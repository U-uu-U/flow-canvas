// ============================================================
// Flow Canvas — Electron Main Process
// ============================================================

const { app, BrowserWindow, ipcMain, shell, clipboard, nativeImage, dialog, protocol, net, safeStorage, session } = require('electron');
const fs = require('fs');
const path = require('path');
const Store = require('./store');
const Watcher = require('./watcher');
const Thumbnailer = require('./thumbnailer');
const { prepareGatewayHeaders } = require('./gateway-auth');
const { gatewayBaseUrl: packagedGatewayUrl } = require('./gateway-config.json');
const createLogger = require('../shared/logger');
const { API_KEY_MAX_LENGTH } = require('./constants');

const logger = createLogger('Main');

let mainWindow = null;
let store = null;
let watcher = null;
let thumbnailer = null;

const isDev = !app.isPackaged;
const DEV_SERVER_URL = 'http://localhost:5180';
const getRavenhashKeyPath = () => path.join(app.getPath('userData'), 'ravenhash-api-key.bin');
const FLOWCANVAS_GATEWAY_URL = String(
    process.env.FLOWCANVAS_GATEWAY_URL
    || packagedGatewayUrl
    || 'http://localhost:8787'
).replace(/\/+$/, '');

function isTrustedRenderer(event) {
    return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents);
}

function readRavenhashKey() {
    try {
        const keyPath = getRavenhashKeyPath();
        if (!fs.existsSync(keyPath) || !safeStorage.isEncryptionAvailable()) return '';
        return safeStorage.decryptString(fs.readFileSync(keyPath));
    } catch (_) {
        return '';
    }
}

function configureGatewayAuthorization() {
    let gatewayUrl;
    try {
        gatewayUrl = new URL(FLOWCANVAS_GATEWAY_URL);
    } catch (_) {
        throw new Error('FLOWCANVAS_GATEWAY_URL 配置无效');
    }
    if (!['http:', 'https:'].includes(gatewayUrl.protocol)
        || gatewayUrl.username || gatewayUrl.password || gatewayUrl.search || gatewayUrl.hash) {
        throw new Error('FLOWCANVAS_GATEWAY_URL 必须是无内嵌凭证、查询参数或锚点的 HTTP(S) URL');
    }
    const filter = { urls: [`${gatewayUrl.protocol}//${gatewayUrl.host}/*`] };

    session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
        const headers = prepareGatewayHeaders({
            requestUrl: details.url,
            requestHeaders: details.requestHeaders,
            gatewayBaseUrl: FLOWCANVAS_GATEWAY_URL,
            readApiKey: readRavenhashKey
        });
        callback({ requestHeaders: headers });
    });
}

// 注册私有协议权限
protocol.registerSchemesAsPrivileged([
    { scheme: 'local-res', privileges: { bypassCSP: true, supportFetchAPI: true, stream: true, secure: true } }
]);

// ── 窗口创建 ───────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        backgroundColor: '#0f0f14',
        // Mac 上 frame:false 会吃掉红绿灯按钮；用 hiddenInset 保留交通灯并留出空间
        frame: process.platform !== 'darwin',
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
        trafficLightPosition: process.platform === 'darwin' ? { x: 12, y: 12 } : undefined,
        titleBarOverlay: process.platform !== 'darwin' ? {
            color: '#0f0f14',
            symbolColor: '#8a8f98',
            height: 38
        } : undefined,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    // 拦截外部拖拽图片导致的页面导航，自动下载图片并通知渲染进程
    mainWindow.webContents.on('will-navigate', async (e, url) => {
        if (isDev) {
            try {
                if (new URL(url).origin === new URL(DEV_SERVER_URL).origin) return;
            } catch (_) { /* 交给下面的外部 URL 判断 */ }
        }
        e.preventDefault();
        // 检查是否像图片URL
        if (/^https?:\/\//i.test(url)) {
            logger.debug('拦截到拖拽导航', { url: url.substring(0, 100) });
            try {
                // 从 store 读取默认保存文件夹
                const data = store.load();
                const targetDir = data.defaultSaveFolder || (data.watchFolders && data.watchFolders[0]);
                const result = await downloadImageFromUrl(url, targetDir);
                if (result.success) {
                    mainWindow.webContents.send('external-image-dropped', result.filePath);
                } else {
                    logger.error('拖拽图片下载失败', { error: result.error });
                }
            } catch (err) {
                logger.error('拖拽图片处理异常', { error: err.message });
            }
        }
    });

    if (isDev) {
        mainWindow.loadURL(DEV_SERVER_URL);
        // DevTools 按需打开（F12），不再自动常驻，节省 ~47MB
        mainWindow.webContents.on('before-input-event', (e, input) => {
            if (input.key === 'F12' && input.type === 'keyDown') {
                mainWindow.webContents.toggleDevTools();
            }
        });
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }
}

