import gsap from 'gsap';
import { NODE_TYPES } from './node-types.js';
import { nodeIconSvg } from './node-icons.js';

const GROUP_TASK_ACKNOWLEDGED_STORAGE_KEY = 'flow-canvas-group-task-acknowledged-v1';
const ASSET_CATEGORY_ORDER = ['角色', '场景', '道具', '风格', '音效', 'Others'];

// ============================================================
// Flow Canvas — Sidebar Manager (with GSAP Hover Accordion)
// ============================================================

export class SidebarManager {
    constructor(storeData, assetLibraryContext = {}) {
        this.storeData = storeData;
        this.listeners = {};
        this.pendingMove = null;
        this._watcherSyncRunId = 0;
        this.groupTaskStates = new Map();
        this.generationTasks = [];
        this.groupTaskAcknowledgedAt = this._loadGroupTaskAcknowledgements();
        this.assetLibraryFiles = [];
        this.assetLibraryMetadata = new Map();
        this.assetLibrarySource = '';
        this.assetLibraryQuery = '';
        this.assetLibraryCategory = '';
        this.assetLibraryLoading = false;
        this._assetLibraryScanRunId = 0;
        this._assetThumbnailObserver = null;
        this.assetLibraryManagedFolder = String(assetLibraryContext.managedFolder || '');
        const storedAssetLibrary = this.storeData.assetLibrary && typeof this.storeData.assetLibrary === 'object'
            ? this.storeData.assetLibrary
            : {};
        this.storeData.assetLibrary = {
            folders: Array.isArray(assetLibraryContext.folders)
                ? [...assetLibraryContext.folders]
                : (Array.isArray(storedAssetLibrary.folders) ? [...storedAssetLibrary.folders] : []),
            defaultFolder: assetLibraryContext.defaultFolder || storedAssetLibrary.defaultFolder || this.assetLibraryManagedFolder || null
        };

        // 数据迁移：如果旧数据有 watchFolders 但没有 folderGroups，自动创建默认组
        if (!this.storeData.folderGroups) {
            this.storeData.folderGroups = [];
        }
        if (this.storeData.watchFolders && this.storeData.watchFolders.length > 0 && this.storeData.folderGroups.length === 0) {
            const defaultGroup = {
                id: Date.now().toString(),
                name: '默认组',
                folders: [...this.storeData.watchFolders],
                removedFromBoardPaths: [],
                removedFromBoardPathsInitialized: false
            };
            this.storeData.folderGroups.push(defaultGroup);
            this.storeData.activeGroupId = defaultGroup.id;
        }

        this._migrateGroupDefaults();
        const originalWatchFolders = JSON.stringify(this.storeData.watchFolders || []);
        const originalActiveDefault = this.storeData.activeGroupDefaultSaveFolder || null;
        this._syncWatchFolders();

        this.dom = {
            sidebar: document.getElementById('sidebar'),
            collapseBtn: document.getElementById('collapseSidebarBtn'),
            addGroupBtn: document.getElementById('addGroupBtn'),
            emptyAddBtn: document.getElementById('emptyAddBtn'),
            folderGroupList: document.getElementById('folderGroupList'),
            filterChips: document.getElementById('filterChips'),
            assetLibraryPanel: document.getElementById('canvasAssetLibrary'),
            assetLibraryToggle: document.getElementById('canvasToolLibrary'),
            assetLibraryCloseBtn: document.getElementById('assetLibraryCloseBtn'),
            assetLibraryAddFolderBtn: document.getElementById('assetLibraryAddFolderBtn'),
            assetLibraryRemoveFolderBtn: document.getElementById('assetLibraryRemoveFolderBtn'),
            assetLibraryDefaultFolderBtn: document.getElementById('assetLibraryDefaultFolderBtn'),
            assetLibrarySourceSelect: document.getElementById('assetLibrarySourceSelect'),
            assetLibraryTypeFilters: document.getElementById('assetLibraryTypeFilters'),
            assetCategoryFilters: document.getElementById('assetCategoryFilters'),
            assetLibrarySearch: document.getElementById('assetLibrarySearch'),
            assetLibrarySearchClear: document.getElementById('assetLibrarySearchClear'),
            assetLibraryGrid: document.getElementById('assetLibraryGrid'),
            assetLibraryScope: document.getElementById('assetLibraryScope'),
            assetLibraryResultCount: document.getElementById('assetLibraryResultCount'),
            fitAllBtn: document.getElementById('fitAllBtn'),
            packLayoutBtn: document.getElementById('packLayoutBtn'),
            seamlessLayoutBtn: document.getElementById('seamlessLayoutBtn'),
            newPlanBtn: document.getElementById('newPlanBtn'),
            nodePalette: document.getElementById('nodePalette'),
            exportMdBtn: document.getElementById('exportMdBtn'),
            resourceSaverBtn: document.getElementById('resourceSaverBtn'),
            resourceSaverState: document.getElementById('resourceSaverState'),
            stats: document.getElementById('sidebarStats'),
            alwaysOnTopBtn: document.getElementById('alwaysOnTopBtn'),
            alwaysOnTopLabel: document.getElementById('alwaysOnTopLabel')
        };

        this.bindEvents();
        this.renderGroups();
        this._renderAssetLibrarySources();
        void this._refreshAssetLibraryFiles();

        // 恢复侧边栏状态
        if (this.storeData.sidebarClosed) {
            document.body.classList.add('sidebar-closed');
        }

        // 恢复置顶状态
        this._initAlwaysOnTop();
        this._updateResourceSaverButton(!!this.storeData.resourceSaver);

        // ── 初始化通用手风琴动画（过滤器 / 画布 / 窗口） ──
        this._initAccordions();
        if (
            JSON.stringify(this.storeData.watchFolders || []) !== originalWatchFolders ||
            (this.storeData.activeGroupDefaultSaveFolder || null) !== originalActiveDefault
        ) {
            this._saveStore();
        }
        void this._restoreActiveGroupWatcherState();
    }

    // ── 获取当前激活的组 ──
    getActiveGroup() {
        if (!this.storeData.activeGroupId) return null;
        return this.storeData.folderGroups.find(g => g.id === this.storeData.activeGroupId) || null;
    }

    // ── 获取当前组的 watchFolders ──
    getActiveWatchFolders() {
        const group = this.getActiveGroup();
        return group ? group.folders : [];
    }

    setGenerationTaskStates(tasks = []) {
        this.generationTasks = Array.isArray(tasks) ? tasks : [];
        const groupedTasks = new Map();
        this.generationTasks.forEach(task => {
            const projectId = String(task?.projectId || '').trim();
            if (!projectId) return;
            if (!groupedTasks.has(projectId)) groupedTasks.set(projectId, []);
            groupedTasks.get(projectId).push(task);
        });

        this.groupTaskStates = new Map();
        groupedTasks.forEach((projectTasks, projectId) => {
            if (projectTasks.some(task => task?.status === 'running')) {
                this.groupTaskStates.set(projectId, 'running');
                return;
            }
            const latest = [...projectTasks].sort((left, right) => {
                const leftTime = new Date(left?.updatedAt || left?.createdAt || 0).getTime();
                const rightTime = new Date(right?.updatedAt || right?.createdAt || 0).getTime();
                return rightTime - leftTime;
            })[0];
            const latestTime = new Date(latest?.updatedAt || latest?.createdAt || 0).getTime();
            const acknowledgedAt = Number(this.groupTaskAcknowledgedAt.get(projectId)) || 0;
            if (!Number.isFinite(latestTime) || latestTime <= acknowledgedAt) return;
            if (latest?.status === 'success') this.groupTaskStates.set(projectId, 'success');
            else if (['failed', 'disconnected'].includes(latest?.status)) this.groupTaskStates.set(projectId, 'failed');
        });

        this._applyGroupTaskStates();
    }

    _loadGroupTaskAcknowledgements() {
        try {
            const saved = JSON.parse(localStorage.getItem(GROUP_TASK_ACKNOWLEDGED_STORAGE_KEY) || '{}');
            return new Map(Object.entries(saved && typeof saved === 'object' ? saved : {}));
        } catch (_) {
            return new Map();
        }
    }

    _saveGroupTaskAcknowledgements() {
        try {
            localStorage.setItem(
                GROUP_TASK_ACKNOWLEDGED_STORAGE_KEY,
                JSON.stringify(Object.fromEntries(this.groupTaskAcknowledgedAt))
            );
        } catch (error) {
            console.warn('[Sidebar] Failed to save task acknowledgements:', error);
        }
    }

