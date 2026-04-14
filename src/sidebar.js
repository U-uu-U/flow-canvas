// ============================================================
// Flow Canvas — Sidebar Manager
// ============================================================

export class SidebarManager {
    constructor(storeData) {
        this.storeData = storeData;
        this.listeners = {};

        this.dom = {
            sidebar: document.getElementById('sidebar'),
            collapseBtn: document.getElementById('collapseSidebarBtn'),
            addBtn: document.getElementById('addFolderBtn'),
            emptyAddBtn: document.getElementById('emptyAddBtn'),
            folderList: document.getElementById('folderList'),
            filterChips: document.getElementById('filterChips'),
            fitAllBtn: document.getElementById('fitAllBtn'),
            packLayoutBtn: document.getElementById('packLayoutBtn'),
            seamlessLayoutBtn: document.getElementById('seamlessLayoutBtn'),
            exportMdBtn: document.getElementById('exportMdBtn'),
            stats: document.getElementById('sidebarStats'),
            alwaysOnTopBtn: document.getElementById('alwaysOnTopBtn'),
            alwaysOnTopLabel: document.getElementById('alwaysOnTopLabel')
        };

        this.bindEvents();
        this.renderFolders();

        // 恢复侧边栏状态
        if (this.storeData.sidebarClosed) {
            document.body.classList.add('sidebar-closed');
        }

        // 恢复置顶状态
        this._initAlwaysOnTop();
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
            // Emit resize or change event to canvas manager if needed
            // Wait a bit for the CSS transition to process
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

        // When closed, clicking the whole sidebar circle expands it
        if (this.dom.sidebar) {
            this.dom.sidebar.addEventListener('click', (e) => {
                if (document.body.classList.contains('sidebar-closed')) {
                    toggleSidebar();
                }
            });
        }

        // 添加文件夹
        const handleAddFolder = async () => {
            const folderPath = await window.flowCanvas.folder.select();
            if (folderPath && !this.storeData.watchFolders.includes(folderPath)) {
                this.storeData.watchFolders.push(folderPath);
                this.renderFolders();
                window.flowCanvas.store.save(this.storeData);
                document.body.classList.add('has-folders');

                // 扫描现有文件
                const files = await window.flowCanvas.folder.scan(folderPath);
                console.log(`[Sidebar] Found ${files.length} files in ${folderPath}`);
                if (files && files.length > 0) {
                    this.emit('scanFiles', files);
                }
            }
        };

        this.dom.addBtn.addEventListener('click', handleAddFolder);
        this.dom.emptyAddBtn.addEventListener('click', handleAddFolder);

        // 移除文件夹
        this.dom.folderList.addEventListener('click', async (e) => {
            if (e.target.classList.contains('folder-remove')) {
                const path = e.target.dataset.path;
                await window.flowCanvas.folder.unwatch(path);

                this.storeData.watchFolders = this.storeData.watchFolders.filter(p => p !== path);

                // 同时移除该文件夹下所有文件
                const removedItems = this.storeData.items.filter(i => i.filePath.startsWith(path));
                this.storeData.items = this.storeData.items.filter(i => !i.filePath.startsWith(path));
                removedItems.forEach(i => {
                    const ev = new CustomEvent('context-remove', { detail: { filePath: i.filePath } });
                    document.dispatchEvent(ev);
                });

                this.renderFolders();
                window.flowCanvas.store.save(this.storeData);

                if (this.storeData.watchFolders.length === 0) {
                    document.body.classList.remove('has-folders');
                }
            }
        });

        // 右键文件夹弹出菜单
        this.dom.folderList.addEventListener('contextmenu', async (e) => {
            const folderItem = e.target.closest('.folder-item');
            if (folderItem) {
                e.preventDefault();
                const path = folderItem.querySelector('.folder-remove').dataset.path;
                const action = await window.flowCanvas.folder.showContextMenu(path);
                if (action === 'setDefault') {
                    this.storeData.defaultSaveFolder = path;
                    this.renderFolders();
                    window.flowCanvas.store.save(this.storeData);
                } else if (action === 'remove') {
                    const removeBtn = folderItem.querySelector('.folder-remove');
                    if (removeBtn) removeBtn.click();
                }
            }
        });

        // 过滤器（多选模式）
        this.dom.filterChips.addEventListener('click', (e) => {
            if (e.target.classList.contains('filter-chip')) {
                const clickedFilter = e.target.dataset.filter;

                if (clickedFilter === 'all') {
                    // 点击"全部"：取消所有其他选中，只选全部
                    this.dom.filterChips.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                    e.target.classList.add('active');
                } else {
                    // 点击具体类型：toggle 该类型，同时取消"全部"
                    const allChip = this.dom.filterChips.querySelector('[data-filter="all"]');
                    if (allChip) allChip.classList.remove('active');
                    e.target.classList.toggle('active');

                    // 如果没有任何具体过滤器选中，自动恢复"全部"
                    const activeChips = this.dom.filterChips.querySelectorAll('.filter-chip.active');
                    if (activeChips.length === 0 && allChip) {
                        allChip.classList.add('active');
                    }
                }

                // 收集当前选中的过滤器
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
        this.dom.fitAllBtn.addEventListener('click', () => this.emit('fitAll'));
        if (this.dom.packLayoutBtn) {
            this.dom.packLayoutBtn.addEventListener('click', () => this.emit('packLayout'));
        }
        if (this.dom.seamlessLayoutBtn) {
            this.dom.seamlessLayoutBtn.addEventListener('click', () => this.emit('seamlessLayout'));
        }
        if (this.dom.exportMdBtn) {
            this.dom.exportMdBtn.addEventListener('click', () => this.emit('exportMd'));
        }
    }

    renderFolders() {
        const folders = this.storeData.watchFolders || [];

        // 同步更新 body 状态，确保画布空状态正确隐藏/显示
        if (folders.length > 0) {
            document.body.classList.add('has-folders');
        } else {
            document.body.classList.remove('has-folders');
        }

        if (folders.length === 0) {
            this.dom.folderList.innerHTML = '<div class="empty-hint">点击 + 添加文件夹<br>文件将自动上墙</div>';
            return;
        }

        const defaultFolder = this.storeData.defaultSaveFolder || folders[0];
        this.dom.folderList.innerHTML = folders.map(folder => {
            const isDefault = folder === defaultFolder;
            return `
      <div class="folder-item ${isDefault ? 'is-default' : ''}" title="${folder}">
        <span class="folder-path">${folder} ${isDefault ? '<span style="font-size:10px;color:#aaa;">(默认下载位置)</span>' : ''}</span>
        <button class="folder-remove" data-path="${folder}" title="取消关联">×</button>
      </div>`;
        }).join('');
    }

    updateStats(count) {
        this.dom.stats.innerHTML = `<span>${count} 个文件</span>`;
    }
}