// ── 初始化服务 ──────────────────────────────────────────
function initServices() {
    store = new Store();
    thumbnailer = new Thumbnailer();
    watcher = new Watcher(store, (event, filePath) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('file-change', { event, filePath });
        }
    });

    // 恢复上次的监听文件夹
    const boardData = store.load();
    if (boardData.watchFolders) {
        boardData.watchFolders.forEach(folder => watcher.add(folder));
    }
}

// ── IPC 处理 ────────────────────────────────────────────

ipcMain.handle('credentials:hasRavenhashKey', event => {
    if (!isTrustedRenderer(event)) return false;
    try {
        const keyPath = getRavenhashKeyPath();
        return safeStorage.isEncryptionAvailable() && fs.existsSync(keyPath);
    } catch (_) {
        return false;
    }
});

ipcMain.handle('credentials:setRavenhashKey', (event, value) => {
    if (!isTrustedRenderer(event)) return false;
    try {
        const key = String(value || '').trim();
        if (!key || key.length > API_KEY_MAX_LENGTH || !safeStorage.isEncryptionAvailable()) return false;
        const keyPath = getRavenhashKeyPath();
        fs.mkdirSync(path.dirname(keyPath), { recursive: true });
        fs.writeFileSync(keyPath, safeStorage.encryptString(key));
        return true;
    } catch (_) {
        return false;
    }
});

ipcMain.handle('credentials:clearRavenhashKey', event => {
    if (!isTrustedRenderer(event)) return false;
    try {
        const keyPath = getRavenhashKeyPath();
        if (fs.existsSync(keyPath)) fs.unlinkSync(keyPath);
        return true;
    } catch (_) {
        return false;
    }
});

// 数据存储
ipcMain.handle('store:load', () => store.load());
ipcMain.handle('store:save', (_, data) => store.save(data));

// 文件夹管理
ipcMain.handle('folder:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: '选择要关联的文件夹'
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const folderPath = result.filePaths[0];
    watcher.add(folderPath);
    return folderPath;
});

ipcMain.handle('folder:scan', async (_, folderPath) => {
    return watcher.scanFolder(folderPath);
});

ipcMain.handle('folder:unwatch', (_, folderPath) => {
    watcher.remove(folderPath);
});

const { Menu } = require('electron');
ipcMain.handle('folder:showContextMenu', async (_, folderPath) => {
    return new Promise((resolve) => {
        const menu = Menu.buildFromTemplate([
            {
                label: '设为摘取图片默认保存文件夹',
                click: () => resolve('setDefault')
            },
            { type: 'separator' },
            {
                label: '取消关联',
                click: () => resolve('remove')
            }
        ]);

        // 监听菜单关闭但未点击项的情况
        menu.on('menu-will-close', () => {
            // setTimeout 确保如果触发了 click 事件，优先 resolve
            setTimeout(() => resolve(null), 10);
        });

        menu.popup({ window: mainWindow });
    });
});


// 缩略图
ipcMain.handle('thumb:get', async (_, filePath) => {
    return thumbnailer.getThumbnail(filePath);
});

