import gsap from 'gsap';

// ============================================================
// Flow Canvas — Sidebar Manager (with GSAP Hover Accordion)
// ============================================================

export class SidebarManager {
    constructor(storeData) {
        this.storeData = storeData;
        this.listeners = {};
        this.pendingMove = null;
        this._watcherSyncRunId = 0;

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
            fitAllBtn: document.getElementById('fitAllBtn'),
            packLayoutBtn: document.getElementById('packLayoutBtn'),
            seamlessLayoutBtn: document.getElementById('seamlessLayoutBtn'),
            newPlanBtn: document.getElementById('newPlanBtn'),
            exportMdBtn: document.getElementById('exportMdBtn'),
            resourceSaverBtn: document.getElementById('resourceSaverBtn'),
            resourceSaverState: document.getElementById('resourceSaverState'),
            stats: document.getElementById('sidebarStats'),
            alwaysOnTopBtn: document.getElementById('alwaysOnTopBtn'),
            alwaysOnTopLabel: document.getElementById('alwaysOnTopLabel')
        };

        this.bindEvents();
        this.renderGroups();

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

    _normalizePath(filePath) {
        return String(filePath || '')
            .replace(/\\/g, '/')
            .replace(/\/+$/g, '')
            .toLowerCase();
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

    _collectAllFolders() {
        return (this.storeData.folderGroups || []).flatMap(group => group.folders || []);
    }

    async _restoreActiveGroupWatcherState() {
        if (!window.flowCanvas?.folder?.syncWatches) return;
        const syncRunId = ++this._watcherSyncRunId;
        const activeFolders = this.getActiveWatchFolders();
        const knownFolders = [
            ...(this.storeData.watchFolders || []),
            ...this._collectAllFolders()
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
        // Toggle Sidebar
        const toggleSidebar = () => {
            const isClosed = document.body.classList.toggle('sidebar-closed');
            this.storeData.sidebarClosed = isClosed;
            if (window.flowCanvas && window.flowCanvas.store) {
                window.flowCanvas.store.save(this.storeData);
            }
            setTimeout(() => {
                const event = new Event('resize');
                window.dispatchEvent(event);
            }, 300);
        };

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
                    // 只处理常规点击，避免干扰
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
            if (e.target.classList.contains('filter-chip')) {
                const clickedFilter = e.target.dataset.filter;

                if (clickedFilter === 'all') {
                    this.dom.filterChips.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                    e.target.classList.add('active');
                } else {
                    const allChip = this.dom.filterChips.querySelector('[data-filter="all"]');
                    if (allChip) allChip.classList.remove('active');
                    e.target.classList.toggle('active');

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
            this.dom.resourceSaverState.textContent = enabled ? 'ON' : 'OFF';
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
            await window.flowCanvas.folder.unwatch(path);
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
    }

    _removeGroup(groupId) {
        const group = this.storeData.folderGroups.find(g => g.id === groupId);
        if (!group) return;

        // 取消监听该组的所有文件夹
        group.folders.forEach(folder => {
            if (window.flowCanvas && window.flowCanvas.folder) {
                window.flowCanvas.folder.unwatch(folder);
            }
        });

        this.storeData.folderGroups = this.storeData.folderGroups.filter(g => g.id !== groupId);

        if (this.storeData.activeGroupId === groupId) {
            if (this.storeData.folderGroups.length > 0) {
                this._activateGroup(this.storeData.folderGroups[0].id);
            } else {
                this.storeData.activeGroupId = null;
                this.storeData.watchFolders = [];
                this.storeData.items = [];
                this.storeData.viewport = { x: 0, y: 0, scale: 1 };
                this.renderGroups();
                this.emit('switchGroup', {
                    folders: [],
                    items: [],
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
            if (!Array.isArray(oldGroup.plans)) oldGroup.plans = [];

            // 取消监听旧组文件夹
            oldGroup.folders.forEach(folder => {
                if (window.flowCanvas && window.flowCanvas.folder) {
                    window.flowCanvas.folder.unwatch(folder);
                }
            });
        }

        // 切换 ID
        this.storeData.activeGroupId = groupId;
        const newGroup = this.getActiveGroup();
        if (!newGroup) return;
        this._ensureGroupDefaultFolder(newGroup);

        if (oldGroup && oldGroup.id !== groupId) {
            this.storeData.items = newGroup.savedItems || [];
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

            // 构建当前组内的文件夹 HTML
            let folderHtml = '';
            if (folders.length === 0) {
                folderHtml = '<div class="empty-hint" style="text-align:left; padding-left:12px;">空空如也，点击下方添加</div>';
            } else {
                folderHtml = folders.map(folder => {
                    const isDefault = folder === defaultFolder;
                    const safeFolder = this._escapeHtml(folder);
                    return `
                    <div class="folder-item ${isDefault ? 'is-default' : ''}" data-path="${safeFolder}" title="${safeFolder}">
                        <span class="folder-path">${safeFolder}</span>
                        <button class="folder-remove" data-path="${safeFolder}" title="取消关联">×</button>
                    </div>`;
                }).join('');
            }

            return `
            <div class="folder-group-item ${isActive ? 'active' : ''}" data-group-id="${safeGroupId}">
                <div class="group-header" title="左键选中激活，双击重命名">
                    <svg class="flow-icon flow-icon-sm group-icon-svg" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-folder"></use></svg>
                    <span class="group-name">${safeGroupName}</span>
                    <span class="group-folder-count">${folders.length}</span>
                    <button class="group-remove" title="删除组">×</button>
                </div>

                <!-- 隐藏的文件夹列表容器（GSAP 操控高度） -->
                <div class="folder-accordion-content">
                    <div class="folder-accordion-inner">
                        <div class="folder-list">
                            ${folderHtml}
                        </div>
                        <button class="sidebar-action-btn add-folder-btn" style="margin-top: 8px;">+ 添加文件夹</button>
                    </div>
                </div>
            </div>`;
        }).join('');

        this._bindGSAPHover();
    }

    _bindGSAPHover() {
        const groupItems = this.dom.folderGroupList.querySelectorAll('.folder-group-item');

        groupItems.forEach(item => {
            const accordionContent = item.querySelector('.folder-accordion-content');

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

    updateStats(count) {
        this.dom.stats.innerHTML = `<span>${count} 个文件</span>`;
    }
}
