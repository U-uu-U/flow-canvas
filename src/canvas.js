// ============================================================
// Flow Canvas — Canvas Manager (Konva.js)
// ============================================================

import Konva from 'konva';

const IMAGE_DEFAULT_WIDTH = 300;
const DOC_DEFAULT_SIZE = 150;

export class CanvasManager {
    constructor(containerId, storeData, contextMenu) {
        this.storeData = storeData;
        this.contextMenu = contextMenu;
        this.listeners = {};
        this.items = new Map();
        this.selectedItems = new Set();
        this.currentFilter = 'all';

        const container = document.getElementById(containerId);
        this.stage = new Konva.Stage({
            container: containerId,
            width: container.offsetWidth,
            height: container.offsetHeight,
            draggable: true
        });

        // ── 修复加载光标：阻止浏览器原生 HTML5 拖拽行为 ──
        container.addEventListener('dragstart', (e) => e.preventDefault());
        container.style.cursor = 'default';

        this.layer = new Konva.Layer();
        this.stage.add(this.layer);

        this.selectionRect = new Konva.Rect({
            fill: 'rgba(58, 123, 213, 0.2)',
            stroke: '#3a7bd5',
            strokeWidth: 1,
            visible: false,
        });
        this.layer.add(this.selectionRect);

        // GIF 叠加层
        this.gifOverlay = document.createElement('div');
        this.gifOverlay.style.position = 'absolute';
        this.gifOverlay.style.top = '0';
        this.gifOverlay.style.left = '0';
        this.gifOverlay.style.width = '100%';
        this.gifOverlay.style.height = '100%';
        this.gifOverlay.style.pointerEvents = 'none'; // 让鼠标事件穿透到画布
        this.gifOverlay.style.overflow = 'hidden';
        container.appendChild(this.gifOverlay);

        if (storeData.viewport) {
            this.stage.position({ x: storeData.viewport.x, y: storeData.viewport.y });
            this.stage.scale({ x: storeData.viewport.scale, y: storeData.viewport.scale });
        }

        // ── 性能优化：rAF 合并高频事件 ──
        this._rafPending = false;
        this._bgCachedScale = -1;   // 缓存上次 SVG 对应的 scale
        this._bgCachedSvg = '';     // 缓存的 SVG data URI
        this._bgCachedSize = 0;     // 缓存的 screenSize

        this.stage.on('xChange yChange scaleXChange scaleYChange', () => {
            if (!this._rafPending) {
                this._rafPending = true;
                requestAnimationFrame(() => {
                    this._rafPending = false;
                    this.syncGifs();
                    this.syncBackground();
                });
            }
        });

        this.bindEvents();
        this.renderInitialItems();
        this.syncBackground();

        // 用 ResizeObserver 监听容器尺寸变化（侧边栏开关、窗口缩放等都能捕获）
        const ro = new ResizeObserver(() => {
            this.stage.width(container.offsetWidth);
            this.stage.height(container.offsetHeight);
        });
        ro.observe(container);

        document.addEventListener('context-remove', (e) => {
            if (e.detail.itemIds) {
                e.detail.itemIds.forEach(id => this.removeItemById(id));
            } else if (e.detail.filePaths) {
                e.detail.filePaths.forEach(p => this.removeFile(p));
            } else if (e.detail.filePath) {
                this.removeFile(e.detail.filePath);
            }
            this.emit('change');
        });
    }

    syncGifs() {
        const scale = this.stage.scaleX();
        const stagePos = this.stage.position();
        this.items.forEach(item => {
            if (item.gifDomElement) {
                if (item.group.isVisible()) {
                    const gx = item.group.x();
                    const gy = item.group.y();
                    // 计算屏幕绝对坐标
                    const screenX = gx * scale + stagePos.x;
                    const screenY = gy * scale + stagePos.y;
                    item.gifDomElement.style.transform = `translate(${screenX}px, ${screenY}px) scale(${scale})`;
                } else {
                    item.gifDomElement.style.display = 'none';
                }
            }
        });
    }

    syncBackground() {
        const gridEl = document.getElementById('canvasGrid');
        if (!gridEl) return;

        const scale = this.stage.scaleX();
        const pos = this.stage.position();

        const GRID_SIZE = 48;
        const screenSize = GRID_SIZE * scale;

        // 自适应透明度
        let opacity = 1;
        if (scale < 0.2) opacity = 0;
        else if (scale < 0.5) opacity = (scale - 0.2) / 0.3;
        if (scale > 5) opacity *= Math.max(0, 1 - (scale - 5) / 5);

        if (opacity <= 0) {
            gridEl.style.opacity = '0';
            return;
        }

        gridEl.style.opacity = '1';

        // ── 关键优化：只在 scale 变化时重建 SVG，平移只更新 position ──
        if (scale !== this._bgCachedScale) {
            this._bgCachedScale = scale;
            this._bgCachedSize = screenSize;

            const dotR = Math.max(0.5, Math.min(1.2, scale * 0.8));
            const dotColor = `rgba(255,255,255,${(opacity * 0.07).toFixed(3)})`;
            const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${screenSize}' height='${screenSize}'><circle cx='${screenSize / 2}' cy='${screenSize / 2}' r='${dotR}' fill='${dotColor}'/></svg>`;
            this._bgCachedSvg = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

            gridEl.style.backgroundImage = this._bgCachedSvg;
            gridEl.style.backgroundSize = `${screenSize}px ${screenSize}px`;
        }

        // 平移时只更新偏移（非常轻量）
        const offsetX = pos.x % this._bgCachedSize;
        const offsetY = pos.y % this._bgCachedSize;
        gridEl.style.backgroundPosition = `${offsetX}px ${offsetY}px`;
    }

