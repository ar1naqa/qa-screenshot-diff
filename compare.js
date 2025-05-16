const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
const PNG = require('pngjs').PNG;
const { default: pixelmatch } = require('pixelmatch');
const express = require('express');
const { RESOLUTIONS, DIRECTORIES, createDirectories, getScreenshotName, clearDirectory, checkBaseScreenshot } = require('./utils');

async function compareImages(img1Path, img2Path, diffPath) {
    const img1 = PNG.sync.read(fs.readFileSync(img1Path));
    const img2 = PNG.sync.read(fs.readFileSync(img2Path));
    
    // Получаем размеры обоих изображений
    const width1 = img1.width;
    const height1 = img1.height;
    const width2 = img2.width;
    const height2 = img2.height;

    // Выбираем максимальные размеры
    const width = Math.max(width1, width2);
    const height = Math.max(height1, height2);

    // Создаем новое изображение с максимальными размерами
    const diff = new PNG({width, height});

    // Создаем временные буферы для нормализации размеров
    const buffer1 = new Uint8Array(width * height * 4);
    const buffer2 = new Uint8Array(width * height * 4);

    // Копируем данные из оригинальных изображений в буферы
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            
            // Для первого изображения
            if (x < width1 && y < height1) {
                const origIdx = (y * width1 + x) * 4;
                buffer1[idx] = img1.data[origIdx];
                buffer1[idx + 1] = img1.data[origIdx + 1];
                buffer1[idx + 2] = img1.data[origIdx + 2];
                buffer1[idx + 3] = img1.data[origIdx + 3];
            }

            // Для второго изображения
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

async function selectUrls(urls) {
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
            return selectUrls(urls);
        }

        return selectedIndices.map(index => urls[index]);
    } finally {
        rl.close();
    }
}

async function waitForEnter() {
    const rl = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {
        await new Promise(resolve => {
            rl.question('', () => {
                resolve();
            });
        });
    } finally {
        rl.close();
    }
}

function getResolutionFromFilename(filename) {
    const match = filename.match(/-(\d+x\d+)\.png$/);
    if (!match) return null;
    
    const [width, height] = match[1].split('x').map(Number);
    return { width, height };
}

async function compareScreenshots() {
    try {
        // Создаем необходимые директории
        await createDirectories();

        // Читаем конфигурацию
        const config = await fs.readJson(path.join(DIRECTORIES.CONFIG, 'config.json'));
        const { urls, credentials } = config;

        // Выбор URL
        const selectedUrls = await selectUrls(urls);
        console.log('Выбраны для сравнения:', selectedUrls);

        // Очищаем директорию new_records
        await clearDirectory(DIRECTORIES.NEW_RECORDS);

        const results = [];

        for (const selectedUrl of selectedUrls) {
            console.log(`\nОбработка URL: ${selectedUrl}`);
            for (const resolution of RESOLUTIONS) {
                const screenshotName = getScreenshotName(selectedUrl, resolution);
                const baseScreenshotPath = path.join(DIRECTORIES.RECORDS, screenshotName);
                const newScreenshotPath = path.join(DIRECTORIES.NEW_RECORDS, `new-${screenshotName}`);
                const diffScreenshotPath = path.join(DIRECTORIES.COMPARE_RECORDS, `diff-${screenshotName}`);

                // Проверяем наличие базового скриншота
                if (!await fs.pathExists(baseScreenshotPath)) {
                    console.warn(`Базовый скриншот не найден для ${selectedUrl} (${resolution.width}x${resolution.height}), пропускаем.`);
                    continue;
                }

                const browser = await puppeteer.launch({
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
                const page = await browser.newPage();
                await page.setViewport({
                    width: resolution.width,
                    height: resolution.height,
                    deviceScaleFactor: 1
                });
                await page.addStyleTag({
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
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
                });
                if (credentials) {
                    await page.authenticate(credentials);
                }
                try {
                    console.log(`Загрузка страницы для разрешения ${resolution.width}x${resolution.height}...`);
                    let retryCount = 0;
                    const maxRetries = 3;
                    let success = false;
                    let response = null;
                    while (retryCount < maxRetries && !success) {
                        try {
                            response = await page.goto(selectedUrl, {
                                waitUntil: 'domcontentloaded',
                                timeout: 60000
                            });
                            if (!response || response.status() >= 400) {
                                throw new Error(`HTTP статус: ${response ? response.status() : 'нет ответа'}`);
                            }
                            await page.waitForFunction(() => {
                                return window.performance.getEntriesByType('resource')
                                    .filter(r => !r.responseEnd && r.startTime > performance.now() - 1000).length === 0;
                            }, { timeout: 30000 }).catch(() => {});
                            success = true;
                        } catch (error) {
                            retryCount++;
                            if (retryCount === maxRetries) {
                                console.warn(`Не удалось загрузить страницу ${selectedUrl} для разрешения ${resolution.width}x${resolution.height} после ${maxRetries} попыток. Ошибка: ${error.message}`);
                                break;
                            }
                            await new Promise(resolve => setTimeout(resolve, 5000));
                        }
                    }
                    if (!success) {
                        await page.close();
                        await browser.close();
                        continue;
                    }
                    await page.waitForFunction(() => {
                        return document.readyState === 'complete' && 
                               !document.querySelector('body')?.classList.contains('loading');
                    }, { timeout: 60000 }).catch(() => {});
                    await new Promise(resolve => setTimeout(resolve, 10000));
                    // Скрытие меню и cookie-баннера (как в create.js)
                    await page.evaluate(() => {
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
                    // Делаем новый скриншот
                    console.log('Создание нового скриншота...');
                    await page.screenshot({
                        path: newScreenshotPath,
                        fullPage: true
                    });
                    console.log(`Создан скриншот: ${newScreenshotPath}`);
                    // Сравниваем скриншоты
                    if (await fs.pathExists(baseScreenshotPath) && await fs.pathExists(newScreenshotPath)) {
                        console.log('Сравнение скриншотов...');
                        const differences = await compareImages(baseScreenshotPath, newScreenshotPath, diffScreenshotPath);
                        results.push({
                            url: selectedUrl,
                            resolution: `${resolution.width}x${resolution.height}`,
                            baseScreenshot: screenshotName,
                            newScreenshot: `new-${screenshotName}`,
                            diffScreenshot: `diff-${screenshotName}`,
                            differences: differences,
                            title: await page.title()
                        });
                        console.log(`Сравнение завершено. Найдено различий: ${differences}`);
                    } else {
                        console.warn('Один из скриншотов не найден, сравнение пропущено.');
                    }
                } catch (error) {
                    console.error(`Ошибка при обработке разрешения ${resolution.width}x${resolution.height}:`, error);
                    continue;
                } finally {
                    await page.close();
                    await browser.close();
                }
            }
        }

        // Сохраняем результаты
        await fs.writeJson(path.join(DIRECTORIES.COMPARE_RECORDS, 'results.json'), results);
        console.log('Результаты сохранены в compare_records/results.json');

        // Запускаем веб-сервер
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

    } catch (error) {
        console.error('Ошибка при сравнении скриншотов:', error);
        process.exit(1);
    }
}

compareScreenshots(); 