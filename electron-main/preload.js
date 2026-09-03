// ============================================================
// Flow Canvas — Preload Script (IPC Bridge)
// ============================================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flowCanvas', {
    credentials: {
        hasRavenhashKey: () => ipcRenderer.invoke('credentials:hasRavenhashKey'),
        setRavenhashKey: (value) => ipcRenderer.invoke('credentials:setRavenhashKey', value),
        clearRavenhashKey: () => ipcRenderer.invoke('credentials:clearRavenhashKey'),
    },

    // 数据存储
    store: {
        load: () => ipcRenderer.invoke('store:load'),
        save: (data) => ipcRenderer.invoke('store:save', data),
    },

    // 文件夹管理
    folder: {
        select: () => ipcRenderer.invoke('folder:select'),
        scan: (folderPath) => ipcRenderer.invoke('folder:scan', folderPath),
        unwatch: (folderPath) => ipcRenderer.invoke('folder:unwatch', folderPath),
        showContextMenu: (folderPath) => ipcRenderer.invoke('folder:showContextMenu', folderPath),
    },

    // 缩略图
    thumb: {
        get: (filePath) => ipcRenderer.invoke('thumb:get', filePath),
    },

    // 剪贴板
    clipboard: {
        copy: (filePath) => ipcRenderer.invoke('clipboard:copy', filePath),
    },

    // Shell 操作
    shell: {
        showInExplorer: (filePath) => ipcRenderer.invoke('shell:showInExplorer', filePath),
        openFile: (filePath) => ipcRenderer.invoke('shell:openFile', filePath),
    },

    // 窗口控制
    win: {
        setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:setAlwaysOnTop', flag),
        getAlwaysOnTop: () => ipcRenderer.invoke('window:getAlwaysOnTop'),
    },

    // 网页图片摘取
    image: {
        downloadFromUrl: (url, targetDir) => ipcRenderer.invoke('image:downloadFromUrl', url, targetDir),
        pasteFromClipboard: (targetDir) => ipcRenderer.invoke('image:pasteFromClipboard', targetDir),
    },

    // 原生文件拖出到外部应用（支持单文件或多文件数组）
    drag: {
        start: (filePathOrPaths) => ipcRenderer.send('drag:start', filePathOrPaths),
    },

    // 文件变更事件监听
    onFileChange: (callback) => {
        ipcRenderer.on('file-change', (_, data) => callback(data));
    },

    // 外部拖拽图片事件（从浏览器拖图片进来时由主进程触发）
    onExternalImageDropped: (callback) => {
        ipcRenderer.on('external-image-dropped', (_, filePath) => callback(filePath));
    },
});