    _acknowledgeGroupTaskState(groupId) {
        const projectId = String(groupId || '').trim();
        if (!projectId) return;
        const latestTaskTime = this.generationTasks
            .filter(task => String(task?.projectId || '') === projectId && task?.status !== 'running')
            .reduce((latest, task) => {
                const timestamp = new Date(task?.updatedAt || task?.createdAt || 0).getTime();
                return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
            }, 0);
        if (latestTaskTime <= (Number(this.groupTaskAcknowledgedAt.get(projectId)) || 0)) return;
        this.groupTaskAcknowledgedAt.set(projectId, Math.max(Date.now(), latestTaskTime));
        this._saveGroupTaskAcknowledgements();
        this.setGenerationTaskStates(this.generationTasks);
    }

    _applyGroupTaskStates() {
        this.dom?.folderGroupList?.querySelectorAll('.folder-group-item').forEach(groupItem => {
            const projectId = String(groupItem.dataset.groupId || '');
            const state = this.groupTaskStates.get(projectId) || '';
            groupItem.classList.toggle('task-state-running', state === 'running');
            groupItem.classList.toggle('task-state-success', state === 'success');
            groupItem.classList.toggle('task-state-failed', state === 'failed');
            const statusDot = groupItem.querySelector('.group-task-status');
            if (statusDot) {
                statusDot.title = state === 'running'
                    ? '有任务正在运行'
                    : state === 'success'
                        ? '最近任务已完成'
                        : state === 'failed'
                            ? '最近任务失败或断连'
                            : '';
            }
        });
    }

    _normalizePath(filePath) {
        const normalized = String(filePath || '')
            .normalize('NFC')
            .replace(/\\/g, '/')
            .replace(/\/+$/g, '');
        return window.flowCanvas?.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }

    _escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    _isPathInsideFolder(filePath, folderPath) {
        const normalizedFilePath = this._normalizePath(filePath);
        const normalizedFolderPath = this._normalizePath(folderPath);
        if (!normalizedFilePath || !normalizedFolderPath) return false;
        return normalizedFilePath === normalizedFolderPath ||
            normalizedFilePath.startsWith(`${normalizedFolderPath}/`);
    }

