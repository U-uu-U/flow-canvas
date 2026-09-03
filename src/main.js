import { CanvasManager } from './canvas.js';
import { SidebarManager } from './sidebar.js';
import { ContextMenu } from './context-menu.js';
import { AgentSidebar } from './agent-sidebar.js';
import { GatewayClient } from './gateway.js';

let storeData = null;
let canvasManager = null;
let sidebarManager = null;
let contextMenu = null;
let agentSidebar = null;

async function bootstrap() {
    try {
        // 旧版本可能把 API Key 放在 localStorage；只清理该配置，不上传迁移。
        localStorage.removeItem('flow-canvas-agent-providers');
        window.flowCanvasGateway = new GatewayClient();

        // 1. 加载数据
        storeData = await window.flowCanvas.store.load();

        // 2. 初始化核心模块
        sidebarManager = new SidebarManager(storeData);
        contextMenu = new ContextMenu();
        canvasManager = new CanvasManager('canvasContainer', storeData, contextMenu);
        agentSidebar = new AgentSidebar();

        // 3. 关联事件
        sidebarManager.on('filter', (types) => {
            canvasManager.setFilter(types);
        });

        sidebarManager.on('fitAll', () => {
            canvasManager.fitAll();
        });

        sidebarManager.on('packLayout', () => {
            canvasManager.packLayout();
        });

        sidebarManager.on('seamlessLayout', () => {
            canvasManager.seamlessLayout();
        });

        sidebarManager.on('exportMd', () => {
            canvasManager.exportAsMd();
        });

        // ── 文件夹组切换 ──
        sidebarManager.on('switchGroup', async (data) => {

            // 1. 清空当前画布
            canvasManager.clearAll();

            // 2. 恢复视口位置
            if (data.viewport) {
                canvasManager.setViewport(data.viewport);
            }

            // 3. 重新加载该组保存的 items
            if (data.items && data.items.length > 0) {
                storeData.items = data.items;
                canvasManager.storeData = storeData;
                canvasManager.renderInitialItems();
            }

            // 4. 如果组有文件夹但没有已保存的 items，扫描文件夹
            if (data.items.length === 0 && data.folders.length > 0) {
                for (const folder of data.folders) {
                    const files = await window.flowCanvas.folder.scan(folder);
                    if (files && files.length > 0) {
                        const newItems = [];
                        files.forEach(filePath => {
                            const item = canvasManager.addFile(filePath);
                            if (item) {
                                storeData.items.push(item);
                                newItems.push(item);
                            }
                        });
                        if (newItems.length > 0 && newItems.length === storeData.items.length) {
                            canvasManager.packLayout();
                        }
                    }
                }
            }

            syncStats();
            saveStoreThrottled();
        });

        // 统一更新文件计数的辅助函数
        function syncStats() {
            const count = canvasManager.items.size;
            sidebarManager.updateStats(count);
        }

        // 监听侧边栏新扫出的文件（初始加载上墙）
        sidebarManager.on('scanFiles', (files) => {
            const newItems = [];
            files.forEach(filePath => {
                const item = canvasManager.addFile(filePath);
                if (item) {
                    storeData.items.push(item);
                    newItems.push(item);
                }
            });
            saveStoreThrottled();
            syncStats();

            // 只在首次（白板上没有已有内容）或全部都是新item时才自动排列
            if (newItems.length > 0 && newItems.length === storeData.items.length) {
                canvasManager.packLayout();
            }
        });

        // 监听后端文件变更
        window.flowCanvas.onFileChange((msg) => {
            const { event, filePath } = msg;

            if (event === 'add') {
                const item = canvasManager.addFile(filePath);
                if (item) {
                    storeData.items.push(item);
                    saveStoreThrottled();
                }
            } else if (event === 'remove') {
                canvasManager.removeFile(filePath);
                storeData.items = storeData.items.filter(i => i.filePath !== filePath);
                saveStoreThrottled();
            }

            syncStats();
        });

        // 监听"从白板移除"（支持单选或多选，优先按 itemId 精确删除）
        document.addEventListener('context-remove', (e) => {
            if (e.detail.itemIds) {
                const idsSet = new Set(e.detail.itemIds);
                storeData.items = storeData.items.filter(i => !idsSet.has(i.id));
            } else {
                const filePaths = e.detail.filePaths || [e.detail.filePath];
                filePaths.forEach(filePath => {
                    storeData.items = storeData.items.filter(i => i.filePath !== filePath);
                });
            }
            saveStoreThrottled();
            syncStats();
        });

        // 监听画布变更
        canvasManager.on('change', () => {
            saveStoreThrottled();
            syncStats();
        });

        // 监听网页图片摘取
        canvasManager.on('capturedFile', (data) => {
            storeData.items.push(data);
            saveStoreThrottled();
            syncStats();
        });

        // 监听 Ctrl+拖拽复制产生的新卡片
        canvasManager.on('clonedItems', (clonedDataList) => {
            clonedDataList.forEach(data => storeData.items.push(data));
            saveStoreThrottled();
            syncStats();
        });

        // 监听主进程拦截到的拖拽图片（will-navigate 拦截方式）
        window.flowCanvas.onExternalImageDropped((filePath) => {
            canvasManager._addCapturedFile(filePath);
        });

        // 初始状态更新
        syncStats();
        updateBodyState();

    } catch (err) {
        console.error('[Main] 启动失败:', err);
    }
}

// 节流保存
let saveTimer = null;
function saveStoreThrottled() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        storeData.viewport = canvasManager.getViewport();

        // 同步当前 items 到激活的组
        const activeGroup = sidebarManager?.getActiveGroup();
        if (activeGroup) {
            activeGroup.savedItems = [...storeData.items];
            activeGroup.savedViewport = { ...storeData.viewport };
        }

        window.flowCanvas.store.save(storeData);
        updateBodyState();
    }, 1000);
}

function updateBodyState() {
    const activeWatchFolders = sidebarManager ? sidebarManager.getActiveWatchFolders() : [];
    if (activeWatchFolders.length > 0) {
        document.body.classList.add('has-folders');
    } else if (storeData && storeData.watchFolders && storeData.watchFolders.length > 0) {
        document.body.classList.add('has-folders');
    } else {
        document.body.classList.remove('has-folders');
    }
}

bootstrap();
