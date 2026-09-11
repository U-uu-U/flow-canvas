// ============================================================
// Flow Canvas — Preload Script (IPC Bridge)
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');
window.addEventListener('error', event => ipcRenderer.send('diagnostics:renderer', {
    type: 'error', message: event.message, stack: event.error?.stack
}));
window.addEventListener('unhandledrejection', event => ipcRenderer.send('diagnostics:renderer', {
    type: 'unhandledrejection', message: event.reason?.message || String(event.reason), stack: event.reason?.stack
}));

let sourceRevisions = {};
let sourceActiveGroupId = null;
function rememberStore(data) {
    sourceRevisions = Object.fromEntries((data?.folderGroups || []).map(group => [group.id, Number(group.boardRevision) || 0]));
    sourceActiveGroupId = data?.activeGroupId ?? null;
    return data;
}
function storeEnvelope(data) {
    const revisions = { ...sourceRevisions };
    for (const group of data.folderGroups || []) if (!(group.id in revisions)) revisions[group.id] = null;
    return { data, sourceRevisions: revisions, sourceActiveGroupId };
}
function savedStore(result) {
    if (typeof result === 'boolean') return result;
    if (result?.sourceRevisions) sourceRevisions = result.sourceRevisions;
    if (result && Object.prototype.hasOwnProperty.call(result, 'activeGroupId')) sourceActiveGroupId = result.activeGroupId;
    if (result?.conflicts?.length) ipcRenderer.emit('agent:save-conflict', {}, result);
    return result?.ok === true;
}

