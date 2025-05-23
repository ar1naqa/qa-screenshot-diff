const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
const PNG = require('pngjs').PNG;
const { default: pixelmatch } = require('pixelmatch');
const express = require('express');
require('dotenv').config();
const { RESOLUTIONS, DIRECTORIES, createDirectories, getScreenshotName, clearDirectory, checkBaseScreenshot } = require('./utils');

class ImageComparer {
    static async compareImages(img1Path, img2Path, diffPath) {
        const img1 = PNG.sync.read(fs.readFileSync(img1Path));
        const img2 = PNG.sync.read(fs.readFileSync(img2Path));
        
        const width1 = img1.width;
        const height1 = img1.height;
        const width2 = img2.width;
        const height2 = img2.height;

        const width = Math.max(width1, width2);
        const height = Math.max(height1, height2);

        const diff = new PNG({width, height});
        const buffer1 = new Uint8Array(width * height * 4);
        const buffer2 = new Uint8Array(width * height * 4);

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                
                if (x < width1 && y < height1) {
                    const origIdx = (y * width1 + x) * 4;
                    buffer1[idx] = img1.data[origIdx];
                    buffer1[idx + 1] = img1.data[origIdx + 1];
                    buffer1[idx + 2] = img1.data[origIdx + 2];
                    buffer1[idx + 3] = img1.data[origIdx + 3];
                }

                if (x < width2 && y < height2) {
                    const origIdx = (y * width2 + x) * 4;
                    buffer2[idx] = img2.data[origIdx];
                    buffer2[idx + 1] = img2.data[origIdx + 1];
                    buffer2[idx + 2] = img2.data[origIdx + 2];
                    buffer2[idx + 3] = img2.data[origIdx + 3];
                }
            }
        }

        const differences = pixelmatch(
            buffer1,
            buffer2,
            diff.data,
            width,
            height,
            {threshold: 0.1}
        );

        fs.writeFileSync(diffPath, PNG.sync.write(diff));
        return differences;
    }
}

class ScreenshotManager {
    constructor() {
        this.browser = null;
        this.page = null;
    }

    async initialize() {
        this.browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ],
            defaultViewport: null
        });
        this.page = await this.browser.newPage();
    }

    async cleanup() {
        if (this.page) await this.page.close();
        if (this.browser) await this.browser.close();
    }

    async setupPage(resolution) {
        await this.page.setViewport({
            width: resolution.width,
            height: resolution.height,
            deviceScaleFactor: 1
        });

        await this.page.addStyleTag({
            content: `
                * {
                    max-width: 100% !important;
                    box-sizing: border-box !important;
                }
                body {
                    width: ${resolution.width}px !important;
                    min-height: ${resolution.height}px !important;
                    margin: 0 !important;
                    padding: 0 !important;
                    overflow: hidden !important;
                }
                img, video, iframe {
                    max-width: 100% !important;
                    height: auto !important;
                }
            `
        });

        await this.page.setExtraHTTPHeaders({
            'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
        });

        if (process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD) {
            await this.page.authenticate({
                username: process.env.AUTH_USERNAME,
                password: process.env.AUTH_PASSWORD
            });
        }
    }

    async hideUIElements() {
        await this.page.evaluate(() => {
            const closeBtn = document.querySelector('.styles_closeBtn__0udzm');
            if (closeBtn && closeBtn.offsetParent !== null) {
                closeBtn.click();
            }

            const style = document.createElement('style');
            style.textContent = `
                .Menu_Root__zPTo0,
                .Menu_active__0pEj1,
                .Navigation_Root__siG__,
                .MainNavigation_list__GvcA4,
                .SecondaryNavigation_navigation__ddAC5,
                .last-navigation_navigation__lRO8P {
                    display: none !important;
                    visibility: hidden !important;
                    opacity: 0 !important;
                }
            `;
            document.head.appendChild(style);

            const cookiePanel = document.querySelector('.CookiePanel_CookiePanel__m9za0');
            if (cookiePanel) cookiePanel.remove();

            const cookieStyle = document.createElement('style');
            cookieStyle.textContent = `
                .CookiePanel_CookiePanel__m9za0,
                .CookiePanel_container__nMgov,
                .CookiePanel_content__KK7ay,
                .CookieButton_CookieButton__aipHg {
                    display: none !important;
                    visibility: hidden !important;
                    opacity: 0 !important;
                }
            `;
            document.head.appendChild(cookieStyle);
        });
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    async loadPage(url) {
        let retryCount = 0;
        const maxRetries = 3;
        let success = false;

        while (retryCount < maxRetries && !success) {
            try {
                const response = await this.page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: 60000
                });

                if (!response || response.status() >= 400) {
                    throw new Error(`HTTP статус: ${response ? response.status() : 'нет ответа'}`);
                }

                await this.page.waitForFunction(() => {
                    return window.performance.getEntriesByType('resource')
                        .filter(r => !r.responseEnd && r.startTime > performance.now() - 1000).length === 0;
                }, { timeout: 30000 }).catch(() => {});

                await this.page.waitForFunction(() => {
                    return document.readyState === 'complete' && 
                           !document.querySelector('body')?.classList.contains('loading');
                }, { timeout: 60000 }).catch(() => {});

                await new Promise(resolve => setTimeout(resolve, 10000));
                success = true;
            } catch (error) {
                retryCount++;
                if (retryCount === maxRetries) {
                    throw new Error(`Не удалось загрузить страницу после ${maxRetries} попыток: ${error.message}`);
                }
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }

    async takeScreenshot(url, resolution, screenshotPath) {
        try {
            await this.initialize();
            await this.setupPage(resolution);
            await this.loadPage(url);
            await this.hideUIElements();

            await this.page.screenshot({
                path: screenshotPath,
                fullPage: true
            });

            console.log(`Создан скриншот: ${screenshotPath}`);
            return await this.page.title();
        } catch (error) {
            console.error(`Ошибка при создании скриншота для ${url} (${resolution.width}x${resolution.height}):`, error);
            throw error;
        } finally {
            await this.cleanup();
        }
    }
}