    _dedupePaths(paths = []) {
        const seen = new Set();
        return paths.filter(Boolean).filter(folderPath => {
            const key = this._normalizePath(folderPath);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    _isManagedAssetLibraryFolder(folderPath) {
        return Boolean(folderPath)
            && this._normalizePath(folderPath) === this._normalizePath(this.assetLibraryManagedFolder);
    }

    getAssetLibraryFolders() {
        const customFolders = Array.isArray(this.storeData.assetLibrary?.folders)
            ? this.storeData.assetLibrary.folders
            : [];
        return this._dedupePaths([this.assetLibraryManagedFolder, ...customFolders]);
    }

    getAssetLibrarySettings() {
        return {
            folders: this.getAssetLibraryFolders(),
            defaultFolder: this.storeData.assetLibrary?.defaultFolder || this.assetLibraryManagedFolder || null,
            managedFolder: this.assetLibraryManagedFolder || null
        };
    }

    _notifyAssetLibrarySettingsChanged() {
        this.emit('assetLibrarySettingsChanged', this.getAssetLibrarySettings());
    }

    _assetFileName(filePath) {
        return String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '素材';
    }

    _assetFolderName(folderPath) {
        return this._assetFileName(folderPath) || '本地目录';
    }

    _assetFileType(filePath) {
        const ext = String(filePath || '').split('.').pop().toLowerCase();
        if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif'].includes(ext)) return 'image';
        if (['gif', 'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm'].includes(ext)) return 'video';
        if (['mp3', 'wav', 'aac', 'flac', 'ogg'].includes(ext)) return 'audio';
        if (['pdf', 'doc', 'docx', 'txt', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) return 'document';
        return 'other';
    }

    _assetTypeLabel(type) {
        return {
            image: '图片',
            video: '视频',
            audio: '音频',
            document: '文档',
            other: '其他'
        }[type] || '其他';
    }

    _assetTypeIcon(type) {
        return {
            image: 'icon-image',
            video: 'icon-video',
            audio: 'icon-audio',
            document: 'icon-canvas',
            other: 'icon-folder'
        }[type] || 'icon-folder';
    }

    _assetMetadata(filePath) {
        return this.assetLibraryMetadata.get(this._normalizePath(filePath)) || null;
    }

    _metadataValues(value) {
        return [...new Set((Array.isArray(value) ? value : [])
            .map(item => String(item || '').trim()).filter(Boolean))];
    }

    _normalizeAssetCategory(value) {
        const category = String(value || '').trim();
        if (/^(?:角色|人物|人像|模特|people|person|character)$/i.test(category)) return '角色';
        if (/^(?:场景|空间|环境|建筑|自然|美食|scene|space|environment|architecture|nature)$/i.test(category)) return '场景';
        if (/^(?:道具|产品|物品|器物|object|objects|product|prop)$/i.test(category)) return '道具';
        if (/^(?:风格|时尚|平面|ui|材质|style|fashion|graphic|material)$/i.test(category)) return '风格';
        if (/^(?:音效|声音|音频|音乐|sound|audio|music)$/i.test(category)) return '音效';
        return 'Others';
    }

    _assetCategories(filePath) {
        const metadata = this._assetMetadata(filePath);
        const categories = this._metadataValues([
            ...(metadata?.categories || []),
            ...(metadata?.classification?.categories || [])
        ]).map(category => this._normalizeAssetCategory(category));
        if (categories.length > 0) return [...new Set(categories)];
        return [this._assetFileType(filePath) === 'audio' ? '音效' : 'Others'];
    }

    _assetSearchMetadata(filePath) {
        const metadata = this._assetMetadata(filePath);
        if (!metadata) return '';
        const dimensions = metadata.dimensions && typeof metadata.dimensions === 'object'
            ? Object.values(metadata.dimensions).flat()
            : [];
        return [
            ...(metadata.categories || []),
            ...(metadata.tags || []),
            ...(metadata.colors || []),
            ...dimensions,
            metadata.summary,
            metadata.source?.pageTitle,
            metadata.source?.pageUrl,
            metadata.source?.url
        ].filter(Boolean).join(' ');
    }

    async _loadAssetMetadata(filePaths) {
        if (!window.flowCanvas?.asset?.readMetadata || !filePaths.length) {
            this.assetLibraryMetadata = new Map();
            return;
        }
        try {
            const result = await window.flowCanvas.asset.readMetadata(filePaths);
            this.assetLibraryMetadata = new Map(Object.entries(result || {})
                .map(([filePath, metadata]) => [this._normalizePath(filePath), metadata]));
        } catch (error) {
            console.warn('[Sidebar] 素材分类信息读取失败:', error);
            this.assetLibraryMetadata = new Map();
        }
    }

    _queuePendingAssetClassifications() {
        const pending = this.assetLibraryFiles.filter(filePath => {
            if (this._assetFileType(filePath) !== 'image') return false;
            const classification = this._assetMetadata(filePath)?.classification;
            if (classification?.status === 'pending') return Number(classification.attempts || 0) < 2;
            if (classification?.status !== 'running') return false;
            const startedAt = new Date(classification.startedAt || 0).getTime();
            return !Number.isFinite(startedAt) || Date.now() - startedAt > 5 * 60 * 1000;
        });
        if (pending.length > 0) setTimeout(() => this.emit('classifyAssets', pending.slice(0, 40)), 0);
    }

    async _updateAssetClassification(filePath, patch) {
        if (!window.flowCanvas?.asset?.updateMetadata) return;
        try {
            const result = await window.flowCanvas.asset.updateMetadata(filePath, patch);
            if (!result?.success) throw new Error(result?.error || '分类保存失败');
            this.applyAssetMetadata(filePath, result.metadata);
        } catch (error) {
            console.warn('[Sidebar] 素材分类保存失败:', error);
        }
    }

    _showAssetClassificationMenu(filePath, clientX, clientY) {
        document.querySelector('.asset-classification-menu')?.remove();
        const metadata = this._assetMetadata(filePath) || {};
        const explicitCategories = this._metadataValues(metadata.categories)
            .map(category => this._normalizeAssetCategory(category));
        const activeCategories = new Set(explicitCategories.length ? explicitCategories : this._assetCategories(filePath));
        const menu = document.createElement('div');
        menu.className = 'asset-classification-menu';
        menu.innerHTML = `
            <div class="asset-classification-menu-head"><span>素材分类</span><small>可多选</small></div>
            <button type="button" data-favorite class="asset-classification-favorite ${metadata.favorite ? 'active' : ''}">
                <svg class="flow-icon flow-icon-xs" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-favorite"></use></svg>
                <span>${metadata.favorite ? '取消收藏' : '加入收藏'}</span>
            </button>
            <div class="asset-classification-options">
                ${ASSET_CATEGORY_ORDER.map(category => `<button type="button" data-assign-category="${this._escapeHtml(category)}" class="${activeCategories.has(category) ? 'active' : ''}"><svg class="flow-icon flow-icon-xs" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-folder"></use></svg><span>${this._escapeHtml(category)}</span></button>`).join('')}
            </div>`;
        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8))}px`;

        menu.addEventListener('click', event => {
            const favoriteButton = event.target.closest('[data-favorite]');
            if (favoriteButton) {
                void this._updateAssetClassification(filePath, { favorite: metadata.favorite !== true });
                menu.remove();
                return;
            }
            const categoryButton = event.target.closest('[data-assign-category]');
            if (!categoryButton) return;
            const category = categoryButton.dataset.assignCategory;
            let categories = [...new Set(explicitCategories)];
            if (categories.length === 0 && category === 'Others') categories = ['Others'];
            else if (categories.includes(category)) categories = categories.filter(item => item !== category);
            else categories.push(category);
            void this._updateAssetClassification(filePath, {
                categories,
                classification: { manuallyUpdatedAt: new Date().toISOString() }
            });
            menu.remove();
        });

        const closeMenu = event => {
            if (menu.contains(event.target)) return;
            menu.remove();
            document.removeEventListener('pointerdown', closeMenu, true);
        };
        setTimeout(() => document.addEventListener('pointerdown', closeMenu, true), 0);
    }

    _dedupeAssetFiles(files = []) {
        const seen = new Set();
        return files
            .filter(Boolean)
            .filter(filePath => {
                const key = this._normalizePath(filePath);
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((left, right) => this._assetFileName(left).localeCompare(this._assetFileName(right), 'zh-CN'));
    }

    _renderAssetLibrarySources() {
        const select = this.dom.assetLibrarySourceSelect;
        if (!select) return;
        const folders = this.getAssetLibraryFolders();
        if (this.assetLibrarySource && !folders.some(folder =>
            this._normalizePath(folder) === this._normalizePath(this.assetLibrarySource))) {
            this.assetLibrarySource = '';
        }

        select.innerHTML = [
            '<option value="">全部来源</option>',
            ...folders.map(folder => {
                const label = this._isManagedAssetLibraryFolder(folder)
                    ? 'Flow Canvas 管理目录'
                    : this._assetFolderName(folder);
                const isDefault = this._normalizePath(folder)
                    === this._normalizePath(this.storeData.assetLibrary?.defaultFolder);
                return `<option value="${this._escapeHtml(folder)}">${this._escapeHtml(label)}${isDefault ? ' · 默认' : ''}</option>`;
            })
        ].join('');
        select.value = this.assetLibrarySource;

        const hasSource = Boolean(this.assetLibrarySource);
        const isManaged = this._isManagedAssetLibraryFolder(this.assetLibrarySource);
        if (this.dom.assetLibraryRemoveFolderBtn) {
            this.dom.assetLibraryRemoveFolderBtn.disabled = !hasSource || isManaged;
        }
        if (this.dom.assetLibraryDefaultFolderBtn) {
            const isDefault = hasSource && this._normalizePath(this.assetLibrarySource)
                === this._normalizePath(this.storeData.assetLibrary?.defaultFolder);
            this.dom.assetLibraryDefaultFolderBtn.disabled = !hasSource;
            this.dom.assetLibraryDefaultFolderBtn.classList.toggle('active', isDefault);
            this.dom.assetLibraryDefaultFolderBtn.title = isDefault
                ? '当前为网页采集默认目录'
                : '设为网页采集默认目录';
        }
    }

    async chooseAssetLibraryFolder(options = {}) {
        const folderPath = await window.flowCanvas?.folder?.select?.();
        if (!folderPath) return null;
        const folders = this.getAssetLibraryFolders();
        const existingFolder = folders.find(folder =>
            this._normalizePath(folder) === this._normalizePath(folderPath));
        const targetFolder = existingFolder || folderPath;
        if (!existingFolder) {
            this.storeData.assetLibrary.folders.push(folderPath);
            await this._restoreActiveGroupWatcherState();
        }
        if (options.makeDefault === true) this.storeData.assetLibrary.defaultFolder = targetFolder;
        this._saveStore();
        this.assetLibrarySource = targetFolder;
        this._renderAssetLibrarySources();
        await this._refreshAssetLibraryFiles();
        this._notifyAssetLibrarySettingsChanged();
        return targetFolder;
    }

    async _addAssetLibraryFolder() {
        return this.chooseAssetLibraryFolder();
    }

    async _removeAssetLibraryFolder() {
        const folderPath = this.assetLibrarySource;
        if (!folderPath || this._isManagedAssetLibraryFolder(folderPath)) return;
        this.storeData.assetLibrary.folders = (this.storeData.assetLibrary.folders || [])
            .filter(folder => this._normalizePath(folder) !== this._normalizePath(folderPath));
        if (this._normalizePath(this.storeData.assetLibrary.defaultFolder) === this._normalizePath(folderPath)) {
            this.storeData.assetLibrary.defaultFolder = this.assetLibraryManagedFolder || null;
        }
        this.assetLibrarySource = '';
        this._saveStore();
        await this._restoreActiveGroupWatcherState();
        this._renderAssetLibrarySources();
        await this._refreshAssetLibraryFiles();
        this._notifyAssetLibrarySettingsChanged();
    }

    setAssetLibraryDefaultFolder(folderPath) {
        const target = this.getAssetLibraryFolders().find(folder =>
            this._normalizePath(folder) === this._normalizePath(folderPath));
        if (!target) return false;
        this.storeData.assetLibrary.defaultFolder = target;
        this._saveStore();
        this._renderAssetLibrarySources();
        this._notifyAssetLibrarySettingsChanged();
        return true;
    }

    _setAssetLibraryDefaultFolder() {
        if (!this.assetLibrarySource) return false;
        return this.setAssetLibraryDefaultFolder(this.assetLibrarySource);
    }

    toggleAssetLibrary(force) {
        const panel = this.dom.assetLibraryPanel;
        if (!panel) return;
        const shouldOpen = typeof force === 'boolean' ? force : panel.hidden;
        panel.hidden = !shouldOpen;
        document.body.classList.toggle('asset-library-open', shouldOpen);
        this.dom.assetLibraryToggle?.classList.toggle('active', shouldOpen);
        this.dom.assetLibraryToggle?.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
        if (!shouldOpen) return;
        const nodeSearch = document.getElementById('canvasNodeSearch');
        if (nodeSearch) nodeSearch.hidden = true;
        document.getElementById('canvasToolSearch')?.classList.remove('active');
        this._renderAssetLibrarySources();
        void this._refreshAssetLibraryFiles();
    }

    async _refreshAssetLibraryFiles() {
        const runId = ++this._assetLibraryScanRunId;
        const folders = this.getAssetLibraryFolders();

        this.assetLibraryFiles = [];
        this.assetLibraryMetadata = new Map();
        this.assetLibraryLoading = Boolean(folders.length);
        this._renderAssetLibraryGrid();
        if (!folders.length || !window.flowCanvas?.folder?.scan) {
            await this._loadAssetMetadata(this.assetLibraryFiles);
            if (runId !== this._assetLibraryScanRunId) return;
            this.assetLibraryLoading = false;
            this._renderAssetLibraryGrid();
            this._queuePendingAssetClassifications();
            return;
        }

        const results = await Promise.all(folders.map(async folderPath => {
            try {
                const result = await window.flowCanvas.folder.scan(folderPath);
                return Array.isArray(result) ? result : (Array.isArray(result?.files) ? result.files : []);
            } catch (error) {
                console.warn('[Sidebar] 素材库目录读取失败:', folderPath, error);
                return [];
            }
        }));

        if (runId !== this._assetLibraryScanRunId) return;
        this.assetLibraryFiles = this._dedupeAssetFiles(results.flat());
        await this._loadAssetMetadata(this.assetLibraryFiles);
        if (runId !== this._assetLibraryScanRunId) return;
        this.assetLibraryLoading = false;
        this._renderAssetLibrarySources();
        this._renderAssetLibraryGrid();
        this._queuePendingAssetClassifications();
    }

    _activeAssetFilters() {
        const active = [...(this.dom.assetLibraryTypeFilters?.querySelectorAll('.filter-chip.active') || [])]
            .map(chip => chip.dataset.filter)
            .filter(Boolean);
        return active.length ? active : ['all'];
    }

    _filteredAssetFiles() {
        const query = this.assetLibraryQuery.trim().toLocaleLowerCase('zh-CN');
        const filters = this._activeAssetFilters();
        return this.assetLibraryFiles.filter(filePath => {
            if (this.assetLibrarySource && !this._isPathInsideFolder(filePath, this.assetLibrarySource)) return false;
            const type = this._assetFileType(filePath);
            if (!filters.includes('all') && !filters.includes(type)) return false;
            if (this.assetLibraryCategory === '__favorite__' && this._assetMetadata(filePath)?.favorite !== true) return false;
            if (this.assetLibraryCategory && this.assetLibraryCategory !== '__favorite__'
                && !this._assetCategories(filePath).includes(this.assetLibraryCategory)) return false;
            if (!query) return true;
            return `${this._assetFileName(filePath)} ${filePath} ${this._assetSearchMetadata(filePath)}`
                .toLocaleLowerCase('zh-CN').includes(query);
        });
    }

    _updateAssetFilterCounts() {
        if (!this.dom.assetLibraryTypeFilters) return;
        const sourceFiles = this.assetLibraryFiles.filter(filePath =>
            !this.assetLibrarySource || this._isPathInsideFolder(filePath, this.assetLibrarySource)
        );
        const counts = { all: sourceFiles.length, image: 0, video: 0, audio: 0, document: 0, other: 0 };
        sourceFiles.forEach(filePath => {
            const type = this._assetFileType(filePath);
            counts[type] = (counts[type] || 0) + 1;
        });
        this.dom.assetLibraryTypeFilters.querySelectorAll('[data-filter-count]').forEach(counter => {
            counter.textContent = String(counts[counter.dataset.filterCount] || 0);
        });
    }

    _renderAssetCategoryFilters() {
        const host = this.dom.assetCategoryFilters;
        if (!host) return;
        const counts = new Map();
        let sourceTotal = 0;
        let favoriteTotal = 0;
        this.assetLibraryFiles.forEach(filePath => {
            if (this.assetLibrarySource && !this._isPathInsideFolder(filePath, this.assetLibrarySource)) return;
            sourceTotal += 1;
            if (this._assetMetadata(filePath)?.favorite === true) favoriteTotal += 1;
            this._assetCategories(filePath).forEach(category => counts.set(category, (counts.get(category) || 0) + 1));
        });
        if (this.assetLibraryCategory && this.assetLibraryCategory !== '__favorite__'
            && !ASSET_CATEGORY_ORDER.includes(this.assetLibraryCategory)) this.assetLibraryCategory = '';
        host.hidden = false;
        host.innerHTML = [
            '<div class="asset-category-heading"><span>分类</span><small>内容目录</small></div>',
            `<button class="asset-category-chip asset-category-all ${this.assetLibraryCategory ? '' : 'active'}" type="button" data-category=""><svg class="flow-icon flow-icon-xs" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-grid"></use></svg><span>全部分类</span><b>${sourceTotal}</b></button>`,
            `<button class="asset-category-chip ${this.assetLibraryCategory === '__favorite__' ? 'active' : ''}" type="button" data-category="__favorite__"><svg class="flow-icon flow-icon-xs" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-favorite"></use></svg><span>收藏</span><b>${favoriteTotal}</b></button>`,
            ...ASSET_CATEGORY_ORDER.map(category => `<button class="asset-category-chip ${this.assetLibraryCategory === category ? 'active' : ''}" type="button" data-category="${this._escapeHtml(category)}"><svg class="flow-icon flow-icon-xs" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-folder"></use></svg><span>${this._escapeHtml(category)}</span><b>${counts.get(category) || 0}</b></button>`)
        ].join('');
    }

    _renderAssetLibraryGrid() {
        const grid = this.dom.assetLibraryGrid;
        if (!grid) return;

        this._assetThumbnailObserver?.disconnect();
        this._assetThumbnailObserver = null;
        this._updateAssetFilterCounts();
        this._renderAssetCategoryFilters();

        const files = this._filteredAssetFiles();
        const visibleFiles = files.slice(0, 240);
        const boardPaths = new Set((this.storeData.items || [])
            .map(item => this._normalizePath(item?.filePath))
            .filter(Boolean));

        const activeFolder = this.getAssetLibraryFolders()
            .find(folder => this._normalizePath(folder) === this._normalizePath(this.assetLibrarySource));
        if (this.dom.assetLibraryScope) {
            this.dom.assetLibraryScope.textContent = activeFolder ? this._assetFolderName(activeFolder) : '全部素材';
        }
        if (this.dom.assetLibraryResultCount) {
            this.dom.assetLibraryResultCount.textContent = this.assetLibraryLoading
                ? `${files.length} · 读取中`
                : (files.length > visibleFiles.length ? `${visibleFiles.length}/${files.length}` : String(files.length));
        }

        if (!this.getAssetLibraryFolders().length && files.length === 0) {
            grid.innerHTML = `<button class="asset-library-empty asset-library-empty-action" type="button" data-add-library-folder><svg class="flow-icon flow-icon-lg" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-folder"></use></svg><span>添加本地文件夹</span></button>`;
            return;
        }
        if (visibleFiles.length === 0) {
            grid.innerHTML = `<div class="asset-library-empty"><svg class="flow-icon flow-icon-lg" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-search"></use></svg><span>${this.assetLibraryLoading ? '正在读取素材' : '没有匹配的素材'}</span></div>`;
            return;
        }

        grid.innerHTML = visibleFiles.map(filePath => {
            const type = this._assetFileType(filePath);
            const fileName = this._assetFileName(filePath);
            const metadata = this._assetMetadata(filePath);
            const categories = this._assetCategories(filePath).slice(0, 2);
            const classificationStatus = metadata?.classification?.status || '';
            const extension = fileName.includes('.') ? fileName.split('.').pop().toUpperCase() : this._assetTypeLabel(type);
            const onCanvas = boardPaths.has(this._normalizePath(filePath));
            const preview = type === 'image'
                ? `<div class="asset-library-card-preview asset-kind-image"><img data-asset-thumbnail alt="" draggable="false"><svg class="flow-icon flow-icon-lg asset-library-card-fallback" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-image"></use></svg></div>`
                : `<div class="asset-library-card-preview asset-kind-${type}"><svg class="flow-icon flow-icon-lg" aria-hidden="true"><use href="./icons/flow-icons.svg#${this._assetTypeIcon(type)}"></use></svg><span>${this._escapeHtml(extension)}</span></div>`;
            return `
                <article class="asset-library-card ${onCanvas ? 'is-on-canvas' : ''} ${metadata?.favorite ? 'is-favorite' : ''} ${classificationStatus ? `classification-${this._escapeHtml(classificationStatus)}` : ''}" draggable="true"
                    data-asset-path="${this._escapeHtml(filePath)}" title="${this._escapeHtml(metadata?.summary || filePath)}">
                    ${preview}
                    <div class="asset-library-card-meta">
                        <span class="asset-library-card-name">${this._escapeHtml(fileName)}</span>
                        ${metadata?.favorite ? '<svg class="flow-icon flow-icon-xs asset-library-favorite" aria-label="已收藏"><use href="./icons/flow-icons.svg#icon-favorite"></use></svg>' : ''}
                        <i class="asset-library-canvas-state" title="${onCanvas ? '已在画布' : '未放入画布'}" aria-hidden="true"></i>
                    </div>
                    ${categories.length || ['pending', 'running', 'failed'].includes(classificationStatus) ? `<div class="asset-library-card-tags">
                        ${categories.map(category => `<span>${this._escapeHtml(category)}</span>`).join('')}
                        ${['pending', 'running'].includes(classificationStatus) ? '<i title="等待智能分类">分类中</i>' : ''}
                        ${classificationStatus === 'failed' ? '<i class="is-error" title="智能分类失败">失败</i>' : ''}
                    </div>` : ''}
                </article>`;
        }).join('');

        if (!window.IntersectionObserver || !window.flowCanvas?.thumb?.get) return;
        this._assetThumbnailObserver = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) return;
                const image = entry.target;
                this._assetThumbnailObserver?.unobserve(image);
                const card = image.closest('.asset-library-card');
                const filePath = card?.dataset.assetPath;
                if (!filePath) return;
                window.flowCanvas.thumb.get(filePath, 220).then(dataUrl => {
                    if (!dataUrl || !image.isConnected) return;
                    image.src = dataUrl;
                    image.classList.add('is-loaded');
                }).catch(() => {});
            });
        }, { root: grid, rootMargin: '100px' });
        grid.querySelectorAll('[data-asset-thumbnail]').forEach(image => this._assetThumbnailObserver.observe(image));
    }

    _collectAllFolders() {
        return (this.storeData.folderGroups || []).flatMap(group => group.folders || []);
    }

    async _restoreActiveGroupWatcherState() {
        if (!window.flowCanvas?.folder?.syncWatches) return;
        const syncRunId = ++this._watcherSyncRunId;
        const libraryFolders = this.getAssetLibraryFolders();
        const activeFolders = this._dedupePaths([
            ...this.getActiveWatchFolders(),
            ...libraryFolders
        ]);
        const knownFolders = [
            ...(this.storeData.watchFolders || []),
            ...this._collectAllFolders(),
            ...libraryFolders
        ];

        await window.flowCanvas.folder.syncWatches(activeFolders, knownFolders);
        if (syncRunId !== this._watcherSyncRunId) return;
    }

    _migrateGroupDefaults() {
        const groups = this.storeData.folderGroups || [];
        groups.forEach(group => this._ensureGroupDefaultFolder(group));

        const legacyDefault = this.storeData.defaultSaveFolder;
        if (legacyDefault) {
            const legacyGroup = groups.find(group => (group.folders || []).includes(legacyDefault));
            if (legacyGroup) {
                legacyGroup.defaultSaveFolder = legacyDefault;
            }
            delete this.storeData.defaultSaveFolder;
        }
    }

    _ensureGroupDefaultFolder(group) {
        if (!group) return null;
        const folders = group.folders || [];
        if (folders.length === 0) {
            group.defaultSaveFolder = null;
            if (this.getActiveGroup?.()?.id === group.id) {
                this.storeData.activeGroupDefaultSaveFolder = null;
            }
            return null;
        }

        if (!group.defaultSaveFolder || !folders.includes(group.defaultSaveFolder)) {
            group.defaultSaveFolder = folders[0];
        }

        if (this.getActiveGroup?.()?.id === group.id) {
            this.storeData.activeGroupDefaultSaveFolder = group.defaultSaveFolder;
        }

        return group.defaultSaveFolder;
    }

    getActiveDefaultSaveFolder() {
        return this._ensureGroupDefaultFolder(this.getActiveGroup());
    }

    async _initAlwaysOnTop() {
        if (window.flowCanvas && window.flowCanvas.win) {
            const isOnTop = await window.flowCanvas.win.getAlwaysOnTop();
            this._updatePinButton(isOnTop);
        }
    }

    _updatePinButton(isOnTop) {
        if (this.dom.alwaysOnTopBtn) {
            this.dom.alwaysOnTopBtn.classList.toggle('active', isOnTop);
        }
        if (this.dom.alwaysOnTopLabel) {
            this.dom.alwaysOnTopLabel.textContent = isOnTop ? '取消置顶' : '置顶窗口';
        }
    }

    /**
     * 渲染节点面板：每个 NODE_TYPES 条目一个按钮。
     * 点击 → addNode 事件；拖到画布 → canvas.js 的 drop 处理接管。
     */
    _bindNodePalette() {
        const host = this.dom.nodePalette;
        if (!host) return;

        host.innerHTML = '';
        Object.values(NODE_TYPES).forEach(def => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'node-palette-item';
            btn.draggable = true;
            btn.dataset.nodeType = def.type;
            btn.title = `${def.title} — 点击添加，或拖到画布指定位置`;
            btn.innerHTML =
                `${nodeIconSvg(def.type, 16)}<span class="node-palette-label">${def.title}</span>`;

            btn.addEventListener('click', () => this.emit('addOpNode', def.type));
            btn.addEventListener('dragstart', e => {
                e.dataTransfer.setData('application/x-flow-node', def.type);
                e.dataTransfer.effectAllowed = 'copy';
            });
            host.appendChild(btn);
        });
    }

