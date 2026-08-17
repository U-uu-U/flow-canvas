// ============================================================
// Flow Canvas — Electron Main Process
// ============================================================

const { app, BrowserWindow, ipcMain, shell, clipboard, nativeImage, dialog, protocol, net, Menu, screen } = require('electron');
const path = require('path');
const util = require('util');
const Store = require('./store');
const Watcher = require('./watcher');
const Thumbnailer = require('./thumbnailer');
const FlowCanvasBridge = require('./mcp-bridge');
const BrowserSyncService = require('./browser-sync');
const { handleLocalResourceRequest } = require('./local-resource');
const { DEFAULT_MCP_CONFIG } = require('../shared/plan-service-core.cjs');

const IS_MAC = process.platform === 'darwin';
const IS_WINDOWS = process.platform === 'win32';

// Some OpenAI-compatible relays close long-running HTTP/2 streams after completing the job.
// Keep Electron's proxy-aware network stack, but force HTTP/1.1 for reliable response delivery.
app.commandLine.appendSwitch('disable-http2');

let mainWindow = null;
let orbWindow = null;
let orbPosition = null;
let orbDragTimer = null;
const pendingOrbDropPaths = new Map();
let isQuitting = false;
let store = null;
let watcher = null;
let thumbnailer = null;
let flowCanvasBridge = null;
let browserSyncService = null;

const isDev = !app.isPackaged;

installSafeConsole();

if (IS_MAC) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' }
    ]));
} else {
    Menu.setApplicationMenu(null);
}

function installSafeConsole() {
    let stdoutBroken = false;
    let stderrBroken = false;

    const isBrokenPipe = (err) => err?.code === 'EPIPE' || /broken pipe/i.test(String(err?.message || ''));
    const markBroken = (stream) => {
        if (stream === process.stderr) stderrBroken = true;
        if (stream === process.stdout) stdoutBroken = true;
    };
    const isMarkedBroken = (stream) => {
        return stream === process.stderr ? stderrBroken : stdoutBroken;
    };

    const swallowBrokenPipe = (stream) => {
        stream?.on?.('error', (err) => {
            if (isBrokenPipe(err)) {
                markBroken(stream);
            }
        });
    };

    swallowBrokenPipe(process.stdout);
    swallowBrokenPipe(process.stderr);

    const safeWrite = (stream, args) => {
        if (!stream || isMarkedBroken(stream) || stream.destroyed) return;
        try {
            stream.write(`${util.format(...args)}\n`);
        } catch (err) {
            if (isBrokenPipe(err)) {
                markBroken(stream);
            }
        }
    };

    console.log = (...args) => safeWrite(process.stdout, args);
    console.info = (...args) => safeWrite(process.stdout, args);
    console.warn = (...args) => safeWrite(process.stderr, args);
    console.error = (...args) => safeWrite(process.stderr, args);

    process.on('uncaughtException', (err) => {
        if (isBrokenPipe(err)) return;
        safeWrite(process.stderr, ['[Main] Uncaught Exception:', err]);
        dialog.showErrorBox('Flow Canvas 主进程错误', err?.stack || err?.message || String(err));
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
        frame: IS_MAC,
        titleBarStyle: IS_MAC ? 'hiddenInset' : 'hidden',
        ...(IS_MAC
            ? { trafficLightPosition: { x: 14, y: 11 } }
            : {
                titleBarOverlay: {
                    color: '#0f0f14',
                    symbolColor: '#8a8f98',
                    height: 38
                }
            }),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false
        }
    });

    // 拦截外部拖拽图片导致的页面导航，自动下载图片并通知渲染进程
    mainWindow.webContents.on('will-navigate', async (e, url) => {
        e.preventDefault();
        // 检查是否像图片URL
        if (/^https?:\/\//i.test(url)) {
            console.log('[Main] 拦截到拖拽导航 URL:', url);
            try {
                // 从 store 读取默认保存文件夹
                const data = store.load();
                const targetDir = getBoardDefaultSaveFolder(data);
                const result = await downloadImageFromUrl(url, targetDir);
                if (result.success) {
                    mainWindow.webContents.send('external-image-dropped', result.filePath);
                } else {
                    console.error('[Main] 拖拽图片下载失败:', result.error);
                }
            } catch (err) {
                console.error('[Main] 拖拽图片处理异常:', err);
            }
        }
    });

    mainWindow.webContents.on('before-input-event', (e, input) => {
        if (input.type !== 'keyDown') return;
        const key = String(input.key || '').toLowerCase();
        const isRefresh = (input.control || input.meta) && key === 'r';
        const isHardRefresh = isRefresh && input.shift;
        if (input.key === 'F5' || isRefresh) {
            e.preventDefault();
            if (isHardRefresh) {
                mainWindow.webContents.reloadIgnoringCache();
            } else {
                mainWindow.webContents.reload();
            }
            return;
        }
        if (input.key === 'F12') {
            e.preventDefault();
            mainWindow.webContents.toggleDevTools();
        }
    });

    if (isDev) {
        mainWindow.loadURL('http://127.0.0.1:15321');
    } else {
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
        if (orbWindow && !orbWindow.isDestroyed()) {
            orbWindow.destroy();
        }
    });
}

const ORB_WINDOW_SIZE = 80;
const ORB_VISUAL_SIZE = 54;
const ORB_VISUAL_INSET = (ORB_WINDOW_SIZE - ORB_VISUAL_SIZE) / 2;
const ORB_DRAG_INTERVAL_MS = 8;

function clampOrbPosition(x, y) {
    const display = screen.getDisplayNearestPoint({
        x: Math.round(x + (ORB_WINDOW_SIZE / 2)),
        y: Math.round(y + (ORB_WINDOW_SIZE / 2))
    });
    const { bounds } = display;
    const minX = bounds.x - ORB_VISUAL_INSET;
    const minY = bounds.y - ORB_VISUAL_INSET;
    const maxX = bounds.x + bounds.width - ORB_VISUAL_SIZE - ORB_VISUAL_INSET;
    const maxY = bounds.y + bounds.height - ORB_VISUAL_SIZE - ORB_VISUAL_INSET;

    return {
        x: Math.round(Math.max(minX, Math.min(x, maxX))),
        y: Math.round(Math.max(minY, Math.min(y, maxY)))
    };
}

function positionOrbWindow() {
    if (!mainWindow || mainWindow.isDestroyed() || !orbWindow || orbWindow.isDestroyed()) return;

    if (!orbPosition) {
        const mainBounds = mainWindow.getBounds();
        const buttonCenterInset = 46;
        orbPosition = {
            x: mainBounds.x + mainBounds.width - buttonCenterInset - (ORB_WINDOW_SIZE / 2),
            y: mainBounds.y + mainBounds.height - buttonCenterInset - (ORB_WINDOW_SIZE / 2)
        };
    }

    orbPosition = clampOrbPosition(orbPosition.x, orbPosition.y);
    orbWindow.setPosition(orbPosition.x, orbPosition.y, false);
}