class ScreenshotComparer {
    constructor() {
        this.screenshotManager = new ScreenshotManager();
    }

    async selectUrls(urls) {
        console.log('Доступные URL:');
        urls.forEach((url, index) => {
            console.log(`${index + 1}. ${url}`);
        });

        console.log('\nВыберите номера URL для сравнения (через запятую, например: 1,3,5)');
        console.log('Или введите "all" для выбора всех URL');

        const rl = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });

        try {
            const answer = await new Promise(resolve => {
                rl.question('Ваш выбор: ', (answer) => {
                    resolve(answer.trim());
                });
            });

            if (answer.toLowerCase() === 'all') {
                return urls;
            }

            const selectedIndices = answer.split(',')
                .map(num => parseInt(num.trim()) - 1)
                .filter(index => !isNaN(index) && index >= 0 && index < urls.length);

            if (selectedIndices.length === 0) {
                console.log('Не выбрано ни одного URL. Попробуйте снова.');
                return this.selectUrls(urls);
            }

            return selectedIndices.map(index => urls[index]);
        } finally {
            rl.close();
        }
    }

    async processUrl(url, resolution) {
        const screenshotName = getScreenshotName(url, resolution);
        const baseScreenshotPath = path.join(DIRECTORIES.RECORDS, screenshotName);
        const newScreenshotPath = path.join(DIRECTORIES.NEW_RECORDS, `new-${screenshotName}`);
        const diffScreenshotPath = path.join(DIRECTORIES.COMPARE_RECORDS, `diff-${screenshotName}`);

        if (!await fs.pathExists(baseScreenshotPath)) {
            console.warn(`Базовый скриншот не найден для ${url} (${resolution.width}x${resolution.height}), пропускаем.`);
            return null;
        }

        try {
            const title = await this.screenshotManager.takeScreenshot(url, resolution, newScreenshotPath);
            
            if (await fs.pathExists(baseScreenshotPath) && await fs.pathExists(newScreenshotPath)) {
                console.log('Сравнение скриншотов...');
                const differences = await ImageComparer.compareImages(baseScreenshotPath, newScreenshotPath, diffScreenshotPath);
                
                return {
                    url,
                    resolution: `${resolution.width}x${resolution.height}`,
                    baseScreenshot: screenshotName,
                    newScreenshot: `new-${screenshotName}`,
                    diffScreenshot: `diff-${screenshotName}`,
                    differences,
                    title
                };
            }
        } catch (error) {
            console.error(`Ошибка при обработке ${url} для разрешения ${resolution.width}x${resolution.height}:`, error);
        }
        return null;
    }

    async startWebServer(results) {
        const app = express();
        app.use(express.static(DIRECTORIES.COMPARE_RECORDS));
        app.use(express.static(DIRECTORIES.NEW_RECORDS));
        app.use(express.static(DIRECTORIES.RECORDS));

        app.get('/', (req, res) => {
            res.sendFile(path.join(DIRECTORIES.COMPARE_RECORDS, 'index.html'));
        });

        app.get('/results', (req, res) => {
            res.json(results);
        });

        app.listen(3000, () => {
            console.log('Сервер запущен на http://localhost:3000');
        });
    }

    async compareScreenshots() {
        try {
            await createDirectories();
            const config = await fs.readJson(path.join(DIRECTORIES.CONFIG, 'config.json'));
            const { urls } = config;

            const selectedUrls = await this.selectUrls(urls);
            console.log('Выбраны для сравнения:', selectedUrls);

            await clearDirectory(DIRECTORIES.NEW_RECORDS);

            const results = [];

            for (const url of selectedUrls) {
                console.log(`\nОбработка URL: ${url}`);
                for (const resolution of RESOLUTIONS) {
                    const result = await this.processUrl(url, resolution);
                    if (result) {
                        results.push(result);
                        console.log(`Сравнение завершено. Найдено различий: ${result.differences}`);
                    }
                }
            }

            await fs.writeJson(path.join(DIRECTORIES.COMPARE_RECORDS, 'results.json'), results);
            console.log('Результаты сохранены в compare_records/results.json');

            await this.startWebServer(results);
        } catch (error) {
            console.error('Ошибка при сравнении скриншотов:', error);
            process.exit(1);
        }
    }
}

const comparer = new ScreenshotComparer();
comparer.compareScreenshots(); 