    on(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
    }

    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(cb => cb(data));
        }
    }

    bindEvents() {
        const setSidebarClosed = (isClosed) => {
            document.body.classList.toggle('sidebar-closed', isClosed);
            if (!isClosed) this.toggleAssetLibrary(false);
            this.storeData.sidebarClosed = isClosed;
            if (window.flowCanvas && window.flowCanvas.store) {
                window.flowCanvas.store.save(this.storeData);
            }
            setTimeout(() => {
                const event = new Event('resize');
                window.dispatchEvent(event);
            }, 300);
        };
        const toggleSidebar = () => {
            setSidebarClosed(!document.body.classList.contains('sidebar-closed'));
        };

        document.addEventListener('open-folder-groups', () => setSidebarClosed(false));
        document.addEventListener('close-asset-library', () => this.toggleAssetLibrary(false));
        document.addEventListener('show-asset-classification-menu', event => {
            const { filePath, clientX, clientY } = event.detail || {};
            if (!filePath) return;
            this._showAssetClassificationMenu(filePath, Number(clientX) || 12, Number(clientY) || 12);
        });

        if (this.dom.collapseBtn) {
            this.dom.collapseBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleSidebar();
            });
        }

        if (this.dom.sidebar) {
            this.dom.sidebar.addEventListener('click', (e) => {
                if (document.body.classList.contains('sidebar-closed')) {
                    toggleSidebar();
                }
            });
        }

        this.dom.assetLibraryToggle?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            this.toggleAssetLibrary();
        });
        this.dom.assetLibraryCloseBtn?.addEventListener('click', () => this.toggleAssetLibrary(false));
        this.dom.assetLibraryAddFolderBtn?.addEventListener('click', () => void this._addAssetLibraryFolder());
        this.dom.assetLibraryRemoveFolderBtn?.addEventListener('click', () => void this._removeAssetLibraryFolder());
        this.dom.assetLibraryDefaultFolderBtn?.addEventListener('click', () => this._setAssetLibraryDefaultFolder());
        this.dom.assetLibrarySourceSelect?.addEventListener('change', event => {
            this.assetLibrarySource = event.target.value || '';
            this._renderAssetLibrarySources();
            this._renderAssetLibraryGrid();
        });
        document.addEventListener('mousedown', event => {
            if (this.dom.assetLibraryPanel?.hidden) return;
            if (this.dom.assetLibraryPanel.contains(event.target) || this.dom.assetLibraryToggle?.contains(event.target)) return;
            if (event.target.closest('.asset-classification-menu')) return;
            this.toggleAssetLibrary(false);
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && !this.dom.assetLibraryPanel?.hidden) this.toggleAssetLibrary(false);
        });

        // ── 新建文件夹组 ──
        if (this.dom.addGroupBtn) {
            this.dom.addGroupBtn.addEventListener('click', () => {
                this._createNewGroup();
            });
        }

        // ── 文件夹组列表事件委托 ──
        this._clickTimer = null; // 用于区分单击/双击
        if (this.dom.folderGroupList) {
            this.dom.folderGroupList.addEventListener('click', async (e) => {
                // 点击删除组
                if (e.target.closest('.group-remove')) {
                    e.stopPropagation();
                    const groupItem = e.target.closest('.folder-group-item');
                    if (groupItem) this._removeGroup(groupItem.dataset.groupId);
                    return;
                }

                // 点击添加文件夹 (+ 按钮)
                if (e.target.closest('.add-folder-btn')) {
                    e.stopPropagation();
                    const groupItem = e.target.closest('.folder-group-item');
                    if (groupItem) this._handleAddFolder(groupItem.dataset.groupId);
                    return;
                }

                // 点击删除文件夹
                if (e.target.closest('.folder-remove')) {
                    e.stopPropagation();
                    const path = e.target.closest('.folder-remove').dataset.path;
                    const groupItem = e.target.closest('.folder-group-item');
                    if (groupItem) this._removeFolder(groupItem.dataset.groupId, path);
                    return;
                }

                // 左键点击文件夹本体，但不要拦截右键或其它点击
                const clickedFolderItem = e.target.closest('.folder-item');
                if (clickedFolderItem) {
                    const groupItem = clickedFolderItem.closest('.folder-group-item');
                    if (this.pendingMove && groupItem?.dataset.groupId === this.storeData.activeGroupId) {
                        e.stopPropagation();
                        const folderPath = clickedFolderItem.dataset.path || clickedFolderItem.querySelector('.folder-remove')?.dataset.path;
                        if (folderPath) this._completeMoveTarget(folderPath);
                    }
                    return;
                }

                // 选中或展开折叠组 (点击 header)，延迟执行以避免与双击冲突
                const groupHeader = e.target.closest('.group-header');
                if (groupHeader) {
                    const groupItem = groupHeader.closest('.folder-group-item');
                    if (groupItem) {
                        if (this._clickTimer) clearTimeout(this._clickTimer);
                        this._clickTimer = setTimeout(() => {
                            this._activateGroup(groupItem.dataset.groupId);
                        }, 250);
                    }
                }
            });

            // 右键菜单（组头部 → 重命名/删除；文件夹 → 设为默认/取消关联）
            this.dom.folderGroupList.addEventListener('contextmenu', async (e) => {
                // 右键文件夹
                const folderItem = e.target.closest('.folder-item');
                if (folderItem) {
                    e.preventDefault();
                    const path = folderItem.querySelector('.folder-remove').dataset.path;
                    const groupItem = folderItem.closest('.folder-group-item');
                    if (!groupItem || groupItem.dataset.groupId !== this.storeData.activeGroupId) return;
                    const action = await window.flowCanvas.folder.showContextMenu(path);
                    if (action === 'setDefault') {
                        const activeGroup = this.getActiveGroup();
                        if (activeGroup && activeGroup.folders.includes(path)) {
                            activeGroup.defaultSaveFolder = path;
                        }
                        this.renderGroups();
                        this._saveStore();
                    } else if (action === 'remove') {
                        if (groupItem) this._removeFolder(groupItem.dataset.groupId, path);
                    }
                    return;
                }

                // 右键组头部 → 显示重命名/删除菜单
                const groupHeader = e.target.closest('.group-header');
                if (groupHeader) {
                    e.preventDefault();
                    const groupItem = groupHeader.closest('.folder-group-item');
                    if (!groupItem) return;
                    const groupId = groupItem.dataset.groupId;
                    this._showGroupContextMenu(groupId, groupHeader);
                }
            });

            // 双击重命名（取消单击延迟的激活，直接进入重命名）
            this.dom.folderGroupList.addEventListener('dblclick', (e) => {
                if (this._clickTimer) { clearTimeout(this._clickTimer); this._clickTimer = null; }
                const nameEl = e.target.closest('.group-name');
                if (!nameEl) return;
                const groupItem = nameEl.closest('.folder-group-item');
                if (!groupItem) return;
                this._startRenameGroup(groupItem.dataset.groupId, nameEl);
            });
        }

        // 大的占位按钮 (全部为空时)
        if (this.dom.emptyAddBtn) this.dom.emptyAddBtn.addEventListener('click', () => {
            if (this.storeData.folderGroups.length === 0) {
                this._createNewGroup();
                // 等待 UI 渲染再触发添加到第一个组
                setTimeout(() => {
                    const firstGroup = this.storeData.folderGroups[0];
                    if (firstGroup) this._handleAddFolder(firstGroup.id);
                }, 100);
            } else {
                const activeGroup = this.getActiveGroup();
                if (activeGroup) this._handleAddFolder(activeGroup.id);
            }
        });

        // 过滤器（多选模式）
        if (this.dom.filterChips) this.dom.filterChips.addEventListener('click', (e) => {
            const chip = e.target.closest('.filter-chip');
            if (chip) {
                const clickedFilter = chip.dataset.filter;

                if (clickedFilter === 'all') {
                    this.dom.filterChips.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                    chip.classList.add('active');
                } else {
                    const allChip = this.dom.filterChips.querySelector('[data-filter="all"]');
                    if (allChip) allChip.classList.remove('active');
                    chip.classList.toggle('active');

                    const activeChips = this.dom.filterChips.querySelectorAll('.filter-chip.active');
                    if (activeChips.length === 0 && allChip) {
                        allChip.classList.add('active');
                    }
                }

                const activeFilters = [];
                this.dom.filterChips.querySelectorAll('.filter-chip.active').forEach(c => {
                    activeFilters.push(c.dataset.filter);
                });
                this.emit('filter', activeFilters);
            }
        });

        if (this.dom.assetLibraryTypeFilters) this.dom.assetLibraryTypeFilters.addEventListener('click', event => {
            const chip = event.target.closest('.filter-chip');
            if (!chip) return;
            const allChip = this.dom.assetLibraryTypeFilters.querySelector('[data-filter="all"]');
            if (chip.dataset.filter === 'all') {
                this.dom.assetLibraryTypeFilters.querySelectorAll('.filter-chip')
                    .forEach(item => item.classList.remove('active'));
                chip.classList.add('active');
            } else {
                allChip?.classList.remove('active');
                chip.classList.toggle('active');
                if (!this.dom.assetLibraryTypeFilters.querySelector('.filter-chip.active')) {
                    allChip?.classList.add('active');
                }
            }
            this._renderAssetLibraryGrid();
        });

        if (this.dom.assetCategoryFilters) {
            this.dom.assetCategoryFilters.addEventListener('click', event => {
                const chip = event.target.closest('[data-category]');
                if (!chip) return;
                this.assetLibraryCategory = chip.dataset.category || '';
                this._renderAssetLibraryGrid();
            });
        }

        if (this.dom.assetLibrarySearch) {
            this.dom.assetLibrarySearch.addEventListener('input', () => {
                this.assetLibraryQuery = this.dom.assetLibrarySearch.value || '';
                this.dom.assetLibrarySearch.closest('.asset-library-search')?.classList.toggle(
                    'has-value',
                    Boolean(this.assetLibraryQuery)
                );
                this._renderAssetLibraryGrid();
            });
        }
        if (this.dom.assetLibrarySearchClear) {
            this.dom.assetLibrarySearchClear.addEventListener('click', () => {
                if (!this.dom.assetLibrarySearch) return;
                this.dom.assetLibrarySearch.value = '';
                this.dom.assetLibrarySearch.dispatchEvent(new Event('input'));
                this.dom.assetLibrarySearch.focus();
            });
        }
        if (this.dom.assetLibraryGrid) {
            this.dom.assetLibraryGrid.addEventListener('click', event => {
                if (event.target.closest('[data-add-library-folder]')) {
                    void this._addAssetLibraryFolder();
                    return;
                }
                const card = event.target.closest('.asset-library-card');
                if (!card?.dataset.assetPath) return;
                this.emit('revealAsset', { filePath: card.dataset.assetPath });
            });
            this.dom.assetLibraryGrid.addEventListener('dragstart', event => {
                const card = event.target.closest('.asset-library-card');
                if (!card?.dataset.assetPath || !event.dataTransfer) return;
                event.dataTransfer.setData('application/x-flow-asset', card.dataset.assetPath);
                event.dataTransfer.effectAllowed = 'copy';
            });
            this.dom.assetLibraryGrid.addEventListener('contextmenu', event => {
                const card = event.target.closest('.asset-library-card');
                if (!card?.dataset.assetPath) return;
                event.preventDefault();
                this._showAssetClassificationMenu(card.dataset.assetPath, event.clientX, event.clientY);
            });
        }

        // 置顶窗口
        if (this.dom.alwaysOnTopBtn) {
            this.dom.alwaysOnTopBtn.addEventListener('click', async () => {
                const isCurrentlyOnTop = this.dom.alwaysOnTopBtn.classList.contains('active');
                const newState = await window.flowCanvas.win.setAlwaysOnTop(!isCurrentlyOnTop);
                this._updatePinButton(newState);
            });
        }

        // 画布控制
        if (this.dom.fitAllBtn) {
            this.dom.fitAllBtn.addEventListener('click', () => this.emit('fitAll'));
        }
        if (this.dom.packLayoutBtn) {
            this.dom.packLayoutBtn.addEventListener('click', () => this.emit('packLayout'));
        }
        if (this.dom.seamlessLayoutBtn) {
            this.dom.seamlessLayoutBtn.addEventListener('click', () => this.emit('seamlessLayout'));
        }
        this._bindNodePalette();
        if (this.dom.newPlanBtn) {
            this.dom.newPlanBtn.addEventListener('click', () => this.emit('newPlan'));
        }
        if (this.dom.exportMdBtn) {
            this.dom.exportMdBtn.addEventListener('click', () => this.emit('exportMd'));
        }
        if (this.dom.resourceSaverBtn) {
            this.dom.resourceSaverBtn.addEventListener('click', () => {
                const enabled = !this.dom.resourceSaverBtn.classList.contains('active');
                this.storeData.resourceSaver = enabled;
                this._updateResourceSaverButton(enabled);
                this._saveStore();
                this.emit('resourceSaverChange', enabled);
            });
        }
    }

    _updateResourceSaverButton(enabled) {
        if (this.dom.resourceSaverBtn) {
            this.dom.resourceSaverBtn.classList.toggle('active', enabled);
            this.dom.resourceSaverBtn.setAttribute('aria-checked', enabled ? 'true' : 'false');
        }
        if (this.dom.resourceSaverState) {
            this.dom.resourceSaverState.textContent = enabled ? '开启' : '关闭';
        }
    }

    // ── 核心操作 ──

    _createNewGroup() {
        const count = this.storeData.folderGroups.length;
        const group = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 4),
            name: `文件夹组 ${count + 1}`,
            folders: [],
            defaultSaveFolder: null,
            removedFromBoardPaths: [],
            removedFromBoardPathsInitialized: true
        };
        group.plans = [];
        this.storeData.folderGroups.push(group);
        this._activateGroup(group.id);
        this._saveStore();
    }

    async _handleAddFolder(groupId) {
        const targetGroup = this.storeData.folderGroups.find(g => g.id === groupId);
        if (!targetGroup) return;

        const folderPath = await window.flowCanvas.folder.select();
        if (folderPath && !targetGroup.folders.includes(folderPath)) {
            targetGroup.folders.push(folderPath);
            this._ensureGroupDefaultFolder(targetGroup);

            // 如果当前组是激活组，同步 watchFolders
            if (this.storeData.activeGroupId === groupId) {
                this._syncWatchFolders();
                await window.flowCanvas.folder.watch(folderPath);
                document.body.classList.add('has-folders');

                // 首次扫描文件
                const scanResult = await window.flowCanvas.folder.scan(folderPath);
                const files = Array.isArray(scanResult) ? scanResult : scanResult?.files;
                const scanSucceeded = Array.isArray(scanResult) || scanResult?.success === true;
                const canApplyScanResult =
                    scanSucceeded &&
                    this.storeData.activeGroupId === groupId &&
                    targetGroup.folders.includes(folderPath);
                if (canApplyScanResult && files && files.length > 0) {
                    console.log(`[Sidebar] Found ${files.length} files in ${folderPath}`);
                    this.emit('scanFiles', files);
                }
            }

            this.renderGroups();
            this._saveStore();
        }
    }

    async _removeFolder(groupId, path) {
        const group = this.storeData.folderGroups.find(g => g.id === groupId);
        if (!group) return;

        group.folders = group.folders.filter(p => p !== path);
        this._ensureGroupDefaultFolder(group);

        // 如果移除的是当前激活组内的文件夹
        if (this.storeData.activeGroupId === groupId) {
            this._syncWatchFolders();

            // 同时移除画布上该路径对应的 item
            const removedItems = this.storeData.items.filter(i => this._isPathInsideFolder(i.filePath, path));
            this.storeData.items = this.storeData.items.filter(i => !this._isPathInsideFolder(i.filePath, path));
            removedItems.forEach(i => {
                const ev = new CustomEvent('context-remove', {
                    detail: { filePath: i.filePath, suppressAutoRestore: false }
                });
                document.dispatchEvent(ev);
            });

            if (this.getActiveWatchFolders().length === 0) {
                document.body.classList.remove('has-folders');
            }
        }

        this.renderGroups();
        this._saveStore();
        if (this.storeData.activeGroupId === groupId) void this._restoreActiveGroupWatcherState();
    }

    _removeGroup(groupId) {
        const group = this.storeData.folderGroups.find(g => g.id === groupId);
        if (!group) return;

        this.storeData.folderGroups = this.storeData.folderGroups.filter(g => g.id !== groupId);

        if (this.storeData.activeGroupId === groupId) {
            if (this.storeData.folderGroups.length > 0) {
                this._activateGroup(this.storeData.folderGroups[0].id);
            } else {
                this.storeData.activeGroupId = null;
                this.storeData.watchFolders = [];
                this.storeData.items = [];
                this.storeData.connections = [];
                this.storeData.viewport = { x: 0, y: 0, scale: 1 };
                this.renderGroups();
                this.emit('switchGroup', {
                    folders: [],
                    items: [],
                    connections: [],
                    viewport: this.storeData.viewport,
                    plans: []
                });
                void this._restoreActiveGroupWatcherState();
            }
        } else {
            this._syncWatchFolders();
            void this._restoreActiveGroupWatcherState();
            this.renderGroups();
        }

        this._saveStore();
    }

    _activateGroup(groupId) {
        const oldGroup = this.getActiveGroup();

        if (oldGroup && oldGroup.id !== groupId) {
            // 保存旧组的数据
            oldGroup.savedItems = [...(this.storeData.items || [])];
            oldGroup.savedViewport = this.storeData.viewport ? { ...this.storeData.viewport } : null;
            oldGroup.connections = [...(this.storeData.connections || [])];
            if (!Array.isArray(oldGroup.plans)) oldGroup.plans = [];

        }

        // 切换 ID
        this.storeData.activeGroupId = groupId;
        const newGroup = this.getActiveGroup();
        if (!newGroup) return;
        this._acknowledgeGroupTaskState(groupId);
        this._ensureGroupDefaultFolder(newGroup);

        if (oldGroup && oldGroup.id !== groupId) {
            this.storeData.items = newGroup.savedItems || [];
            this.storeData.connections = [...(newGroup.connections || [])];
            this.storeData.watchFolders = [...newGroup.folders];
            this.storeData.activeGroupDefaultSaveFolder = newGroup.defaultSaveFolder || null;
            this.storeData.viewport = newGroup.savedViewport
                ? { ...newGroup.savedViewport }
                : { x: 0, y: 0, scale: 1 };

            // 监听新组文件夹
            void this._restoreActiveGroupWatcherState();

            this.emit('switchGroup', {
                folders: [...(newGroup.folders || [])],
                items: [...(this.storeData.items || [])],
                connections: [...(this.storeData.connections || [])],
                viewport: this.storeData.viewport ? { ...this.storeData.viewport } : null,
                plans: [...(newGroup.plans || [])]
            });
        }

        if (newGroup.folders.length > 0) {
            document.body.classList.add('has-folders');
        } else {
            document.body.classList.remove('has-folders');
        }

        this.renderGroups();
        this._saveStore();
    }

    _startRenameGroup(groupId, nameEl) {
        const group = this.storeData.folderGroups.find(g => g.id === groupId);
        if (!group) return;

        // 如果传入的不是 DOM 元素（来自右键菜单），则手动查找
        if (!nameEl || !nameEl.parentNode) {
            const groupItem = this.dom.folderGroupList.querySelector(`[data-group-id="${groupId}"]`);
            if (!groupItem) return;
            nameEl = groupItem.querySelector('.group-name');
            if (!nameEl) return;
        }

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'group-rename-input';
        input.value = group.name;
        nameEl.replaceWith(input);
        input.focus();
        input.select();

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            const newName = input.value.trim() || group.name;
            group.name = newName;
            this.renderGroups();
            this._saveStore();
        };

        input.addEventListener('blur', finish);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { input.value = group.name; input.blur(); }
        });
        // 阻止事件冒泡到 group header，避免触发激活
        input.addEventListener('click', (e) => e.stopPropagation());
    }

    // ── 组右键菜单（纯 DOM 方式，不依赖 Electron 原生菜单） ──
    beginMoveToFolder(payload) {
        const group = this.getActiveGroup();
        if (!group || !group.folders || group.folders.length === 0) {
            this._showMoveHint('当前文件夹组没有可用文件夹');
            return;
        }

        this.pendingMove = {
            itemIds: payload.itemIds || [],
            filePaths: payload.filePaths || [],
            mode: payload.mode === 'copy' ? 'copy' : 'move'
        };
        document.body.classList.remove('sidebar-closed');
        document.body.classList.add('folder-move-pending');
        this.renderGroups();
        this._expandActiveGroup();
        this._showMoveHint(this.pendingMove.mode === 'copy'
            ? '点击当前文件夹组里的目标文件夹复制'
            : '点击当前文件夹组里的目标文件夹剪切');
    }

    cancelMoveToFolder() {
        this.pendingMove = null;
        document.body.classList.remove('folder-move-pending');
        this.renderGroups();
    }

    _completeMoveTarget(targetFolder) {
        if (!this.pendingMove) return;
        const activeGroup = this.getActiveGroup();
        if (!activeGroup || !activeGroup.folders.includes(targetFolder)) {
            this._showMoveHint('只能移动到当前文件夹组中的文件夹');
            return;
        }

        const payload = {
            ...this.pendingMove,
            targetFolder
        };
        const mode = this.pendingMove.mode;
        this.cancelMoveToFolder();
        this.emit(mode === 'copy' ? 'copyToFolder' : 'moveToFolder', payload);
    }

    _expandActiveGroup() {
        const activeEl = this.dom.folderGroupList?.querySelector('.folder-group-item.active .folder-accordion-content');
        if (activeEl) {
            gsap.to(activeEl, {
                height: 'auto',
                duration: 0.25,
                ease: 'power2.out',
                overwrite: 'auto'
            });
        }
    }

    _showMoveHint(text) {
        const status = document.getElementById('titlebarStatus');
        if (!status) return;
        status.textContent = text;
        status.classList.add('status-visible');
        clearTimeout(this.moveHintTimer);
        this.moveHintTimer = setTimeout(() => {
            if (status.textContent === text) {
                status.textContent = '';
                status.classList.remove('status-visible');
            }
        }, 2600);
    }

    _showGroupContextMenu(groupId, anchorEl) {
        // 移除已有菜单
        document.querySelectorAll('.group-ctx-menu').forEach(m => m.remove());

        const menu = document.createElement('div');
        menu.className = 'group-ctx-menu';

        const renameBtn = document.createElement('div');
        renameBtn.className = 'group-ctx-item';
        renameBtn.textContent = '重命名';
        renameBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            this._startRenameGroup(groupId);
        });

        const deleteBtn = document.createElement('div');
        deleteBtn.className = 'group-ctx-item group-ctx-danger';
        deleteBtn.textContent = '删除组';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.remove();
            this._removeGroup(groupId);
        });

        menu.appendChild(renameBtn);
        menu.appendChild(deleteBtn);

        // 定位到锚点元素附近
        const rect = anchorEl.getBoundingClientRect();
        menu.style.position = 'fixed';
        menu.style.left = `${rect.left + 20}px`;
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.zIndex = '9999';

        document.body.appendChild(menu);

        // 点其他地方关闭
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('mousedown', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('mousedown', closeMenu), 0);
    }

    _syncWatchFolders() {
        const activeGroup = this.getActiveGroup();
        this.storeData.watchFolders = activeGroup ? [...activeGroup.folders] : [];
        this.storeData.activeGroupDefaultSaveFolder = activeGroup ? this._ensureGroupDefaultFolder(activeGroup) : null;
    }

    _saveStore() {
        if (window.flowCanvas && window.flowCanvas.store) {
            window.flowCanvas.store.save(this.storeData);
        }
    }

    // ── 渲染与动画 ──

    renderGroups() {
        const groups = this.storeData.folderGroups || [];
        const activeId = this.storeData.activeGroupId;

        if (groups.length === 0) {
            this.dom.folderGroupList.innerHTML = '<div class="empty-hint" style="margin-top:20px;">点击右上角 + 新建文件夹组<br>每组独立管理文件</div>';
            document.body.classList.remove('has-folders');
            return;
        }

        this.dom.folderGroupList.innerHTML = groups.map(group => {
            const isActive = group.id === activeId;
            const folders = group.folders || [];
            const defaultFolder = this._ensureGroupDefaultFolder(group);
            const safeGroupId = this._escapeHtml(group.id);
            const safeGroupName = this._escapeHtml(group.name);

            const folderHtml = folders.length === 0
                ? '<div class="empty-hint" style="text-align:left; padding-left:12px;">空空如也，点击下方添加</div>'
                : folders.map(folder => {
                    const isDefault = folder === defaultFolder;
                    const safeFolder = this._escapeHtml(folder);
                    return `
                        <div class="folder-item ${isDefault ? 'is-default' : ''}" data-path="${safeFolder}" title="${safeFolder}">
                            <span class="folder-path">${safeFolder}</span>
                            <button class="folder-remove" type="button" data-path="${safeFolder}" title="取消关联" aria-label="取消关联">
                                <svg class="flow-icon flow-icon-xs" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-close"></use></svg>
                            </button>
                        </div>`;
                }).join('');

            return `
            <div class="folder-group-item ${isActive ? 'active' : ''}" data-group-id="${safeGroupId}">
                <div class="group-header" title="单击切换文件夹组，双击重命名">
                    <i class="group-task-status" aria-hidden="true"></i>
                    <svg class="flow-icon flow-icon-sm group-icon-svg" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-folder"></use></svg>
                    <span class="group-name">${safeGroupName}</span>
                    <span class="group-folder-count" title="关联目录数量">${folders.length}</span>
                    <button class="group-remove" type="button" title="删除文件夹组" aria-label="删除文件夹组">
                        <svg class="flow-icon flow-icon-xs" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-trash"></use></svg>
                    </button>
                </div>
                <div class="folder-accordion-content">
                    <div class="folder-accordion-inner">
                        <div class="folder-list">${folderHtml}</div>
                        <button class="sidebar-action-btn add-folder-btn" type="button" style="margin-top: 8px;">+ 添加文件夹</button>
                    </div>
                </div>
            </div>`;
        }).join('');

        this._applyGroupTaskStates();
        this._bindGSAPHover();
    }

    _bindGSAPHover() {
        this.dom.folderGroupList.querySelectorAll('.folder-group-item').forEach(item => {
            const accordionContent = item.querySelector('.folder-accordion-content');
            if (!accordionContent) return;
            item.addEventListener('mouseenter', () => {
                gsap.to(accordionContent, {
                    height: 'auto',
                    duration: 0.35,
                    ease: 'power2.out',
                    overwrite: 'auto'
                });
            });
            item.addEventListener('mouseleave', () => {
                if (this.pendingMove && item.classList.contains('active')) return;
                gsap.to(accordionContent, {
                    height: 0,
                    duration: 0.3,
                    ease: 'power2.inOut',
                    overwrite: 'auto'
                });
            });
        });
    }

    // ── 通用手风琴（过滤器、画布、窗口）的 GSAP 悬停动画 ──
    _initAccordions() {
        const sections = document.querySelectorAll('[data-accordion]');
        sections.forEach(section => {
            const body = section.querySelector('.accordion-body');
            if (!body) return;

            section.addEventListener('mouseenter', () => {
                gsap.to(body, {
                    height: 'auto',
                    duration: 0.35,
                    ease: 'power2.out',
                    overwrite: 'auto'
                });
            });

            section.addEventListener('mouseleave', () => {
                gsap.to(body, {
                    height: 0,
                    duration: 0.3,
                    ease: 'power2.inOut',
                    overwrite: 'auto'
                });
            });
        });
    }

    scheduleAssetLibraryRefresh(delay = 140) {
        clearTimeout(this._assetLibraryRefreshTimer);
        this._assetLibraryRefreshTimer = setTimeout(() => {
            void this._refreshAssetLibraryFiles();
        }, delay);
    }

    applyAssetMetadata(filePath, metadata) {
        if (!filePath || !metadata) return;
        this.assetLibraryMetadata.set(this._normalizePath(filePath), metadata);
        this._renderAssetLibraryGrid();
    }

    updateStats(count) {
        this.dom.stats.innerHTML = `<span>${count} 个文件</span>`;
        this._renderAssetLibraryGrid();
    }
}
