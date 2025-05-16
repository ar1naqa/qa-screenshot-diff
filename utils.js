const fs = require('fs-extra');
const path = require('path');

// Константы
const RESOLUTIONS = [
    { width: 1920, height: 1080 },  // Full HD
    { width: 1440, height: 900 },   // WXGA+
    { width: 1024, height: 768 }, 
    { width: 768, height: 1024 },
    { width: 395, height: 852 }, 
    { width: 375, height: 667 }
     // XGA
];

const DIRECTORIES = {
    RECORDS: 'records',
    COMPARE_RECORDS: 'compare_records',
    NEW_RECORDS: 'new_records',
    CONFIG: 'config'
};

// Создание необходимых директорий
async function createDirectories() {
    for (const dir of Object.values(DIRECTORIES)) {
        await fs.ensureDir(dir);
    }
}

// Получение имени файла скриншота
function getScreenshotName(url, resolution) {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.replace(/\./g, '-');
    const pathname = urlObj.pathname.replace(/[^a-zA-Z0-9]/g, '-');
    return `${hostname}${pathname}-${resolution.width}x${resolution.height}.png`;
}

// Очистка директории
async function clearDirectory(dir) {
    await fs.emptyDir(dir);
}

// Проверка существования базового скриншота
async function checkBaseScreenshot(url, resolution) {
    const screenshotName = getScreenshotName(url, resolution);
    const screenshotPath = path.join(DIRECTORIES.RECORDS, screenshotName);
    return await fs.pathExists(screenshotPath);
}

module.exports = {
    RESOLUTIONS,
    DIRECTORIES,
    createDirectories,
    getScreenshotName,
    clearDirectory,
    checkBaseScreenshot
}; 