function moveOrbWindow(x, y) {
    if (!orbWindow || orbWindow.isDestroyed()) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    orbPosition = clampOrbPosition(x, y);
    orbWindow.setPosition(orbPosition.x, orbPosition.y, false);
}

function stopOrbDrag() {
    if (orbDragTimer) {
        clearInterval(orbDragTimer);
        orbDragTimer = null;
    }
}

function startOrbDrag() {
    stopOrbDrag();
    if (!orbWindow || orbWindow.isDestroyed()) return;

    const startCursor = screen.getCursorScreenPoint();
    const [startX, startY] = orbWindow.getPosition();
    let lastCursor = startCursor;

    const updatePosition = () => {
        if (!orbWindow || orbWindow.isDestroyed() || !orbWindow.isVisible()) {
            stopOrbDrag();
            return;
        }
        const cursor = screen.getCursorScreenPoint();
        if (cursor.x === lastCursor.x && cursor.y === lastCursor.y) return;
        lastCursor = cursor;
        moveOrbWindow(
            startX + cursor.x - startCursor.x,
            startY + cursor.y - startCursor.y
        );
    };

    orbDragTimer = setInterval(updatePosition, ORB_DRAG_INTERVAL_MS);
    orbDragTimer.unref?.();
}

async function createOrbWindow() {
    if (orbWindow && !orbWindow.isDestroyed()) return orbWindow;

    const nextOrbWindow = new BrowserWindow({
        width: ORB_WINDOW_SIZE,
        height: ORB_WINDOW_SIZE,
        useContentSize: true,
        transparent: true,
        backgroundColor: '#00000000',
        frame: false,
        thickFrame: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, 'orb-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false
        }
    });

    orbWindow = nextOrbWindow;
    nextOrbWindow.setBackgroundColor('#00000000');
    nextOrbWindow.setAlwaysOnTop(true, 'screen-saver');
    nextOrbWindow.setSkipTaskbar(true);

    try {
        nextOrbWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (err) {
        console.warn('[Main] Unable to show the floating button on every workspace:', err.message);
    }

    nextOrbWindow.on('closed', () => {
        stopOrbDrag();
        if (orbWindow === nextOrbWindow) orbWindow = null;
        if (!isQuitting && mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
            mainWindow.show();
            mainWindow.focus();
        }
    });

    try {
        await nextOrbWindow.loadFile(path.join(__dirname, 'orb.html'));
    } catch (err) {
        if (!nextOrbWindow.isDestroyed()) nextOrbWindow.destroy();
        throw err;
    }

    return nextOrbWindow;
}

async function collapseMainWindowToOrb() {
    if (!mainWindow || mainWindow.isDestroyed()) return false;

    const nextOrbWindow = await createOrbWindow();
    if (!nextOrbWindow || nextOrbWindow.isDestroyed()) return false;

    positionOrbWindow();
    nextOrbWindow.showInactive();
    mainWindow.hide();
    return true;
}

function restoreMainWindowFromOrb() {
    if (!mainWindow || mainWindow.isDestroyed()) return false;

    stopOrbDrag();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();

    if (orbWindow && !orbWindow.isDestroyed()) {
        orbWindow.hide();
    }

    if (pendingOrbDropPaths.size > 0 && !mainWindow.webContents.isDestroyed()) {
        const filePaths = Array.from(pendingOrbDropPaths.values());
        pendingOrbDropPaths.clear();
        mainWindow.webContents.send('orb-files-dropped', filePaths);
    }
    return true;
}

// ── 初始化服务 ──────────────────────────────────────────
function initServices() {
    store = new Store();
    browserSyncService = new BrowserSyncService(store);
    thumbnailer = new Thumbnailer();
    watcher = new Watcher(store, (event, filePath) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('file-change', { event, filePath });
        }
    });

    // 恢复上次的监听文件夹
    const boardData = store.load();
    const mcpConfig = {
        ...DEFAULT_MCP_CONFIG,
        ...(boardData.mcp || {}),
        host: '127.0.0.1',
        port: Number(boardData.mcp?.port) === 8765 ? DEFAULT_MCP_CONFIG.port : (boardData.mcp?.port || DEFAULT_MCP_CONFIG.port)
    };

    flowCanvasBridge = new FlowCanvasBridge({
        store,
        getDefaultSaveFolder: getBoardDefaultSaveFolder,
        getFallbackSaveDir: getSaveDir,
        getMainWindow: () => mainWindow,
        notifyRenderer: (event, data) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('mcp:store-updated', {
                    event,
                    data
                });
            }
        },
        notifyTaskSubmitted: (event) => {
            browserSyncService?.registerTaskRoute(event);
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('generation:task-submitted', event);
            }
        },
        notifyTaskCompleted: (event) => {
            browserSyncService?.markTaskCompleted(event.remoteTaskId, event.filePath);
        },
        notifyVideoProgress: (event) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('generation:video-progress', event);
            }
        }
    });
    flowCanvasBridge.start(mcpConfig);

    const activeGroup = (boardData.folderGroups || []).find(group => group.id === boardData.activeGroupId);
    const activeFolders = activeGroup?.folders || boardData.watchFolders || [];
    const knownFolders = [
        ...(boardData.watchFolders || []),
        ...(boardData.folderGroups || []).flatMap(group => group.folders || [])
    ];
    watcher.sync(activeFolders, knownFolders);
}

function buildOpenAiModelsUrl(endpoint) {
    const url = new URL(String(endpoint || '').trim());
    let pathName = url.pathname.replace(/\/+$/, '');

    if (!pathName || pathName === '/') {
        pathName = '/v1/models';
    } else if (/\/(?:chat\/completions|responses|completions)$/i.test(pathName)) {
        pathName = pathName.replace(/\/(?:chat\/completions|responses|completions)$/i, '');
        pathName = pathName.replace(/\/+$/, '') + '/models';
    } else if (/\/v1(?:\/.*)?$/i.test(pathName)) {
        pathName = pathName.replace(/\/v1(?:\/.*)?$/i, '/v1/models');
    } else if (!/\/models$/i.test(pathName)) {
        pathName += '/models';
    }

    url.pathname = pathName;
    url.search = '';
    url.hash = '';
    return url.toString();
}

function buildGeminiModelsUrl(endpoint, apiKey) {
    const rawEndpoint = String(endpoint || '').trim() || 'https://generativelanguage.googleapis.com/v1beta/models';
    const url = new URL(rawEndpoint);
    const match = url.pathname.match(/\/(v1(?:beta|alpha)?|v1)\/models/i);
    const version = match?.[1] || 'v1beta';
    url.pathname = `/${version}/models`;
    url.search = '';
    url.hash = '';
    if (apiKey) url.searchParams.set('key', apiKey);
    return url.toString();
}

function buildAnthropicModelsUrl(endpoint) {
    const url = new URL(String(endpoint || '').trim() || 'https://api.anthropic.com/v1/models');
    url.pathname = '/v1/models';
    url.search = '';
    url.hash = '';
    return url.toString();
}

