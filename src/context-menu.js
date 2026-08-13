// ============================================================
// Flow Canvas — Context Menu (Smart Copy-Paste)
// ============================================================

import gsap from 'gsap';

export class ContextMenu {
    constructor() {
        this.el = document.getElementById('contextMenu');
        this.currentItem = null;
        this.hideTween = null;

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
            const currentItem = this.currentItem;
            const primaryPath = this.currentItem.filePath;
            const filePaths = this.currentItem.filePaths || [primaryPath];
            const itemIds = this.currentItem.itemIds || null;

            this.hide();

            try {
                if (action === 'copy') {
                    const copyPaths = filePaths.length > 0 ? filePaths : [primaryPath];
                    const res = await window.flowCanvas.clipboard.copy(copyPaths);
                    if (res.success) {
                        let msg = res.sizeMB ? `已复制 (${res.sizeMB}MB)` : `已复制 ${res.type === 'file' ? '文件' : '路径'}`;
                        this._showStatus(msg);
                    } else {
                        this._showStatus('复制失败');
                    }
                } else if (action === 'copyFilePath') {
                    const paths = (filePaths.length > 0 ? filePaths : [primaryPath]).filter(Boolean);
                    const res = await window.flowCanvas.clipboard.writeText(paths.join('\r\n'));
                    if (res.success) {
                        const countText = paths.length > 1 ? `${paths.length} 个` : '';
                        this._showStatus(`已复制 ${countText}文件地址`);
                    } else {
                        this._showStatus('复制文件地址失败');
                    }
                } else if (action === 'copyAiReference') {
                    const reference = this._buildAiReference(filePaths);
                    const res = await window.flowCanvas.clipboard.writeText(reference);
                    if (res.success) {
                        const countText = filePaths.length > 1 ? `${filePaths.length} 个 ` : '';
                        this._showStatus(`已复制 ${countText}AI 引用地址`);
                    } else {
                        this._showStatus('复制 AI 引用地址失败');
                    }
                } else if (action === 'showInExplorer') {
                    await window.flowCanvas.shell.showInExplorer(primaryPath);
                } else if (action === 'openFile') {
                    await window.flowCanvas.shell.openFile(primaryPath);
                } else if (action === 'repairMaterial') {
                    const ev = new CustomEvent('context-repair-material', { detail: { itemIds, filePaths } });
                    document.dispatchEvent(ev);
                } else if (action === 'relinkMaterial') {
                    const ev = new CustomEvent('context-relink-material', {
                        detail: {
                            itemId: itemIds?.[0] || currentItem.itemId || null,
                            itemIds: itemIds?.length === 1 ? itemIds : [],
                            filePath: primaryPath
                        }
                    });
                    document.dispatchEvent(ev);
                } else if (action === 'copyToFolder') {
                    const ev = new CustomEvent('context-copy-to-folder', { detail: { itemIds, filePaths } });
                    document.dispatchEvent(ev);
                } else if (action === 'copyToExplorer') {
                    const paths = (filePaths.length > 0 ? filePaths : [primaryPath]).filter(Boolean);
                    const res = await window.flowCanvas.folder.copyFilesToExplorer(paths);
                    if (res?.success) {
                        if (res.pasted) {
                            this._showStatus(paths.length > 1 ? `已投递 ${paths.length} 个素材到系统文件夹` : '已投递到系统文件夹');
                            return;
                        }
                        const copiedCount = (res.copied || []).filter(entry => entry.copied !== false).length || res.copied?.length || paths.length;
                        this._showStatus(copiedCount > 1 ? `已复制 ${copiedCount} 个素材到系统文件夹` : '已复制到系统文件夹');
                    } else if (res?.clipboardReady) {
                        this._showStatus(window.flowCanvas?.platform === 'darwin'
                            ? '已放入系统剪贴板，请在目标文件夹按 Command+V'
                            : '已放入系统剪贴板，请在目标文件夹按 Ctrl+V');
                    } else {
                        this._showStatus(`复制失败：${res?.error || '未找到系统文件夹'}`);
                    }
                } else if (action === 'moveToFolder') {
                    const ev = new CustomEvent('context-move-to-folder', { detail: { itemIds, filePaths } });
                    document.dispatchEvent(ev);
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

        const moveBtnSpan = this.el.querySelector('[data-action="moveToFolder"] span:nth-child(2)');
        if (moveBtnSpan) {
            moveBtnSpan.textContent = item.filePaths && item.filePaths.length > 1
                ? `剪切 ${item.filePaths.length} 项到文件夹`
                : '剪切到文件夹';
        }
        const copyToFolderBtnSpan = this.el.querySelector('[data-action="copyToFolder"] span:nth-child(2)');
        if (copyToFolderBtnSpan) {
            copyToFolderBtnSpan.textContent = item.filePaths && item.filePaths.length > 1
                ? `复制 ${item.filePaths.length} 项到文件夹`
                : '复制到文件夹';
        }
        const copyToExplorerBtnSpan = this.el.querySelector('[data-action="copyToExplorer"] span:nth-child(2)');
        if (copyToExplorerBtnSpan) {
            copyToExplorerBtnSpan.textContent = item.filePaths && item.filePaths.length > 1
                ? `复制 ${item.filePaths.length} 项到当前系统文件夹`
                : '复制到当前系统文件夹';
        }

        const repairItem = this.el.querySelector('[data-action="repairMaterial"]');
        const repairText = repairItem?.querySelector('span:nth-child(2)');
        if (repairText) {
            repairText.textContent = item.filePaths && item.filePaths.length > 1
                ? `自动修补选中素材 (${item.filePaths.length} 项)`
                : '自动修补断联素材';
        }
        if (repairItem) {
            repairItem.style.display = item.filePaths?.length ? '' : 'none';
        }

        const relinkItem = this.el.querySelector('[data-action="relinkMaterial"]');
        if (relinkItem) {
            const canRelink = (item.itemIds || []).length === 1 || Boolean(item.itemId);
            relinkItem.style.display = canRelink ? '' : 'none';
        }

        this.el.style.left = `${e.evt.clientX}px`;
        this.el.style.top = `${e.evt.clientY}px`;
        this.el.classList.add('show');
        this.hideTween?.kill();

        // 边界检测
        const rect = this.el.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            this.el.style.left = `${window.innerWidth - rect.width - 10}px`;
        }
        if (rect.bottom > window.innerHeight) {
            this.el.style.top = `${window.innerHeight - rect.height - 10}px`;
        }

        gsap.fromTo(this.el,
            { opacity: 0, y: 4, scale: 0.985 },
            { opacity: 1, y: 0, scale: 1, duration: 0.14, ease: 'power2.out' }
        );
    }

    hide() {
        if (!this.el.classList.contains('show')) {
            this.currentItem = null;
            return;
        }

        this.hideTween?.kill();
        this.hideTween = gsap.to(this.el, {
            opacity: 0,
            y: 3,
            scale: 0.985,
            duration: 0.1,
            ease: 'power1.in',
            onComplete: () => {
                this.el.classList.remove('show');
                gsap.set(this.el, { clearProps: 'opacity,transform' });
            }
        });
        this.currentItem = null;
    }

    _buildAiReference(filePaths) {
        const items = filePaths
            .filter(Boolean)
            .map((filePath, index) => this._toReferenceItem(filePath, index + 1));

        if (items.length === 0) return '';

        return this._stringifyAsciiJson({
            schema: 'flow-canvas.references.v1',
            encoding: 'unicode-escaped-json',
            itemCount: items.length,
            items
        });
    }

    _toReferenceItem(filePath, index) {
        const name = filePath.split(/[/\\]/).pop() || filePath;
        return {
            index,
            name,
            type: this._getFileType(filePath),
            path: filePath
        };
    }

    _getFileType(filePath) {
        if (this._isImageFile(filePath)) return 'image';
        if (/\.(mp4|mov|avi|mkv|wmv|flv|webm)$/i.test(filePath)) return 'video';
        if (/\.(mp3|wav|aac|flac|ogg)$/i.test(filePath)) return 'audio';
        if (/\.(pdf|doc|docx|txt|ppt|pptx|xls|xlsx|md)$/i.test(filePath)) return 'document';
        return 'other';
    }

    _stringifyAsciiJson(value) {
        return JSON.stringify(value, null, 2)
            .replace(/[^\x00-\x7F]/g, char => char.split('')
                .map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
                .join(''));
    }

    _isImageFile(filePath) {
        return /\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|svg|ico)$/i.test(filePath);
    }

    _showStatus(msg) {
        const status = document.getElementById('titlebarStatus');
        status.textContent = msg;
        status.classList.add('status-visible');
        gsap.fromTo(status,
            { opacity: 0, y: -3 },
            { opacity: 1, y: 0, duration: 0.16, ease: 'power2.out' }
        );

        clearTimeout(this.statusTimer);
        this.statusTimer = setTimeout(() => {
            if (status.textContent !== msg) return;
            gsap.to(status, {
                opacity: 0,
                y: -2,
                duration: 0.16,
                ease: 'power1.in',
                onComplete: () => {
                    if (status.textContent === msg) {
                        status.textContent = '';
                        status.classList.remove('status-visible');
                        gsap.set(status, { clearProps: 'opacity,transform' });
                    }
                }
            });
        }, 2600);
    }
}
