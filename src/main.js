import { CanvasManager } from './canvas.js';
import './mcp-client-settings.js';
import './diagnostics-settings.js';
import './generation-recovery.css';
import './model-config-settings.css';
import { initModelConfigUi } from './model-config-ui.js';
import { SidebarManager } from './sidebar.js';
import { ContextMenu } from './context-menu.js';
import { AgentSidebar } from './agent-sidebar.js';
import { PlanService } from './plan-service.js';
import { snapshotState, UndoStack } from './undo-stack.js';
import {
    applyBoardTransaction,
    createBoardSnapshot,
    previewBoardTransaction,
    undoBoardTransaction
} from './board-transaction.js';

let storeData = null;
let canvasManager = null;
let sidebarManager = null;
let contextMenu = null;
let agentSidebar = null;
let planService = null;
let unsubscribeBoardToolRequests = null;
const HISTORY_LIMIT = 100;
const historyStack = new UndoStack(HISTORY_LIMIT);
const transactionUndoRecords = new Map();
const TRANSACTION_UNDO_LIMIT = 100;
let isRestoringHistory = false;
let historyCommitTimer = null;
let lastBoardSemanticFingerprint = '';
let switchGroupRunId = 0;
const assetClassificationQueue = [];
const queuedAssetClassifications = new Set();
let assetClassificationRunning = false;

document.body.classList.add(`platform-${window.flowCanvas?.platform || 'web'}`);
window.flowCanvas?.mcp?.setBoardToolsReady?.(false);
if (window.flowCanvas?.platform === 'darwin') {
    document.querySelectorAll('.context-menu-shortcut').forEach(element => {
        element.textContent = element.textContent.replace(/^Ctrl\+/, 'Command+');
    });
}