contextBridge.exposeInMainWorld('flowCanvas', {
    platform: process.platform,
    diagnostics: {
        summary: () => ipcRenderer.invoke('diagnostics:summary'),
        copy: () => ipcRenderer.invoke('diagnostics:copy'),
        export: () => ipcRenderer.invoke('diagnostics:export'),
    },

    // 数据存储
    store: {
        load: async () => rememberStore(await ipcRenderer.invoke('store:load')),
        loadSync: () => rememberStore(ipcRenderer.sendSync('store:loadSync')),
        save: async (data) => savedStore(ipcRenderer.sendSync('store:saveSync', storeEnvelope(data))),
        saveSync: (data) => savedStore(ipcRenderer.sendSync('store:saveSync', storeEnvelope(data))),
    },

    mcpClient: {
        list: () => ipcRenderer.invoke('mcp-client:list'),
        save: config => ipcRenderer.invoke('mcp-client:save', config),
        remove: request => ipcRenderer.invoke('mcp-client:remove', request),
        test: request => ipcRenderer.invoke('mcp-client:test', request),
    },

    agent: {
        start: request => ipcRenderer.invoke('agent:start', request),
        get: request => ipcRenderer.invoke('agent:get', request),
        list: request => ipcRenderer.invoke('agent:list', request),
        confirm: request => ipcRenderer.invoke('agent:confirm', request),
        revise: request => ipcRenderer.invoke('agent:revise', request),
        cancel: request => ipcRenderer.invoke('agent:cancel', request),
        resume: request => ipcRenderer.invoke('agent:resume', request),
        retry: request => ipcRenderer.invoke('agent:retry', request),
        onEvent: callback => {
            const listener = (_, event) => callback(event);
            ipcRenderer.on('agent:event', listener);
            return () => ipcRenderer.removeListener('agent:event', listener);
        },
        onSaveConflict: callback => {
            const listener = (_, result) => callback(result);
            ipcRenderer.on('agent:save-conflict', listener);
            return () => ipcRenderer.removeListener('agent:save-conflict', listener);
        }
    },

    apiConfig: {
        load: () => ipcRenderer.invoke('api-config:load'),
        save: (config) => ipcRenderer.invoke('api-config:save', config),
    },

    // 文件夹管理
    folder: {
        select: () => ipcRenderer.invoke('folder:select'),
        watch: (folderPath) => ipcRenderer.invoke('folder:watch', folderPath),
        syncWatches: (activeFolders, knownFolders) => ipcRenderer.invoke('folder:syncWatches', activeFolders, knownFolders),
        scan: (folderPath) => ipcRenderer.invoke('folder:scan', folderPath),
        unwatch: (folderPath) => ipcRenderer.invoke('folder:unwatch', folderPath),
        moveFiles: (filePaths, targetDir) => ipcRenderer.invoke('folder:moveFiles', filePaths, targetDir),
        copyFiles: (filePaths, targetDir) => ipcRenderer.invoke('folder:copyFiles', filePaths, targetDir),
        copyFilesToExplorer: (filePaths, options) => ipcRenderer.invoke('folder:copyFilesToExplorer', filePaths, options),
        showContextMenu: (folderPath) => ipcRenderer.invoke('folder:showContextMenu', folderPath),
    },

    // 缩略图
    thumb: {
        get: (filePath, maxDim) => ipcRenderer.invoke('thumb:get', filePath, maxDim),
    },

    // 剪贴板
    clipboard: {
        copy: (filePathOrPaths) => ipcRenderer.invoke('clipboard:copy', filePathOrPaths),
        writeText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
    },

    // Shell 操作
    shell: {
        showInExplorer: (filePath) => ipcRenderer.invoke('shell:showInExplorer', filePath),
        openFile: (filePath) => ipcRenderer.invoke('shell:openFile', filePath),
        openRavenHash: (site) => ipcRenderer.invoke('shell:openRavenHash', site),
    },

    file: {
        selectMedia: () => ipcRenderer.invoke('file:selectMedia'),
        selectReplacement: (options) => ipcRenderer.invoke('file:selectReplacement', options),
        saveCopy: (filePath) => ipcRenderer.invoke('file:saveCopy', filePath),
        inspect: (filePath) => ipcRenderer.invoke('file:inspect', filePath),
    },

    // 窗口控制
    win: {
        setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:setAlwaysOnTop', flag),
        getAlwaysOnTop: () => ipcRenderer.invoke('window:getAlwaysOnTop'),
        setMediaPreviewFullscreen: (enabled) => ipcRenderer.invoke('window:setMediaPreviewFullscreen', enabled),
        collapseToOrb: () => ipcRenderer.invoke('window:collapseToOrb'),
    },

    metrics: {
        getBoardUsage: () => ipcRenderer.invoke('metrics:getBoardUsage'),
    },

    // 网页图片摘取
    ai: {
        fetchModels: (config) => ipcRenderer.invoke('ai:fetchModels', config),
        generateText: (request) => ipcRenderer.invoke('ai:generateText', request),
        describeImages: (request) => ipcRenderer.invoke('ai:describeImages', request),
        planImageEdit: (request) => ipcRenderer.invoke('ai:planImageEdit', request),
        saveGenerationTrace: (trace) => ipcRenderer.invoke('ai:saveGenerationTrace', trace),
        classifyAsset: (filePath, provider) => ipcRenderer.invoke('ai:classifyAsset', filePath, provider),
    },

    asset: {
        getLibraryContext: () => ipcRenderer.invoke('asset:getLibraryContext'),
        archiveFile: (filePath) => ipcRenderer.invoke('asset:archiveFile', filePath),
        readMetadata: (filePaths) => ipcRenderer.invoke('asset:readMetadata', filePaths),
        updateMetadata: (filePath, patch) => ipcRenderer.invoke('asset:updateMetadata', filePath, patch),
    },

    image: {
        downloadFromUrl: (url, targetDir) => ipcRenderer.invoke('image:downloadFromUrl', url, targetDir),
        archiveLocalFile: (filePath, targetDir) => ipcRenderer.invoke('image:archiveLocalFile', filePath, targetDir),
        saveDroppedFile: (file, targetDir) => ipcRenderer.invoke('image:saveDroppedFile', file, targetDir),
        pasteFromClipboard: (targetDir) => ipcRenderer.invoke('image:pasteFromClipboard', targetDir),
        crop: (body) => ipcRenderer.invoke('image:crop', body),
    },

    // 原生文件拖出到外部应用（支持单文件或多文件数组）
    mcp: {
        generateImage: (body) => ipcRenderer.invoke('mcp:image:generate', body),
        cancelGeneration: (clientTaskId) => ipcRenderer.invoke('mcp:generation:cancel', clientTaskId),
        recoverGeneration: (body) => ipcRenderer.invoke('mcp:generation:recover', body),
        listRecoverableGenerations: () => ipcRenderer.invoke('mcp:generation:recovery-list'),
        compressImageReferences: (body) => ipcRenderer.invoke('mcp:image:compress-references', body),
        compressVideoReferences: (body) => ipcRenderer.invoke('mcp:video:compress-references', body),
        generateVideo: (body) => ipcRenderer.invoke('mcp:video:generate', body),
        resumeVideo: (body) => ipcRenderer.invoke('mcp:video:resume', body),
        onVideoProgress: (callback) => {
            ipcRenderer.on('generation:video-progress', (_, payload) => callback(payload));
        },
        onBoardToolRequest: (callback) => {
            const listener = (_, payload) => callback(payload);
            ipcRenderer.on('mcp:board-tool-request', listener);
            return () => ipcRenderer.removeListener('mcp:board-tool-request', listener);
        },
        respondBoardTool: (payload) => ipcRenderer.send('mcp:board-tool-response', payload),
        setBoardToolsReady: (ready) => ipcRenderer.send('mcp:board-tools-ready', ready === true),
    },

    browserSync: {
        getEvents: () => ipcRenderer.invoke('browser-sync:get-events'),
        onTaskSubmitted: (callback) => {
            ipcRenderer.on('generation:task-submitted', (_, payload) => callback(payload));
        },
        onTaskCompleted: (callback) => {
            ipcRenderer.on('generation:task-completed', (_, payload) => callback(payload));
        }
    },

    drag: {
        start: (filePathOrPaths) => ipcRenderer.send('drag:start', filePathOrPaths),
        startExportCopy: (filePathOrPaths) => ipcRenderer.send('drag:startExportCopy', filePathOrPaths),
    },

    // 文件变更事件监听
    onFileChange: (callback) => {
        ipcRenderer.on('file-change', (_, data) => callback(data));
    },

    // 外部拖拽图片事件（从浏览器拖图片进来时由主进程触发）
    onExternalImageDropped: (callback) => {
        ipcRenderer.on('external-image-dropped', (_, filePath) => callback(filePath));
    },

    onOrbFilesDropped: (callback) => {
        ipcRenderer.on('orb-files-dropped', (_, filePaths) => callback(filePaths));
    },

    onMcpStoreUpdated: (callback) => {
        ipcRenderer.on('mcp:store-updated', (_, payload) => callback(payload));
    },
});
