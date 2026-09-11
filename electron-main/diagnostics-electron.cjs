const { app, ipcMain, dialog, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { DiagnosticLog, setDiagnosticLog } = require('./diagnostics.cjs');
const appVersion = require('../package.json').version;

function installDiagnostics({ getWindow, getTasks, getSecrets }) {
    const knownSecrets = new Set();
    const remember = value => {
        if (typeof value !== 'string' || value.length < 4) return;
        if (knownSecrets.size >= 1000) knownSecrets.delete(knownSecrets.values().next().value);
        knownSecrets.add(value);
        knownSecrets.add(value.replace(/^(Bearer|Basic)\s+/i, ''));
    };
    const log = new DiagnosticLog(path.join(app.getPath('userData'), 'diagnostics'), { getSecrets: () => {
        try { (getSecrets?.() || []).forEach(remember); } catch { /* Retain credentials already seen in this session. */ }
        return [...knownSecrets];
    } });
    setDiagnosticLog(log);
    log.record('info', 'app.start', { version: appVersion, platform: process.platform, arch: process.arch, packaged: app.isPackaged });
    for (const level of ['warn', 'error']) {
        const original = console[level].bind(console);
        console[level] = (...args) => { log.record(level, 'console.main', { args }); original(...args); };
    }
    process.on('uncaughtExceptionMonitor', error => { log.record('error', 'main.uncaught', error); log.flush(); });
    process.on('unhandledRejection', error => { log.record('error', 'main.unhandledRejection', error); log.flush(); });
    app.on('before-quit', () => { log.record('info', 'app.quit'); log.flush(); });
    app.on('will-quit', () => log.flush());
    app.on('web-contents-created', (_event, web) => {
        web.on('console-message', (_e, level, message, line, source) => {
            if (level >= 2) log.record(level === 2 ? 'warn' : 'error', 'renderer.console', { webContentsId: web.id, message, line, source });
        });
        web.on('render-process-gone', (_e, details) => { log.record('error', 'renderer.gone', { webContentsId: web.id, ...details }); log.flush(); });
        web.on('unresponsive', () => log.record('error', 'renderer.unresponsive', { webContentsId: web.id }));
        web.on('did-fail-load', (_e, code, description, url, isMainFrame) => log.record('error', 'renderer.loadFailed', { code, description, url, isMainFrame }));
    });
    app.on('child-process-gone', (_e, details) => log.record('error', 'process.gone', details));
    const originalHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, listener) => originalHandle(channel, async (event, ...args) => {
        if (channel.startsWith('diagnostics:')) return listener(event, ...args);
        const tracked = /^(mcp:|agent:|mcp-client:|ai:|image:|thumb:|asset:|store:save)/.test(channel)
            && !/:(get|list|recovery-list|get-events)$/.test(channel);
        const request = args[0] && typeof args[0] === 'object' ? args[0] : {};
        remember(request.providerConfig?.apiKey);
        remember(request.apiKey);
        if (channel === 'api-config:save' && Array.isArray(request.providers)) request.providers.forEach(provider => remember(provider?.apiKey));
        if (channel === 'mcp-client:save') {
            Object.values(request.env || {}).forEach(remember);
            Object.values(request.headers || {}).forEach(remember);
        }
        const context = { invocationId: crypto.randomUUID(), channel, projectId: request.projectId,
            nodeId: request.nodeId, clientTaskId: request.clientTaskId, taskId: request.taskId, runId: request.runId,
            providerId: request.providerConfig?.id, model: request.providerConfig?.model || request.model,
            ...(/^(thumb|asset|image):/.test(channel) && typeof args[0] === 'string' ? {
                assetRef: crypto.createHash('sha256').update(args[0]).digest('hex').slice(0, 16),
                extension: path.extname(args[0]).slice(0, 12)
            } : {}) };
        const started = Date.now();
        if (tracked) log.record('info', 'ipc.start', context);
        try {
            const result = await listener(event, ...args);
            const failed = result?.success === false || result?.ok === false || Boolean(result?.error);
            if (tracked || failed) log.record(failed ? 'error' : 'info', 'ipc.end', { ...context,
                elapsedMs: Date.now() - started, status: failed ? 'failed' : 'completed',
                error: result?.error, code: result?.code, canceled: result?.canceled,
                taskId: result?.taskId || context.taskId });
            return result;
        } catch (error) {
            log.record('error', 'ipc.throw', { ...context, elapsedMs: Date.now() - started, error });
            throw error;
        }
    });
    const report = () => {
        const events = log.read();
        const tasks = [...(getTasks?.() || [])].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 200).map(task => ({ clientTaskId: task.clientTaskId,
            projectId: task.projectId, nodeId: task.nodeId, taskId: task.taskId, kind: task.kind,
            model: task.model, endpoint: task.endpoint, state: task.state, createdAt: task.createdAt,
            updatedAt: task.updatedAt, requestDiagnostic: task.requestDiagnostic, hasLocalResult: Boolean(task.filePath) }));
        return log.clean({ formatVersion: 1, exportedAt: new Date().toISOString(), sessionId: log.sessionId,
            environment: { app: appVersion, electron: process.versions.electron, chrome: process.versions.chrome,
                node: process.versions.node, platform: process.platform, arch: process.arch, osRelease: os.release(),
                packaged: app.isPackaged, uptimeSeconds: Math.round(process.uptime()), memory: process.memoryUsage(),
                freeMemory: os.freemem(), totalMemory: os.totalmem(), http2Disabled: app.commandLine.hasSwitch('disable-http2') },
            droppedEvents: log.dropped, writeError: log.writeError, tasks, events });
    };
    const trusted = event => event.sender === getWindow()?.webContents;
    ipcMain.handle('diagnostics:summary', event => {
        if (!trusted(event)) throw new Error('Invalid sender');
        const data = report();
        return { version: data.environment.app, platform: data.environment.platform, arch: data.environment.arch,
            eventCount: data.events.length, droppedEvents: data.droppedEvents, writeError: data.writeError,
            errors: data.events.filter(entry => entry.level === 'error').slice(-12) };
    });
    ipcMain.handle('diagnostics:copy', event => {
        if (!trusted(event)) throw new Error('Invalid sender');
        const data = report();
        clipboard.writeText(JSON.stringify({ ...data, events: data.events.slice(-150) }, null, 2));
        return { success: true };
    });
    ipcMain.handle('diagnostics:export', async event => {
        if (!trusted(event)) throw new Error('Invalid sender');
        const choice = await dialog.showSaveDialog(getWindow(), { title: '导出诊断报告',
            defaultPath: `Flow-Canvas-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }] });
        if (choice.canceled || !choice.filePath) return { canceled: true };
        await fs.writeFile(choice.filePath, JSON.stringify(report(), null, 2), 'utf8');
        return { success: true };
    });
    let lastSecond = 0, count = 0;
    ipcMain.on('diagnostics:renderer', (event, detail) => {
        if (!trusted(event)) return;
        const second = Math.floor(Date.now() / 1000);
        if (second !== lastSecond) { count = 0; lastSecond = second; }
        if (++count > 20) { log.dropped++; return; }
        log.record('error', 'renderer.exception', { message: String(detail?.message || '').slice(0, 6000),
            stack: String(detail?.stack || '').slice(0, 6000), type: detail?.type });
    });
    return log;
}
module.exports = { installDiagnostics };