    on(event, cb) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(cb);
    }

    emit(event, data) {
        if (this.listeners[event]) this.listeners[event].forEach(cb => cb(data));
    }

    getViewport() {
        return { x: this.stage.x(), y: this.stage.y(), scale: this.stage.scaleX() };
    }

    _getRelativePointerPos() {
        const pos = this.stage.getPointerPosition();
        return {
            x: (pos.x - this.stage.x()) / this.stage.scaleX(),
            y: (pos.y - this.stage.y()) / this.stage.scaleY(),
        };
    }

    bindEvents() {
        // Zoom
        this.stage.on('wheel', (e) => {
            e.evt.preventDefault();
            const oldScale = this.stage.scaleX();
            const pointer = this.stage.getPointerPosition();
            const mousePointTo = {
                x: (pointer.x - this.stage.x()) / oldScale,
                y: (pointer.y - this.stage.y()) / oldScale,
            };

            const direction = e.evt.deltaY > 0 ? -1 : 1;
            const scaleBy = 1.1;
            const newScale = direction > 0 ? oldScale * scaleBy : oldScale / scaleBy;
            if (newScale < 0.1 || newScale > 10) return;

            this.stage.scale({ x: newScale, y: newScale });
            this.stage.position({
                x: pointer.x - mousePointTo.x * newScale,
                y: pointer.y - mousePointTo.y * newScale,
            });
            this.emit('change');
            // syncGifs 已由 stage change 事件的 rAF 批处理统一调用，不再手动重复调用
        });

        // Marquee Selection & Panning Logic
        let x1, y1, x2, y2;
        let isSelecting = false;
        let isPanning = false;
        let lastPanX = 0, lastPanY = 0;

        this.stage.on('mousedown', (e) => {
            if (e.evt.button === 1 || e.evt.button === 2) {
                // Middle or Right click: 只平移画布，不拖动图片
                e.evt.preventDefault();
                isPanning = true;

                // ── 关键：临时禁用 stage 和所有图片的 draggable ──
                this.stage.draggable(false);
                this.items.forEach(item => item.group.draggable(false));

                const pos = this.stage.getPointerPosition();
                lastPanX = pos.x;
                lastPanY = pos.y;
                document.body.style.cursor = 'grabbing';
                return;
            }
            if (e.target !== this.stage && e.target !== this.selectionRect) {
                const group = e.target.findAncestor('Group');
                if (group) {
                    // ── Alt+左键：拖出文件到外部应用（支持多选批量导出）──
                    if (e.evt.altKey && e.evt.button === 0) {
                        e.evt.preventDefault();
                        group.draggable(false); // 阻止 Konva 拖拽
                        this.stage.draggable(false); // 阻止画布平移

                        // 收集要导出的文件路径
                        let filePaths;
                        if (this.selectedItems.size > 1 && this.selectedItems.has(group.attrs.id)) {
                            // 有多项框选且当前点击的图片在选中范围内 → 导出所有选中图片
                            // 按从左上到右下排序（先按 y 排，y 相近的按 x 排）
                            const selectedEntries = [];
                            this.selectedItems.forEach(id => {
                                const item = this.items.get(id);
                                if (item && item.data.filePath) {
                                    selectedEntries.push({
                                        filePath: item.data.filePath,
                                        x: item.group.x(),
                                        y: item.group.y()
                                    });
                                }
                            });
                            // 按行分组再排序：y 值差距小于 50 的视为同一行
                            selectedEntries.sort((a, b) => {
                                const rowDiff = Math.abs(a.y - b.y);
                                if (rowDiff < 50) return a.x - b.x; // 同行按 x 排
                                return a.y - b.y; // 不同行按 y 排
                            });
                            filePaths = selectedEntries.map(e => e.filePath);
                        } else {
                            // 单张图片
                            filePaths = group.attrs.filePath ? [group.attrs.filePath] : [];
                        }

                        if (filePaths.length > 0 && window.flowCanvas && window.flowCanvas.drag) {
                            this._startNativeDrag(filePaths);
                        }
                        // 拖完后恢复 draggable
                        const restore = () => {
                            group.draggable(true);
                            this.stage.draggable(true);
                            document.removeEventListener('mouseup', restore);
                        };
                        document.addEventListener('mouseup', restore);
                        return;
                    }

                    if (!e.evt.ctrlKey && !e.evt.shiftKey && !this.selectedItems.has(group.attrs.id)) {
                        this.clearSelection();
                        this.selectItem(group.attrs.id, true);
                    }
                }
                return;
            }
            e.evt.preventDefault();

            // disable dragging for stage to allow marquee select
            this.stage.draggable(false);

            isSelecting = true;
            const pos = this._getRelativePointerPos();
            x1 = pos.x;
            y1 = pos.y;
            x2 = pos.x;
            y2 = pos.y;

            this.selectionRect.visible(true);
            this.selectionRect.position({ x: x1, y: y1 });
            this.selectionRect.width(0);
            this.selectionRect.height(0);
            this.selectionRect.moveToTop();
        });

        this.stage.on('mousemove', (e) => {
            if (isPanning) {
                e.evt.preventDefault();
                const pos = this.stage.getPointerPosition();
                const dx = pos.x - lastPanX;
                const dy = pos.y - lastPanY;
                lastPanX = pos.x;
                lastPanY = pos.y;

                this.stage.position({
                    x: this.stage.x() + dx,
                    y: this.stage.y() + dy
                });
                this.stage.batchDraw();
                // syncGifs 已由 rAF 批处理统一调用
                return;
            }

            if (!isSelecting) return;
            e.evt.preventDefault();
            const pos = this._getRelativePointerPos();
            x2 = pos.x;
            y2 = pos.y;

            this.selectionRect.setAttrs({
                x: Math.min(x1, x2),
                y: Math.min(y1, y2),
                width: Math.abs(x2 - x1),
                height: Math.abs(y2 - y1)
            });
        });

        this.stage.on('mouseup', (e) => {
            if (isPanning) {
                isPanning = false;
                document.body.style.cursor = 'default';

                // ── 恢复 stage 和所有图片的 draggable ──
                this.stage.draggable(true);
                this.items.forEach(item => item.group.draggable(true));

                this.emit('change');
                return;
            }

            this.stage.draggable(true);
            if (!isSelecting) return;

            isSelecting = false;
            this.selectionRect.visible(false);

            const box = this.selectionRect.getClientRect();
            if (box.width === 0 && box.height === 0) {
                if (!e.evt.ctrlKey && !e.evt.shiftKey) {
                    this.clearSelection();
                }
                return;
            }

            if (!e.evt.ctrlKey && !e.evt.shiftKey) {
                this.clearSelection();
            }

            // Find overlapping items
            const selBox = this.selectionRect.getClientRect();
            const shapes = this.stage.find('.nodeGroup');
            shapes.forEach(shape => {
                const shapeBox = shape.getClientRect();
                if (Konva.Util.haveIntersection(selBox, shapeBox)) {
                    this.selectItem(shape.attrs.id, true);
                }
            });
        });

        this.stage.on('dragend', (e) => {
            if (e.target.name() === 'nodeGroup') {
                const group = e.target;
                const entry = this.items.get(group.attrs.id);
                if (!entry) return;
                const data = entry.data;
                data.x = group.x();
                data.y = group.y();

                const displayNode = group.findOne('.displayNode') || group.findOne('.fallbackBg');
                if (displayNode) {
                    data.width = displayNode.width();
                    data.height = displayNode.height();
                }
            }
            this.emit('change');
        });

        this.stage.on('dragmove', (e) => {
            if (e.target.name() === 'nodeGroup') {
                const group = e.target;
                if (!this.selectedItems.has(group.attrs.id)) return;

                if (this.selectedItems.size === 1 && (!e.evt || !e.evt.shiftKey)) {
                    this._applyMagneticSnapping(group);
                }

                const deltaX = group.x() - group.getAttr('lastX');
                const deltaY = group.y() - group.getAttr('lastY');
                group.setAttr('lastX', group.x());
                group.setAttr('lastY', group.y());

                this.selectedItems.forEach(id => {
                    if (id === group.attrs.id) return;
                    const item = this.items.get(id);
                    if (item) {
                        item.group.x(item.group.x() + deltaX);
                        item.group.y(item.group.y() + deltaY);
                        item.data.x = item.group.x();
                        item.data.y = item.group.y();
                    }
                });
            }
        });

        this.stage.on('dragstart', (e) => {
            if (e.target.name() === 'nodeGroup') {
                // ── 只允许左键拖动图片，中键/右键用于画布平移 ──
                if (e.evt && e.evt.button !== 0) {
                    e.target.stopDrag();
                    return;
                }
                // ── Alt+拖拽由原生文件拖放处理，不走 Konva 拖拽 ──
                if (e.evt && e.evt.altKey) {
                    e.target.stopDrag();
                    return;
                }

                const group = e.target;
                if (!this.selectedItems.has(group.attrs.id)) {
                    this.clearSelection();
                    this.selectItem(group.attrs.id, true);
                }

                // ── Ctrl+拖拽：在原位留下副本，拖走原件 ──
                if (e.evt && e.evt.ctrlKey) {
                    const clonedDataList = [];
                    let cloneIdx = 0;
                    this.selectedItems.forEach(id => {
                        const item = this.items.get(id);
                        if (!item) return;
                        const cloneData = {
                            id: Date.now().toString() + '_c' + (cloneIdx++) + Math.random().toString(36).substr(2, 5),
                            filePath: item.data.filePath,
                            x: item.group.x(),
                            y: item.group.y(),
                            width: item.data.width,
                            height: item.data.height,
                            addedAt: Date.now()
                        };
                        this._createCard(cloneData);
                        clonedDataList.push(cloneData);
                    });
                    if (clonedDataList.length > 0) {
                        this.emit('clonedItems', clonedDataList);
                    }
                }

                this.selectedItems.forEach(id => {
                    const item = this.items.get(id);
                    if (item) {
                        item.group.setAttr('lastX', item.group.x());
                        item.group.setAttr('lastY', item.group.y());
                    }
                });
            }
        });

        // Keyboard Shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (this.selectedItems.size > 0) {
                    const idsToRemove = [...this.selectedItems];
                    const filePaths = idsToRemove.map(id => this.items.get(id)?.data.filePath).filter(Boolean);

                    if (idsToRemove.length > 0) {
                        const ev = new CustomEvent('context-remove', { detail: { itemIds: idsToRemove, filePaths } });
                        document.dispatchEvent(ev);
                        this.clearSelection();
                    }
                }
            } else if (e.key === 'Escape') {
                this.clearSelection();
                this.contextMenu.hide();
            } else if (e.key === 'a' && e.ctrlKey) {
                e.preventDefault();
                this.selectAll();
            } else if (e.key === 'v' && e.ctrlKey) {
                // Ctrl+V 粘贴网页图片
                this._handlePaste();
            }
        });

        // ── 从浏览器拖拽图片到白板 ──────────────────────────
        // 全局接受拖放
        window.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        window.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[Canvas] 触发全局 drop 事件, types:', Array.from(e.dataTransfer.types));

            // 1. 尝试获取拖拽的图片 URL
            const uriList = e.dataTransfer.getData('text/uri-list') || '';
            const plainText = e.dataTransfer.getData('text/plain') || '';
            const url = uriList || plainText;

            // 2. 尝试获取拖拽的 HTML（<img src="...">）
            const html = e.dataTransfer.getData('text/html') || '';
            let parsedImgUrl = null;
            if (html) {
                try {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, 'text/html');
                    const img = doc.querySelector('img');
                    if (img) {
                        parsedImgUrl = img.getAttribute('src') || img.src;
                    }
                } catch (err) {
                    console.warn('[Canvas] HTML解析失败', err);
                }
            }

            // 3. 尝试获取拖拽的本地文件
            const files = e.dataTransfer.files;

            console.log('[Canvas] drop 数据: url=', url, '解析出的图片URL=', parsedImgUrl, '本地文件数=', files?.length);

            let imageUrl = null;

            if (parsedImgUrl && /^https?:\/\//i.test(parsedImgUrl)) {
                imageUrl = parsedImgUrl;
            } else if (url && /^https?:\/\/.+/i.test(url)) {
                imageUrl = url;
            }

            if (imageUrl) {
                console.log('[Canvas] 拖拽图片 URL:', imageUrl);
                const targetDir = this.storeData.defaultSaveFolder || (this.storeData.watchFolders && this.storeData.watchFolders[0]);
                const result = await window.flowCanvas.image.downloadFromUrl(imageUrl, targetDir);
                if (result.success) {
                    this._addCapturedFile(result.filePath, e);
                } else {
                    console.error('[Canvas] 下载失败:', result.error);
                }
            } else if (files && files.length > 0) {
                // 本地文件拖入（直接用路径）
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    if (file.path) {
                        this._addCapturedFile(file.path, e);
                    }
                }
            }
        });
    }

    _applyMagneticSnapping(movedGroup) {
        const SNAP_DIST = 8; // 磁吸距离（缩小到 8，避免远距离误吸附）
        const movedNode = movedGroup.findOne('.displayNode') || movedGroup.findOne('.fallbackBg');
        if (!movedNode) return;

        let mx = movedGroup.x();
        let my = movedGroup.y();
        let mw = movedNode.width();
        let mh = movedNode.height();

        let snappedX = mx;
        let snappedY = my;
        let snappedW = mw;
        let snappedH = mh;
        let snapped = false;
        let bestDist = SNAP_DIST;

        for (let [itemId, item] of this.items.entries()) {
            if (item.group === movedGroup) continue;

            const targetNode = item.group.findOne('.displayNode') || item.group.findOne('.fallbackBg');
            if (!targetNode) continue;

            const tx = item.group.x();
            const ty = item.group.y();
            const tw = targetNode.width();
            const th = targetNode.height();

            // 垂直方向接近度：两个图片中心的垂直距离不能超过两者较小高度的 60%
            const vProximity = Math.min(mh, th) * 0.6;
            // 水平方向接近度
            const hProximity = Math.min(mw, tw) * 0.6;

            // Check Left/Right edges (Horizontal Alignment)
            if (Math.abs(mx + mw - tx) < bestDist && Math.abs(my + mh / 2 - (ty + th / 2)) < vProximity) {
                bestDist = Math.abs(mx + mw - tx);
                const scale = th / mh;
                snappedH = th;
                snappedW = mw * scale;
                snappedX = tx - snappedW;
                snappedY = ty;
                snapped = true;
            } else if (Math.abs(mx - (tx + tw)) < bestDist && Math.abs(my + mh / 2 - (ty + th / 2)) < vProximity) {
                bestDist = Math.abs(mx - (tx + tw));
                const scale = th / mh;
                snappedH = th;
                snappedW = mw * scale;
                snappedX = tx + tw;
                snappedY = ty;
                snapped = true;
            }

            // Check Top/Bottom edges (Vertical Alignment)
            if (Math.abs(my + mh - ty) < bestDist && Math.abs(mx + mw / 2 - (tx + tw / 2)) < hProximity) {
                bestDist = Math.abs(my + mh - ty);
                const scale = tw / mw;
                snappedW = tw;
                snappedH = mh * scale;
                snappedY = ty - snappedH;
                snappedX = tx;
                snapped = true;
            } else if (Math.abs(my - (ty + th)) < bestDist && Math.abs(mx + mw / 2 - (tx + tw / 2)) < hProximity) {
                bestDist = Math.abs(my - (ty + th));
                const scale = tw / mw;
                snappedW = tw;
                snappedH = mh * scale;
                snappedY = ty + th;
                snappedX = tx;
                snapped = true;
            }
        }

        if (snapped) {
            movedGroup.x(snappedX);
            movedGroup.y(snappedY);

            if (Math.abs(snappedW - mw) > 0.1 || Math.abs(snappedH - mh) > 0.1) {
                movedNode.width(snappedW);
                movedNode.height(snappedH);

                const item = this.items.get(movedGroup.attrs.id);
                if (item) {
                    item.data.width = snappedW;
                    item.data.height = snappedH;
                    if (item.gifDomElement) {
                        item.gifDomElement.style.width = `${snappedW}px`;
                        item.gifDomElement.style.height = `${snappedH}px`;
                    }
                }

                // If video, update control group size
                const controlsGroup = movedGroup.children.find(c => c.getClassName() === 'Group' && c !== movedGroup.findOne('.fallbackIcon'));
                if (controlsGroup && movedGroup.attrs.filePath.match(/\.(mp4|mov|avi|mkv|wmv|flv|webm)$/i)) {
                    controlsGroup.y(snappedH - 30);
                    controlsGroup.children[0].width(snappedW); // ctrlBg
                    controlsGroup.children[1].width(Math.max(0, snappedW - 45)); // progressBg
                    controlsGroup.children[5].width(Math.max(0, snappedW - 45)); // progressHotspot
                }
            }
        }
    }

    /**
     * Alt+拖拽：启动原生文件拖放，让用户可以把图片拖到外部应用
     * 直接调用 Electron 的 startDrag，它会接管当前鼠标手势启动 OS 拖拽
     */
    _startNativeDrag(filePathOrPaths) {
        const filePaths = Array.isArray(filePathOrPaths) ? filePathOrPaths : [filePathOrPaths];
        if (filePaths.length > 0 && window.flowCanvas?.drag) {
            window.flowCanvas.drag.start(filePaths.length === 1 ? filePaths[0] : filePaths);
        }
    }

    async _handlePaste() {
        console.log('[Canvas] 尝试粘贴图片...');
        const targetDir = this.storeData.defaultSaveFolder || (this.storeData.watchFolders && this.storeData.watchFolders[0]);
        const result = await window.flowCanvas.image.pasteFromClipboard(targetDir);
        if (result && result.success) {
            this._addCapturedFile(result.filePath);
        } else {
            console.warn('[Canvas] 粘贴失败:', result?.error);
        }
    }

    _addCapturedFile(filePath, dropEvent) {
        if (this._hasFilePath(filePath)) return;

        // 计算放置坐标
        let x = 0, y = 0;
        if (dropEvent) {
            // 将鼠标位置转换为画布坐标
            const stagePos = this.stage.position();
            const scale = this.stage.scaleX();
            x = (dropEvent.offsetX - stagePos.x) / scale;
            y = (dropEvent.offsetY - stagePos.y) / scale;
        } else {
            // Ctrl+V 粘贴：放在当前视口中心
            const stagePos = this.stage.position();
            const scale = this.stage.scaleX();
            const container = this.stage.container();
            x = (container.offsetWidth / 2 - stagePos.x) / scale;
            y = (container.offsetHeight / 2 - stagePos.y) / scale;
        }

        const data = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            filePath, x, y, addedAt: Date.now()
        };

        this._createCard(data);
        this.emit('capturedFile', data); // 通知 main.js 保存到 store
    }

    selectItem(id, add = false) {
        if (!add) this.clearSelection();
        this.selectedItems.add(id);
        this._updateSelectionVisuals();
    }

    clearSelection() {
        this.selectedItems.clear();
        this._updateSelectionVisuals();
    }

    selectAll() {
        this.items.forEach(item => {
            if (item.group.isVisible()) {
                this.selectedItems.add(item.data.id);
            }
        });
        this._updateSelectionVisuals();
    }

    _updateSelectionVisuals() {
        this.items.forEach(item => {
            const isSelected = this.selectedItems.has(item.data.id);
            const node = item.group.findOne('.displayNode') || item.group.findOne('.fallbackBg');
            if (node) {
                if (isSelected) {
                    node.stroke('#3a7bd5');
                    node.strokeWidth(3);
                } else {
                    node.stroke(null);
                    node.strokeWidth(0);
                }
            }
        });
    }

    // ── 清空画布上所有卡片（用于切换文件夹组） ──
    clearAll() {
        console.log('[Canvas] clearAll: 清除', this.items.size, '个卡片');
        this.items.forEach(item => {
            if (item.group) item.group.destroy();
            if (item.gifDomElement) item.gifDomElement.remove();
        });
        this.items.clear();
        this.selectedItems.clear();
        this.layer.batchDraw();
    }

    // ── 设置视口位置和缩放 ──
    setViewport(viewport) {
        if (viewport) {
            this.stage.position({ x: viewport.x || 0, y: viewport.y || 0 });
            this.stage.scale({ x: viewport.scale || 1, y: viewport.scale || 1 });
            this.stage.batchDraw();
            this.syncGifs();
            this.syncBackground();
        }
    }

    renderInitialItems() {
        const items = this.storeData.items || [];
        console.log('[Canvas] renderInitialItems: storeData.items 数量 =', items.length);
        items.forEach(item => this._createCard(item));
        console.log('[Canvas] renderInitialItems 完成: this.items.size =', this.items.size);
    }

    _getFileType(filePath) {
        const ext = filePath.split('.').pop().toLowerCase();
        if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tiff', 'tif'].includes(ext)) return 'image';
        if (['gif', 'mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm'].includes(ext)) return 'video';
        if (['mp3', 'wav', 'aac', 'flac', 'ogg'].includes(ext)) return 'audio';
        if (['pdf', 'doc', 'docx', 'txt', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) return 'document';
        return 'other';
    }

    async _createCard(data) {
        const fileType = this._getFileType(data.filePath);

        const group = new Konva.Group({
            x: data.x || 0, y: data.y || 0,
            draggable: true,
            id: data.id,
            name: 'nodeGroup',
            filePath: data.filePath
        });

        // 默认占位块（在图片未加载完成前或非图片文件时显示）
        const fallbackGroup = new Konva.Group({
            name: 'fallbackIcon'
        });

        const bg = new Konva.Rect({
            name: 'fallbackBg',
            width: DOC_DEFAULT_SIZE, height: DOC_DEFAULT_SIZE,
            fill: '#242430',
            cornerRadius: 8
        });

        const icon = new Konva.Text({
            width: DOC_DEFAULT_SIZE, height: DOC_DEFAULT_SIZE,
            text: fileType === 'image' ? '🖼️' : (fileType === 'video' ? '🎬' : '📄'),
            fontSize: 48, fill: '#555', align: 'center', verticalAlign: 'middle'
        });

        fallbackGroup.add(bg, icon);
        group.add(fallbackGroup);

        group.on('mouseenter', () => document.body.style.cursor = 'pointer');
        group.on('mouseleave', () => document.body.style.cursor = 'default');

        group.on('click', (e) => {
            if (e.evt.button === 2) return;
            if (e.evt.ctrlKey || e.evt.shiftKey) {
                if (this.selectedItems.has(data.id)) {
                    this.selectedItems.delete(data.id);
                    this._updateSelectionVisuals();
                } else {
                    this.selectItem(data.id, true);
                }
            }
        });

        group.on('contextmenu', (e) => {
            e.cancelBubble = true;
            if (!this.selectedItems.has(data.id)) {
                this.selectItem(data.id, false);
            }
            const selectedFiles = [];
            const selectedIds = [];
            this.selectedItems.forEach(id => {
                const item = this.items.get(id);
                if (item) {
                    selectedFiles.push(item.data.filePath);
                    selectedIds.push(id);
                }
            });
            this.contextMenu.show(e, { filePath: data.filePath, filePaths: selectedFiles, itemIds: selectedIds });
        });

        group.on('dblclick', () => window.flowCanvas.shell.openFile(data.filePath));

        this.layer.add(group);
        this.items.set(data.id, { group, data });

        const ext = data.filePath.split('.').pop().toLowerCase();
        const isGif = ext === 'gif';

        if (fileType === 'image' || isGif) {
            this._loadThumbnail(group, data);
        } else if (fileType === 'video') {
            this._loadVideo(group, data);
        }

        return group;
    }

    async _loadThumbnail(group, data, retryCount = 0) {
        const MAX_RETRIES = 5;
        const RETRY_DELAY = 1500; // ms
        const filePath = data.filePath;

        try {
            // 加时间戳防止浏览器缓存住失败的响应
            const imgUrl = 'local-res://' + encodeURIComponent(filePath) + '?t=' + Date.now();

            const imgObj = new window.Image();
            imgObj.onload = () => {
                // 如果 group 已被销毁（比如用户已经删除了该项），直接跳过
                if (!group.getLayer()) return;

                const aspect = imgObj.width / imgObj.height;
                const targetW = data.width || IMAGE_DEFAULT_WIDTH;
                const targetH = data.height || (targetW / aspect);

                data.width = targetW;
                data.height = targetH;

                const imageNode = new Konva.Image({
                    name: 'displayNode',
                    x: 0, y: 0,
                    image: imgObj,
                    width: targetW,
                    height: targetH
                });

                const fallback = group.findOne('.fallbackIcon');
                if (fallback) fallback.destroy();

                group.add(imageNode);
                imageNode.moveToBottom();

                if (this.selectedItems.has(group.attrs.id)) {
                    this._updateSelectionVisuals();
                }

                // 如果是 GIF，DOM 叠加层默认隐藏，hover 时才显示动画
                if (filePath.toLowerCase().endsWith('.gif')) {
                    const gifImg = document.createElement('img');
                    gifImg.src = imgUrl;
                    gifImg.style.position = 'absolute';
                    gifImg.style.top = '0';
                    gifImg.style.left = '0';
                    gifImg.style.width = `${targetW}px`;
                    gifImg.style.height = `${targetH}px`;
                    gifImg.style.pointerEvents = 'none';
                    gifImg.style.transformOrigin = 'top left';
                    gifImg.style.display = 'none'; // 默认隐藏，鼠标移入才显示

                    this.gifOverlay.appendChild(gifImg);
                    const itemEntry = this.items.get(filePath);
                    if (itemEntry) {
                        itemEntry.gifDomElement = gifImg;
                        group.on('dragmove', () => this.syncGifs());
                    }

                    // 鼠标移入 -> 显示 GIF 动画层, 移出 -> 隐藏(只显示 Konva 静态首帧)
                    group.on('mouseenter', () => {
                        this.syncGifs();
                        gifImg.style.display = 'block';
                    });
                    group.on('mouseleave', () => {
                        gifImg.style.display = 'none';
                    });

                    this.syncGifs();
                }

                group.getLayer().batchDraw();
            };
            imgObj.onerror = () => {
                if (retryCount < MAX_RETRIES) {
                    console.warn(`[Canvas] 图片加载失败，${RETRY_DELAY}ms 后重试 (${retryCount + 1}/${MAX_RETRIES}):`, filePath);
                    setTimeout(() => this._loadThumbnail(group, data, retryCount + 1), RETRY_DELAY);
                } else {
                    console.error('[Canvas] 图片加载最终失败（已重试' + MAX_RETRIES + '次）:', filePath);
                }
            };
            imgObj.src = imgUrl;
        } catch (err) {
            console.error('[Canvas] 图片异常:', filePath, err);
        }
    }

    // ── 视频内嵌播放 ──────────────────────────────────────
    _loadVideo(group, data) {
        const VIDEO_W = IMAGE_DEFAULT_WIDTH;
        const VIDEO_H = VIDEO_W * 9 / 16; // 默认 16:9

        // 创建一个隐藏的 HTML video 元素
        const video = document.createElement('video');
        video.src = 'local-res://' + encodeURIComponent(data.filePath);
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.style.display = 'none';
        document.body.appendChild(video);

        video.addEventListener('loadedmetadata', () => {
            if (!group.getLayer()) { video.remove(); return; }

            const aspect = video.videoWidth / video.videoHeight;
            const w = data.width || VIDEO_W;
            const h = data.height || (w / aspect);

            data.width = w;
            data.height = h;

            // 用 Konva.Image 从 video 元素创建可交互的画布节点
            const videoImage = new Konva.Image({
                name: 'displayNode',
                x: 0, y: 0,
                image: video,
                width: w, height: h
            });

            const fallback = group.findOne('.fallbackIcon');
            if (fallback) fallback.destroy();

            group.add(videoImage);

            // -- 进度条和控制按钮 --
            const controlsGroup = new Konva.Group({
                x: 0, y: h - 30, opacity: 0
            });

            const ctrlBg = new Konva.Rect({
                width: w, height: 30, fill: 'rgba(0,0,0,0.6)'
            });

            const playPauseBtnText = new Konva.Text({
                text: '▶', fontSize: 16, fill: 'white', x: 10, y: 7
            });

            // 增大按钮的热区
            const playPauseHotspot = new Konva.Rect({
                width: 30, height: 30, x: 0, y: 0,
                fill: 'transparent'
            });

            // 进度条背景
            const progressBg = new Konva.Rect({
                x: 35, y: 13, width: w - 45, height: 4, fill: '#555', cornerRadius: 2
            });

            // 进度条前景
            const progressFg = new Konva.Rect({
                x: 35, y: 13, width: 0, height: 4, fill: '#3a7bd5', cornerRadius: 2
            });

            // 进度条热区，方便点击
            const progressHotspot = new Konva.Rect({
                x: 35, y: 0, width: w - 45, height: 30,
                fill: 'transparent'
            });

            controlsGroup.add(ctrlBg, progressBg, progressFg, playPauseBtnText, playPauseHotspot, progressHotspot);
            group.add(controlsGroup);

            videoImage.moveToBottom();

            // 控制逻辑 —— 用 mousedown 替代 click，避免 Konva 动画层干扰点击检测
            playPauseHotspot.on('mousedown', (e) => {
                e.cancelBubble = true;
                e.evt.stopPropagation();
                if (video.paused) {
                    video.play().then(() => {
                        playPauseBtnText.text('⏸');
                        group.getLayer()?.batchDraw();
                    }).catch(() => { });
                } else {
                    video.pause();
                    playPauseBtnText.text('▶');
                    group.getLayer()?.batchDraw();
                }
            });

            // 进度跳转逻辑
            progressHotspot.on('mousedown', (e) => {
                e.cancelBubble = true;
                e.evt.stopPropagation();
                const ptrX = group.getRelativePointerPosition().x;
                let percent = (ptrX - 35) / (w - 45);
                percent = Math.max(0, Math.min(1, percent));
                video.currentTime = video.duration * percent;
            });

            // 播放视频动画帧刷新
            const anim = new Konva.Animation(() => {
                if (!video.paused && video.duration) {
                    progressFg.width((video.currentTime / video.duration) * (w - 45));
                }
            }, group.getLayer());
            anim.start();

            // 显示隐藏控制器
            group.on('mouseenter', () => {
                controlsGroup.opacity(1);
                group.getLayer()?.batchDraw();
            });
            group.on('mouseleave', () => {
                controlsGroup.opacity(0);
                group.getLayer()?.batchDraw();
            });

            group.getLayer().batchDraw();
        });

        video.addEventListener('error', () => {
            console.error('[Canvas] 视频加载失败:', data.filePath);
        });
    }

    addFile(filePath) {
        if (this._hasFilePath(filePath)) return null;

        // 计算当前视口中心（画布坐标）
        const stagePos = this.stage.position();
        const scale = this.stage.scaleX();
        const container = this.stage.container();
        const centerX = (container.offsetWidth / 2 - stagePos.x) / scale;
        const centerY = (container.offsetHeight / 2 - stagePos.y) / scale;

        // 随机错开偏移（±30px），产生堆叠散开效果
        const offsetX = (Math.random() - 0.5) * 60;
        const offsetY = (Math.random() - 0.5) * 60;

        const x = centerX - IMAGE_DEFAULT_WIDTH / 2 + offsetX;
        const y = centerY - IMAGE_DEFAULT_WIDTH / 2 + offsetY;

        const data = {
            id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
            filePath, x, y, addedAt: Date.now()
        };

        this._createCard(data);
        return data;
    }

    removeFile(filePath) {
        // 移除所有与此 filePath 关联的条目（可能有 Ctrl+拖拽的副本）
        const idsToRemove = [];
        this.items.forEach((item, id) => {
            if (item.data.filePath === filePath) idsToRemove.push(id);
        });
        idsToRemove.forEach(id => this.removeItemById(id));
    }

    removeItemById(id) {
        const item = this.items.get(id);
        if (item) {
            this.selectedItems.delete(id);
            if (item.gifDomElement) item.gifDomElement.remove();
            item.group.destroy();
            this.items.delete(id);
        }
    }

    _hasFilePath(filePath) {
        for (let [id, item] of this.items.entries()) {
            if (item.data.filePath === filePath) return true;
        }
        return false;
    }

    setFilter(types) {
        this.currentFilter = types; // 现在是数组
        this.items.forEach((item, id) => {
            const filePath = item.data.filePath;
            if (types.includes('all') || types.length === 0 || types.includes(this._getFileType(filePath))) {
                item.group.show();
                if (item.gifDomElement) item.gifDomElement.style.display = '';
            } else {
                item.group.hide();
                if (item.gifDomElement) item.gifDomElement.style.display = 'none';
            }
        });
        this.layer.batchDraw();
        this.syncGifs();
    }

    /**
     * 获取目标 items：有框选则返回框选的，否则返回全部可见的
     */
    _getTargetItems() {
        const targetItems = [];
        if (this.selectedItems.size > 0) {
            // 有框选内容，只操作框选的 items
            this.items.forEach(item => {
                if (this.selectedItems.has(item.data.id) && item.group.isVisible()) {
                    targetItems.push(item);
                }
            });
        } else {
            // 没有框选，操作全部可见内容
            this.items.forEach(item => {
                if (item.group.isVisible()) {
                    targetItems.push(item);
                }
            });
        }
        return targetItems;
    }
    exportAsMd() {
        if (this.items.size === 0) return;

        let markdownContent = `# Flow Canvas 引用清单\n\n`;
        markdownContent += `本文件包含当前白板上所有文件的绝对路径，可提供给 AI 作为上下文引用。\n\n`;

        // 按照视觉上的排列顺序导出（从上到下，从左到右）
        const sortedItems = Array.from(this.items.values()).sort((a, b) => {
            const rowDiff = Math.abs(a.group.y() - b.group.y());
            if (rowDiff < 50) return a.group.x() - b.group.x();
            return a.group.y() - b.group.y();
        });

        let index = 1;
        sortedItems.forEach(item => {
            const filePath = item.data.filePath;
            if (filePath) {
                const fileName = filePath.split(/[/\\]/).pop();
                markdownContent += `## ${index}. ${fileName}\n`;
                markdownContent += `- **路径**：\`${filePath}\`\n\n`;
                index++;
            }
        });

        const blob = new Blob([markdownContent], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `flow-canvas-files.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    fitAll() {
        if (this.items.size === 0) return;
        const targetItems = this._getTargetItems();
        if (targetItems.length === 0) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        targetItems.forEach(item => {
            const g = item.group;
            const node = g.findOne('.displayNode') || g.findOne('.fallbackIcon');
            const w = node ? (node.width() || DOC_DEFAULT_SIZE) : DOC_DEFAULT_SIZE;
            const h = node ? (node.height() || DOC_DEFAULT_SIZE) : DOC_DEFAULT_SIZE;
            minX = Math.min(minX, g.x()); minY = Math.min(minY, g.y());
            maxX = Math.max(maxX, g.x() + w); maxY = Math.max(maxY, g.y() + h);
        });
        if (minX === Infinity) return;
        const padding = 50;
        const container = this.stage.container();
        const scaleX = (container.offsetWidth - padding * 2) / (maxX - minX);
        const scaleY = (container.offsetHeight - padding * 2) / (maxY - minY);
        const scale = Math.min(scaleX, scaleY, 1);
        this.stage.scale({ x: scale, y: scale });
        this.stage.position({ x: padding - minX * scale, y: padding - minY * scale });
        this.emit('change');
    }

    packLayout() {
        // Shelf packing algorithm (紧凑瀑布流排列)
        const padding = 15;
        this._shelfLayout(padding);
    }

    seamlessLayout() {
        // 零间距无缝拼接
        this._shelfLayout(0);
    }

    _shelfLayout(padding) {
        const targetItems = this._getTargetItems();
        if (targetItems.length === 0) return;

        let layoutItems = [];
        targetItems.forEach(item => {
            const node = item.group.findOne('.displayNode') || item.group.findOne('.fallbackIcon');
            const w = node ? Math.max(1, node.width()) : DOC_DEFAULT_SIZE;
            const h = node ? Math.max(1, node.height()) : DOC_DEFAULT_SIZE;
            layoutItems.push({ item, w, h });
        });

        // 按高度降序排列，以便同行放置
        layoutItems.sort((a, b) => b.h - a.h);

        const maxWidth = this.stage.width() * 0.8 || 1000;
        let currentX = 0;
        let currentY = 0;
        let rowHeight = 0;

        // 如果只操作选中项，以第一个选中项的位置为起点
        if (this.selectedItems.size > 0 && layoutItems.length > 0) {
            let originX = Infinity, originY = Infinity;
            layoutItems.forEach(obj => {
                originX = Math.min(originX, obj.item.group.x());
                originY = Math.min(originY, obj.item.group.y());
            });
            currentX = originX;
            currentY = originY;
            const startX = currentX;

            layoutItems.forEach(obj => {
                if (currentX - startX + obj.w > maxWidth && currentX > startX) {
                    currentX = startX;
                    currentY += rowHeight + padding;
                    rowHeight = 0;
                }
                obj.item.group.to({ x: currentX, y: currentY, duration: 0.3, easing: Konva.Easings.EaseInOut });
                obj.item.data.x = currentX;
                obj.item.data.y = currentY;

                currentX += obj.w + padding;
                rowHeight = Math.max(rowHeight, obj.h);
            });
        } else {
            layoutItems.forEach(obj => {
                if (currentX + obj.w > maxWidth && currentX > 0) {
                    currentX = 0;
                    currentY += rowHeight + padding;
                    rowHeight = 0;
                }
                obj.item.group.to({ x: currentX, y: currentY, duration: 0.3, easing: Konva.Easings.EaseInOut });
                obj.item.data.x = currentX;
                obj.item.data.y = currentY;

                currentX += obj.w + padding;
                rowHeight = Math.max(rowHeight, obj.h);
            });
        }

        setTimeout(() => { this.emit('change'); this.syncGifs(); }, 300);
    }
}
