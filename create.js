const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
require('dotenv').config();
const { RESOLUTIONS, DIRECTORIES, createDirectories, getScreenshotName, checkBaseScreenshot } = require('./utils');

async function getExistingScreenshots() {
    const screenshots = new Set();
    if (await fs.pathExists(DIRECTORIES.RECORDS)) {
        const files = await fs.readdir(DIRECTORIES.RECORDS);
        files.forEach(file => {
            if (file.endsWith('.png')) {
                // Удаляем разрешение и расширение из имени файла
                const baseName = file.replace(/-\d+x\d+\.png$/, '');
                screenshots.add(baseName);
            }
        });
    }
    return screenshots;
}

async function selectPagesToProcess(urls) {
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
                        // Обработка диапазона
                        const [start, end] = part.split('-').map(num => parseInt(num.trim()) - 1);
                        if (!isNaN(start) && !isNaN(end) && start >= 0 && end < urls.length) {
                            for (let i = start; i <= end; i++) {
                                selectedIndices.add(i);
                            }
                        }
                    } else {
                        // Обработка одиночного номера
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

async function selectResolutions() {
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

async function createScreenshots() {
    try {
        // Создаем необходимые директории
        await createDirectories();

        // Читаем конфигурацию
        const config = await fs.readJson(path.join(DIRECTORIES.CONFIG, 'config.json'));
        const { urls: configUrls, credentials } = config;

        // Получаем список существующих скриншотов
        const existingScreenshots = await getExistingScreenshots();
        
        // Определяем новые URL, для которых нет скриншотов
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
            
            // Предлагаем выбрать страницы для пересоздания
            urlsToProcess = await selectPagesToProcess(configUrls);
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
                    // Предлагаем выбрать конкретные новые страницы
                    urlsToProcess = await selectPagesToProcess(newUrls);
                    break;
                case '2':
                    urlsToProcess = await selectPagesToProcess(configUrls);
                    break;
                case '3':
                    urlsToProcess = configUrls;
                    break;
                default:
                    console.log('Неверный выбор. Операция отменена.');
                    return;
            }
        }

        // Выбираем разрешения для создания скриншотов
        const resolutionsToProcess = await selectResolutions();

        // Создаем скриншоты для каждого URL
        for (const url of urlsToProcess) {
            console.log(`Обработка URL: ${url}`);
            
            for (const resolution of resolutionsToProcess) {
                // Запускаем новый браузер для каждого разрешения
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
                
                // Устанавливаем фиксированный размер viewport
                await page.setViewport({
                    width: resolution.width,
                    height: resolution.height,
                    deviceScaleFactor: 1
                });

                // Добавляем CSS для нормализации размеров
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

                // Настраиваем обработку всплывающих окон с куки
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
                });

                // Авторизация
                if (process.env.AUTH_USERNAME && process.env.AUTH_PASSWORD) {
                    await page.authenticate({
                        username: process.env.AUTH_USERNAME,
                        password: process.env.AUTH_PASSWORD
                    });
                }

                // Переходим на страницу и ждем полной загрузки
                try {
                    console.log(`Загрузка страницы для разрешения ${resolution.width}x${resolution.height}...`);
                    
                    // Пробуем загрузить страницу несколько раз
                    let retryCount = 0;
                    const maxRetries = 3;
                    let success = false;
                    let response = null;

                    while (retryCount < maxRetries && !success) {
                        try {
                            response = await page.goto(url, { 
                                waitUntil: 'domcontentloaded',
                                timeout: 60000
                            });

                            // Проверяем HTTP-статус
                            if (!response || response.status() >= 400) {
                                throw new Error(`HTTP статус: ${response ? response.status() : 'нет ответа'}`);
                            }

                            // Ждем, пока сеть станет практически неактивной
                            await page.waitForFunction(() => {
                                return window.performance.getEntriesByType('resource')
                                    .filter(r => !r.responseEnd && r.startTime > performance.now() - 1000).length === 0;
                            }, { timeout: 30000 }).catch(() => {});

                            success = true;
                        } catch (error) {
                            retryCount++;
                            if (retryCount === maxRetries) {
                                console.warn(`Не удалось загрузить страницу ${url} для разрешения ${resolution.width}x${resolution.height} после ${maxRetries} попыток. Ошибка: ${error.message}`);
                                break; // Просто пропускаем этот URL
                            }
                            await new Promise(resolve => setTimeout(resolve, 5000));
                        }
                    }

                    if (!success) {
                        continue; // Переходим к следующему разрешению или URL
                    }

                    // Ждем, пока страница полностью загрузится
                    await page.waitForFunction(() => {
                        return document.readyState === 'complete' && 
                               !document.querySelector('body')?.classList.contains('loading');
                    }, { timeout: 60000 }).catch(() => {});

                    // Ждем дополнительное время для полной загрузки динамического контента
                    await new Promise(resolve => setTimeout(resolve, 10000));

                    // Закрываем меню, если оно открыто перед созданием скриншота
                    await page.evaluate(() => {
                        // Кликаем по кнопке закрытия меню, если она есть и видима
                        const closeBtn = document.querySelector('.styles_closeBtn__0udzm');
                        if (closeBtn && closeBtn.offsetParent !== null) {
                            closeBtn.click();
                        }

                        // Принудительно скрываем меню через CSS (на всякий случай)
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

                        // Удаляем баннер cookies по точному классу
                        const cookiePanel = document.querySelector('.CookiePanel_CookiePanel__m9za0');
                        if (cookiePanel) cookiePanel.remove();

                        // На всякий случай скрываем все элементы cookie-баннера через CSS
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
                    await new Promise(resolve => setTimeout(resolve, 1000)); // Ждём, чтобы скрытие применилось

                    // Делаем скриншот
                    console.log('Создание скриншота...');
                    const screenshotName = getScreenshotName(url, resolution);
                    const screenshotPath = path.join(DIRECTORIES.RECORDS, screenshotName);
                    await page.screenshot({
                        path: screenshotPath,
                        fullPage: true
                    });

                    console.log(`Создан скриншот: ${screenshotName}`);
                } catch (error) {
                    console.error(`Ошибка при обработке разрешения ${resolution.width}x${resolution.height}:`, error);
                    // process.exit(1); // Удаляем завершение работы скрипта
                } finally {
                    await page.close();
                    await browser.close();
                }
            }
        }

        console.log('Все скриншоты успешно созданы');
    } catch (error) {
        console.error('Ошибка при создании скриншотов:', error);
        process.exit(1);
    }
}

createScreenshots(); 