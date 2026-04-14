// ============================================================
// Flow Canvas — Context Menu (Smart Copy-Paste)
// ============================================================

export class ContextMenu {
    constructor() {
        this.el = document.getElementById('contextMenu');
        this.currentItem = null;

        this.bindEvents();
    }

    bindEvents() {
        // 点击外部隐藏
        document.addEventListener('mousedown', (e) => {
            if (!this.el.contains(e.target)) {
                this.hide();
            }
        });

        // 滚动画布隐藏
        document.getElementById('canvasContainer').addEventListener('wheel', () => {
            this.hide();
        });

        // 菜单项点击
        this.el.addEventListener('click', async (e) => {
            const itemBtn = e.target.closest('.context-menu-item');
            if (!itemBtn || !this.currentItem) return;

            const action = itemBtn.dataset.action;
            const primaryPath = this.currentItem.filePath;
            const filePaths = this.currentItem.filePaths || [primaryPath];
            const itemIds = this.currentItem.itemIds || null;

            this.hide();

            try {
                if (action === 'copy') {
                    const res = await window.flowCanvas.clipboard.copy(primaryPath);
                    if (res.success) {
                        let msg = res.sizeMB ? `已复制 (${res.sizeMB}MB)` : `已复制 ${res.type === 'file' ? '文件' : '路径'}`;
                        this._showStatus(msg);
                    }
                } else if (action === 'showInExplorer') {
                    await window.flowCanvas.shell.showInExplorer(primaryPath);
                } else if (action === 'openFile') {
                    await window.flowCanvas.shell.openFile(primaryPath);
                } else if (action === 'removeFromBoard') {
                    const ev = new CustomEvent('context-remove', { detail: { itemIds, filePaths } });
                    document.dispatchEvent(ev);
                }
            } catch (err) {
                console.error('Menu action failed:', err);
            }
        });
    }

    show(e, item) {
        e.evt.preventDefault();
        this.currentItem = item;

        // 根据选择数量更新描述文字
        const removeBtnSpan = this.el.querySelector('[data-action="removeFromBoard"] span:nth-child(2)');
        if (item.filePaths && item.filePaths.length > 1) {
            removeBtnSpan.textContent = `从白板移除 (${item.filePaths.length} 项)`;
        } else {
            removeBtnSpan.textContent = `从白板移除`;
        }

        this.el.style.left = `${e.evt.clientX}px`;
        this.el.style.top = `${e.evt.clientY}px`;
        this.el.classList.add('show');

        // 边界检测
        const rect = this.el.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            this.el.style.left = `${window.innerWidth - rect.width - 10}px`;
        }
        if (rect.bottom > window.innerHeight) {
            this.el.style.top = `${window.innerHeight - rect.height - 10}px`;
        }
    }

    hide() {
        this.el.classList.remove('show');
        this.currentItem = null;
    }

    _showStatus(msg) {
        const status = document.getElementById('titlebarStatus');
        status.textContent = msg;
        setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 3000);
    }
}
