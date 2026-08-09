// ============================================================
// Flow Canvas — Preload Script (IPC Bridge)
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flowCanvas', {
    // 数据存储
    store: {
        load: () => ipcRenderer.invoke('store:load'),
        save: (data) => ipcRenderer.invoke('store:save', data),
        saveSync: (data) => ipcRenderer.sendSync('store:saveSync', data),
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
        selectReplacement: (options) => ipcRenderer.invoke('file:selectReplacement', options),
        inspect: (filePath) => ipcRenderer.invoke('file:inspect', filePath),
    },

    // 窗口控制
    win: {
        setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:setAlwaysOnTop', flag),
        getAlwaysOnTop: () => ipcRenderer.invoke('window:getAlwaysOnTop'),
        collapseToOrb: () => ipcRenderer.invoke('window:collapseToOrb'),
    },

    metrics: {
        getBoardUsage: () => ipcRenderer.invoke('metrics:getBoardUsage'),
    },

    // 网页图片摘取
    ai: {
        fetchModels: (config) => ipcRenderer.invoke('ai:fetchModels', config),
        chat: (request) => ipcRenderer.invoke('ai:chat', request),
        listSkills: () => ipcRenderer.invoke('ai:listSkills'),
        getSkill: (skillId) => ipcRenderer.invoke('ai:getSkill', skillId),
    },

    image: {
        downloadFromUrl: (url, targetDir) => ipcRenderer.invoke('image:downloadFromUrl', url, targetDir),
        archiveLocalFile: (filePath, targetDir) => ipcRenderer.invoke('image:archiveLocalFile', filePath, targetDir),
        pasteFromClipboard: (targetDir) => ipcRenderer.invoke('image:pasteFromClipboard', targetDir),
    },

    // 原生文件拖出到外部应用（支持单文件或多文件数组）
    mcp: {
        generateImage: (body) => ipcRenderer.invoke('mcp:image:generate', body),
        generateVideo: (body) => ipcRenderer.invoke('mcp:video:generate', body),
        resumeVideo: (body) => ipcRenderer.invoke('mcp:video:resume', body),
    },

    browserSync: {
        getEvents: () => ipcRenderer.invoke('browser-sync:get-events'),
        onTaskSubmitted: (callback) => {
            ipcRenderer.on('generation:task-submitted', (_, payload) => callback(payload));
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
