const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();
const { RESOLUTIONS, DIRECTORIES, createDirectories, getScreenshotName, checkBaseScreenshot } = require('./utils');

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

    async takeScreenshot(url, resolution) {
        try {
            await this.initialize();
            await this.setupPage(resolution);
            await this.loadPage(url);
            await this.hideUIElements();

            const screenshotName = getScreenshotName(url, resolution);
            const screenshotPath = path.join(DIRECTORIES.RECORDS, screenshotName);
            
            await this.page.screenshot({
                path: screenshotPath,
                fullPage: true
            });

            console.log(`Создан скриншот: ${screenshotName}`);
            return screenshotName;
        } catch (error) {
            console.error(`Ошибка при создании скриншота для ${url} (${resolution.width}x${resolution.height}):`, error);
            throw error;
        } finally {
            await this.cleanup();
        }
    }
}

class ScreenshotCreator {
    constructor() {
        this.screenshotManager = new ScreenshotManager();
    }

    async getExistingScreenshots() {
        const screenshots = new Set();
        if (await fs.pathExists(DIRECTORIES.RECORDS)) {
            const files = await fs.readdir(DIRECTORIES.RECORDS);
            files.forEach(file => {
                if (file.endsWith('.png')) {
                    const baseName = file.replace(/-\d+x\d+\.png$/, '');
                    screenshots.add(baseName);
                }
            });
        }
        return screenshots;
    }

    async selectPagesToProcess(urls) {
        console.log('\nДоступные страницы:');
        urls.forEach((url, index) => {
            console.log(`${index + 1}. ${url}`);
        });

        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const selectedUrls = await new Promise(resolve => {
            readline.question('\nВыберите номера страниц через запятую или диапазон (например: 1,3,5 или 2-15) или введите "all" для всех страниц: ', (answer) => {
                readline.close();
                if (answer.toLowerCase() === 'all') {
                    resolve(urls);
                } else {
                    const selectedIndices = new Set();
                    const parts = answer.split(',');
                    
                    for (const part of parts) {
                        if (part.includes('-')) {
                            const [start, end] = part.split('-').map(num => parseInt(num.trim()) - 1);
                            if (!isNaN(start) && !isNaN(end) && start >= 0 && end < urls.length) {
                                for (let i = start; i <= end; i++) {
                                    selectedIndices.add(i);
                                }
                            }
                        } else {
                            const index = parseInt(part.trim()) - 1;
                            if (!isNaN(index) && index >= 0 && index < urls.length) {
                                selectedIndices.add(index);
                            }
                        }
                    }
                    
                    resolve(urls.filter((_, index) => selectedIndices.has(index)));
                }
            });
        });

        return selectedUrls;
    }

    async selectResolutions() {
        console.log('\nДоступные разрешения:');
        RESOLUTIONS.forEach((resolution, index) => {
            console.log(`${index + 1}. ${resolution.width}x${resolution.height}`);
        });

        const readline = require('readline').createInterface({
            input: process.stdin,
            output: process.stdout
        });

        const selectedResolutions = await new Promise(resolve => {
            readline.question('\nВыберите номера разрешений через запятую (например: 1,3) или введите "all" для всех разрешений: ', (answer) => {
                readline.close();
                if (answer.toLowerCase() === 'all') {
                    resolve(RESOLUTIONS);
                } else {
                    const selectedIndices = answer.split(',').map(num => parseInt(num.trim()) - 1);
                    resolve(RESOLUTIONS.filter((_, index) => selectedIndices.includes(index)));
                }
            });
        });

        return selectedResolutions;
    }

    async processUrls(urls, resolutions) {
        for (const url of urls) {
            console.log(`Обработка URL: ${url}`);
            for (const resolution of resolutions) {
                try {
                    await this.screenshotManager.takeScreenshot(url, resolution);
                } catch (error) {
                    console.error(`Ошибка при обработке ${url} для разрешения ${resolution.width}x${resolution.height}:`, error);
                    continue;
                }
            }
        }
    }

    async createScreenshots() {
        try {
            await createDirectories();
            const config = await fs.readJson(path.join(DIRECTORIES.CONFIG, 'config.json'));
            const { urls: configUrls } = config;

            const existingScreenshots = await this.getExistingScreenshots();
            const newUrls = configUrls.filter(url => {
                const screenshotName = getScreenshotName(url, RESOLUTIONS[0]).replace(/-\d+x\d+\.png$/, '');
                return !existingScreenshots.has(screenshotName);
            });

            let urlsToProcess = configUrls;

            if (newUrls.length === 0) {
                console.log('Все скриншоты уже существуют. Хотите пересоздать скриншоты? (y/n)');
                const readline = require('readline').createInterface({
                    input: process.stdin,
                    output: process.stdout
                });

                const recreate = await new Promise(resolve => {
                    readline.question('', (answer) => {
                        readline.close();
                        resolve(answer.toLowerCase() === 'y');
                    });
                });

                if (!recreate) {
                    console.log('Операция отменена');
                    return;
                }
                
                urlsToProcess = await this.selectPagesToProcess(configUrls);
            } else {
                console.log('Найдены новые страницы для создания скриншотов:');
                newUrls.forEach((url, index) => {
                    console.log(`${index + 1}. ${url}`);
                });

                console.log('\nВыберите действие:');
                console.log('1. Создать скриншоты только для новых страниц');
                console.log('2. Выбрать конкретные страницы для создания скриншотов');
                console.log('3. Создать скриншоты для всех страниц');

                const readline = require('readline').createInterface({
                    input: process.stdin,
                    output: process.stdout
                });

                const choice = await new Promise(resolve => {
                    readline.question('Выберите вариант (1, 2 или 3): ', (answer) => {
                        readline.close();
                        resolve(answer);
                    });
                });

                switch (choice) {
                    case '1':
                        urlsToProcess = await this.selectPagesToProcess(newUrls);
                        break;
                    case '2':
                        urlsToProcess = await this.selectPagesToProcess(configUrls);
                        break;
                    case '3':
                        urlsToProcess = configUrls;
                        break;
                    default:
                        console.log('Неверный выбор. Операция отменена.');
                        return;
                }
            }

            const resolutionsToProcess = await this.selectResolutions();
            await this.processUrls(urlsToProcess, resolutionsToProcess);
            console.log('Все скриншоты успешно созданы');
        } catch (error) {
            console.error('Ошибка при создании скриншотов:', error);
            process.exit(1);
        }
    }
}

const creator = new ScreenshotCreator();
creator.createScreenshots(); 