function normalizeModelId(model, providerType) {
    const value = String(model || '').trim();
    if (!value) return '';
    return providerType === 'google' ? value.replace(/^models\//, '') : value;
}

function extractModelIds(payload, providerType) {
    const source = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
            ? payload.models
            : Array.isArray(payload)
                ? payload
                : [];

    const ids = source
        .map(item => normalizeModelId(item?.id || item?.name || item?.model || item, providerType))
        .filter(Boolean);

    return [...new Set(ids)].sort((a, b) => a.localeCompare(b, 'en', {
        numeric: true,
        sensitivity: 'base'
    }));
}

async function fetchModelList(config = {}) {
    const providerType = String(config.type || 'openai').toLowerCase();
    const endpoint = String(config.endpoint || '').trim();
    const apiKey = String(config.apiKey || '').trim();

    if (!endpoint && providerType !== 'google' && providerType !== 'anthropic') {
        return { success: false, error: '请先填写 API 端点' };
    }
    if (!apiKey) {
        return { success: false, error: '请先填写 API Key' };
    }

    try {
        let url;
        const headers = { Accept: 'application/json' };

        if (providerType === 'google') {
            url = buildGeminiModelsUrl(endpoint, apiKey);
            headers['x-goog-api-key'] = apiKey;
        } else if (providerType === 'anthropic') {
            url = buildAnthropicModelsUrl(endpoint);
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
        } else {
            url = buildOpenAiModelsUrl(endpoint);
            headers.Authorization = `Bearer ${apiKey}`;
        }

        const response = await net.fetch(url, {
            method: 'GET',
            headers,
            redirect: 'follow'
        });
        const text = await response.text();

        if (!response.ok) {
            return {
                success: false,
                error: `HTTP ${response.status}: ${(text || response.statusText || '').slice(0, 500)}`
            };
        }

        let payload;
        try {
            payload = JSON.parse(text);
        } catch (err) {
            return { success: false, error: '模型接口没有返回有效 JSON' };
        }

        const models = extractModelIds(payload, providerType);
        if (models.length === 0) {
            return { success: false, error: '接口响应中没有可用模型列表' };
        }

        return { success: true, models };
    } catch (err) {
        return { success: false, error: err.message || String(err) };
    }
}


// ── IPC 处理 ────────────────────────────────────────────

// 数据存储
ipcMain.handle('store:load', () => store.load());
ipcMain.handle('store:save', (_, data) => store.save(data));
ipcMain.on('store:saveSync', (event, data) => {
    event.returnValue = store.save(data);
});

ipcMain.handle('metrics:getBoardUsage', (event) => {
    try {
        const pid = event.sender.getOSProcessId ? event.sender.getOSProcessId() : null;
        const metric = app.getAppMetrics().find(item => item.pid === pid);
        return {
            success: true,
            pid,
            memory: metric?.memory || null
        };
    } catch (err) {
        console.error('[Metrics] 获取白板资源占用失败:', err);
        return { success: false, error: err.message };
    }
});

// 文件夹管理
ipcMain.handle('folder:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: '选择要关联的文件夹'
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('ai:fetchModels', async (_, config) => {
    return await fetchModelList(config);
});

ipcMain.handle('folder:watch', (_, folderPath) => {
    return watcher.add(folderPath);
});

ipcMain.handle('folder:syncWatches', (_, activeFolders, knownFolders = []) => {
    return watcher.sync(activeFolders, knownFolders);
});

ipcMain.handle('folder:scan', async (_, folderPath) => {
    return watcher.scanFolder(folderPath);
});

ipcMain.handle('folder:unwatch', (_, folderPath) => {
    return watcher.remove(folderPath);
});

ipcMain.handle('folder:moveFiles', async (_, filePaths, targetDir) => {
    return await moveFilesToFolder(filePaths, targetDir);
});

ipcMain.handle('folder:copyFiles', async (_, filePaths, targetDir) => {
    return await copyFilesToFolder(filePaths, targetDir);
});

ipcMain.handle('folder:copyFilesToExplorer', async (_, filePaths, options = {}) => {
    return await copyFilesToCurrentExplorer(filePaths, options);
});

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

ipcMain.handle('file:selectReplacement', async (_, options = {}) => {
    const originalPath = String(options.originalPath || '');
    const originalName = originalPath ? path.basename(originalPath) : '';
    const originalExt = originalPath ? path.extname(originalPath).replace(/^\./, '').toLowerCase() : '';
    const filters = originalExt
        ? [{ name: `${originalExt.toUpperCase()} 文件`, extensions: [originalExt] }, { name: '所有文件', extensions: ['*'] }]
        : [{ name: '所有文件', extensions: ['*'] }];
    const result = await dialog.showOpenDialog(mainWindow, {
        title: originalName ? `重接素材：${originalName}` : '选择替代素材',
        properties: ['openFile'],
        filters
    });
    if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
    }
    return { success: true, filePath: result.filePaths[0] };
});

ipcMain.handle('file:inspect', async (_, filePath) => {
    try {
        const stat = await fs.promises.stat(String(filePath || ''));
        return {
            success: true,
            exists: true,
            isFile: stat.isFile(),
            size: stat.size,
            modifiedAt: stat.mtime.toISOString()
        };
    } catch (error) {
        return {
            success: true,
            exists: false,
            isFile: false,
            error: error?.code || error?.message || String(error)
        };
    }
});


// 缩略图
ipcMain.handle('thumb:get', async (_, filePath, maxDim) => {
    return thumbnailer.getThumbnail(filePath, maxDim);
});

function psQuoted(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function writeTextWithPowerShell(text) {
    if (!IS_WINDOWS) return Promise.resolve(false);
    const fs = require('fs');
    const os = require('os');
    const { execFile } = require('child_process');
    const textPath = path.join(os.tmpdir(), `flow_clipboard_text_${process.pid}_${Date.now()}.txt`);
    const scriptPath = path.join(os.tmpdir(), `flow_clipboard_text_${process.pid}_${Date.now()}.ps1`);
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

    fs.writeFileSync(textPath, text, 'utf16le');
    const psContent = [
        'Add-Type -AssemblyName System.Windows.Forms',
        `$text = Get-Content -LiteralPath ${psQuoted(textPath)} -Raw -Encoding Unicode`,
        '$ok = $false',
        'for ($i = 0; $i -lt 10 -and -not $ok; $i++) {',
        '  try {',
        '    [System.Windows.Forms.Clipboard]::SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)',
        '    $actual = [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText)',
        '    if ($actual -eq $text) { $ok = $true } else { Start-Sleep -Milliseconds 80 }',
        '  } catch { Start-Sleep -Milliseconds 80 }',
        '}',
        'if (-not $ok) { throw "Clipboard text write failed" }',
        'Write-Output "DONE"'
    ].join('\r\n');
    writePowerShellScript(scriptPath, psContent);

    return new Promise((resolve) => {
        execFile(psExe, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
            { timeout: 8000, windowsHide: true },
            (err, stdout) => {
                try { fs.unlinkSync(textPath); } catch (_) { }
                try { fs.unlinkSync(scriptPath); } catch (_) { }
                resolve(!err && (stdout || '').includes('DONE'));
            }
        );
    });
}

async function writePlainTextToClipboard(text) {
    const value = String(text || '');
    try {
        clipboard.writeText(value, 'clipboard');
        if (clipboard.readText('clipboard') === value) {
            return { success: true, type: 'text', method: 'electron', verified: true };
        }
    } catch (err) {
        console.warn('[Clipboard] Electron text write failed:', err?.message);
    }

    const ok = IS_WINDOWS && await writeTextWithPowerShell(value);
    if (ok) {
        return { success: true, type: 'text', method: 'powershell', verified: true };
    }

    return { success: false, error: 'Clipboard text write failed' };
}

function appleScriptString(value) {
    return `"${String(value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/[\r\n]+/g, ' ')}"`;
}

function writeFileListToMacClipboard(filePaths) {
    const { execFile } = require('child_process');
    const script = `set the clipboard to {${filePaths
        .map(filePath => `POSIX file ${appleScriptString(filePath)}`)
        .join(', ')}}`;

    return new Promise((resolve) => {
        execFile('/usr/bin/osascript', ['-e', script], { timeout: 8000 }, (error) => {
            if (error) {
                resolve({ success: false, error: error.message });
                return;
            }
            const totalBytes = filePaths.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0);
            resolve({
                success: true,
                type: 'file',
                method: 'macos-pasteboard',
                count: filePaths.length,
                sizeMB: (totalBytes / 1024 / 1024).toFixed(1)
            });
        });
    });
}

async function writeFileDropListToClipboard(filePathOrPaths) {
    const os = require('os');
    const { execFile } = require('child_process');
    const paths = (Array.isArray(filePathOrPaths) ? filePathOrPaths : [filePathOrPaths])
        .filter(Boolean)
        .map(p => String(p));
    const existingPaths = paths.filter(p => {
        try {
            return fs.existsSync(p) && fs.statSync(p).isFile();
        } catch (_) {
            return false;
        }
    });

    if (existingPaths.length === 0) {
        return writePlainTextToClipboard(paths.join('\r\n'));
    }

    if (IS_MAC) {
        return writeFileListToMacClipboard(existingPaths);
    }

    if (!IS_WINDOWS) {
        return writePlainTextToClipboard(existingPaths.join('\n'));
    }

    const scriptPath = path.join(os.tmpdir(), `flow_clipboard_${process.pid}_${Date.now()}.ps1`);
    const dataPath = path.join(os.tmpdir(), `flow_clipboard_${process.pid}_${Date.now()}.json`);
    const asciiJson = JSON.stringify(existingPaths).replace(/[^\x00-\x7F]/g, ch => {
        return ch.split('').map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    });
    fs.writeFileSync(dataPath, asciiJson, 'ascii');

    const psContent = [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.Windows.Forms',
        `$paths = Get-Content -LiteralPath ${psQuoted(dataPath)} -Raw | ConvertFrom-Json`,
        '$col = New-Object System.Collections.Specialized.StringCollection',
        'foreach ($p in $paths) { [void]$col.Add([string]$p) }',
        '$data = New-Object System.Windows.Forms.DataObject',
        '$data.SetFileDropList($col)',
        '$data.SetText(($paths -join "`r`n"), [System.Windows.Forms.TextDataFormat]::UnicodeText)',
        '$dropEffect = [byte[]](5,0,0,0)',
        '$stream = New-Object System.IO.MemoryStream(,$dropEffect)',
        '$data.SetData("Preferred DropEffect", $stream)',
        '$ok = $false',
        'for ($i = 0; $i -lt 8 -and -not $ok; $i++) {',
        '  try { [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 8, 80); $ok = $true }',
        '  catch { Start-Sleep -Milliseconds 80 }',
        '}',
        'if (-not $ok) { throw "Clipboard write failed" }',
        '[pscustomobject]@{ success = $true } | ConvertTo-Json -Compress'
    ].join('\r\n');
    writePowerShellScript(scriptPath, psContent);

    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

    return new Promise((resolve) => {
        execFile(psExe, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
            timeout: 8000,
            windowsHide: true
        }, (err, stdout, stderr) => {
            try { fs.unlinkSync(scriptPath); } catch (_) { }
            try { fs.unlinkSync(dataPath); } catch (_) { }
            if (err) {
                console.warn('[Clipboard] PowerShell 失败，降级为文本:', err?.message);
                writePlainTextToClipboard(existingPaths.join('\r\n')).then(resolve);
                return;
            }
            try {
                const parsed = JSON.parse(String(stdout || '').trim() || '{}');
                if (!parsed?.success) {
                    writePlainTextToClipboard(existingPaths.join('\r\n')).then(resolve);
                    return;
                }
            } catch (parseErr) {
                writePlainTextToClipboard(existingPaths.join('\r\n')).then(resolve);
                return;
            }

            const filePath = existingPaths[0];
            const totalBytes = existingPaths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
            const sizeMB = (totalBytes / 1024 / 1024).toFixed(1);
            console.log(`[Clipboard] 文件引用写入成功: ${path.basename(filePath)} (${sizeMB}MB)`);
            resolve({ success: true, type: 'file', count: existingPaths.length, sizeMB });
        });
    });
}