async function bootstrap() {
    try {
        if (!window.flowCanvas?.store?.load) {
            throw new Error('Flow Canvas preload bridge is unavailable');
        }

        // 1. 加载数据
        storeData = await window.flowCanvas.store.load();
        // 模型能力 CONFIG：内置默认立刻可用，随后按 1 小时周期从服务器静默更新。
        // 不 await：拉取失败或网络慢都不能拖住启动，UI 先用内置/缓存配置渲染。
        initModelConfigUi();
        storeData.items = (Array.isArray(storeData.items) ? storeData.items : [])
            .filter(item => item?.kind !== 'generation');
        delete storeData.generationNodes;
        storeData.folderGroups = Array.isArray(storeData.folderGroups) ? storeData.folderGroups : [];
        const assetLibraryContext = await window.flowCanvas.asset.getLibraryContext();
        planService = new PlanService(storeData);
        console.log('[Main] 数据加载完成', storeData);

        // 2. 初始化核心模块
        sidebarManager = initRequiredModule('sidebar', () => new SidebarManager(storeData, assetLibraryContext));
        contextMenu = initRequiredModule('context-menu', () => new ContextMenu());
        canvasManager = initRequiredModule('canvas', () => new CanvasManager('canvasContainer', storeData, contextMenu, planService, {
            getTextProvider: (binding) => agentSidebar?.getTextProviderConfig?.(binding) || null,
            getImageProvider: (binding) => agentSidebar?.getImageProviderConfig?.(binding) || null,
            setImageProvider: (id) => agentSidebar?.setImageProvider?.(id) || false,
            getImageGenerationPreferences: (binding) =>
                agentSidebar?.getImageGenerationPreferences?.(binding) || null,
            saveImageGenerationPreferences: (config, binding) =>
                agentSidebar?.saveImageGenerationPreferences?.(config, binding) || false,
            getVideoProvider: (binding) => agentSidebar?.getVideoProviderConfig?.(binding) || null,
            getGenerationProviders: (kind) => agentSidebar?.getGenerationProviderOptions?.(kind) || [],
            getImageModelProfile: (binding) => agentSidebar?.getImageModelProfile?.(binding) || null,
            getVideoModelProfile: (binding) => agentSidebar?.getVideoModelProfile?.(binding) || null,
            getPromptPresets: (kind) => agentSidebar?.getPromptPresets?.(kind) || [],
            savePromptPreset: (kind, value) => agentSidebar?.savePromptPreset?.(kind, value) || null,
            deletePromptPreset: (kind, presetId) => agentSidebar?.deletePromptPreset?.(kind, presetId) || false,
            getImageIntentPipelineMode: () => agentSidebar?.getImageIntentPipelineMode?.() || 'compiled',
            setImageIntentPipelineEnabled: (enabled) =>
                agentSidebar?.setImageIntentPipelineEnabled?.(enabled) ?? Promise.resolve(false),
            prepareAgentFromNode: (details) =>
                agentSidebar?.prepareAgentFromNode?.(details) || null,
            generateImageThroughAgent: (details) =>
                agentSidebar?.generateImageFromNode?.(details) || null,
            // 不能写成 `?.() || []`：那会把「用户取消参考图处理」和
            // 「side bar 未就绪」都折叠成空数组，使生成静默降级为纯文生图。
            // 这里原样上传结果，由 node-types 的 prepareGenerationReferences 判定。
            prepareImageReferences: (refs) => {
                const prepare = agentSidebar?._prepareImageReferencesForGeneration;
                return typeof prepare === 'function' ? prepare.call(agentSidebar, refs) : null;
            },
            createGenerationTask: (details) => agentSidebar?.createGenerationTask?.(details) || null,
            updateGenerationTask: (taskId, patch) => agentSidebar?.updateGenerationTask?.(taskId, patch) || null,
            recordGenerationError: (taskId, error) => agentSidebar?.recordGenerationError?.(taskId, error) || null,
            cancelGenerationTasks: (nodeId) => agentSidebar?.cancelGenerationTasksForNode?.(nodeId) || false,
            cancelGenerationTask: (taskId) => agentSidebar?.cancelGenerationTask?.(taskId) || false,
            retryGenerationTask: (taskId, options) => agentSidebar?.retryGenerationTask?.(taskId, options) || null,
            persistCompletedGenerationNode: (nodeData) => persistCompletedGenerationNode(nodeData)
        }));
        agentSidebar = initOptionalModule('agent-sidebar', () => new AgentSidebar({
            flushBoard: () => saveStoreNow(),
            getSelectedFilePaths: () => canvasManager?.getSelectedFilePaths?.() || [],
            getSelectedCanvasEntries: () => canvasManager?.getSelectedCanvasEntries?.() || [],
            getPlanningContext: () => planService?.getAgentContext?.(canvasManager?.getSelectedFilePaths?.() || []) || null,
            subscribeCanvasSelection: (handler) => canvasManager?.on?.('selectionChanged', handler),
            subscribeInitialRenderComplete: (handler) => canvasManager?.on?.('initialRenderComplete', handler),
            subscribeMediaReferenceSelection: (handler) => canvasManager?.on?.('mediaReferenceSelectionChanged', handler),
            subscribeMediaReferencePickState: (handler) => canvasManager?.on?.('mediaReferencePickStateChanged', handler),
            beginMediaReferencePick: (type, entries, maxItems, allSelections) => canvasManager?.beginMediaReferencePick?.(type, entries, maxItems, allSelections),
            endMediaReferencePick: (options) => canvasManager?.endMediaReferencePick?.(options),
            updateMediaReferencePick: (type, entries) => canvasManager?.updateMediaReferencePick?.(type, entries),
            clearMediaReferenceSelections: () => canvasManager?.clearMediaReferenceSelections?.(),
            resolveMediaReferenceEntries: (entries, type) => canvasManager?.resolveMediaReferenceEntries?.(entries, type) || [],
            getActiveProjectId: () => storeData?.activeGroupId || null,
            getAssetLibrarySettings: () => sidebarManager?.getAssetLibrarySettings?.() || {},
            chooseAssetLibraryFolder: () => sidebarManager?.chooseAssetLibraryFolder?.({ makeDefault: true }) || null,
            setDefaultAssetLibraryFolder: (folderPath) => sidebarManager?.setAssetLibraryDefaultFolder?.(folderPath) ?? false,
            subscribeAssetLibrarySettings: (handler) => sidebarManager?.on?.('assetLibrarySettingsChanged', handler),
            onGenerationTasksChanged: (tasks) => {
                sidebarManager?.setGenerationTaskStates?.(tasks);
                canvasManager?.setGenerationTaskStates?.(tasks);
            },
            beginImageGeneration: (settings) => canvasManager?.addImageGenerationPlaceholder?.(settings) || null,
            endImageGeneration: (placeholderId, itemId) => canvasManager?.removeImageGenerationPlaceholder?.(placeholderId, itemId),
            beginVideoGeneration: (settings) => canvasManager?.addVideoGenerationPlaceholder?.(settings) || null,
            endVideoGeneration: (placeholderId, itemId) => canvasManager?.removeVideoGenerationPlaceholder?.(placeholderId, itemId),
            completeGenerationTaskOnNode: (details) => canvasManager?.completeGenerationTaskOnNode?.(details) || false,
            getAgentNodeContext: (nodeId) => canvasManager?.getAgentGenerationContext?.(nodeId) || null,
            executeImageNodeFromAgent: (details) => canvasManager?.runImageNodeWithAgentPlan?.(details) || null,
            applyPlanSuggestion: (rows) => applyAgentPlanRows(rows),
            getBoardSnapshot: (options) => getAgentBoardSnapshot(options),
            previewBoardTransaction: (transaction) => previewAgentBoardTransaction(transaction),
            applyBoardTransaction: (transaction) => applyAgentBoardTransaction(transaction),
            undoBoardTransaction: (undoToken) => undoAgentBoardTransaction(undoToken)
        }));

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

        sidebarManager.on('newPlan', () => {
            const plan = canvasManager.addPlan();
            if (plan) {
                saveStoreThrottled();
                commitHistory('new-plan');
            }
        });

        sidebarManager.on('addOpNode', (nodeType) => {
            const node = canvasManager.addOpNode(nodeType);
            if (node) {
                saveStoreThrottled();
                commitHistory('add-op-node');
            }
        });

        sidebarManager.on('resourceSaverChange', (enabled) => {
            canvasManager.setResourceSaverMode(enabled);
            saveStoreThrottled();
        });

        document.addEventListener('history-undo', () => {
            undoHistory();
        });

        document.addEventListener('history-redo', () => {
            redoHistory();
        });

        document.addEventListener('context-move-to-folder', (e) => {
            sidebarManager.beginMoveToFolder({ ...(e.detail || {}), mode: 'move' });
        });

        document.addEventListener('context-copy-to-folder', (e) => {
            sidebarManager.beginMoveToFolder({ ...(e.detail || {}), mode: 'copy' });
        });

        document.addEventListener('context-repair-material', (e) => {
            repairDisconnectedMaterials(e.detail || {}, { manual: false });
        });

        document.addEventListener('context-relink-material', (e) => {
            repairDisconnectedMaterials(e.detail || {}, { manual: true });
        });

        sidebarManager.on('moveToFolder', async ({ itemIds = [], filePaths = [], fileTargets = [], targetFolder }) => {
            if (!targetFolder || filePaths.length === 0) return;
            const result = await window.flowCanvas.folder.moveFiles(filePaths, targetFolder);
            if (!result?.success) {
                console.warn('[Main] moveToFolder failed:', result?.error || result?.errors);
                return;
            }

            try {
                isRestoringHistory = true;
                const idsByPath = new Map();
                fileTargets.forEach(target => {
                    const pathKey = normalizeFsPath(target.filePath);
                    if (!pathKey || !target.itemId) return;
                    const ids = idsByPath.get(pathKey) || [];
                    ids.push(target.itemId);
                    idsByPath.set(pathKey, ids);
                });

                (result.moved || []).forEach(({ oldPath, newPath }) => {
                    if (!oldPath || !newPath) return;
                    const candidateIds = idsByPath.get(normalizeFsPath(oldPath)) || itemIds;
                    candidateIds.forEach(id => {
                        const item = storeData.items.find(entry => entry.id === id);
                        if (!item) return;
                        if (normalizeFsPath(item.filePath) === normalizeFsPath(oldPath)) {
                            const updated = canvasManager.updateItemFilePath(id, newPath);
                            if (!updated) item.filePath = newPath;
                            return;
                        }
                        canvasManager.updateGeneratorResultFilePath(id, oldPath, newPath);
                    });
                });
            } finally {
                isRestoringHistory = false;
            }

            const movedNewPaths = new Set((result.moved || []).map(entry => entry.newPath).filter(Boolean));
            storeData.items = storeData.items.filter((item, index, items) => {
                if (!movedNewPaths.has(item.filePath)) return true;
                return items.findIndex(other => other.filePath === item.filePath) === index;
            });

            saveStoreThrottled();
            syncStats();
            resetHistory('move-to-folder');
        });

        sidebarManager.on('copyToFolder', async ({ filePaths = [], targetFolder }) => {
            if (!targetFolder || filePaths.length === 0) return;
            const result = await window.flowCanvas.folder.copyFiles(filePaths, targetFolder);
            if (!result?.success) {
                console.warn('[Main] copyToFolder failed:', result?.error || result?.errors);
                showHistoryStatus('复制失败');
                return;
            }
            const count = result.copied?.length || 0;
            showHistoryStatus(count > 1 ? `已复制 ${count} 个文件` : '已复制文件');
        });

        const revealLibraryAsset = ({ filePath, position = null } = {}) => {
            if (!filePath) return;
            const normalizedPath = normalizeFsPath(filePath);
            let entry = [...canvasManager.items.values()].find(item =>
                normalizeFsPath(item?.data?.filePath) === normalizedPath
            );

            if (!entry) {
                restoreRemovedFromBoard(filePath);
                const data = canvasManager.addFile(filePath);
                if (data) {
                    storeData.items.push(data);
                    entry = canvasManager.items.get(data.id);
                    saveStoreThrottled();
                    syncStats();
                    commitHistory('asset-library-add');
                }
            }

            if (!entry) return;
            canvasManager.focusItemById(entry.data.id, position);
        };

        sidebarManager.on('revealAsset', revealLibraryAsset);
        sidebarManager.on('classifyAssets', enqueueAssetClassifications);
        document.addEventListener('agent-providers-updated', () => sidebarManager.scheduleAssetLibraryRefresh?.(80));
        document.addEventListener('library-asset-drop', event => {
            revealLibraryAsset(event.detail || {});
        });

        // ── 文件夹组切换 ──
        sidebarManager.on('switchGroup', async (data = {}) => {
            const currentSwitchRun = ++switchGroupRunId;
            const folders = Array.isArray(data.folders) ? data.folders : [];
            const items = Array.isArray(data.items) ? data.items : [];
            console.log('[Main] 切换文件夹组, folders:', folders.length, ', items:', items.length);

            canvasManager.clearAll();
            planService.migrateStoreData();

            storeData.items = [...items];
            canvasManager.storeData = storeData;
            agentSidebar?.switchProjectContext?.(storeData.activeGroupId || null);

            if (data.viewport) {
                canvasManager.setViewport(data.viewport);
            } else {
                canvasManager.setViewport({ x: 0, y: 0, scale: 1 });
            }

            if (storeData.items.length > 0) {
                canvasManager.renderInitialItems();
            } else {
                canvasManager.renderPlans();
            }

            storeData.connections = cloneData(data.connections || []);
            canvasManager.graphView?.load(storeData.connections);

            if (folders.length > 0) {
                await reconcileGroupFiles(folders, currentSwitchRun);
                if (currentSwitchRun !== switchGroupRunId) return;
            }

            syncStats();
            saveStoreThrottled();
            resetHistory('switch-group');
        });

        // 统一更新文件计数的辅助函数
        function syncStats() {
            const count = storeData.items.length;
            console.log('[Main] syncStats: canvasManager.items.size =', canvasManager.items.size, ', storeData.items.length =', count);
            sidebarManager.updateStats(count);
        }

        // 监听侧边栏新扫出的文件（初始加载上墙）
        sidebarManager.on('scanFiles', (files) => {
            const newItems = [];
            files.forEach(filePath => {
                if (!isWatchedBoardFile(filePath) || isRemovedFromBoard(filePath)) return;
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
            if (newItems.length > 0) {
                commitHistory('scan-files');
            }
        });

        // 监听后端文件变更
        window.flowCanvas.onFileChange((msg) => {
            const { event, filePath } = msg;
            console.log('[Main] 收到文件变更:', event, filePath);

            const isBoardFile = isWatchedBoardFile(filePath);
            const isLibraryFile = isAssetLibraryFile(filePath);
            if (isLibraryFile) sidebarManager.scheduleAssetLibraryRefresh?.();

            if (!isBoardFile) {
                console.log('[Main] 忽略非当前文件夹组的画布变更:', filePath);
                return;
            }

            if (event === 'add') {
                if (isRemovedFromBoard(filePath)) {
                    console.log('[Main] 跳过已从白板移除的文件:', filePath);
                    return;
                }
                const item = canvasManager.addFile(filePath);
                if (item) {
                    storeData.items.push(item);
                    saveStoreThrottled();
                    commitHistory('file-add');
                }
            } else if (event === 'remove') {
                canvasManager.removeFile(filePath);
                storeData.items = storeData.items.filter(i => i.filePath !== filePath);
                saveStoreThrottled();
                commitHistory('file-remove');
            }

            syncStats();
        });

        // 监听"从白板移除"（支持单选或多选，优先按 itemId 精确删除）
        document.addEventListener('context-remove', (e) => {
            const detail = e.detail || {};
            const itemIds = Array.isArray(detail.itemIds) ? detail.itemIds.filter(Boolean) : [];
            const explicitPaths = (Array.isArray(detail.filePaths)
                ? detail.filePaths
                : [detail.filePath]).filter(Boolean);
            const itemPaths = itemIds
                .map(id => storeData.items.find(item => item.id === id)?.filePath)
                .filter(Boolean);

            if (detail.suppressAutoRestore !== false) {
                markRemovedFromBoard([...itemPaths, ...explicitPaths]);
            }

            if (itemIds.length > 0) {
                const idsSet = new Set(itemIds);
                storeData.items = storeData.items.filter(i => !idsSet.has(i.id));
            } else {
                explicitPaths.forEach(filePath => {
                    storeData.items = storeData.items.filter(i => i.filePath !== filePath);
                });
            }
            saveStoreThrottled();
            syncStats();
            commitHistory('remove');
        });

        // 监听画布变更
        canvasManager.on('change', () => {
            // 文件夹组切换是同步发生的，不能等节流保存后才更新顶层连线。
            // Sidebar 会在切换瞬间把这里的实时快照写回旧组。
            storeData.connections = cloneData(canvasManager.graphView?.serialize?.() || []);
            saveStoreThrottled();
            syncStats();
            scheduleHistoryCommit('canvas-change');
        });

        canvasManager.on('mediaDimensionsResolved', () => {
            saveStoreThrottled();
        });

        canvasManager.on('plansChanged', () => {
            saveStoreThrottled();
            scheduleHistoryCommit('plans-change');
        });

        canvasManager.on('manualFileImport', (filePath) => {
            if (!restoreRemovedFromBoard(filePath)) return;
            saveStoreThrottled();
            scheduleHistoryCommit('manual-file-import');
        });

        // 监听网页图片摘取
        canvasManager.on('capturedFile', (data) => {
            storeData.items.push(data);
            saveStoreThrottled();
            syncStats();
            commitHistory('captured-file');
        });

        // 监听 Ctrl+拖拽复制产生的新卡片
        canvasManager.on('clonedItems', (clonedDataList) => {
            clonedDataList.forEach(data => storeData.items.push(data));
            saveStoreThrottled();
            syncStats();
            scheduleHistoryCommit('cloned-items');
        });

        // 监听主进程拦截到的拖拽图片（will-navigate 拦截方式）
        window.flowCanvas.onExternalImageDropped?.((filePath) => {
            console.log('[Main] 收到主进程拖拽图片:', filePath);
            canvasManager._addCapturedFile(filePath, null, { manualRestore: true });
        });

        window.flowCanvas.onOrbFilesDropped?.((filePaths) => {
            const addedItems = [];
            (Array.isArray(filePaths) ? filePaths : []).forEach(filePath => {
                restoreRemovedFromBoard(filePath);
                const item = canvasManager.addFile(filePath);
                if (!item) return;
                storeData.items.push(item);
                addedItems.push(item);
            });

            if (addedItems.length === 0) return;
            canvasManager.selectItems(addedItems.map(item => item.id));
            saveStoreThrottled();
            syncStats();
            commitHistory('orb-file-drop');
        });

        if (window.flowCanvas.onMcpStoreUpdated) {
            window.flowCanvas.onMcpStoreUpdated((payload) => {
                handleExternalStoreUpdate(payload);
            });
        }
        window.flowCanvas.agent?.onSaveConflict?.(result => {
            if (isRestoringHistory) return;
            handleExternalStoreUpdate({ event: 'agent:save-conflict', data: result.data, skipFlush: true });
            showHistoryStatus('画板已同步到较新版本；未保存的编辑已保留在本地冲突备份中');
        });

        // 初始状态更新
        agentSidebar?.switchProjectContext?.(storeData.activeGroupId || null, { saveCurrent: false });
        canvasManager.graphView?.load(storeData.connections);
        syncStats();
        updateBodyState();
        resetHistory('initial');
        startBoardUsageMonitor();
        registerBoardToolBridge();

    } catch (err) {
        window.flowCanvas?.mcp?.setBoardToolsReady?.(false);
        console.error('[Main] 启动失败:', err);
        showStartupError(err);
    }
}

function registerBoardToolBridge() {
    unsubscribeBoardToolRequests?.();
    unsubscribeBoardToolRequests = null;
    const bridge = window.flowCanvas?.mcp;
    if (!agentSidebar?.boardToolRegistry || !bridge?.onBoardToolRequest || !bridge?.respondBoardTool) {
        bridge?.setBoardToolsReady?.(false);
        return false;
    }

    unsubscribeBoardToolRequests = bridge.onBoardToolRequest((payload = {}) => {
        const requestId = String(payload.requestId || '').trim();
        if (!requestId) return;
        Promise.resolve()
            .then(() => agentSidebar.boardToolRegistry.execute(payload.toolName, payload.input || {}))
            .then(result => {
                bridge.respondBoardTool({ requestId, success: true, result });
            })
            .catch(error => {
                bridge.respondBoardTool({
                    requestId,
                    success: false,
                    error: {
                        code: String(error?.code || 'BOARD_TOOL_FAILED'),
                        message: String(error?.message || error || 'Board tool failed'),
                        details: error?.details && typeof error.details === 'object'
                            ? cloneData(error.details)
                            : null
                    }
                });
            });
    });
    bridge.setBoardToolsReady?.(true);
    return true;
}

function enqueueAssetClassifications(filePaths = []) {
    (Array.isArray(filePaths) ? filePaths : []).forEach(filePath => {
        const key = normalizeFsPath(filePath);
        if (!key || queuedAssetClassifications.has(key)) return;
        queuedAssetClassifications.add(key);
        assetClassificationQueue.push({ key, filePath });
    });
    void runAssetClassificationQueue();
}

async function runAssetClassificationQueue() {
    if (assetClassificationRunning || !agentSidebar?.classifyLibraryAsset) return;
    assetClassificationRunning = true;
    try {
        while (assetClassificationQueue.length > 0) {
            const next = assetClassificationQueue.shift();
            if (!next) break;
            const metadata = sidebarManager?._assetMetadata?.(next.filePath) || {};
            const result = await agentSidebar.classifyLibraryAsset(next.filePath, metadata);
            queuedAssetClassifications.delete(next.key);
            if (result?.metadata) sidebarManager?.applyAssetMetadata?.(next.filePath, result.metadata);
            if (result?.waiting) {
                assetClassificationQueue.splice(0).forEach(item => queuedAssetClassifications.delete(item.key));
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 180));
        }
    } catch (error) {
        console.warn('[Main] 素材智能分类队列中断:', error);
    } finally {
        assetClassificationRunning = false;
        if (assetClassificationQueue.length > 0) void runAssetClassificationQueue();
    }
}

function initRequiredModule(name, factory) {
    try {
        return factory();
    } catch (err) {
        console.error(`[Main] ${name} init failed:`, err);
        showStartupError(err, name);
        throw err;
    }
}

function initOptionalModule(name, factory) {
    try {
        return factory();
    } catch (err) {
        console.error(`[Main] ${name} init skipped:`, err);
        showStartupError(err, name);
        return null;
    }
}

function showStartupError(err, area = 'startup') {
    const status = document.getElementById('titlebarStatus');
    if (status) {
        const message = `Flow Canvas ${area} error: ${err?.message || err}`;
        const text = document.createElement('span');
        text.className = 'titlebar-status-message';
        text.textContent = message;
        text.title = message;
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'titlebar-status-copy';
        copy.title = '复制报错';
        copy.setAttribute('aria-label', '复制报错');
        copy.innerHTML = '<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-copy"></use></svg>';
        copy.addEventListener('click', async event => {
            event.stopPropagation();
            try {
                if (window.flowCanvas?.clipboard?.writeText) {
                    const result = await window.flowCanvas.clipboard.writeText(message);
                    if (result?.success === false) throw new Error(result.error || '复制失败');
                } else await navigator.clipboard.writeText(message);
                copy.querySelector('use').setAttribute('href', './icons/flow-icons.svg#icon-check');
                copy.title = '已复制';
                copy.setAttribute('aria-label', '报错已复制');
            } catch {
                copy.title = '复制失败，请重试';
                copy.setAttribute('aria-label', '复制失败，请重试');
            }
        });
        status.replaceChildren(text, copy);
        status.classList.add('status-visible', 'status-error', 'status-dismissible');
        status.title = '点击关闭';
        if (!showStartupError.bound) {
            showStartupError.bound = true;
            status.addEventListener('click', () => {
                status.textContent = '';
                status.classList.remove('status-visible', 'status-error', 'status-dismissible');
                status.removeAttribute('title');
                document.body.classList.remove('app-startup-error');
            });
        }
    }
    document.body.classList.add('app-startup-error');
}

function handleExternalStoreUpdate(payload) {
    if (!payload?.data || !canvasManager || !sidebarManager) return;

    if (saveTimer && !payload.skipFlush) saveStoreNow(true);
    if (window.flowCanvas.store.loadSync) payload = { ...payload, data: window.flowCanvas.store.loadSync() };
    if (payload.projectIds?.length && !payload.projectIds.includes(storeData.activeGroupId)
        && payload.data.activeGroupId === storeData.activeGroupId) {
        storeData.folderGroups = payload.data.folderGroups.map(group => group.id === storeData.activeGroupId
            ? sidebarManager.getActiveGroup() : group);
        sidebarManager.renderGroups();
        return;
    }

    isRestoringHistory = true;
    clearTimeout(historyCommitTimer);
    historyCommitTimer = null;
    clearTimeout(saveTimer);

    try {
        storeData = payload.data;
        sidebarManager.storeData = storeData;
        const incomingItems = (Array.isArray(storeData.items) ? storeData.items : [])
            .filter(item => item?.kind !== 'generation');
        const incomingItemCount = incomingItems.length;
        storeData.items = incomingItems.filter(item => !isRemovedFromBoard(item?.filePath));
        const filteredSuppressedItems = storeData.items.length < incomingItemCount;
        delete storeData.generationNodes;
        planService = new PlanService(storeData);

        canvasManager.storeData = storeData;
        canvasManager.planService = planService;

        if (filteredSuppressedItems) {
            const activeGroup = sidebarManager.getActiveGroup();
            if (activeGroup) activeGroup.savedItems = cloneData(storeData.items);
            saveStoreThrottled();
        }

        canvasManager.clearAll({ preserveTransients: true });
        canvasManager.setViewport(storeData.viewport || { x: 0, y: 0, scale: 1 });
        agentSidebar?.switchProjectContext?.(storeData.activeGroupId || null);
        canvasManager.renderInitialItems();
        canvasManager.graphView?.load(storeData.connections);
        sidebarManager.renderGroups();
        sidebarManager.updateStats(storeData.items?.length || 0);
        updateBodyState();
        resetHistory(payload.event || 'mcp-store-update');
        console.log('[Main] MCP store update applied:', payload.event);
    } finally {
        isRestoringHistory = false;
    }
}

let boardUsageTimer = null;
function startBoardUsageMonitor() {
    const memoryEl = document.getElementById('boardUsageMemory');
    const detailEl = document.getElementById('boardUsageDetail');
    if (!memoryEl || !detailEl || !window.flowCanvas?.metrics?.getBoardUsage) return;

    const formatMB = (kb) => {
        if (!Number.isFinite(kb)) return '-- MB';
        return `${Math.round(kb / 1024)} MB`;
    };

    const update = async () => {
        try {
            const usage = await window.flowCanvas.metrics.getBoardUsage();
            const stats = canvasManager?.getResourceUsageStats?.() || {};
            const workingSetKB = usage?.memory?.workingSetSize || usage?.memory?.privateBytes || 0;
            memoryEl.textContent = formatMB(workingSetKB);
            detailEl.textContent = `${stats.loaded || 0}/${stats.total || 0}`;
            detailEl.title = `loaded ${stats.loaded || 0}, loading ${stats.loading || 0}, queued ${stats.queued || 0}, ports ${stats.graphPortNodes || 0}/${stats.graphPortShapes || 0}, edges ${stats.graphEdges || 0}`;
        } catch (err) {
            memoryEl.textContent = '-- MB';
            detailEl.textContent = '0/0';
        }
    };

    clearInterval(boardUsageTimer);
    update();
    boardUsageTimer = setInterval(update, 2000);
}

function cloneData(value) {
    if (value == null) return value;
    return JSON.parse(JSON.stringify(value));
}

async function persistCompletedGenerationNode(nodeData) {
    const nodeId = String(nodeData?.id || '').trim();
    if (!nodeId || !storeData || !canvasManager) return false;

    const item = (storeData.items || []).find(candidate => candidate?.id === nodeId);
    if (!item) return false;

    const snapshot = cloneData(nodeData);
    Object.keys(item).forEach(key => { delete item[key]; });
    Object.assign(item, snapshot);
    return await Promise.resolve(saveStoreNow());
}

function getCurrentViewport() {
    if (canvasManager) return canvasManager.getViewport();
    return cloneData(storeData?.viewport || { x: 0, y: 0, scale: 1 });
}

function getActiveStoreGroup() {
    return (storeData?.folderGroups || []).find(group => group.id === storeData?.activeGroupId) || null;
}

function getBoardRevision() {
    const group = getActiveStoreGroup();
    const revision = Number(group?.boardRevision ?? storeData?.boardRevision);
    return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function setBoardRevision(revision) {
    if (!storeData) return 0;
    const normalized = Number.isInteger(Number(revision)) && Number(revision) >= 0 ? Number(revision) : 0;
    storeData.boardRevision = normalized;
    const group = getActiveStoreGroup();
    if (group) group.boardRevision = normalized;
    return normalized;
}

function incrementBoardRevision() {
    return setBoardRevision(getBoardRevision() + 1);
}

function getAppliedTransactionKeys() {
    const group = getActiveStoreGroup();
    const source = group?.appliedTransactionKeys ?? storeData?.appliedTransactionKeys;
    return [...new Set((Array.isArray(source) ? source : []).map(String).filter(Boolean))].slice(-200);
}

function setAppliedTransactionKeys(keys) {
    if (!storeData) return [];
    const normalized = [...new Set((Array.isArray(keys) ? keys : []).map(String).filter(Boolean))].slice(-200);
    storeData.appliedTransactionKeys = normalized;
    const group = getActiveStoreGroup();
    if (group) group.appliedTransactionKeys = [...normalized];
    return normalized;
}

function getViewportWorldBounds() {
    const viewport = getCurrentViewport();
    const scale = Math.max(0.01, Number(viewport.scale) || 1);
    const width = Number(canvasManager?.stage?.width?.()) || 0;
    const height = Number(canvasManager?.stage?.height?.()) || 0;
    return {
        x: -(Number(viewport.x) || 0) / scale,
        y: -(Number(viewport.y) || 0) / scale,
        width: width / scale,
        height: height / scale
    };
}

function getAgentBoardSnapshot(options = {}) {
    if (!storeData) return null;
    if (historyCommitTimer && !isRestoringHistory) commitHistory('before-agent-snapshot');
    const selectedItemIds = [...(canvasManager?.selectedItems || [])];
    return createBoardSnapshot({
        projectId: storeData.activeGroupId || null,
        revision: getBoardRevision(),
        items: storeData.items || [],
        connections: canvasManager?.graphView?.serialize?.() || storeData.connections || [],
        plans: planService?.listPlans?.() || [],
        viewport: getCurrentViewport(),
        selectedItemIds,
        appliedTransactionKeys: getAppliedTransactionKeys()
    }, {
        ...options,
        scope: options.scope || 'selection',
        selectedItemIds: options.selectedItemIds || selectedItemIds,
        viewportBounds: options.viewportBounds || getViewportWorldBounds()
    });
}

function previewAgentBoardTransaction(transaction) {
    const snapshot = getAgentBoardSnapshot({ scope: 'project' });
    if (!snapshot) throw new Error('画板尚未初始化');
    return previewBoardTransaction(snapshot, transaction);
}

function applyAgentBoardTransaction(transaction) {
    const current = getAgentBoardSnapshot({ scope: 'project' });
    if (!current) throw new Error('画板尚未初始化');
    const result = applyBoardTransaction(current, transaction);
    if (result.duplicate) return publicTransactionResult(result);

    commitHistory('before-agent-transaction');
    setBoardRevision(result.nextRevision);
    setAppliedTransactionKeys(result.snapshot.appliedTransactionKeys);
    restoreHistorySnapshot(result.snapshot, { boardRevision: result.nextRevision });
    historyStack.commitState(snapshotBoardState());
    rememberTransactionUndo(result.undoRecord);
    document.dispatchEvent(new CustomEvent('board-transaction-applied', {
        detail: publicTransactionResult(result)
    }));
    showHistoryStatus('Agent 已更新画板');
    return publicTransactionResult(result);
}

function undoAgentBoardTransaction(undoToken) {
    const token = String(undoToken || '').trim();
    const record = transactionUndoRecords.get(token);
    if (!record) throw new Error('撤销令牌不存在或已过期');
    const current = getAgentBoardSnapshot({ scope: 'project' });
    const result = undoBoardTransaction(current, record);
    setBoardRevision(result.nextRevision);
    setAppliedTransactionKeys(result.snapshot.appliedTransactionKeys);
    restoreHistorySnapshot(result.snapshot, { boardRevision: result.nextRevision });
    historyStack.commitState(snapshotBoardState());
    transactionUndoRecords.delete(token);
    showHistoryStatus('已撤销 Agent 画板操作');
    return {
        ok: true,
        transactionId: result.transactionId,
        previousRevision: result.previousRevision,
        nextRevision: result.nextRevision
    };
}

function rememberTransactionUndo(record) {
    if (!record?.token) return;
    transactionUndoRecords.set(record.token, record);
    while (transactionUndoRecords.size > TRANSACTION_UNDO_LIMIT) {
        transactionUndoRecords.delete(transactionUndoRecords.keys().next().value);
    }
}

function publicTransactionResult(result) {
    return {
        ok: result.ok,
        duplicate: result.duplicate,
        transactionId: result.transaction?.id || result.transactionId || null,
        currentRevision: result.currentRevision,
        nextRevision: result.nextRevision,
        operations: result.operations || [],
        summary: result.summary || null,
        warnings: result.warnings || [],
        tempIds: result.tempIds || {},
        undoToken: result.undoToken || null
    };
}

function applyAgentPlanRows(rows) {
    if (!Array.isArray(rows) || !planService || !canvasManager) return false;
    let plan = planService.listPlans()[0];
    if (!plan) {
        plan = canvasManager.addPlan();
    }
    if (!plan) return false;

    const normalizedRows = rows.map((row, index) => {
        const base = planService.createRow(index);
        const cells = row.cells || row;
        plan.columns.forEach(column => {
            if (cells[column.key] != null) {
                base.cells[column.key] = String(cells[column.key]);
            } else if (cells[column.label] != null) {
                base.cells[column.key] = String(cells[column.label]);
            }
        });
        return base;
    });

    planService.updatePlan(plan.id, { rows: normalizedRows });
    canvasManager.renderPlans();
    saveStoreThrottled();
    commitHistory('agent-plan-apply');
    return true;
}

function snapshotBoardState() {
    if (!storeData) return null;

    return {
        activeGroupId: storeData.activeGroupId || null,
        items: cloneData(storeData.items || []),
        removedFromBoardPaths: cloneData(getRemovedFromBoardPaths()),
        plans: cloneData(planService?.listPlans?.() || []),
        connections: cloneData(canvasManager?.graphView?.serialize?.() || []),
        viewport: cloneData(getCurrentViewport())
    };
}

function boardSemanticFingerprint(snapshot) {
    const clean = snapshotState(snapshot || {});
    delete clean.viewport;
    return JSON.stringify(clean);
}

function resetHistory(reason = 'reset') {
    clearTimeout(historyCommitTimer);
    const snapshot = snapshotBoardState();
    if (!snapshot) return;

    historyStack.resetState(snapshot);
    lastBoardSemanticFingerprint = boardSemanticFingerprint(snapshot);
    console.log('[History] reset:', reason);
}

function commitHistory(reason = 'change') {
    if (isRestoringHistory) return;

    clearTimeout(historyCommitTimer);
    historyCommitTimer = null;

    const snapshot = snapshotBoardState();
    if (!snapshot) return;

    const fingerprint = boardSemanticFingerprint(snapshot);
    if (!historyStack.commitState(snapshot)) return false;
    if (fingerprint !== lastBoardSemanticFingerprint) incrementBoardRevision();
    lastBoardSemanticFingerprint = fingerprint;
    console.log('[History] commit:', reason, 'undo:', historyStack.past.length);
    return true;
}

function scheduleHistoryCommit(reason = 'change') {
    if (isRestoringHistory) return;

    clearTimeout(historyCommitTimer);
    historyCommitTimer = setTimeout(() => {
        commitHistory(reason);
    }, 250);
}

function restoreHistorySnapshot(snapshot, options = {}) {
    if (!snapshot || !storeData || !canvasManager) return;

    isRestoringHistory = true;
    clearTimeout(historyCommitTimer);
    historyCommitTimer = null;
    clearTimeout(saveTimer);

    const restoredItems = cloneData(snapshot.items || []);
    const restoredPlans = cloneData(snapshot.plans || []);
    const restoredViewport = cloneData(snapshot.viewport || { x: 0, y: 0, scale: 1 });

    storeData.items = restoredItems;
    storeData.viewport = restoredViewport;
    setRemovedFromBoardPaths(snapshot.removedFromBoardPaths || []);
    const activeGroup = sidebarManager?.getActiveGroup();
    if (activeGroup) {
        activeGroup.plans = restoredPlans;
    }
    planService?.migrateStoreData?.();

    storeData.connections = cloneData(snapshot.connections || []);
    if (options.boardRevision != null) setBoardRevision(options.boardRevision);

    canvasManager.clearAll();
    canvasManager.storeData = storeData;
    canvasManager.setViewport(restoredViewport);
    canvasManager.renderInitialItems();
    canvasManager.graphView?.load(storeData.connections);
    lastBoardSemanticFingerprint = boardSemanticFingerprint(snapshot);

    sidebarManager?.updateStats?.(storeData.items.length);
    saveStoreNow();

    isRestoringHistory = false;
}

function undoHistory() {
    if (isRestoringHistory) return;

    commitHistory('before-undo');
    const current = snapshotBoardState();
    const target = historyStack.undoState();
    if (!target) {
        showHistoryStatus('没有可撤销的操作');
        return;
    }
    const semanticChange = boardSemanticFingerprint(current) !== boardSemanticFingerprint(target);
    restoreHistorySnapshot(target, { boardRevision: getBoardRevision() + (semanticChange ? 1 : 0) });
    showHistoryStatus('已撤销');
}

function redoHistory() {
    if (isRestoringHistory) return;

    commitHistory('before-redo');
    const current = snapshotBoardState();
    const target = historyStack.redoState();
    if (!target) {
        showHistoryStatus('没有可前进的操作');
        return;
    }
    const semanticChange = boardSemanticFingerprint(current) !== boardSemanticFingerprint(target);
    restoreHistorySnapshot(target, { boardRevision: getBoardRevision() + (semanticChange ? 1 : 0) });
    showHistoryStatus('已前进');
}

function showHistoryStatus(text) {
    const status = document.getElementById('titlebarStatus');
    if (!status) return;

    status.textContent = text;
    status.classList.add('status-visible');
    clearTimeout(showHistoryStatus.timer);
    showHistoryStatus.timer = setTimeout(() => {
        status.textContent = '';
        status.classList.remove('status-visible');
    }, 1200);
}

async function reconcileGroupFiles(folders, currentSwitchRun) {
    if (!window.flowCanvas?.folder?.scan || !canvasManager || !storeData) return;

    const activeGroup = sidebarManager?.getActiveGroup?.() || null;
    const isInitializingRemovedPaths = Boolean(
        activeGroup && activeGroup.removedFromBoardPathsInitialized !== true
    );
    const successfulFolders = [];
    const discoveredFiles = new Set();
    const addedItems = [];
    const legacyMissingPaths = [];
    const existingFilePaths = new Set(
        (storeData.items || [])
            .map(item => item?.filePath)
            .filter(Boolean)
            .map(filePath => normalizeFsPath(filePath))
    );

    for (const folder of folders) {
        if (currentSwitchRun !== switchGroupRunId) return;

        let scanResult = null;
        try {
            scanResult = await window.flowCanvas.folder.scan(folder);
        } catch (err) {
            console.warn('[Main] folder scan failed:', folder, err);
            continue;
        }

        if (currentSwitchRun !== switchGroupRunId) return;

        const parsed = parseScanResult(scanResult);
        if (!parsed.success) {
            console.warn('[Main] folder scan skipped:', folder, parsed.error || 'unknown error');
            continue;
        }

        successfulFolders.push(folder);
        parsed.files.forEach(filePath => {
            if (!isSupportedBoardFile(filePath) || isTemporaryBoardFile(filePath)) return;
            const normalizedFilePath = normalizeFsPath(filePath);
            discoveredFiles.add(normalizedFilePath);
            if (existingFilePaths.has(normalizedFilePath)) return;
            if (isInitializingRemovedPaths) {
                legacyMissingPaths.push(filePath);
                return;
            }
            if (isRemovedFromBoard(filePath)) return;
            const item = canvasManager.addFile(filePath);
            if (item) {
                storeData.items.push(item);
                addedItems.push(item);
                existingFilePaths.add(normalizedFilePath);
            }
        });
    }

    if (currentSwitchRun !== switchGroupRunId) return;

    if (isInitializingRemovedPaths && successfulFolders.length > 0) {
        markRemovedFromBoard(legacyMissingPaths);
        if (successfulFolders.length === folders.length) {
            activeGroup.removedFromBoardPathsInitialized = true;
        }
    }

    if (successfulFolders.length > 0) {
        const removedItems = storeData.items.filter(item => {
            if (!item?.filePath) return false;
            return successfulFolders.some(folder => isPathInsideFolder(item.filePath, folder)) &&
                !discoveredFiles.has(normalizeFsPath(item.filePath));
        });

        removedItems.forEach(item => {
            canvasManager.removeItemById(item.id);
        });
        const removedIds = new Set(removedItems.map(item => item.id));
        storeData.items = storeData.items.filter(item => !removedIds.has(item.id));
    }

    if (addedItems.length > 0 && addedItems.length === storeData.items.length) {
        canvasManager.packLayout();
    }
}

function parseScanResult(scanResult) {
    if (Array.isArray(scanResult)) {
        return { success: true, files: scanResult, error: null };
    }
    return {
        success: scanResult?.success === true,
        files: Array.isArray(scanResult?.files) ? scanResult.files : [],
        error: scanResult?.error || null
    };
}

async function repairDisconnectedMaterials(detail = {}, options = {}) {
    if (!canvasManager || !storeData) return;
    const itemIds = (detail.itemIds || []).filter(Boolean);
    const candidateIds = itemIds.length > 0
        ? itemIds
        : (detail.itemId ? [detail.itemId] : []);
    if (candidateIds.length === 0 && !(detail.fileTargets || []).length) return;

    const explicitTargets = (detail.fileTargets || [])
        .map(target => ({
            item: storeData.items.find(item => item.id === target.itemId),
            filePath: target.filePath || '',
            generatorResult: target.generatorResult === true
        }))
        .filter(target => target.item && target.filePath);
    const targets = explicitTargets.length > 0
        ? explicitTargets
        : candidateIds
            .map(id => storeData.items.find(item => item.id === id))
            .filter(Boolean)
            .map(item => ({ item, filePath: item.filePath || '', generatorResult: false }))
            .filter(target => target.filePath);
    if (targets.length === 0) return;

    let repaired = 0;
    if (options.manual) {
        if (targets.length !== 1) {
            showHistoryStatus('手动重接一次只能选择 1 个素材');
            return;
        }
        repaired = await relinkMaterialManually(targets[0]);
    } else {
        repaired = await repairMaterialsAutomatically(targets);
    }

    if (repaired > 0) {
        saveStoreNow();
        sidebarManager?.updateStats?.(storeData.items?.length || 0);
        commitHistory(options.manual ? 'relink-material' : 'repair-materials');
    }
}

async function relinkMaterialManually(target) {
    if (!window.flowCanvas?.file?.selectReplacement) {
        showHistoryStatus('当前版本不支持选择替代文件');
        return 0;
    }
    const expectedType = getBoardMediaType(
        target.filePath,
        target.generatorResult ? target.item.nodeType : target.item.mediaType
    );
    const result = await window.flowCanvas.file.selectReplacement({
        originalPath: target.filePath,
        mediaType: expectedType
    });
    if (!result?.success || !result.filePath) {
        if (!result?.canceled) showHistoryStatus('未选择替代文件');
        return 0;
    }
    if (!isSupportedBoardFile(result.filePath) || isTemporaryBoardFile(result.filePath)) {
        showHistoryStatus('请选择 Flow Canvas 支持的素材文件');
        return 0;
    }
    const replacementType = getBoardMediaType(result.filePath);
    if (expectedType && expectedType !== 'other' && replacementType !== expectedType) {
        showHistoryStatus(`请选择${expectedType === 'image' ? '图片' : expectedType === 'video' ? '视频' : expectedType === 'audio' ? '音频' : '同类型'}素材`);
        return 0;
    }
    if (!applyMaterialRelink(target, result.filePath)) {
        showHistoryStatus('替换失败，结果路径没有更新');
        return 0;
    }
    showHistoryStatus('已重接素材');
    return 1;
}

async function repairMaterialsAutomatically(targets) {
    const folders = sidebarManager?.getActiveWatchFolders?.() || storeData?.watchFolders || [];
    if (!window.flowCanvas?.folder?.scan || folders.length === 0) {
        showHistoryStatus('请先关联素材文件夹，或使用“手动重接素材”');
        return 0;
    }

    const nameMap = new Map();
    const candidates = [];
    for (const folder of folders) {
        let scanResult = null;
        try {
            scanResult = await window.flowCanvas.folder.scan(folder);
        } catch (err) {
            console.warn('[Main] repair scan failed:', folder, err);
            continue;
        }
        const parsed = parseScanResult(scanResult);
        if (!parsed.success) continue;
        parsed.files.forEach(filePath => {
            if (!isSupportedBoardFile(filePath) || isTemporaryBoardFile(filePath)) return;
            const nameKey = getFileNameKey(filePath);
            candidates.push(filePath);
            if (!nameKey || !nameMap.has(nameKey)) {
                nameMap.set(nameKey, filePath);
            }
        });
    }

    let repaired = 0;
    targets.forEach(target => {
        const match = nameMap.get(getFileNameKey(target.filePath)) || findLikelyMaterialMatch(target.filePath, candidates);
        if (!match) return;
        if (applyMaterialRelink(target, match)) repaired += 1;
    });

    showHistoryStatus(repaired > 0 ? `已修补 ${repaired} 个素材` : '没有在当前文件夹里找到同名素材');
    return repaired;
}

function applyMaterialRelink(target, nextPath) {
    const { item, filePath: oldPath, generatorResult } = target;
    const updated = generatorResult
        ? canvasManager.updateGeneratorResultFilePath(item.id, oldPath, nextPath)
        : canvasManager.updateItemFilePath(item.id, nextPath, {
            reflowToNewAspect: true,
            forceReload: true
        });
    if (!updated && !generatorResult) item.filePath = nextPath;
    if (updated || !generatorResult) {
        console.log('[Main] 素材已重接:', oldPath, '=>', nextPath);
        return true;
    }
    return false;
}

function getFileNameKey(filePath) {
    return String(filePath || '').split(/[/\\]/).pop()?.toLowerCase() || '';
}

function findLikelyMaterialMatch(originalPath, candidates = []) {
    const originalName = getFileNameKey(originalPath);
    const originalExt = getFileExt(originalName);
    const originalRawStem = stripFileExt(originalName);
    const originalStem = normalizeMaterialName(originalRawStem);
    if (!originalStem) return null;

    const scored = [];
    candidates.forEach(candidatePath => {
        const candidateName = getFileNameKey(candidatePath);
        const candidateExt = getFileExt(candidateName);
        const sameExt = originalExt && candidateExt === originalExt;
        const compatibleExt = sameExt || areCompatibleMediaExts(originalExt, candidateExt);
        if (originalExt && candidateExt && !compatibleExt) return;
        const candidateRawStem = stripFileExt(candidateName);
        const candidateStem = normalizeMaterialName(candidateRawStem);
        if (!candidateStem) return;

        const score = scoreMaterialNameMatch({
            originalStem,
            candidateStem,
            originalRawStem,
            candidateRawStem,
            extensionBoost: sameExt ? 0.08 : 0
        });
        scored.push({ path: candidatePath, score });
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (!best) return null;

    const secondScore = scored[1]?.score || 0;
    const confident = best.score >= 0.56 && (best.score >= 0.72 || best.score - secondScore >= 0.08);
    console.log('[Main] 自动修补候选:', originalName, scored.slice(0, 3));
    return confident ? best.path : null;
}

function getFileExt(fileName) {
    const match = String(fileName || '').match(/\.([^.]+)$/);
    return match ? match[1].toLowerCase() : '';
}

function stripFileExt(fileName) {
    return String(fileName || '').replace(/\.[^.]+$/, '');
}

function normalizeMaterialName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[_\-\s()[\]{}，,。.!！?？"'“”‘’·:：/\\]+/g, '')
        .replace(/\d{8,}/g, '')
        .replace(/\d+k/g, '')
        .replace(/copy|副本|拷贝|最终|导出|结果|原图|图片|图像|素材/g, '');
}

function scoreMaterialNameMatch({ originalStem, candidateStem, originalRawStem, candidateRawStem, extensionBoost = 0 }) {
    if (candidateStem === originalStem) return 1;

    const containment = candidateStem.includes(originalStem) || originalStem.includes(candidateStem)
        ? Math.min(candidateStem.length, originalStem.length) / Math.max(candidateStem.length, originalStem.length)
        : 0;
    const substring = longestCommonSubstringRatio(originalStem, candidateStem);
    const dice = diceCoefficient(originalStem, candidateStem);
    const token = tokenOverlapRatio(originalRawStem, candidateRawStem);
    const phrase = phraseContainmentScore(originalStem, candidateStem);

    return Math.min(1, Math.max(
        containment * 0.9,
        substring * 0.78,
        dice * 0.78,
        token * 0.72,
        phrase * 0.88
    ) + extensionBoost);
}

function areCompatibleMediaExts(a, b) {
    const image = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif', 'gif']);
    const video = new Set(['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'm4v']);
    if (image.has(a) && image.has(b)) return true;
    if (video.has(a) && video.has(b)) return true;
    return false;
}

function diceCoefficient(a, b) {
    const left = charBigrams(a);
    const right = charBigrams(b);
    if (left.length === 0 || right.length === 0) return 0;
    const counts = new Map();
    left.forEach(pair => counts.set(pair, (counts.get(pair) || 0) + 1));
    let hits = 0;
    right.forEach(pair => {
        const count = counts.get(pair) || 0;
        if (count > 0) {
            hits += 1;
            counts.set(pair, count - 1);
        }
    });
    return (2 * hits) / (left.length + right.length);
}

function charBigrams(value) {
    const text = String(value || '');
    if (text.length < 2) return text ? [text] : [];
    const pairs = [];
    for (let index = 0; index < text.length - 1; index += 1) {
        pairs.push(text.slice(index, index + 2));
    }
    return pairs;
}

function tokenOverlapRatio(a, b) {
    const left = tokenizeMaterialName(a);
    const right = tokenizeMaterialName(b);
    if (left.length === 0 || right.length === 0) return 0;
    const rightSet = new Set(right);
    const hits = left.filter(token => rightSet.has(token)).length;
    return hits / Math.min(left.length, right.length);
}

function tokenizeMaterialName(value) {
    return String(value || '')
        .toLowerCase()
        .split(/[_\-\s()[\]{}，,。.!！?？"'“”‘’·:：/\\]+/)
        .map(token => normalizeMaterialName(token))
        .filter(token => token.length >= 2 && !/^\d+$/.test(token));
}

function phraseContainmentScore(a, b) {
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length > b.length ? a : b;
    if (shorter.length < 4) return 0;
    const minPhrase = Math.min(8, Math.max(4, Math.floor(shorter.length * 0.42)));
    for (let length = shorter.length; length >= minPhrase; length -= 1) {
        for (let start = 0; start + length <= shorter.length; start += 1) {
            if (longer.includes(shorter.slice(start, start + length))) {
                return length / Math.max(a.length, b.length);
            }
        }
    }
    return 0;
}

function longestCommonSubstringRatio(a, b) {
    if (!a || !b) return 0;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length > b.length ? a : b;
    let best = 0;
    for (let start = 0; start < shorter.length; start += 1) {
        for (let end = start + best + 1; end <= shorter.length; end += 1) {
            if (longer.includes(shorter.slice(start, end))) {
                best = end - start;
            }
        }
    }
    return best / Math.max(a.length, b.length);
}

function isWatchedBoardFile(filePath) {
    if (!filePath || !isSupportedBoardFile(filePath) || isTemporaryBoardFile(filePath)) {
        return false;
    }

    const folders = sidebarManager?.getActiveWatchFolders?.() || storeData?.watchFolders || [];
    if (folders.length === 0) return false;

    const normalizedPath = normalizeFsPath(filePath);
    return folders.some(folder => isPathInsideFolder(normalizedPath, folder));
}

function getBoardMediaType(filePath, fallback = '') {
    const ext = String(filePath || '').split('.').pop()?.toLowerCase() || '';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'svg', 'ico'].includes(ext)) return 'image';
    if (['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'm4v'].includes(ext)) return 'video';
    if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'wma', 'm4a'].includes(ext)) return 'audio';
    if (['pdf', 'doc', 'docx', 'txt', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) return 'document';
    return String(fallback || '').toLowerCase() || 'other';
}

function isAssetLibraryFile(filePath) {
    if (!filePath || !isSupportedBoardFile(filePath) || isTemporaryBoardFile(filePath)) return false;
    const folders = sidebarManager?.getAssetLibraryFolders?.() || [];
    if (folders.length === 0) return false;
    const normalizedPath = normalizeFsPath(filePath);
    return folders.some(folder => isPathInsideFolder(normalizedPath, folder));
}

function isSupportedBoardFile(filePath) {
    return /\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|svg|ico|mp4|mov|avi|mkv|wmv|flv|webm|m4v|mp3|wav|aac|flac|ogg|wma|m4a|pdf|doc|docx|txt|ppt|pptx|xls|xlsx)$/i.test(filePath);
}

function isTemporaryBoardFile(filePath) {
    const name = String(filePath).split(/[/\\]/).pop() || '';
    const lower = name.toLowerCase();
    if (!name || name.startsWith('.') || name.startsWith('~') || name.endsWith('~')) return true;
    if (lower === 'thumbs.db' || lower === 'desktop.ini') return true;
    if (/\.(tmp|temp|part|partial|crdownload|download|swp|swo)$/i.test(lower)) return true;
    if (/\.(jpg|jpeg|png|gif|webp|bmp|tif|tiff)\.(tmp|temp|part|partial|download)$/i.test(lower)) return true;
    return false;
}

function normalizeFsPath(filePath) {
    const raw = String(filePath || '');
    if (!raw) return '';
    const normalized = raw
        .normalize('NFC')
        .replace(/\\/g, '/')
        .replace(/\/+$/g, '') || '/';
    return window.flowCanvas?.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getRemovedFromBoardOwner() {
    return sidebarManager?.getActiveGroup?.() || storeData;
}

function getRemovedFromBoardPaths() {
    const owner = getRemovedFromBoardOwner();
    if (!owner) return [];

    const normalizedPaths = [...new Set(
        (Array.isArray(owner.removedFromBoardPaths) ? owner.removedFromBoardPaths : [])
            .map(normalizeFsPath)
            .filter(Boolean)
    )];
    owner.removedFromBoardPaths = normalizedPaths;
    return normalizedPaths;
}

function setRemovedFromBoardPaths(filePaths) {
    const owner = getRemovedFromBoardOwner();
    if (!owner) return;
    owner.removedFromBoardPaths = [...new Set(
        (Array.isArray(filePaths) ? filePaths : [])
            .map(normalizeFsPath)
            .filter(Boolean)
    )];
}

function isRemovedFromBoard(filePath) {
    const normalizedPath = normalizeFsPath(filePath);
    return normalizedPath !== '' && getRemovedFromBoardPaths().includes(normalizedPath);
}

function markRemovedFromBoard(filePaths) {
    const currentPaths = new Set(getRemovedFromBoardPaths());
    const previousSize = currentPaths.size;
    (filePaths || []).forEach(filePath => {
        const normalizedPath = normalizeFsPath(filePath);
        if (normalizedPath) currentPaths.add(normalizedPath);
    });
    setRemovedFromBoardPaths([...currentPaths]);
    return currentPaths.size !== previousSize;
}

function restoreRemovedFromBoard(filePath) {
    const normalizedPath = normalizeFsPath(filePath);
    if (!normalizedPath) return false;
    const currentPaths = getRemovedFromBoardPaths();
    const nextPaths = currentPaths.filter(path => path !== normalizedPath);
    if (nextPaths.length === currentPaths.length) return false;
    setRemovedFromBoardPaths(nextPaths);
    return true;
}

function isPathInsideFolder(filePath, folderPath) {
    const normalizedPath = normalizeFsPath(filePath);
    const normalizedFolder = normalizeFsPath(folderPath);
    if (!normalizedPath || !normalizedFolder) return false;
    return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
}

// 节流保存
let saveTimer = null;
function saveStoreThrottled() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveStoreNow, 1000);
}

function saveStoreNow(useSync = false) {
    if (!storeData || !canvasManager) return;
    clearTimeout(saveTimer);
    saveTimer = null;

    storeData.viewport = canvasManager.getViewport();

    // 同步当前 items 到激活的组
    const activeGroup = sidebarManager?.getActiveGroup();
    if (activeGroup) {
        activeGroup.savedItems = cloneData(storeData.items || []);
        activeGroup.savedViewport = cloneData(storeData.viewport);
        activeGroup.plans = cloneData(planService?.listPlans?.() || activeGroup.plans || []);
        activeGroup.connections = cloneData(canvasManager.graphView?.serialize?.() || []);
        activeGroup.boardRevision = getBoardRevision();
        activeGroup.appliedTransactionKeys = cloneData(getAppliedTransactionKeys());
    }

    storeData.connections = cloneData(canvasManager.graphView?.serialize?.() || []);
    storeData.boardRevision = getBoardRevision();
    storeData.appliedTransactionKeys = cloneData(getAppliedTransactionKeys());

    if (useSync && window.flowCanvas?.store?.saveSync) {
        const result = window.flowCanvas.store.saveSync(storeData);
        updateBodyState();
        return result;
    } else {
        const result = window.flowCanvas.store.save(storeData);
        updateBodyState();
        return result;
    }
}

function updateBodyState() {
    const emptyCanvas = document.getElementById('canvasEmpty');
    if (emptyCanvas) emptyCanvas.style.display = storeData?.items?.length ? 'none' : '';
    const activeWatchFolders = sidebarManager ? sidebarManager.getActiveWatchFolders() : [];
    if (activeWatchFolders.length > 0) {
        document.body.classList.add('has-folders');
    } else if (storeData && storeData.watchFolders && storeData.watchFolders.length > 0) {
        document.body.classList.add('has-folders');
    } else {
        document.body.classList.remove('has-folders');
    }
}

// 启动
bootstrap();

window.addEventListener('beforeunload', () => {
    window.flowCanvas?.mcp?.setBoardToolsReady?.(false);
    unsubscribeBoardToolRequests?.();
    unsubscribeBoardToolRequests = null;
    saveStoreNow(true);
});