// 剪贴板 — 复制文件引用（和资源管理器/Finder 右键→复制一样）
ipcMain.handle('clipboard:copy', async (_, filePath) => {
    try {
        const fs = require('fs');
        const { exec } = require('child_process');

        if (process.platform === 'darwin') {
            // Mac：用 osascript 把文件引用写入剪贴板
            const escaped = filePath.replace(/"/g, '\\"');
            const script = `set the clipboard to (POSIX file "${escaped}")`;
            return new Promise((resolve) => {
                exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`,
                    { timeout: 8000 },
                    (err) => {
                        if (err) {
                            logger.warn('osascript 复制失败，降级为文本', { error: err.message });
                            clipboard.writeText(filePath);
                            resolve({ success: true, type: 'text' });
                        } else {
                            const fileSize = fs.statSync(filePath).size;
                            const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
                            logger.info('文件引用写入成功', { fileName: path.basename(filePath), sizeMB });
                            resolve({ success: true, type: 'file', sizeMB });
                        }
                    }
                );
            });
        }

        // Windows：通过 PowerShell SetFileDropList 写入文件引用
        const os = require('os');
        const scriptPath = path.join(os.tmpdir(), 'flow_clipboard.ps1');
        const psContent = [
            'Add-Type -AssemblyName System.Windows.Forms',
            '$col = New-Object System.Collections.Specialized.StringCollection',
            `$col.Add("${filePath.replace(/"/g, '`"')}")`,
            '[System.Windows.Forms.Clipboard]::SetFileDropList($col)',
            'Write-Output "DONE"'
        ].join('\r\n');
        fs.writeFileSync(scriptPath, psContent, 'utf8');

        const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

        return new Promise((resolve) => {
            exec(`"${psExe}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
                { timeout: 8000, windowsHide: true },
                (err, stdout) => {
                    try { fs.unlinkSync(scriptPath); } catch (_) { }
                    if (err || !(stdout || '').includes('DONE')) {
                        logger.warn('PowerShell 复制失败，降级为文本', { error: err?.message });
                        clipboard.writeText(filePath);
                        resolve({ success: true, type: 'text' });
                    } else {
                        const fileSize = fs.statSync(filePath).size;
                        const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
                        logger.info('文件引用写入成功', { fileName: path.basename(filePath), sizeMB });
                        resolve({ success: true, type: 'file', sizeMB });
                    }
                }
            );
        });
    } catch (err) {
        logger.error('剪贴板复制失败', { error: err.message });
        return { success: false, error: err.message };
    }
});

// Shell 操作
ipcMain.handle('shell:showInExplorer', (_, filePath) => {
    shell.showItemInFolder(filePath);
});

ipcMain.handle('shell:openFile', (_, filePath) => {
    shell.openPath(filePath);
});

// 原生文件拖放到外部应用（支持单文件或多文件）
ipcMain.on('drag:start', (event, filePathOrPaths) => {
    try {
        const filePaths = Array.isArray(filePathOrPaths) ? filePathOrPaths : [filePathOrPaths];

        // 用第一个图片文件生成拖拽图标
        let icon = nativeImage.createEmpty();
        for (const fp of filePaths) {
            const img = nativeImage.createFromPath(fp);
            if (!img.isEmpty()) {
                icon = img.resize({ width: 128, height: 128 });
                break;
            }
        }

        if (filePaths.length === 1) {
            event.sender.startDrag({
                file: filePaths[0],
                icon: icon
            });
        } else {
            event.sender.startDrag({
                files: filePaths,
                icon: icon
            });
        }
    } catch (err) {
        logger.error('原生拖拽启动失败', { error: err.message });
    }
});

// 窗口置顶
ipcMain.handle('window:setAlwaysOnTop', (_, flag) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.setAlwaysOnTop(flag, 'floating');
        return mainWindow.isAlwaysOnTop();
    }
    return false;
});

ipcMain.handle('window:getAlwaysOnTop', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        return mainWindow.isAlwaysOnTop();
    }
    return false;
});

// ── 网页图片摘取 ────────────────────────────────────────
const crypto = require('crypto');

function getSaveDir() {
    const dir = path.join(app.getPath('userData'), 'data', 'captured');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// 从 URL 下载图片到本地（saveDir 由前端传入）
ipcMain.handle('image:downloadFromUrl', async (_, url, targetDir) => {
    return await downloadImageFromUrl(url, targetDir);
});

// 从剪贴板读取图片并保存
ipcMain.handle('image:pasteFromClipboard', async (_, targetDir) => {
    try {
        const img = clipboard.readImage();
        if (img.isEmpty()) {
            // 尝试读取剪贴板中的 HTML
            const html = clipboard.readHTML();
            const match = html && html.match(/src=["']([^"']+)["']/);
            if (match && match[1] && /^https?:\/\//i.test(match[1])) {
                // 复用 downloadFromUrl 逻辑（手动内联以避免 ipcMain.handle 递归问题）
                return await downloadImageFromUrl(match[1], targetDir);
            }
            const text = clipboard.readText();
            if (text && /^https?:\/\/.+\.(jpg|jpeg|png|gif|webp|bmp)/i.test(text)) {
                return await downloadImageFromUrl(text, targetDir);
            }
            return { success: false, error: '剪贴板中没有图片' };
        }

        const saveDir = targetDir || getSaveDir();
        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
        const hash = crypto.createHash('md5').update(img.toPNG()).digest('hex').slice(0, 10);
        const fileName = `paste_${hash}.png`;
        const filePath = path.join(saveDir, fileName);

        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, img.toPNG());
        }

        return { success: true, filePath };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

// 共享下载函数
async function downloadImageFromUrl(url, targetDir) {
    try {
        const saveDir = targetDir || getSaveDir();
        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });
        let ext = path.extname(new URL(url).pathname).split('?')[0] || '.png';
        if (ext.length > 6) ext = '.png';
        const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 10);
        const fileName = `web_${hash}${ext}`;
        const filePath = path.join(saveDir, fileName);
        if (fs.existsSync(filePath)) return { success: true, filePath };

        const res = await net.fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            redirect: 'follow'
        });

        if (!res.ok) {
            return { success: false, error: `HTTP ${res.status} ${res.statusText}` };
        }

        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        return { success: true, filePath };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ── 应用生命周期 ────────────────────────────────────────
app.whenReady().then(() => {
    // 监听本地文件加载
    protocol.handle('local-res', (request) => {
        const urlStr = request.url.slice('local-res://'.length);
        const decodedPath = decodeURIComponent(urlStr);
        // 去除可能的 query 字符串并标准化路径
        const normalizedPath = decodedPath.split('?')[0].replace(/\\/g, '/');
        // 使用 net.fetch 获取文件原生流返回给前端
        // Mac 路径以 / 开头，直接拼会变四斜杠；Windows 路径以盘符开头无此问题
        const fileUrl = normalizedPath.startsWith('/')
            ? 'file://' + normalizedPath
            : 'file:///' + normalizedPath;
        return net.fetch(fileUrl);
    });

    configureGatewayAuthorization();
    initServices();
    createWindow();
});

app.on('window-all-closed', () => {
    if (watcher) watcher.closeAll();
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