// 剪贴板 — 复制文件引用（和资源管理器右键→复制一样）
ipcMain.handle('clipboard:copy', async (_, filePathOrPaths) => {
    try {
        return await writeFileDropListToClipboard(filePathOrPaths);
    } catch (err) {
        console.error('[Clipboard] 复制失败:', err);
        return { success: false, error: err.message };
    }
});

// 剪贴板 — 写入纯文本（用于 AI IDE 引用地址）
ipcMain.handle('clipboard:writeText', async (_, text) => {
    try {
        return await writePlainTextToClipboard(text);
    } catch (err) {
        console.error('[Clipboard] 写入文本失败:', err);
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

const RAVENHASH_URLS = Object.freeze({
    ai: 'https://ai.ravenhash.org/',
    art: 'https://art.ravenhash.org/'
});

ipcMain.handle('shell:openRavenHash', async (_, site) => {
    const targetUrl = RAVENHASH_URLS[site];
    if (!targetUrl) throw new Error('Unknown RavenHash site');
    await shell.openExternal(targetUrl);
    return true;
});

// 原生文件拖放到外部应用（支持单文件或多文件）
ipcMain.on('drag:start', (event, filePathOrPaths) => {
    try {
        const filePaths = Array.isArray(filePathOrPaths) ? filePathOrPaths : [filePathOrPaths];
        startFileDrag(event, filePaths);
    } catch (err) {
        console.error('[Main] startDrag 失败:', err);
    }
});

ipcMain.on('drag:startExportCopy', (event, filePathOrPaths) => {
    try {
        const sourcePaths = Array.isArray(filePathOrPaths) ? filePathOrPaths : [filePathOrPaths];
        const exportPaths = createDragExportCopies(sourcePaths);
        startFileDrag(event, exportPaths);
    } catch (err) {
        console.error('[Main] startExportCopy 失败:', err);
    }
});

function startFileDrag(event, filePaths) {
    const paths = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean).map(p => String(p));
    if (paths.length === 0) return;

    // 用第一个图片文件生成拖拽图标
    let icon = nativeImage.createEmpty();
    for (const fp of paths) {
        const img = nativeImage.createFromPath(fp);
        if (!img.isEmpty()) {
            icon = img.resize({ width: 128, height: 128 });
            break;
        }
    }

    if (paths.length === 1) {
        event.sender.startDrag({
            file: paths[0],
            icon: icon
        });
    } else {
        event.sender.startDrag({
            files: paths,
            icon: icon
        });
    }
}

function createDragExportCopies(filePaths) {
    const paths = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean).map(p => String(p));
    const exportRoot = path.join(app.getPath('temp'), 'FlowCanvasDragExport');
    const exportDir = path.join(exportRoot, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(exportDir, { recursive: true });
    cleanupOldDragExports(exportRoot);

    const copied = [];
    paths.forEach(source => {
        const sourcePath = path.resolve(source);
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) return;
        const targetPath = getAvailableArchivePath(exportDir, sourcePath);
        fs.copyFileSync(sourcePath, targetPath);
        copied.push(targetPath);
    });

    return copied;
}

function cleanupOldDragExports(exportRoot) {
    try {
        if (!fs.existsSync(exportRoot)) return;
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        fs.readdirSync(exportRoot, { withFileTypes: true }).forEach(entry => {
            if (!entry.isDirectory()) return;
            const fullPath = path.join(exportRoot, entry.name);
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs < cutoff) {
                fs.rmSync(fullPath, { recursive: true, force: true });
            }
        });
    } catch (err) {
        console.warn('[Main] 清理拖拽导出缓存失败:', err.message);
    }
}

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

ipcMain.handle('window:collapseToOrb', () => collapseMainWindowToOrb());
ipcMain.handle('window:restoreFromOrb', (event) => {
    if (!orbWindow || orbWindow.isDestroyed() || event.sender !== orbWindow.webContents) return false;
    return restoreMainWindowFromOrb();
});
ipcMain.handle('window:queueOrbFiles', async (event, payload) => {
    const legacyFilePaths = Array.isArray(payload) ? payload : [];
    const filePaths = Array.isArray(payload?.filePaths) ? payload.filePaths : legacyFilePaths;
    const urls = Array.isArray(payload?.urls) ? payload.urls : [];
    const sourceCount = filePaths.length + urls.length;

    if (!orbWindow || orbWindow.isDestroyed() || event.sender !== orbWindow.webContents) {
        return { accepted: 0, added: 0, rejected: sourceCount, queued: pendingOrbDropPaths.size, errors: [] };
    }

    let accepted = 0;
    let added = 0;
    const errors = [];
    const queueFile = (filePath) => {
        if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false;
        try {
            if (!fs.statSync(filePath).isFile()) return false;
            const normalizedPath = path.normalize(filePath);
            const pathKey = process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
            accepted += 1;
            if (!pendingOrbDropPaths.has(pathKey)) added += 1;
            pendingOrbDropPaths.set(pathKey, normalizedPath);
            return true;
        } catch (err) {
            console.warn('[Orb] Ignoring unavailable dropped file:', filePath, err.message);
            return false;
        }
    };

    filePaths.forEach(queueFile);

    const targetDir = getBoardDefaultSaveFolder(store?.load?.()) || getSaveDir();
    for (const rawUrl of urls.slice(0, 20)) {
        if (typeof rawUrl !== 'string' || !/^https?:\/\//i.test(rawUrl)) continue;
        const result = await downloadImageFromUrl(rawUrl, targetDir);
        if (!result?.success || !queueFile(result.filePath)) {
            errors.push({ url: rawUrl, error: result?.error || 'Downloaded file is unavailable' });
        }
    }

    const result = {
        accepted,
        added,
        rejected: Math.max(0, sourceCount - accepted),
        queued: pendingOrbDropPaths.size,
        errors
    };
    if (accepted > 0) restoreMainWindowFromOrb();
    return result;
});
ipcMain.on('window:startOrbDrag', (event) => {
    if (!orbWindow || orbWindow.isDestroyed() || event.sender !== orbWindow.webContents) return;
    startOrbDrag();
});
ipcMain.on('window:stopOrbDrag', (event) => {
    if (!orbWindow || orbWindow.isDestroyed() || event.sender !== orbWindow.webContents) return;
    stopOrbDrag();
});

// ── 网页图片摘取 ────────────────────────────────────────
const fs = require('fs');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

function writePowerShellScript(scriptPath, content) {
    fs.writeFileSync(scriptPath, `\uFEFF${content}`, 'utf8');
}

function normalizeExplorerCopyError(error) {
    const text = String(error || '').trim();
    if (!text) return '复制失败';
    if (text.includes('FC_NO_WINDOW')) return '鼠标下方没有可用窗口';
    if (text.includes('FC_NOT_EXPLORER') || text.includes('FC_RELEASE_ON_EXPLORER')) {
        return '请把鼠标松在资源管理器文件夹窗口上';
    }
    if (text.includes('FC_NO_EXPLORER_FOLDER')) return '未找到打开的资源管理器文件夹';
    if (text.includes('FC_PASTE_NO_RESULT')) return '资源管理器粘贴没有返回结果';
    if (text.includes('FC_MOUSE_TIMEOUT')) return '拖拽超时，未检测到鼠标松开';
    return text;
}

function getSaveDir() {
    const dir = path.join(app.getPath('userData'), 'data', 'captured');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function getBoardDefaultSaveFolder(data) {
    const groups = data?.folderGroups || [];
    const activeGroup = groups.find(group => group.id === data?.activeGroupId);
    const activeFolders = activeGroup?.folders || [];

    if (activeGroup?.defaultSaveFolder && activeFolders.includes(activeGroup.defaultSaveFolder)) {
        return activeGroup.defaultSaveFolder;
    }

    return activeFolders[0] || (data?.watchFolders && data.watchFolders[0]) || data?.activeGroupDefaultSaveFolder || null;
}

// 从 URL 下载图片到本地（saveDir 由前端传入）
ipcMain.handle('image:downloadFromUrl', async (_, url, targetDir) => {
    return await downloadImageFromUrl(url, targetDir);
});

ipcMain.handle('image:archiveLocalFile', async (_, filePath, targetDir) => {
    return await archiveLocalFile(filePath, targetDir);
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
ipcMain.handle('mcp:image:generate', async (_, body) => {
    try {
        if (!flowCanvasBridge) {
            return { success: false, error: 'Flow Canvas bridge is not ready' };
        }
        return { success: true, ...(await flowCanvasBridge.generateImageFromRenderer(body || {})) };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('mcp:image:compress-references', async (_, body) => {
    try {
        if (!flowCanvasBridge) {
            return { success: false, error: 'Flow Canvas bridge is not ready' };
        }
        return { success: true, ...(await flowCanvasBridge.compressVideoReferenceImagesFromRenderer({
            ...(body || {}),
            uploadBudgetBytes: Number(body?.uploadBudgetBytes) || 6 * 1024 * 1024
        })) };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('mcp:video:compress-references', async (_, body) => {
    try {
        if (!flowCanvasBridge) {
            return { success: false, error: 'Flow Canvas bridge is not ready' };
        }
        return { success: true, ...(await flowCanvasBridge.compressVideoReferenceImagesFromRenderer(body || {})) };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('mcp:video:generate', async (_, body) => {
    try {
        if (!flowCanvasBridge) {
            return { success: false, error: 'Flow Canvas bridge is not ready' };
        }
        return { success: true, ...(await flowCanvasBridge.generateVideoFromRenderer(body || {})) };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('mcp:video:resume', async (_, body) => {
    try {
        if (!flowCanvasBridge) {
            return { success: false, error: 'Flow Canvas bridge is not ready' };
        }
        return { success: true, ...(await flowCanvasBridge.resumeVideoFromRenderer(body || {})) };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('browser-sync:get-events', async () => {
    return browserSyncService?.getEvents?.() || [];
});

function isPathInside(parentDir, filePath) {
    const relative = path.relative(path.resolve(parentDir), path.resolve(filePath));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function getAvailableArchivePath(saveDir, sourcePath) {
    const parsed = path.parse(path.basename(sourcePath));
    const firstChoice = path.join(saveDir, path.basename(sourcePath));
    if (!fs.existsSync(firstChoice)) return firstChoice;

    const sourceKey = crypto.createHash('md5').update(path.resolve(sourcePath)).digest('hex').slice(0, 8);
    const hashedChoice = path.join(saveDir, `${parsed.name}_${sourceKey}${parsed.ext}`);
    if (!fs.existsSync(hashedChoice)) return hashedChoice;

    for (let i = 2; i < 1000; i++) {
        const candidate = path.join(saveDir, `${parsed.name}_${sourceKey}_${i}${parsed.ext}`);
        if (!fs.existsSync(candidate)) return candidate;
    }

    throw new Error('No available archive filename');
}

async function archiveLocalFile(filePath, targetDir) {
    try {
        if (!filePath) {
            return { success: false, error: 'Missing file path' };
        }

        const sourcePath = path.resolve(String(filePath));
        if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
            return { success: false, error: 'Source file does not exist' };
        }

        const saveDir = path.resolve(targetDir || getSaveDir());
        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

        if (isPathInside(saveDir, sourcePath)) {
            return { success: true, filePath: sourcePath, archived: false, reason: 'already-in-target' };
        }

        const archivedPath = getAvailableArchivePath(saveDir, sourcePath);
        await fs.promises.copyFile(sourcePath, archivedPath);
        return { success: true, filePath: archivedPath, archived: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

async function moveFilesToFolder(filePaths, targetDir) {
    try {
        const paths = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean).map(p => String(p));
        if (!targetDir) {
            return { success: false, error: 'Missing target folder', moved: [] };
        }

        const saveDir = path.resolve(String(targetDir));
        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

        const moved = [];
        const errors = [];

        for (const source of paths) {
            try {
                const sourcePath = path.resolve(source);
                if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
                    errors.push({ source, error: 'Source file does not exist' });
                    continue;
                }

                if (isPathInside(saveDir, sourcePath)) {
                    moved.push({ oldPath: sourcePath, newPath: sourcePath, moved: false, reason: 'already-in-target' });
                    continue;
                }

                const targetPath = getAvailableArchivePath(saveDir, sourcePath);
                await fs.promises.rename(sourcePath, targetPath);
                moved.push({ oldPath: sourcePath, newPath: targetPath, moved: true });
            } catch (err) {
                errors.push({ source, error: err.message });
            }
        }

        return {
            success: moved.length > 0,
            moved,
            errors
        };
    } catch (err) {
        return { success: false, error: err.message, moved: [] };
    }
}

async function copyFilesToFolder(filePaths, targetDir) {
    try {
        const paths = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean).map(p => String(p));
        if (!targetDir) {
            return { success: false, error: 'Missing target folder', copied: [] };
        }

        const saveDir = path.resolve(String(targetDir));
        if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

        const copied = [];
        const errors = [];

        for (const source of paths) {
            try {
                const sourcePath = path.resolve(source);
                if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
                    errors.push({ source, error: 'Source file does not exist' });
                    continue;
                }

                if (isPathInside(saveDir, sourcePath)) {
                    copied.push({ oldPath: sourcePath, newPath: sourcePath, copied: false, reason: 'already-in-target' });
                    continue;
                }

                const targetPath = getAvailableArchivePath(saveDir, sourcePath);
                await fs.promises.copyFile(sourcePath, targetPath);
                copied.push({ oldPath: sourcePath, newPath: targetPath, copied: true });
            } catch (err) {
                errors.push({ source, error: err.message });
            }
        }

        return {
            success: copied.length > 0,
            copied,
            errors
        };
    } catch (err) {
        return { success: false, error: err.message, copied: [] };
    }
}

async function copyFilesToCurrentExplorer(filePaths, options = {}) {
    try {
        const paths = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean).map(p => String(p));
        if (paths.length === 0) {
            return { success: false, error: 'No files selected', copied: [] };
        }

        if (IS_MAC) {
            const clipboardResult = await writeFileDropListToClipboard(paths);
            return {
                success: false,
                error: clipboardResult?.error || null,
                copied: [],
                clipboardReady: clipboardResult?.success === true,
                explorerMethod: 'finder-clipboard'
            };
        }

        if (options?.waitForMouseUp) {
            const released = await waitForPrimaryMouseRelease(options.timeoutMs);
            if (!released.success) {
                return { success: false, error: released.error || '未检测到鼠标松开', copied: [] };
            }
        }

        const explorer = await getCurrentExplorerFolder({
            requireUnderMouse: options?.requireExplorerUnderMouse === true
        });
        if (!explorer?.success || !explorer.path) {
            const pasted = await pasteFilesIntoExplorerUnderMouse(paths);
            if (pasted?.success) {
                return {
                    success: true,
                    copied: paths.map(source => ({ oldPath: source, newPath: null, copied: true, pasted: true })),
                    pasted: true,
                    explorerMethod: pasted.method || 'clipboard-paste'
                };
            }

            return {
                success: false,
                error: pasted?.error || explorer?.error || '未找到打开的资源管理器文件夹',
                copied: [],
                clipboardReady: pasted?.clipboardReady === true
            };
        }

        if (!isUsableExplorerFolderPath(explorer.path)) {
            const pasted = await pasteFilesIntoExplorerUnderMouse(paths);
            if (pasted?.success) {
                return {
                    success: true,
                    copied: paths.map(source => ({ oldPath: source, newPath: null, copied: true, pasted: true })),
                    pasted: true,
                    explorerMethod: pasted.method || 'clipboard-paste'
                };
            }

            return {
                success: false,
                error: pasted?.error || 'Explorer folder path encoding failed',
                copied: [],
                clipboardReady: pasted?.clipboardReady === true,
                targetDir: explorer.path
            };
        }

        const result = await copyFilesToFolder(paths, explorer.path);
        return {
            ...result,
            targetDir: explorer.path,
            explorerMethod: explorer.method || null
        };
    } catch (err) {
        return { success: false, error: err.message, copied: [] };
    }
}

function waitForPrimaryMouseRelease(timeoutMs = 8000) {
    const os = require('os');
    const { execFile } = require('child_process');
    const scriptPath = path.join(os.tmpdir(), `flow_canvas_mouseup_${process.pid}_${Date.now()}.ps1`);
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const timeout = Math.max(500, Math.min(Number(timeoutMs) || 8000, 15000));
    const script = [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.Windows.Forms',
        `for ($i = 0; $i -lt ${Math.ceil(timeout / 40)}; $i++) {`,
        '  if (-not ([System.Windows.Forms.Control]::MouseButtons -band [System.Windows.Forms.MouseButtons]::Left)) {',
        '    [pscustomobject]@{ success = $true } | ConvertTo-Json -Compress',
        '    exit 0',
        '  }',
        '  Start-Sleep -Milliseconds 40',
        '}',
        '[pscustomobject]@{ success = $false; error = "FC_MOUSE_TIMEOUT" } | ConvertTo-Json -Compress'
    ].join('\r\n');

    writePowerShellScript(scriptPath, script);

    return new Promise((resolve) => {
        execFile(psExe, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
            timeout: timeout + 2000,
            windowsHide: true
        }, (err, stdout, stderr) => {
            try { fs.unlinkSync(scriptPath); } catch (_) { }
            if (err) {
                resolve({ success: false, error: normalizeExplorerCopyError(stderr?.trim() || err.message) });
                return;
            }
            try {
                const parsed = JSON.parse(String(stdout || '').trim() || '{}');
                if (parsed?.error) parsed.error = normalizeExplorerCopyError(parsed.error);
                resolve(parsed);
            } catch (parseErr) {
                resolve({ success: false, error: parseErr.message });
            }
        });
    });
}

async function pasteFilesIntoExplorerUnderMouse(filePaths) {
    const explorerTarget = await verifyExplorerUnderMouse();
    if (!explorerTarget?.success) {
        return {
            success: false,
            error: explorerTarget?.error || '请把鼠标松在资源管理器文件夹窗口上',
            clipboardReady: false
        };
    }

    const clipboardResult = await writeFileDropListToClipboard(filePaths);
    if (!clipboardResult?.success || clipboardResult.type !== 'file') {
        return {
            success: false,
            error: clipboardResult?.error || '写入系统文件剪贴板失败',
            clipboardReady: false
        };
    }

    const pasteResult = await sendPasteToExplorerUnderMouse();
    if (pasteResult?.success) {
        return {
            success: true,
            method: pasteResult.method || 'clipboard-paste',
            clipboardReady: true
        };
    }

    return {
        success: false,
        error: pasteResult?.error || '未找到鼠标下方的资源管理器窗口，文件已放入剪贴板，可在目标文件夹按 Ctrl+V',
        clipboardReady: true
    };
}

function verifyExplorerUnderMouse() {
    const os = require('os');
    const { execFile } = require('child_process');
    const scriptPath = path.join(os.tmpdir(), `flow_canvas_explorer_check_${process.pid}_${Date.now()}.ps1`);
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -TypeDefinition @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class Win32FlowCanvasExplorerCheck {',
        '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
        '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);',
        '  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);',
        '  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);',
        '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
        '}',
        '"@',
        '$point = New-Object Win32FlowCanvasExplorerCheck+POINT',
        '[void][Win32FlowCanvasExplorerCheck]::GetCursorPos([ref]$point)',
        '$hwnd = [Win32FlowCanvasExplorerCheck]::WindowFromPoint($point)',
        'if ($hwnd -eq [IntPtr]::Zero) { throw "FC_NO_WINDOW" }',
        '$root = [Win32FlowCanvasExplorerCheck]::GetAncestor($hwnd, 2)',
        'if ($root -eq [IntPtr]::Zero) { $root = $hwnd }',
        '$pidValue = 0',
        '[void][Win32FlowCanvasExplorerCheck]::GetWindowThreadProcessId($root, [ref]$pidValue)',
        '$processName = ""',
        'try { $processName = (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch {}',
        'if ($processName -ne "explorer") { throw "FC_RELEASE_ON_EXPLORER" }',
        '[pscustomobject]@{ success = $true } | ConvertTo-Json -Compress'
    ].join('\r\n');

    writePowerShellScript(scriptPath, script);

    return new Promise((resolve) => {
        execFile(psExe, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
            timeout: 5000,
            windowsHide: true
        }, (err, stdout, stderr) => {
            try { fs.unlinkSync(scriptPath); } catch (_) { }
            if (err) {
                resolve({ success: false, error: normalizeExplorerCopyError(stderr?.trim() || err.message) });
                return;
            }
            try {
                resolve(JSON.parse(String(stdout || '').trim() || '{}'));
            } catch (parseErr) {
                resolve({ success: false, error: parseErr.message });
            }
        });
    });
}

function sendPasteToExplorerUnderMouse() {
    const os = require('os');
    const { execFile } = require('child_process');
    const scriptPath = path.join(os.tmpdir(), `flow_canvas_explorer_paste_${process.pid}_${Date.now()}.ps1`);
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = [
        '$ErrorActionPreference = "Stop"',
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -TypeDefinition @"',
        'using System;',
        'using System.Text;',
        'using System.Runtime.InteropServices;',
        'public static class Win32FlowCanvas {',
        '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
        '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);',
        '  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);',
        '  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);',
        '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
        '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
        '  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);',
        '}',
        '"@',
        '$point = New-Object Win32FlowCanvas+POINT',
        '[void][Win32FlowCanvas]::GetCursorPos([ref]$point)',
        '$hwnd = [Win32FlowCanvas]::WindowFromPoint($point)',
        'if ($hwnd -eq [IntPtr]::Zero) { throw "FC_NO_WINDOW" }',
        '$root = [Win32FlowCanvas]::GetAncestor($hwnd, 2)',
        'if ($root -eq [IntPtr]::Zero) { $root = $hwnd }',
        '$pidValue = 0',
        '[void][Win32FlowCanvas]::GetWindowThreadProcessId($root, [ref]$pidValue)',
        '$processName = ""',
        'try { $processName = (Get-Process -Id $pidValue -ErrorAction Stop).ProcessName } catch {}',
        'if ($processName -ne "explorer") { throw "FC_NOT_EXPLORER" }',
        '[void][Win32FlowCanvas]::ShowWindowAsync($root, 9)',
        '[void][Win32FlowCanvas]::SetForegroundWindow($root)',
        'Start-Sleep -Milliseconds 120',
        '[System.Windows.Forms.SendKeys]::SendWait("^v")',
        '[pscustomobject]@{ success = $true; method = "clipboard-paste-under-mouse" } | ConvertTo-Json -Compress'
    ].join('\r\n');

    writePowerShellScript(scriptPath, script);

    return new Promise((resolve) => {
        execFile(psExe, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
            timeout: 8000,
            windowsHide: true
        }, (err, stdout, stderr) => {
            try { fs.unlinkSync(scriptPath); } catch (_) { }
            if (err) {
                resolve({ success: false, error: normalizeExplorerCopyError(stderr?.trim() || err.message) });
                return;
            }
            try {
                const text = String(stdout || '').trim();
                if (!text) {
                    resolve({ success: false, error: normalizeExplorerCopyError('FC_PASTE_NO_RESULT') });
                    return;
                }
                resolve(JSON.parse(text));
            } catch (parseErr) {
                resolve({ success: false, error: parseErr.message });
            }
        });
    });
}

function isUsableExplorerFolderPath(folderPath) {
    const value = String(folderPath || '');
    if (!value || value.includes('\uFFFD')) return false;
    try {
        return fs.existsSync(value) && fs.statSync(value).isDirectory();
    } catch (_) {
        return false;
    }
}

function getCurrentExplorerFolder(options = {}) {
    const os = require('os');
    const { execFile } = require('child_process');
    const scriptPath = path.join(os.tmpdir(), `flow_canvas_explorer_${process.pid}_${Date.now()}.ps1`);
    const outputPath = path.join(os.tmpdir(), `flow_canvas_explorer_${process.pid}_${Date.now()}.json`);
    const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const requireUnderMouse = options?.requireUnderMouse === true;
    const script = [
        '$ErrorActionPreference = "Stop"',
        `$outputPath = ${psQuoted(outputPath)}`,
        'function Write-FlowCanvasResult($payload) {',
        '  $json = $payload | ConvertTo-Json -Compress',
        '  $utf8 = New-Object System.Text.UTF8Encoding($false)',
        '  [System.IO.File]::WriteAllText($outputPath, $json, $utf8)',
        '}',
        `$requireUnderMouse = ${requireUnderMouse ? '$true' : '$false'}`,
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -TypeDefinition @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class Win32FlowCanvasExplorer {',
        '  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }',
        '  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);',
        '  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);',
        '  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint gaFlags);',
        '}',
        '"@',
        '$mouse = [System.Windows.Forms.Cursor]::Position',
        '$point = New-Object Win32FlowCanvasExplorer+POINT',
        '[void][Win32FlowCanvasExplorer]::GetCursorPos([ref]$point)',
        '$mouseRoot = [Win32FlowCanvasExplorer]::GetAncestor([Win32FlowCanvasExplorer]::WindowFromPoint($point), 2)',
        '$mouseRootHandle = if ($mouseRoot -ne [IntPtr]::Zero) { $mouseRoot.ToInt64() } else { 0 }',
        '$shell = New-Object -ComObject Shell.Application',
        '$items = @()',
        'foreach ($w in @($shell.Windows())) {',
        '  try {',
        '    $fullName = [string]$w.FullName',
        '    if ([string]::IsNullOrWhiteSpace($fullName) -or ($fullName -notmatch "(?i)explorer\\.exe$")) { continue }',
        '    $path = [string]$w.Document.Folder.Self.Path',
        '    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Container)) { continue }',
        '    $left = [int]$w.Left; $top = [int]$w.Top; $width = [int]$w.Width; $height = [int]$w.Height',
        '    $underMouse = ($mouse.X -ge $left -and $mouse.X -le ($left + $width) -and $mouse.Y -ge $top -and $mouse.Y -le ($top + $height))',
        '    $handleMatch = ([int64]$w.HWND -eq $mouseRootHandle)',
        '    $items += [pscustomobject]@{ Path = $path; HandleMatch = $handleMatch; UnderMouse = $underMouse; Left = $left; Top = $top; Width = $width; Height = $height }',
        '  } catch {}',
        '}',
        '$target = $items | Where-Object { $_.HandleMatch } | Select-Object -First 1',
        '$method = "window-handle"',
        'if (-not $target) {',
        '  $target = $items | Where-Object { $_.UnderMouse } | Select-Object -First 1',
        '  $method = "under-mouse"',
        '}',
        'if ($requireUnderMouse -and -not $target) {',
        '  Write-FlowCanvasResult ([pscustomobject]@{ success = $false; error = "FC_RELEASE_ON_EXPLORER" })',
        '  exit 0',
        '}',
        'if (-not $target) {',
        '  $target = $items | Select-Object -Last 1',
        '  $method = "last-open"',
        '}',
        'if ($target) {',
        '  Write-FlowCanvasResult ([pscustomobject]@{ success = $true; path = $target.Path; method = $method; count = @($items).Count })',
        '} else {',
        '  Write-FlowCanvasResult ([pscustomobject]@{ success = $false; error = "FC_NO_EXPLORER_FOLDER" })',
        '}'
    ].join('\r\n');

    writePowerShellScript(scriptPath, script);

    return new Promise((resolve) => {
        execFile(psExe, ['-STA', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
            timeout: 6000,
            windowsHide: true
        }, (err, stdout, stderr) => {
            try { fs.unlinkSync(scriptPath); } catch (_) { }
            if (err) {
                try { fs.unlinkSync(outputPath); } catch (_) { }
                resolve({ success: false, error: normalizeExplorerCopyError(stderr?.trim() || err.message) });
                return;
            }
            try {
                const text = fs.existsSync(outputPath)
                    ? fs.readFileSync(outputPath, 'utf8').trim()
                    : String(stdout || '').trim();
                try { fs.unlinkSync(outputPath); } catch (_) { }
                if (!text) {
                    resolve({ success: false, error: normalizeExplorerCopyError('FC_NO_EXPLORER_FOLDER') });
                    return;
                }
                const parsed = JSON.parse(text || '{}');
                if (parsed?.error) parsed.error = normalizeExplorerCopyError(parsed.error);
                if (parsed?.success && parsed.path && !isUsableExplorerFolderPath(parsed.path)) {
                    parsed.success = false;
                    parsed.error = 'Explorer folder path encoding failed';
                }
                resolve(parsed);
            } catch (parseErr) {
                try { fs.unlinkSync(outputPath); } catch (_) { }
                resolve({ success: false, error: parseErr.message });
            }
        });
    });
}

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
    protocol.handle('local-res', handleLocalResourceRequest);

    initServices();
    createWindow();
});

app.on('before-quit', () => {
    isQuitting = true;
});

app.on('window-all-closed', () => {
    if (watcher) watcher.closeAll();
    if (flowCanvasBridge) flowCanvasBridge.stop();
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
        restoreMainWindowFromOrb();
    } else if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
