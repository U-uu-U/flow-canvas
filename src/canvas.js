// ============================================================
// Flow Canvas — Canvas Manager (Konva.js)
// ============================================================

import Konva from 'konva';
import { GraphView, viewportFixedScale } from './graph-view.js';
import { NODE_TYPES } from './node-types.js';
import { nodeIconSvg } from './node-icons.js';
import { GraphRunner, STATUS } from './graph-runner.js';
import {
    MAX_VIEWPORT_SCALE,
    MIN_VIEWPORT_SCALE,
    isCanvasTextContentVisible,
    normalizeWheelDelta,
    wheelZoomFactor,
    zoomViewportAtPoint
} from './viewport-zoom.js';
import { getSelectionToolbarPosition } from './selection-toolbar-layout.js';
import {
    moveCropRect,
    normalizeCropRect,
    resizeCropRect
} from './image-crop-layout.js';
import {
    getGeneratorComposerPosition,
    getGeneratorPlaceholderSize
} from './generator-placeholder-layout.js';
import {
    appendGeneratorResult,
    clearGeneratorResults,
    ensureGeneratorResultEntries,
    getGeneratorResultEntries,
    keepFirstGeneratorResult,
    removeGeneratorResultByFilePath,
    rotateGeneratorResults
} from './generator-result-stack.js';
import {
    IMAGE_ASPECT_RATIOS,
    IMAGE_RESOLUTION_TIERS,
    inferImageAspectRatio,
    inferImageResolutionTier,
    resolveGenerationDisplaySize,
    resolveImageDimensions
} from './image-node-settings.js';
import {
    VIDEO_CONTROL_BUTTON_WIDTH,
    VIDEO_CONTROL_HEIGHT,
    VIDEO_CONTROL_PROGRESS_RIGHT_PADDING,
    VIDEO_CONTROL_PROGRESS_X,
    getVideoControlLayout
} from './video-control-layout.js';
import {
    DEFAULT_SHORTCUTS,
    SHORTCUTS_CHANGED_EVENT,
    loadShortcutBindings,
    matchesShortcut,
    normalizeShortcutBindings
} from './shortcut-settings.js';

const OP_NODE_WIDTH = 300;
const OP_NODE_HEIGHT = 156;
const OP_NODE_HEIGHTS = {
    text: 210,
    image: 300,
    video: 236,
    batch: 156
};
const OP_NODE_FOOTER_HEIGHT = 48;
const OP_NODE_PROMPT_TOP = 43;
const OP_GENERATOR_REFERENCE_TOP = 42;
const OP_GENERATOR_PROMPT_TOP = 96;
const GENERATION_COMPOSER_CARET_ANCHOR = '\u200B';
const OP_STATUS_COLORS = {
    error: '#ef4444'
};
const OP_STATUS_LABELS = {
    idle: '待生成',
    queued: '排队中',
    running: '生成中',
    done: '已完成',
    error: '生成失败'
};
const NODE_GLYPH_PATHS = {
    image: 'M3 4H17V16H3Z M5 13L8 10L10.5 12.5L13 9.5L17 14 M6.5 7.5H6.6',
    video: 'M3 4H17V16H3Z M7 4V16 M13 4V16 M9 8L13 10L9 12Z',
    audio: 'M4 8H7L11 5V15L7 12H4Z M14 7C16 9 16 11 14 13',
    document: 'M5 3H12L16 7V17H5Z M12 3V7H16 M8 10H13 M8 13H13',
    text: 'M4 5H16 M4 9H14 M4 13H12 M4 17H9',
    batch: 'M3 6L10 3L17 6L10 9Z M3 10L10 13L17 10 M3 14L10 17L17 14'
};

const IMAGE_DEFAULT_WIDTH = 300;
const DOC_DEFAULT_SIZE = 150;
const AUDIO_NODE_WIDTH = 300;
const AUDIO_NODE_HEIGHT = 96;
const CANVAS_BOUNDARY_MIN_WIDTH = 1400;
const CANVAS_BOUNDARY_MIN_HEIGHT = 1000;
const CANVAS_BOUNDARY_PADDING = 260;
const VIDEO_PLACEHOLDER_LONG_EDGE = 320;
const VIDEO_PLACEHOLDER_DEFAULT_RATIO = 16 / 9;
const PLAN_NODE_WIDTH = 1440;
const PLAN_NODE_HEIGHT = 620;
const PLAN_ROW_HEIGHT = 58;
const PLAN_CELL_LINE_HEIGHT = 16;
const PLAN_CELL_VERTICAL_PADDING = 18;
const PLAN_CELL_HEIGHT_ALLOWANCE = 10;
const PLAN_LAST_CELL_TOOLBAR_SPACE = 126;
const PLAN_HANDLE_X = -16;
const PLAN_OUTPUT_HANDLE_X_OFFSET = 16;
const PLAN_HANDLE_RADIUS = 7;
const PLAN_CONNECTION_BADGE_HEIGHT = 16;
const PLAN_SOURCE_CONNECTION_COLOR = '#b9bcc2';
const PLAN_OUTPUT_CONNECTION_COLOR = '#eceef1';
const PLAN_CONNECTION_PREVIEW_COLOR = '#34d399';
const PLAN_CONNECTION_LABEL_MAX_WIDTH = 180;
const PLAN_CONNECTION_SELECTED_LABEL_MAX_WIDTH = 260;
const PLAN_CONNECTION_LABEL_HEIGHT = 24;
const PLAN_CONNECTION_TOOLBAR_HEIGHT = 22;
const PLAN_CONNECTION_FOCUS_CARD_WIDTH = 310;
const PLAN_CONNECTION_FOCUS_CARD_HEIGHT = 92;
const PLAN_CONNECTION_HINT_HEIGHT = 24;
const PLAN_CONNECTION_PREVIEW_LABEL_MAX_WIDTH = 210;
const PLAN_CONNECTION_PREVIEW_LABEL_HEIGHT = 26;
const PLAN_CONNECTION_FANOUT_GAP = 10;
const PLAN_CONNECTION_FANOUT_MAX = 24;
const PLAN_CONNECTION_STYLES = {
    source: {
        color: PLAN_SOURCE_CONNECTION_COLOR,
        activeColor: '#d5d7db',
        halo: 'rgba(255, 255, 255, 0.12)',
        mutedOpacity: 0.34,
        activeOpacity: 0.82,
        mutedWidth: 1.5,
        activeWidth: 2.6,
        dash: [7, 9]
    },
    output: {
        color: PLAN_OUTPUT_CONNECTION_COLOR,
        activeColor: '#ffffff',
        halo: 'rgba(255, 255, 255, 0.16)',
        mutedOpacity: 0.72,
        activeOpacity: 0.96,
        mutedWidth: 2.2,
        activeWidth: 3.2,
        dash: []
    }
};
const PLAN_HEADER_ROW_HEIGHT = 28;
const INTERNAL_PROCESS_FILE_PREFIXES = ['flow_source_builtin_', 'flow_builtin_'];
const DEFAULT_STATUS_OPTIONS = ['未开始', '进行中', '待确认', '已完成'];

function normalizeDroppedText(value) {
    return String(value || '')
        .replace(/&amp;/gi, '&')
        .replace(/\\u002f/gi, '/')
        .replace(/\\\//g, '/');
}

function collectDroppedUrls(value) {
    const text = normalizeDroppedText(value);
    const urls = text.match(/https?:\/\/[^\s<>"']+/gi) || [];
    const encodedUrls = text.match(/https?%3a%2f%2f[^\s<>"']+/gi) || [];
    encodedUrls.forEach(url => {
        try {
            urls.push(decodeURIComponent(url));
        } catch (_) {
            // Ignore malformed encoded URLs.
        }
    });
    const relativePin = /(?:^|["'\s])(\/pin\/\d+\/?)(?=$|["'\s?#])/i.exec(text)?.[1];
    if (relativePin) urls.push(`https://www.pinterest.com${relativePin}`);
    const trimmed = text.trim();
    if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(trimmed)) urls.push(trimmed);
    return urls;
}

function scoreDroppedImageUrl(url, source = '', descriptor = '') {
    let score = 0;
    if (/^data:image\//i.test(url)) score += 700;
    if (/\.pinimg\.com\//i.test(url)) score += 500;
    if (/\.pinimg\.com\/originals\//i.test(url)) score += 400;
    const pinWidth = /\.pinimg\.com\/(\d+)x\//i.exec(url)?.[1];
    if (pinWidth) score += Math.min(300, Number.parseInt(pinWidth, 10) / 3);
    if (/\.(?:jpe?g|png|webp|gif|bmp|tiff?)(?:[?#]|$)/i.test(url)) score += 180;
    if (source === 'srcset') score += 80;
    if (source === 'img') score += 50;
    const width = Number.parseInt(descriptor, 10);
    if (Number.isFinite(width)) score += Math.min(100, width / 20);
    if (/pinterest\.[^/]+\/pin\//i.test(url)) score -= 200;
    return score;
}

function collectDroppedImageUrls(dataTransfer, extraPayloads = []) {
    const candidates = [];
    const add = (value, source = '', descriptor = '') => {
        collectDroppedUrls(value).forEach(url => {
            candidates.push({ url, score: scoreDroppedImageUrl(url, source, descriptor) });
            const resizedPin = /^(https?:\/\/i\.pinimg\.com\/)(?:\d+x)(\/.*)$/i.exec(url);
            if (resizedPin && !/\/736x\//i.test(url)) {
                const largerUrl = `${resizedPin[1]}736x${resizedPin[2]}`;
                candidates.push({
                    url: largerUrl,
                    score: scoreDroppedImageUrl(largerUrl, 'srcset', '736w')
                });
            }
        });
    };

    const html = dataTransfer?.getData?.('text/html') || '';
    if (html) {
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            doc.querySelectorAll('img, source, video, image, [style]').forEach(element => {
                ['src', 'data-src', 'data-original', 'data-lazy-src', 'poster', 'href', 'xlink:href'].forEach(attribute => {
                    add(element.getAttribute(attribute), 'img');
                });
                ['srcset', 'data-srcset'].forEach(attribute => {
                    String(element.getAttribute(attribute) || '').split(',').forEach(entry => {
                        const [candidateUrl, descriptor] = entry.trim().split(/\s+/, 2);
                        add(candidateUrl, 'srcset', descriptor);
                    });
                });
                add(element.getAttribute('style'), 'style');
            });
            doc.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"], a[href]').forEach(element => {
                add(element.getAttribute('content') || element.getAttribute('href'), 'html');
            });
        } catch (error) {
            console.warn('[Canvas] HTML drop parsing failed:', error);
        }
        add(html, 'html-raw');
    }

    const handledTypes = new Set(['text/html']);
    Array.from(dataTransfer?.types || []).forEach(type => {
        const normalizedType = String(type || '').toLowerCase();
        if (!type || normalizedType === 'files' || handledTypes.has(normalizedType)) return;
        try {
            add(dataTransfer.getData(type), normalizedType);
            handledTypes.add(normalizedType);
        } catch (_) {
            // Some browser-specific drag formats cannot be read outside their source app.
        }
    });
    ['text/uri-list', 'text/plain', 'text/x-moz-url', 'text/x-moz-url-data', 'url', 'downloadurl'].forEach(type => {
        if (handledTypes.has(type)) return;
        try {
            add(dataTransfer?.getData?.(type), type);
        } catch (_) {
            // Try the remaining known formats.
        }
    });
    extraPayloads.forEach(payload => add(payload?.value, payload?.type || 'drag-item'));

    const bestByUrl = new Map();
    candidates.forEach(candidate => {
        const normalizedUrl = candidate.url.replace(/[),.;]+$/, '');
        const previous = bestByUrl.get(normalizedUrl);
        if (!previous || candidate.score > previous.score) {
            bestByUrl.set(normalizedUrl, { ...candidate, url: normalizedUrl });
        }
    });
    return [...bestByUrl.values()]
        .sort((left, right) => right.score - left.score)
        .map(candidate => candidate.url);
}

export class CanvasManager {
    constructor(containerId, storeData, contextMenu, planService = null, options = {}) {
        this.options = options;
        this.storeData = storeData;
        this.contextMenu = contextMenu;
        this.planService = planService;
        this.listeners = {};
        this.items = new Map();
        this.plans = new Map();
        this.selectedItems = new Set();
        this.currentFilter = 'all';
        this.isAltPressed = false;
        this.shortcutBindings = loadShortcutBindings();
        document.addEventListener(SHORTCUTS_CHANGED_EVENT, event => {
            this.shortcutBindings = normalizeShortcutBindings(event.detail);
        });

        const container = document.getElementById(containerId);
        this.container = container;
        this.stage = new Konva.Stage({
            container: containerId,
            width: container.offsetWidth,
            height: container.offsetHeight,
            draggable: true
        });

        // ── 修复加载光标：阻止浏览器原生 HTML5 拖拽行为 ──
        container.addEventListener('dragstart', (e) => {
            if (e.target === this.nativeDragProxy) return;
            e.preventDefault();
        });
        if (!container.style.position) container.style.position = 'relative';
        container.style.cursor = 'default';
        this._createSelectionToolbar();

        this.boundaryLayer = new Konva.Layer({ listening: false });
        this.canvasBoundary = new Konva.Rect({
            listening: false,
            visible: false,
            fill: 'transparent',
            stroke: 'transparent',
            strokeWidth: 1,
            dash: [10, 8],
            strokeScaleEnabled: false,
            perfectDrawEnabled: false
        });
        this.boundaryLayer.add(this.canvasBoundary);
        this.stage.add(this.boundaryLayer);
        this._canvasBounds = null;
        this._minimapDrawPending = false;
        this._minimapTransform = null;
        this._minimapUserVisible = false;
        this._gridVisible = true;
        this._connectionsVisible = true;
        this._autoSnapEnabled = this.storeData.autoSnapEnabled !== false;

        this.layer = new Konva.Layer();
        this.stage.add(this.layer);

        this.transientLayer = new Konva.Layer();
        this.stage.add(this.transientLayer);

        this.graphView = new GraphView(this, Konva);
        this.generationPlaceholders = new Map();
        this.pendingGenerationPlacements = new Map();

        this.selectionRect = new Konva.Rect({
            fill: 'rgba(255, 255, 255, 0.1)',
            stroke: '#b9bcc2',
            strokeWidth: 1,
            visible: false,
        });
        this.layer.add(this.selectionRect);

        this.imageTransformer = new Konva.Transformer({
            enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
            rotateEnabled: false,
            keepRatio: true,
            flipEnabled: false,
            ignoreStroke: true,
            borderStroke: '#b9bcc2',
            borderStrokeWidth: 1.5,
            anchorFill: '#f8fbff',
            anchorStroke: '#b9bcc2',
            anchorStrokeWidth: 2,
            anchorSize: 11,
            anchorCornerRadius: 6,
            padding: 2,
            boundBoxFunc: (oldBox, newBox) => {
                if (Math.abs(newBox.width) < 48 || Math.abs(newBox.height) < 48) return oldBox;
                return newBox;
            }
        });
        this.imageTransformer.on('transformstart', () => this._beginImageResize());
        this.imageTransformer.on('transform', () => this._updateImageResize());
        this.imageTransformer.on('transformend', () => this._finishImageResize());
        this.layer.add(this.imageTransformer);

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

        this.nativeDragProxy = document.createElement('div');
        this.nativeDragProxy.draggable = true;
        Object.assign(this.nativeDragProxy.style, {
            position: 'absolute',
            inset: '0',
            opacity: '0',
            pointerEvents: 'none',
            zIndex: '30',
            cursor: 'copy'
        });
        container.appendChild(this.nativeDragProxy);
        this._nativeDragProxyActive = false;

        this.planInlineLayer = document.createElement('div');
        this.planInlineLayer.className = 'plan-inline-layer';
        container.appendChild(this.planInlineLayer);
        this.opInlineLayer = document.createElement('div');
        this.opInlineLayer.className = 'op-inline-layer';
        container.appendChild(this.opInlineLayer);
        this._activeOpPromptEditor = null;
        this._textNodeEditors = new Map();
        this._textNodeChangeTimers = new Map();
        this._activeMediaTitleEditor = null;
        this._visualExtractingNodeIds = new Set();
        this._generationComposer = null;
        this._generationTypeMenu = null;
        this._activeImageCrop = null;
        this._imageCropPointerCleanup = null;
        this._activeNodeReferenceTargetId = null;
        this.planInlineEditors = new Map();
        this._inlinePlanChangeTimers = new Map();
        this._hoveredPlanId = null;
        this._hoveredPlanRowKey = null;
        this._hoveredReferenceItem = null;
        this._hoveredMediaItemId = null;
        this._hoveredConnectionTargetId = null;
        this._selectedPlanConnection = null;
        this._activePlanReferencePick = null;
        this._planReferencePickTargetId = null;
        this._activeMediaReferencePick = null;
        this._mediaReferenceSelections = { image: [], video: [], audio: [] };
        this._mediaReferenceHighlightIds = new Set();
        this._lastMediaReferencePointerPick = null;
        this._referenceHighlightIds = new Set();
        this._isDraggingPlanReference = false;
        this._isGeneratingPlanRow = false;
        this._dragConnectionRefreshTimer = null;
        this._lastDragConnectionRefreshAt = 0;
        this._setupCanvasMinimap();
        this._setupCanvasViewDock();
        this._setupCanvasToolRail();

        if (storeData.viewport) {
            const initialScale = Math.max(
                MIN_VIEWPORT_SCALE,
                Math.min(MAX_VIEWPORT_SCALE, Number(storeData.viewport.scale) || 1)
            );
            this.stage.position({ x: storeData.viewport.x, y: storeData.viewport.y });
            this.stage.scale({ x: initialScale, y: initialScale });
        }

        // ── 性能优化：rAF 合并高频事件 ──
        this._rafPending = false;
        this._wheelZoomFrame = 0;
        this._wheelZoomDelta = 0;
        this._wheelZoomPointer = null;
        this._bgCachedScale = -1;   // 缓存上次 SVG 对应的 scale
        this._bgCachedSvg = '';     // 缓存的 SVG data URI
        this._bgCachedSize = 0;     // 缓存的 screenSize

        // ── 内容加载调度：卡片分批创建完成后，素材全量常驻加载 ──
        this._cullPending = false;
        this._cullTimer = null;     // 节流定时器
        this._CULL_THROTTLE_MS = 150; // culling 检查最小间隔
        this._CULL_IDLE_MS = 240;   // 平移/缩放停止后再加载，避免拖动时解码图片
        this._renderGeneration = 0;
        this._contentLoadQueue = [];
        this._activeContentLoads = 0;
        this._MAX_CONTENT_LOADS = 4;
        this.resourceSaverMode = !!this.storeData.resourceSaver;
        this._RESOURCE_HOVER_DELAY_MS = 450;

        this.stage.on('xChange yChange scaleXChange scaleYChange', () => {
            if (!this._rafPending) {
                this._rafPending = true;
                requestAnimationFrame(() => {
                    this._rafPending = false;
                    this._syncHoveredMediaItemAtPointer();
                    this._scheduleSelectionToolbarSync();
                    this._positionImageCropOverlay();
                    this.syncGifs();
                    this.syncBackground();
                    this._syncViewportFixedControls();
                    this.syncPlanInlineEditors();
                    this._syncPersistentTextEditors();
                    this._positionOpPromptEditor();
                    this._positionMediaTitleEditor();
                    this._positionGenerationComposer();
                    this._syncCanvasViewDock();
                    this._scheduleMinimapDraw();
                    this.graphView?.scheduleVisiblePortsRefresh();
                    this._scheduleCullCheck(this._CULL_IDLE_MS);
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
            this.syncPlanInlineEditors();
            this._syncPersistentTextEditors();
            this._positionOpPromptEditor();
            this._positionMediaTitleEditor();
            this._positionGenerationComposer();
            this._scheduleSelectionToolbarSync();
            this._positionImageCropOverlay();
            this._refreshCanvasBoundary();
            this.graphView?.scheduleVisiblePortsRefresh(0);
        });
        ro.observe(container);

        document.addEventListener('context-remove', (e) => {
            let changed = false;
            if (e.detail.planIds) {
                e.detail.planIds.forEach(id => this.removePlanById(id));
                changed = true;
                this.emit('plansChanged');
            }
            if (e.detail.itemIds) {
                e.detail.itemIds.forEach(id => this.removeItemById(id));
                changed = true;
            } else if (e.detail.filePaths) {
                e.detail.filePaths.forEach(p => this.removeFile(p));
                changed = true;
            } else if (e.detail.filePath) {
                this.removeFile(e.detail.filePath);
                changed = true;
            }
            if (changed) this.emit('change');
        });

        document.addEventListener('context-edit-node', event => {
            const nodeId = event.detail?.nodeId;
            if (nodeId) this.openOpNodeEditor(nodeId);
        });

        document.addEventListener('context-run-node', event => {
            const nodeId = event.detail?.nodeId;
            if (nodeId) void this.runFromNode(nodeId);
        });

        document.addEventListener('context-duplicate-node', event => {
            this.duplicateItems(event.detail?.itemIds || []);
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
        if (!this._gridVisible) {
            gridEl.style.opacity = '0';
            return;
        }

        const scale = this.stage.scaleX();
        const pos = this.stage.position();

        const GRID_SIZE = 32;
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

            const dotR = Math.max(0.55, Math.min(1.05, scale * 0.72));
            const dotColor = `rgba(255,255,255,${(opacity * 0.11).toFixed(3)})`;
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

    _setupCanvasMinimap() {
        this.minimapPanel = document.getElementById('canvasMinimap');
        this.minimapCanvas = document.getElementById('canvasMinimapMap');
        this.minimapZoom = document.getElementById('canvasMinimapZoom');
        this.minimapFitButton = document.getElementById('canvasMinimapFit');
        if (!this.minimapCanvas) return;

        this.minimapFitButton?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.fitAll();
        });

        const finishDrag = (event) => {
            if (!this._minimapDragging) return;
            this._minimapDragging = false;
            this._minimapDragOffset = null;
            this.minimapCanvas.classList.remove('is-dragging');
            try { this.minimapCanvas.releasePointerCapture(event.pointerId); } catch (_) { }
            this.emit('change');
        };

        const navigate = (event, preserveOffset = true) => {
            const transform = this._minimapTransform;
            if (!transform) return;
            const rect = this.minimapCanvas.getBoundingClientRect();
            const mapX = event.clientX - rect.left;
            const mapY = event.clientY - rect.top;
            let worldX = (mapX - transform.offsetX) / transform.scale + transform.bounds.x;
            let worldY = (mapY - transform.offsetY) / transform.scale + transform.bounds.y;
            if (preserveOffset && this._minimapDragOffset) {
                worldX -= this._minimapDragOffset.x;
                worldY -= this._minimapDragOffset.y;
            }
            this._centerViewportAt(worldX, worldY);
        };

        this.minimapCanvas.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || !this._minimapTransform) return;
            event.preventDefault();
            event.stopPropagation();
            const rect = this.minimapCanvas.getBoundingClientRect();
            const mapX = event.clientX - rect.left;
            const mapY = event.clientY - rect.top;
            const viewport = this._minimapViewportRect;
            if (viewport && mapX >= viewport.x && mapX <= viewport.x + viewport.width
                && mapY >= viewport.y && mapY <= viewport.y + viewport.height) {
                const transform = this._minimapTransform;
                const worldX = (mapX - transform.offsetX) / transform.scale + transform.bounds.x;
                const worldY = (mapY - transform.offsetY) / transform.scale + transform.bounds.y;
                const center = this._getViewportCenter();
                this._minimapDragOffset = { x: worldX - center.x, y: worldY - center.y };
            } else {
                this._minimapDragOffset = null;
                navigate(event, false);
            }
            this._minimapDragging = true;
            this.minimapCanvas.classList.add('is-dragging');
            this.minimapCanvas.setPointerCapture(event.pointerId);
        });

        this.minimapCanvas.addEventListener('pointermove', (event) => {
            if (!this._minimapDragging) return;
            event.preventDefault();
            navigate(event, true);
        });
        this.minimapCanvas.addEventListener('pointerup', finishDrag);
        this.minimapCanvas.addEventListener('pointercancel', finishDrag);

        this.minimapCanvas.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.fitAll();
                return;
            }
            const directions = {
                ArrowLeft: [-1, 0],
                ArrowRight: [1, 0],
                ArrowUp: [0, -1],
                ArrowDown: [0, 1]
            };
            const direction = directions[event.key];
            if (!direction) return;
            event.preventDefault();
            const center = this._getViewportCenter();
            const stepX = this.stage.width() / this.stage.scaleX() * 0.12;
            const stepY = this.stage.height() / this.stage.scaleY() * 0.12;
            this._centerViewportAt(center.x + direction[0] * stepX, center.y + direction[1] * stepY);
            this.emit('change');
        });
    }

    _setupCanvasViewDock() {
        this.canvasMinimapToggle = document.getElementById('canvasMinimapToggle');
        this.canvasConnectionsToggle = document.getElementById('canvasConnectionsToggle');
        this.canvasGridToggle = document.getElementById('canvasGridToggle');
        this.canvasSnapToggle = document.getElementById('canvasSnapToggle');
        this.canvasFitToggle = document.getElementById('canvasFitToggle');

        const stop = (event) => {
            event.preventDefault();
            event.stopPropagation();
        };

        this.canvasMinimapToggle?.addEventListener('click', (event) => {
            stop(event);
            this._minimapUserVisible = !this._minimapUserVisible;
            const hasEntries = this._collectCanvasOverviewEntries().length > 0;
            if (this.minimapPanel) this.minimapPanel.hidden = !this._minimapUserVisible || !hasEntries;
            this._scheduleMinimapDraw();
            this._syncCanvasViewDock();
        });

        this.canvasConnectionsToggle?.addEventListener('click', (event) => {
            stop(event);
            this._connectionsVisible = !this._connectionsVisible;
            this.graphView?.setConnectionsVisible(this._connectionsVisible);
            this._syncCanvasViewDock();
        });

        this.canvasGridToggle?.addEventListener('click', (event) => {
            stop(event);
            this._gridVisible = !this._gridVisible;
            this._bgCachedScale = -1;
            this.syncBackground();
            this._syncCanvasViewDock();
        });

        this.canvasSnapToggle?.addEventListener('click', (event) => {
            stop(event);
            this._autoSnapEnabled = !this._autoSnapEnabled;
            this.storeData.autoSnapEnabled = this._autoSnapEnabled;
            this._syncCanvasViewDock();
            this._showCanvasStatus(this._autoSnapEnabled ? '已开启自动吸附' : '已关闭自动吸附');
            this.emit('change');
        });

        this.canvasFitToggle?.addEventListener('click', (event) => {
            stop(event);
            this.fitAll();
        });

        this._syncCanvasViewDock();
    }

    _setupCanvasToolRail() {
        const projectChip = document.getElementById('canvasProjectChip');
        const addButton = document.getElementById('canvasToolAdd');
        const searchButton = document.getElementById('canvasToolSearch');
        const planButton = document.getElementById('canvasToolPlan');
        const tasksButton = document.getElementById('canvasToolTasks');
        this.canvasNodeSearch = document.getElementById('canvasNodeSearch');
        this.canvasNodeSearchInput = document.getElementById('canvasNodeSearchInput');
        this.canvasNodeSearchResults = document.getElementById('canvasNodeSearchResults');

        projectChip?.addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('open-folder-groups'));
        });
        planButton?.addEventListener('click', () => document.getElementById('newPlanBtn')?.click());
        tasksButton?.addEventListener('click', () => document.getElementById('agentTaskHistoryBtn')?.click());

        addButton?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const rect = addButton.getBoundingClientRect();
            this._showInsertNodeMenu({
                clientX: rect.right + 8,
                clientY: rect.top,
                insertAt: this._getViewportCenter()
            });
        });

        searchButton?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            document.dispatchEvent(new CustomEvent('close-asset-library'));
            this._toggleCanvasNodeSearch();
        });
        this.canvasNodeSearchInput?.addEventListener('input', () => this._renderCanvasNodeSearchResults());
        this.canvasNodeSearchInput?.addEventListener('keydown', event => {
            if (event.key === 'Escape') this._toggleCanvasNodeSearch(false);
            if (event.key === 'Enter') this.canvasNodeSearchResults?.querySelector('button')?.click();
        });

        document.addEventListener('mousedown', event => {
            if (this.canvasNodeSearch?.hidden) return;
            if (this.canvasNodeSearch.contains(event.target) || searchButton?.contains(event.target)) return;
            this._toggleCanvasNodeSearch(false);
        });

        const groupList = document.getElementById('folderGroupList');
        if (groupList) {
            this._canvasProjectObserver = new MutationObserver(() => this._syncCanvasProjectName());
            this._canvasProjectObserver.observe(groupList, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['class']
            });
        }
        this._syncCanvasProjectName();
    }

    _syncCanvasProjectName() {
        const label = document.getElementById('canvasProjectName');
        if (!label) return;
        const activeName = document.querySelector('.folder-group-item.active .group-name')?.textContent?.trim();
        label.textContent = activeName || 'Flow Canvas';
    }

    _toggleCanvasNodeSearch(force) {
        if (!this.canvasNodeSearch) return;
        const shouldOpen = typeof force === 'boolean' ? force : this.canvasNodeSearch.hidden;
        this.canvasNodeSearch.hidden = !shouldOpen;
        document.getElementById('canvasToolSearch')?.classList.toggle('active', shouldOpen);
        if (!shouldOpen) return;
        this.canvasNodeSearchInput.value = '';
        this._renderCanvasNodeSearchResults();
        requestAnimationFrame(() => this.canvasNodeSearchInput?.focus());
    }

    _renderCanvasNodeSearchResults() {
        const host = this.canvasNodeSearchResults;
        if (!host) return;
        const query = String(this.canvasNodeSearchInput?.value || '').trim().toLowerCase();
        const results = [];
        this.items.forEach((entry, id) => {
            if (!entry?.group?.isVisible?.()) return;
            const data = entry.data || {};
            const mediaType = data.kind === 'op' ? data.nodeType : this._getItemMediaType(data);
            const title = data.kind === 'op'
                ? (data.title || NODE_TYPES[data.nodeType]?.title || '节点')
                : (mediaType === 'image'
                    ? this._mediaDisplayName(data, mediaType)
                    : (this._fileNameFromPath(data.filePath) || `空${this._nodeTypeLabel(mediaType, data)}节点`));
            const haystack = `${title} ${mediaType} ${data.filePath || ''}`.toLowerCase();
            if (query && !haystack.includes(query)) return;
            results.push({ id, title, mediaType, entry });
        });

        results.sort((left, right) => left.title.localeCompare(right.title, 'zh-CN'));
        host.replaceChildren();
        if (!results.length) {
            const empty = document.createElement('div');
            empty.className = 'canvas-node-search-empty';
            empty.textContent = '没有匹配的节点或素材';
            host.appendChild(empty);
            return;
        }

        results.slice(0, 80).forEach(result => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'canvas-node-search-result';
            const iconId = result.mediaType === 'video'
                ? 'icon-video'
                : result.mediaType === 'audio'
                    ? 'icon-audio'
                    : result.mediaType === 'image'
                        ? 'icon-image'
                        : 'icon-canvas';
            button.innerHTML = `<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#${iconId}"></use></svg><span></span>`;
            button.querySelector('span').textContent = result.title;
            button.addEventListener('click', () => {
                this._focusCanvasNode(result.id);
                this._toggleCanvasNodeSearch(false);
            });
            host.appendChild(button);
        });
    }

    _focusCanvasNode(nodeId) {
        const entry = this._getNodeEntry(nodeId);
        if (!entry?.group) return;
        const node = entry.group.findOne('.displayNode')
            || entry.group.findOne('.fallbackBg')
            || entry.group.findOne('.planHitArea');
        const width = Number(entry.data?.width) || Number(node?.width?.()) || 1;
        const height = Number(entry.data?.height) || Number(node?.height?.()) || 1;
        const scale = Math.max(0.35, Math.min(1.5, this.stage.scaleX()));
        this.stage.scale({ x: scale, y: scale });
        this.stage.position({
            x: this.stage.width() / 2 - (entry.group.x() + width / 2) * scale,
            y: this.stage.height() / 2 - (entry.group.y() + height / 2) * scale
        });
        this.selectItem(nodeId, false);
        this.stage.batchDraw();
        this.syncBackground();
        this.syncGifs();
        this.syncPlanInlineEditors();
        this.graphView?.sync();
        this._syncCanvasViewDock();
        this.emit('change');
    }

    _setCanvasScale(nextScale) {
        const oldScale = this.stage.scaleX();
        const scale = Math.max(
            MIN_VIEWPORT_SCALE,
            Math.min(MAX_VIEWPORT_SCALE, Number(nextScale) || 1)
        );
        if (Math.abs(scale - oldScale) < 0.0001) return;
        const center = { x: this.stage.width() / 2, y: this.stage.height() / 2 };
        const worldCenter = {
            x: (center.x - this.stage.x()) / oldScale,
            y: (center.y - this.stage.y()) / oldScale
        };
        this.stage.scale({ x: scale, y: scale });
        this.stage.position({
            x: center.x - worldCenter.x * scale,
            y: center.y - worldCenter.y * scale
        });
        this.stage.batchDraw();
        this.emit('change');
    }

    _syncCanvasViewDock() {
        const syncToggle = (button, active, labels) => {
            if (!button) return;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
            button.title = active ? labels.on : labels.off;
            button.setAttribute('aria-label', button.title);
        };
        syncToggle(this.canvasMinimapToggle, this._minimapUserVisible, { on: '隐藏小地图', off: '显示小地图' });
        syncToggle(this.canvasConnectionsToggle, this._connectionsVisible, { on: '隐藏节点连线', off: '显示节点连线' });
        syncToggle(this.canvasGridToggle, this._gridVisible, { on: '隐藏画布点阵', off: '显示画布点阵' });
        syncToggle(this.canvasSnapToggle, this._autoSnapEnabled, { on: '关闭自动吸附', off: '开启自动吸附' });
    }

    _getEntryCanvasRect(entry) {
        const group = entry?.group;
        if (!group || group.isDestroyed?.()) return null;
        const node = group.findOne?.('.displayNode')
            || group.findOne?.('.fallbackIcon')
            || group.findOne?.('.fallbackBg')
            || group.findOne?.('.planHitArea');
        let relative = null;
        try {
            relative = node?.getClientRect?.({ relativeTo: group, skipShadow: true, skipStroke: true });
        } catch (_) { }
        const width = Math.max(1, Number(relative?.width)
            || Number(entry.data?.node?.width)
            || Number(entry.data?.width)
            || DOC_DEFAULT_SIZE);
        const height = Math.max(1, Number(relative?.height)
            || Number(entry.data?.node?.height)
            || Number(entry.data?.height)
            || DOC_DEFAULT_SIZE);
        const x = Number(group.x()) + (Number(relative?.x) || 0);
        const y = Number(group.y()) + (Number(relative?.y) || 0);
        if (![x, y, width, height].every(Number.isFinite)) return null;
        return { x, y, width, height };
    }

    _collectCanvasOverviewEntries() {
        const entries = [];
        this.items.forEach(entry => {
            const rect = this._getEntryCanvasRect(entry);
            if (rect) entries.push({
                ...rect,
                kind: entry.data?.kind === 'op' ? entry.data.nodeType : this._getItemMediaType(entry.data),
                selected: this.selectedItems.has(entry.data.id)
            });
        });
        this.plans.forEach(entry => {
            const rect = this._getEntryCanvasRect(entry);
            if (rect) entries.push({ ...rect, kind: 'plan', selected: this.selectedItems.has(entry.data.id) });
        });
        this.generationPlaceholders.forEach(entry => {
            const rect = entry?.placement;
            if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return;
            entries.push({ ...rect, kind: 'pending' });
        });
        return entries;
    }

    _refreshCanvasBoundary(options = {}) {
        const entries = this._collectCanvasOverviewEntries();
        let contentBounds = null;
        entries.forEach(entry => {
            if (!contentBounds) {
                contentBounds = {
                    minX: entry.x,
                    minY: entry.y,
                    maxX: entry.x + entry.width,
                    maxY: entry.y + entry.height
                };
                return;
            }
            contentBounds.minX = Math.min(contentBounds.minX, entry.x);
            contentBounds.minY = Math.min(contentBounds.minY, entry.y);
            contentBounds.maxX = Math.max(contentBounds.maxX, entry.x + entry.width);
            contentBounds.maxY = Math.max(contentBounds.maxY, entry.y + entry.height);
        });

        if (options.reset || !this._canvasBounds) {
            const center = contentBounds
                ? { x: (contentBounds.minX + contentBounds.maxX) / 2, y: (contentBounds.minY + contentBounds.maxY) / 2 }
                : this._getViewportCenter();
            const contentWidth = contentBounds ? contentBounds.maxX - contentBounds.minX + CANVAS_BOUNDARY_PADDING * 2 : 0;
            const contentHeight = contentBounds ? contentBounds.maxY - contentBounds.minY + CANVAS_BOUNDARY_PADDING * 2 : 0;
            const width = Math.max(CANVAS_BOUNDARY_MIN_WIDTH, contentWidth);
            const height = Math.max(CANVAS_BOUNDARY_MIN_HEIGHT, contentHeight);
            this._canvasBounds = { x: center.x - width / 2, y: center.y - height / 2, width, height };
        } else if (contentBounds) {
            const current = this._canvasBounds;
            const minX = Math.min(current.x, contentBounds.minX - CANVAS_BOUNDARY_PADDING);
            const minY = Math.min(current.y, contentBounds.minY - CANVAS_BOUNDARY_PADDING);
            const maxX = Math.max(current.x + current.width, contentBounds.maxX + CANVAS_BOUNDARY_PADDING);
            const maxY = Math.max(current.y + current.height, contentBounds.maxY + CANVAS_BOUNDARY_PADDING);
            this._canvasBounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        }

        this.canvasBoundary?.setAttrs(this._canvasBounds);
        this.boundaryLayer?.batchDraw();
        if (this.minimapPanel) {
            this.minimapPanel.hidden = entries.length === 0 || !this._minimapUserVisible;
        }
        this._scheduleMinimapDraw();
    }

    _scheduleMinimapDraw() {
        if (!this.minimapCanvas || this._minimapDrawPending) return;
        this._minimapDrawPending = true;
        requestAnimationFrame(() => {
            this._minimapDrawPending = false;
            this._drawCanvasMinimap();
        });
    }

    _drawCanvasMinimap() {
        const canvas = this.minimapCanvas;
        const bounds = this._canvasBounds;
        if (!canvas || !bounds || canvas.clientWidth <= 0 || canvas.clientHeight <= 0) return;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const pixelWidth = Math.round(width * dpr);
        const pixelHeight = Math.round(height * dpr);
        if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;
        }
        const context = canvas.getContext('2d');
        if (!context) return;
        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, width, height);

        const inset = 8;
        const mapScale = Math.max(0.0001, Math.min(
            (width - inset * 2) / bounds.width,
            (height - inset * 2) / bounds.height
        ));
        const mapWidth = bounds.width * mapScale;
        const mapHeight = bounds.height * mapScale;
        const offsetX = (width - mapWidth) / 2;
        const offsetY = (height - mapHeight) / 2;
        this._minimapTransform = { bounds: { ...bounds }, scale: mapScale, offsetX, offsetY };

        context.fillStyle = 'rgba(7, 8, 11, 0.72)';
        context.fillRect(offsetX, offsetY, mapWidth, mapHeight);
        context.strokeStyle = 'rgba(145, 151, 162, 0.34)';
        context.lineWidth = 1;
        context.setLineDash([4, 3]);
        context.strokeRect(offsetX + 0.5, offsetY + 0.5, Math.max(0, mapWidth - 1), Math.max(0, mapHeight - 1));
        context.setLineDash([]);

        const colors = {
            image: '#7d838e',
            video: '#969a9f',
            audio: '#6c727b',
            document: '#8d929c',
            other: '#707783',
            plan: '#c0c4cb',
            pending: '#69707b'
        };
        context.save();
        context.beginPath();
        context.rect(offsetX, offsetY, mapWidth, mapHeight);
        context.clip();
        this._collectCanvasOverviewEntries().forEach(entry => {
            const x = offsetX + (entry.x - bounds.x) * mapScale;
            const y = offsetY + (entry.y - bounds.y) * mapScale;
            const itemWidth = Math.max(2, entry.width * mapScale);
            const itemHeight = Math.max(2, entry.height * mapScale);
            const selected = entry.selected === true;
            context.globalAlpha = selected ? 1 : entry.kind === 'pending' ? 0.5 : 0.86;
            context.fillStyle = selected ? '#aeb3ba' : (colors[entry.kind] || colors.other);
            context.fillRect(x, y, itemWidth, itemHeight);
            if (selected) {
                context.strokeStyle = 'rgba(232, 233, 236, 0.72)';
                context.lineWidth = 1;
                context.strokeRect(x + 0.5, y + 0.5, Math.max(0, itemWidth - 1), Math.max(0, itemHeight - 1));
            }
        });
        context.restore();
        context.globalAlpha = 1;

        const stageScale = Math.max(0.0001, this.stage.scaleX());
        const viewportWorld = {
            x: -this.stage.x() / stageScale,
            y: -this.stage.y() / stageScale,
            width: this.stage.width() / stageScale,
            height: this.stage.height() / stageScale
        };
        const viewport = {
            x: offsetX + (viewportWorld.x - bounds.x) * mapScale,
            y: offsetY + (viewportWorld.y - bounds.y) * mapScale,
            width: Math.max(4, viewportWorld.width * mapScale),
            height: Math.max(4, viewportWorld.height * mapScale)
        };
        this._minimapViewportRect = viewport;
        context.fillStyle = 'rgba(119, 124, 133, 0.16)';
        context.strokeStyle = '#8f949d';
        context.lineWidth = 1.5;
        context.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);
        context.strokeRect(viewport.x + 0.75, viewport.y + 0.75, Math.max(0, viewport.width - 1.5), Math.max(0, viewport.height - 1.5));

        if (this.minimapZoom) this.minimapZoom.textContent = `${Math.round(stageScale * 100)}%`;
    }

    _centerViewportAt(worldX, worldY) {
        if (!Number.isFinite(worldX) || !Number.isFinite(worldY)) return;
        const scale = this.stage.scaleX();
        this.stage.position({
            x: this.stage.width() / 2 - worldX * scale,
            y: this.stage.height() / 2 - worldY * scale
        });
        this.stage.batchDraw();
    }

    on(event, cb) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(cb);
    }

    emit(event, data) {
        if (event === 'change') this._refreshCanvasBoundary();
        if (this.listeners[event]) this.listeners[event].forEach(cb => cb(data));
    }

    _createSelectionToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'canvas-selection-toolbar';
        toolbar.hidden = true;
        toolbar.setAttribute('role', 'toolbar');
        toolbar.setAttribute('aria-label', '素材操作');
        toolbar.innerHTML = `
            <button type="button" data-action="crop" title="裁切图片" aria-label="裁切图片"><svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-crop"></use></svg></button>
            <button type="button" data-action="duplicate" title="创建副本" aria-label="创建副本"><svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-copy"></use></svg></button>
            <button type="button" data-action="replace" title="替换素材" aria-label="替换素材"><svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-replace"></use></svg></button>
            <button type="button" data-action="reference" title="加入创作参考" aria-label="加入创作参考"><svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-sparkles"></use></svg></button>
            <button type="button" data-action="more" title="更多操作" aria-label="更多操作"><svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-more"></use></svg></button>
            <span class="canvas-selection-toolbar-divider" aria-hidden="true"></span>
            <button type="button" data-action="tag" title="分类与收藏" aria-label="分类与收藏"><svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-tag"></use></svg></button>
            <span class="canvas-selection-toolbar-divider" aria-hidden="true"></span>
            <button type="button" data-action="folder" title="复制到文件夹" aria-label="复制到文件夹"><svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-folder-add"></use></svg></button>
            <button type="button" data-action="export" title="另存为" aria-label="另存为"><svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-download"></use></svg></button>
            <button type="button" data-action="preview" title="全屏预览" aria-label="全屏预览"><svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-expand"></use></svg></button>
        `;
        toolbar.addEventListener('pointerdown', event => {
            event.stopPropagation();
        });
        toolbar.addEventListener('click', event => {
            const button = event.target.closest('button[data-action]');
            if (!button || button.disabled) return;
            event.preventDefault();
            event.stopPropagation();
            void this._handleSelectionToolbarAction(button.dataset.action, button);
        });
        this.container.appendChild(toolbar);
        this.selectionToolbar = toolbar;
        document.addEventListener('canvas-reference-feedback', event => {
            if (event.detail?.message) this._showCanvasStatus(event.detail.message, 2600);
        });
    }

    _getSelectionToolbarItem() {
        if (this.selectedItems.size !== 1) return null;
        const item = this.items.get([...this.selectedItems][0]);
        if (!item || item.data?.kind === 'op' || !item.group?.isVisible()) return null;
        return item;
    }

    _scheduleSelectionToolbarSync() {
        if (this._selectionToolbarRaf) return;
        this._selectionToolbarRaf = requestAnimationFrame(() => {
            this._selectionToolbarRaf = null;
            this._syncSelectionToolbar();
        });
    }

    _syncSelectionToolbar() {
        const toolbar = this.selectionToolbar;
        if (this._activeImageCrop) {
            if (toolbar) toolbar.hidden = true;
            return;
        }
        const item = this._getSelectionToolbarItem();
        const itemRect = item ? this._getEntryContentRect(item) : null;
        if (!toolbar || !item || !itemRect) {
            if (toolbar) toolbar.hidden = true;
            return;
        }

        toolbar.hidden = false;
        toolbar.style.visibility = 'hidden';
        const toolbarRect = toolbar.getBoundingClientRect();
        const position = getSelectionToolbarPosition({
            stage: {
                x: this.stage.x(),
                y: this.stage.y(),
                scale: this.stage.scaleX()
            },
            itemRect,
            viewport: {
                width: this.stage.width(),
                height: this.stage.height()
            },
            toolbar: {
                width: toolbarRect.width,
                height: toolbarRect.height
            }
        });

        if (!position.visible) {
            toolbar.hidden = true;
            toolbar.style.visibility = '';
            return;
        }
        toolbar.style.left = `${position.left}px`;
        toolbar.style.top = `${position.top}px`;
        toolbar.style.visibility = '';
        toolbar.dataset.placement = position.placement;

        const mediaType = this._getItemMediaType(item.data);
        const cropButton = toolbar.querySelector('[data-action="crop"]');
        if (cropButton) {
            cropButton.disabled = mediaType !== 'image'
                || !item.data.filePath
                || !item.group.findOne('.displayNode');
        }
        const referenceButton = toolbar.querySelector('[data-action="reference"]');
        if (referenceButton) referenceButton.disabled = !['image', 'video', 'audio'].includes(mediaType);
    }

    _getSelectionActionPayload(primaryId = null) {
        const entries = [...this.selectedItems]
            .map(id => this.items.get(id))
            .filter(Boolean)
            .sort((left, right) => (left.group.x() - right.group.x()) || (left.group.y() - right.group.y()));
        const primary = this.items.get(primaryId) || entries[0] || null;
        return {
            itemId: primary?.data?.id || null,
            itemIds: entries.map(entry => entry.data.id),
            filePath: primary?.data?.filePath || '',
            filePaths: entries.map(entry => entry.data.filePath).filter(Boolean),
            loadError: Boolean(primary?.loadError),
            mediaType: primary ? this._getItemMediaType(primary.data) : null
        };
    }

    _copyableFilePath(data) {
        if (data?.filePath) return data.filePath;
        if (data?.kind !== 'op' || !['image', 'video'].includes(data.nodeType)) return '';
        return getGeneratorResultEntries(data)[0]?.filePath || '';
    }

    async _handleSelectionToolbarAction(action, button) {
        const item = this._getSelectionToolbarItem();
        if (!item) return;
        const payload = this._getSelectionActionPayload(item.data.id);
        try {
            if (action === 'crop') {
                this._startImageCrop(item);
            } else if (action === 'duplicate') {
                this.duplicateItems(payload.itemIds);
            } else if (action === 'replace') {
                this._requestMediaReplacement(item.data);
            } else if (action === 'reference') {
                this._showGenerationTypeMenuForMedia(item.data.id, button);
            } else if (action === 'more') {
                const rect = button.getBoundingClientRect();
                this.contextMenu.show({
                    evt: {
                        preventDefault() {},
                        clientX: rect.left,
                        clientY: rect.bottom + 8
                    }
                }, payload);
            } else if (action === 'tag') {
                const rect = button.getBoundingClientRect();
                document.dispatchEvent(new CustomEvent('show-asset-classification-menu', {
                    detail: {
                        filePath: item.data.filePath,
                        clientX: rect.left,
                        clientY: rect.bottom + 8
                    }
                }));
            } else if (action === 'folder') {
                document.dispatchEvent(new CustomEvent('context-copy-to-folder', { detail: payload }));
            } else if (action === 'export') {
                const result = await window.flowCanvas?.file?.saveCopy?.(item.data.filePath);
                if (result?.success) this._showCanvasStatus('素材已另存为');
                else if (!result?.canceled) this._showCanvasStatus(`另存失败：${result?.error || '未知错误'}`, 3200);
            } else if (action === 'preview') {
                this._openMediaPreview(item);
            }
        } catch (error) {
            console.error('[Canvas] selection toolbar action failed:', action, error);
            this._showCanvasStatus(`操作失败：${error?.message || error}`, 3200);
        }
    }

    _startImageCrop(item) {
        if (!item?.data?.filePath || this._getItemMediaType(item.data) !== 'image') return false;
        if (!window.flowCanvas?.image?.crop) {
            this._showCanvasStatus('裁切功能需要在 Flow Canvas 桌面版中使用', 3200);
            return false;
        }
        const displayNode = item.group?.findOne('.displayNode');
        if (!displayNode || item.loadError) {
            this._showCanvasStatus('图片尚未加载完成，暂时不能裁切', 3200);
            return false;
        }

        this._closeImageCrop({ silent: true });
        this._closeGenerationTypeMenu();
        this.contextMenu?.hide?.();

        const root = document.createElement('div');
        root.className = 'image-crop-overlay';
        root.innerHTML = `
            <div class="image-crop-frame" aria-label="图片裁切区域">
                <div class="image-crop-mask" data-crop-mask="top"></div>
                <div class="image-crop-mask" data-crop-mask="right"></div>
                <div class="image-crop-mask" data-crop-mask="bottom"></div>
                <div class="image-crop-mask" data-crop-mask="left"></div>
                <div class="image-crop-selection" data-crop-drag>
                    <i class="image-crop-grid-line vertical first" aria-hidden="true"></i>
                    <i class="image-crop-grid-line vertical second" aria-hidden="true"></i>
                    <i class="image-crop-grid-line horizontal first" aria-hidden="true"></i>
                    <i class="image-crop-grid-line horizontal second" aria-hidden="true"></i>
                    <button type="button" data-crop-handle="nw" aria-label="调整左上角"></button>
                    <button type="button" data-crop-handle="n" aria-label="调整上边"></button>
                    <button type="button" data-crop-handle="ne" aria-label="调整右上角"></button>
                    <button type="button" data-crop-handle="e" aria-label="调整右边"></button>
                    <button type="button" data-crop-handle="se" aria-label="调整右下角"></button>
                    <button type="button" data-crop-handle="s" aria-label="调整下边"></button>
                    <button type="button" data-crop-handle="sw" aria-label="调整左下角"></button>
                    <button type="button" data-crop-handle="w" aria-label="调整左边"></button>
                </div>
            </div>
            <div class="image-crop-actions">
                <span class="image-crop-size" aria-live="polite"></span>
                <button type="button" class="image-crop-cancel" title="取消裁切">取消</button>
                <button type="button" class="image-crop-confirm">完成裁切</button>
            </div>
        `;
        root.addEventListener('pointerdown', event => {
            event.preventDefault();
            event.stopPropagation();
            this._beginImageCropPointer(event);
        });
        root.addEventListener('contextmenu', event => event.preventDefault());
        root.addEventListener('wheel', event => event.preventDefault(), { passive: false });
        root.querySelector('.image-crop-cancel')?.addEventListener('click', event => {
            event.stopPropagation();
            this._closeImageCrop();
        });
        root.querySelector('.image-crop-confirm')?.addEventListener('click', event => {
            event.stopPropagation();
            void this._confirmImageCrop();
        });

        this.container.appendChild(root);
        this._activeImageCrop = {
            itemId: item.data.id,
            sourcePath: item.data.filePath,
            crop: { x: 0, y: 0, width: 1, height: 1 },
            root,
            frame: root.querySelector('.image-crop-frame'),
            selection: root.querySelector('.image-crop-selection'),
            actions: root.querySelector('.image-crop-actions'),
            sizeLabel: root.querySelector('.image-crop-size'),
            wasStageDraggable: this.stage.draggable(),
            wasItemDraggable: item.group.draggable(),
            gifDisplay: item.gifDomElement?.style?.display || '',
            busy: false
        };
        this.stage.draggable(false);
        item.group.draggable(false);
        if (item.gifDomElement) item.gifDomElement.style.display = 'none';
        this.imageTransformer?.nodes([]);
        if (this.selectionToolbar) this.selectionToolbar.hidden = true;
        document.body.classList.add('image-crop-active');
        this._positionImageCropOverlay();
        this.layer.batchDraw();
        this._showCanvasStatus('拖动边角裁切；Enter 完成，Esc 取消', 3200);
        return true;
    }

    _beginImageCropPointer(event) {
        const active = this._activeImageCrop;
        if (!active || active.busy || event.button !== 0) return;
        const handle = event.target.closest?.('[data-crop-handle]')?.dataset?.cropHandle || '';
        const isMove = Boolean(event.target.closest?.('[data-crop-drag]')) && !handle;
        if (!handle && !isMove) return;

        this._imageCropPointerCleanup?.();
        const frameRect = active.frame.getBoundingClientRect();
        if (frameRect.width < 2 || frameRect.height < 2) return;
        const startCrop = { ...active.crop };
        const startX = event.clientX;
        const startY = event.clientY;
        const minWidth = Math.min(1, Math.max(0.01, 24 / frameRect.width));
        const minHeight = Math.min(1, Math.max(0.01, 24 / frameRect.height));
        active.root.classList.add('is-adjusting');

        const move = moveEvent => {
            const dx = (moveEvent.clientX - startX) / frameRect.width;
            const dy = (moveEvent.clientY - startY) / frameRect.height;
            active.crop = handle
                ? resizeCropRect(startCrop, handle, dx, dy, { minWidth, minHeight })
                : moveCropRect(startCrop, dx, dy);
            this._renderImageCropOverlay();
        };
        const stop = () => {
            active.root.classList.remove('is-adjusting');
            document.removeEventListener('pointermove', move, true);
            document.removeEventListener('pointerup', stop, true);
            document.removeEventListener('pointercancel', stop, true);
            window.removeEventListener('blur', stop);
            this._imageCropPointerCleanup = null;
        };
        this._imageCropPointerCleanup = stop;
        document.addEventListener('pointermove', move, true);
        document.addEventListener('pointerup', stop, true);
        document.addEventListener('pointercancel', stop, true);
        window.addEventListener('blur', stop);
    }

    _positionImageCropOverlay() {
        const active = this._activeImageCrop;
        if (!active) return;
        const item = this.items.get(active.itemId);
        const itemRect = item ? this._getEntryContentRect(item) : null;
        if (!item || !itemRect) {
            this._closeImageCrop({ silent: true });
            return;
        }
        const scale = this.stage.scaleX();
        active.screenRect = {
            left: this.stage.x() + itemRect.x * scale,
            top: this.stage.y() + itemRect.y * scale,
            width: Math.max(1, itemRect.width * scale),
            height: Math.max(1, itemRect.height * scale)
        };
        Object.assign(active.frame.style, {
            left: `${active.screenRect.left}px`,
            top: `${active.screenRect.top}px`,
            width: `${active.screenRect.width}px`,
            height: `${active.screenRect.height}px`
        });
        this._renderImageCropOverlay();
    }

    _renderImageCropOverlay() {
        const active = this._activeImageCrop;
        if (!active?.screenRect) return;
        active.crop = normalizeCropRect(active.crop);
        const crop = active.crop;
        const percent = value => `${value * 100}%`;
        const setBox = (name, box) => {
            const node = active.frame.querySelector(`[data-crop-mask="${name}"]`);
            if (!node) return;
            Object.assign(node.style, {
                left: percent(box.x),
                top: percent(box.y),
                width: percent(box.width),
                height: percent(box.height)
            });
        };
        setBox('top', { x: 0, y: 0, width: 1, height: crop.y });
        setBox('right', { x: crop.x + crop.width, y: crop.y, width: 1 - crop.x - crop.width, height: crop.height });
        setBox('bottom', { x: 0, y: crop.y + crop.height, width: 1, height: 1 - crop.y - crop.height });
        setBox('left', { x: 0, y: crop.y, width: crop.x, height: crop.height });
        Object.assign(active.selection.style, {
            left: percent(crop.x),
            top: percent(crop.y),
            width: percent(crop.width),
            height: percent(crop.height)
        });

        if (active.sizeLabel) {
            active.sizeLabel.textContent = `保留 ${Math.round(crop.width * 100)}% × ${Math.round(crop.height * 100)}%`;
        }
        const actionsRect = active.actions.getBoundingClientRect();
        const cropRight = active.screenRect.left + (crop.x + crop.width) * active.screenRect.width;
        const cropTop = active.screenRect.top + crop.y * active.screenRect.height;
        const cropBottom = active.screenRect.top + (crop.y + crop.height) * active.screenRect.height;
        const actionsWidth = actionsRect.width || 240;
        const actionsHeight = actionsRect.height || 44;
        const maxLeft = Math.max(8, this.container.clientWidth - actionsWidth - 8);
        let top = cropBottom + 12;
        if (top + actionsHeight > this.container.clientHeight - 8) top = cropTop - actionsHeight - 12;
        Object.assign(active.actions.style, {
            left: `${Math.max(8, Math.min(maxLeft, cropRight - actionsWidth))}px`,
            top: `${Math.max(8, Math.min(this.container.clientHeight - actionsHeight - 8, top))}px`
        });
    }

    _closeImageCrop(options = {}) {
        const active = this._activeImageCrop;
        if (!active) return;
        this._imageCropPointerCleanup?.();
        this._imageCropPointerCleanup = null;
        active.root?.remove();
        const item = this.items.get(active.itemId);
        if (item?.group) {
            item.group.draggable(active.wasItemDraggable);
            if (item.gifDomElement) item.gifDomElement.style.display = active.gifDisplay;
        }
        this.stage.draggable(active.wasStageDraggable);
        this._activeImageCrop = null;
        document.body.classList.remove('image-crop-active');
        this._syncImageTransformer();
        this._scheduleSelectionToolbarSync();
        this.layer.batchDraw();
        if (!options.silent) this._showCanvasStatus('已取消裁切');
    }

    async _confirmImageCrop() {
        const active = this._activeImageCrop;
        if (!active || active.busy) return;
        const sourceEntry = this.items.get(active.itemId);
        const displayNode = sourceEntry?.group?.findOne('.displayNode');
        if (!sourceEntry || !displayNode) {
            this._closeImageCrop({ silent: true });
            return;
        }

        active.busy = true;
        active.root.classList.add('is-busy');
        active.root.querySelectorAll('button').forEach(button => { button.disabled = true; });
        try {
            const crop = normalizeCropRect(active.crop);
            const result = await window.flowCanvas.image.crop({
                filePath: active.sourcePath,
                crop
            });
            if (!result?.success || !result.filePath) {
                throw new Error(result?.error || '图片裁切失败');
            }

            const sourceData = sourceEntry.data;
            const at = this._findResultSlot(sourceData);
            const childData = {
                id: `crop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                kind: 'media',
                mediaType: 'image',
                filePath: result.filePath,
                x: at.x,
                y: at.y,
                width: Math.max(1, displayNode.width() * crop.width),
                height: Math.max(1, displayNode.height() * crop.height),
                addedAt: Date.now(),
                fromNodeId: sourceData.id,
                sourceOperation: 'crop'
            };
            await this._createCard(childData);
            this._scheduleCullCheck();
            this.emit('capturedFile', childData);
            this._connectResultHistory(sourceData, { image: result.filePath }, childData.id);
            this._closeImageCrop({ silent: true });
            this.clearSelection();
            this.selectItem(childData.id, true);
            this.graphView?.sync();
            this._showCanvasStatus(`裁切完成并已连接原图 · ${result.width} × ${result.height}`, 3600);
        } catch (error) {
            console.error('[Canvas] image crop failed:', error);
            if (this._activeImageCrop === active) {
                active.busy = false;
                active.root.classList.remove('is-busy');
                active.root.querySelectorAll('button').forEach(button => { button.disabled = false; });
            }
            this._showCanvasStatus(`裁切失败：${error?.message || error}`, 4200);
        }
    }

    _showGenerationTypeMenuForMedia(itemId, anchor) {
        const source = this.items.get(itemId)?.data;
        if (!source?.filePath) return;
        const mediaType = this._getItemMediaType(source);
        const choices = mediaType === 'image'
            ? [
                { nodeType: 'image', label: '生成图片', description: '把当前图片作为参考图' },
                { nodeType: 'video', label: '生成视频', description: '把当前图片作为首帧参考' }
            ]
            : mediaType === 'video'
                ? [{ nodeType: 'video', label: '生成视频', description: '把当前视频作为动态参考' }]
                : mediaType === 'audio'
                    ? [{ nodeType: 'video', label: '生成视频', description: '把当前音频作为声音参考' }]
                    : [];
        if (!choices.length) return;

        this._closeGenerationTypeMenu();
        const menu = document.createElement('section');
        menu.className = 'generation-type-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', '选择生成类型');
        choices.forEach(choice => {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('role', 'menuitem');
            const iconId = choice.nodeType === 'video' ? 'icon-video' : 'icon-image';
            button.innerHTML = `
                <svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#${iconId}"></use></svg>
                <span><strong></strong><small></small></span>
            `;
            button.querySelector('strong').textContent = choice.label;
            button.querySelector('small').textContent = choice.description;
            button.addEventListener('click', () => {
                this._closeGenerationTypeMenu();
                this._createGeneratorFromMedia(itemId, choice.nodeType);
            });
            menu.appendChild(button);
        });
        document.body.appendChild(menu);

        const anchorRect = anchor?.getBoundingClientRect?.() || { left: 12, right: 12, top: 12, bottom: 12 };
        const rect = menu.getBoundingClientRect();
        let left = anchorRect.left + (anchorRect.width - rect.width) / 2;
        let top = anchorRect.bottom + 8;
        left = Math.max(10, Math.min(window.innerWidth - rect.width - 10, left));
        if (top + rect.height > window.innerHeight - 10) top = anchorRect.top - rect.height - 8;
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.max(10, Math.round(top))}px`;

        const closeOutside = event => {
            if (!menu.contains(event.target)) this._closeGenerationTypeMenu();
        };
        const closeOnKey = event => {
            if (event.key === 'Escape') this._closeGenerationTypeMenu();
        };
        this._generationTypeMenu = { menu, closeOutside, closeOnKey };
        setTimeout(() => document.addEventListener('pointerdown', closeOutside, true), 0);
        document.addEventListener('keydown', closeOnKey, true);
        requestAnimationFrame(() => menu.querySelector('button')?.focus({ preventScroll: true }));
    }

    _closeGenerationTypeMenu() {
        const active = this._generationTypeMenu;
        if (!active) return;
        document.removeEventListener('pointerdown', active.closeOutside, true);
        document.removeEventListener('keydown', active.closeOnKey, true);
        active.menu?.remove();
        this._generationTypeMenu = null;
    }

    _createGeneratorFromMedia(itemId, nodeType) {
        const sourceEntry = this.items.get(itemId);
        const source = sourceEntry?.data;
        if (!sourceEntry || !source) return null;
        const size = getGeneratorPlaceholderSize(nodeType, {}, source);
        const sourceX = Number.isFinite(Number(source.x)) ? Number(source.x) : sourceEntry.group.x();
        const sourceY = Number.isFinite(Number(source.y)) ? Number(source.y) : sourceEntry.group.y();
        const left = sourceX + Number(source.width || IMAGE_DEFAULT_WIDTH) + 64;
        const top = sourceY + Math.max(0, (Number(source.height || size.height) - size.height) / 2);
        const created = this.addOpNode(nodeType, {
            x: left + size.width / 2,
            y: top + size.height / 2
        });
        if (!created) return null;

        const connection = this.graphView?.connect(
            { nodeId: itemId, port: 'out' },
            { nodeId: created.id, port: 'source' }
        );
        if (!connection) return created;
        requestAnimationFrame(() => this.openGenerationComposer(created.id));
        return created;
    }

    _openMediaPreview(item) {
        const filePath = resolveCanvasFilePath(item?.data?.filePath);
        if (!filePath) return;
        const mediaType = this._getItemMediaType(item.data);
        if (!['image', 'video', 'audio'].includes(mediaType)) {
            void window.flowCanvas?.shell?.openFile?.(filePath);
            return;
        }

        this._closeMediaPreview?.();
        const preview = document.createElement('div');
        preview.className = 'canvas-media-preview';
        preview.setAttribute('role', 'dialog');
        preview.setAttribute('aria-modal', 'true');
        preview.setAttribute('aria-label', '素材预览');
        const source = `local-res://${encodeURIComponent(filePath)}`;
        const media = mediaType === 'image'
            ? document.createElement('img')
            : mediaType === 'video'
                ? document.createElement('video')
                : document.createElement('audio');
        media.src = source;
        media.draggable = false;
        if (mediaType !== 'image') media.controls = true;
        if (mediaType === 'video') media.autoplay = true;

        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'canvas-media-preview-close';
        closeButton.title = '关闭预览';
        closeButton.setAttribute('aria-label', '关闭预览');
        closeButton.innerHTML = '<svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-close"></use></svg>';
        preview.append(media, closeButton);
        document.body.appendChild(preview);
        void window.flowCanvas?.win?.setMediaPreviewFullscreen?.(true);

        const close = () => {
            if (!preview.isConnected) return;
            if (media instanceof HTMLMediaElement) media.pause();
            preview.remove();
            document.removeEventListener('keydown', onKeyDown, true);
            if (this._closeMediaPreview === close) this._closeMediaPreview = null;
            void window.flowCanvas?.win?.setMediaPreviewFullscreen?.(false);
        };
        const onKeyDown = event => {
            if (event.key === 'Escape') close();
        };
        closeButton.addEventListener('click', close);
        preview.addEventListener('pointerdown', event => {
            if (event.target === preview) close();
        });
        this._closeMediaPreview = close;
        document.addEventListener('keydown', onKeyDown, true);
        requestAnimationFrame(() => preview.classList.add('show'));
    }

    beginMediaReferencePick(type, entries = [], maxItems = 1, allSelections = {}) {
        const normalizedType = type === 'mixed'
            ? 'mixed'
            : (['image', 'video', 'audio'].includes(type) ? type : 'image');
        if (this._activePlanReferencePick) this._cancelPlanReferencePick('', { refresh: false });
        this.endMediaReferencePick({ silent: true });
        ['image', 'video', 'audio'].forEach(mediaType => {
            this._mediaReferenceSelections[mediaType] = (Array.isArray(allSelections?.[mediaType]) ? allSelections[mediaType] : [])
                .map(entry => this._normalizeMediaReferenceEntry(entry))
                .filter(entry => entry && entry.mediaType === mediaType);
        });
        if (normalizedType === 'mixed') {
            const limits = Object.fromEntries(['image', 'video', 'audio'].map(mediaType => [
                mediaType,
                Math.max(0, Number(maxItems?.[mediaType]) || 0)
            ]));
            this._activeMediaReferencePick = { type: 'mixed', limits };
            this._renderMediaReferencePickHighlights();
            this._showCanvasStatus('依次点击画布中的图片、视频或音频素材；再次点击可取消选择', 4200);
            this.emit('mediaReferencePickStateChanged', { active: true, type: 'mixed' });
            return true;
        }
        const normalizedEntries = (Array.isArray(entries) ? entries : [])
            .map(entry => this._normalizeMediaReferenceEntry(entry))
            .filter(entry => entry && entry.mediaType === normalizedType)
            .slice(0, Math.max(1, Number(maxItems) || 1));
        this._mediaReferenceSelections[normalizedType] = normalizedEntries;
        this._activeMediaReferencePick = {
            type: normalizedType,
            entries: normalizedEntries,
            maxItems: Math.max(1, Number(maxItems) || 1)
        };
        this._renderMediaReferencePickHighlights();
        const typeLabel = { image: '图片', video: '视频', audio: '音频' }[normalizedType];
        this._showCanvasStatus(`按顺序点击画布${typeLabel}，选择立即生效；点击右侧继续操作`, 4200);
        this.emit('mediaReferencePickStateChanged', { active: true, type: normalizedType });
        return true;
    }

    beginNodeReferencePick(nodeId) {
        const target = this.items.get(nodeId)?.data;
        if (!target || target.kind !== 'op' || !['image', 'video'].includes(target.nodeType)) return false;

        const selections = { image: [], video: [], audio: [] };
        (this.graphView?.connections || []).forEach(connection => {
            if (!this._isGeneratorInputConnection(target, connection)) return;
            const source = this.items.get(connection.from.nodeId)?.data;
            const entry = this._normalizeMediaReferenceEntry({ id: source?.id, filePath: source?.filePath });
            if (entry && selections[entry.mediaType]) selections[entry.mediaType].push(entry);
        });

        this.beginMediaReferencePick('mixed', [], target.nodeType === 'image'
            ? { image: 9, video: 0, audio: 0 }
            : { image: 9, video: 3, audio: 3 }, selections);
        this._activeNodeReferenceTargetId = nodeId;
        this._showCanvasStatus('点击画布素材连接到当前节点；再次点击可断开，Esc 完成', 4600);
        return true;
    }

    endMediaReferencePick(options = {}) {
        const pick = this._activeMediaReferencePick;
        if (!pick && !options.clearHighlights) return false;
        const clearNodeReferenceHighlights = Boolean(this._activeNodeReferenceTargetId);
        const type = pick?.type || null;
        if (pick && pick.type !== 'mixed') {
            this._mediaReferenceSelections[pick.type] = pick.entries.map(entry => ({ ...entry }));
        }
        this._activeMediaReferencePick = null;
        this._activeNodeReferenceTargetId = null;
        if (options.clearHighlights || clearNodeReferenceHighlights) {
            this._mediaReferenceSelections = { image: [], video: [], audio: [] };
        }
        this._renderMediaReferencePickHighlights();
        document.body.style.cursor = 'default';
        if (pick) this.emit('mediaReferencePickStateChanged', { active: false, type });
        if (pick && !options.silent) this._showCanvasStatus('参考素材选择已完成');
        return true;
    }

    updateMediaReferencePick(type, entries = []) {
        if (!['image', 'video', 'audio'].includes(type)) return false;
        const maxItems = this._activeMediaReferencePick?.type === type
            ? this._activeMediaReferencePick.maxItems
            : Number.MAX_SAFE_INTEGER;
        const normalizedEntries = (Array.isArray(entries) ? entries : [])
            .map(entry => this._normalizeMediaReferenceEntry(entry))
            .filter(entry => entry && entry.mediaType === type)
            .slice(0, maxItems);
        this._mediaReferenceSelections[type] = normalizedEntries;
        if (this._activeMediaReferencePick?.type === type) {
            this._activeMediaReferencePick.entries = normalizedEntries;
        }
        this._renderMediaReferencePickHighlights();
        return true;
    }

    clearMediaReferenceSelections() {
        this._mediaReferenceSelections = { image: [], video: [], audio: [] };
        if (this._activeMediaReferencePick) this._activeMediaReferencePick.entries = [];
        this._renderMediaReferencePickHighlights();
    }

    resolveMediaReferenceEntries(entries = [], type = null) {
        const normalizedType = ['image', 'video', 'audio'].includes(type) ? type : null;
        const byPath = new Map();
        this.items.forEach(item => {
            const filePath = String(item?.data?.filePath || '').trim();
            if (filePath) byPath.set(filePath.replaceAll('/', '\\').toLowerCase(), item);
        });
        return (Array.isArray(entries) ? entries : []).map(entry => {
            const requestedId = String(entry?.id || entry?.itemId || '').trim();
            const requestedPath = String(entry?.filePath || '').trim();
            const item = (requestedId && this.items.get(requestedId))
                || (requestedPath && byPath.get(requestedPath.replaceAll('/', '\\').toLowerCase()));
            if (!item?.data?.id || !item.data.filePath) return null;
            return this._normalizeMediaReferenceEntry({
                id: item.data.id,
                filePath: item.data.filePath
            });
        }).filter(entry => entry && (!normalizedType || entry.mediaType === normalizedType));
    }

    _normalizeMediaReferenceEntry(entry) {
        const id = String(entry?.id || entry?.itemId || '').trim();
        const item = id ? this.items.get(id) : null;
        const filePath = String(entry?.filePath || item?.data?.filePath || '').trim();
        if (!id || !item || !filePath) return null;
        return {
            id,
            itemId: id,
            filePath,
            mediaType: this._getFileType(filePath)
        };
    }

    _findMediaReferenceItemFromNode(node) {
        let current = node;
        while (current && current !== this.stage) {
            const id = String(current.attrs?.id || '').trim();
            if (id && this.items.has(id)) return this.items.get(id);
            current = current.getParent?.();
        }
        return null;
    }

    _pickMediaReferenceFromControl(item, event) {
        if (event?.evt?.button != null && event.evt.button !== 0) return false;
        if (!this._activeMediaReferencePick || !item?.data) return false;
        event.cancelBubble = true;
        event.evt?.preventDefault?.();
        event.evt?.stopPropagation?.();
        item.group?.stopDrag?.();
        this._lastMediaReferencePointerPick = { id: item.data.id, at: Date.now() };
        this._toggleMediaReferencePick(item);
        return true;
    }

    _toggleMediaReferencePick(item) {
        const pick = this._activeMediaReferencePick;
        if (!pick || !item?.data) return;
        const entry = this._normalizeMediaReferenceEntry({ id: item.data.id, filePath: item.data.filePath });
        const targetType = pick.type === 'mixed' ? entry?.mediaType : pick.type;
        const typeLabel = { image: '图片', video: '视频', audio: '音频' }[targetType] || '媒体';
        if (!entry || !['image', 'video', 'audio'].includes(targetType) || (pick.type !== 'mixed' && entry.mediaType !== pick.type)) {
            this._showCanvasStatus(pick.type === 'mixed' ? '这里只能选择图片、视频或音频素材' : `这里只能选择${typeLabel}素材`);
            return;
        }
        const entries = pick.type === 'mixed'
            ? this._mediaReferenceSelections[targetType]
            : pick.entries;
        const maxItems = pick.type === 'mixed' ? pick.limits[targetType] : pick.maxItems;
        if (maxItems <= 0) {
            this._showCanvasStatus(`当前模型不支持${typeLabel}参考素材`);
            return;
        }
        const existingIndex = entries.findIndex(candidate => candidate.id === entry.id);
        if (existingIndex >= 0) {
            entries.splice(existingIndex, 1);
        } else if (entries.length >= maxItems) {
            this._showCanvasStatus(`${typeLabel}最多选择 ${maxItems} 个`);
            return;
        } else {
            entries.push(entry);
        }
        if (this._activeNodeReferenceTargetId) {
            this._syncNodeReferenceConnection(
                this._activeNodeReferenceTargetId,
                entry,
                existingIndex < 0
            );
        }
        this._mediaReferenceSelections[targetType] = entries.map(candidate => ({ ...candidate }));
        this._renderMediaReferencePickHighlights();
        this.emit('mediaReferenceSelectionChanged', {
            type: targetType,
            entries: entries.map(candidate => ({ ...candidate }))
        });
        if (pick.type !== 'mixed' && existingIndex < 0 && entries.length >= maxItems) {
            this.endMediaReferencePick({ silent: true });
        }
    }

    _syncNodeReferenceConnection(nodeId, entry, selected) {
        const target = this.items.get(nodeId)?.data;
        if (!target || !entry?.id) return;
        if (target.nodeType === 'image' && entry.mediaType !== 'image') return;

        const existing = (this.graphView?.connections || []).find(connection =>
            connection.from.nodeId === entry.id
            && connection.from.port === 'out'
            && connection.to.nodeId === nodeId
            && this._isGeneratorInputConnection(target, connection)
        );
        if (selected && !existing) {
            this.graphView?.connect(
                { nodeId: entry.id, port: 'out' },
                { nodeId, port: 'source' }
            );
        } else if (!selected && existing) {
            this.graphView?.disconnect(existing.id);
        }
    }

    _renderMediaReferencePickHighlights() {
        Array.from(this._mediaReferenceHighlightIds).forEach(id => this._setItemReferenceHighlight(id, false));
        this._mediaReferenceHighlightIds.clear();
        Object.entries(this._mediaReferenceSelections).forEach(([type, entries]) => {
            entries.forEach((entry, index) => {
                this._mediaReferenceHighlightIds.add(entry.id);
                this._setItemReferenceHighlight(entry.id, true, {
                    mode: 'media',
                    referenceIndex: index,
                    labelText: `${{ image: '图片', video: '视频', audio: '音频' }[type]} ${index + 1}`
                });
            });
        });
    }

    getViewport() {
        return { x: this.stage.x(), y: this.stage.y(), scale: this.stage.scaleX() };
    }

    _getGenerationReferenceSize(references = []) {
        const firstReference = Array.isArray(references) ? references[0] : null;
        if (!firstReference) return null;
        const referenceId = String(firstReference?.itemId || firstReference?.id || '').trim();
        const referencePath = String(
            typeof firstReference === 'string' ? firstReference : firstReference?.filePath || ''
        ).trim();
        let item = referenceId ? this.items.get(referenceId) : null;
        if (!item && referencePath) {
            const pathKey = referencePath.replaceAll('/', '\\').toLowerCase();
            this.items.forEach(candidate => {
                if (item) return;
                const candidatePath = String(candidate?.data?.filePath || '').replaceAll('/', '\\').toLowerCase();
                if (candidatePath === pathKey) item = candidate;
            });
        }
        if (!item) return null;

        const displayNode = item.group?.findOne?.('.displayNode');
        const width = Number(item.data?.width) || Number(displayNode?.width?.()) || 0;
        const height = Number(item.data?.height) || Number(displayNode?.height?.()) || 0;
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
        return { width, height };
    }

    addGenerationPlaceholder(options = {}) {
        const referenceSize = this._getGenerationReferenceSize(options.sourceReferences);
        const { width, height } = resolveGenerationDisplaySize({
            kind: options.kind,
            referenceSize,
            ratio: options.ratio,
            size: options.size,
            longEdge: VIDEO_PLACEHOLDER_LONG_EDGE
        });
        const stagePos = this.stage.position();
        const scale = this.stage.scaleX();
        const container = this.stage.container();
        const centerX = (container.offsetWidth / 2 - stagePos.x) / scale;
        const centerY = (container.offsetHeight / 2 - stagePos.y) / scale;
        const x = centerX - width / 2;
        const y = centerY - height / 2;
        const kind = options.kind === 'image' ? 'image' : 'video';
        const id = `${kind}-placeholder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const group = new Konva.Group({
            x,
            y,
            listening: true,
            draggable: true,
            name: `${kind}GenerationPlaceholder`
        });
        const placement = { id, x, y, width, height };

        group.on('mouseenter', () => {
            document.body.style.cursor = 'grab';
        });
        group.on('mouseleave', () => {
            if (!group.isDragging()) document.body.style.cursor = 'default';
        });
        group.on('dragstart', (event) => {
            event.cancelBubble = true;
            if (event.evt && event.evt.button !== 0) {
                group.stopDrag();
                return;
            }
            this.stage.draggable(false);
            document.body.style.cursor = 'grabbing';
        });
        group.on('dragmove', (event) => {
            event.cancelBubble = true;
            placement.x = group.x();
            placement.y = group.y();
            this.graphView?.scheduleSync(placement.id);
        });
        group.on('dragend', (event) => {
            event.cancelBubble = true;
            placement.x = group.x();
            placement.y = group.y();
            this.graphView?.sync();
            this.stage.draggable(true);
            document.body.style.cursor = 'grab';
        });

        group.add(new Konva.Rect({
            width,
            height,
            fill: '#25272c',
            stroke: 'rgba(255, 255, 255, 0.12)',
            strokeWidth: 1,
            cornerRadius: 7,
            shadowColor: 'rgba(0, 0, 0, 0.35)',
            shadowBlur: 14,
            shadowOffsetY: 5,
            shadowOpacity: 0.5
        }));

        const sweepWidth = Math.max(72, Math.round(width * 0.34));
        const sweep = new Konva.Rect({
            x: -sweepWidth,
            y: 1,
            width: sweepWidth,
            height: Math.max(1, height - 2),
            cornerRadius: 6,
            fillLinearGradientStartPoint: { x: 0, y: 0 },
            fillLinearGradientEndPoint: { x: sweepWidth, y: 0 },
            fillLinearGradientColorStops: [
                0, 'rgba(255, 255, 255, 0)',
                0.5, 'rgba(255, 255, 255, 0.14)',
                1, 'rgba(255, 255, 255, 0)'
            ]
        });
        const sweepClip = new Konva.Group({
            clipX: 1,
            clipY: 1,
            clipWidth: Math.max(1, width - 2),
            clipHeight: Math.max(1, height - 2)
        });
        sweepClip.add(sweep);
        group.add(sweepClip);
        this.transientLayer.add(group);

        const animation = new Konva.Animation((frame) => {
            const progress = ((frame?.time || 0) % 1500) / 1500;
            sweep.x(-sweepWidth + ((width + sweepWidth) * progress));
        }, this.transientLayer);
        this.generationPlaceholders.set(id, { group, animation, placement });
        animation.start();
        this.transientLayer.batchDraw();
        this._refreshCanvasBoundary();
        return placement;
    }

    addVideoGenerationPlaceholder(options = {}) {
        return this.addGenerationPlaceholder({ ...options, kind: 'video' });
    }

    addImageGenerationPlaceholder(options = {}) {
        return this.addGenerationPlaceholder({ ...options, kind: 'image' });
    }

    _applyGenerationPlacement(itemId, position) {
        if (!itemId || !position) return false;
        const item = this.items.get(itemId);
        if (!item) {
            this.pendingGenerationPlacements.set(itemId, {
                x: position.x,
                y: position.y,
                width: position.width,
                height: position.height
            });
            return false;
        }

        item.group.position({ x: position.x, y: position.y });
        item.data.x = position.x;
        item.data.y = position.y;
        this._applyGeneratedDisplaySize(item, position.width, position.height);
        this.pendingGenerationPlacements.delete(itemId);
        this.layer.batchDraw();
        setTimeout(() => this.emit('change'), 0);
        return true;
    }

    _applyGeneratedDisplaySize(item, width, height) {
        const targetWidth = Number(width) || 0;
        const targetHeight = Number(height) || 0;
        if (!item?.data || targetWidth <= 0 || targetHeight <= 0) return false;

        item.data.width = targetWidth;
        item.data.height = targetHeight;
        const displayNode = item.group?.findOne?.('.displayNode');
        if (displayNode) displayNode.size({ width: targetWidth, height: targetHeight });

        const fallback = item.group?.findOne?.('.fallbackIcon');
        if (fallback && !displayNode) {
            fallback.destroy();
            item.group.add(this._createFallbackGroup(
                this._getItemMediaType(item.data),
                targetWidth,
                targetHeight,
                item.data.filePath
            ));
        }
        if (item.gifDomElement) {
            item.gifDomElement.style.width = `${targetWidth}px`;
            item.gifDomElement.style.height = `${targetHeight}px`;
        }
        const controls = item.group?.findOne?.('.videoControls');
        const coverControls = item.group?.findOne?.('.videoCoverControls');
        if (controls) this._layoutVideoControlGroup(controls, targetWidth, targetHeight);
        if (coverControls) this._layoutVideoControlGroup(coverControls, targetWidth, targetHeight);
        this._syncExternalNodeTitle(item.group, item.data, this._getItemMediaType(item.data));
        this.graphView?.scheduleSync(item.data.id);
        if (this.imageTransformer?.nodes?.()[0] === displayNode) this.imageTransformer.forceUpdate();
        return true;
    }

    removeGenerationPlaceholder(id, itemId = null) {
        const placeholder = this.generationPlaceholders.get(id);
        if (!placeholder) return false;
        const position = {
            x: placeholder.group?.x() ?? placeholder.placement?.x,
            y: placeholder.group?.y() ?? placeholder.placement?.y,
            width: placeholder.placement?.width,
            height: placeholder.placement?.height
        };
        if (itemId && Number.isFinite(position.x) && Number.isFinite(position.y)) {
            this._applyGenerationPlacement(itemId, position);
        }
        placeholder.animation?.stop();
        placeholder.group?.destroy();
        this.generationPlaceholders.delete(id);
        document.body.style.cursor = 'default';
        this.stage.draggable(true);
        this.transientLayer.batchDraw();
        this._refreshCanvasBoundary();
        return true;
    }

    removeVideoGenerationPlaceholder(id, itemId = null) {
        return this.removeGenerationPlaceholder(id, itemId);
    }

    removeImageGenerationPlaceholder(id, itemId = null) {
        return this.removeGenerationPlaceholder(id, itemId);
    }

    clearGenerationPlaceholders() {
        this.generationPlaceholders.forEach(({ group, animation }) => {
            animation?.stop();
            group?.destroy();
        });
        this.generationPlaceholders.clear();
        this.pendingGenerationPlacements.clear();
        this.stage.draggable(true);
        document.body.style.cursor = 'default';
        this.transientLayer.batchDraw();
    }

    clearVideoGenerationPlaceholders() {
        this.clearGenerationPlaceholders();
    }

    _getRelativePointerPos() {
        const pos = this.stage.getPointerPosition();
        return {
            x: (pos.x - this.stage.x()) / this.stage.scaleX(),
            y: (pos.y - this.stage.y()) / this.stage.scaleY(),
        };
    }

    bindEvents() {
        this.nativeDragProxy?.addEventListener('dragstart', (event) => {
            event.preventDefault();
        });
        this.nativeDragProxy?.addEventListener('dragend', () => {
            this._setNativeDragProxyActive(this.isAltPressed);
            document.body.style.cursor = 'default';
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight') {
                const wasAltPressed = this.isAltPressed;
                this.isAltPressed = true;
                this._setNativeDragProxyActive(true);
                if (!wasAltPressed && this._hoveredPlanId) {
                    this._refreshConnectionInteractionState();
                    this._showCanvasStatus('临时总览：松开 Alt 恢复行级连接');
                }
                e.preventDefault();
            }
        }, true);

        document.addEventListener('keyup', (e) => {
            if (e.key === 'Alt' || e.code === 'AltLeft' || e.code === 'AltRight') {
                const wasAltPressed = this.isAltPressed;
                this.isAltPressed = false;
                this._setNativeDragProxyActive(false);
                if (wasAltPressed && this._hoveredPlanId) {
                    this._refreshConnectionInteractionState();
                }
                e.preventDefault();
            }
        }, true);

        window.addEventListener('blur', () => {
            const wasAltPressed = this.isAltPressed;
            this.isAltPressed = false;
            this._setNativeDragProxyActive(false);
            this._setHoveredMediaItem(null);
            if (wasAltPressed && this._hoveredPlanId) {
                this._refreshConnectionInteractionState();
            }
        });

        this.stage.container().addEventListener('pointerleave', () => {
            this._setHoveredMediaItem(null);
        });

        document.addEventListener('pointerdown', (event) => {
            if (event.button !== 1) return;
            const planEditor = event.target?.closest?.('.plan-inline-editor');
            if (!planEditor) return;
            if (document.activeElement?.blur) document.activeElement.blur();
            this._inlineMiddlePointerHandled = true;
            setTimeout(() => {
                this._inlineMiddlePointerHandled = false;
            }, 0);
            this._startCanvasPanFromClientPoint(event, {
                passthroughElement: planEditor,
                pointerCaptureElement: planEditor,
                pointerId: event.pointerId
            });
        }, true);

        // Zoom
        this.stage.on('wheel', (e) => {
            this._zoomCanvasAtClientPoint(e.evt);
            // syncGifs 已由 stage change 事件的 rAF 批处理统一调用，不再手动重复调用
        });

        // Marquee Selection & Panning Logic
        let x1, y1, x2, y2;
        let isSelecting = false;
        let isPanning = false;
        let lastPanX = 0, lastPanY = 0;
        let panMoved = false;

        const setCanvasDragEnabled = (enabled) => {
            this.stage.draggable(enabled);
            this._forEachNode(item => {
                item.group.draggable(enabled);
                item.group.find?.('.planRowHandle').forEach(handle => handle.draggable(enabled));
            });
        };

        const detachPanningEndListeners = () => {
            document.removeEventListener('mouseup', finishPanning, true);
            document.removeEventListener('pointerup', finishPanning, true);
            document.removeEventListener('pointercancel', finishPanning, true);
            window.removeEventListener('blur', finishPanning);
        };

        const finishPanning = () => {
            if (!isPanning) return;
            isPanning = false;
            // 右键按下即开始平移，松手后 contextmenu 才触发。移动过就算平移，
            // 不弹菜单；原地点一下（位移为 0）才认作右键点击。
            this._suppressStageMenu = panMoved;
            document.body.style.cursor = 'default';
            setCanvasDragEnabled(true);
            detachPanningEndListeners();
            this.emit('change');
        };

        const attachPanningEndListeners = () => {
            detachPanningEndListeners();
            document.addEventListener('mouseup', finishPanning, true);
            document.addEventListener('pointerup', finishPanning, true);
            document.addEventListener('pointercancel', finishPanning, true);
            window.addEventListener('blur', finishPanning);
        };

        const detachSelectionEndListeners = () => {
            document.removeEventListener('mouseup', finishSelection, true);
            document.removeEventListener('pointerup', finishSelection, true);
            document.removeEventListener('pointercancel', finishSelection, true);
            window.removeEventListener('blur', finishSelection);
        };

        const finishSelection = (event = null) => {
            if (!isSelecting) return;

            isSelecting = false;
            this.stage.draggable(true);
            detachSelectionEndListeners();
            this.selectionRect.visible(false);

            const box = this.selectionRect.getClientRect();
            const ctrlKey = Boolean(event?.ctrlKey || event?.metaKey);
            const shiftKey = Boolean(event?.shiftKey);
            if (box.width === 0 && box.height === 0) {
                if (!ctrlKey && !shiftKey) {
                    this.clearSelection();
                }
                return;
            }

            if (!ctrlKey && !shiftKey) {
                this.clearSelection();
            }

            const selBox = this.selectionRect.getClientRect();
            const shapes = this.stage.find('.nodeGroup');
            shapes.forEach(shape => {
                const shapeBox = shape.getClientRect();
                if (Konva.Util.haveIntersection(selBox, shapeBox)) {
                    this.selectItem(shape.attrs.id, true);
                }
            });
        };

        const attachSelectionEndListeners = () => {
            detachSelectionEndListeners();
            document.addEventListener('mouseup', finishSelection, true);
            document.addEventListener('pointerup', finishSelection, true);
            document.addEventListener('pointercancel', finishSelection, true);
            window.addEventListener('blur', finishSelection);
        };

        this.stage.on('mousedown', (e) => {
            if (e.evt.button === 2) {
                let current = e.target;
                while (current && current !== this.stage && current.name?.() !== 'nodeGroup') {
                    current = current.getParent?.();
                }
                if (current?.name?.() === 'nodeGroup') {
                    e.evt.preventDefault();
                    return;
                }
            }
            if (e.evt.button === 1 || e.evt.button === 2) {
                // Middle or Right click: 只平移画布，不拖动图片
                e.evt.preventDefault();
                isPanning = true;
                panMoved = false;

                // ── 关键：临时禁用 stage 和所有图片的 draggable ──
                setCanvasDragEnabled(false);

                const pos = this.stage.getPointerPosition();
                lastPanX = pos.x;
                lastPanY = pos.y;
                document.body.style.cursor = 'grabbing';
                attachPanningEndListeners();
                return;
            }
            const transformerTarget = e.target === this.imageTransformer
                || e.target?.findAncestor?.(node => node === this.imageTransformer);
            if (transformerTarget) {
                e.cancelBubble = true;
                return;
            }
            if (this._activePlanReferencePick && e.evt.button === 0 && (e.target === this.stage || e.target === this.selectionRect)) {
                e.evt.preventDefault();
                e.cancelBubble = true;
                this._cancelPlanReferencePick('已取消连接参考图');
                return;
            }
            if (this._activeMediaReferencePick && e.evt.button === 0) {
                const item = this._findMediaReferenceItemFromNode(e.target);
                if (item) {
                    e.evt.preventDefault();
                    e.cancelBubble = true;
                    item.group?.stopDrag?.();
                    this._lastMediaReferencePointerPick = { id: item.data.id, at: Date.now() };
                    this._toggleMediaReferencePick(item);
                    return;
                }
                if (e.target === this.stage || e.target === this.selectionRect) {
                    e.evt.preventDefault();
                    e.cancelBubble = true;
                    return;
                }
            }
            if (e.target !== this.stage && e.target !== this.selectionRect) {
                const group = e.target.findAncestor('Group');
                if (this._activePlanReferencePick && e.evt.button === 0 && (!group || !this.items.has(group.attrs.id))) {
                    e.evt.preventDefault();
                    e.cancelBubble = true;
                    this._cancelPlanReferencePick('已取消连接参考图');
                    return;
                }
                if (this._activePlanReferencePick && e.evt.button === 0 && group && this.items.has(group.attrs.id)) {
                    e.evt.preventDefault();
                    return;
                }
                if (group) {
                    if (this._isAltDragModifier(e.evt) && e.evt.button === 0) {
                        e.evt.preventDefault();
                        e.cancelBubble = true;

                        if (!this.selectedItems.has(group.attrs.id)) {
                            this.clearSelection();
                            this.selectItem(group.attrs.id, true);
                        }

                        const filePaths = this._getSelectedFilePathsForExternalDrag(group);
                        if (filePaths.length > 0) {
                            setCanvasDragEnabled(false);
                            group.stopDrag();
                            document.body.style.cursor = 'copy';

                            if (window.flowCanvas?.platform === 'darwin' && window.flowCanvas?.drag?.startExportCopy) {
                                this._showCanvasStatus(filePaths.length > 1
                                    ? `拖到 Finder：复制 ${filePaths.length} 个素材副本`
                                    : '拖到 Finder：复制素材副本', 3200);
                                window.flowCanvas.drag.startExportCopy(filePaths);
                                setCanvasDragEnabled(true);
                                document.body.style.cursor = 'default';
                                return;
                            }
                            this._showCanvasStatus(filePaths.length > 1
                                ? `拖到系统文件夹松手：复制 ${filePaths.length} 个素材副本`
                                : '拖到系统文件夹松手：复制素材副本', 4200);

                            this._copyFilesToExplorerAfterPointerRelease(filePaths);

                            let restored = false;
                            const restoreDrag = () => {
                                if (restored) return;
                                restored = true;
                                setCanvasDragEnabled(true);
                                document.body.style.cursor = 'default';
                                document.removeEventListener('mouseup', restoreDrag, true);
                                document.removeEventListener('pointerup', restoreDrag, true);
                                document.removeEventListener('pointercancel', restoreDrag, true);
                                window.removeEventListener('blur', restoreDrag);
                            };
                            document.addEventListener('mouseup', restoreDrag, true);
                            document.addEventListener('pointerup', restoreDrag, true);
                            document.addEventListener('pointercancel', restoreDrag, true);
                            window.addEventListener('blur', restoreDrag);
                            setTimeout(restoreDrag, 8200);
                        }
                        return;
                    }

                    if (!(e.evt.ctrlKey || e.evt.metaKey) && !e.evt.shiftKey && !this.selectedItems.has(group.attrs.id)) {
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
            attachSelectionEndListeners();
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

        // 空白处右键：插入节点。卡片/规划表自己的 contextmenu 已 cancelBubble，
        // 冒泡到 stage 的只剩空白区域。
        this.stage.on('contextmenu', (e) => {
            e.evt.preventDefault();
            const suppressed = this._suppressStageMenu;
            this._suppressStageMenu = false;
            if (suppressed) return;
            if (this.graphView?.pending) return;
            this._showInsertNodeMenu(e.evt);
        });

        this.stage.on('mousemove', (e) => {
            const hoveredItem = this._findMediaReferenceItemFromNode(e.target);
            this._setHoveredMediaItem(
                hoveredItem?.data?.kind === 'op' ? null : hoveredItem?.data?.id || null
            );
            if (this.graphView?.pending) {
                this.graphView._syncPending();
                return;
            }
            if (isPanning) {
                e.evt.preventDefault();
                const pos = this.stage.getPointerPosition();
                const dx = pos.x - lastPanX;
                const dy = pos.y - lastPanY;
                lastPanX = pos.x;
                lastPanY = pos.y;
                if (dx || dy) panMoved = true;

                this.stage.position({
                    x: this.stage.x() + dx,
                    y: this.stage.y() + dy
                });
                this.stage.batchDraw();
                // syncGifs 已由 rAF 批处理统一调用
                return;
            }

            if (this._activePlanReferencePick && !this._planReferencePickTargetId) {
                this._updatePlanReferencePickPreview(null, e.evt);
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
            // 连线结束由 graphView 的 document 级 mouseup 统一处理（单一驱动路径）。
            // 这里只需在拖拽连线时拦住平移/框选的收尾逻辑。
            if (this.graphView?.pending) {
                return;
            }
            if (isPanning) {
                finishPanning();
                return;
            }

            finishSelection(e.evt);
        });

        this.stage.on('dragend', (e) => {
            if (e.target.name() === 'nodeGroup') {
                const group = e.target;
                const entry = this._getNodeEntry(group.attrs.id);
                if (!entry) return;
                const data = entry.data;
                data.x = group.x();
                data.y = group.y();

                const displayNode = group.findOne('.displayNode');
                if (displayNode) {
                    data.width = displayNode.width();
                    data.height = displayNode.height();
                }

                if (entry.kind === 'plan') {
                    this.planService?.updatePlanNode(data.id, {
                        x: group.x(),
                        y: group.y(),
                        width: data.node?.width || data.width,
                        height: data.node?.height || data.height
                    });
                    this.emit('plansChanged');
                }
            }
            this._flushDragConnectionRefresh();
            this._refreshVisiblePlanConnections();
            this.graphView?.sync();
            this.emit('change');
        });

        this.stage.on('dragmove', (e) => {
            this._scheduleMinimapDraw();
            if (e.target.name() === 'nodeGroup') {
                const group = e.target;
                if (!this.selectedItems.has(group.attrs.id)) return;

                const movingEntry = this._getNodeEntry(group.attrs.id);
                if (this._autoSnapEnabled && movingEntry?.kind !== 'plan' && this.selectedItems.size === 1 && (!e.evt || !e.evt.shiftKey)) {
                    this._applyMagneticSnapping(group);
                }

                const deltaX = group.x() - group.getAttr('lastX');
                const deltaY = group.y() - group.getAttr('lastY');
                group.setAttr('lastX', group.x());
                group.setAttr('lastY', group.y());
                if (movingEntry) {
                    this._setEntryNodePosition(movingEntry, group.x(), group.y());
                }

                this.selectedItems.forEach(id => {
                    if (id === group.attrs.id) return;
                    const item = this._getNodeEntry(id);
                    if (item) {
                        item.group.x(item.group.x() + deltaX);
                        item.group.y(item.group.y() + deltaY);
                        this._setEntryNodePosition(item, item.group.x(), item.group.y());
                    }
                });

                if (movingEntry?.kind === 'plan') {
                    this._positionPlanInlineEditor(group.attrs.id);
                }
                this._scheduleDragConnectionRefresh(movingEntry);
                if (this.graphView) {
                    const scope = this.selectedItems.size ? this.selectedItems : [group.attrs.id];
                    this.graphView.scheduleSync(scope);
                }
                this._scheduleSelectionToolbarSync();
            }
        });

        this.stage.on('dragstart', (e) => {
            if (e.target.name() === 'nodeGroup') {
                // ── 只允许左键拖动图片，中键/右键用于画布平移 ──
                if (e.evt && e.evt.button !== 0) {
                    e.target.stopDrag();
                    return;
                }
                const group = e.target;
                if (!this.selectedItems.has(group.attrs.id)) {
                    this.clearSelection();
                    this.selectItem(group.attrs.id, true);
                }

                if (this._isAltDragModifier(e.evt)) {
                    e.target.stopDrag();
                    return;
                }

                // ── Ctrl+拖拽：在原位留下副本，拖走原件 ──
                if (e.evt && (e.evt.ctrlKey || e.evt.metaKey) && !this._isAltDragModifier(e.evt)) {
                    const clonedDataList = [];
                    let cloneIdx = 0;
                    this.selectedItems.forEach(id => {
                        const item = this.items.get(id);
                        if (!item) return;
                        const cloneData = {
                            id: Date.now().toString() + '_c' + (cloneIdx++) + Math.random().toString(36).substr(2, 5),
                            kind: item.data.kind,
                            mediaType: item.data.mediaType,
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
                    const item = this._getNodeEntry(id);
                    if (item) {
                        item.group.setAttr('lastX', item.group.x());
                        item.group.setAttr('lastY', item.group.y());
                    }
                });
            }
        });

        // Keyboard Shortcuts
        document.addEventListener('keydown', (e) => {
            if (this._activeImageCrop) {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this._closeImageCrop();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    void this._confirmImageCrop();
                }
                return;
            }
            if (this._activePlanReferencePick && e.key === 'Escape') {
                e.preventDefault();
                this._cancelPlanReferencePick('已取消连接参考图');
                return;
            }
            if (this._activeMediaReferencePick && e.key === 'Escape') {
                e.preventDefault();
                this.endMediaReferencePick();
                return;
            }
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;

            const key = e.key.toLowerCase();
            const commandKey = e.ctrlKey || e.metaKey;
            const shortcuts = this.shortcutBindings;
            const usesDefaultShiftRedo = shortcuts.undo === DEFAULT_SHORTCUTS.undo
                && commandKey && e.shiftKey && !e.altKey && key === 'z';
            const usesDefaultBackspace = shortcuts.delete === DEFAULT_SHORTCUTS.delete
                && e.key === 'Backspace';

            if (matchesShortcut(e, shortcuts.redo) || usesDefaultShiftRedo) {
                e.preventDefault();
                document.dispatchEvent(new CustomEvent('history-redo'));
            } else if (matchesShortcut(e, shortcuts.undo)) {
                e.preventDefault();
                document.dispatchEvent(new CustomEvent('history-undo'));
            } else if (matchesShortcut(e, shortcuts.duplicate)) {
                if (this.selectedItems.size > 0) {
                    e.preventDefault();
                    this.duplicateItems([...this.selectedItems]);
                }
            } else if (matchesShortcut(e, shortcuts.run)) {
                const opNodes = [...this.selectedItems]
                    .map(id => this.items.get(id)?.data)
                    .filter(item => item?.kind === 'op');
                if (opNodes.length === 1) {
                    e.preventDefault();
                    void this.runFromNode(opNodes[0].id);
                }
            } else if (commandKey && !e.shiftKey && !e.altKey && key === 'c') {
                if (this.selectedItems.size > 0) {
                    e.preventDefault();
                    this.copySelectionToClipboard();
                }
            } else if (matchesShortcut(e, shortcuts.delete) || usesDefaultBackspace) {
                if (this._selectedPlanConnection) {
                    e.preventDefault();
                    this._removeSelectedPlanConnection();
                } else if (this.selectedItems.size > 0) {
                    const idsToRemove = [...this.selectedItems];
                    const filePaths = idsToRemove.map(id => this.items.get(id)?.data.filePath).filter(Boolean);
                    const itemIds = idsToRemove.filter(id => this.items.has(id));
                    const planIds = idsToRemove.filter(id => this.plans.has(id));

                    if (idsToRemove.length > 0) {
                        const ev = new CustomEvent('context-remove', { detail: { itemIds, filePaths, planIds } });
                        document.dispatchEvent(ev);
                        this.clearSelection();
                    }
                }
            } else if (e.key === 'Escape') {
                this.clearSelection();
                this.contextMenu.hide();
            } else if (key === 'a' && commandKey) {
                e.preventDefault();
                this.selectAll();
            } else if (matchesShortcut(e, shortcuts.fit)) {
                e.preventDefault();
                this.fitAll();
            } else if (key === 'v' && commandKey) {
                // Ctrl+V 粘贴网页图片
                e.preventDefault();
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
            const dropTypes = Array.from(e.dataTransfer.types || []);
            const libraryFilePath = e.dataTransfer.getData('application/x-flow-asset');
            if (libraryFilePath) {
                const rect = this.container.getBoundingClientRect();
                const insideCanvas = e.clientX >= rect.left && e.clientX <= rect.right &&
                    e.clientY >= rect.top && e.clientY <= rect.bottom;
                if (insideCanvas) {
                    const scale = this.stage.scaleX();
                    const stagePosition = this.stage.position();
                    document.dispatchEvent(new CustomEvent('library-asset-drop', {
                        detail: {
                            filePath: libraryFilePath,
                            position: {
                                x: (e.clientX - rect.left - stagePosition.x) / scale,
                                y: (e.clientY - rect.top - stagePosition.y) / scale
                            }
                        }
                    }));
                }
                return;
            }
            console.log('[Canvas] 触发全局 drop 事件, types:', dropTypes);
            const stringItemPromises = Array.from(e.dataTransfer.items || [])
                .filter(item => item.kind === 'string')
                .map(item => new Promise(resolve => {
                    let settled = false;
                    const finish = (value = '') => {
                        if (settled) return;
                        settled = true;
                        resolve({ type: item.type, value });
                    };
                    try {
                        item.getAsString(finish);
                    } catch (_) {
                        finish();
                    }
                    setTimeout(() => finish(), 350);
                }));
            let imageUrls = collectDroppedImageUrls(e.dataTransfer);
            const files = Array.from(e.dataTransfer.files || []);
            const dropPosition = { offsetX: e.offsetX, offsetY: e.offsetY };
            const inMemoryFiles = files
                .filter(file => !file.path && file.size > 0 && /^image\//i.test(file.type))
                .map(file => ({
                    name: file.name,
                    type: file.type,
                    dataPromise: file.arrayBuffer()
                }));
            const targetDir = this._getDefaultSaveFolder();
            if (stringItemPromises.length > 0) {
                const stringPayloads = await Promise.all(stringItemPromises);
                imageUrls = [...new Set([
                    ...imageUrls,
                    ...collectDroppedImageUrls(null, stringPayloads)
                ])];
            }
            console.log('[Canvas] drop candidates:', imageUrls, 'files:', files.length);

            let lastRemoteError = '';
            if (imageUrls.length > 0) {
                this._showCanvasStatus('正在导入网页图片...');
                for (const imageUrl of imageUrls.slice(0, 12)) {
                    const result = await window.flowCanvas.image.downloadFromUrl(imageUrl, targetDir);
                    if (result?.success) {
                        this._addCapturedFile(result.filePath, dropPosition);
                        this._showCanvasStatus('网页图片已加入画板');
                        return;
                    }
                    lastRemoteError = result?.error || '下载失败';
                    console.warn('[Canvas] Dropped image candidate failed:', imageUrl, lastRemoteError);
                }
            }

            if (files.length > 0) {
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    if (file.path) {
                        const result = await this._archiveLocalDroppedFile(file.path, targetDir);
                        if (result?.success) {
                            this._addCapturedFile(result.filePath, dropPosition);
                        } else {
                            console.error('[Canvas] 归档本地文件失败:', result?.error);
                            this._addCapturedFile(file.path, dropPosition);
                        }
                    }
                }
                for (const file of inMemoryFiles) {
                    if (window.flowCanvas?.image?.saveDroppedFile) {
                        const result = await window.flowCanvas.image.saveDroppedFile({
                            name: file.name,
                            type: file.type,
                            data: await file.dataPromise
                        }, targetDir);
                        if (result?.success) {
                            this._addCapturedFile(result.filePath, dropPosition);
                            this._showCanvasStatus('网页图片已加入画板');
                            return;
                        }
                        lastRemoteError = result?.error || lastRemoteError;
                    }
                }
            }
            const typeHint = dropTypes.length > 0 ? `（${dropTypes.join(', ')}）` : '';
            this._showCanvasStatus(`网页图片导入失败${lastRemoteError ? `：${lastRemoteError}` : `：拖拽数据中没有可用图片${typeHint}`}`);
        });
    }

    _forEachNode(callback) {
        this.items.forEach(callback);
        this.plans.forEach(callback);
    }

    _getNodeEntry(id) {
        return this.items.get(id) || this.plans.get(id) || null;
    }

    _setEntryNodePosition(entry, x, y) {
        if (!entry) return;
        if (entry.kind === 'plan') {
            entry.data.node = { ...(entry.data.node || {}), x, y };
            entry.data.x = x;
            entry.data.y = y;
            this.planService?.updatePlanNode(entry.data.id, { x, y });
            this._positionPlanInlineEditor(entry.data.id);
        } else {
            entry.data.x = x;
            entry.data.y = y;
        }
    }

    _getDefaultSaveFolder() {
        return this.storeData.activeGroupDefaultSaveFolder
            || this.storeData.defaultSaveFolder
            || (this.storeData.watchFolders && this.storeData.watchFolders[0]);
    }

    _applyMagneticSnapping(movedGroup) {
        if (!this._autoSnapEnabled) return;
        // Keep the snap range stable on screen even when the canvas is zoomed far out.
        const SNAP_DIST = 14 / Math.max(0.08, this.stage.scaleX());
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

        for (let [itemId, item] of [...this.items.entries(), ...this.plans.entries()]) {
            if (item.group === movedGroup) continue;

            const targetNode = item.group.findOne('.displayNode') || item.group.findOne('.fallbackBg') || item.group.findOne('.planHitArea');
            if (!targetNode) continue;

            const tx = item.group.x();
            const ty = item.group.y();
            const tw = targetNode.width();
            const th = targetNode.height();

            const verticalAlignment = Math.min(
                Math.abs(my - ty),
                Math.abs(my + mh - (ty + th)),
                Math.abs(my + mh / 2 - (ty + th / 2))
            );
            const horizontalAlignment = Math.min(
                Math.abs(mx - tx),
                Math.abs(mx + mw - (tx + tw)),
                Math.abs(mx + mw / 2 - (tx + tw / 2))
            );
            const vProximity = Math.max(SNAP_DIST * 1.5, Math.min(mh, th) * 0.35);
            const hProximity = Math.max(SNAP_DIST * 1.5, Math.min(mw, tw) * 0.35);

            // Check Left/Right edges (Horizontal Alignment)
            if (Math.abs(mx + mw - tx) < bestDist && verticalAlignment < vProximity) {
                bestDist = Math.abs(mx + mw - tx);
                const scale = th / mh;
                snappedH = th;
                snappedW = mw * scale;
                snappedX = tx - snappedW;
                snappedY = ty;
                snapped = true;
            } else if (Math.abs(mx - (tx + tw)) < bestDist && verticalAlignment < vProximity) {
                bestDist = Math.abs(mx - (tx + tw));
                const scale = th / mh;
                snappedH = th;
                snappedW = mw * scale;
                snappedX = tx + tw;
                snappedY = ty;
                snapped = true;
            }

            // Check Top/Bottom edges (Vertical Alignment)
            if (Math.abs(my + mh - ty) < bestDist && horizontalAlignment < hProximity) {
                bestDist = Math.abs(my + mh - ty);
                const scale = tw / mw;
                snappedW = tw;
                snappedH = mh * scale;
                snappedY = ty - snappedH;
                snappedX = tx;
                snapped = true;
            } else if (Math.abs(my - (ty + th)) < bestDist && horizontalAlignment < hProximity) {
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

                const item = this._getNodeEntry(movedGroup.attrs.id);
                if (item) {
                    if (item.kind === 'plan') {
                        item.data.node = { ...(item.data.node || {}), width: snappedW, height: snappedH };
                        item.data.width = snappedW;
                        item.data.height = snappedH;
                        this.planService?.updatePlanNode(item.data.id, {
                            x: movedGroup.x(),
                            y: movedGroup.y(),
                            width: snappedW,
                            height: snappedH
                        });
                    } else {
                        item.data.width = snappedW;
                        item.data.height = snappedH;
                    }
                    if (item.gifDomElement) {
                        item.gifDomElement.style.width = `${snappedW}px`;
                        item.gifDomElement.style.height = `${snappedH}px`;
                    }
                }

                // Keep video controls screen-sized after snap resizing.
                const controlsGroup = movedGroup.findOne('.videoControls');
                const coverControls = movedGroup.findOne('.videoCoverControls');
                if (controlsGroup && movedGroup.attrs.filePath.match(/\.(mp4|mov|avi|mkv|wmv|flv|webm)$/i)) {
                    this._layoutVideoControlGroup(controlsGroup, snappedW, snappedH);
                }
                if (coverControls) this._layoutVideoControlGroup(coverControls, snappedW, snappedH);
                if (this.imageTransformer?.nodes?.()[0] === movedNode) {
                    this.imageTransformer.forceUpdate();
                }
            }
        }
    }

    /**
     * Alt+拖拽：等待鼠标松开后，把画板素材复制到鼠标下方的资源管理器文件夹。
     * 这比 Electron 原生拖放更稳定，也不会移动原始素材。
     */
    async _copyFilesToExplorerAfterPointerRelease(filePathOrPaths) {
        const filePaths = (Array.isArray(filePathOrPaths) ? filePathOrPaths : [filePathOrPaths]).filter(Boolean);
        if (filePaths.length === 0) return;
        if (!window.flowCanvas?.folder?.copyFilesToExplorer) {
            this._showCanvasStatus('请重启 Flow Canvas 后再使用 Alt 拖到系统文件夹', 3200);
            return;
        }

        this._showCanvasStatus(filePaths.length > 1
            ? `松开鼠标后复制 ${filePaths.length} 个素材到系统文件夹`
            : '松开鼠标后复制素材到系统文件夹', 4200);

        try {
            const result = await window.flowCanvas.folder.copyFilesToExplorer(filePaths, {
                waitForMouseUp: true,
                requireExplorerUnderMouse: true,
                timeoutMs: 8000
            });

            if (result?.success) {
                if (result.pasted) {
                    this._showCanvasStatus(filePaths.length > 1
                        ? `已投递 ${filePaths.length} 个素材到系统文件夹`
                        : '已投递素材到系统文件夹', 3200);
                    return;
                }

                const copiedCount = (result.copied || []).filter(entry => entry.copied !== false).length || result.copied?.length || filePaths.length;
                const folderName = this._fileNameFromPath(result.targetDir) || result.targetDir || '系统文件夹';
                this._showCanvasStatus(copiedCount > 1
                    ? `已复制 ${copiedCount} 个素材到 ${folderName}`
                    : `已复制素材到 ${folderName}`, 3200);
                return;
            }

            if (result?.clipboardReady) {
                this._showCanvasStatus(window.flowCanvas?.platform === 'darwin'
                    ? '已放入系统剪贴板，请在目标文件夹按 Command+V'
                    : '已放入系统剪贴板，请在目标文件夹按 Ctrl+V', 5200);
                return;
            }

            this._showCanvasStatus(`复制失败：${result?.error || '未找到系统文件夹'}`, 4200);
        } catch (err) {
            this._showCanvasStatus(`复制失败：${err?.message || err}`, 4200);
        }
    }

    _setNativeDragProxyActive(active) {
        if (!this.nativeDragProxy) return;
        this._nativeDragProxyActive = Boolean(active);
        this.nativeDragProxy.style.pointerEvents = 'none';
    }

    _getItemAtClientPoint(clientX, clientY) {
        const canvasPoint = this._getCanvasPointFromClient(clientX, clientY);
        let matched = null;
        Array.from(this.items.values())
            .sort((a, b) => b.group.getZIndex() - a.group.getZIndex())
            .some(item => {
                if (!item.group?.isVisible()) return false;
                const node = item.group.findOne('.displayNode') || item.group.findOne('.fallbackBg');
                if (!node) return false;
                const rect = node.getClientRect({ relativeTo: this.layer });
                const inside = canvasPoint.x >= rect.x
                    && canvasPoint.x <= rect.x + rect.width
                    && canvasPoint.y >= rect.y
                    && canvasPoint.y <= rect.y + rect.height;
                if (inside) matched = item;
                return inside;
            });
        return matched;
    }

    _isAltDragModifier(evt) {
        return !!(evt?.altKey || this.isAltPressed || evt?.getModifierState?.('Alt'));
    }

    _getSelectedFilePathsForExternalDrag(clickedGroup) {
        const entries = [];
        this.selectedItems.forEach(id => {
            const item = this.items.get(id);
            const filePath = this._copyableFilePath(item?.data);
            if (filePath && item.group.isVisible()) {
                entries.push({
                    filePath,
                    x: item.group.x(),
                    y: item.group.y()
                });
            }
        });

        if (entries.length === 0 && clickedGroup?.attrs?.filePath) {
            return [clickedGroup.attrs.filePath];
        }

        entries.sort((a, b) => (a.x - b.x) || (a.y - b.y));
        return entries.map(item => item.filePath);
    }

    async _handlePaste() {
        console.log('[Canvas] 尝试粘贴图片...');
        const targetDir = this._getDefaultSaveFolder();
        const result = await window.flowCanvas.image.pasteFromClipboard(targetDir);
        if (result && result.success) {
            this._addCapturedFile(result.filePath);
        } else {
            console.warn('[Canvas] 粘贴失败:', result?.error);
        }
    }

    async _archiveLocalDroppedFile(filePath, targetDir) {
        if (!targetDir) {
            return { success: true, filePath, archived: false, reason: 'no-target-dir' };
        }

        if (window.flowCanvas?.image?.archiveLocalFile) {
            return await window.flowCanvas.image.archiveLocalFile(filePath, targetDir);
        }

        return await window.flowCanvas.image.downloadFromUrl(`file:///${filePath.replace(/\\/g, '/')}`, targetDir);
    }

    _addCapturedFile(filePath, dropEvent, options = {}) {
        if (dropEvent || options.manualRestore) {
            this.emit('manualFileImport', filePath);
        }
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
        this._scheduleCullCheck(); // 新卡片创建后补加载内容
        this.emit('capturedFile', data); // 通知 main.js 保存到 store
    }

    _selectionHasPlan(selection = this.selectedItems) {
        if (!selection) return false;
        for (const id of selection) {
            if (this.plans.has(id)) return true;
        }
        return false;
    }

    _refreshSelectionVisualState(previousSelection = null, hadSelectedConnection = false) {
        if (
            hadSelectedConnection
            || this._selectionHasPlan(previousSelection)
            || this._selectionHasPlan(this.selectedItems)
        ) {
            this._refreshConnectionInteractionState();
            return;
        }
        this._updateSelectionVisuals();
    }

    selectItem(id, add = false) {
        const previousSelection = new Set(this.selectedItems);
        const hadSelectedConnection = Boolean(this._selectedPlanConnection);
        if (!add) this.clearSelection({ skipVisualRefresh: true });
        this.selectedItems.add(id);
        this._refreshSelectionVisualState(previousSelection, hadSelectedConnection);
        this.emit('selectionChanged', this.getSelectedCanvasEntries());
    }

    focusItemById(id, worldPoint = null) {
        const item = this.items.get(id);
        if (!item) return false;

        const displayNode = item.group.findOne('.displayNode') || item.group.findOne('.fallbackBg');
        const width = Math.max(1, Number(displayNode?.width?.()) || Number(item.data.width) || IMAGE_DEFAULT_WIDTH);
        const height = Math.max(1, Number(displayNode?.height?.()) || Number(item.data.height) || IMAGE_DEFAULT_WIDTH);

        if (Number.isFinite(worldPoint?.x) && Number.isFinite(worldPoint?.y)) {
            item.group.position({
                x: worldPoint.x - width / 2,
                y: worldPoint.y - height / 2
            });
            item.data.x = item.group.x();
            item.data.y = item.group.y();
        } else {
            const scale = this.stage.scaleX();
            const container = this.stage.container();
            this.stage.position({
                x: container.offsetWidth / 2 - (item.group.x() + width / 2) * scale,
                y: container.offsetHeight / 2 - (item.group.y() + height / 2) * scale
            });
        }

        this.selectItem(id, false);
        this.stage.batchDraw();
        this.syncBackground();
        this.syncGifs();
        this.syncPlanInlineEditors();
        this.graphView?.sync();
        this._scheduleMinimapDraw();
        this.emit('change');
        return true;
    }

    selectItems(ids = []) {
        const previousSelection = new Set(this.selectedItems);
        const hadSelectedConnection = Boolean(this._selectedPlanConnection);
        this.selectedItems.clear();
        this._selectedPlanConnection = null;
        if (hadSelectedConnection) this._clearPlanConnectionFocusState();

        ids.forEach(id => {
            if (this.items.has(id) || this.plans.has(id)) this.selectedItems.add(id);
        });

        this._refreshSelectionVisualState(previousSelection, hadSelectedConnection);
        this.emit('selectionChanged', this.getSelectedCanvasEntries());
    }

    clearSelection(options = {}) {
        const previousSelection = new Set(this.selectedItems);
        const hadSelectedConnection = Boolean(this._selectedPlanConnection);
        this.selectedItems.clear();
        this._selectedPlanConnection = null;
        if (hadSelectedConnection) this._clearPlanConnectionFocusState();
        if (options.skipVisualRefresh) return;
        this._refreshSelectionVisualState(previousSelection, hadSelectedConnection);
        this.emit('selectionChanged', this.getSelectedCanvasEntries());
    }

    selectAll() {
        const previousSelection = new Set(this.selectedItems);
        const hadSelectedConnection = Boolean(this._selectedPlanConnection);
        this._selectedPlanConnection = null;
        if (hadSelectedConnection) this._clearPlanConnectionFocusState();
        this.items.forEach(item => {
            if (item.group.isVisible()) {
                this.selectedItems.add(item.data.id);
            }
        });
        this.plans.forEach(plan => {
            if (plan.group.isVisible()) {
                this.selectedItems.add(plan.data.id);
            }
        });
        this._refreshSelectionVisualState(previousSelection, hadSelectedConnection);
        this.emit('selectionChanged', this.getSelectedCanvasEntries());
    }

    async copySelectionToClipboard() {
        const selectedEntries = [];
        this.selectedItems.forEach(id => {
            const item = this.items.get(id);
            const filePath = this._copyableFilePath(item?.data);
            if (filePath && item.group.isVisible()) {
                selectedEntries.push({
                    filePath,
                    x: item.group.x(),
                    y: item.group.y()
                });
            }
        });

        selectedEntries.sort((a, b) => (a.x - b.x) || (a.y - b.y));
        const filePaths = selectedEntries.map(item => item.filePath);
        if (filePaths.length === 0) return;

        try {
            const res = await window.flowCanvas.clipboard.copy(filePaths);
            if (res?.success) {
                this._showCopyStatus(filePaths.length, res);
            }
        } catch (err) {
            console.error('[Canvas] Ctrl+C 复制失败:', err);
            this._showCopyStatus(filePaths.length, { type: 'error' });
        }
    }

    _showCopyStatus(count, res) {
        const status = document.getElementById('titlebarStatus');
        if (!status) return;
        if (res?.type === 'error') {
            status.textContent = '复制失败';
        } else if (res?.type === 'file') {
            status.textContent = count > 1 ? `已复制 ${count} 个文件` : '已复制文件';
        } else {
            status.textContent = count > 1 ? `已复制 ${count} 个路径` : '已复制路径';
        }
        status.classList.add('status-visible');
        clearTimeout(this.copyStatusTimer);
        this.copyStatusTimer = setTimeout(() => {
            status.textContent = '';
            status.classList.remove('status-visible');
        }, 2200);
    }

    _updateSelectionVisuals() {
        this.items.forEach(item => {
            const isSelected = this.selectedItems.has(item.data.id);
            const node = item.group.findOne('.displayNode') || item.group.findOne('.fallbackBg');
            if (node) {
                if (isSelected) {
                    node.stroke('#d5d7db');
                    node.strokeWidth(item.data.kind === 'op' ? 2 : 2.5);
                } else {
                    const status = item.data.runStatus || 'idle';
                    node.stroke(item.data.kind === 'op'
                        ? (status === 'error' ? OP_STATUS_COLORS.error : 'rgba(255,255,255,0.13)')
                        : 'rgba(255,255,255,0.14)');
                    node.strokeWidth(item.data.kind === 'op' && status === 'error' ? 1.5 : 1);
                }
            }
        });
        this.graphView?.refreshPortVisibility();
        this.plans.forEach(plan => {
            const isSelected = this.selectedItems.has(plan.data.id);
            const node = plan.group.findOne('.planHitArea');
            if (!node) return;
            if (isSelected) {
                node.stroke('rgba(255, 255, 255, 0.01)');
                node.strokeWidth(0);
            } else {
                node.stroke('transparent');
                node.strokeWidth(0);
            }
        });
        this._scheduleMinimapDraw();
        this._syncImageTransformer();
        this._scheduleSelectionToolbarSync();
    }

    _getImageTransformerTarget() {
        const node = this.imageTransformer?.nodes?.()[0];
        const group = node?.getParent?.();
        const item = group ? this.items.get(group.id()) : null;
        if (!node || !item || this._getFileType(item.data.filePath) !== 'image') return null;
        return { item, group, node };
    }

    _syncImageTransformer() {
        if (!this.imageTransformer) return;
        if (this._activeImageCrop) {
            if (this.imageTransformer.nodes().length) this.imageTransformer.nodes([]);
            return;
        }
        const selectedIds = Array.from(this.selectedItems);
        const item = selectedIds.length === 1 ? this.items.get(selectedIds[0]) : null;
        const isImage = item && this._getFileType(item.data.filePath) === 'image';
        const node = isImage ? item.group.findOne('.displayNode') : null;
        const currentNode = this.imageTransformer.nodes()[0];

        if (!node) {
            if (currentNode) this.imageTransformer.nodes([]);
            return;
        }
        if (currentNode !== node) this.imageTransformer.nodes([node]);
        this.imageTransformer.moveToTop();
        this.imageTransformer.forceUpdate();
    }

    _beginImageResize() {
        const target = this._getImageTransformerTarget();
        if (!target) return;
        const { item, group, node } = target;
        item.isResizing = true;
        clearTimeout(item.hoverTimer);
        item.hoverTimer = null;
        if (item.loading && item.transitionOldNode === node) {
            this._prepareQualityReload(item, item.transitionPreviousIsThumbnail);
        }
        if (item.qualityTransition?.finish) item.qualityTransition.finish();
        group.draggable(false);
        if (item.gifDomElement) item.gifDomElement.style.display = 'none';
    }

    _updateImageResize() {
        const target = this._getImageTransformerTarget();
        if (!target) return;
        this._scheduleDragConnectionRefresh(target.item);
    }

    _finishImageResize() {
        const target = this._getImageTransformerTarget();
        if (!target) return;
        const { item, group, node } = target;
        const width = Math.max(48, node.width() * Math.abs(node.scaleX()));
        const height = Math.max(48, node.height() * Math.abs(node.scaleY()));

        group.position({
            x: group.x() + node.x(),
            y: group.y() + node.y()
        });
        node.position({ x: 0, y: 0 });
        node.scale({ x: 1, y: 1 });
        node.size({ width, height });

        item.data.x = group.x();
        item.data.y = group.y();
        item.data.width = width;
        item.data.height = height;
        this._syncExternalNodeTitle(item.group, item.data, this._getItemMediaType(item.data));
        item.isResizing = false;
        group.draggable(true);

        if (item.gifDomElement) {
            item.gifDomElement.style.width = `${width}px`;
            item.gifDomElement.style.height = `${height}px`;
            this.syncGifs();
        }

        this.imageTransformer.forceUpdate();
        this._scheduleSelectionToolbarSync();
        this._flushDragConnectionRefresh();
        this._refreshVisiblePlanConnections();
        this.layer.batchDraw();
        this.emit('change');
        if (this.resourceSaverMode) this._scheduleResourceSaverPromote(item);
    }

    // ── 清空画布上所有卡片（用于切换文件夹组） ──
    clearAll(options = {}) {
        this._closeImageCrop({ silent: true });
        if (!options.preserveTransients) this.clearVideoGenerationPlaceholders();
        this.graphView?.closeConnectionNodeMenu?.();
        this._closeInlineOpPromptEditor({ commit: false });
        this._removeAllPersistentTextEditors();
        this._closeMediaTitleEditor({ commit: false });
        this._closeOpPromptPresetMenu();
        this.endMediaReferencePick({ silent: true, clearHighlights: true });
        console.log('[Canvas] clearAll: 清除', this.items.size, '个卡片');
        this._flushDragConnectionRefresh();
        this._cancelPlanReferencePick('', { refresh: false });
        this._selectedPlanConnection = null;
        this._clearPlanConnectionFocusState();
        this._hidePlanConnectionHint();
        this._renderGeneration += 1;
        this._contentLoadQueue = [];
        this._activeContentLoads = 0;
        this.items.forEach(item => {
            clearTimeout(item.hoverTimer);
            item.hoverTimer = null;
            this._unloadContent(item);
            if (item.group) item.group.destroy();
        });
        this.items.clear();
        this.plans.forEach(plan => {
            if (plan.group) plan.group.destroy();
        });
        this.plans.clear();
        this._removeAllPlanInlineEditors();
        this.selectedItems.clear();
        this.layer.batchDraw();
        this._canvasBounds = null;
        this._refreshCanvasBoundary({ reset: true });
    }

    // ── 设置视口位置和缩放 ──
    setViewport(viewport) {
        if (viewport) {
            const scale = Math.max(
                MIN_VIEWPORT_SCALE,
                Math.min(MAX_VIEWPORT_SCALE, Number(viewport.scale) || 1)
            );
            this.stage.position({ x: viewport.x || 0, y: viewport.y || 0 });
            this.stage.scale({ x: scale, y: scale });
            this.stage.batchDraw();
            this.syncGifs();
            this.syncBackground();
            this.syncPlanInlineEditors();
            this._syncPersistentTextEditors();
            this._syncCanvasViewDock();
            this._scheduleMinimapDraw();
        }
    }

    renderInitialItems() {
        const items = this.storeData.items || [];
        console.log('[Canvas] renderInitialItems: storeData.items 数量 =', items.length);
        const generation = ++this._renderGeneration;
        const batchSize = 120;
        let index = 0;

        const renderBatch = () => {
            if (generation !== this._renderGeneration) return;

            const end = Math.min(index + batchSize, items.length);
            for (; index < end; index++) {
                const raw = items[index];
                if (raw?.kind === 'op') {
                    if (raw.id && this.items.has(raw.id)) continue;
                    raw.runStatus = 'idle';
                    raw.runError = '';
                    this._createOpNode(raw);
                    continue;
                }
                if (this._isInternalProcessFile(raw?.filePath)) continue;
                if (raw?.id && this.items.has(raw.id)) continue;
                this._createCard(raw);
            }

            this.layer.batchDraw();
            this._refreshCanvasBoundary();

            if (index < items.length) {
                requestAnimationFrame(renderBatch);
            } else {
                console.log('[Canvas] renderInitialItems 完成: this.items.size =', this.items.size);
                this.emit('initialRenderComplete', { itemCount: this.items.size });
                requestAnimationFrame(() => this._loadAllContent());
            }
        };

        renderBatch();
        this.renderPlans();
    }

    getSelectedCanvasEntries() {
        const selected = [];
        this.selectedItems.forEach(id => {
            const entry = this._getNodeEntry(id);
            if (!entry?.data || !entry.group?.isVisible()) return;
            selected.push({
                id,
                kind: entry.kind || entry.data.kind || (entry.data.filePath ? 'asset' : 'node'),
                filePath: entry.data.filePath || null,
                mediaType: entry.data.mediaType || (entry.data.filePath ? this._getFileType(entry.data.filePath) : null),
                x: entry.group.x(),
                y: entry.group.y(),
                model: entry.data.model || null,
                status: entry.data.status || null
            });
        });
        return selected.sort((a, b) => (a.y - b.y) || (a.x - b.x));
    }

    renderPlans() {
        this._removeAllPlanInlineEditors();
        this.plans.forEach(plan => plan.group?.destroy());
        this.plans.clear();

        const plans = this.planService?.listPlans?.() || [];
        plans.forEach(plan => this._createPlanNode(plan));
        if (this._activePlanReferencePick) {
            const { planId, rowId } = this._activePlanReferencePick;
            if (!this._getPlanRowConnectionAnchor(planId, rowId)) {
                this._cancelPlanReferencePick('', { refresh: false });
            }
        }
        this.layer.batchDraw();
        this.syncPlanInlineEditors();
        this.setFilter(Array.isArray(this.currentFilter) ? this.currentFilter : [this.currentFilter]);
        this._refreshCanvasBoundary();
    }

    _getFileType(filePath) {
        const ext = String(filePath || '').split('.').pop().toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'svg', 'ico'].includes(ext)) return 'image';
        if (['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm', 'm4v'].includes(ext)) return 'video';
        if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'wma', 'm4a'].includes(ext)) return 'audio';
        if (['pdf', 'doc', 'docx', 'txt', 'ppt', 'pptx', 'xls', 'xlsx'].includes(ext)) return 'document';
        return 'other';
    }

    _getItemMediaType(data = {}) {
        const explicitType = String(data.mediaType || '').toLowerCase();
        if (['image', 'video', 'audio', 'document', 'other'].includes(explicitType)) return explicitType;
        return this._getFileType(data.filePath);
    }

    _mediaPlaceholderSize(fileType, data = {}) {
        const savedWidth = Number(data.width) > 0 ? Number(data.width) : 0;
        const savedHeight = Number(data.height) > 0 ? Number(data.height) : 0;
        const defaults = fileType === 'image'
            ? { width: IMAGE_DEFAULT_WIDTH, height: IMAGE_DEFAULT_WIDTH }
            : fileType === 'video'
                ? { width: IMAGE_DEFAULT_WIDTH, height: Math.round(IMAGE_DEFAULT_WIDTH / VIDEO_PLACEHOLDER_DEFAULT_RATIO) }
                : fileType === 'audio'
                    ? { width: AUDIO_NODE_WIDTH, height: AUDIO_NODE_HEIGHT }
                    : { width: DOC_DEFAULT_SIZE, height: DOC_DEFAULT_SIZE };
        const width = savedWidth || defaults.width;
        const height = savedHeight || (savedWidth ? Math.round(savedWidth * defaults.height / defaults.width) : defaults.height);
        return { width, height };
    }

    _nodeTypeLabel(type, data = {}) {
        if (data.kind === 'op') return data.title || NODE_TYPES[data.nodeType]?.title || '节点';
        const labels = {
            image: '图片',
            video: '视频',
            audio: '音频',
            document: '文件',
            other: '素材'
        };
        return labels[type] || labels.other;
    }

    _mediaDisplayName(data = {}, type = this._getItemMediaType(data)) {
        if (type !== 'image') return this._nodeTypeLabel(type, data);
        const customName = String(data.displayName || '').trim();
        if (customName) return customName;
        const fileName = this._fileNameFromPath(data.filePath);
        const extensionIndex = fileName.lastIndexOf('.');
        const stem = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName;
        return stem || '未命名图片';
    }

    _truncateExternalTitle(value, maxWidth, fontSize = 13) {
        const text = String(value || '').trim();
        if (!text) return '';
        const suffix = '..';
        const canvas = this._externalTitleMeasureCanvas || document.createElement('canvas');
        this._externalTitleMeasureCanvas = canvas;
        const context = canvas.getContext('2d');
        if (!context) return text;
        context.font = `400 ${fontSize}px "Segoe UI", sans-serif`;
        if (context.measureText(text).width <= maxWidth) return text;
        if (context.measureText(suffix).width >= maxWidth) return suffix;

        const characters = Array.from(text);
        let low = 0;
        let high = characters.length;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            const candidate = `${characters.slice(0, middle).join('').trimEnd()}${suffix}`;
            if (context.measureText(candidate).width <= maxWidth) low = middle;
            else high = middle - 1;
        }
        return `${characters.slice(0, low).join('').trimEnd()}${suffix}`;
    }

    _syncExternalNodeTitle(group, data, type) {
        if (!group || !data) return;
        group.findOne('.externalNodeTitle')?.destroy();

        const nodeType = data.kind === 'op' ? data.nodeType : type;
        const editableImageTitle = data.kind !== 'op' && type === 'image';
        const label = editableImageTitle
            ? this._mediaDisplayName(data, type)
            : this._nodeTypeLabel(type, data);
        const titleWidth = Math.max(40, Number(data.width) || OP_NODE_WIDTH);
        const textWidth = Math.max(20, titleWidth - 20);
        const visibleLabel = editableImageTitle
            ? this._truncateExternalTitle(label, textWidth)
            : label;
        const title = new Konva.Group({
            name: editableImageTitle ? 'externalNodeTitle editableMediaTitle' : 'externalNodeTitle',
            x: 0,
            y: -27,
            listening: editableImageTitle
        });
        if (editableImageTitle) {
            title.add(new Konva.Rect({
                name: 'externalNodeTitleHit',
                width: titleWidth,
                height: 24,
                fill: 'rgba(0,0,0,0.001)',
                listening: true
            }));
        }
        title.add(new Konva.Path({
            data: NODE_GLYPH_PATHS[nodeType] || NODE_GLYPH_PATHS.document,
            x: 0,
            y: 3,
            scaleX: 0.72,
            scaleY: 0.72,
            stroke: '#989ba1',
            strokeWidth: 1.35,
            lineCap: 'round',
            lineJoin: 'round',
            fill: null,
            perfectDrawEnabled: false,
            listening: false
        }));
        title.add(new Konva.Text({
            name: 'externalNodeTitleText',
            x: 20,
            y: 3,
            width: textWidth,
            height: 18,
            text: visibleLabel,
            fontFamily: 'Segoe UI, sans-serif',
            fontSize: 13,
            fontStyle: 'normal',
            fill: '#b8bbc0',
            wrap: 'none',
            listening: false
        }));

        if (editableImageTitle) {
            title.on('mouseenter', () => {
                document.body.style.cursor = 'text';
            });
            title.on('mouseleave', () => {
                document.body.style.cursor = 'default';
            });
            title.on('dblclick dbltap', event => {
                event.cancelBubble = true;
                this.openMediaTitleEditor(data.id);
            });
        }
        group.add(title);
        title.moveToTop();
    }

    _styleMediaDisplayNode(item, node) {
        if (!item || !node) return;
        node.cornerRadius?.(8);
        node.stroke(this.selectedItems.has(item.data.id) ? '#d5d7db' : 'rgba(255,255,255,0.14)');
        node.strokeWidth(this.selectedItems.has(item.data.id) ? 2.5 : 1);
        node.shadowColor?.('rgba(0,0,0,0.32)');
        node.shadowBlur?.(10);
        node.shadowOffsetY?.(3);
        node.shadowOpacity?.(0.42);
        node.perfectDrawEnabled?.(false);
        this._syncExternalNodeTitle(item.group, item.data, this._getItemMediaType(item.data));
        this.graphView?.renderPorts(item.data.id);
        this.graphView?.scheduleSync(item.data.id);
    }

    _createFallbackGroup(fileType, width = DOC_DEFAULT_SIZE, height = DOC_DEFAULT_SIZE, filePath = '') {
        const group = new Konva.Group({
            name: 'fallbackIcon',
            width,
            height
        });

        group.add(new Konva.Rect({
            name: 'fallbackBg',
            width,
            height,
            fill: '#202123',
            stroke: 'rgba(255,255,255,0.14)',
            strokeWidth: 1,
            cornerRadius: 8,
            shadowColor: 'rgba(0,0,0,0.32)',
            shadowBlur: 10,
            shadowOffsetY: 3,
            shadowOpacity: 0.42,
            perfectDrawEnabled: false
        }));

        const documentTitle = fileType === 'document' ? this._fileNameFromPath(filePath) : '';
        if (fileType === 'audio') {
            group.add(this._createAudioWaveform(width, height, filePath));
        } else {
            const emptyImage = fileType === 'image' && !filePath;
            group.add(this._createFallbackGlyph(fileType, width, height, documentTitle ? 46 : (emptyImage ? 34 : 0)));
            if (emptyImage) {
                group.add(new Konva.Text({
                    name: 'emptyMediaLabel',
                    x: 12,
                    y: Math.max(12, height - 34),
                    width: Math.max(1, width - 24),
                    height: 18,
                    text: '上传图片',
                    fill: '#8e949f',
                    fontSize: 11,
                    align: 'center',
                    verticalAlign: 'middle',
                    listening: false
                }));
            }
        }
        if (documentTitle) {
            group.add(new Konva.Text({
                name: 'fallbackTitle',
                x: 10,
                y: Math.max(8, height - 44),
                width: Math.max(1, width - 20),
                height: 34,
                text: documentTitle,
                fill: '#d8dbe3',
                fontSize: 11,
                lineHeight: 1.25,
                align: 'center',
                verticalAlign: 'middle',
                wrap: 'char',
                ellipsis: true,
                listening: false
            }));
        }
        return group;
    }

    _createAudioWaveform(width, height, filePath) {
        const group = new Konva.Group({ name: 'audioWaveform', listening: false });
        const fileName = this._fileNameFromPath(filePath) || '未命名音频';
        const extension = fileName.includes('.') ? fileName.split('.').pop().toUpperCase() : 'AUDIO';
        group.add(new Konva.Path({
            data: NODE_GLYPH_PATHS.audio,
            x: 14,
            y: 12,
            scaleX: 0.9,
            scaleY: 0.9,
            stroke: '#aeb4bf',
            strokeWidth: 1.5,
            lineCap: 'round',
            lineJoin: 'round',
            perfectDrawEnabled: false,
            listening: false
        }));
        group.add(new Konva.Text({
            name: 'audioFileName',
            x: 46,
            y: 10,
            width: Math.max(1, width - 60),
            height: 18,
            text: fileName,
            fill: '#d0d3d9',
            fontSize: 11,
            ellipsis: true,
            wrap: 'none',
            listening: false
        }));
        group.add(new Konva.Text({
            x: 46,
            y: 29,
            width: Math.max(1, width - 60),
            height: 14,
            text: extension,
            fill: '#6f7580',
            fontSize: 8,
            listening: false
        }));

        const waveX = 14;
        const waveY = Math.max(52, height - 32);
        const waveWidth = Math.max(40, width - 28);
        const barCount = Math.max(18, Math.min(42, Math.floor(waveWidth / 7)));
        const gap = waveWidth / barCount;
        const seed = [...fileName].reduce((total, char) => (total + char.charCodeAt(0)) % 997, 37);
        for (let index = 0; index < barCount; index += 1) {
            const value = Math.abs(Math.sin((index + 1) * 1.71 + seed * 0.013));
            const barHeight = 4 + Math.round(value * Math.max(8, Math.min(22, height - 62)));
            group.add(new Konva.Rect({
                x: waveX + index * gap,
                y: waveY + (24 - barHeight) / 2,
                width: Math.max(2, gap - 3),
                height: barHeight,
                cornerRadius: 1,
                fill: index % 5 === 0 ? '#9da4af' : '#666d78',
                listening: false,
                perfectDrawEnabled: false
            }));
        }
        return group;
    }

    _requestMediaReplacement(data) {
        document.dispatchEvent(new CustomEvent('context-relink-material', {
            detail: { itemId: data.id, itemIds: [data.id], filePath: data.filePath || '' }
        }));
    }

    _setHoveredMediaItem(itemId = null) {
        const nextId = itemId && this.items.has(itemId) ? itemId : null;
        if (this._hoveredMediaItemId === nextId) return;

        const previousId = this._hoveredMediaItemId;
        this._hoveredMediaItemId = nextId;
        if (previousId) {
            const previous = this.items.get(previousId);
            if (previous) {
                previous.isHovered = false;
                this._demoteResourceSaverItem(previous);
                this.graphView?.setNodeHovered(previousId, false);
                previous.group.getLayer()?.batchDraw();
            }
        }

        if (!nextId) return;
        const next = this.items.get(nextId);
        if (!next || next.data?.kind === 'op') return;
        next.isHovered = true;
        this._setVideoControlsVisible(next, true);
        this._scheduleResourceSaverPromote(next);
        this.graphView?.setNodeHovered(nextId, true);
        next.group.getLayer()?.batchDraw();
    }

    _syncHoveredMediaItemAtPointer() {
        const pointer = this.stage?.getPointerPosition?.();
        if (!pointer) return;
        const target = this.stage.getIntersection(pointer);
        const hoveredItem = this._findMediaReferenceItemFromNode(target);
        this._setHoveredMediaItem(
            hoveredItem?.data?.kind === 'op' ? null : hoveredItem?.data?.id || null
        );
    }

    _markFallbackLoadError(item, message = '加载失败') {
        if (!item?.group) return;
        item.loadErrorMessage = String(message || '加载失败');
        if (!item.group.findOne('.fallbackIcon')) {
            const fileType = this._getItemMediaType(item.data);
            const { width: w, height: h } = this._mediaPlaceholderSize(fileType, item.data);
            item.group.add(this._createFallbackGroup(fileType, w, h, item.data.filePath));
        }

        const fallback = item.group.findOne('.fallbackIcon');
        if (!fallback) return;
        fallback.findOne('.fallbackErrorBadge')?.destroy();

        const bg = fallback.findOne('.fallbackBg');
        const width = bg?.width?.() || item.data.width || DOC_DEFAULT_SIZE;
        const height = bg?.height?.() || item.data.height || DOC_DEFAULT_SIZE;
        const badgeText = String(message || '加载失败');
        const badgeWidth = Math.max(52, Math.min(92, this._estimateTextWidth(badgeText) + 18));
        const badgeGroup = new Konva.Group({
            name: 'fallbackErrorBadge',
            x: Math.max(8, width - badgeWidth - 8),
            y: fallback.findOne('.fallbackTitle') ? 8 : Math.max(8, height - 27),
            listening: true
        });

        badgeGroup.add(new Konva.Rect({
            width: badgeWidth,
            height: 19,
            fill: 'rgba(72, 20, 26, 0.92)',
            stroke: 'rgba(255, 133, 133, 0.55)',
            strokeWidth: 1,
            cornerRadius: 9.5,
            perfectDrawEnabled: false,
            listening: true
        }));
        badgeGroup.add(new Konva.Text({
            x: 8,
            y: 5,
            width: badgeWidth - 16,
            text: badgeText,
            fill: '#ffb4b4',
            fontSize: 9,
            fontStyle: 'bold',
            align: 'center',
            listening: false
        }));

        badgeGroup.on('mouseenter', () => {
            document.body.style.cursor = 'pointer';
            this._showCanvasStatus('点击手动重接素材，或右键选择自动修补');
        });
        badgeGroup.on('mouseleave', () => {
            document.body.style.cursor = 'default';
        });
        badgeGroup.on('click tap', e => {
            e.cancelBubble = true;
            document.dispatchEvent(new CustomEvent('context-relink-material', {
                detail: {
                    itemId: item.data.id,
                    itemIds: [item.data.id],
                    filePath: item.data.filePath
                }
            }));
        });

        fallback.add(badgeGroup);
    }

    _createFallbackGlyph(fileType, width, height, reservedBottom = 0) {
        const size = Math.max(34, Math.min(58, Math.min(width, height) * 0.42));
        const scale = size / 24;
        const x = (width - size) / 2;
        const y = Math.max(8, (height - reservedBottom - size) / 2);
        const stroke = '#7d8492';
        const accent = '#a0a8b8';

        const group = new Konva.Group({
            name: 'fallbackGlyph',
            x,
            y,
            scaleX: scale,
            scaleY: scale,
            listening: false
        });

        const base = {
            stroke,
            strokeWidth: 1.8,
            lineCap: 'round',
            lineJoin: 'round',
            listening: false,
            perfectDrawEnabled: false
        };

        const paths = {
            image: [
                { data: 'M4.5 5.5H19.5V18.5H4.5Z M7 15.5L10.2 12.3L13.2 15.2L15.3 13.1L18 15.8 M8.2 8.7H8.4' }
            ],
            video: [
                { data: 'M4.5 6H19.5V18H4.5Z M8 6V18 M16 6V18' },
                { data: 'M10.5 9.3L15.4 12L10.5 14.7Z', fill: accent, stroke: accent, strokeWidth: 1.2 }
            ],
            audio: [
                { data: 'M5.5 10H8.6L13.5 6.2V17.8L8.6 14H5.5Z M17 9.5C18.2 10.7 18.2 13.3 17 14.5' }
            ],
            document: [
                { data: 'M7 4.5H14.5L18 8V19.5H7Z M14.5 4.5V8H18 M10 12H15 M10 15H15 M10 18H13' }
            ],
            other: [
                { data: 'M7 4.5H14.5L18 8V19.5H7Z M14.5 4.5V8H18 M10 12H15 M10 15H15 M10 18H13' }
            ]
        };

        (paths[fileType] || paths.other).forEach(path => {
            group.add(new Konva.Path({
                ...base,
                ...path,
                fill: path.fill || null
            }));
        });

        return group;
    }

    async _createCard(data) {
        const fileType = this._getItemMediaType(data);
        const placeholderSize = this._mediaPlaceholderSize(fileType, data);
        data.mediaType = fileType;

        const group = new Konva.Group({
            x: data.x || 0, y: data.y || 0,
            draggable: true,
            id: data.id,
            name: 'nodeGroup',
            filePath: data.filePath
        });

        // 默认占位块（在图片未加载完成前或非图片文件时显示）
        group.add(this._createFallbackGroup(fileType, placeholderSize.width, placeholderSize.height, data.filePath));
        this._syncExternalNodeTitle(group, data, fileType);

        group.on('mouseenter', () => {
            const item = this.items.get(data.id);
            this._setHoveredMediaItem(data.id);
            if (this._activePlanReferencePick) {
                document.body.style.cursor = 'crosshair';
                this._planReferencePickTargetId = data.id;
                this._setItemReferenceHighlight(data.id, true);
                if (item) this._updatePlanReferencePickPreview(item);
                return;
            }
            if (this._activeMediaReferencePick) {
                document.body.style.cursor = 'crosshair';
                return;
            }
            document.body.style.cursor = 'pointer';
            if (item?.loadError) {
                const errorLabel = item.loadErrorMessage || '加载失败';
                const guidance = errorLabel === '文件失联'
                    ? '文件已移动或删除，点击错误标记可手动重接'
                    : errorLabel === '无法解码'
                        ? '文件仍在磁盘，但当前视频编码或容器无法读取，可重接为兼容文件'
                        : '点击错误标记可手动重接';
                this._showCanvasStatus(`${errorLabel}：${this._fileNameFromPath(data.filePath)}，${guidance}`, 4600);
            }
            if (this._countPlanReferencesToItem(data.id, data.filePath) > 0) {
                this._setHoveredReferenceItem(data.id, data.filePath);
            }
        });
        group.on('mouseleave', () => {
            document.body.style.cursor = 'default';
            const item = this.items.get(data.id);
            if (this._hoveredMediaItemId === data.id) this._setHoveredMediaItem(null);
            if (this._activePlanReferencePick) {
                this._setItemReferenceHighlight(data.id, false);
                if (this._planReferencePickTargetId === data.id) {
                    this._planReferencePickTargetId = null;
                }
                this._updatePlanReferencePickPreview(null);
                return;
            }
            if (this._activeMediaReferencePick) return;
            if (this._isHoveredReferenceItem(data.id, data.filePath)) {
                this._setHoveredReferenceItem(null, null);
            }
        });

        group.on('click tap', (e) => {
            if (e.evt.button != null && e.evt.button !== 0) return;
            if (this._activeMediaReferencePick) {
                e.cancelBubble = true;
                e.evt.preventDefault();
                const recentPick = this._lastMediaReferencePointerPick;
                if (recentPick?.id === data.id && Date.now() - recentPick.at < 500) return;
                this._toggleMediaReferencePick(this.items.get(data.id));
                return;
            }
            if (this._activePlanReferencePick) {
                e.cancelBubble = true;
                e.evt.preventDefault();
                const item = this.items.get(data.id);
                if (item) this._finishPlanReferencePick(item);
                return;
            }
            if (e.evt.ctrlKey || e.evt.metaKey || e.evt.shiftKey) {
                if (this.selectedItems.has(data.id)) {
                    const previousSelection = new Set(this.selectedItems);
                    this.selectedItems.delete(data.id);
                    this._refreshSelectionVisualState(previousSelection);
                } else {
                    this.selectItem(data.id, true);
                }
            }
        });

        group.on('mousemove', (e) => {
            if (!this._activePlanReferencePick) return;
            const item = this.items.get(data.id);
            if (item) this._updatePlanReferencePickPreview(item, e.evt);
        });

        group.on('contextmenu', (e) => {
            e.cancelBubble = true;
            if (!this.selectedItems.has(data.id)) {
                this.selectItem(data.id, false);
            }
            const selectedEntries = [];
            this.selectedItems.forEach(id => {
                const item = this.items.get(id);
                if (item) {
                    selectedEntries.push({
                        id,
                        filePath: item.data.filePath,
                        x: item.group.x(),
                        y: item.group.y()
                    });
                }
            });
            selectedEntries.sort((a, b) => (a.x - b.x) || (a.y - b.y));
            const selectedFiles = selectedEntries.map(item => item.filePath).filter(Boolean);
            const selectedIds = selectedEntries.map(item => item.id);
            const currentItem = this.items.get(data.id);
            this.contextMenu.show(e, {
                itemId: data.id,
                filePath: data.filePath,
                filePaths: selectedFiles,
                itemIds: selectedIds,
                loadError: Boolean(currentItem?.loadError),
                mediaType: currentItem?.data?.mediaType || fileType
            });
        });

        group.on('dblclick', () => {
            if (this._activePlanReferencePick) return;
            if (data.filePath) {
                window.flowCanvas.shell.openFile(data.filePath);
            } else {
                this._requestMediaReplacement(data);
            }
        });

        this.layer.add(group);
        // 标记为未加载，卡片创建完成后统一加载内容
        this.items.set(data.id, {
            group,
            data,
            loaded: !data.filePath,
            loading: false,
            isThumbnail: false,
            loadToken: 0,
            loadQueued: false,
            queuedUseThumbnail: false,
            hoverTimer: null,
            hoverFull: false,
            isResizing: false,
            qualityTransition: null,
            transitionOldNode: null,
            transitionPreviousIsThumbnail: null,
            gifDomElement: null,
            videoElement: null,
            videoAnimation: null,
            autoPlayVideo: false,
            loadError: false,
            loadErrorMessage: '',
            isHovered: false
        });

        const pendingPlacement = this.pendingGenerationPlacements.get(data.id);
        if (pendingPlacement) this._applyGenerationPlacement(data.id, pendingPlacement);

        this.graphView?.renderPorts(data.id);

        return group;
    }

    /**
     * 新建功能节点。pos 省略时落在视口中心。
     * 数据进 storeData.items，与素材卡片同一条持久化链路。
     */
    /**
     * 空白处右键的「插入节点」菜单。复用 .plan-context-menu 的样式与关闭逻辑，
     * 节点在光标处落地而非视口中心 —— 右键的位置就是用户想要的位置。
     */
    _showInsertNodeMenu(evt) {
        this.graphView?.closeConnectionNodeMenu?.();
        this._removePlanContextMenu();
        const at = evt.insertAt || this._getCanvasPointFromClient(evt.clientX, evt.clientY);

        const menu = document.createElement('div');
        menu.className = 'plan-context-menu insert-node-menu';

        const heading = document.createElement('div');
        heading.className = 'insert-node-heading';
        heading.textContent = '插入节点';
        menu.appendChild(heading);

        const emptyImageButton = document.createElement('button');
        emptyImageButton.type = 'button';
        emptyImageButton.className = 'plan-context-item insert-node-item';
        emptyImageButton.innerHTML =
            `<span class="insert-node-icon">${nodeIconSvg('image')}</span>` +
            '<span class="insert-node-label">空图片</span>';
        emptyImageButton.title = '创建可上传或替换素材的空图片节点';
        emptyImageButton.addEventListener('click', () => {
            this._removePlanContextMenu();
            this.addEmptyMediaNode('image', at);
        });
        menu.appendChild(emptyImageButton);

        Object.entries(NODE_TYPES).forEach(([nodeType, def]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'plan-context-item insert-node-item';
            button.innerHTML =
                `<span class="insert-node-icon">${nodeIconSvg(nodeType)}</span>` +
                `<span class="insert-node-label"></span>`;
            button.querySelector('.insert-node-label').textContent = def.title || nodeType;
            button.addEventListener('click', () => {
                this._removePlanContextMenu();
                this.addOpNode(nodeType, at);
            });
            menu.appendChild(button);
        });

        menu.style.left = `${evt.clientX}px`;
        menu.style.top = `${evt.clientY}px`;
        document.body.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 10}px`;
        if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 10}px`;

        setTimeout(() => {
            const close = (event) => {
                if (!menu.contains(event.target)) {
                    this._removePlanContextMenu();
                    document.removeEventListener('mousedown', close);
                }
            };
            document.addEventListener('mousedown', close);
        }, 0);
    }

    addEmptyMediaNode(mediaType = 'image', pos = null) {
        const normalizedType = ['image', 'video', 'audio'].includes(mediaType) ? mediaType : 'image';
        const at = pos || this._getViewportCenter();
        const size = this._mediaPlaceholderSize(normalizedType);
        const data = {
            id: `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'media',
            mediaType: normalizedType,
            filePath: '',
            x: Math.round(at.x - size.width / 2),
            y: Math.round(at.y - size.height / 2),
            width: size.width,
            height: size.height,
            addedAt: Date.now()
        };

        this.storeData.items.push(data);
        this._createCard(data);
        this._refreshCanvasBoundary();
        this.clearSelection();
        this.selectItem(data.id, true);
        this.emit('change');
        return data;
    }

    addOpNode(nodeType, pos = null) {
        const def = NODE_TYPES[nodeType];
        if (!def) {
            console.warn('[Canvas] 未知节点类型:', nodeType);
            return null;
        }

        const at = pos || this._getViewportCenter();
        const config = {};
        (def.config || []).forEach(field => {
            config[field.key] = field.default ?? '';
        });
        if (nodeType === 'text' || nodeType === 'image' || nodeType === 'video') {
            const provider = nodeType === 'video'
                ? this.options.getVideoProvider?.()
                : nodeType === 'text'
                    ? this.options.getTextProvider?.()
                    : this.options.getImageProvider?.();
            if (provider) {
                config.providerId = provider.id || null;
                config.sourceProviderId = provider.sourceProviderId || provider.id || null;
                config.model = provider.model || '';
            }
            if (nodeType === 'video') {
                const profile = this.options.getVideoModelProfile?.(config);
                if (profile) {
                    config.ratio = profile.defaultRatio || config.ratio;
                    config.resolution = profile.defaultResolution || config.resolution;
                    config.duration = profile.defaultDuration ?? config.duration;
                }
            }
        }
        const isGenerator = nodeType === 'image' || nodeType === 'video';
        const placeholderSize = isGenerator ? getGeneratorPlaceholderSize(nodeType, config) : null;
        const width = placeholderSize?.width || Math.max(OP_NODE_WIDTH, Number(def.width) || 0);
        const height = placeholderSize?.height || OP_NODE_HEIGHTS[nodeType] || OP_NODE_HEIGHT;

        const data = {
            id: `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'op',
            nodeType,
            title: nodeType === 'image' ? '图片生成' : nodeType === 'video' ? '视频生成' : def.title,
            config,
            model: config.model || '',
            x: Math.round(at.x - width / 2),
            y: Math.round(at.y - height / 2),
            width,
            height,
            runStatus: 'idle',
            runError: '',
            ...(isGenerator ? {
                generatorUiVersion: 1,
                resultEntries: [],
                resultFilePaths: [],
                resultUrls: [],
                resultItems: [],
                resultStackPosition: 0
            } : {})
        };

        this.storeData.items.push(data);
        this._createOpNode(data);
        this.clearSelection();
        this.selectItem(data.id, true);
        this.emit('change');
        return data;
    }

    duplicateItems(itemIds = []) {
        const sourceIds = (Array.isArray(itemIds) && itemIds.length ? itemIds : [...this.selectedItems])
            .filter(id => this.items.has(id));
        if (!sourceIds.length) return [];

        const clones = sourceIds.map((id, index) => {
            const source = this.items.get(id);
            const data = JSON.parse(JSON.stringify(source.data || {}));
            data.id = `${data.kind === 'op' ? 'op' : 'item'}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
            data.x = Math.round(source.group.x() + 30 + index * 6);
            data.y = Math.round(source.group.y() + 30 + index * 6);
            data.addedAt = Date.now();
            if (data.kind === 'op') {
                data.runStatus = 'idle';
                data.runError = '';
                if (data.nodeType === 'image' || data.nodeType === 'video') {
                    keepFirstGeneratorResult(data);
                }
            }
            this.storeData.items.push(data);
            if (data.kind === 'op') this._createOpNode(data);
            else void this._createCard(data);
            return data;
        });

        this.clearSelection();
        clones.forEach(data => this.selectItem(data.id, true));
        this._refreshCanvasBoundary();
        this.emit('change');
        this._showCanvasStatus(clones.length > 1 ? `已复制 ${clones.length} 个节点` : '已复制节点');
        return clones;
    }

    _createOpNode(data) {
        if (!data) return null;
        const def = NODE_TYPES[data.nodeType];
        if (!def) return null;

        const isGenerator = data.nodeType === 'image' || data.nodeType === 'video';
        if (isGenerator) {
            const nextTitle = data.nodeType === 'image' ? '图片生成' : '视频生成';
            if (!data.title || data.title === def.title || data.title === '图像' || data.title === '视频') data.title = nextTitle;
            data.generatorUiVersion = 1;
            ensureGeneratorResultEntries(data);
        }
        const placeholderSize = isGenerator && getGeneratorResultEntries(data).length === 0
            ? getGeneratorPlaceholderSize(data.nodeType, data.config)
            : null;
        const width = placeholderSize?.width
            || (isGenerator ? Math.max(112, Number(data.width) || 264) : Math.max(OP_NODE_WIDTH, Number(data.width) || 0, Number(def.width) || 0));
        const height = placeholderSize?.height
            || (isGenerator ? Math.max(112, Number(data.height) || 264) : Math.max(OP_NODE_HEIGHTS[data.nodeType] || OP_NODE_HEIGHT, Number(data.height) || 0));
        data.width = width;
        data.height = height;

        const group = new Konva.Group({
            x: data.x || 0,
            y: data.y || 0,
            draggable: true,
            id: data.id,
            name: 'nodeGroup',
            nodeKind: 'op'
        });

        this._drawOpNode(group, data, width, height);

        group.on('dragmove', (event) => {
            event.cancelBubble = true;
            data.x = group.x();
            data.y = group.y();
            this.graphView?.scheduleSync(data.id);
            if (data.nodeType === 'text') this._positionPersistentTextEditor(data.id);
            if (this._generationComposer?.nodeId === data.id) this._positionGenerationComposer();
        });
        group.on('dragend', (event) => {
            event.cancelBubble = true;
            data.x = group.x();
            data.y = group.y();
            this.graphView?.sync();
            this.emit('change');
        });
        group.on('mouseenter', () => {
            document.body.style.cursor = 'pointer';
            this.graphView?.setNodeHovered(data.id, true);
        });
        group.on('mouseleave', () => {
            document.body.style.cursor = 'default';
            this.graphView?.setNodeHovered(data.id, false);
        });
        group.on('click', (e) => {
            if (e.evt.button === 2) return;
            const additive = e.evt.ctrlKey || e.evt.metaKey || e.evt.shiftKey;
            this.selectItem(data.id, additive);
            if (isGenerator && !additive) this.openGenerationComposer(data.id);
        });
        group.on('dblclick', (e) => {
            e.cancelBubble = true;
            if (isGenerator) {
                this.openGenerationComposer(data.id);
                return;
            }
            const def = NODE_TYPES[data.nodeType] || {};
            if ((def.config || []).length) {
                this.openOpNodeEditor(data.id);
            } else {
                this.runFromNode(data.id);
            }
        });
        group.on('contextmenu', e => {
            e.cancelBubble = true;
            if (!this.selectedItems.has(data.id)) this.selectItem(data.id, false);
            const itemIds = [...this.selectedItems].filter(id => this.items.has(id));
            this.contextMenu.show(e, {
                kind: 'op',
                itemId: data.id,
                itemIds,
                filePath: '',
                filePaths: []
            });
        });

        this.layer.add(group);
        this.items.set(data.id, { group, data, loaded: true, loading: false });
        if (data.nodeType === 'text') this._ensurePersistentTextEditor(data.id);
        this.graphView?.renderPorts(data.id);
        return group;
    }

    _opPromptTop(data) {
        return data?.nodeType === 'image' ? OP_GENERATOR_PROMPT_TOP : OP_NODE_PROMPT_TOP;
    }

    _generatorInputPortNames(data) {
        if (data?.nodeType === 'image') return new Set(['source', 'prompt', 'reference']);
        if (data?.nodeType === 'video') return new Set(['source', 'prompt', 'image', 'video', 'audio']);
        return new Set();
    }

    _isGeneratorInputConnection(data, connection) {
        return connection?.kind !== 'history'
            && connection?.to?.nodeId === data?.id
            && this._generatorInputPortNames(data).has(connection?.to?.port);
    }

    _connectionOutputDataType(connection) {
        const source = this.items.get(connection?.from?.nodeId)?.data;
        if (!source) return null;
        if (source.kind === 'op') {
            return (NODE_TYPES[source.nodeType]?.outputs || [])
                .find(port => port.name === connection.from.port)?.dataType || null;
        }
        const mediaType = this._getItemMediaType(source);
        return mediaType === 'image' || mediaType === 'video' ? mediaType : 'file';
    }

    _hasUpstreamPrompt(data) {
        return (this.graphView?.connections || []).some(connection =>
            this._isGeneratorInputConnection(data, connection)
            && this._connectionOutputDataType(connection) === 'string'
        );
    }

    _opReferenceEntries(data) {
        if (!data?.id || !['image', 'video'].includes(data.nodeType)) return [];
        const acceptedTypes = data.nodeType === 'image'
            ? new Set(['image'])
            : new Set(['image', 'video', 'file']);
        return (this.graphView?.connections || [])
            .filter(connection => this._isGeneratorInputConnection(data, connection)
                && acceptedTypes.has(this._connectionOutputDataType(connection)))
            .map(connection => {
                const source = this.items.get(connection.from.nodeId)?.data;
                return source ? { connection, source } : null;
            })
            .filter(Boolean);
    }

    _drawOpReferenceStrip(group, data, width) {
        const references = this._opReferenceEntries(data);
        const y = OP_GENERATOR_REFERENCE_TOP;
        const tileSize = 40;
        const gap = 6;
        let x = 12;

        group.add(new Konva.Text({
            x,
            y: y + 13,
            width: 52,
            text: '参考素材',
            fontSize: 10,
            fill: '#8f939b',
            listening: false
        }));
        x += 58;

        const roomForTiles = Math.max(1, Math.floor((width - x - tileSize - 16) / (tileSize + gap)));
        const visibleReferences = references.slice(0, roomForTiles);
        visibleReferences.forEach(({ source }, index) => {
            const tile = new Konva.Group({ x, y, name: 'opReferenceThumbnail' });
            const background = new Konva.Rect({
                width: tileSize,
                height: tileSize,
                fill: '#292b2f',
                stroke: 'rgba(255,255,255,0.14)',
                strokeWidth: 1,
                cornerRadius: 6
            });
            tile.add(background);

            const mediaType = this._getItemMediaType(source);
            if (mediaType === 'image' && source.filePath) {
                const preview = new Konva.Image({
                    x: 2,
                    y: 2,
                    width: tileSize - 4,
                    height: tileSize - 4,
                    cornerRadius: 4,
                    listening: false
                });
                tile.add(preview);
                const image = new window.Image();
                image.onload = () => {
                    if (!tile.getLayer()) return;
                    const side = Math.max(1, Math.min(image.width, image.height));
                    preview.image(image);
                    preview.crop({
                        x: Math.max(0, (image.width - side) / 2),
                        y: Math.max(0, (image.height - side) / 2),
                        width: side,
                        height: side
                    });
                    tile.getLayer()?.batchDraw();
                };
                image.src = 'local-res://' + encodeURIComponent(source.filePath);
            } else {
                tile.add(new Konva.Path({
                    data: NODE_GLYPH_PATHS[mediaType] || NODE_GLYPH_PATHS.document,
                    x: 10,
                    y: 10,
                    scaleX: 1,
                    scaleY: 1,
                    stroke: '#a7abb2',
                    strokeWidth: 1.25,
                    listening: false
                }));
            }

            tile.add(new Konva.Text({
                x: tileSize - 15,
                y: 3,
                width: 11,
                height: 11,
                text: String(index + 1),
                align: 'center',
                fontSize: 8,
                fill: '#d9dce1',
                shadowColor: '#000',
                shadowBlur: 3,
                shadowOpacity: 0.7,
                listening: false
            }));
            tile.on('mouseenter', () => {
                background.stroke('rgba(255,255,255,0.32)');
                document.body.style.cursor = 'pointer';
                group.getLayer()?.batchDraw();
            });
            tile.on('mouseleave', () => {
                background.stroke('rgba(255,255,255,0.14)');
                document.body.style.cursor = 'default';
                group.getLayer()?.batchDraw();
            });
            tile.on('mousedown touchstart click tap', event => {
                if (event.evt?.button != null && event.evt.button !== 0) return;
                event.cancelBubble = true;
                event.evt?.preventDefault?.();
                if (event.type === 'click' || event.type === 'tap') this.selectItem(source.id, false);
            });
            group.add(tile);
            x += tileSize + gap;
        });

        if (references.length > visibleReferences.length) {
            const remaining = references.length - visibleReferences.length;
            group.add(new Konva.Text({
                x: Math.max(70, x - tileSize - gap),
                y: y + 14,
                width: tileSize,
                text: `+${remaining}`,
                align: 'center',
                fontSize: 10,
                fill: '#e0e2e5',
                listening: false
            }));
        }

        const addButton = new Konva.Group({ x, y, name: 'opReferenceAddButton' });
        const addBackground = new Konva.Rect({
            width: tileSize,
            height: tileSize,
            fill: '#292b2f',
            stroke: 'rgba(255,255,255,0.12)',
            strokeWidth: 1,
            cornerRadius: 6
        });
        addButton.add(addBackground, new Konva.Line({
            points: [13, 20, 27, 20, 20, 20, 20, 13, 20, 27],
            stroke: '#aeb2b9',
            strokeWidth: 1.5,
            lineCap: 'round',
            listening: false
        }));
        addButton.on('mouseenter', () => {
            addBackground.fill('#34363b');
            addBackground.stroke('rgba(255,255,255,0.24)');
            document.body.style.cursor = 'pointer';
            group.getLayer()?.batchDraw();
        });
        addButton.on('mouseleave', () => {
            addBackground.fill('#292b2f');
            addBackground.stroke('rgba(255,255,255,0.12)');
            document.body.style.cursor = 'default';
            group.getLayer()?.batchDraw();
        });
        addButton.on('mousedown touchstart click tap', event => {
            if (event.evt?.button != null && event.evt.button !== 0) return;
            event.cancelBubble = true;
            event.evt?.preventDefault?.();
            if (event.type === 'click' || event.type === 'tap') this.beginNodeReferencePick(data.id);
        });
        group.add(addButton);
    }

    _drawGeneratorPlaceholder(group, data, width, height) {
        group.getAttr('generatorAnimation')?.stop?.();
        group.setAttr('generatorAnimation', null);
        const previousVideos = group.getAttr('generatorPreviewVideos') || [];
        previousVideos.forEach(video => {
            video.pause?.();
            video.removeAttribute?.('src');
            video.load?.();
        });
        group.setAttr('generatorPreviewVideos', []);
        group.off('.generatorStack');
        group.destroyChildren();

        const status = data.runStatus || 'idle';
        const results = ensureGeneratorResultEntries(data);
        const resultCount = results.length;
        const isBusy = status === STATUS.QUEUED || status === STATUS.RUNNING;
        const stroke = status === STATUS.ERROR
            ? OP_STATUS_COLORS.error
            : 'rgba(255, 255, 255, 0.24)';

        if (resultCount > 1) {
            const collapsedOffset = 7;
            const expandedOffset = Math.min(64, Math.max(40, Math.round(width * 0.18)));
            const nextCard = new Konva.Group({
                x: collapsedOffset,
                y: collapsedOffset,
                name: 'generatorStackNext'
            });
            nextCard.add(new Konva.Rect({
                width,
                height,
                fill: '#17181a',
                stroke: 'rgba(255, 255, 255, 0.14)',
                strokeWidth: 1,
                cornerRadius: 8
            }));
            this._addGeneratorResultPreview(group, nextCard, data, results[1], width, height);
            nextCard.on('mouseenter.generatorStack', () => {
                document.body.style.cursor = 'pointer';
            });
            nextCard.on('mousedown.generatorStack touchstart.generatorStack click.generatorStack tap.generatorStack', event => {
                if (event.evt?.button != null && event.evt.button !== 0) return;
                event.cancelBubble = true;
                event.evt?.preventDefault?.();
                if (event.type !== 'click' && event.type !== 'tap') return;
                rotateGeneratorResults(data);
                this.refreshOpNode(data.id);
                this.emit('change');
            });
            group.add(nextCard);
            group.on('mouseenter.generatorStack', () => {
                nextCard.to({
                    x: expandedOffset,
                    y: 5,
                    duration: 0.16,
                    easing: Konva.Easings.EaseOut
                });
            });
            group.on('mouseleave.generatorStack', () => {
                nextCard.to({
                    x: collapsedOffset,
                    y: collapsedOffset,
                    duration: 0.14,
                    easing: Konva.Easings.EaseInOut
                });
            });
        }

        const background = new Konva.Rect({
            name: 'displayNode',
            width,
            height,
            fill: '#202123',
            stroke,
            strokeWidth: status === STATUS.ERROR ? 1.5 : 1,
            cornerRadius: 8,
            shadowColor: 'rgba(0, 0, 0, 0.36)',
            shadowBlur: 14,
            shadowOffsetY: 5,
            shadowOpacity: 0.5
        });
        group.add(background);

        if (results[0]) {
            this._addGeneratorResultPreview(group, group, data, results[0], width, height, 'generatorResultPreview');
        } else {
            const glyph = NODE_GLYPH_PATHS[data.nodeType] || NODE_GLYPH_PATHS.image;
            group.add(new Konva.Path({
                data: glyph,
                x: width / 2 - 22,
                y: height / 2 - 22,
                scaleX: 2.2,
                scaleY: 2.2,
                stroke: '#696c71',
                strokeWidth: 1.8,
                lineCap: 'round',
                lineJoin: 'round',
                listening: false
            }));
        }

        if (isBusy) {
            const sweepWidth = Math.max(72, Math.round(width * 0.34));
            const sweep = new Konva.Rect({
                x: -sweepWidth,
                width: sweepWidth,
                height,
                fillLinearGradientStartPoint: { x: 0, y: 0 },
                fillLinearGradientEndPoint: { x: sweepWidth, y: 0 },
                fillLinearGradientColorStops: [
                    0, 'rgba(255,255,255,0)',
                    0.5, 'rgba(255,255,255,0.15)',
                    1, 'rgba(255,255,255,0)'
                ],
                listening: false
            });
            const clip = new Konva.Group({
                clipX: 1,
                clipY: 1,
                clipWidth: Math.max(1, width - 2),
                clipHeight: Math.max(1, height - 2),
                listening: false
            });
            clip.add(sweep);
            group.add(clip);
            const animation = new Konva.Animation(frame => {
                const progress = ((frame?.time || 0) % 1500) / 1500;
                sweep.x(-sweepWidth + (width + sweepWidth) * progress);
            }, this.layer);
            group.setAttr('generatorAnimation', animation);
            animation.start();
        }

        if (status === STATUS.ERROR && data.runError) {
            group.add(new Konva.Rect({
                x: 8,
                y: height - 44,
                width: width - 16,
                height: 36,
                fill: 'rgba(31, 15, 16, 0.9)',
                cornerRadius: 5,
                listening: false
            }), new Konva.Text({
                x: 14,
                y: height - 36,
                width: width - 28,
                height: 24,
                text: data.runError,
                fontSize: 10,
                lineHeight: 1.25,
                fill: '#d99a94',
                ellipsis: true,
                wrap: 'word',
                listening: false
            }));
        }

        if (resultCount > 1) {
            group.add(new Konva.Text({
                name: 'generatorStackPosition',
                x: Math.max(0, width - 72),
                y: -24,
                width: 72,
                height: 18,
                text: `${Number(data.resultStackPosition || 0) + 1}/${resultCount}`,
                align: 'right',
                fontFamily: 'Segoe UI, sans-serif',
                fontSize: 11,
                fill: '#aeb1b7',
                listening: false
            }));
        }

        this._syncExternalNodeTitle(group, data, data.nodeType);
    }

    _addGeneratorResultPreview(ownerGroup, parent, data, result, width, height, name = '') {
        const source = result?.filePath
            ? `local-res://${encodeURIComponent(resolveCanvasFilePath(result.filePath))}`
            : result?.url || '';
        if (!source) return null;

        const preview = new Konva.Image({
            name,
            width,
            height,
            cornerRadius: 8,
            listening: false
        });
        parent.add(preview);

        if (data.nodeType === 'video') {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.muted = true;
            video.playsInline = true;
            const drawFrame = () => {
                if (!ownerGroup.getLayer()) return;
                preview.image(video);
                this._coverGeneratorPreview(preview, video.videoWidth, video.videoHeight, width, height);
                ownerGroup.getLayer()?.batchDraw();
            };
            video.addEventListener('loadeddata', () => {
                if (Number.isFinite(video.duration) && video.duration > 0.12) {
                    try { video.currentTime = Math.min(0.12, video.duration / 2); } catch (_) { drawFrame(); }
                } else {
                    drawFrame();
                }
            }, { once: true });
            video.addEventListener('seeked', drawFrame, { once: true });
            video.src = source;
            const videos = ownerGroup.getAttr('generatorPreviewVideos') || [];
            videos.push(video);
            ownerGroup.setAttr('generatorPreviewVideos', videos);
        } else {
            const image = new window.Image();
            image.onload = () => {
                if (!ownerGroup.getLayer()) return;
                preview.image(image);
                this._coverGeneratorPreview(preview, image.naturalWidth || image.width, image.naturalHeight || image.height, width, height);
                ownerGroup.getLayer()?.batchDraw();
            };
            image.src = source;
        }
        return preview;
    }

    _coverGeneratorPreview(preview, mediaWidth, mediaHeight, boxWidth, boxHeight) {
        const sourceWidth = Math.max(1, Number(mediaWidth) || boxWidth);
        const sourceHeight = Math.max(1, Number(mediaHeight) || boxHeight);
        const sourceRatio = sourceWidth / sourceHeight;
        const boxRatio = boxWidth / boxHeight;
        if (sourceRatio > boxRatio) {
            const cropWidth = sourceHeight * boxRatio;
            preview.crop({ x: (sourceWidth - cropWidth) / 2, y: 0, width: cropWidth, height: sourceHeight });
        } else {
            const cropHeight = sourceWidth / boxRatio;
            preview.crop({ x: 0, y: (sourceHeight - cropHeight) / 2, width: sourceWidth, height: cropHeight });
        }
    }

    _drawOpNode(group, data, width, height) {
        group.destroyChildren();
        const def = NODE_TYPES[data.nodeType] || {};
        const status = data.runStatus || 'idle';
        const isGenerator = data.nodeType === 'image' || data.nodeType === 'video';

        if (isGenerator) {
            this._drawGeneratorPlaceholder(group, data, width, height);
            return;
        }

        this._syncExternalNodeTitle(group, data, data.nodeType);

        group.add(new Konva.Rect({
            name: 'displayNode',
            width,
            height,
            fill: '#202123',
            stroke: status === 'error' ? OP_STATUS_COLORS.error : 'rgba(255,255,255,0.13)',
            strokeWidth: status === 'error' ? 1.5 : 1,
            cornerRadius: 8,
            shadowColor: 'rgba(0,0,0,0.32)',
            shadowBlur: 12,
            shadowOffsetY: 4,
            shadowOpacity: 0.45
        }));

        const promptField = data.nodeType === 'text' ? 'text' : 'prompt';
        const isPromptNode = ['text', 'image', 'video'].includes(data.nodeType);
        const prompt = isPromptNode ? String(data.config?.[promptField] || '') : '';
        const footerY = data.nodeType === 'text' ? height : height - OP_NODE_FOOTER_HEIGHT;

        if (isPromptNode) {
            let actionX = 12;
            if (data.nodeType === 'image' || data.nodeType === 'video') {
                actionX += this._addOpToolbarAction(group, {
                    x: actionX,
                    label: '预设',
                    onClick: event => this._showOpPromptPresetMenu(data.id, event)
                });
            }
            actionX += this._addOpToolbarAction(group, {
                x: actionX,
                label: '优化',
                onClick: () => this._tidyOpPrompt(data.id)
            });
            if (data.nodeType === 'text') {
                this._addOpToolbarAction(group, {
                    x: actionX,
                    label: this._visualExtractingNodeIds.has(data.id) ? '提取中' : '画面提取',
                    onClick: () => this._extractVisualPrompt(data.id)
                });
            }
            if (data.nodeType === 'image' || data.nodeType === 'video') {
                this._addOpToolbarAction(group, {
                    x: actionX,
                    label: '参考',
                    onClick: () => this.beginNodeReferencePick(data.id)
                });
            }

            if (data.nodeType === 'image') this._drawOpReferenceStrip(group, data, width);

            if (data.nodeType !== 'text') {
                const promptY = this._opPromptTop(data);
                const promptHeight = Math.max(44, footerY - promptY - 8);
                const promptHit = new Konva.Rect({
                    name: 'opPromptEditorHit',
                    x: 10,
                    y: promptY - 3,
                    width: width - 20,
                    height: promptHeight + 4,
                    fill: 'rgba(255,255,255,0.001)',
                    cornerRadius: 5
                });
                const promptText = new Konva.Text({
                    name: 'opPromptText',
                    x: 16,
                    y: promptY + 4,
                    width: width - 32,
                    height: promptHeight - 8,
                    text: data.runError || prompt || '点击输入提示词…',
                    fontFamily: 'Segoe UI, sans-serif',
                    fontSize: 13,
                    lineHeight: 1.5,
                    fill: data.runError ? '#e7a1a1' : (prompt ? '#d9dade' : '#74777d'),
                    ellipsis: true,
                    wrap: 'word',
                    listening: false
                });
                promptHit.on('mouseenter', () => {
                    promptHit.fill('rgba(255,255,255,0.025)');
                    document.body.style.cursor = 'text';
                    group.getLayer()?.batchDraw();
                });
                promptHit.on('mouseleave', () => {
                    promptHit.fill('rgba(255,255,255,0.001)');
                    document.body.style.cursor = 'default';
                    group.getLayer()?.batchDraw();
                });
                promptHit.on('mousedown touchstart click tap dblclick dbltap', event => {
                    if (event.evt?.button != null && event.evt.button !== 0) return;
                    event.cancelBubble = true;
                    event.evt?.preventDefault?.();
                    if (['click', 'tap', 'dblclick', 'dbltap'].includes(event.type)) {
                        this.selectItem(data.id, false);
                        this.openInlineOpPromptEditor(data.id);
                    }
                });
                group.add(promptHit, promptText);
            }
        } else {
            const summary = data.runError || this._opConfigSummary(data, def);
            group.add(new Konva.Text({
                x: 16,
                y: 17,
                width: width - 32,
                height: footerY - 28,
                text: summary,
                fontFamily: 'Segoe UI, sans-serif',
                fontSize: 13,
                lineHeight: 1.5,
                fill: data.runError ? '#f0a0a0' : '#85888e',
                ellipsis: true,
                wrap: 'word'
            }));
        }

        if (data.nodeType === 'text') {
            group.findOne('.externalNodeTitle')?.moveToTop();
            return;
        }

        group.add(new Konva.Line({
            points: [0, footerY, width, footerY],
            stroke: 'rgba(255,255,255,0.08)',
            strokeWidth: 1,
            listening: false
        }));

        const modelText = data.model || data.config?.model || (isGenerator ? '选择模型' : '编辑参数');
        const footerControlY = footerY + 10;
        const modelPillWidth = isGenerator
            ? Math.min(112, Math.max(72, 22 + String(modelText).length * 10))
            : Math.min(132, Math.max(76, 24 + String(modelText).length * 11));

        this._addOpFooterPill(group, {
            name: 'opModelButton',
            x: 12,
            y: footerControlY,
            width: modelPillWidth,
            text: modelText,
            onClick: event => isGenerator
                ? this._showOpModelMenu(data.id, event)
                : this.openOpNodeEditor(data.id)
        });

        if (isGenerator) {
            const controlGap = 5;
            const countWidth = 42;
            const runSpace = 48;
            const parameterX = 12 + modelPillWidth + controlGap;
            let countX;
            if (data.nodeType === 'image') {
                const styleWidth = 62;
                const cameraWidth = 80;
                const parameterWidth = Math.max(
                    98,
                    width - parameterX - styleWidth - cameraWidth - countWidth - runSpace - controlGap * 5
                );
                let controlX = parameterX;
                this._addOpFooterPill(group, {
                    name: 'opParameterButton',
                    x: controlX,
                    y: footerControlY,
                    width: parameterWidth,
                    text: this._opParameterSummary(data),
                    onClick: event => this._showOpParameterMenu(data.id, event)
                });
                controlX += parameterWidth + controlGap;
                this._addOpFooterPill(group, {
                    name: 'opStyleButton',
                    x: controlX,
                    y: footerControlY,
                    width: styleWidth,
                    text: data.config?.style || '风格',
                    onClick: event => this._showOpChoiceMenu(data.id, event, {
                        title: '图像风格',
                        key: 'style',
                        choices: ['', '写实', '产品摄影', '电影感', '插画', '极简']
                    })
                });
                controlX += styleWidth + controlGap;
                this._addOpFooterPill(group, {
                    name: 'opCameraButton',
                    x: controlX,
                    y: footerControlY,
                    width: cameraWidth,
                    text: data.config?.cameraControl || '摄影控制',
                    onClick: event => this._showOpChoiceMenu(data.id, event, {
                        title: '摄影机控制',
                        key: 'cameraControl',
                        choices: ['', '自动', '特写', '近景', '中景', '广角', '俯拍']
                    })
                });
                countX = controlX + cameraWidth + controlGap;
            } else {
                const parameterWidth = Math.max(84, width - parameterX - countWidth - runSpace - controlGap * 2);
                countX = parameterX + parameterWidth + controlGap;
                this._addOpFooterPill(group, {
                    name: 'opParameterButton',
                    x: parameterX,
                    y: footerControlY,
                    width: parameterWidth,
                    text: this._opParameterSummary(data),
                    onClick: event => this._showOpParameterMenu(data.id, event)
                });
            }
            this._addOpFooterPill(group, {
                name: 'opCountButton',
                x: countX,
                y: footerControlY,
                width: countWidth,
                text: `${Math.max(1, Number(data.config?.count) || 1)}×`,
                align: 'center',
                onClick: event => this._showOpCountMenu(data.id, event)
            });
        } else {
            const parameterText = data.nodeType === 'batch'
                ? `${Number(data.config?.count) || 1}×`
                : 'Prompt';
            const metaX = 20 + modelPillWidth;
            group.add(new Konva.Text({
                x: metaX,
                y: footerY + 18,
                width: Math.max(40, width - metaX - 58),
                text: `${parameterText} · ${OP_STATUS_LABELS[status] || OP_STATUS_LABELS.idle}`,
                fontSize: 11,
                fill: '#85888e',
                ellipsis: true,
                wrap: 'none',
                listening: false
            }));
        }

        const runButton = new Konva.Group({
            name: 'opRunButton',
            x: width - 40,
            y: footerY + 8
        });
        const runButtonBg = new Konva.Circle({
            x: 16,
            y: 16,
            radius: 16,
            fill: status === 'error' ? '#d9b2b2' : '#eeeeef',
            opacity: status === 'running' ? 0.66 : 1,
            shadowColor: 'rgba(0,0,0,0.3)',
            shadowBlur: 6,
            shadowOffsetY: 2,
            shadowOpacity: 0.4
        });
        runButton.add(runButtonBg);
        if (status === 'running' || status === 'queued') {
            runButton.add(new Konva.Arc({
                x: 16,
                y: 16,
                innerRadius: 6,
                outerRadius: 7.5,
                angle: 250,
                rotation: -90,
                fill: '#4c4e52',
                listening: false
            }));
        } else {
            runButton.add(new Konva.Line({
                points: [10, 17, 16, 11, 22, 17, 16, 11, 16, 22],
                stroke: '#202123',
                strokeWidth: 1.8,
                lineCap: 'round',
                lineJoin: 'round',
                listening: false
            }));
        }
        runButton.on('mouseenter', () => {
            runButtonBg.fill('#ffffff');
            document.body.style.cursor = 'pointer';
            group.getLayer()?.batchDraw();
        });
        runButton.on('mouseleave', () => {
            runButtonBg.fill(status === 'error' ? '#d9b2b2' : '#eeeeef');
            document.body.style.cursor = 'default';
            group.getLayer()?.batchDraw();
        });
        runButton.on('mousedown touchstart click tap', event => {
            if (event.evt?.button != null && event.evt.button !== 0) return;
            event.cancelBubble = true;
            event.evt?.preventDefault?.();
            if (event.type === 'click' || event.type === 'tap') this.runFromNode(data.id);
        });
        group.add(runButton);
        group.findOne('.externalNodeTitle')?.moveToTop();
    }

    _addOpFooterPill(group, { name, x, y, width, text, align = 'left', onClick }) {
        const button = new Konva.Group({ name, x, y });
        const background = new Konva.Rect({
            width,
            height: 28,
            fill: '#2a2b2e',
            stroke: 'rgba(255,255,255,0.08)',
            strokeWidth: 1,
            cornerRadius: 6
        });
        button.add(background, new Konva.Text({
            x: align === 'center' ? 4 : 10,
            y: 8,
            width: width - (align === 'center' ? 8 : 20),
            text: String(text || ''),
            align,
            fontSize: 11,
            fill: '#b7b9bd',
            ellipsis: true,
            wrap: 'none',
            listening: false
        }));
        button.on('mouseenter', () => {
            background.fill('#343539');
            background.stroke('rgba(255,255,255,0.15)');
            document.body.style.cursor = 'pointer';
            group.getLayer()?.batchDraw();
        });
        button.on('mouseleave', () => {
            background.fill('#2a2b2e');
            background.stroke('rgba(255,255,255,0.08)');
            document.body.style.cursor = 'default';
            group.getLayer()?.batchDraw();
        });
        button.on('mousedown touchstart click tap', event => {
            if (event.evt?.button != null && event.evt.button !== 0) return;
            event.cancelBubble = true;
            event.evt?.preventDefault?.();
            if (event.type === 'click' || event.type === 'tap') onClick?.(event);
        });
        group.add(button);
        return button;
    }

    _addOpToolbarAction(group, { x, label, onClick }) {
        const width = Math.max(44, 20 + String(label || '').length * 12);
        const button = new Konva.Group({ x, y: 10, name: 'opToolbarAction' });
        const background = new Konva.Rect({
            width,
            height: 24,
            fill: '#292a2d',
            stroke: 'rgba(255,255,255,0.07)',
            strokeWidth: 1,
            cornerRadius: 5
        });
        button.add(background, new Konva.Text({
            x: 8,
            y: 6,
            width: width - 16,
            text: label,
            align: 'center',
            fontSize: 10,
            fill: '#a8abb1',
            listening: false
        }));
        button.on('mouseenter', () => {
            background.fill('#35363a');
            background.stroke('rgba(255,255,255,0.14)');
            document.body.style.cursor = 'pointer';
            group.getLayer()?.batchDraw();
        });
        button.on('mouseleave', () => {
            background.fill('#292a2d');
            background.stroke('rgba(255,255,255,0.07)');
            document.body.style.cursor = 'default';
            group.getLayer()?.batchDraw();
        });
        button.on('mousedown touchstart click tap', event => {
            if (event.evt?.button != null && event.evt.button !== 0) return;
            event.cancelBubble = true;
            event.evt?.preventDefault?.();
            if (event.type === 'click' || event.type === 'tap') onClick?.(event);
        });
        group.add(button);
        return width + 6;
    }

    _opParameterSummary(data) {
        if (data.nodeType === 'image') {
            const width = Math.max(1, Number(data.config?.width) || 1024);
            const height = Math.max(1, Number(data.config?.height) || 1024);
            const tier = data.config?.resolutionTier || inferImageResolutionTier(width, height);
            const ratio = data.config?.ratio || inferImageAspectRatio(width, height);
            return `${ratio === 'adaptive' ? '自适应' : ratio} · ${tier}`;
        }
        if (data.nodeType === 'video') {
            const parts = [
                data.config?.ratio,
                data.config?.resolution,
                Number(data.config?.duration) === -1
                    ? '智能时长'
                    : (data.config?.duration ? `${data.config.duration}s` : '')
            ].filter(Boolean);
            return parts.join(' · ') || '接口默认';
        }
        return '参数';
    }

    _normalizeVideoConfigForProfile(config) {
        const profile = this.options.getVideoModelProfile?.(config);
        if (!profile) return null;
        const syncChoice = (key, values, fallback) => {
            const options = (values || []).map(String);
            if (!options.length) {
                config[key] = '';
                return;
            }
            const current = String(config[key] ?? '');
            config[key] = options.includes(current) ? config[key] : (fallback ?? values[0]);
        };
        syncChoice('ratio', profile.ratios, profile.defaultRatio);
        syncChoice('resolution', profile.resolutions, profile.defaultResolution);
        syncChoice('duration', profile.durations, profile.defaultDuration);
        if (profile.supportsCameraFixed === false) config.cameraFixed = false;
        if (profile.supportsGeneratedAudio === false) config.generateAudio = false;
        if (profile.supportsWebSearch !== true) config.webSearch = false;
        if (profile.supportsWatermark === false) config.watermark = false;
        return profile;
    }

    _showOpModelMenu(nodeId, event = null) {
        const data = this.items.get(nodeId)?.data;
        if (!data || !['image', 'video'].includes(data.nodeType)) return;
        const providers = this.options.getGenerationProviders?.(data.nodeType) || [];
        const menu = document.createElement('section');
        menu.className = 'op-node-quick-menu op-node-model-menu';
        menu.setAttribute('role', 'dialog');
        menu.setAttribute('aria-label', '选择模型');
        menu.innerHTML = `
            <div class="op-quick-menu-head">
                <strong>选择模型</strong>
                <button type="button" data-close title="关闭" aria-label="关闭">×</button>
            </div>
            <label class="op-model-search">
                <span aria-hidden="true">⌕</span>
                <input type="search" autocomplete="off" placeholder="搜索模型或 API" aria-label="搜索模型或 API">
            </label>
            <div class="op-model-options"></div>
        `;
        const search = menu.querySelector('input');
        const list = menu.querySelector('.op-model-options');
        const render = () => {
            const query = search.value.trim().toLowerCase();
            const matches = providers.filter(provider =>
                !query || `${provider.model || ''} ${provider.name || ''}`.toLowerCase().includes(query)
            );
            list.replaceChildren();
            if (!matches.length) {
                const empty = document.createElement('div');
                empty.className = 'op-quick-empty';
                empty.textContent = providers.length ? '没有匹配的模型' : '请先在右上角设置中添加 API';
                list.appendChild(empty);
                return;
            }
            matches.forEach(provider => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'op-model-option';
                const isSelected = provider.id === data.config?.providerId
                    || (provider.sourceProviderId === data.config?.sourceProviderId && provider.model === data.config?.model);
                button.classList.toggle('selected', isSelected);
                const model = document.createElement('strong');
                model.textContent = provider.model || '未命名模型';
                const source = document.createElement('small');
                source.textContent = provider.name || '未命名 API';
                const marker = document.createElement('span');
                marker.textContent = isSelected ? '当前' : '›';
                button.append(model, source, marker);
                button.addEventListener('click', () => {
                    data.config = data.config || {};
                    data.config.providerId = provider.id;
                    data.config.sourceProviderId = provider.sourceProviderId || provider.id;
                    data.config.model = provider.model || '';
                    data.model = data.config.model;
                    if (data.nodeType === 'video') this._normalizeVideoConfigForProfile(data.config);
                    this.refreshOpNode(nodeId);
                    this.emit('change');
                    this._closeOpQuickMenu();
                });
                list.appendChild(button);
            });
        };
        search.addEventListener('input', render);
        menu.querySelector('[data-close]')?.addEventListener('click', () => this._closeOpQuickMenu());
        render();
        this._mountOpQuickMenu(menu, nodeId, event);
        search.focus();
    }

    _showOpParameterMenu(nodeId, event = null) {
        const data = this.items.get(nodeId)?.data;
        if (!data || !['image', 'video'].includes(data.nodeType)) return;
        data.config = data.config || {};
        const menu = document.createElement('section');
        menu.className = 'op-node-quick-menu op-node-parameter-menu';
        menu.setAttribute('role', 'dialog');
        menu.setAttribute('aria-label', '生成参数');
        menu.innerHTML = `
            <div class="op-quick-menu-head">
                <strong>生成参数</strong>
                <button type="button" data-close title="关闭" aria-label="关闭">×</button>
            </div>
            <div class="op-parameter-sections"></div>
        `;
        const sections = menu.querySelector('.op-parameter-sections');
        const commit = () => {
            this.refreshOpNode(nodeId);
            this.emit('change');
        };
        const addChoices = (label, key, values, formatter = value => String(value)) => {
            if (!values?.length) return;
            const section = document.createElement('div');
            section.className = 'op-quick-section';
            const title = document.createElement('span');
            title.className = 'op-quick-section-title';
            title.textContent = label;
            const options = document.createElement('div');
            options.className = 'op-parameter-options';
            values.forEach(value => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = formatter(value);
                button.classList.toggle('selected', String(data.config[key] ?? '') === String(value));
                button.addEventListener('click', () => {
                    data.config[key] = key === 'duration' ? Number(value) : value;
                    options.querySelectorAll('button').forEach(candidate => candidate.classList.toggle('selected', candidate === button));
                    commit();
                });
                options.appendChild(button);
            });
            section.append(title, options);
            sections.appendChild(section);
        };

        if (data.nodeType === 'image') {
            const initialWidth = Math.max(64, Number(data.config.width) || 1024);
            const initialHeight = Math.max(64, Number(data.config.height) || 1024);
            data.config.resolutionTier = IMAGE_RESOLUTION_TIERS.includes(data.config.resolutionTier)
                ? data.config.resolutionTier
                : inferImageResolutionTier(initialWidth, initialHeight);
            data.config.ratio = IMAGE_ASPECT_RATIOS.includes(data.config.ratio)
                ? data.config.ratio
                : inferImageAspectRatio(initialWidth, initialHeight);

            const applyImageProfile = () => {
                const reference = this._opReferenceEntries(data)[0]?.source;
                const dimensions = resolveImageDimensions(
                    data.config.resolutionTier,
                    data.config.ratio,
                    {
                        width: Number(reference?.width) || data.config.width,
                        height: Number(reference?.height) || data.config.height
                    }
                );
                data.config.width = dimensions.width;
                data.config.height = dimensions.height;
            };

            const qualitySection = document.createElement('div');
            qualitySection.className = 'op-quick-section';
            qualitySection.innerHTML = '<span class="op-quick-section-title">画质</span><div class="op-parameter-options op-quality-options"></div>';
            const qualityOptions = qualitySection.querySelector('.op-parameter-options');
            IMAGE_RESOLUTION_TIERS.forEach(tier => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = tier;
                button.classList.toggle('selected', data.config.resolutionTier === tier);
                button.addEventListener('click', () => {
                    data.config.resolutionTier = tier;
                    applyImageProfile();
                    qualityOptions.querySelectorAll('button').forEach(candidate => candidate.classList.toggle('selected', candidate === button));
                    widthInput.value = String(data.config.width);
                    heightInput.value = String(data.config.height);
                    commit();
                });
                qualityOptions.appendChild(button);
            });
            sections.appendChild(qualitySection);

            const ratioSection = document.createElement('div');
            ratioSection.className = 'op-quick-section';
            ratioSection.innerHTML = '<span class="op-quick-section-title">比例</span><div class="op-parameter-options op-ratio-options"></div>';
            const ratioOptions = ratioSection.querySelector('.op-parameter-options');
            IMAGE_ASPECT_RATIOS.forEach(ratio => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = ratio === 'adaptive' ? '自适应' : ratio;
                button.classList.toggle('selected', data.config.ratio === ratio);
                button.addEventListener('click', () => {
                    data.config.ratio = ratio;
                    applyImageProfile();
                    ratioOptions.querySelectorAll('button').forEach(candidate => candidate.classList.toggle('selected', candidate === button));
                    widthInput.value = String(data.config.width);
                    heightInput.value = String(data.config.height);
                    commit();
                });
                ratioOptions.appendChild(button);
            });
            sections.appendChild(ratioSection);

            const searchSection = document.createElement('div');
            searchSection.className = 'op-quick-section';
            searchSection.innerHTML = '<span class="op-quick-section-title">联网搜索</span><div class="op-parameter-options op-binary-options"></div>';
            const searchOptions = searchSection.querySelector('.op-parameter-options');
            [true, false].forEach(enabled => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = enabled ? 'ON' : 'OFF';
                button.classList.toggle('selected', Boolean(data.config.webSearch) === enabled);
                button.addEventListener('click', () => {
                    data.config.webSearch = enabled;
                    searchOptions.querySelectorAll('button').forEach(candidate => candidate.classList.toggle('selected', candidate === button));
                    commit();
                });
                searchOptions.appendChild(button);
            });
            sections.appendChild(searchSection);

            const section = document.createElement('div');
            section.className = 'op-quick-section op-exact-dimensions';
            section.innerHTML = '<span class="op-quick-section-title">精确尺寸</span>';
            const dimensions = document.createElement('div');
            dimensions.className = 'op-dimension-inputs';
            const widthInput = document.createElement('input');
            const heightInput = document.createElement('input');
            [widthInput, heightInput].forEach(input => {
                input.type = 'number';
                input.min = '64';
                input.max = '8192';
                input.step = '64';
            });
            widthInput.value = String(Number(data.config.width) || 1024);
            heightInput.value = String(Number(data.config.height) || 1024);
            widthInput.setAttribute('aria-label', '图片宽度');
            heightInput.setAttribute('aria-label', '图片高度');
            const applyDimensions = () => {
                data.config.width = Math.max(64, Math.min(8192, Number(widthInput.value) || 1024));
                data.config.height = Math.max(64, Math.min(8192, Number(heightInput.value) || 1024));
                data.config.resolutionTier = inferImageResolutionTier(data.config.width, data.config.height);
                data.config.ratio = inferImageAspectRatio(data.config.width, data.config.height);
                widthInput.value = String(data.config.width);
                heightInput.value = String(data.config.height);
                commit();
            };
            widthInput.addEventListener('change', applyDimensions);
            heightInput.addEventListener('change', applyDimensions);
            dimensions.append(widthInput, document.createTextNode('×'), heightInput);
            section.appendChild(dimensions);
            sections.appendChild(section);
        } else {
            const profile = this._normalizeVideoConfigForProfile(data.config);
            addChoices('画面比例', 'ratio', profile?.ratios || [], value => value === 'adaptive' ? '自适应' : value);
            addChoices('输出分辨率', 'resolution', profile?.resolutions || []);
            addChoices('视频时长', 'duration', profile?.durations || [], value => Number(value) === -1 ? '智能' : `${value}s`);
            const capabilities = [
                ['cameraFixed', '固定镜头', profile?.supportsCameraFixed !== false],
                ['generateAudio', '生成音频', profile?.supportsGeneratedAudio !== false],
                ['webSearch', '联网搜索', profile?.supportsWebSearch === true],
                ['watermark', '添加水印', profile?.supportsWatermark !== false]
            ].filter(([, , supported]) => supported);
            if (capabilities.length) {
                const section = document.createElement('div');
                section.className = 'op-quick-section';
                const title = document.createElement('span');
                title.className = 'op-quick-section-title';
                title.textContent = '模型能力';
                const toggles = document.createElement('div');
                toggles.className = 'op-capability-toggles';
                capabilities.forEach(([key, label]) => {
                    const control = document.createElement('label');
                    const input = document.createElement('input');
                    input.type = 'checkbox';
                    input.checked = Boolean(data.config[key]);
                    input.addEventListener('change', () => {
                        data.config[key] = input.checked;
                        commit();
                    });
                    control.append(input, document.createTextNode(label));
                    toggles.appendChild(control);
                });
                section.append(title, toggles);
                sections.appendChild(section);
            }
            if (!sections.children.length) {
                const empty = document.createElement('div');
                empty.className = 'op-quick-empty';
                empty.textContent = '当前模型未声明可调参数，将使用接口默认值';
                sections.appendChild(empty);
            }
        }

        menu.querySelector('[data-close]')?.addEventListener('click', () => this._closeOpQuickMenu());
        this._mountOpQuickMenu(menu, nodeId, event);
    }

    _showOpChoiceMenu(nodeId, event, { title, key, choices = [] } = {}) {
        const data = this.items.get(nodeId)?.data;
        if (!data || data.nodeType !== 'image' || !key) return;
        data.config = data.config || {};
        const menu = document.createElement('section');
        menu.className = 'op-node-quick-menu op-node-choice-menu';
        menu.setAttribute('role', 'dialog');
        menu.setAttribute('aria-label', title || '选择参数');
        menu.innerHTML = `
            <div class="op-quick-menu-head">
                <strong></strong>
                <button type="button" data-close title="关闭" aria-label="关闭">×</button>
            </div>
            <div class="op-choice-options"></div>
        `;
        menu.querySelector('strong').textContent = title || '选择参数';
        const options = menu.querySelector('.op-choice-options');
        choices.forEach(value => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = value || '模型默认';
            button.classList.toggle('selected', String(data.config[key] || '') === String(value));
            button.addEventListener('click', () => {
                data.config[key] = value;
                this.refreshOpNode(nodeId);
                this.emit('change');
                this._closeOpQuickMenu();
            });
            options.appendChild(button);
        });
        menu.querySelector('[data-close]')?.addEventListener('click', () => this._closeOpQuickMenu());
        this._mountOpQuickMenu(menu, nodeId, event);
    }

    _showOpCountMenu(nodeId, event = null) {
        const data = this.items.get(nodeId)?.data;
        if (!data || !['image', 'video'].includes(data.nodeType)) return;
        data.config = data.config || {};
        const menu = document.createElement('section');
        menu.className = 'op-node-quick-menu op-node-count-menu';
        menu.setAttribute('role', 'dialog');
        menu.setAttribute('aria-label', '生成数量与并发');
        menu.innerHTML = `
            <div class="op-quick-menu-head">
                <strong>生成数量</strong>
                <button type="button" data-close title="关闭" aria-label="关闭">×</button>
            </div>
            <div class="op-count-stepper">
                <button type="button" data-step="-1" title="减少数量" aria-label="减少数量">−</button>
                <strong data-count></strong>
                <button type="button" data-step="1" title="增加数量" aria-label="增加数量">+</button>
            </div>
            <div class="op-count-presets" aria-label="常用生成数量"></div>
            <label class="op-concurrency-control"><span>并发任务</span><select aria-label="并发任务数"></select></label>
        `;
        const countOutput = menu.querySelector('[data-count]');
        const presets = menu.querySelector('.op-count-presets');
        const concurrency = menu.querySelector('select');
        const readCount = () => Math.max(1, Math.min(20, Number(data.config.count) || 1));
        const render = () => {
            const count = readCount();
            data.config.count = count;
            countOutput.textContent = `${count}×`;
            presets.querySelectorAll('button').forEach(button => button.classList.toggle('selected', Number(button.dataset.value) === count));
            const limit = Math.min(6, count);
            const selectedConcurrency = Math.max(1, Math.min(limit, Number(data.config.concurrency) || Math.min(limit, data.nodeType === 'video' ? 2 : 3)));
            data.config.concurrency = selectedConcurrency;
            concurrency.replaceChildren(...Array.from({ length: limit }, (_, index) => {
                const option = document.createElement('option');
                option.value = String(index + 1);
                option.textContent = `${index + 1} 路`;
                return option;
            }));
            concurrency.value = String(selectedConcurrency);
        };
        const commit = count => {
            data.config.count = Math.max(1, Math.min(20, Number(count) || 1));
            render();
            this.refreshOpNode(nodeId);
            this.emit('change');
        };
        [1, 2, 4, 8].forEach(value => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.value = String(value);
            button.textContent = `${value}×`;
            button.addEventListener('click', () => commit(value));
            presets.appendChild(button);
        });
        menu.querySelectorAll('[data-step]').forEach(button => {
            button.addEventListener('click', () => commit(readCount() + Number(button.dataset.step)));
        });
        concurrency.addEventListener('change', () => {
            data.config.concurrency = Number(concurrency.value) || 1;
            this.refreshOpNode(nodeId);
            this.emit('change');
        });
        menu.querySelector('[data-close]')?.addEventListener('click', () => this._closeOpQuickMenu());
        render();
        this._mountOpQuickMenu(menu, nodeId, event);
    }

    _mountOpQuickMenu(menu, nodeId, event = null) {
        this._closeOpQuickMenu();
        this._closeOpPromptPresetMenu();
        this._removeOpNodeEditor();
        document.body.appendChild(menu);
        const entry = this.items.get(nodeId);
        const containerRect = this.container.getBoundingClientRect();
        const scale = this.stage.scaleX();
        const clientX = Number(event?.evt?.clientX);
        const clientY = Number(event?.evt?.clientY);
        const fallbackX = containerRect.left + this.stage.x() + ((entry?.group?.x() || 0) + 12) * scale;
        const fallbackY = containerRect.top + this.stage.y()
            + ((entry?.group?.y() || 0) + (entry?.data?.height || OP_NODE_HEIGHT)) * scale;
        const anchorX = Number.isFinite(clientX) ? clientX : fallbackX;
        const anchorY = Number.isFinite(clientY) ? clientY : fallbackY;
        menu.style.left = `${anchorX}px`;
        menu.style.top = `${anchorY + 8}px`;
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth - 10) menu.style.left = `${window.innerWidth - rect.width - 10}px`;
        if (rect.bottom > window.innerHeight - 10) {
            menu.style.top = `${Math.max(10, anchorY - rect.height - 8)}px`;
        }
        const closeOutside = outsideEvent => {
            if (!menu.contains(outsideEvent.target)) this._closeOpQuickMenu();
        };
        const closeOnKey = keyEvent => {
            if (keyEvent.key === 'Escape') this._closeOpQuickMenu();
        };
        this._opQuickMenu = { menu, closeOutside, closeOnKey };
        setTimeout(() => document.addEventListener('pointerdown', closeOutside, true), 0);
        document.addEventListener('keydown', closeOnKey, true);
    }

    _closeOpQuickMenu() {
        const active = this._opQuickMenu;
        if (!active) return;
        document.removeEventListener('pointerdown', active.closeOutside, true);
        document.removeEventListener('keydown', active.closeOnKey, true);
        active.menu?.remove();
        this._opQuickMenu = null;
    }

    _tidyOpPrompt(nodeId) {
        const data = this.items.get(nodeId)?.data;
        if (!data || !['text', 'image', 'video'].includes(data.nodeType)) return;
        const field = data.nodeType === 'text' ? 'text' : 'prompt';
        const current = String(data.config?.[field] || '');
        if (!current.trim()) {
            this.openInlineOpPromptEditor(nodeId);
            this._showCanvasStatus('先输入提示词，再进行优化');
            return;
        }
        const next = current
            .split(/\r?\n/)
            .map(line => line.trim())
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        if (next === current) {
            this._showCanvasStatus('提示词格式已经很整洁');
            return;
        }
        data.config[field] = next;
        this.refreshOpNode(nodeId);
        this.emit('change');
        this._showCanvasStatus('已整理提示词格式');
    }

    _textNodeImageSources(nodeId) {
        return (this.graphView?.connections || [])
            .filter(connection => connection.kind !== 'history'
                && connection.to.nodeId === nodeId
                && connection.to.port === 'context')
            .map(connection => this.items.get(connection.from.nodeId)?.data || null)
            .filter(source => source?.filePath && this._getItemMediaType(source) === 'image');
    }

    async _extractVisualPrompt(nodeId) {
        const data = this.items.get(nodeId)?.data;
        if (data?.nodeType !== 'text' || this._visualExtractingNodeIds.has(nodeId)) return;
        const filePaths = [...new Set(this._textNodeImageSources(nodeId)
            .map(source => resolveCanvasFilePath(source.filePath))
            .filter(Boolean))].slice(0, 4);
        if (!filePaths.length) {
            this._showCanvasStatus('请先将图片连接到文本节点，再提取画面', 3200);
            return;
        }
        const provider = this.options.getTextProvider?.(data.config);
        if (!provider?.apiKey || !provider?.model) {
            this._showCanvasStatus('请先配置支持图片输入的文本与视觉 API', 3600);
            return;
        }
        if (!window.flowCanvas?.ai?.describeImages) {
            this._showCanvasStatus('画面提取接口不可用，请重启 Flow Canvas', 3600);
            return;
        }

        this._closeInlineOpPromptEditor();
        this._visualExtractingNodeIds.add(nodeId);
        this.refreshOpNode(nodeId);
        this._showCanvasStatus(`正在提取${filePaths.length > 1 ? ` ${filePaths.length} 张图片的` : ''}画面…`, 120000);
        try {
            const result = await window.flowCanvas.ai.describeImages({ filePaths, provider });
            if (!result?.success) throw new Error(result?.error || '视觉模型没有返回画面描述');
            const extracted = String(result.text || '').trim();
            if (!extracted) throw new Error('视觉模型返回了空内容');
            data.config = data.config || {};
            const current = String(data.config.text || '').trim();
            data.config.text = current ? `${current}\n\n${extracted}` : extracted;
            this.refreshOpNode(nodeId);
            this.emit('change');
            this._showCanvasStatus('画面提取完成，已写入文本节点', 3000);
        } catch (error) {
            console.error('[Canvas] visual prompt extraction failed:', error);
            this._showCanvasStatus(`画面提取失败：${error?.message || error}`, 5000);
        } finally {
            this._visualExtractingNodeIds.delete(nodeId);
            if (this.items.has(nodeId)) this.refreshOpNode(nodeId);
        }
    }

    _showOpPromptPresetMenu(nodeId, event = null) {
        const data = this.items.get(nodeId)?.data;
        if (!data || !['image', 'video'].includes(data.nodeType)) return;
        this._closeOpQuickMenu();
        this._closeOpPromptPresetMenu();

        const menu = document.createElement('section');
        menu.className = 'op-prompt-preset-menu';
        menu.setAttribute('role', 'dialog');
        menu.setAttribute('aria-label', '提示词预设');
        menu.innerHTML = `
            <div class="op-prompt-preset-head">
                <strong>提示词预设</strong>
                <button type="button" title="关闭" aria-label="关闭">×</button>
            </div>
            <select class="op-prompt-preset-select" aria-label="选择提示词预设"></select>
            <div class="op-prompt-preset-save-row">
                <input type="text" maxlength="60" placeholder="输入预设名称" aria-label="预设名称">
                <button type="button" data-save-preset>保存</button>
            </div>
            <div class="op-prompt-preset-status" aria-live="polite"></div>
        `;
        const select = menu.querySelector('select');
        const nameInput = menu.querySelector('input');
        const status = menu.querySelector('.op-prompt-preset-status');
        const readPresets = () => this.options.getPromptPresets?.(data.nodeType) || [];
        const renderOptions = (selectedId = '') => {
            const presets = readPresets();
            select.replaceChildren();
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = presets.length ? '选择预设…' : '暂无预设';
            select.appendChild(placeholder);
            presets.forEach(preset => {
                const option = document.createElement('option');
                option.value = preset.id;
                option.textContent = preset.name;
                select.appendChild(option);
            });
            select.value = presets.some(preset => preset.id === selectedId) ? selectedId : '';
        };
        renderOptions();

        select.addEventListener('change', () => {
            const preset = readPresets().find(candidate => candidate.id === select.value);
            if (!preset) return;
            data.config = data.config || {};
            data.config.prompt = preset.prompt;
            nameInput.value = preset.name;
            this.refreshOpNode(nodeId);
            this.emit('change');
            status.textContent = `已写入“${preset.name}”`;
            status.dataset.state = 'success';
        });
        menu.querySelector('[data-save-preset]')?.addEventListener('click', () => {
            const name = nameInput.value.trim();
            const prompt = String(data.config?.prompt || '').trim();
            if (!name || !prompt) {
                status.textContent = !name ? '请填写预设名称' : '当前提示词为空';
                status.dataset.state = 'error';
                (!name ? nameInput : null)?.focus();
                return;
            }
            try {
                const saved = this.options.savePromptPreset?.(data.nodeType, {
                    id: select.value || null,
                    name,
                    prompt
                });
                if (!saved) throw new Error('预设存储不可用');
                renderOptions(saved.id);
                status.textContent = `已保存“${saved.name}”`;
                status.dataset.state = 'success';
            } catch (error) {
                status.textContent = error?.message || '预设保存失败';
                status.dataset.state = 'error';
            }
        });
        menu.querySelector('.op-prompt-preset-head button')?.addEventListener('click', () => {
            this._closeOpPromptPresetMenu();
        });

        document.body.appendChild(menu);
        const clientX = Number(event?.evt?.clientX);
        const clientY = Number(event?.evt?.clientY);
        const containerRect = this.container.getBoundingClientRect();
        const scale = this.stage.scaleX();
        const group = this.items.get(nodeId)?.group;
        const fallbackX = containerRect.left + this.stage.x() + ((group?.x() || 0) + 12) * scale;
        const fallbackY = containerRect.top + this.stage.y() + ((group?.y() || 0) + 40) * scale;
        menu.style.left = `${Number.isFinite(clientX) ? clientX : fallbackX}px`;
        menu.style.top = `${(Number.isFinite(clientY) ? clientY : fallbackY) + 8}px`;
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth - 10) menu.style.left = `${window.innerWidth - rect.width - 10}px`;
        if (rect.bottom > window.innerHeight - 10) menu.style.top = `${window.innerHeight - rect.height - 10}px`;

        const closeOutside = outsideEvent => {
            if (!menu.contains(outsideEvent.target)) this._closeOpPromptPresetMenu();
        };
        const closeOnKey = keyEvent => {
            if (keyEvent.key === 'Escape') this._closeOpPromptPresetMenu();
        };
        this._opPromptPresetMenu = { menu, closeOutside, closeOnKey };
        setTimeout(() => document.addEventListener('pointerdown', closeOutside, true), 0);
        document.addEventListener('keydown', closeOnKey, true);
    }

    _closeOpPromptPresetMenu() {
        const active = this._opPromptPresetMenu;
        if (!active) return;
        document.removeEventListener('pointerdown', active.closeOutside, true);
        document.removeEventListener('keydown', active.closeOnKey, true);
        active.menu?.remove();
        this._opPromptPresetMenu = null;
    }

    _ensurePersistentTextEditor(nodeId) {
        const entry = this.items.get(nodeId);
        if (!entry?.data || entry.data.kind !== 'op' || entry.data.nodeType !== 'text') {
            this._removePersistentTextEditor(nodeId);
            return null;
        }

        entry.data.config = entry.data.config || {};
        let editor = this._textNodeEditors.get(nodeId);
        if (!editor?.element?.isConnected) {
            const textarea = document.createElement('textarea');
            textarea.className = 'op-inline-prompt-editor persistent';
            textarea.placeholder = '输入 Prompt 文本';
            textarea.spellcheck = false;
            textarea.setAttribute('aria-label', 'Prompt 文本');
            this.opInlineLayer.appendChild(textarea);
            editor = { element: textarea };
            this._textNodeEditors.set(nodeId, editor);

            ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'].forEach(type => {
                textarea.addEventListener(type, inputEvent => inputEvent.stopPropagation());
            });
            textarea.addEventListener('pointerdown', inputEvent => {
                const additive = inputEvent.ctrlKey || inputEvent.metaKey || inputEvent.shiftKey;
                this.selectItem(nodeId, additive);
            });
            textarea.addEventListener('input', () => {
                const current = this.items.get(nodeId)?.data;
                if (!current || current.nodeType !== 'text') return;
                current.config = current.config || {};
                current.config.text = textarea.value;
                clearTimeout(this._textNodeChangeTimers.get(nodeId));
                this._textNodeChangeTimers.set(nodeId, setTimeout(() => {
                    this._textNodeChangeTimers.delete(nodeId);
                    if (this.items.has(nodeId)) this.emit('change');
                }, 300));
            });
            textarea.addEventListener('keydown', keyEvent => {
                keyEvent.stopPropagation();
                if (keyEvent.key === 'Escape') textarea.blur();
            });
            textarea.addEventListener('blur', () => {
                const timer = this._textNodeChangeTimers.get(nodeId);
                if (!timer) return;
                clearTimeout(timer);
                this._textNodeChangeTimers.delete(nodeId);
                if (this.items.has(nodeId)) this.emit('change');
            });
        }

        const nextValue = String(entry.data.config.text || '');
        if (editor.element.value !== nextValue) editor.element.value = nextValue;
        this._positionPersistentTextEditor(nodeId);
        return editor.element;
    }

    _positionPersistentTextEditor(nodeId) {
        const editor = this._textNodeEditors.get(nodeId);
        const entry = this.items.get(nodeId);
        if (!editor?.element?.isConnected || !entry?.group || entry.data?.nodeType !== 'text') return;
        const scale = this.stage.scaleX();
        const visible = isCanvasTextContentVisible(scale);
        editor.element.hidden = !visible;
        editor.element.setAttribute('aria-hidden', visible ? 'false' : 'true');
        editor.element.tabIndex = visible ? 0 : -1;
        if (!visible) return;
        const data = entry.data;
        const width = Number(data.width) || OP_NODE_WIDTH;
        const height = Number(data.height) || OP_NODE_HEIGHT;
        const footerY = height;
        Object.assign(editor.element.style, {
            left: `${this.stage.x() + (entry.group.x() + 11) * scale}px`,
            top: `${this.stage.y() + (entry.group.y() + this._opPromptTop(data) - 2) * scale}px`,
            width: `${Math.max(120, (width - 22) * scale)}px`,
            height: `${Math.max(58, (footerY - this._opPromptTop(data) - 4) * scale)}px`,
            fontSize: `${Math.max(11, Math.min(20, 13 * scale))}px`
        });
    }

    _syncPersistentTextEditors() {
        this._textNodeEditors.forEach((_editor, nodeId) => {
            const data = this.items.get(nodeId)?.data;
            if (!data || data.nodeType !== 'text') this._removePersistentTextEditor(nodeId);
        });
        this.items.forEach((entry, nodeId) => {
            if (entry?.data?.kind === 'op' && entry.data.nodeType === 'text') {
                this._ensurePersistentTextEditor(nodeId);
            }
        });
    }

    _removePersistentTextEditor(nodeId) {
        clearTimeout(this._textNodeChangeTimers.get(nodeId));
        this._textNodeChangeTimers.delete(nodeId);
        this._textNodeEditors.get(nodeId)?.element?.remove();
        this._textNodeEditors.delete(nodeId);
    }

    _removeAllPersistentTextEditors() {
        this._textNodeEditors.forEach(editor => editor.element?.remove());
        this._textNodeEditors.clear();
        this._textNodeChangeTimers.forEach(timer => clearTimeout(timer));
        this._textNodeChangeTimers.clear();
    }

    openInlineOpPromptEditor(nodeId) {
        const entry = this.items.get(nodeId);
        if (!entry?.data || entry.data.kind !== 'op') return;
        const { data, group } = entry;
        if (!['text', 'image', 'video'].includes(data.nodeType)) return;
        if (data.nodeType === 'text') {
            const textarea = this._ensurePersistentTextEditor(nodeId);
            textarea?.focus();
            if (textarea) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
            return;
        }
        if (this._activeOpPromptEditor?.nodeId === nodeId) {
            this._activeOpPromptEditor.element.focus();
            return;
        }
        this._closeMediaTitleEditor();
        this._closeInlineOpPromptEditor();

        data.config = data.config || {};
        const field = data.nodeType === 'text' ? 'text' : 'prompt';
        const originalValue = String(data.config[field] || '');
        const textarea = document.createElement('textarea');
        textarea.className = 'op-inline-prompt-editor';
        textarea.value = originalValue;
        textarea.placeholder = data.nodeType === 'text' ? '输入 Prompt 文本' : '描述要生成的内容';
        textarea.spellcheck = false;
        textarea.setAttribute('aria-label', data.nodeType === 'text' ? 'Prompt 文本' : '生成提示词');
        this.opInlineLayer.appendChild(textarea);
        group.draggable(false);
        this._activeOpPromptEditor = {
            nodeId,
            element: textarea,
            group,
            data,
            field,
            originalValue,
            changed: false
        };
        this._positionOpPromptEditor();

        ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'].forEach(type => {
            textarea.addEventListener(type, inputEvent => inputEvent.stopPropagation());
        });
        textarea.addEventListener('input', () => {
            const active = this._activeOpPromptEditor;
            if (!active || active.element !== textarea) return;
            active.changed = textarea.value !== originalValue;
            data.config[field] = textarea.value;
            const promptText = group.findOne('.opPromptText');
            if (promptText) {
                promptText.text(textarea.value || '点击输入提示词…');
                promptText.fill(textarea.value ? '#d9dade' : '#74777d');
                group.getLayer()?.batchDraw();
            }
        });
        textarea.addEventListener('keydown', keyEvent => {
            keyEvent.stopPropagation();
            if (keyEvent.key === 'Escape') {
                keyEvent.preventDefault();
                this._closeInlineOpPromptEditor({ commit: false });
            } else if (keyEvent.key === 'Enter' && (keyEvent.ctrlKey || keyEvent.metaKey)) {
                keyEvent.preventDefault();
                this._closeInlineOpPromptEditor();
            }
        });
        textarea.addEventListener('blur', () => {
            setTimeout(() => {
                if (this._activeOpPromptEditor?.element === textarea) this._closeInlineOpPromptEditor();
            }, 0);
        });
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }

    _positionOpPromptEditor() {
        const active = this._activeOpPromptEditor;
        if (!active?.element?.isConnected) return;
        const entry = this.items.get(active.nodeId);
        if (!entry?.group) {
            this._closeInlineOpPromptEditor({ commit: false });
            return;
        }
        const scale = this.stage.scaleX();
        const data = entry.data;
        const width = Number(data.width) || OP_NODE_WIDTH;
        const height = Number(data.height) || OP_NODE_HEIGHT;
        const footerY = height - OP_NODE_FOOTER_HEIGHT;
        Object.assign(active.element.style, {
            left: `${this.stage.x() + (entry.group.x() + 11) * scale}px`,
            top: `${this.stage.y() + (entry.group.y() + this._opPromptTop(data) - 2) * scale}px`,
            width: `${Math.max(120, (width - 22) * scale)}px`,
            height: `${Math.max(58, (footerY - this._opPromptTop(data) - 4) * scale)}px`,
            fontSize: `${Math.max(11, Math.min(20, 13 * scale))}px`
        });
    }

    _closeInlineOpPromptEditor({ commit = true } = {}) {
        const active = this._activeOpPromptEditor;
        if (!active) return;
        this._activeOpPromptEditor = null;
        if (!commit) active.data.config[active.field] = active.originalValue;
        active.element?.remove();
        active.group?.draggable(true);
        if (this.items.has(active.nodeId)) this.refreshOpNode(active.nodeId);
        if (commit && active.changed) this.emit('change');
    }

    openMediaTitleEditor(nodeId) {
        const entry = this.items.get(nodeId);
        if (!entry?.data || entry.data.kind === 'op' || this._getItemMediaType(entry.data) !== 'image') return;
        if (this._activeMediaTitleEditor?.nodeId === nodeId) {
            this._activeMediaTitleEditor.element.focus();
            this._activeMediaTitleEditor.element.select();
            return;
        }

        this._closeInlineOpPromptEditor();
        this._closeMediaTitleEditor();
        const { data, group } = entry;
        const originalCustomName = Object.prototype.hasOwnProperty.call(data, 'displayName')
            ? data.displayName
            : undefined;
        const originalValue = this._mediaDisplayName(data, 'image');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'media-title-inline-editor';
        input.value = originalValue;
        input.maxLength = 160;
        input.spellcheck = false;
        input.setAttribute('aria-label', '图片名称');
        this.opInlineLayer.appendChild(input);
        group.draggable(false);
        this._activeMediaTitleEditor = {
            nodeId,
            element: input,
            group,
            data,
            originalCustomName,
            originalValue
        };
        this._positionMediaTitleEditor();

        ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'].forEach(type => {
            input.addEventListener(type, inputEvent => inputEvent.stopPropagation());
        });
        input.addEventListener('keydown', keyEvent => {
            keyEvent.stopPropagation();
            if (keyEvent.key === 'Escape') {
                keyEvent.preventDefault();
                this._closeMediaTitleEditor({ commit: false });
            } else if (keyEvent.key === 'Enter') {
                keyEvent.preventDefault();
                this._closeMediaTitleEditor();
            }
        });
        input.addEventListener('blur', () => {
            setTimeout(() => {
                if (this._activeMediaTitleEditor?.element === input) this._closeMediaTitleEditor();
            }, 0);
        });
        input.focus();
        input.select();
    }

    _positionMediaTitleEditor() {
        const active = this._activeMediaTitleEditor;
        if (!active?.element?.isConnected) return;
        const entry = this.items.get(active.nodeId);
        if (!entry?.group) {
            this._closeMediaTitleEditor({ commit: false });
            return;
        }
        const scale = this.stage.scaleX();
        const width = Number(entry.data.width) || IMAGE_DEFAULT_WIDTH;
        Object.assign(active.element.style, {
            left: `${this.stage.x() + (entry.group.x() + 18) * scale}px`,
            top: `${this.stage.y() + (entry.group.y() - 29) * scale}px`,
            width: `${Math.max(72, (width - 18) * scale)}px`,
            height: `${Math.max(24, 22 * scale)}px`,
            fontSize: `${Math.max(11, Math.min(20, 13 * scale))}px`
        });
    }

    _closeMediaTitleEditor({ commit = true } = {}) {
        const active = this._activeMediaTitleEditor;
        if (!active) return;
        this._activeMediaTitleEditor = null;

        if (commit) {
            const nextName = String(active.element?.value || '').trim();
            if (!nextName || (active.originalCustomName === undefined && nextName === active.originalValue)) {
                delete active.data.displayName;
            } else {
                active.data.displayName = nextName;
            }
        } else if (active.originalCustomName === undefined) {
            delete active.data.displayName;
        } else {
            active.data.displayName = active.originalCustomName;
        }

        const before = active.originalCustomName === undefined ? '' : String(active.originalCustomName || '').trim();
        const after = String(active.data.displayName || '').trim();
        const changed = before !== after;
        active.element?.remove();
        active.group?.draggable(true);
        if (this.items.has(active.nodeId)) {
            this._syncExternalNodeTitle(active.group, active.data, 'image');
            active.group.getLayer()?.batchDraw();
        }
        if (commit && changed) this.emit('change');
    }

    _opConfigSummary(data, def) {
        const fields = this._opConfigFields(data, def);
        if (!fields.length) return '点击运行，双击打开参数';
        if (data.nodeType === 'image' || data.nodeType === 'video' || data.nodeType === 'text') {
            return '双击填写提示词或连接上游节点';
        }
        return fields
            .map(field => {
                const value = data.config?.[field.key];
                const shown = (value === '' || value == null) ? '—' : String(value);
                return `${field.label || field.key}: ${shown}`;
            })
            .join('\n');
    }

    _opConfigFields(data, def, config = data.config || {}) {
        const profile = data.nodeType === 'video'
            ? this.options.getVideoModelProfile?.(config)
            : null;
        return (def.config || [])
            .filter(field => {
                if (!profile) return true;
                if (field.key === 'ratio') return (profile.ratios || []).length > 0;
                if (field.key === 'resolution') return (profile.resolutions || []).length > 0;
                if (field.key === 'duration') return (profile.durations || []).length > 0;
                if (field.key === 'cameraFixed') return profile.supportsCameraFixed !== false;
                if (field.key === 'generateAudio') return profile.supportsGeneratedAudio !== false;
                if (field.key === 'webSearch') return profile.supportsWebSearch === true;
                if (field.key === 'watermark') return profile.supportsWatermark !== false;
                return true;
            })
            .map(field => {
                if (!profile) return field;
                if (field.key === 'ratio') {
                    return { ...field, options: profile.ratios, default: profile.defaultRatio ?? field.default };
                }
                if (field.key === 'resolution') {
                    return { ...field, options: profile.resolutions, default: profile.defaultResolution ?? field.default };
                }
                if (field.key === 'duration') {
                    return { ...field, options: profile.durations, default: profile.defaultDuration ?? field.default };
                }
                return field;
            });
    }

    openGenerationComposer(nodeId) {
        const entry = this.items.get(nodeId);
        if (!entry?.data || entry.data.kind !== 'op' || !['image', 'video'].includes(entry.data.nodeType)) return;
        const { data } = entry;
        data.config = data.config || {};
        this._closeGenerationComposer({ commit: true, keepReferencePick: true });
        this._closeGenerationTypeMenu();
        this._closeOpQuickMenu();
        this._closeOpPromptPresetMenu();
        this._removeOpNodeEditor();

        const composer = document.createElement('section');
        composer.className = 'generation-composer';
        composer.setAttribute('role', 'dialog');
        composer.setAttribute('aria-label', data.nodeType === 'video' ? '视频生成设置' : '图片生成设置');
        composer.innerHTML = `
            <div class="generation-composer-reference-row">
                <div class="generation-composer-references" data-reference-list></div>
                ${data.nodeType === 'image' ? `
                    <button class="generation-composer-upstream-plan" type="button" data-upstream-plan hidden
                        title="规划上游提示词" aria-label="规划上游提示词" aria-haspopup="dialog">
                        <svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-sparkles"></use></svg>
                        <span>规划上游提示词</span>
                    </button>
                ` : ''}
            </div>
            <div class="generation-composer-prompt-shell">
                <div class="generation-composer-prompt" data-prompt contenteditable="true" role="textbox" aria-label="提示词" aria-multiline="true" spellcheck="false"></div>
            </div>
            <div class="generation-composer-options" data-option-row></div>
            <div class="generation-composer-footer">
                <button class="generation-composer-trigger generation-composer-model" type="button" data-model title="选择 API 和模型" aria-label="选择 API 和模型" aria-haspopup="dialog">
                    <svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-models"></use></svg>
                    <span data-model-label></span>
                    <span class="generation-composer-trigger-arrow" aria-hidden="true">⌄</span>
                </button>
                <div class="generation-composer-parameters" data-parameters></div>
                ${data.nodeType === 'image' ? `
                    <button class="generation-composer-agent-toggle" type="button" data-agent-mode role="switch"
                        title="Agent 规划模式" aria-label="Agent 规划模式">
                        <span>Agent 模式</span><i aria-hidden="true"></i>
                    </button>
                ` : ''}
                <label class="generation-composer-count" title="生成数量">
                    <select data-count aria-label="生成数量"></select>
                </label>
                <button class="generation-composer-submit" type="button" data-submit title="开始生成" aria-label="开始生成">
                    <svg viewBox="8 8 16 16" aria-hidden="true" focusable="false">
                        <path d="M10 17L16 11L22 17M16 11V22"></path>
                    </svg>
                </button>
            </div>
            <div class="generation-composer-message" data-message aria-live="polite"></div>
        `;
        document.body.appendChild(composer);

        const active = {
            nodeId,
            element: composer,
            changed: false,
            closeOutside: null,
            closeOnKey: null,
            closeOutsideTimer: null,
            popover: null
        };
        this._generationComposer = active;

        const prompt = composer.querySelector('[data-prompt]');
        this._setGenerationComposerPromptValue(prompt, data.config.prompt || '');
        prompt.dataset.placeholder = data.nodeType === 'video'
            ? '描述你希望生成的视频，参考素材会通过连线传入'
            : '描述你希望生成的图片，参考素材会通过连线传入';
        ['pointerdown', 'mousedown', 'click', 'dblclick', 'wheel'].forEach(type => {
            prompt.addEventListener(type, event => event.stopPropagation());
        });
        prompt.addEventListener('input', () => {
            data.config.prompt = this._generationComposerPromptValue(prompt);
            const previousCitationIds = Array.isArray(data.config.referenceCitationIds)
                ? data.config.referenceCitationIds.join('\u0000')
                : '';
            const citationState = this._syncGenerationComposerCitationsFromPrompt(data, prompt);
            prompt.dataset.empty = data.config.prompt || citationState.selectedIds.size ? 'false' : 'true';
            active.changed = true;
            if (previousCitationIds !== citationState.orderedIds.join('\u0000')) {
                this._renderGenerationComposerReferences(nodeId);
            }
        });
        prompt.addEventListener('keydown', event => {
            if (event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.isComposing) return;
            event.preventDefault();
            document.execCommand('insertText', false, '\n');
        });
        prompt.addEventListener('paste', event => {
            event.preventDefault();
            document.execCommand('insertText', false, event.clipboardData?.getData('text/plain') || '');
        });
        composer.querySelector('.generation-composer-prompt-shell')?.addEventListener('click', event => {
            if (event.target !== event.currentTarget) return;
            this._focusGenerationComposerPromptEnd(prompt);
        });

        const model = composer.querySelector('[data-model]');
        this._syncGenerationComposerModelButton(nodeId);
        model.addEventListener('click', () => this._showGenerationComposerModelMenu(nodeId, model));

        const upstreamPlan = composer.querySelector('[data-upstream-plan]');
        upstreamPlan?.addEventListener('click', () => this._showGenerationComposerPromptMerge(nodeId, upstreamPlan));

        const agentToggle = composer.querySelector('[data-agent-mode]');
        const syncAgentToggle = () => {
            if (!agentToggle) return;
            const enabled = this.options.getImageIntentPipelineMode?.() !== 'off';
            agentToggle.setAttribute('aria-checked', String(enabled));
            agentToggle.classList.toggle('active', enabled);
        };
        syncAgentToggle();
        agentToggle?.addEventListener('click', async () => {
            if (agentToggle.disabled) return;
            const enable = agentToggle.getAttribute('aria-checked') !== 'true';
            agentToggle.disabled = true;
            agentToggle.classList.add('pending');
            try {
                await this.options.setImageIntentPipelineEnabled?.(enable);
            } finally {
                agentToggle.disabled = false;
                agentToggle.classList.remove('pending');
                syncAgentToggle();
            }
        });

        const count = composer.querySelector('[data-count]');
        for (let value = 1; value <= 8; value += 1) {
            const option = document.createElement('option');
            option.value = String(value);
            option.textContent = `${value}×`;
            count.appendChild(option);
        }
        count.value = String(Math.max(1, Math.min(8, Number(data.config.count) || 1)));
        count.addEventListener('change', () => {
            data.config.count = Number(count.value) || 1;
            data.config.concurrency = Math.max(1, Math.min(data.config.count, data.nodeType === 'video' ? 2 : 3));
            active.changed = true;
            this.emit('change');
        });

        composer.querySelector('[data-submit]').addEventListener('click', () => this._runGeneratorFromComposer(nodeId));
        active.closeOutside = event => {
            const popover = active.popover;
            if (popover?.element?.contains(event.target)) return;
            if (composer.contains(event.target)) {
                if (!popover?.anchor?.contains(event.target)) this._closeGenerationComposerPopover(active);
                return;
            }
            if (this._activeNodeReferenceTargetId === nodeId && this.container.contains(event.target)) return;
            this._closeGenerationComposer({ commit: true });
        };
        active.closeOnKey = event => {
            if (event.key === 'Escape') {
                if (active.popover) {
                    this._closeGenerationComposerPopover(active);
                    return;
                }
                if (this._activeNodeReferenceTargetId === nodeId) {
                    this.endMediaReferencePick();
                    this._renderGenerationComposerReferences(nodeId);
                } else {
                    this._closeGenerationComposer({ commit: true });
                }
                return;
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                this._runGeneratorFromComposer(nodeId);
            }
        };
        active.closeOutsideTimer = setTimeout(() => {
            active.closeOutsideTimer = null;
            if (this._generationComposer !== active || !composer.isConnected) return;
            document.addEventListener('pointerdown', active.closeOutside, true);
        }, 0);
        document.addEventListener('keydown', active.closeOnKey, true);
        composer.addEventListener('scroll', () => this._positionGenerationComposerPopover(active));

        this._renderGenerationComposerReferences(nodeId);
        this._renderGenerationComposerParameters(nodeId);
        this._syncGenerationComposerStatus(nodeId);
        this._positionGenerationComposer();
        requestAnimationFrame(() => {
            this._positionGenerationComposer();
            this._focusGenerationComposerPromptEnd(prompt);
        });
    }

    _generationComposerPromptValue(prompt) {
        if (!prompt) return '';
        const clone = prompt.cloneNode(true);
        clone.querySelectorAll('[data-citation-id]').forEach(citation => citation.remove());
        return String(clone.innerText || clone.textContent || '')
            .replace(/\u200B/g, '')
            .replace(/\u00a0/g, ' ')
            .replace(/\r\n/g, '\n');
    }

    _setGenerationComposerPromptValue(prompt, value) {
        if (!prompt) return;
        const text = String(value || '');
        const citations = [...prompt.querySelectorAll('[data-citation-id]')];
        prompt.replaceChildren(document.createTextNode(text), ...citations);
        citations.forEach(citation => this._ensureGenerationComposerCitationCaret(citation));
        prompt.dataset.empty = text || citations.length ? 'false' : 'true';
    }

    _focusGenerationComposerPromptEnd(prompt) {
        if (!prompt) return;
        prompt.focus({ preventScroll: true });
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.selectNodeContents(prompt);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    _focusGenerationComposerPromptAfterCitation(prompt, citation) {
        if (!prompt || !citation) return;
        prompt.focus({ preventScroll: true });
        const next = this._ensureGenerationComposerCitationCaret(citation);
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.setStart(next, GENERATION_COMPOSER_CARET_ANCHOR.length);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
    }

    _ensureGenerationComposerCitationCaret(citation) {
        let next = citation.nextSibling;
        if (!next || next.nodeType !== Node.TEXT_NODE) {
            next = document.createTextNode(GENERATION_COMPOSER_CARET_ANCHOR);
            citation.after(next);
        } else if (!next.nodeValue?.startsWith(GENERATION_COMPOSER_CARET_ANCHOR)) {
            next.nodeValue = GENERATION_COMPOSER_CARET_ANCHOR + (next.nodeValue || '');
        }
        return next;
    }

    _renderGenerationComposerReferences(nodeId) {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || !data) return;
        const host = active.element.querySelector('[data-reference-list]');
        if (!host) return;
        host.replaceChildren();

        const references = this._opReferenceEntries(data);
        const citationState = this._generationComposerCitationState(data, references);
        let imageIndex = 0;
        references.forEach(({ connection, source }, index) => {
            const tile = document.createElement('div');
            tile.className = 'generation-composer-reference';
            tile.title = this._fileNameFromPath(source.filePath) || `参考素材 ${index + 1}`;
            const mediaType = this._getItemMediaType(source);
            if (mediaType === 'image' && source.filePath) {
                const referenceLabel = this._generationImageReferenceLabel(imageIndex);
                imageIndex += 1;
                const image = document.createElement('img');
                image.src = `local-res://${encodeURIComponent(resolveCanvasFilePath(source.filePath))}`;
                image.alt = '';
                tile.appendChild(image);
                tile.classList.add('citable');
                tile.classList.toggle('cited', citationState.selectedIds.has(connection.id));
                tile.tabIndex = 0;
                tile.setAttribute('role', 'button');
                tile.setAttribute('aria-label', `引用${referenceLabel}`);
                tile.setAttribute('aria-pressed', citationState.selectedIds.has(connection.id) ? 'true' : 'false');
                tile.title = `点击引用${referenceLabel} · ${tile.title}`;
                const toggleCitation = () => this._toggleGenerationComposerCitation(nodeId, connection.id);
                tile.addEventListener('pointerdown', event => {
                    if (event.target.closest('button')) return;
                    event.preventDefault();
                });
                tile.addEventListener('click', toggleCitation);
                tile.addEventListener('keydown', event => {
                    if (event.target !== tile) return;
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    toggleCitation();
                });
            } else {
                const icon = document.createElement('span');
                const iconId = mediaType === 'audio' ? 'icon-audio' : 'icon-video';
                icon.innerHTML = `<svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#${iconId}"></use></svg>`;
                tile.appendChild(icon);
            }
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.title = '移除参考素材';
            remove.setAttribute('aria-label', '移除参考素材');
            remove.textContent = '×';
            remove.addEventListener('click', event => {
                event.stopPropagation();
                this.graphView?.disconnect(connection.id);
            });
            tile.appendChild(remove);
            host.appendChild(tile);
        });

        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'generation-composer-reference-add';
        add.title = '从画布选择参考素材';
        add.setAttribute('aria-label', '添加参考素材');
        add.innerHTML = '<svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-add"></use></svg>';
        add.classList.toggle('active', this._activeNodeReferenceTargetId === nodeId);
        add.addEventListener('click', () => {
            if (this._activeNodeReferenceTargetId === nodeId) this.endMediaReferencePick();
            else this.beginNodeReferencePick(nodeId);
            this._renderGenerationComposerReferences(nodeId);
        });
        host.appendChild(add);
        this._renderGenerationComposerCitations(nodeId, references);
        this._syncGenerationComposerPromptMergeButton(nodeId);
        this._positionGenerationComposer();
    }

    _generationImageReferenceLabel(index) {
        const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
        return `图${numerals[index] || index + 1}`;
    }

    _generationComposerCitationState(data, references = this._opReferenceEntries(data)) {
        data.config = data.config || {};
        const imageReferences = references.filter(({ source }) => this._getItemMediaType(source) === 'image');
        const validIds = new Set(imageReferences.map(({ connection }) => connection.id));
        const configuredIds = Array.isArray(data.config.referenceCitationIds)
            ? data.config.referenceCitationIds.filter(id => validIds.has(id))
            : [];
        const selectedIds = new Set(configuredIds);
        const orderedIds = imageReferences
            .map(({ connection }) => connection.id)
            .filter(id => selectedIds.has(id));
        const configuredOffsets = data.config.referenceCitationOffsets
            && typeof data.config.referenceCitationOffsets === 'object'
            ? data.config.referenceCitationOffsets
            : {};
        const offsets = {};
        orderedIds.forEach(id => {
            const offset = Number(configuredOffsets[id]);
            if (Number.isFinite(offset) && offset >= 0) offsets[id] = offset;
        });
        const labels = imageReferences
            .map(({ connection }, index) => selectedIds.has(connection.id)
                ? this._generationImageReferenceLabel(index)
                : null)
            .filter(Boolean);
        data.config.referenceCitationIds = orderedIds;
        data.config.referenceCitationLabels = labels;
        data.config.referenceCitationOffsets = offsets;
        return { imageReferences, selectedIds: new Set(orderedIds), orderedIds, labels, offsets };
    }

    _toggleGenerationComposerCitation(nodeId, connectionId) {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || !data) return;
        const state = this._generationComposerCitationState(data);
        if (!state.imageReferences.some(({ connection }) => connection.id === connectionId)) return;
        const adding = !state.selectedIds.has(connectionId);
        if (adding) state.selectedIds.add(connectionId);
        else {
            state.selectedIds.delete(connectionId);
            delete data.config.referenceCitationOffsets?.[connectionId];
        }
        data.config.referenceCitationIds = [...state.selectedIds];
        active.changed = true;
        this._renderGenerationComposerReferences(nodeId);
        const prompt = active.element.querySelector('[data-prompt]');
        const citation = [...prompt.querySelectorAll('[data-citation-id]')]
            .find(element => element.dataset.citationId === connectionId);
        if (adding && citation) this._focusGenerationComposerPromptAfterCitation(prompt, citation);
        else this._focusGenerationComposerPromptEnd(prompt);
    }

    _renderGenerationComposerCitations(nodeId, references = null) {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || !data) return;
        const prompt = active.element.querySelector('[data-prompt]');
        if (!prompt) return;
        const state = this._generationComposerCitationState(data, references || this._opReferenceEntries(data));
        const labelsById = new Map(state.imageReferences.map(({ connection }, index) => [
            connection.id,
            this._generationImageReferenceLabel(index)
        ]));
        const existingById = new Map();
        prompt.querySelectorAll('[data-citation-id]').forEach(citation => {
            const citationId = citation.dataset.citationId;
            if (!state.selectedIds.has(citationId) || existingById.has(citationId)) {
                citation.remove();
                return;
            }
            const label = labelsById.get(citationId);
            citation.textContent = label;
            citation.title = `取消引用${label}`;
            citation.setAttribute('aria-label', `取消引用${label}`);
            existingById.set(citationId, citation);
        });

        const selectionRange = this._generationComposerPromptSelection(prompt);
        const missing = state.imageReferences.filter(({ connection }) =>
            state.selectedIds.has(connection.id) && !existingById.has(connection.id)
        );
        for (let index = missing.length - 1; index >= 0; index -= 1) {
            const { connection } = missing[index];
            const label = labelsById.get(connection.id);
            const pill = this._createGenerationComposerCitation(nodeId, connection.id, label);
            this._insertGenerationComposerCitation(
                prompt,
                pill,
                state.offsets[connection.id],
                selectionRange
            );
            existingById.set(connection.id, pill);
        }
        const synced = this._syncGenerationComposerCitationsFromPrompt(data, prompt);
        prompt.dataset.empty = this._generationComposerPromptValue(prompt) || synced.selectedIds.size
            ? 'false'
            : 'true';
    }

    _createGenerationComposerCitation(nodeId, connectionId, label) {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'generation-composer-citation';
        pill.dataset.citationId = connectionId;
        pill.contentEditable = 'false';
        pill.textContent = label;
        pill.title = `取消引用${label}`;
        pill.setAttribute('aria-label', `取消引用${label}`);
        pill.addEventListener('pointerdown', event => {
            event.preventDefault();
            event.stopPropagation();
        });
        pill.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            this._toggleGenerationComposerCitation(nodeId, connectionId);
        });
        return pill;
    }

    _generationComposerPromptSelection(prompt) {
        const selection = window.getSelection();
        if (!selection?.rangeCount) return null;
        const range = selection.getRangeAt(0);
        const common = range.commonAncestorContainer;
        if (common !== prompt && !prompt.contains(common)) return null;
        const element = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
        if (element?.closest?.('[data-citation-id]')) return null;
        return range.cloneRange();
    }

    _insertGenerationComposerCitation(prompt, citation, offset, selectionRange = null) {
        const textPosition = Number.isFinite(offset)
            ? this._generationComposerTextPosition(prompt, offset)
            : null;
        const range = document.createRange();
        if (textPosition) {
            range.setStart(textPosition.node, textPosition.offset);
        } else if (selectionRange) {
            range.setStart(selectionRange.endContainer, selectionRange.endOffset);
        } else {
            range.selectNodeContents(prompt);
            range.collapse(false);
        }
        range.collapse(true);
        range.insertNode(citation);
        this._ensureGenerationComposerCitationCaret(citation);
    }

    _generationComposerTextPosition(prompt, requestedOffset) {
        let remaining = Math.max(0, Number(requestedOffset) || 0);
        const walker = document.createTreeWalker(prompt, NodeFilter.SHOW_TEXT, {
            acceptNode: node => node.parentElement?.closest?.('[data-citation-id]')
                ? NodeFilter.FILTER_REJECT
                : NodeFilter.FILTER_ACCEPT
        });
        let node = walker.nextNode();
        let last = null;
        while (node) {
            last = node;
            const value = node.nodeValue || '';
            const length = value.replace(/\u200B/g, '').length;
            if (remaining <= length) {
                let rawOffset = 0;
                let visibleOffset = 0;
                while (rawOffset < value.length && visibleOffset < remaining) {
                    if (value[rawOffset] !== GENERATION_COMPOSER_CARET_ANCHOR) visibleOffset += 1;
                    rawOffset += 1;
                }
                return { node, offset: rawOffset };
            }
            remaining -= length;
            node = walker.nextNode();
        }
        return last ? { node: last, offset: last.nodeValue?.length || 0 } : null;
    }

    _generationComposerCitationOffsets(prompt) {
        const offsets = {};
        let textOffset = 0;
        const visit = node => {
            if (node.nodeType === Node.TEXT_NODE) {
                textOffset += (node.nodeValue || '').replace(/\u200B/g, '').length;
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            if (node.matches('[data-citation-id]')) {
                offsets[node.dataset.citationId] = textOffset;
                return;
            }
            if (node.tagName === 'BR') {
                textOffset += 1;
                return;
            }
            node.childNodes.forEach(visit);
        };
        prompt.childNodes.forEach(visit);
        return offsets;
    }

    _syncGenerationComposerCitationsFromPrompt(data, prompt) {
        const references = this._opReferenceEntries(data);
        const imageReferences = references.filter(({ source }) => this._getItemMediaType(source) === 'image');
        const visibleIds = new Set([...prompt.querySelectorAll('[data-citation-id]')]
            .map(citation => citation.dataset.citationId));
        data.config.referenceCitationIds = imageReferences
            .map(({ connection }) => connection.id)
            .filter(id => visibleIds.has(id));
        const state = this._generationComposerCitationState(data, references);
        const measuredOffsets = this._generationComposerCitationOffsets(prompt);
        data.config.referenceCitationOffsets = Object.fromEntries(state.orderedIds
            .filter(id => Number.isFinite(measuredOffsets[id]))
            .map(id => [id, measuredOffsets[id]]));
        state.offsets = data.config.referenceCitationOffsets;
        return state;
    }

    _syncGenerationComposerModelButton(nodeId) {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || !data) return;
        const button = active.element.querySelector('[data-model]');
        const label = button?.querySelector('[data-model-label]');
        if (!button || !label) return;
        const providers = this.options.getGenerationProviders?.(data.nodeType) || [];
        const selected = providers.find(provider =>
            provider.id === data.config?.providerId
            || (provider.sourceProviderId === data.config?.sourceProviderId && provider.model === data.config?.model)
        );
        label.textContent = selected?.model || data.config?.model || (providers.length ? '选择模型' : '请先添加 API');
        button.title = selected
            ? `${selected.name || '未命名 API'} · ${selected.model || '未命名模型'}`
            : (providers.length ? '选择 API 和模型' : '请先在设置中添加 API');
        button.classList.toggle('is-empty', !selected && !data.config?.model);
    }

    _showGenerationComposerModelMenu(nodeId, anchor) {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || !data) return;
        if (active.popover?.anchor === anchor) {
            this._closeGenerationComposerPopover(active);
            return;
        }
        const providers = this.options.getGenerationProviders?.(data.nodeType) || [];
        const popover = document.createElement('section');
        popover.className = 'generation-composer-popover generation-composer-model-popover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', '选择模型');
        popover.innerHTML = `
            <div class="generation-composer-popover-title">选择模型</div>
            <label class="generation-composer-popover-search">
                <svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-search"></use></svg>
                <input type="search" autocomplete="off" placeholder="搜索模型或 API" aria-label="搜索模型或 API">
            </label>
            <div class="generation-composer-model-options" role="listbox"></div>
        `;
        const search = popover.querySelector('input');
        const list = popover.querySelector('.generation-composer-model-options');
        const render = () => {
            const query = search.value.trim().toLowerCase();
            const matches = providers.filter(provider =>
                !query || `${provider.model || ''} ${provider.name || ''}`.toLowerCase().includes(query)
            );
            list.replaceChildren();
            if (!matches.length) {
                const empty = document.createElement('div');
                empty.className = 'generation-composer-popover-empty';
                empty.textContent = providers.length ? '没有匹配的模型' : '请先在设置中添加图片 API';
                list.appendChild(empty);
                return;
            }
            matches.forEach(provider => {
                const selected = provider.id === data.config?.providerId
                    || (provider.sourceProviderId === data.config?.sourceProviderId && provider.model === data.config?.model);
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'generation-composer-model-option';
                button.classList.toggle('selected', selected);
                button.setAttribute('role', 'option');
                button.setAttribute('aria-selected', String(selected));
                const copy = document.createElement('span');
                const model = document.createElement('strong');
                model.textContent = provider.model || '未命名模型';
                const source = document.createElement('small');
                source.textContent = provider.name || '未命名 API';
                copy.append(model, source);
                const marker = document.createElement('span');
                marker.textContent = selected ? '当前' : '›';
                button.append(copy, marker);
                button.addEventListener('click', () => {
                    data.config.providerId = provider.id;
                    data.config.sourceProviderId = provider.sourceProviderId || provider.id;
                    data.config.model = provider.model || '';
                    data.model = data.config.model;
                    if (data.nodeType === 'video') this._normalizeVideoConfigForProfile(data.config);
                    active.changed = true;
                    this._closeGenerationComposerPopover(active);
                    this._syncGenerationComposerModelButton(nodeId);
                    this._renderGenerationComposerParameters(nodeId);
                    this.refreshOpNode(nodeId);
                    this.emit('change');
                });
                list.appendChild(button);
            });
        };
        search.addEventListener('input', render);
        render();
        this._mountGenerationComposerPopover(active, popover, anchor);
        search.focus({ preventScroll: true });
    }

    _syncGenerationComposerImageButtons(nodeId) {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || data?.nodeType !== 'image') return;
        const parameterLabel = active.element.querySelector('[data-image-settings-label]');
        const styleLabel = active.element.querySelector('[data-image-style-label]');
        const cameraLabel = active.element.querySelector('[data-image-camera-label]');
        if (parameterLabel) parameterLabel.textContent = this._opParameterSummary(data);
        if (styleLabel) styleLabel.textContent = data.config?.style || '风格';
        if (cameraLabel) cameraLabel.textContent = data.config?.cameraControl || '摄影机控制';
    }

    _syncGenerationComposerPromptMergeButton(nodeId) {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || data?.nodeType !== 'image') return;
        const button = active.element.querySelector('[data-upstream-plan]');
        if (!button) return;
        const visible = this._hasUpstreamPrompt(data);
        const labels = { append: '追加', prepend: '前置', replace: '替换' };
        const mode = ['append', 'prepend', 'replace'].includes(data.config?.promptMergeMode)
            ? data.config.promptMergeMode
            : 'append';
        button.hidden = !visible;
        button.dataset.mode = mode;
        button.title = `规划上游提示词（${labels[mode]}）`;
        button.setAttribute('aria-label', button.title);
        if (!visible && active.popover?.anchor === button) this._closeGenerationComposerPopover(active);
    }

    _showGenerationComposerPromptMerge(nodeId, anchor) {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || data?.nodeType !== 'image' || !this._hasUpstreamPrompt(data)) return;
        if (active.popover?.anchor === anchor) {
            this._closeGenerationComposerPopover(active);
            return;
        }
        const popover = document.createElement('section');
        popover.className = 'generation-composer-popover generation-composer-prompt-merge-popover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', '规划上游提示词');
        popover.innerHTML = `
            <div class="generation-composer-popover-title">规划上游提示词</div>
            <div class="generation-composer-segmented" data-prompt-merge role="group" aria-label="上游提示词合并方式"></div>
        `;
        const host = popover.querySelector('[data-prompt-merge]');
        const selectedMode = ['append', 'prepend', 'replace'].includes(data.config.promptMergeMode)
            ? data.config.promptMergeMode
            : 'append';
        [
            { value: 'append', label: '追加' },
            { value: 'prepend', label: '前置' },
            { value: 'replace', label: '替换' }
        ].forEach(option => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = option.label;
            button.classList.toggle('selected', selectedMode === option.value);
            button.addEventListener('click', () => {
                data.config.promptMergeMode = option.value;
                host.querySelectorAll('button').forEach(candidate => candidate.classList.toggle('selected', candidate === button));
                active.changed = true;
                this._syncGenerationComposerPromptMergeButton(nodeId);
                this.refreshOpNode(nodeId);
                this.emit('change');
            });
            host.appendChild(button);
        });
        this._mountGenerationComposerPopover(active, popover, anchor);
    }

    _showGenerationComposerImageSettings(nodeId, anchor) {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || data?.nodeType !== 'image') return;
        if (active.popover?.anchor === anchor) {
            this._closeGenerationComposerPopover(active);
            return;
        }
        const profile = this.options.getImageModelProfile?.(data.config) || null;
        const availableTiers = profile?.resolutionTiers?.length
            ? profile.resolutionTiers
            : IMAGE_RESOLUTION_TIERS;
        const popover = document.createElement('section');
        popover.className = 'generation-composer-popover generation-composer-image-settings-popover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', '图片生成参数');
        popover.innerHTML = `
            <div class="generation-composer-setting-section">
                <div class="generation-composer-setting-title">画质</div>
                <div class="generation-composer-segmented" data-quality role="group" aria-label="画质"></div>
            </div>
            <div class="generation-composer-setting-section">
                <div class="generation-composer-setting-title">比例</div>
                <div class="generation-composer-ratio-grid" data-ratios role="group" aria-label="画面比例"></div>
            </div>
            <div class="generation-composer-setting-section">
                <div class="generation-composer-setting-title">联网搜索</div>
                <div class="generation-composer-segmented" data-web-search role="group" aria-label="联网搜索"></div>
            </div>
        `;
        const commitImageProfile = () => {
            const reference = this._opReferenceEntries(data)[0]?.source;
            Object.assign(data.config, resolveImageDimensions(
                data.config.resolutionTier || '1K',
                data.config.ratio || 'adaptive',
                { width: reference?.width || data.config.width, height: reference?.height || data.config.height }
            ));
            active.changed = true;
            this._syncGenerationComposerImageButtons(nodeId);
            this.refreshOpNode(nodeId);
            this.emit('change');
        };
        const qualityHost = popover.querySelector('[data-quality]');
        IMAGE_RESOLUTION_TIERS.forEach(tier => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = tier;
            button.disabled = !availableTiers.includes(tier);
            button.classList.toggle('selected', data.config.resolutionTier === tier);
            button.addEventListener('click', () => {
                data.config.resolutionTier = tier;
                qualityHost.querySelectorAll('button').forEach(candidate => candidate.classList.toggle('selected', candidate === button));
                commitImageProfile();
            });
            qualityHost.appendChild(button);
        });
        const ratioHost = popover.querySelector('[data-ratios]');
        IMAGE_ASPECT_RATIOS.forEach(ratio => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.value = ratio;
            button.classList.toggle('selected', data.config.ratio === ratio);
            const icon = document.createElement('span');
            icon.className = 'generation-composer-ratio-icon';
            if (ratio === 'adaptive') {
                icon.innerHTML = '<svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-fit"></use></svg>';
            } else {
                const [ratioWidth, ratioHeight] = ratio.split(':').map(Number);
                const numericRatio = ratioWidth / ratioHeight;
                const width = numericRatio >= 1 ? 22 : Math.max(7, Math.round(22 * numericRatio));
                const height = numericRatio >= 1 ? Math.max(7, Math.round(22 / numericRatio)) : 22;
                icon.style.setProperty('--ratio-width', `${width}px`);
                icon.style.setProperty('--ratio-height', `${height}px`);
            }
            const label = document.createElement('span');
            label.textContent = ratio === 'adaptive' ? '自适应' : ratio;
            button.append(icon, label);
            button.addEventListener('click', () => {
                data.config.ratio = ratio;
                ratioHost.querySelectorAll('button').forEach(candidate => candidate.classList.toggle('selected', candidate === button));
                commitImageProfile();
            });
            ratioHost.appendChild(button);
        });
        const searchHost = popover.querySelector('[data-web-search]');
        [true, false].forEach(enabled => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = enabled ? 'ON' : 'OFF';
            button.classList.toggle('selected', Boolean(data.config.webSearch) === enabled);
            button.addEventListener('click', () => {
                data.config.webSearch = enabled;
                searchHost.querySelectorAll('button').forEach(candidate => candidate.classList.toggle('selected', candidate === button));
                active.changed = true;
                this.refreshOpNode(nodeId);
                this.emit('change');
            });
            searchHost.appendChild(button);
        });
        this._mountGenerationComposerPopover(active, popover, anchor);
    }

    _showGenerationComposerImageStyle(nodeId, anchor) {
        this._showGenerationComposerImageChoice(nodeId, anchor, {
            key: 'style',
            title: '图片风格',
            emptyLabel: '默认风格'
        });
    }

    _showGenerationComposerImageCamera(nodeId, anchor) {
        this._showGenerationComposerImageChoice(nodeId, anchor, {
            key: 'cameraControl',
            title: '摄影机控制',
            emptyLabel: '模型默认'
        });
    }

    _showGenerationComposerImageChoice(nodeId, anchor, { key, title, emptyLabel }) {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || data?.nodeType !== 'image') return;
        if (active.popover?.anchor === anchor) {
            this._closeGenerationComposerPopover(active);
            return;
        }
        const field = NODE_TYPES.image?.config?.find(candidate => candidate.key === key);
        const choices = field?.options || [''];
        const popover = document.createElement('section');
        popover.className = 'generation-composer-popover generation-composer-style-popover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', title);
        const titleElement = document.createElement('div');
        titleElement.className = 'generation-composer-popover-title';
        titleElement.textContent = title;
        const options = document.createElement('div');
        options.className = 'generation-composer-style-options';
        choices.forEach(value => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = value || emptyLabel;
            button.classList.toggle('selected', String(data.config[key] || '') === String(value));
            button.addEventListener('click', () => {
                data.config[key] = value;
                active.changed = true;
                this._syncGenerationComposerImageButtons(nodeId);
                this.refreshOpNode(nodeId);
                this.emit('change');
                this._closeGenerationComposerPopover(active);
            });
            options.appendChild(button);
        });
        popover.append(titleElement, options);
        this._mountGenerationComposerPopover(active, popover, anchor);
    }

    _mountGenerationComposerPopover(active, element, anchor) {
        if (!active || this._generationComposer !== active) return;
        this._closeGenerationComposerPopover(active);
        document.body.appendChild(element);
        active.popover = { element, anchor };
        anchor.classList.add('is-open');
        anchor.setAttribute('aria-expanded', 'true');
        this._positionGenerationComposerPopover(active);
    }

    _positionGenerationComposerPopover(active = this._generationComposer) {
        const popover = active?.popover;
        if (!popover?.element?.isConnected || !popover.anchor?.isConnected) return;
        const margin = 10;
        const gap = 9;
        const anchorRect = popover.anchor.getBoundingClientRect();
        const rect = popover.element.getBoundingClientRect();
        let left = anchorRect.left;
        let top = anchorRect.top - rect.height - gap;
        let placement = 'above';
        if (top < margin) {
            top = anchorRect.bottom + gap;
            placement = 'below';
        }
        left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - rect.width - margin));
        top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - rect.height - margin));
        popover.element.style.left = `${left}px`;
        popover.element.style.top = `${top}px`;
        popover.element.dataset.placement = placement;
    }

    _closeGenerationComposerPopover(active = this._generationComposer) {
        const popover = active?.popover;
        if (!popover) return;
        active.popover = null;
        popover.anchor?.classList.remove('is-open');
        popover.anchor?.setAttribute('aria-expanded', 'false');
        popover.element?.remove();
    }

    _renderGenerationComposerParameters(nodeId) {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || !data) return;
        const host = active.element.querySelector('[data-parameters]');
        const optionRow = active.element.querySelector('[data-option-row]');
        if (!host || !optionRow) return;
        host.replaceChildren();
        optionRow.replaceChildren();

        const addSelect = (parent, key, values, formatter, title) => {
            if (!values?.length) return null;
            const label = document.createElement('label');
            label.className = 'generation-composer-select';
            label.title = title;
            const select = document.createElement('select');
            select.setAttribute('aria-label', title);
            values.forEach(value => {
                const option = document.createElement('option');
                option.value = String(value);
                option.textContent = formatter ? formatter(value) : String(value);
                select.appendChild(option);
            });
            select.value = String(data.config[key] ?? values[0]);
            if (!select.value && values.length) select.value = String(values[0]);
            select.addEventListener('change', () => {
                data.config[key] = key === 'duration' ? Number(select.value) : select.value;
                if (data.nodeType === 'image' && (key === 'ratio' || key === 'resolutionTier')) {
                    const reference = this._opReferenceEntries(data)[0]?.source;
                    Object.assign(data.config, resolveImageDimensions(
                        data.config.resolutionTier || '1K',
                        data.config.ratio || 'adaptive',
                        { width: reference?.width || data.config.width, height: reference?.height || data.config.height }
                    ));
                }
                active.changed = true;
                this.refreshOpNode(nodeId);
                this.emit('change');
            });
            label.appendChild(select);
            parent.appendChild(label);
            return select;
        };

        if (data.nodeType === 'image') {
            const width = Math.max(64, Number(data.config.width) || 1024);
            const height = Math.max(64, Number(data.config.height) || 1024);
            data.config.resolutionTier = IMAGE_RESOLUTION_TIERS.includes(data.config.resolutionTier)
                ? data.config.resolutionTier
                : inferImageResolutionTier(width, height);
            data.config.ratio = IMAGE_ASPECT_RATIOS.includes(data.config.ratio)
                ? data.config.ratio
                : inferImageAspectRatio(width, height);
            const profile = this.options.getImageModelProfile?.(data.config) || null;
            const availableTiers = profile?.resolutionTiers || [];
            if (availableTiers.length && !availableTiers.includes(data.config.resolutionTier)) {
                data.config.resolutionTier = availableTiers.includes(profile.defaultResolutionTier)
                    ? profile.defaultResolutionTier
                    : availableTiers[0];
                const reference = this._opReferenceEntries(data)[0]?.source;
                Object.assign(data.config, resolveImageDimensions(
                    data.config.resolutionTier,
                    data.config.ratio,
                    { width: reference?.width || data.config.width, height: reference?.height || data.config.height }
                ));
                active.changed = true;
            }
            const settings = document.createElement('button');
            settings.type = 'button';
            settings.className = 'generation-composer-trigger generation-composer-parameter-trigger';
            settings.dataset.imageSettings = '';
            settings.title = '画质、比例和联网搜索';
            settings.setAttribute('aria-label', '图片生成参数');
            settings.setAttribute('aria-haspopup', 'dialog');
            settings.innerHTML = `
                <svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-fit"></use></svg>
                <span data-image-settings-label></span>
            `;
            settings.addEventListener('click', () => this._showGenerationComposerImageSettings(nodeId, settings));
            const style = document.createElement('button');
            style.type = 'button';
            style.className = 'generation-composer-trigger generation-composer-style-trigger';
            style.title = '图片风格';
            style.setAttribute('aria-label', '图片风格');
            style.setAttribute('aria-haspopup', 'dialog');
            style.innerHTML = `
                <svg class="flow-icon" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-sparkles"></use></svg>
                <span data-image-style-label></span>
            `;
            style.addEventListener('click', () => this._showGenerationComposerImageStyle(nodeId, style));
            const camera = document.createElement('button');
            camera.type = 'button';
            camera.className = 'generation-composer-trigger generation-composer-camera-trigger';
            camera.title = '摄影机控制';
            camera.setAttribute('aria-label', '摄影机控制');
            camera.setAttribute('aria-haspopup', 'dialog');
            camera.innerHTML = `
                <span class="generation-composer-camera-icon" aria-hidden="true"></span>
                <span data-image-camera-label></span>
            `;
            camera.addEventListener('click', () => this._showGenerationComposerImageCamera(nodeId, camera));
            host.append(settings, style, camera);
            this._syncGenerationComposerImageButtons(nodeId);
        } else {
            const profile = this._normalizeVideoConfigForProfile(data.config);
            if (profile) {
                addSelect(host, 'ratio', profile.ratios || [], null, '画面比例');
                addSelect(host, 'resolution', profile.resolutions || [], null, '输出分辨率');
                addSelect(host, 'duration', profile.durations || [], value => Number(value) === -1 ? '智能时长' : `${value}s`, '视频时长');
            }
            const toggles = [
                ['cameraFixed', '固定镜头', Boolean(profile) && profile.supportsCameraFixed !== false],
                ['generateAudio', '生成音频', Boolean(profile) && profile.supportsGeneratedAudio !== false],
                ['webSearch', '联网搜索', Boolean(profile) && profile.supportsWebSearch === true],
                ['watermark', '水印', Boolean(profile) && profile.supportsWatermark !== false]
            ];
            toggles.filter(([, , visible]) => visible).forEach(([key, labelText]) => {
                const label = document.createElement('label');
                label.className = 'generation-composer-toggle';
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.checked = Boolean(data.config[key]);
                input.addEventListener('change', () => {
                    data.config[key] = input.checked;
                    active.changed = true;
                    this.emit('change');
                });
                const text = document.createElement('span');
                text.textContent = labelText;
                label.append(input, text);
                optionRow.appendChild(label);
            });
        }
        optionRow.hidden = !optionRow.childElementCount;
        this._positionGenerationComposer();
    }

    async _runGeneratorFromComposer(nodeId) {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || !data) return;
        const message = active.element.querySelector('[data-message]');
        const hasUpstreamPrompt = this._hasUpstreamPrompt(data);
        if (!String(data.config?.prompt || '').trim() && !hasUpstreamPrompt) {
            message.textContent = '请先填写提示词，或连接一个文本节点';
            message.dataset.state = 'error';
            active.element.querySelector('[data-prompt]')?.focus();
            return;
        }
        if (!data.config?.providerId && !data.config?.model) {
            message.textContent = '请先选择一个可用模型';
            message.dataset.state = 'error';
            active.element.querySelector('[data-model]')?.focus();
            return;
        }

        data.runError = '';
        clearGeneratorResults(data);
        active.changed = false;
        this.emit('change');
        this._syncGenerationComposerStatus(nodeId, '正在提交生成任务…');
        await this.runFromNode(nodeId);
        this._syncGenerationComposerStatus(nodeId);
    }

    _syncGenerationComposerStatus(nodeId, pendingMessage = '') {
        const active = this._generationComposer;
        const data = this.items.get(nodeId)?.data;
        if (active?.nodeId !== nodeId || !data) return;
        const submit = active.element.querySelector('[data-submit]');
        const message = active.element.querySelector('[data-message]');
        const isBusy = data.runStatus === STATUS.QUEUED || data.runStatus === STATUS.RUNNING;
        submit?.classList.toggle('is-running', isBusy);
        submit?.setAttribute('aria-label', isBusy ? '生成中' : '开始生成');
        if (pendingMessage) {
            message.textContent = pendingMessage;
            message.dataset.state = 'pending';
        } else if (data.runStatus === STATUS.ERROR) {
            message.textContent = data.runError || '生成失败';
            message.dataset.state = 'error';
        } else if (data.runStatus === STATUS.DONE) {
            message.textContent = '';
            delete message.dataset.state;
        } else if (isBusy) {
            message.textContent = data.runStatus === STATUS.QUEUED ? '任务排队中…' : '正在生成…';
            message.dataset.state = 'pending';
        } else {
            message.textContent = '';
            delete message.dataset.state;
        }
    }

    _positionGenerationComposer() {
        const active = this._generationComposer;
        const entry = active ? this.items.get(active.nodeId) : null;
        if (!active?.element?.isConnected || !entry?.group) return;
        const containerRect = this.container.getBoundingClientRect();
        const scale = this.stage.scaleX() || 1;
        const left = containerRect.left + this.stage.x() + entry.group.x() * scale;
        const top = containerRect.top + this.stage.y() + entry.group.y() * scale;
        const anchor = {
            left,
            top,
            right: left + Number(entry.data.width || 1) * scale,
            bottom: top + Number(entry.data.height || 1) * scale,
            width: Number(entry.data.width || 1) * scale,
            height: Number(entry.data.height || 1) * scale
        };
        const rect = active.element.getBoundingClientRect();
        const position = getGeneratorComposerPosition(
            anchor,
            { width: rect.width, height: rect.height },
            { width: window.innerWidth, height: window.innerHeight }
        );
        active.element.style.left = `${position.left}px`;
        active.element.style.top = `${position.top}px`;
        active.element.dataset.placement = position.placement;
        this._positionGenerationComposerPopover(active);
    }

    _closeGenerationComposer({ commit = true, keepReferencePick = false } = {}) {
        const active = this._generationComposer;
        if (!active) return;
        this._closeGenerationComposerPopover(active);
        this._generationComposer = null;
        clearTimeout(active.closeOutsideTimer);
        active.closeOutsideTimer = null;
        document.removeEventListener('pointerdown', active.closeOutside, true);
        document.removeEventListener('keydown', active.closeOnKey, true);
        active.element?.remove();
        if (!keepReferencePick && this._activeNodeReferenceTargetId === active.nodeId) {
            this.endMediaReferencePick({ silent: true });
        }
        if (commit && active.changed) this.emit('change');
    }

    /** 双击 op 节点时打开配置编辑器，允许输入文本/数值 */
    openOpNodeEditor(nodeId) {
        const entry = this.items.get(nodeId);
        if (!entry?.data || entry.data.kind !== 'op') return;
        const { data } = entry;
        if (data.nodeType === 'image' || data.nodeType === 'video') {
            this.openGenerationComposer(nodeId);
            return;
        }
        const def = NODE_TYPES[data.nodeType] || {};
        data.config = data.config || {};
        const fields = this._opConfigFields(data, def);
        if (!fields.length) return;

        this._removeOpNodeEditor();

        const overlay = document.createElement('div');
        overlay.className = 'plan-editor-overlay op-node-editor-overlay';
        overlay.innerHTML = `
            <div class="plan-editor op-node-editor" role="dialog" aria-modal="true">
                <div class="plan-editor-header">
                    <input class="plan-editor-title" value="${escapeHtml(data.title || def.title || data.nodeType)}" aria-label="节点标题">
                    <button class="plan-editor-close" type="button" title="关闭">×</button>
                </div>
                <div class="plan-editor-table-wrap op-node-editor-body"></div>
                <div class="plan-editor-footer">
                    <div></div>
                    <div class="plan-editor-footer-actions">
                        <button class="plan-editor-cancel" type="button">取消</button>
                        <button class="plan-editor-save" type="button">保存</button>
                    </div>
                </div>
            </div>
        `;

        const body = overlay.querySelector('.op-node-editor-body');
        const draft = { ...data.config };
        const inputs = [];
        let applyVideoProfile = () => {};

        if (['text', 'image', 'video'].includes(data.nodeType)) {
            const providerOptions = this.options.getGenerationProviders?.(data.nodeType) || [];
            const wrap = document.createElement('label');
            wrap.className = 'op-node-field';
            const label = document.createElement('span');
            label.className = 'op-node-field-label';
            label.textContent = 'API / 模型';
            const select = document.createElement('select');
            select.className = 'plan-cell-input';
            const empty = document.createElement('option');
            empty.value = '';
            empty.textContent = providerOptions.length ? '请选择模型' : '请先在设置中添加 API';
            select.appendChild(empty);
            providerOptions.forEach(provider => {
                const option = document.createElement('option');
                option.value = provider.id;
                option.textContent = `${provider.name} (${provider.model})`;
                option.dataset.sourceProviderId = provider.sourceProviderId;
                option.dataset.model = provider.model;
                select.appendChild(option);
            });
            select.value = draft.providerId || '';
            select.addEventListener('change', () => {
                const option = select.selectedOptions[0];
                draft.providerId = select.value || null;
                draft.sourceProviderId = option?.dataset.sourceProviderId || null;
                draft.model = option?.dataset.model || '';
                applyVideoProfile();
            });
            wrap.append(label, select);
            body.appendChild(wrap);
        }

        fields.forEach(field => {
            const wrap = document.createElement('label');
            wrap.className = 'op-node-field';
            const label = document.createElement('span');
            label.className = 'op-node-field-label';
            label.textContent = field.label || field.key;
            wrap.appendChild(label);

            const current = draft[field.key] ?? field.default ?? '';
            let control;
            if (field.type === 'textarea') {
                control = document.createElement('textarea');
                control.className = 'plan-cell-input';
                control.rows = 4;
                control.value = String(current);
            } else if (field.type === 'checkbox') {
                wrap.classList.add('is-checkbox');
                control = document.createElement('input');
                control.className = 'op-node-checkbox';
                control.type = 'checkbox';
                control.checked = Boolean(current);
            } else if (field.type === 'select') {
                control = document.createElement('select');
                control.className = 'plan-cell-input';
                (field.options || []).forEach(value => {
                    const option = document.createElement('option');
                    option.value = String(value);
                    option.textContent = String(value);
                    control.appendChild(option);
                });
                control.value = String(current);
            } else {
                control = document.createElement('input');
                control.className = 'plan-cell-input';
                control.type = field.type === 'number' ? 'number' : 'text';
                control.value = String(current);
            }
            const readValue = () => field.type === 'checkbox'
                ? control.checked
                : field.type === 'number'
                    ? (control.value === '' ? '' : Number(control.value))
                    : control.value;
            control.addEventListener('input', () => { draft[field.key] = readValue(); });
            inputs.push({ field, control, wrap });
            wrap.appendChild(control);
            body.appendChild(wrap);
        });

        if (data.nodeType === 'video') {
            applyVideoProfile = () => {
                const nextFields = new Map(
                    this._opConfigFields(data, def, draft).map(field => [field.key, field])
                );
                inputs.forEach(input => {
                    const nextField = nextFields.get(input.field.key);
                    input.wrap.hidden = !nextField;
                    if (!nextField) {
                        if (input.field.type === 'checkbox') {
                            input.control.checked = false;
                            draft[input.field.key] = false;
                        }
                        return;
                    }
                    if (input.field.type !== 'select') return;
                    const previousValue = String(draft[input.field.key] ?? input.control.value ?? '');
                    const options = (nextField.options || []).map(String);
                    input.control.replaceChildren(...options.map(value => {
                        const option = document.createElement('option');
                        option.value = value;
                        option.textContent = value;
                        return option;
                    }));
                    const fallback = String(nextField.default ?? options[0] ?? '');
                    input.control.value = options.includes(previousValue) ? previousValue : fallback;
                    draft[input.field.key] = input.control.value;
                });
            };
            applyVideoProfile();
        }

        document.body.appendChild(overlay);
        const titleInput = overlay.querySelector('.plan-editor-title');
        (inputs[0]?.control || titleInput)?.focus();

        const close = () => this._removeOpNodeEditor();
        const save = () => {
            inputs.forEach(({ field, control }) => {
                data.config[field.key] = field.type === 'checkbox'
                    ? control.checked
                    : field.type === 'number'
                        ? (control.value === '' ? '' : Number(control.value))
                        : control.value;
            });
            Object.assign(data.config, draft);
            data.model = data.config.model || '';
            const title = titleInput.value.trim();
            if (title) data.title = title;
            this.refreshOpNode(nodeId);
            this.emit('change');
            close();
        };

        overlay.querySelector('.plan-editor-close')?.addEventListener('click', close);
        overlay.querySelector('.plan-editor-cancel')?.addEventListener('click', close);
        overlay.querySelector('.plan-editor-save')?.addEventListener('click', save);
        overlay.addEventListener('mousedown', event => {
            if (event.target === overlay) close();
        });
        overlay.addEventListener('keydown', event => {
            if (event.key === 'Escape') { close(); return; }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) save();
        });
    }

    _removeOpNodeEditor() {
        document.querySelectorAll('.op-node-editor-overlay').forEach(node => node.remove());
    }

    /** 状态变化后只重绘该节点，避免整层刷新 */
    refreshOpNode(nodeId) {
        const entry = this.items.get(nodeId);
        if (!entry?.data || entry.data.kind !== 'op') return;
        const { group, data } = entry;
        if ((data.nodeType === 'image' || data.nodeType === 'video') && getGeneratorResultEntries(data).length === 0) {
            const reference = this._opReferenceEntries(data)[0]?.source;
            const size = getGeneratorPlaceholderSize(data.nodeType, data.config, reference);
            data.width = size.width;
            data.height = size.height;
        }
        this._drawOpNode(group, data, data.width || OP_NODE_WIDTH, data.height || OP_NODE_HEIGHT);
        if (data.nodeType === 'text') this._ensurePersistentTextEditor(nodeId);
        this.graphView?.renderPorts(nodeId);
        if (this._generationComposer?.nodeId === nodeId) this._renderGenerationComposerReferences(nodeId);
        this._syncGenerationComposerStatus(nodeId);
        this._positionGenerationComposer();
        this.layer.batchDraw();
    }

    /**
     * 生成结果自动落地成素材卡片，并连一条 history 边指回源节点。
     * 这是节点体系相对侧栏聊天的核心优势：产物立刻可以连出去做下一步，
     * 不用手动往画布上摆。参考 Infinite-Canvas 的 createPendingOutputFromSource。
     * history 边只做溯源，不参与执行遍历（graph-model 的 topoOrder 会忽略它）。
     */
    async _landResult(sourceItem, output) {
        const rawResult = output?.image || output?.video || output?.file || '';
        const filePath = output?._resultFilePath
            || (/^https?:\/\//i.test(String(rawResult)) ? '' : resolveCanvasFilePath(rawResult));
        const resultUrl = output?._resultUrl
            || (/^https?:\/\//i.test(String(rawResult)) ? String(rawResult) : '');
        if (sourceItem?.kind === 'op' && ['image', 'video'].includes(sourceItem.nodeType)) {
            if (!filePath && !resultUrl) return null;
            const results = appendGeneratorResult(sourceItem, {
                filePath,
                url: resultUrl,
                item: output?._resultItem || null
            });

            if (results.length === 1) {
                const resultItem = output?._resultItem || {};
                const mediaWidth = Number(resultItem.naturalWidth || resultItem.pixelWidth || resultItem.width);
                const mediaHeight = Number(resultItem.naturalHeight || resultItem.pixelHeight || resultItem.height);
                if (mediaWidth > 0 && mediaHeight > 0) {
                    const size = getGeneratorPlaceholderSize(sourceItem.nodeType, { ratio: 'adaptive' }, {
                        width: mediaWidth,
                        height: mediaHeight
                    });
                    sourceItem.width = size.width;
                    sourceItem.height = size.height;
                }
            }
            this.refreshOpNode(sourceItem.id);
            this.emit('change');
            return sourceItem;
        }
        if (!filePath) return null;              // 纯文本产物留在缓存里，不落地
        const firstReference = this._opReferenceEntries(sourceItem)[0]?.source || null;
        const displaySize = resolveGenerationDisplaySize({
            kind: sourceItem.nodeType,
            referenceSize: firstReference ? {
                width: firstReference.width,
                height: firstReference.height
            } : null,
            ratio: sourceItem.config?.ratio,
            size: sourceItem.nodeType === 'image'
                ? `${Number(sourceItem.config?.width) || 1024}x${Number(sourceItem.config?.height) || 1024}`
                : '',
            longEdge: VIDEO_PLACEHOLDER_LONG_EDGE
        });
        const existing = this._findItemByFilePath(filePath);
        if (existing) {
            if (!existing.data.fromNodeId && Date.now() - Number(existing.data.addedAt || 0) < 10000) {
                const at = this._findResultSlot(sourceItem);
                existing.data.fromNodeId = sourceItem.id;
                existing.data.x = at.x;
                existing.data.y = at.y;
                existing.group.position(at);
                this._applyGeneratedDisplaySize(existing, displaySize.width, displaySize.height);
                this.graphView?.sync();
                this.emit('change');
            }
            this._connectResultHistory(sourceItem, output, existing.data.id);
            return existing.data;
        }

        const at = this._findResultSlot(sourceItem);
        const data = {
            ...(output?._resultItem || {}),
            id: output?._resultItem?.id || Date.now().toString() + Math.random().toString(36).substr(2, 5),
            filePath,
            x: at.x,
            y: at.y,
            width: displaySize.width,
            height: displaySize.height,
            addedAt: Date.now(),
            fromNodeId: sourceItem.id
        };

        // 必须 await：_createCard 是异步的（canvas.js:2638），
        // 卡片的 Konva 组建好之后端口才存在，连线才有落点。
        await this._createCard(data);
        this._scheduleCullCheck();
        this.emit('capturedFile', data);

        this._connectResultHistory(sourceItem, output, data.id);
        return data;
    }

    _connectResultHistory(sourceItem, output, resultNodeId) {
        const alreadyConnected = this.graphView?.connections?.some(connection =>
            connection.kind === 'history'
            && connection.from.nodeId === sourceItem.id
            && connection.to.nodeId === resultNodeId
        );
        if (alreadyConnected) return;
        this.graphView?.connect(
            { nodeId: sourceItem.id, port: this._resultPortName(sourceItem, output) },
            { nodeId: resultNodeId, port: 'source' },
            { kind: 'history', silent: true }
        );
    }

    /** 产物对应的输出端口名，用于连溯源边 */
    _resultPortName(sourceItem, output) {
        if (sourceItem?.kind !== 'op') return 'out';
        const def = NODE_TYPES[sourceItem.nodeType] || {};
        const outputs = def.outputs || [];
        const key = output?.image ? 'image' : output?.video ? 'video' : 'file';
        return outputs.find(p => p.dataType === key)?.name || outputs[0]?.name || 'output';
    }

    /**
     * 产物落点：源节点右侧固定偏移；该位置已被占用时向下顺延，
     * 这样连续生成不会叠在一起。只查一屏范围内的卡片，不做全局布局。
     */
    _findResultSlot(sourceItem) {
        const gap = 40;
        const baseX = (sourceItem.x || 0) + (sourceItem.width || OP_NODE_WIDTH) + gap;
        let y = sourceItem.y || 0;
        const stepY = (sourceItem.height || OP_NODE_HEIGHT) + gap;

        const occupied = (x, cy) => {
            for (const entry of this.items.values()) {
                const d = entry?.data;
                if (!d) continue;
                if (Math.abs((d.x || 0) - x) < gap && Math.abs((d.y || 0) - cy) < gap) return true;
            }
            return false;
        };

        let guard = 0;
        while (occupied(baseX, y) && guard++ < 50) y += stepY;
        return { x: Math.round(baseX), y: Math.round(y) };
    }

    _ensureRunner() {
        if (this.graphRunner) return this.graphRunner;
        this.graphRunner = new GraphRunner({
            getItems: () => {
                const map = new Map();
                this.items.forEach((entry, id) => { if (entry?.data) map.set(id, entry.data); });
                return map;
            },
            getConnections: () => this.graphView?.serialize() || [],
            onStatus: (id) => this.refreshOpNode(id),
            onResult: (item, output) => this._landResult(item, output),
            // 复用 main.js 注入的 provider 取值器（canvas.js:5977 同一套）
            getTextProvider: (binding) => this.options.getTextProvider?.(binding) || null,
            getImageProvider: (binding) => this.options.getImageProvider?.(binding) || null,
            getVideoProvider: (binding) => this.options.getVideoProvider?.(binding) || null,
            getImageIntentPipelineMode: () => this.options.getImageIntentPipelineMode?.() || 'compiled',
            prepareImageReferences: (refs) => this.options.prepareImageReferences?.(refs) || []
        });
        return this.graphRunner;
    }

    /** 执行 nodeId 及其全部上游依赖 */
    async runFromNode(nodeId) {
        const runner = this._ensureRunner();
        this._showCanvasStatus('开始执行…');
        const result = await runner.runFrom(nodeId);
        if (!result.ok) {
            this._showCanvasStatus(result.reason || '执行失败', 3200);
        } else {
            this._showCanvasStatus(`执行完成，共 ${result.ran?.length || 0} 个节点`, 2400);
            this.emit('change');
        }
        return result;
    }

    addPlan() {
        if (!this.planService) return null;
        const center = this._getViewportCenter();
        const plan = this.planService.createPlan({
            title: '规划矩阵',
            node: {
                x: center.x - PLAN_NODE_WIDTH / 2,
                y: center.y - PLAN_NODE_HEIGHT / 2,
                width: PLAN_NODE_WIDTH,
                height: PLAN_NODE_HEIGHT
            }
        });
        if (!plan) {
            this._showCanvasStatus('请先选择文件夹组');
            return null;
        }

        this._createPlanNode(plan);
        this.clearSelection();
        this.selectItem(plan.id, true);
        this.emit('plansChanged');
        this.emit('change');
        return plan;
    }

    _getViewportCenter() {
        const stagePos = this.stage.position();
        const scale = this.stage.scaleX();
        const container = this.stage.container();
        return {
            x: (container.offsetWidth / 2 - stagePos.x) / scale,
            y: (container.offsetHeight / 2 - stagePos.y) / scale
        };
    }

    _createPlanNode(plan, options = {}) {
        if (!plan) return null;
        const node = plan.node || {};
        const metricPlan = { ...plan, node };
        const metrics = this._getPlanTableMetrics(metricPlan);
        const width = metrics.width;
        const height = metrics.height;
        plan.x = node.x || 0;
        plan.y = node.y || 0;
        plan.width = width;
        plan.height = height;
        plan.node = { ...node, width, height };

        const group = new Konva.Group({
            x: plan.x,
            y: plan.y,
            draggable: true,
            id: plan.id,
            name: 'nodeGroup',
            nodeKind: 'plan'
        });

        this._drawPlanPreview(group, plan, width, height);

        const getCurrentPlan = () => this.plans.get(plan.id)?.data
            || this.planService?.getPlan?.(plan.id)
            || plan;

        group.on('mouseenter', () => {
            document.body.style.cursor = 'pointer';
            if (this._hoveredPlanId !== plan.id) {
                this._hoveredPlanId = plan.id;
                this._refreshConnectionInteractionState();
            }
            this._showCanvasStatus('悬停行查看单行连接，点击规划表展开全表连接，Alt 临时总览', 2800);
        });
        group.on('mouseleave', () => {
            document.body.style.cursor = 'default';
            if (this._hoveredPlanId === plan.id) {
                this._hoveredPlanId = null;
                this._refreshConnectionInteractionState();
            }
        });
        group.on('click', (e) => {
            if (e.evt.button === 2) return;
            if (e.evt.ctrlKey || e.evt.metaKey || e.evt.shiftKey) {
                if (this.selectedItems.has(plan.id)) {
                    const previousSelection = new Set(this.selectedItems);
                    this.selectedItems.delete(plan.id);
                    this._refreshSelectionVisualState(previousSelection);
                } else {
                    this.selectItem(plan.id, true);
                }
                return;
            }
            if (e.target?.getAttr('isPlanHandle')) return;
            this.selectItem(plan.id, false);
            this.focusPlanInlineEditor(plan.id);
        });
        group.on('contextmenu', (e) => {
            e.cancelBubble = true;
            if (!this.selectedItems.has(plan.id)) {
                this.selectItem(plan.id, false);
            }
            this._showPlanContextMenu(e, getCurrentPlan());
        });
        this.layer.add(group);
        this.plans.set(plan.id, { kind: 'plan', group, data: plan });
        if (options.mountInlineEditor !== false) {
            this._mountPlanInlineEditor(plan);
        }
        return group;
    }

    _drawPlanPreview(group, plan, width, height) {
        group.destroyChildren();
        const hitArea = new Konva.Rect({
            name: 'planHitArea displayNode',
            x: PLAN_HANDLE_X - PLAN_HANDLE_RADIUS - 8,
            width: width - PLAN_HANDLE_X + PLAN_OUTPUT_HANDLE_X_OFFSET + PLAN_HANDLE_RADIUS + 8,
            height,
            fill: 'rgba(0,0,0,0.01)',
            stroke: 'transparent',
            strokeWidth: 0
        });
        group.add(hitArea);

        const metrics = this._getPlanTableMetrics({
            ...plan,
            node: { ...(plan.node || {}), width, height }
        });
        const rows = (plan.rows || []).slice(0, metrics.maxRows);

        rows.forEach((row, rowIndex) => {
            const y = metrics.rowTops[rowIndex] ?? (PLAN_HEADER_ROW_HEIGHT + rowIndex * PLAN_ROW_HEIGHT);
            const rowHeight = metrics.rowHeights[rowIndex] || PLAN_ROW_HEIGHT;
            const anchorY = y + rowHeight / 2;
            const sourceReferences = this._getSourcePlanRowReferences(row);
            const outputReferences = this._getOutputPlanRowReferences(row);
            const references = [...sourceReferences, ...outputReferences];
            const isLinked = references.length > 0;
            const isRowActive = this._isPlanRowActive(plan.id, row.id);
            const shouldShowSourceLines = this._shouldShowPlanSourceConnections(plan.id, row.id, row);
            sourceReferences.forEach((reference, index) => {
                this._drawPlanConnectionLine(group, plan, anchorY, reference, {
                    kind: 'source',
                    rowId: row.id,
                    connectionIndex: index,
                    connectionTotal: sourceReferences.length,
                    visible: shouldShowSourceLines
                });
            });
            outputReferences.forEach((reference, index) => {
                this._drawPlanConnectionLine(group, plan, anchorY, reference, {
                    kind: 'output',
                    rowId: row.id,
                    connectionIndex: index,
                    connectionTotal: outputReferences.length,
                    visible: this._shouldShowPlanOutputConnections(plan.id, row.id, row)
                });
            });
            group.add(new Konva.Line({
                points: [PLAN_HANDLE_X + PLAN_HANDLE_RADIUS, anchorY, 0, anchorY],
                stroke: sourceReferences.length ? 'rgba(210,213,218,0.62)' : 'rgba(255,255,255,0.18)',
                strokeWidth: sourceReferences.length ? 1.6 : 1,
                dash: sourceReferences.length ? [] : [3, 4],
                listening: false
            }));
            group.add(new Konva.Circle({
                x: PLAN_HANDLE_X,
                y: anchorY,
                radius: PLAN_HANDLE_RADIUS + 6,
                fill: 'rgba(255,255,255,0.07)',
                visible: isRowActive || this.selectedItems.has(plan.id),
                listening: false
            }));
            const handle = new Konva.Circle({
                x: PLAN_HANDLE_X,
                y: anchorY,
                radius: PLAN_HANDLE_RADIUS,
                fill: sourceReferences.length ? '#0f1b2d' : '#0d121c',
                stroke: sourceReferences.length ? PLAN_SOURCE_CONNECTION_COLOR : 'rgba(210,213,218,0.68)',
                strokeWidth: sourceReferences.length ? 2.4 : 1.8,
                name: 'planRowHandle',
                draggable: true,
                isPlanHandle: true,
                planHandleKind: 'source',
                planId: plan.id,
                rowId: row.id
            });
            handle.on('mouseenter', () => {
                document.body.style.cursor = 'crosshair';
                this._setHoveredPlanRow(plan.id, row.id);
                this._showPlanConnectionHint(
                    plan.x + PLAN_HANDLE_X,
                    plan.y + anchorY,
                    sourceReferences.length
                        ? `${sourceReferences.length} 个参考 · 点击继续连接，双击清空`
                        : '点击选择素材，或拖拽到素材上连接'
                );
                this._showCanvasStatus('单击端口进入连接模式，拖拽到素材也可连接，双击清空本行参考', 2800);
                handle.radius(PLAN_HANDLE_RADIUS + 2);
                this.layer.batchDraw();
            });
            handle.on('mouseleave', () => {
                document.body.style.cursor = 'default';
                this._hidePlanConnectionHint();
                handle.radius(PLAN_HANDLE_RADIUS);
                this.layer.batchDraw();
            });
            handle.on('click tap', e => {
                e.cancelBubble = true;
                this._hidePlanConnectionHint();
                this.selectItem(plan.id, false);
                this._startPlanReferencePick(plan.id, row.id);
            });
            handle.on('dblclick dbltap', e => {
                e.cancelBubble = true;
                this._clearPlanRowReference(plan.id, row.id);
            });
            handle.on('dragstart', e => {
                e.cancelBubble = true;
                if (e.evt && e.evt.button !== 0) {
                    handle.stopDrag();
                    return;
                }
                group.draggable(false);
                this._hidePlanConnectionHint();
                handle.moveToTop();
                this._startPlanReferenceDrag(handle);
            });
            handle.on('dragmove', e => {
                e.cancelBubble = true;
                const target = this._highlightReferenceDropTarget(handle);
                this._updatePlanReferenceDragPreview(handle, target);
            });
            handle.on('dragend', e => {
                e.cancelBubble = true;
                group.draggable(true);
                this._stopPlanReferenceDrag();
                this._finishPlanReferenceDrag(handle);
            });
            group.add(handle);
            this._drawPlanConnectionBadge(group, PLAN_HANDLE_X, anchorY, sourceReferences.length, 'source');

            const outputHandleX = width + PLAN_OUTPUT_HANDLE_X_OFFSET;
            group.add(new Konva.Line({
                points: [width, anchorY, outputHandleX - PLAN_HANDLE_RADIUS, anchorY],
                stroke: outputReferences.length ? 'rgba(236,238,241,0.72)' : 'rgba(255,255,255,0.14)',
                strokeWidth: outputReferences.length ? 1.6 : 1,
                dash: outputReferences.length ? [] : [3, 4],
                listening: false
            }));
            group.add(new Konva.Circle({
                x: outputHandleX,
                y: anchorY,
                radius: PLAN_HANDLE_RADIUS + 6,
                fill: 'rgba(255,255,255,0.09)',
                visible: outputReferences.length > 0 || isRowActive || this.selectedItems.has(plan.id),
                listening: false
            }));
            group.add(new Konva.Circle({
                x: outputHandleX,
                y: anchorY,
                radius: PLAN_HANDLE_RADIUS,
                fill: outputReferences.length ? '#0d2230' : '#0d121c',
                stroke: outputReferences.length ? PLAN_OUTPUT_CONNECTION_COLOR : 'rgba(236,238,241,0.52)',
                strokeWidth: outputReferences.length ? 2.4 : 1.6,
                name: 'planOutputHandle',
                listening: false
            }));
            const outputHotspot = new Konva.Circle({
                x: outputHandleX,
                y: anchorY,
                radius: PLAN_HANDLE_RADIUS + 8,
                fill: 'rgba(255,255,255,0.001)',
                name: 'planOutputHandleHotspot',
                listening: true
            });
            outputHotspot.on('mouseenter', () => {
                document.body.style.cursor = 'help';
                this._setHoveredPlanRow(plan.id, row.id);
                this._showPlanConnectionHint(
                    plan.x + outputHandleX,
                    plan.y + anchorY,
                    outputReferences.length
                        ? `${outputReferences.length} 个输出 · 由生成结果自动连接`
                        : '输出端 · 生成结果后自动连接'
                );
            });
            outputHotspot.on('mouseleave', () => {
                document.body.style.cursor = 'default';
                this._hidePlanConnectionHint();
                this._setHoveredPlanRow(null, null);
            });
            group.add(outputHotspot);
            this._drawPlanConnectionBadge(group, outputHandleX, anchorY, outputReferences.length, 'output');

        });

        this._drawPlanConnectionModeHint(group, plan, width);

        if ((plan.rows || []).length > rows.length) {
            group.add(new Konva.Text({
                x: 0,
                y: height - 24,
                width,
                text: `还有 ${(plan.rows || []).length - rows.length} 行，单击查看完整表格`,
                fontSize: 11,
                fill: '#8a8f98'
            }));
        }
    }

    _getPlanConnectionCounts(plan) {
        return (plan?.rows || []).reduce((counts, row) => {
            counts.source += this._getSourcePlanRowReferences(row).length;
            counts.output += this._getOutputPlanRowReferences(row).length;
            return counts;
        }, { source: 0, output: 0 });
    }

    _drawPlanConnectionModeHint(group, plan, width) {
        const counts = this._getPlanConnectionCounts(plan);
        const total = counts.source + counts.output;
        if (!total) return;

        const hovered = this._hoveredPlanId === plan.id;
        const selected = this.selectedItems.has(plan.id);
        if (!hovered && !selected) return;

        const overview = selected || (hovered && this.isAltPressed);
        const title = overview
            ? (this.isAltPressed && !selected ? '临时总览' : '全表连接')
            : '行级连接';
        const suffix = selected
            ? '点空白收起'
            : (overview ? '松开 Alt 收起' : '悬停行聚焦 · Alt 总览');
        const text = `${title} · ${counts.source} 参考 / ${counts.output} 输出 · ${suffix}`;
        const labelWidth = Math.min(width - 32, Math.max(230, this._estimateTextWidth(text) + 38));
        const x = width - labelWidth - 12;
        const y = -34;
        const stroke = overview ? 'rgba(255, 209, 102, 0.5)' : 'rgba(210, 213, 218, 0.34)';
        const fill = overview ? 'rgba(42, 32, 13, 0.94)' : 'rgba(9, 18, 34, 0.94)';
        const textFill = overview ? '#ffe6a3' : '#dce9ff';
        const hint = new Konva.Group({
            x,
            y,
            name: 'planConnectionModeHint',
            listening: false
        });

        hint.add(new Konva.Rect({
            width: labelWidth,
            height: 24,
            fill,
            stroke,
            strokeWidth: 1,
            cornerRadius: 12,
            shadowColor: overview ? '#ffd166' : PLAN_SOURCE_CONNECTION_COLOR,
            shadowBlur: 14,
            shadowOpacity: overview ? 0.18 : 0.12,
            perfectDrawEnabled: false
        }));
        hint.add(new Konva.Circle({
            x: 13,
            y: 12,
            radius: 4,
            fill: overview ? '#ffd166' : PLAN_SOURCE_CONNECTION_COLOR,
            opacity: 0.9,
            perfectDrawEnabled: false
        }));
        hint.add(new Konva.Text({
            x: 24,
            y: 7,
            width: labelWidth - 34,
            text,
            fill: textFill,
            fontSize: 10,
            fontStyle: 'bold',
            ellipsis: true,
            listening: false
        }));
        group.add(hint);
    }

    _getPlanConnectionVisual(kind, emphasized = false, selected = false, dimmed = false) {
        const base = PLAN_CONNECTION_STYLES[kind] || PLAN_CONNECTION_STYLES.source;
        const mutedOpacity = dimmed ? Math.min(base.mutedOpacity, 0.16) : base.mutedOpacity;
        const mutedWidth = dimmed ? Math.max(1, base.mutedWidth - 0.4) : base.mutedWidth;
        const haloOpacity = dimmed ? 0.1 : 0.34;
        return {
            ...base,
            selected,
            dimmed,
            stroke: selected ? '#ffd166' : (emphasized ? base.activeColor : base.color),
            halo: selected ? 'rgba(255, 209, 102, 0.24)' : base.halo,
            strokeWidth: selected ? base.activeWidth + 0.8 : (emphasized ? base.activeWidth : mutedWidth),
            opacity: selected ? 1 : (emphasized ? base.activeOpacity : mutedOpacity),
            haloOpacity: selected ? 0.95 : (emphasized ? 0.72 : haloOpacity),
            endpointRadius: selected ? 6.2 : (emphasized ? 5.5 : (dimmed ? 3.4 : 4.2))
        };
    }

    _isPlanConnectionEmphasized(planId, rowId, reference = null) {
        return this._isPlanRowActive(planId, rowId)
            || this._referenceMatchesHoveredItem(reference)
            || this._isPlanConnectionSelected(planId, rowId, reference, this._getPlanReferenceKind(reference));
    }

    _hasPlanConnectionFocus() {
        return Boolean(
            this._selectedPlanConnection
            || this._hoveredPlanRowKey
            || this._hoveredReferenceItem
            || this._hoveredConnectionTargetId
            || this._activePlanReferencePick
        );
    }

    _isPlanConnectionDimmed(planId, rowId, reference, selected, emphasized) {
        if (selected || emphasized || !this._hasPlanConnectionFocus()) return false;
        if (this._activePlanReferencePick && this._isPlanReferencePickRow(planId, rowId)) return false;
        return true;
    }

    _getConnectionFanoutOffset(index = 0, total = 1) {
        if (!Number.isFinite(index) || !Number.isFinite(total) || total <= 1) return 0;
        const centered = index - (total - 1) / 2;
        return Math.max(
            -PLAN_CONNECTION_FANOUT_MAX,
            Math.min(PLAN_CONNECTION_FANOUT_MAX, centered * PLAN_CONNECTION_FANOUT_GAP)
        );
    }

    _getConnectionCurvePoints(startX, startY, endX, endY, routeOffset = 0) {
        const direction = endX >= startX ? 1 : -1;
        const horizontal = Math.abs(endX - startX);
        const vertical = Math.abs(endY - startY);
        const dx = Math.max(56, Math.min(280, horizontal * 0.36 + vertical * 0.12));
        return [
            startX,
            startY,
            startX + dx * direction,
            startY + routeOffset,
            endX - dx * direction,
            endY + routeOffset * 0.45,
            endX,
            endY
        ];
    }

    _getBezierPoint(points, t = 0.5) {
        const [x0, y0, x1, y1, x2, y2, x3, y3] = points;
        const mt = 1 - t;
        const mt2 = mt * mt;
        const t2 = t * t;
        return {
            x: mt2 * mt * x0 + 3 * mt2 * t * x1 + 3 * mt * t2 * x2 + t2 * t * x3,
            y: mt2 * mt * y0 + 3 * mt2 * t * y1 + 3 * mt * t2 * y2 + t2 * t * y3
        };
    }

    _getBezierTangent(points, t = 0.5) {
        const [x0, y0, x1, y1, x2, y2, x3, y3] = points;
        const mt = 1 - t;
        return {
            x: 3 * mt * mt * (x1 - x0) + 6 * mt * t * (x2 - x1) + 3 * t * t * (x3 - x2),
            y: 3 * mt * mt * (y1 - y0) + 6 * mt * t * (y2 - y1) + 3 * t * t * (y3 - y2)
        };
    }

    _truncateMiddle(value, maxLength = 24) {
        const text = String(value || '');
        if (text.length <= maxLength) return text;
        const keep = Math.max(4, Math.floor((maxLength - 1) / 2));
        return `${text.slice(0, keep)}…${text.slice(-keep)}`;
    }

    _getPlanConnectionLabel(reference, kind, target) {
        const fileName = target?.data?.filePath
            ? this._fileNameFromPath(target.data.filePath)
            : (reference?.name || this._fileNameFromPath(reference?.filePath) || '未命名素材');
        return `${kind === 'output' ? '输出' : '参考'} · ${this._truncateMiddle(fileName, 26)}`;
    }

    _getPlanRowConnectionTitle(plan, rowId) {
        const row = (plan?.rows || []).find(entry => entry.id === rowId);
        if (!row) return '未命名规划行';
        const title = row.cells?.title || row.cells?.stage || row.cells?.content || '';
        return this._truncateMiddle(title || '未命名规划行', 32);
    }

    _drawPlanConnectionBadge(group, x, y, count, kind = 'source') {
        if (!count) return;
        const text = count > 9 ? '9+' : String(count);
        const isOutput = kind === 'output';
        const width = text.length > 1 ? 22 : 18;
        const badgeX = isOutput ? x + 6 : x - width - 6;
        const badgeY = y - PLAN_HANDLE_RADIUS - PLAN_CONNECTION_BADGE_HEIGHT + 3;
        const stroke = isOutput ? 'rgba(236,238,241,0.52)' : 'rgba(210,213,218,0.5)';
        const fill = isOutput ? '#102536' : '#141a24';
        const textFill = isOutput ? '#d6f6ff' : '#c9ddff';

        group.add(new Konva.Rect({
            x: badgeX,
            y: badgeY,
            width,
            height: PLAN_CONNECTION_BADGE_HEIGHT,
            fill,
            stroke,
            strokeWidth: 1,
            cornerRadius: PLAN_CONNECTION_BADGE_HEIGHT / 2,
            shadowColor: isOutput ? PLAN_OUTPUT_CONNECTION_COLOR : PLAN_SOURCE_CONNECTION_COLOR,
            shadowBlur: 8,
            shadowOpacity: 0.16,
            listening: false,
            perfectDrawEnabled: false
        }));
        group.add(new Konva.Text({
            x: badgeX,
            y: badgeY + 4,
            width,
            height: 10,
            text,
            fill: textFill,
            fontSize: 8,
            fontStyle: 'bold',
            align: 'center',
            listening: false
        }));
    }

    _ensurePlanConnectionHint() {
        if (this.connectionHintGroup && !this.connectionHintGroup.isDestroyed()) {
            return this.connectionHintGroup;
        }
        const group = new Konva.Group({
            name: 'planConnectionHint',
            listening: false,
            visible: false
        });
        group.add(new Konva.Rect({
            name: 'planConnectionHintBg',
            height: PLAN_CONNECTION_HINT_HEIGHT,
            fill: 'rgba(11, 19, 34, 0.95)',
            stroke: 'rgba(210, 213, 218, 0.38)',
            strokeWidth: 1,
            cornerRadius: PLAN_CONNECTION_HINT_HEIGHT / 2,
            shadowColor: PLAN_SOURCE_CONNECTION_COLOR,
            shadowBlur: 14,
            shadowOpacity: 0.18,
            perfectDrawEnabled: false
        }));
        group.add(new Konva.Text({
            name: 'planConnectionHintText',
            x: 10,
            y: 7,
            height: 10,
            fill: '#dce9ff',
            fontSize: 10,
            fontStyle: 'bold',
            listening: false
        }));
        this.layer.add(group);
        this.connectionHintGroup = group;
        return group;
    }

    _showPlanConnectionHint(x, y, text) {
        const hint = this._ensurePlanConnectionHint();
        const width = Math.min(260, Math.max(148, this._estimateTextWidth(text) + 24));
        hint.findOne('.planConnectionHintBg')?.width(width);
        hint.findOne('.planConnectionHintText')?.width(width - 20);
        hint.findOne('.planConnectionHintText')?.text(text);
        hint.position({ x: x + 12, y: y - PLAN_CONNECTION_HINT_HEIGHT - 12 });
        hint.visible(true);
        hint.moveToTop();
        this.layer.batchDraw();
    }

    _hidePlanConnectionHint() {
        if (!this.connectionHintGroup) return;
        this.connectionHintGroup.visible(false);
        this.layer.batchDraw();
    }

    _getPlanReferenceSnapshot(reference = {}, kind = '') {
        return {
            itemId: reference.itemId || '',
            filePath: reference.filePath || '',
            name: reference.name || '',
            kind: kind || reference.kind || reference.role || ''
        };
    }

    _isPlanConnectionSelected(planId, rowId, reference, kind = 'source') {
        const selected = this._selectedPlanConnection;
        return Boolean(
            selected
            && selected.planId === planId
            && selected.rowId === rowId
            && selected.kind === kind
            && this._samePlanReference(selected.reference, reference, kind)
        );
    }

    _isPlanRowConnectionSelected(planId, rowId) {
        const selected = this._selectedPlanConnection;
        return Boolean(selected && selected.planId === planId && selected.rowId === rowId);
    }

    _selectPlanConnection(planId, rowId, reference, kind = 'source', target = null) {
        this._selectedPlanConnection = {
            planId,
            rowId,
            kind,
            reference: this._getPlanReferenceSnapshot(reference, kind)
        };
        const didRefresh = this._setHoveredConnection(planId, rowId, target);
        if (target?.data?.id) {
            this._setItemReferenceHighlight(target.data.id, true, { mode: 'connection' });
        }
        if (!didRefresh) this._refreshConnectionInteractionState();
    }

    _removeSelectedPlanConnection() {
        const selected = this._selectedPlanConnection;
        if (!selected) return false;
        return this._removePlanRowReference(selected.planId, selected.rowId, selected.reference, selected.kind);
    }

    _focusCanvasEntry(entry, { scale = null } = {}) {
        if (!entry?.group) return;
        const node = entry.group.findOne('.displayNode')
            || entry.group.findOne('.fallbackBg')
            || entry.group.findOne('.fallbackIcon')
            || entry.group.findOne('.planHitArea');
        const rect = node?.getClientRect({ relativeTo: this.layer });
        const center = rect
            ? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
            : { x: entry.group.x(), y: entry.group.y() };
        const container = this.stage.container();
        const nextScale = scale || Math.max(0.28, Math.min(1.25, this.stage.scaleX()));
        this.stage.to({
            x: container.offsetWidth / 2 - center.x * nextScale,
            y: container.offsetHeight / 2 - center.y * nextScale,
            scaleX: nextScale,
            scaleY: nextScale,
            duration: 0.18,
            easing: Konva.Easings.EaseOut
        });
        this.emit('change');
    }

    _focusPlanConnectionRow(planId, rowId) {
        const planEntry = this.plans.get(planId);
        if (!planEntry) return;
        const selectedConnection = this._selectedPlanConnection;
        this.selectItem(planId, false);
        this._selectedPlanConnection = selectedConnection;
        this._setHoveredPlanRow(planId, rowId);
        this._focusCanvasEntry(planEntry);
        requestAnimationFrame(() => this.focusPlanInlineEditor(planId));
        this._refreshConnectionInteractionState();
        this._showCanvasStatus('已定位到规划行');
    }

    _focusPlanConnectionTarget(target) {
        if (!target?.data?.id) return;
        const selectedConnection = this._selectedPlanConnection;
        this.selectItem(target.data.id, false);
        this._selectedPlanConnection = selectedConnection;
        this._setHoveredReferenceItem(target.data.id, target.data.filePath);
        this._focusCanvasEntry(target);
        this._refreshConnectionInteractionState();
        this._showCanvasStatus('已定位到连接素材');
    }

    _drawPlanConnectionToolbar(group, labelWidth, visual, options = {}) {
        if (!visual.selected) return;
        const actions = [
            { label: '定位行', action: () => this._focusPlanConnectionRow(options.plan.id, options.rowId) },
            options.target ? { label: '素材', action: () => this._focusPlanConnectionTarget(options.target) } : null,
            {
                label: '断开',
                danger: true,
                action: () => this._removePlanRowReference(options.plan.id, options.rowId, options.reference, options.kind)
            }
        ].filter(Boolean);
        const gap = 4;
        const widths = actions.map(action => Math.max(36, this._estimateTextWidth(action.label) + 18));
        const toolbarWidth = Math.min(
            labelWidth,
            widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1)
        );
        const toolbarX = options.toolbarX ?? 0;
        const toolbarRight = toolbarX + labelWidth;
        let cursorX = toolbarX + Math.max(0, (labelWidth - toolbarWidth) / 2);
        const toolbarY = options.toolbarY ?? PLAN_CONNECTION_LABEL_HEIGHT + 5;

        actions.forEach((action, index) => {
            const buttonWidth = Math.min(widths[index], toolbarRight - cursorX);
            const buttonGroup = new Konva.Group({
                x: cursorX,
                y: toolbarY,
                name: 'planConnectionToolbarButton',
                listening: true
            });
            buttonGroup.add(new Konva.Rect({
                width: buttonWidth,
                height: PLAN_CONNECTION_TOOLBAR_HEIGHT,
                fill: action.danger ? 'rgba(84, 31, 37, 0.94)' : 'rgba(13, 18, 30, 0.94)',
                stroke: action.danger ? 'rgba(255, 130, 130, 0.38)' : 'rgba(255, 209, 102, 0.34)',
                strokeWidth: 1,
                cornerRadius: 7,
                shadowColor: action.danger ? '#ff8d8d' : visual.stroke,
                shadowBlur: 10,
                shadowOpacity: 0.14,
                perfectDrawEnabled: false
            }));
            buttonGroup.add(new Konva.Text({
                x: 0,
                y: 6,
                width: buttonWidth,
                text: action.label,
                fill: action.danger ? '#ffd0d0' : '#ffe6a3',
                fontSize: 10,
                fontStyle: 'bold',
                align: 'center',
                listening: false
            }));
            buttonGroup.on('mouseenter', () => {
                document.body.style.cursor = 'pointer';
                this._setHoveredConnection(options.plan.id, options.rowId, options.target);
            });
            buttonGroup.on('mouseleave', () => {
                document.body.style.cursor = 'default';
                this._clearHoveredConnection(options.target);
            });
            buttonGroup.on('click tap', e => {
                e.cancelBubble = true;
                action.action();
            });
            group.add(buttonGroup);
            cursorX += buttonWidth + gap;
        });
    }

    _drawSelectedPlanConnectionCard(group, anchor, visual, labelText, options = {}) {
        const isOutput = options.kind === 'output';
        const cardWidth = PLAN_CONNECTION_FOCUS_CARD_WIDTH;
        const cardHeight = PLAN_CONNECTION_FOCUS_CARD_HEIGHT;
        const planWidth = options.plan?.width || options.plan?.node?.width || PLAN_NODE_WIDTH;
        const planHeight = options.plan?.height || options.plan?.node?.height || PLAN_NODE_HEIGHT;
        const cardX = Math.max(PLAN_HANDLE_X - 18, Math.min(planWidth - cardWidth + 18, anchor.x - cardWidth / 2));
        const cardY = Math.max(-cardHeight - 14, Math.min(planHeight - cardHeight + 14, anchor.y - cardHeight - 16 + (options.labelOffset || 0)));
        const targetName = options.target?.data?.filePath
            ? this._fileNameFromPath(options.target.data.filePath)
            : (options.reference?.name || this._fileNameFromPath(options.reference?.filePath) || '未命名素材');
        const rowTitle = this._getPlanRowConnectionTitle(options.plan, options.rowId);
        const directionText = isOutput ? '规划行  →  输出素材' : '参考素材  →  规划行';
        const typeText = isOutput ? '输出链路' : '参考链路';
        const typeWidth = Math.max(76, this._estimateTextWidth(typeText) + 22);
        const card = new Konva.Group({
            x: cardX,
            y: cardY,
            name: 'planConnectionFocusCard',
            listening: true
        });

        card.add(new Konva.Rect({
            width: cardWidth,
            height: cardHeight,
            fill: isOutput ? 'rgba(9, 30, 42, 0.97)' : 'rgba(17, 20, 32, 0.97)',
            stroke: visual.stroke,
            strokeWidth: 1.35,
            cornerRadius: 14,
            shadowColor: visual.stroke,
            shadowBlur: 22,
            shadowOpacity: 0.24,
            perfectDrawEnabled: false
        }));
        card.add(new Konva.Rect({
            x: 10,
            y: 10,
            width: typeWidth,
            height: 20,
            fill: isOutput ? 'rgba(255, 255, 255, 0.09)' : 'rgba(255, 255, 255, 0.07)',
            stroke: isOutput ? 'rgba(236, 238, 241, 0.34)' : 'rgba(210, 213, 218, 0.3)',
            strokeWidth: 1,
            cornerRadius: 10,
            listening: false,
            perfectDrawEnabled: false
        }));
        card.add(new Konva.Text({
            x: 21,
            y: 15,
            text: typeText,
            fill: isOutput ? '#d8f8ff' : '#dce9ff',
            fontSize: 10,
            fontStyle: 'bold',
            listening: false
        }));
        card.add(new Konva.Text({
            x: 10 + typeWidth + 12,
            y: 15,
            width: cardWidth - typeWidth - 34,
            text: directionText,
            fill: '#f7d990',
            fontSize: 10,
            fontStyle: 'bold',
            ellipsis: true,
            listening: false
        }));
        card.add(new Konva.Text({
            x: 12,
            y: 38,
            width: cardWidth - 24,
            text: labelText,
            fill: '#fff2c6',
            fontSize: 12,
            fontStyle: 'bold',
            ellipsis: true,
            listening: false
        }));
        card.add(new Konva.Text({
            x: 12,
            y: 56,
            width: cardWidth - 24,
            text: `${rowTitle} · ${this._truncateMiddle(targetName, 28)}`,
            fill: 'rgba(226, 232, 240, 0.76)',
            fontSize: 10,
            ellipsis: true,
            listening: false
        }));
        this._drawPlanConnectionToolbar(card, cardWidth - 24, visual, {
            ...options,
            toolbarX: 12,
            toolbarY: 66
        });

        card.on('mouseenter', () => {
            document.body.style.cursor = 'pointer';
            this._setHoveredConnection(options.plan.id, options.rowId, options.target);
        });
        card.on('mouseleave', () => {
            document.body.style.cursor = 'default';
            this._clearHoveredConnection(options.target);
        });
        card.on('click tap', e => {
            e.cancelBubble = true;
            this.selectItem(options.plan.id, false);
            this._selectPlanConnection(options.plan.id, options.rowId, options.reference, options.kind, options.target);
        });

        group.add(card);
    }

    _drawPlanConnectionLabel(group, points, visual, labelText, options = {}) {
        const anchor = this._getBezierPoint(points, options.labelT ?? 0.52);
        if (visual.selected) {
            this._drawSelectedPlanConnectionCard(group, anchor, visual, labelText, options);
            return;
        }
        const actionText = 'Del 断开';
        const actionWidth = visual.selected ? Math.max(48, this._estimateTextWidth(actionText) + 16) : 0;
        const removeButtonWidth = 26;
        const labelPadding = visual.selected ? 52 + actionWidth : 42;
        const labelWidth = Math.min(
            visual.selected ? PLAN_CONNECTION_SELECTED_LABEL_MAX_WIDTH : PLAN_CONNECTION_LABEL_MAX_WIDTH,
            Math.max(88, this._estimateTextWidth(labelText) + labelPadding)
        );
        const labelX = anchor.x - labelWidth / 2;
        const labelY = anchor.y - PLAN_CONNECTION_LABEL_HEIGHT - 10 + (options.labelOffset || 0);
        const isOutput = options.kind === 'output';
        const actionX = labelWidth - removeButtonWidth - actionWidth - 4;
        const textWidth = visual.selected
            ? Math.max(42, actionX - 14)
            : labelWidth - 34;
        const labelGroup = new Konva.Group({
            x: labelX,
            y: labelY,
            name: 'planConnectionLabel',
            listening: true
        });

        labelGroup.add(new Konva.Rect({
            width: labelWidth,
            height: PLAN_CONNECTION_LABEL_HEIGHT,
            fill: visual.selected
                ? 'rgba(48, 37, 12, 0.96)'
                : (isOutput ? 'rgba(8, 35, 48, 0.94)' : 'rgba(11, 19, 34, 0.94)'),
            stroke: visual.stroke,
            strokeWidth: visual.selected ? 1.4 : 1,
            cornerRadius: PLAN_CONNECTION_LABEL_HEIGHT / 2,
            shadowColor: visual.stroke,
            shadowBlur: visual.selected ? 18 : 12,
            shadowOpacity: visual.selected ? 0.3 : 0.16,
            perfectDrawEnabled: false
        }));
        labelGroup.add(new Konva.Text({
            x: 10,
            y: 6,
            width: textWidth,
            text: labelText,
            fill: visual.selected ? '#fff2c6' : (isOutput ? '#e8fbff' : '#eaf2ff'),
            fontSize: 10,
            fontStyle: 'bold',
            ellipsis: true,
            listening: false
        }));

        if (visual.selected) {
            labelGroup.add(new Konva.Rect({
                x: actionX,
                y: 4,
                width: actionWidth,
                height: 16,
                fill: 'rgba(255, 209, 102, 0.14)',
                stroke: 'rgba(255, 209, 102, 0.38)',
                strokeWidth: 1,
                cornerRadius: 8,
                listening: false,
                perfectDrawEnabled: false
            }));
            labelGroup.add(new Konva.Text({
                x: actionX,
                y: 6,
                width: actionWidth,
                text: actionText,
                fill: '#ffe6a3',
                fontSize: 9,
                fontStyle: 'bold',
                align: 'center',
                listening: false
            }));
        }

        const removeGroup = new Konva.Group({
            x: labelWidth - 22,
            y: 5,
            name: 'planConnectionLabelRemove',
            listening: true
        });
        removeGroup.add(new Konva.Circle({
            x: 7,
            y: 7,
            radius: 7,
            fill: 'rgba(255, 255, 255, 0.08)',
            stroke: 'rgba(255, 255, 255, 0.12)',
            strokeWidth: 1,
            perfectDrawEnabled: false
        }));
        removeGroup.add(new Konva.Text({
            x: 3,
            y: 0,
            width: 8,
            height: 14,
            text: '×',
            fill: '#ffd6d6',
            fontSize: 11,
            align: 'center',
            listening: false
        }));
        removeGroup.on('mouseenter', () => {
            document.body.style.cursor = 'pointer';
        });
        removeGroup.on('click tap', e => {
            e.cancelBubble = true;
            this._removePlanRowReference(options.plan.id, options.rowId, options.reference, options.kind);
        });
        labelGroup.add(removeGroup);
        this._drawPlanConnectionToolbar(labelGroup, labelWidth, visual, options);

        labelGroup.on('mouseenter', () => {
            document.body.style.cursor = 'pointer';
            this._setHoveredConnection(options.plan.id, options.rowId, options.target);
        });
        labelGroup.on('mouseleave', () => {
            document.body.style.cursor = 'default';
            this._clearHoveredConnection(options.target);
        });
        labelGroup.on('click tap', e => {
            e.cancelBubble = true;
            this.selectItem(options.plan.id, false);
            this._selectPlanConnection(options.plan.id, options.rowId, options.reference, options.kind, options.target);
            this._showCanvasStatus('已选中连接线，可定位素材或按 Delete 断开');
        });

        group.add(labelGroup);
    }

    _drawConnectionEndpoint(group, x, y, visual, isOutput) {
        if (visual.selected) {
            group.add(new Konva.Circle({
                x,
                y,
                radius: visual.endpointRadius + 6,
                fill: 'rgba(255, 209, 102, 0.08)',
                stroke: 'rgba(255, 209, 102, 0.76)',
                strokeWidth: 1.4,
                listening: false,
                perfectDrawEnabled: false
            }));
        }
        group.add(new Konva.Circle({
            x,
            y,
            radius: visual.endpointRadius + 3,
            fill: visual.halo,
            opacity: visual.haloOpacity,
            listening: false,
            perfectDrawEnabled: false
        }));
        group.add(new Konva.Circle({
            x,
            y,
            radius: visual.endpointRadius,
            fill: '#0c111b',
            stroke: visual.stroke,
            strokeWidth: isOutput ? 2 : 1.6,
            opacity: visual.dimmed ? visual.opacity : Math.min(1, visual.opacity + 0.08),
            listening: false,
            perfectDrawEnabled: false
        }));
        group.add(new Konva.Circle({
            x,
            y,
            radius: Math.max(1.7, visual.endpointRadius - 2.4),
            fill: visual.stroke,
            opacity: visual.dimmed ? Math.min(0.2, visual.opacity + 0.02) : Math.min(1, visual.opacity + 0.12),
            listening: false,
            perfectDrawEnabled: false
        }));
    }

    _drawConnectionPortFocus(group, x, y, visual, isOutput) {
        if (visual.dimmed) return;
        group.add(new Konva.Circle({
            x,
            y,
            radius: PLAN_HANDLE_RADIUS + (visual.selected ? 8 : 6),
            fill: isOutput ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.06)',
            stroke: visual.stroke,
            strokeWidth: visual.selected ? 1.5 : 1.1,
            opacity: visual.selected ? 0.78 : 0.52,
            listening: false,
            perfectDrawEnabled: false
        }));
        group.add(new Konva.Circle({
            x,
            y,
            radius: PLAN_HANDLE_RADIUS + 2,
            fill: '#0c111b',
            stroke: visual.stroke,
            strokeWidth: visual.selected ? 2.2 : 1.6,
            opacity: visual.selected ? 0.96 : 0.74,
            listening: false,
            perfectDrawEnabled: false
        }));
    }

    _drawConnectionArrow(group, points, visual) {
        const endX = points[6];
        const endY = points[7];
        const angle = Math.atan2(endY - points[5], endX - points[4]);
        const arrowSize = 9;
        group.add(new Konva.Line({
            points: [
                endX,
                endY,
                endX - Math.cos(angle - 0.42) * arrowSize,
                endY - Math.sin(angle - 0.42) * arrowSize,
                endX,
                endY,
                endX - Math.cos(angle + 0.42) * arrowSize,
                endY - Math.sin(angle + 0.42) * arrowSize
            ],
            stroke: visual.stroke,
            strokeWidth: Math.max(2, visual.strokeWidth - 0.4),
            opacity: visual.opacity,
            lineCap: 'round',
            lineJoin: 'round',
            listening: false,
            perfectDrawEnabled: false
        }));
    }

    _drawConnectionStartArrow(group, points, visual) {
        const startX = points[0];
        const startY = points[1];
        const controlX = points[2];
        const controlY = points[3];
        const angle = Math.atan2(startY - controlY, startX - controlX);
        const arrowSize = visual.selected ? 8.5 : 7.5;
        group.add(new Konva.Line({
            points: [
                startX,
                startY,
                startX - Math.cos(angle - 0.42) * arrowSize,
                startY - Math.sin(angle - 0.42) * arrowSize,
                startX,
                startY,
                startX - Math.cos(angle + 0.42) * arrowSize,
                startY - Math.sin(angle + 0.42) * arrowSize
            ],
            stroke: visual.stroke,
            strokeWidth: Math.max(1.8, visual.strokeWidth - 0.6),
            opacity: visual.dimmed ? visual.opacity : Math.min(1, visual.opacity + 0.08),
            lineCap: 'round',
            lineJoin: 'round',
            listening: false,
            perfectDrawEnabled: false
        }));
    }

    _drawConnectionFlowMarkers(group, points, visual, isOutput) {
        if (visual.dimmed) return;
        const markerTs = visual.selected ? [0.38, 0.58] : [0.52];
        markerTs.forEach(t => {
            const point = this._getBezierPoint(points, t);
            const tangent = this._getBezierTangent(points, t);
            const angle = Math.atan2(tangent.y, tangent.x) * 180 / Math.PI;
            const marker = new Konva.Group({
                x: point.x,
                y: point.y,
                rotation: isOutput ? angle : angle + 180,
                listening: false
            });
            marker.add(new Konva.Line({
                points: [-7, -4, 0, 0, -7, 4],
                stroke: visual.stroke,
                strokeWidth: visual.selected ? 2.2 : 1.8,
                opacity: visual.selected ? 0.95 : 0.78,
                lineCap: 'round',
                lineJoin: 'round',
                perfectDrawEnabled: false
            }));
            marker.add(new Konva.Circle({
                x: -10,
                y: 0,
                radius: visual.selected ? 2.2 : 1.7,
                fill: visual.stroke,
                opacity: visual.selected ? 0.72 : 0.45,
                perfectDrawEnabled: false
            }));
            group.add(marker);
        });
    }

    _drawPlanConnectionLine(group, plan, anchorY, reference, options = {}) {
        if (!options.visible) return;
        const target = this._findItemForReference(reference);
        if (!target) return;
        const isOutput = options.kind === 'output';
        const startX = isOutput ? (plan.width + PLAN_OUTPUT_HANDLE_X_OFFSET) : PLAN_HANDLE_X;
        const startY = anchorY;
        const targetPoint = this._getConnectionPointForItem(target, {
            x: plan.x + startX,
            y: plan.y + startY
        });
        if (!targetPoint) return;

        const endX = targetPoint.x - plan.x;
        const endY = targetPoint.y - plan.y;
        const connectionKind = options.kind || 'source';
        const selected = this._isPlanConnectionSelected(plan.id, options.rowId, reference, connectionKind);
        const emphasized = selected || this._isPlanConnectionEmphasized(plan.id, options.rowId, reference);
        const dimmed = this._isPlanConnectionDimmed(plan.id, options.rowId, reference, selected, emphasized);
        const visual = this._getPlanConnectionVisual(connectionKind, emphasized, selected, dimmed);
        const routeOffset = this._getConnectionFanoutOffset(options.connectionIndex, options.connectionTotal);
        const points = this._getConnectionCurvePoints(startX, startY, endX, endY, routeOffset);
        const labelT = 0.52 + Math.max(-0.08, Math.min(0.08, routeOffset / 180));
        const labelOffset = routeOffset * 0.45;
        const connectionLabel = this._getPlanConnectionLabel(reference, connectionKind, target);

        group.add(new Konva.Line({
            points,
            tension: 0,
            bezier: true,
            stroke: visual.halo,
            strokeWidth: visual.strokeWidth + 6,
            opacity: visual.haloOpacity,
            lineCap: 'round',
            lineJoin: 'round',
            listening: false,
            perfectDrawEnabled: false
        }));

        group.add(new Konva.Line({
            points,
            tension: 0,
            bezier: true,
            stroke: visual.stroke,
            strokeWidth: visual.strokeWidth,
            opacity: visual.opacity,
            dash: emphasized ? [] : visual.dash,
            lineCap: 'round',
            lineJoin: 'round',
            listening: false,
            perfectDrawEnabled: false
        }));

        if (emphasized) {
            this._drawConnectionPortFocus(group, startX, startY, visual, isOutput);
            this._drawConnectionFlowMarkers(group, points, visual, isOutput);
        }

        const hitLine = new Konva.Line({
            points,
            tension: 0,
            bezier: true,
            stroke: 'rgba(255,255,255,0.001)',
            strokeWidth: Math.max(16, visual.strokeWidth + 12),
            lineCap: 'round',
            lineJoin: 'round',
            name: 'planConnectionHit',
            listening: true,
            planId: plan.id,
            rowId: options.rowId
        });
        hitLine.on('mouseenter', () => {
            document.body.style.cursor = 'pointer';
            this._setHoveredConnection(plan.id, options.rowId, target);
            this._showCanvasStatus(`${connectionLabel} · 单击选中，Delete 删除，右键更多`, 2800);
        });
        hitLine.on('mouseleave', () => {
            document.body.style.cursor = 'default';
            this._clearHoveredConnection(target);
        });
        hitLine.on('click tap', e => {
            e.cancelBubble = true;
            this.selectItem(plan.id, false);
            this._selectPlanConnection(plan.id, options.rowId, reference, connectionKind, target);
            this._showCanvasStatus('已选中连接线，可定位素材或按 Delete 断开');
        });
        hitLine.on('dblclick dbltap', e => {
            e.cancelBubble = true;
            this._removePlanRowReference(plan.id, options.rowId, reference, connectionKind);
        });
        hitLine.on('contextmenu', e => {
            e.cancelBubble = true;
            e.evt.preventDefault();
            this.selectItem(plan.id, false);
            this._selectPlanConnection(plan.id, options.rowId, reference, connectionKind, target);
            this._showPlanConnectionMenu(e, {
                plan,
                rowId: options.rowId,
                reference,
                kind: connectionKind,
                target
            });
        });
        group.add(hitLine);

        this._drawConnectionEndpoint(group, endX, endY, visual, isOutput);

        if (isOutput) {
            this._drawConnectionArrow(group, points, visual);
        } else {
            this._drawConnectionStartArrow(group, points, visual);
        }

        if (emphasized) {
            this._drawPlanConnectionLabel(
                group,
                points,
                visual,
                connectionLabel,
                {
                    plan,
                    rowId: options.rowId,
                    reference,
                    kind: connectionKind,
                    target,
                    labelT,
                    labelOffset
                }
            );
        }
    }

    _showPlanContextMenu(e, plan) {
        e.evt.preventDefault();
        this._removePlanContextMenu();

        const menu = document.createElement('div');
        menu.className = 'plan-context-menu';
        const items = [
            { label: '聚焦规划表', action: () => this.focusPlanInlineEditor(plan.id) },
            { label: '复制为 Markdown', action: () => this.copyPlanAsMarkdown(plan.id) },
            { label: '删除规划表', danger: true, action: () => this._removeSelectedPlansFromContext() }
        ];

        items.forEach(item => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `plan-context-item ${item.danger ? 'danger' : ''}`;
            button.textContent = item.label;
            button.addEventListener('click', () => {
                this._removePlanContextMenu();
                item.action();
            });
            menu.appendChild(button);
        });

        menu.style.left = `${e.evt.clientX}px`;
        menu.style.top = `${e.evt.clientY}px`;
        document.body.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 10}px`;
        if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 10}px`;

        setTimeout(() => {
            const close = (event) => {
                if (!menu.contains(event.target)) {
                    this._removePlanContextMenu();
                    document.removeEventListener('mousedown', close);
                }
            };
            document.addEventListener('mousedown', close);
        }, 0);
    }

    _showPlanConnectionMenu(e, { plan, rowId, reference, kind, target }) {
        e.evt.preventDefault();
        this._removePlanContextMenu();

        const isOutput = kind === 'output';
        const targetName = target?.data?.filePath
            ? this._fileNameFromPath(target.data.filePath)
            : (reference?.name || '连接素材');
        const menu = document.createElement('div');
        menu.className = 'plan-context-menu plan-connection-menu';
        const items = [
            {
                label: '定位规划行',
                action: () => {
                    this.selectItem(plan.id, false);
                    this._setHoveredPlanRow(plan.id, rowId);
                    this.focusPlanInlineEditor(plan.id);
                }
            },
            target ? {
                label: `选中素材：${targetName}`,
                action: () => {
                    this.selectItem(target.data.id, false);
                    this._setHoveredReferenceItem(target.data.id, target.data.filePath);
                }
            } : null,
            {
                label: isOutput ? '断开这条输出线' : '断开这条参考线',
                danger: true,
                action: () => this._removePlanRowReference(plan.id, rowId, reference, kind)
            }
        ].filter(Boolean);

        items.forEach(item => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `plan-context-item ${item.danger ? 'danger' : ''}`;
            button.textContent = item.label;
            button.addEventListener('click', () => {
                this._removePlanContextMenu();
                item.action();
            });
            menu.appendChild(button);
        });

        menu.style.left = `${e.evt.clientX}px`;
        menu.style.top = `${e.evt.clientY}px`;
        document.body.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 10}px`;
        if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 10}px`;

        setTimeout(() => {
            const close = (event) => {
                if (!menu.contains(event.target)) {
                    this._removePlanContextMenu();
                    document.removeEventListener('mousedown', close);
                }
            };
            document.addEventListener('mousedown', close);
        }, 0);
    }

    _removePlanContextMenu() {
        document.querySelectorAll('.plan-context-menu').forEach(menu => menu.remove());
    }

    _removeSelectedPlansFromContext() {
        const planIds = [...this.selectedItems].filter(id => this.plans.has(id));
        if (planIds.length === 0) return;
        document.dispatchEvent(new CustomEvent('context-remove', { detail: { planIds } }));
    }

    _getPlanTableMetrics(plan) {
        const rawWidth = plan.node?.width || plan.width || PLAN_NODE_WIDTH;
        const rowCount = Math.max(1, plan.rows?.length || 1);
        const width = rawWidth;
        const columns = plan.columns || [];
        const tableX = 0;
        const tableY = 0;
        const headerHeight = PLAN_HEADER_ROW_HEIGHT;
        const availableWidth = width;
        const totalColumnWidth = columns.reduce((sum, column) => sum + (column.width || 120), 0) || availableWidth;
        const scale = availableWidth / totalColumnWidth;
        const colWidths = columns.map(column => Math.max(78, (column.width || 120) * scale));
        const rows = Array.isArray(plan.rows) && plan.rows.length > 0
            ? plan.rows
            : [{ cells: {}, references: [] }];
        const rowHeights = rows
            .slice(0, rowCount)
            .map(row => this._measurePlanRowHeight(row, columns, colWidths));
        while (rowHeights.length < rowCount) rowHeights.push(PLAN_ROW_HEIGHT);
        const rowTops = [];
        let cursorY = headerHeight;
        rowHeights.forEach(rowHeight => {
            rowTops.push(cursorY);
            cursorY += rowHeight;
        });
        const height = cursorY;
        const maxRows = rowCount;
        return { width, height, tableX, tableY, headerHeight, colWidths, rowHeights, rowTops, maxRows };
    }

    _measurePlanRowHeight(row, columns, colWidths) {
        if (!columns.length) return PLAN_ROW_HEIGHT;
        const contentHeight = columns.reduce((maxHeight, column, columnIndex) => {
            const text = column.key === 'assets'
                ? this._formatPlanAssetCell(row)
                : (row?.cells?.[column.key] || '');
            const rightInset = columnIndex === columns.length - 1 ? PLAN_LAST_CELL_TOOLBAR_SPACE : 0;
            return Math.max(
                maxHeight,
                this._measurePlanCellHeight(text, colWidths[columnIndex] || 120, rightInset)
            );
        }, PLAN_ROW_HEIGHT);
        return Math.max(
            PLAN_ROW_HEIGHT,
            Math.ceil(contentHeight + PLAN_CELL_HEIGHT_ALLOWANCE)
        );
    }

    _measurePlanCellHeight(value, columnWidth, rightInset = 0) {
        if (typeof document !== 'undefined') {
            const textarea = this._getPlanMeasureTextarea();
            if (textarea) {
                textarea.style.width = `${Math.max(40, columnWidth)}px`;
                textarea.style.padding = `8px ${8 + rightInset}px 8px 8px`;
                textarea.value = String(value ?? '') || ' ';
                textarea.style.height = '0px';
                return textarea.scrollHeight;
            }
        }
        return PLAN_CELL_VERTICAL_PADDING
            + this._measureWrappedLineCount(value, Math.max(40, columnWidth - rightInset))
            * PLAN_CELL_LINE_HEIGHT;
    }

    _getPlanMeasureTextarea() {
        if (this._planMeasureTextarea?.isConnected) return this._planMeasureTextarea;
        if (typeof document === 'undefined' || !document.body) return null;
        const textarea = document.createElement('textarea');
        textarea.tabIndex = -1;
        textarea.setAttribute('aria-hidden', 'true');
        textarea.rows = 1;
        textarea.wrap = 'soft';
        Object.assign(textarea.style, {
            position: 'fixed',
            left: '-10000px',
            top: '-10000px',
            zIndex: '-1',
            visibility: 'hidden',
            pointerEvents: 'none',
            boxSizing: 'border-box',
            border: '0',
            outline: '0',
            resize: 'none',
            overflow: 'hidden',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'break-word',
            wordBreak: 'break-word',
            background: 'transparent',
            fontSize: '11px',
            fontFamily: 'inherit',
            lineHeight: '1.35'
        });
        document.body.appendChild(textarea);
        this._planMeasureTextarea = textarea;
        return textarea;
    }

    _measureWrappedLineCount(value, columnWidth) {
        const text = String(value ?? '');
        if (!text) return 1;
        const innerWidth = Math.max(24, columnWidth - 16);
        return text.split(/\r?\n/).reduce((lineCount, segment) => {
            const visualWidth = this._estimateTextWidth(segment);
            return lineCount + Math.max(1, Math.ceil(visualWidth / innerWidth));
        }, 0);
    }

    _estimateTextWidth(text) {
        let width = 0;
        String(text || '').split('').forEach(char => {
            if (/[\u2e80-\uffff]/.test(char)) width += 11;
            else if (/\s/.test(char)) width += 4;
            else if (/[A-Z0-9]/.test(char)) width += 7;
            else width += 6;
        });
        return width;
    }

    _planRowKey(planId, rowId) {
        return `${planId}:${rowId}`;
    }

    _isPlanRowActive(planId, rowId) {
        return this._hoveredPlanRowKey === this._planRowKey(planId, rowId);
    }

    _setHoveredPlanRow(planId, rowId) {
        const key = planId && rowId ? this._planRowKey(planId, rowId) : null;
        if (this._hoveredPlanRowKey === key) return;
        this._hoveredPlanRowKey = key;
        this._refreshConnectionInteractionState();
    }

    _mountPlanInlineEditor(plan) {
        if (!this.planInlineLayer || !plan) return;
        this._removePlanInlineEditor(plan.id);

        const metrics = this._getPlanTableMetrics(plan);
        const wrapper = document.createElement('div');
        wrapper.className = 'plan-inline-editor';
        wrapper.dataset.planId = plan.id;
        wrapper.addEventListener('mouseenter', () => {
            if (this._hoveredPlanId !== plan.id) {
                this._hoveredPlanId = plan.id;
                this._refreshConnectionInteractionState();
            }
        });
        wrapper.addEventListener('mouseleave', () => {
            if (this._hoveredPlanId === plan.id) {
                this._hoveredPlanId = null;
                this._refreshConnectionInteractionState();
            }
            if (this._hoveredPlanRowKey?.startsWith(`${plan.id}:`)) {
                this._hoveredPlanRowKey = null;
                this._refreshConnectionInteractionState();
            }
        });
        wrapper.addEventListener('pointermove', event => {
            if (!this._activePlanReferencePick) return;
            event.stopPropagation();
            this._updatePlanReferencePickPreview(null, event);
        }, true);
        wrapper.addEventListener('mousedown', event => {
            if (this._activePlanReferencePick && !event.target?.closest?.('.plan-row-tool-connect')) {
                event.preventDefault();
                event.stopPropagation();
                this._cancelPlanReferencePick('已取消连接参考图');
                return;
            }
            if (event.button === 1) {
                if (this._inlineMiddlePointerHandled) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                if (document.activeElement?.blur) document.activeElement.blur();
                this._startCanvasPanFromClientPoint(event, { passthroughElement: wrapper });
                return;
            }
            if (this._shouldStartInlinePlanDrag(event)) {
                this._startInlinePlanDrag(plan.id, event);
                return;
            }
            event.stopPropagation();
        }, true);
        wrapper.addEventListener('click', event => event.stopPropagation());
        wrapper.addEventListener('dblclick', event => event.stopPropagation());
        wrapper.addEventListener('contextmenu', event => {
            event.preventDefault();
            event.stopPropagation();
            this.selectItem(plan.id, false);
            this._showPlanContextMenu({ evt: event, cancelBubble: false }, plan);
        });
        wrapper.addEventListener('mouseup', event => {
            if (event.button === 1) {
                event.preventDefault();
            }
        }, true);
        wrapper.addEventListener('auxclick', event => {
            if (event.button === 1) {
                event.preventDefault();
                event.stopPropagation();
                if (document.activeElement?.blur) document.activeElement.blur();
            }
        }, true);
        wrapper.addEventListener('wheel', event => {
            event.stopPropagation();
            this._zoomCanvasAtClientPoint(event);
        }, { passive: false });

        const table = document.createElement('table');
        table.className = 'plan-inline-table';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        (plan.columns || []).forEach((column, columnIndex) => {
            const th = document.createElement('th');
            th.style.width = `${metrics.colWidths[columnIndex]}px`;
            th.textContent = column.label;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        const actions = document.createElement('div');
        actions.className = 'plan-inline-actions';
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'plan-inline-add';
        addBtn.title = '添加行';
        addBtn.textContent = '+';
        addBtn.style.top = '2px';
        addBtn.addEventListener('click', () => this._addInlinePlanRow(plan.id));
        actions.appendChild(addBtn);
        (plan.rows || []).slice(0, metrics.maxRows).forEach((row, rowIndex) => {
            const rowHeight = metrics.rowHeights[rowIndex] || PLAN_ROW_HEIGHT;
            const sourceCount = this._getSourcePlanRowReferences(row).length;
            const outputCount = this._getOutputPlanRowReferences(row).length;
            const sourceCountLabel = sourceCount > 9 ? '9+' : String(sourceCount);
            const outputCountLabel = outputCount > 9 ? '9+' : String(outputCount);
            const tr = document.createElement('tr');
            tr.dataset.rowId = row.id;
            tr.style.height = `${rowHeight}px`;
            if (sourceCount > 0) tr.classList.add('has-source-connections');
            if (outputCount > 0) tr.classList.add('has-output-connections');
            const isPickingReferenceForRow = this._isPlanReferencePickRow(plan.id, row.id);
            if (this._isInlinePlanRowReferenceActive(plan.id, row)) {
                tr.classList.add('is-reference-active');
            }
            tr.addEventListener('mouseenter', () => this._setHoveredPlanRow(plan.id, row.id));
            (plan.columns || []).forEach((column, columnIndex) => {
                const td = document.createElement('td');
                td.style.width = `${metrics.colWidths[columnIndex]}px`;
                td.style.height = `${rowHeight}px`;
                td.dataset.columnKey = column.key;
                if (columnIndex === 0) {
                    td.classList.add('plan-row-source-cell');
                    if (sourceCount > 0) td.dataset.sourceCount = sourceCountLabel;
                }
                if (columnIndex === (plan.columns || []).length - 1) {
                    td.classList.add('plan-row-output-cell');
                    if (outputCount > 0) td.dataset.outputCount = outputCountLabel;
                }
                if (column.key === 'status') {
                    const select = document.createElement('select');
                    select.dataset.rowId = row.id;
                    select.dataset.columnKey = column.key;
                    select.style.minHeight = `${rowHeight}px`;
                    select.style.height = `${rowHeight}px`;
                    select.value = row.cells?.[column.key] || '未开始';
                    DEFAULT_STATUS_OPTIONS.forEach(status => {
                        const option = document.createElement('option');
                        option.value = status;
                        option.textContent = status;
                        select.appendChild(option);
                    });
                    select.addEventListener('change', () => {
                        this._updateInlinePlanCell(plan.id, row.id, column.key, select.value);
                    });
                    td.appendChild(select);
                } else {
                    const textarea = document.createElement('textarea');
                    textarea.dataset.rowId = row.id;
                    textarea.dataset.columnKey = column.key;
                    textarea.value = column.key === 'assets'
                        ? this._formatPlanAssetCell(row)
                        : (row.cells?.[column.key] || '');
                    textarea.rows = 1;
                    textarea.style.minHeight = `${rowHeight}px`;
                    textarea.style.height = `${rowHeight}px`;
                    textarea.spellcheck = false;
                    textarea.addEventListener('input', () => {
                        this._updateInlinePlanCell(plan.id, row.id, column.key, textarea.value);
                    });
                    textarea.addEventListener('keydown', event => {
                        if (event.key === 'Tab') {
                            event.preventDefault();
                            this._focusAdjacentPlanCell(wrapper, textarea, event.shiftKey ? -1 : 1);
                        }
                    });
                    td.appendChild(textarea);
                }
                tr.appendChild(td);
            });
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'plan-inline-delete';
            deleteBtn.title = '删除行';
            deleteBtn.textContent = '×';
            deleteBtn.style.top = `${(metrics.rowTops[rowIndex] || metrics.headerHeight) + Math.max(0, (rowHeight - 24) / 2)}px`;
            deleteBtn.addEventListener('click', () => this._deleteInlinePlanRow(plan.id, row.id));
            actions.appendChild(deleteBtn);
            const toolbar = document.createElement('div');
            toolbar.className = 'plan-row-toolbar';
            tr.addEventListener('mouseleave', () => toolbar.classList.remove('is-dismissed'));
            const addTool = (className, title, text, handler) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `plan-row-tool ${className}`;
                button.title = title;
                button.textContent = text;
                button.addEventListener('click', event => {
                    event.preventDefault();
                    event.stopPropagation();
                    toolbar.classList.add('is-dismissed');
                    handler();
                });
                toolbar.appendChild(button);
                return button;
            };
            const connectTool = addTool('plan-row-tool-connect', '点选素材作为参考图', '↙', () => this._startPlanReferencePick(plan.id, row.id));
            if (isPickingReferenceForRow) connectTool.classList.add('is-connecting');
            addTool('plan-row-tool-generate', '按本行内容生成结果图', '↗', () => this._generateOutputForPlanRow(plan.id, row.id));
            addTool('plan-row-tool-add', '添加行', '+', () => this._addInlinePlanRow(plan.id));
            addTool('plan-row-tool-delete', '删除行', 'x', () => this._deleteInlinePlanRow(plan.id, row.id));
            const lastCell = tr.lastElementChild;
            if (lastCell) {
                lastCell.classList.add('plan-inline-last-cell');
                lastCell.appendChild(toolbar);
            }
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrapper.appendChild(table);
        wrapper.appendChild(actions);
        this.planInlineLayer.appendChild(wrapper);
        this.planInlineEditors.set(plan.id, wrapper);
        this._positionPlanInlineEditor(plan.id);
    }

    _removePlanInlineEditor(planId) {
        const editor = this.planInlineEditors?.get(planId);
        if (editor) editor.remove();
        this.planInlineEditors?.delete(planId);
        clearTimeout(this._inlinePlanChangeTimers?.get(planId));
        this._inlinePlanChangeTimers?.delete(planId);
    }

    _removeAllPlanInlineEditors() {
        this.planInlineEditors?.forEach(editor => editor.remove());
        this.planInlineEditors?.clear();
        this._inlinePlanChangeTimers?.forEach(timer => clearTimeout(timer));
        this._inlinePlanChangeTimers?.clear();
    }

    _positionPlanInlineEditor(planId) {
        const entry = this.plans.get(planId);
        const editor = this.planInlineEditors.get(planId);
        if (!entry || !editor) return;
        const plan = entry.data;
        const metrics = this._getPlanTableMetrics(plan);
        const stageScale = this.stage.scaleX();
        const stagePos = this.stage.position();
        const x = entry.group.x() * stageScale + stagePos.x;
        const y = entry.group.y() * stageScale + stagePos.y;
        const width = metrics.colWidths.reduce((sum, colWidth) => sum + colWidth, 0);
        editor.style.transform = `translate(${x}px, ${y}px) scale(${stageScale})`;
        editor.style.width = `${width}px`;
        editor.style.height = `${metrics.height}px`;
    }

    syncPlanInlineEditors() {
        this.planInlineEditors?.forEach((_, planId) => this._positionPlanInlineEditor(planId));
        this.graphView?.sync();
    }

    focusPlanInlineEditor(planId) {
        const editor = this.planInlineEditors.get(planId);
        if (!editor) return;
        const focusable = editor.querySelector('textarea, select');
        focusable?.focus();
        if (focusable?.select) focusable.select();
    }

    _focusAdjacentPlanCell(wrapper, current, offset) {
        const fields = Array.from(wrapper.querySelectorAll('textarea, select'));
        const index = fields.indexOf(current);
        const next = fields[index + offset];
        if (next) {
            next.focus();
            if (next.select) next.select();
        }
    }

    _getStagePointerFromClient(clientX, clientY) {
        const rect = this.stage.container().getBoundingClientRect();
        return {
            x: clientX - rect.left,
            y: clientY - rect.top
        };
    }

    _getCanvasPointFromClient(clientX, clientY) {
        const pointer = this._getStagePointerFromClient(clientX, clientY);
        return {
            x: (pointer.x - this.stage.x()) / this.stage.scaleX(),
            y: (pointer.y - this.stage.y()) / this.stage.scaleY()
        };
    }

    _zoomCanvasAtClientPoint(event) {
        event.preventDefault();
        const delta = normalizeWheelDelta(event, this.stage.height());
        if (!delta) return;

        const hasClientPoint = Number.isFinite(Number(event.clientX)) && Number.isFinite(Number(event.clientY));
        const pointer = hasClientPoint
            ? this._getStagePointerFromClient(Number(event.clientX), Number(event.clientY))
            : this.stage.getPointerPosition();
        if (!pointer) return;

        this._wheelZoomDelta += delta;
        this._wheelZoomPointer = { x: pointer.x, y: pointer.y };
        if (this._wheelZoomFrame) return;

        this._wheelZoomFrame = requestAnimationFrame(() => {
            this._wheelZoomFrame = 0;
            const accumulatedDelta = this._wheelZoomDelta;
            const zoomPointer = this._wheelZoomPointer;
            this._wheelZoomDelta = 0;
            this._wheelZoomPointer = null;
            if (!zoomPointer || !accumulatedDelta) return;

            const viewport = zoomViewportAtPoint({
                x: this.stage.x(),
                y: this.stage.y(),
                scale: this.stage.scaleX()
            }, zoomPointer, wheelZoomFactor(accumulatedDelta));
            this.stage.scale({ x: viewport.scale, y: viewport.scale });
            this.stage.position({ x: viewport.x, y: viewport.y });
            this.stage.batchDraw();
            this.emit('change');
        });
    }

    _startCanvasPanFromClientPoint(event, options = {}) {
        if (this._activeCanvasPanStop) {
            this._activeCanvasPanStop();
        }
        event.preventDefault();
        event.stopPropagation();
        let last = this._getStagePointerFromClient(event.clientX, event.clientY);
        const passthroughElement = options.passthroughElement || null;
        const pointerCaptureElement = options.pointerCaptureElement || null;
        const pointerId = options.pointerId;
        const previousPointerEvents = passthroughElement?.style?.pointerEvents;
        if (pointerCaptureElement && pointerId != null && pointerCaptureElement.setPointerCapture) {
            try { pointerCaptureElement.setPointerCapture(pointerId); } catch (_) { }
        }
        if (passthroughElement) passthroughElement.classList.add('is-canvas-panning');
        document.body.style.cursor = 'grabbing';
        this.stage.draggable(false);
        this._forEachNode(item => {
            item.group.draggable(false);
            item.group.find?.('.planRowHandle').forEach(handle => handle.draggable(false));
        });
        let lastMoveStamp = null;

        const move = (moveEvent) => {
            moveEvent.preventDefault();
            const stamp = `${moveEvent.timeStamp}:${moveEvent.clientX}:${moveEvent.clientY}`;
            if (stamp === lastMoveStamp) return;
            lastMoveStamp = stamp;
            const next = this._getStagePointerFromClient(moveEvent.clientX, moveEvent.clientY);
            this.stage.position({
                x: this.stage.x() + next.x - last.x,
                y: this.stage.y() + next.y - last.y
            });
            last = next;
            this.stage.batchDraw();
            this.syncPlanInlineEditors();
            this.syncGifs();
        };

        const stop = (stopEvent = null) => {
            if (this._activeCanvasPanStop !== stop) return;
            stopEvent?.preventDefault?.();
            stopEvent?.stopPropagation?.();
            this._activeCanvasPanStop = null;
            document.body.style.cursor = 'default';
            if (passthroughElement) {
                passthroughElement.style.pointerEvents = previousPointerEvents || '';
                passthroughElement.classList.remove('is-canvas-panning');
            }
            if (pointerCaptureElement && pointerId != null && pointerCaptureElement.releasePointerCapture) {
                try { pointerCaptureElement.releasePointerCapture(pointerId); } catch (_) { }
            }
            this.stage.draggable(true);
            this._forEachNode(item => {
                item.group.draggable(true);
                item.group.find?.('.planRowHandle').forEach(handle => handle.draggable(true));
            });
            document.removeEventListener('mousemove', move, true);
            document.removeEventListener('pointermove', move, true);
            document.removeEventListener('mouseup', stop, true);
            document.removeEventListener('pointerup', stop, true);
            document.removeEventListener('pointercancel', stop, true);
            pointerCaptureElement?.removeEventListener?.('pointermove', move, true);
            pointerCaptureElement?.removeEventListener?.('pointerup', stop, true);
            pointerCaptureElement?.removeEventListener?.('pointercancel', stop, true);
            pointerCaptureElement?.removeEventListener?.('lostpointercapture', stop, true);
            window.removeEventListener('blur', stop);
            this.emit('change');
        };

        this._activeCanvasPanStop = stop;
        document.addEventListener('mousemove', move, true);
        document.addEventListener('pointermove', move, true);
        document.addEventListener('mouseup', stop, true);
        document.addEventListener('pointerup', stop, true);
        document.addEventListener('pointercancel', stop, true);
        pointerCaptureElement?.addEventListener?.('pointermove', move, true);
        pointerCaptureElement?.addEventListener?.('pointerup', stop, true);
        pointerCaptureElement?.addEventListener?.('pointercancel', stop, true);
        pointerCaptureElement?.addEventListener?.('lostpointercapture', stop, true);
        window.addEventListener('blur', stop);
    }

    _shouldStartInlinePlanDrag(event) {
        if (event.button !== 0) return false;
        return !!event.target.closest('th') && !event.target.closest('button, textarea, select, input');
    }

    _startInlinePlanDrag(planId, event) {
        if (this._activeInlinePlanDragStop) {
            this._activeInlinePlanDragStop();
        }
        const entry = this.plans.get(planId);
        if (!entry) return;
        event.preventDefault();
        event.stopPropagation();
        this.selectItem(planId, false);

        const scale = this.stage.scaleX();
        const startClientX = event.clientX;
        const startClientY = event.clientY;
        const startX = entry.group.x();
        const startY = entry.group.y();
        let lastMoveStamp = null;
        document.body.style.cursor = 'grabbing';

        const move = (moveEvent) => {
            moveEvent.preventDefault();
            moveEvent.stopPropagation();
            const stamp = `${moveEvent.timeStamp}:${moveEvent.clientX}:${moveEvent.clientY}`;
            if (stamp === lastMoveStamp) return;
            lastMoveStamp = stamp;
            const nextX = startX + (moveEvent.clientX - startClientX) / scale;
            const nextY = startY + (moveEvent.clientY - startClientY) / scale;
            entry.group.position({ x: nextX, y: nextY });
            this._setEntryNodePosition(entry, nextX, nextY);
            this._scheduleDragConnectionRefresh(entry);
        };

        const stop = () => {
            if (this._activeInlinePlanDragStop !== stop) return;
            this._activeInlinePlanDragStop = null;
            document.body.style.cursor = 'default';
            document.removeEventListener('mousemove', move, true);
            document.removeEventListener('pointermove', move, true);
            document.removeEventListener('mouseup', stop, true);
            document.removeEventListener('pointerup', stop, true);
            document.removeEventListener('pointercancel', stop, true);
            window.removeEventListener('blur', stop);
            this._flushDragConnectionRefresh();
            this._refreshVisiblePlanConnections();
            this.emit('plansChanged');
            this.emit('change');
        };

        this._activeInlinePlanDragStop = stop;
        document.addEventListener('mousemove', move, true);
        document.addEventListener('pointermove', move, true);
        document.addEventListener('mouseup', stop, true);
        document.addEventListener('pointerup', stop, true);
        document.addEventListener('pointercancel', stop, true);
        window.addEventListener('blur', stop);
    }

    _updateInlinePlanCell(planId, rowId, columnKey, value) {
        const plan = this.planService?.getPlan?.(planId);
        const row = plan?.rows?.find(entry => entry.id === rowId);
        if (!plan || !row) return;

        const beforeHeight = this._getPlanTableMetrics(plan).height;
        row.cells[columnKey] = String(value ?? '');
        let shouldRefreshNode = false;
        if (columnKey === 'assets' && row.references?.length) {
            row.references = [];
            shouldRefreshNode = true;
        }
        this.planService.updatePlan(planId, { rows: plan.rows });
        const afterHeight = this._getPlanTableMetrics(plan).height;
        if (shouldRefreshNode || Math.abs(afterHeight - beforeHeight) > 0.5) {
            this.refreshPlanNode(planId, { preserveInlineFocus: true });
        }
        this.emit('plansChanged');
        this.emit('change');
        clearTimeout(this._inlinePlanChangeTimers.get(planId));
        this._inlinePlanChangeTimers.set(planId, setTimeout(() => {
            this._showCanvasStatus('规划表已保存');
        }, 500));
    }

    _addInlinePlanRow(planId) {
        const plan = this.planService?.getPlan?.(planId);
        if (!plan) return;
        const rows = [...(plan.rows || []), this.planService.createRow(plan.rows?.length || 0)];
        this.planService.updatePlan(planId, { rows });
        this.refreshPlanNode(planId);
        this.emit('plansChanged');
        this.emit('change');
        this._showCanvasStatus('已添加行');
    }

    _deleteInlinePlanRow(planId, rowId) {
        const plan = this.planService?.getPlan?.(planId);
        if (!plan) return;
        const rows = (plan.rows || []).filter(row => row.id !== rowId);
        if (rows.length === 0) rows.push(this.planService.createRow(0));
        this.planService.updatePlan(planId, { rows });
        this.refreshPlanNode(planId);
        this.emit('plansChanged');
        this.emit('change');
        this._showCanvasStatus('已删除行');
    }

    _formatPlanAssetCell(row) {
        const referenceNames = this._getSourcePlanRowReferences(row)
            .map(reference => reference.name || this._fileNameFromPath(reference.filePath))
            .filter(Boolean);
        const text = row.cells?.assets || '';
        if (referenceNames.length === 0) return text;
        const referenceText = referenceNames.map(name => `● ${name}`).join('\n');
        return text ? `${referenceText}\n${text}` : referenceText;
    }

    _fileNameFromPath(filePath) {
        return String(filePath || '').split(/[/\\]/).pop() || '';
    }

    _isInternalProcessFile(filePath) {
        const name = this._fileNameFromPath(filePath).toLowerCase();
        return INTERNAL_PROCESS_FILE_PREFIXES.some(prefix => name.startsWith(prefix));
    }

    _isInternalProcessReference(reference) {
        return this._isInternalProcessFile(reference?.filePath || reference?.name || '');
    }

    _getPlanReferenceKind(reference) {
        if (reference?.kind === 'output' || reference?.role === 'output' || reference?.generated === true) return 'output';
        if (reference?.kind === 'source' || reference?.role === 'source') return 'source';
        if (this._isInternalProcessReference(reference)) return 'process';
        const name = this._fileNameFromPath(reference?.filePath || reference?.name || '').toLowerCase();
        if (name.startsWith('flow_imagegen_') || name.startsWith('ai_')) return 'output';
        return 'source';
    }

    _getVisiblePlanRowReferences(row) {
        return (row?.references || []).filter(reference => this._getPlanReferenceKind(reference) !== 'process');
    }

    _getSourcePlanRowReferences(row) {
        return this._getVisiblePlanRowReferences(row)
            .filter(reference => this._getPlanReferenceKind(reference) !== 'output');
    }

    _getOutputPlanRowReferences(row) {
        return this._getVisiblePlanRowReferences(row)
            .filter(reference => this._getPlanReferenceKind(reference) === 'output');
    }

    _referenceMatchesItem(reference, itemId, filePath) {
        if (!reference) return false;
        return Boolean(
            (itemId && reference.itemId === itemId)
            || (filePath && reference.filePath === filePath)
        );
    }

    _isHoveredReferenceItem(itemId, filePath) {
        const hovered = this._hoveredReferenceItem;
        if (!hovered) return false;
        return (itemId && hovered.itemId === itemId)
            || (filePath && hovered.filePath === filePath);
    }

    _referenceMatchesHoveredItem(reference) {
        const hovered = this._hoveredReferenceItem;
        if (!hovered) return false;
        return this._referenceMatchesItem(reference, hovered.itemId, hovered.filePath);
    }

    _rowReferencesHoveredItem(row) {
        return this._getVisiblePlanRowReferences(row)
            .some(reference => this._referenceMatchesHoveredItem(reference));
    }

    _isInlinePlanRowReferenceActive(planId, row) {
        return this._isPlanRowActive(planId, row?.id)
            || this._isPlanRowConnectionSelected(planId, row?.id)
            || this._rowReferencesHoveredItem(row)
            || this._isPlanReferencePickRow(planId, row?.id);
    }

    _syncPlanInlineActiveRows() {
        this.planInlineEditors?.forEach((wrapper, planId) => {
            const plan = this.planService?.getPlan?.(planId);
            if (!plan || !wrapper?.isConnected) return;
            (plan.rows || []).forEach(row => {
                const tr = wrapper.querySelector(`tr[data-row-id="${CSS.escape(row.id)}"]`);
                tr?.classList.toggle('is-reference-active', this._isInlinePlanRowReferenceActive(planId, row));
            });
        });
    }

    _countPlanReferencesToItem(itemId, filePath) {
        let count = 0;
        this.planService?.listPlans?.().forEach(plan => {
            (plan.rows || []).forEach(row => {
                this._getVisiblePlanRowReferences(row).forEach(reference => {
                    if (this._referenceMatchesItem(reference, itemId, filePath)) count += 1;
                });
            });
        });
        return count;
    }

    _setHoveredReferenceItem(itemId, filePath) {
        const next = itemId || filePath ? { itemId, filePath } : null;
        const current = this._hoveredReferenceItem;
        if (
            (!next && !current)
            || (next && current && next.itemId === current.itemId && next.filePath === current.filePath)
        ) {
            return;
        }
        this._hoveredReferenceItem = next;
        this._refreshConnectionInteractionState();
    }

    _setHoveredConnection(planId, rowId, target = null) {
        const rowKey = planId && rowId ? this._planRowKey(planId, rowId) : null;
        const targetId = target?.data?.id || null;
        if (this._hoveredConnectionTargetId && this._hoveredConnectionTargetId !== targetId) {
            this._setItemReferenceHighlight(this._hoveredConnectionTargetId, false);
        }
        const nextReferenceItem = target?.data
            ? { itemId: target.data.id, filePath: target.data.filePath }
            : null;
        const current = this._hoveredReferenceItem;
        const sameReferenceItem = (!nextReferenceItem && !current)
            || (
                nextReferenceItem
                && current
                && nextReferenceItem.itemId === current.itemId
                && nextReferenceItem.filePath === current.filePath
            );
        const changed = this._hoveredPlanRowKey !== rowKey || !sameReferenceItem;
        this._hoveredPlanRowKey = rowKey;
        this._hoveredReferenceItem = nextReferenceItem;
        if (changed) this._refreshConnectionInteractionState();
        this._hoveredConnectionTargetId = targetId;
        if (targetId) {
            this._setItemReferenceHighlight(targetId, true, { mode: 'connection' });
        }
        return changed;
    }

    _clearHoveredConnection(target = null) {
        const targetId = target?.data?.id || this._hoveredConnectionTargetId;
        const selected = this._selectedPlanConnection;
        const targetBelongsToSelected = Boolean(
            selected
            && target?.data
            && this._samePlanReference(selected.reference, {
                itemId: target.data.id,
                filePath: target.data.filePath,
                name: target.data.name
            }, selected.kind)
        );
        if (targetId && !this._activePlanReferencePick && !targetBelongsToSelected) {
            this._setItemReferenceHighlight(targetId, false);
        }
        if (targetBelongsToSelected && selected) {
            this._hoveredConnectionTargetId = targetId;
            this._hoveredReferenceItem = target?.data
                ? { itemId: target.data.id, filePath: target.data.filePath }
                : this._hoveredReferenceItem;
            this._hoveredPlanRowKey = this._planRowKey(selected.planId, selected.rowId);
            this._refreshConnectionInteractionState();
            return;
        }
        this._hoveredConnectionTargetId = null;
        this._hoveredReferenceItem = null;
        this._setHoveredPlanRow(null, null);
    }

    _shouldShowPlanSourceConnections(planId, rowId, row = null) {
        if (this.referenceDropTargetId) return true;
        if (row && this._rowReferencesHoveredItem(row)) return true;
        return this._isPlanRowActive(planId, rowId)
            || this._isPlanRowConnectionSelected(planId, rowId)
            || (this._hoveredPlanId === planId && this.isAltPressed)
            || this.selectedItems.has(planId);
    }

    _shouldShowPlanOutputConnections(planId, rowId, row = null) {
        if (row && this._rowReferencesHoveredItem(row)) return true;
        return this._isPlanRowActive(planId, rowId)
            || this._isPlanRowConnectionSelected(planId, rowId)
            || (this._hoveredPlanId === planId && this.isAltPressed)
            || this.selectedItems.has(planId);
    }

    _findItemAtStagePoint(point, excludeIds = new Set()) {
        if (!point) return null;
        let matched = null;
        this.items.forEach((entry, id) => {
            if (matched || excludeIds.has(id) || !entry.group?.isVisible()) return;
            const rect = this._getEntryContentRect(entry);
            if (!rect) return;
            if (
                point.x >= rect.x &&
                point.x <= rect.x + rect.width &&
                point.y >= rect.y &&
                point.y <= rect.y + rect.height
            ) {
                matched = entry;
            }
        });
        return matched;
    }

    _findItemForReference(reference) {
        if (!reference) return null;
        if (reference.itemId && this.items.has(reference.itemId)) {
            return this.items.get(reference.itemId);
        }
        for (const item of this.items.values()) {
            if (item.data.filePath === reference.filePath) return item;
        }
        return null;
    }

    _getEntryContentRect(entry) {
        const node = entry?.group?.findOne('.displayNode') || entry?.group?.findOne('.fallbackBg');
        if (!node) return null;
        return node.getClientRect({
            relativeTo: this.layer,
            skipStroke: true,
            skipShadow: true
        });
    }

    _getItemCenter(entry) {
        const rect = this._getEntryContentRect(entry);
        if (!rect) return null;
        return {
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2
        };
    }

    _getConnectionPointForItem(entry, fromPoint) {
        const rect = this._getEntryContentRect(entry);
        if (!rect || !fromPoint) return this._getItemCenter(entry);
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const dx = fromPoint.x - cx;
        const dy = fromPoint.y - cy;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx === 0 && absDy === 0) return { x: cx, y: cy };
        const halfW = rect.width / 2;
        const halfH = rect.height / 2;
        const scale = Math.min(
            absDx > 0 ? halfW / absDx : Infinity,
            absDy > 0 ? halfH / absDy : Infinity
        );
        return {
            x: cx + dx * scale,
            y: cy + dy * scale
        };
    }

    _refreshVisiblePlanConnections() {
        if (this.plans.size === 0) return;
        const selected = new Set(this.selectedItems);
        const focusSnapshots = Array.from(this.plans.keys())
            .map(planId => this._capturePlanInlineFocus(planId))
            .filter(Boolean);
        this.renderPlans();
        this.selectedItems = selected;
        this._updateSelectionVisuals();
        focusSnapshots.forEach(snapshot => {
            requestAnimationFrame(() => this._restorePlanInlineFocus(snapshot));
        });
    }

    _refreshPlanConnectionGraphicsOnly() {
        if (this.plans.size === 0) return;
        const selected = new Set(this.selectedItems);
        const plans = this.planService?.listPlans?.() || [];
        plans.forEach(plan => {
            const entry = this.plans.get(plan.id);
            if (!entry?.group) {
                this._createPlanNode(plan, { mountInlineEditor: false });
                return;
            }
            const node = plan.node || {};
            const metrics = this._getPlanTableMetrics({ ...plan, node });
            const width = metrics.width;
            const height = metrics.height;
            plan.x = node.x || 0;
            plan.y = node.y || 0;
            plan.width = width;
            plan.height = height;
            plan.node = { ...node, width, height };
            entry.data = plan;
            entry.group.position({ x: plan.x, y: plan.y });
            this._drawPlanPreview(entry.group, plan, width, height);
        });
        this.plans.forEach((entry, planId) => {
            if (!plans.some(plan => plan.id === planId)) {
                entry.group?.destroy();
                this.plans.delete(planId);
            }
        });
        this.selectedItems = selected;
        this._applyPlanFilterVisibility();
        this._updateSelectionVisuals();
        this.layer.batchDraw();
    }

    _refreshConnectionInteractionState() {
        if (this._isDraggingPlanReference) {
            this._syncPlanInlineActiveRows();
            return;
        }
        this._refreshPlanConnectionGraphicsOnly();
        this._syncPlanInlineActiveRows();
    }

    _canRefreshConnectionsDuringDrag(movingEntry) {
        return Boolean(movingEntry && this.plans.size > 0);
    }

    _scheduleDragConnectionRefresh(movingEntry) {
        if (!this._canRefreshConnectionsDuringDrag(movingEntry)) return;
        if (this._dragConnectionRefreshTimer) return;
        this._dragConnectionRefreshTimer = requestAnimationFrame(() => {
            this._dragConnectionRefreshTimer = null;
            this._lastDragConnectionRefreshAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
            this._refreshPlanConnectionGraphicsOnly();
        });
    }

    _flushDragConnectionRefresh() {
        if (this._dragConnectionRefreshTimer) {
            cancelAnimationFrame(this._dragConnectionRefreshTimer);
            this._dragConnectionRefreshTimer = null;
        }
    }

    _isPlanReferencePickRow(planId, rowId) {
        const pick = this._activePlanReferencePick;
        return Boolean(pick && pick.planId === planId && pick.rowId === rowId);
    }

    _getPlanRowConnectionAnchor(planId, rowId) {
        const plan = this.planService?.getPlan?.(planId);
        if (!plan) return null;
        const rowIndex = (plan.rows || []).findIndex(row => row.id === rowId);
        if (rowIndex < 0) return null;
        const metrics = this._getPlanTableMetrics(plan);
        const rowTop = metrics.rowTops[rowIndex] ?? (PLAN_HEADER_ROW_HEIGHT + rowIndex * PLAN_ROW_HEIGHT);
        const rowHeight = metrics.rowHeights[rowIndex] || PLAN_ROW_HEIGHT;
        return {
            x: (plan.x || 0) + PLAN_HANDLE_X,
            y: (plan.y || 0) + rowTop + rowHeight / 2
        };
    }

    _startPlanReferencePick(planId, rowId) {
        if (this._isPlanReferencePickRow(planId, rowId)) {
            this._cancelPlanReferencePick('已取消连接参考图');
            return;
        }
        const anchor = this._getPlanRowConnectionAnchor(planId, rowId);
        if (!anchor) return;
        this._clearReferenceDropHighlights();
        this._activePlanReferencePick = { planId, rowId };
        this._hoveredPlanRowKey = this._planRowKey(planId, rowId);
        this._refreshConnectionInteractionState();
        this._updatePlanReferencePickPreview(null);
        document.body.style.cursor = 'crosshair';
        this._showCanvasStatus('连接模式：移动到素材预览，点击素材建立/取消参考，Esc 取消', 3600);
    }

    _updatePlanReferencePickPreview(target = null, event = null) {
        const pick = this._activePlanReferencePick;
        if (!pick) return;
        const anchor = this._getPlanRowConnectionAnchor(pick.planId, pick.rowId);
        if (!anchor) return;

        const pointer = this.stage.getPointerPosition();
        const pointerAtCanvas = event?.clientX != null
            ? this._getCanvasPointFromClient(event.clientX, event.clientY)
            : pointer
            ? {
                x: (pointer.x - this.stage.x()) / this.stage.scaleX(),
                y: (pointer.y - this.stage.y()) / this.stage.scaleY()
            }
            : anchor;
        const end = target
            ? this._getConnectionPointForItem(target, anchor)
            : pointerAtCanvas;
        if (!end) return;

        const points = this._getConnectionCurvePoints(anchor.x, anchor.y, end.x, end.y);
        const preview = this._ensurePlanReferencePreview();
        preview.findOne('.previewHalo')?.points(points);
        preview.findOne('.previewLine')?.points(points);
        const dot = preview.findOne('.previewDot');
        if (dot) {
            dot.position({ x: end.x, y: end.y });
            dot.radius(target ? 6.5 : 4.5);
            dot.stroke(target ? '#5ff1b3' : PLAN_CONNECTION_PREVIEW_COLOR);
        }
        this._updatePlanReferencePreviewLabel(preview, end, target);
        preview.moveToTop();
        this.layer.batchDraw();
    }

    _clearReferenceDropHighlights() {
        Array.from(this._referenceHighlightIds || []).forEach(itemId => this._setItemReferenceHighlight(itemId, false));
        this.referenceDropTargetId = null;
    }

    _clearPlanConnectionFocusState({ clearHighlights = true } = {}) {
        this._hoveredConnectionTargetId = null;
        this._hoveredReferenceItem = null;
        this._hoveredPlanRowKey = null;
        if (clearHighlights) this._clearReferenceDropHighlights();
    }

    _cancelPlanReferencePick(message = '', options = {}) {
        if (!this._activePlanReferencePick) return;
        this._activePlanReferencePick = null;
        this._planReferencePickTargetId = null;
        this._hidePlanConnectionHint();
        this._clearReferenceDropHighlights();
        this._stopPlanReferenceDrag();
        if (options.refresh === false) {
            this._hoveredPlanRowKey = null;
        } else {
            this._setHoveredPlanRow(null, null);
        }
        document.body.style.cursor = 'default';
        if (message) this._showCanvasStatus(message);
    }

    _finishPlanReferencePick(itemEntry) {
        const pick = this._activePlanReferencePick;
        if (!pick || !itemEntry) return;
        this._activePlanReferencePick = null;
        this._planReferencePickTargetId = null;
        this._clearReferenceDropHighlights();
        this._stopPlanReferenceDrag();
        this._togglePlanRowReference(pick.planId, pick.rowId, itemEntry);
        this._setHoveredReferenceItem(itemEntry.data.id, itemEntry.data.filePath);
        document.body.style.cursor = 'default';
    }

    _startPlanReferenceDrag(handle) {
        this._isDraggingPlanReference = true;
        const origin = handle.getAbsolutePosition(this.layer);
        handle.setAttr('dragOriginX', origin.x);
        handle.setAttr('dragOriginY', origin.y);
        this._showCanvasStatus('拖到素材卡片上松开，即可建立或取消参考连接');
        this._updatePlanReferenceDragPreview(handle, null);
    }

    _getPlanReferencePreviewText(target = null) {
        if (!target?.data?.filePath) return '选择素材 · Esc 取消';
        return `点击连接：${this._truncateMiddle(this._fileNameFromPath(target.data.filePath), 24)}`;
    }

    _updatePlanReferencePreviewLabel(preview, end, target = null) {
        const labelGroup = preview?.findOne('.previewLabel');
        const labelBg = preview?.findOne('.previewLabelBg');
        const labelText = preview?.findOne('.previewLabelText');
        if (!labelGroup || !labelBg || !labelText || !end) return;

        const text = this._getPlanReferencePreviewText(target);
        const width = Math.min(
            PLAN_CONNECTION_PREVIEW_LABEL_MAX_WIDTH,
            Math.max(112, this._estimateTextWidth(text) + 28)
        );
        const x = end.x + 12;
        const y = end.y - PLAN_CONNECTION_PREVIEW_LABEL_HEIGHT - 14;

        labelGroup.position({ x, y });
        labelBg.width(width);
        labelText.width(width - 18);
        labelText.text(text);
        labelBg.fill(target ? 'rgba(8, 39, 30, 0.94)' : 'rgba(12, 17, 27, 0.92)');
        labelBg.stroke(target ? '#5ff1b3' : 'rgba(52, 211, 153, 0.42)');
        labelText.fill(target ? '#ddfff2' : '#b8f7d9');
        labelGroup.visible(true);
    }

    _ensurePlanReferencePreview() {
        if (this.connectionPreviewGroup && !this.connectionPreviewGroup.isDestroyed()) {
            return this.connectionPreviewGroup;
        }

        const group = new Konva.Group({
            name: 'connectionPreview',
            listening: false
        });
        group.add(new Konva.Line({
            name: 'previewHalo',
            points: [],
            tension: 0,
            bezier: true,
            stroke: 'rgba(52, 211, 153, 0.2)',
            strokeWidth: 11,
            lineCap: 'round',
            lineJoin: 'round',
            perfectDrawEnabled: false
        }));
        group.add(new Konva.Line({
            name: 'previewLine',
            points: [],
            tension: 0,
            bezier: true,
            stroke: PLAN_CONNECTION_PREVIEW_COLOR,
            strokeWidth: 2.8,
            dash: [10, 8],
            lineCap: 'round',
            lineJoin: 'round',
            perfectDrawEnabled: false
        }));
        group.add(new Konva.Circle({
            name: 'previewDot',
            x: 0,
            y: 0,
            radius: 5,
            fill: '#0c111b',
            stroke: PLAN_CONNECTION_PREVIEW_COLOR,
            strokeWidth: 2,
            perfectDrawEnabled: false
        }));
        const labelGroup = new Konva.Group({
            name: 'previewLabel',
            visible: false,
            listening: false
        });
        labelGroup.add(new Konva.Rect({
            name: 'previewLabelBg',
            width: 112,
            height: PLAN_CONNECTION_PREVIEW_LABEL_HEIGHT,
            fill: 'rgba(12, 17, 27, 0.92)',
            stroke: 'rgba(52, 211, 153, 0.42)',
            strokeWidth: 1,
            cornerRadius: PLAN_CONNECTION_PREVIEW_LABEL_HEIGHT / 2,
            shadowColor: PLAN_CONNECTION_PREVIEW_COLOR,
            shadowBlur: 12,
            shadowOpacity: 0.18,
            perfectDrawEnabled: false
        }));
        labelGroup.add(new Konva.Text({
            name: 'previewLabelText',
            x: 9,
            y: 7,
            width: 94,
            text: '选择素材 · Esc 取消',
            fill: '#b8f7d9',
            fontSize: 10,
            fontStyle: 'bold',
            listening: false
        }));
        group.add(labelGroup);

        this.layer.add(group);
        this.connectionPreviewGroup = group;
        return group;
    }

    _updatePlanReferenceDragPreview(handle, target = null) {
        const originX = handle.getAttr('dragOriginX');
        const originY = handle.getAttr('dragOriginY');
        if (!Number.isFinite(originX) || !Number.isFinite(originY)) return;

        const pointer = handle.getAbsolutePosition(this.layer);
        const end = target
            ? this._getConnectionPointForItem(target, { x: originX, y: originY })
            : pointer;
        if (!end) return;

        const points = this._getConnectionCurvePoints(originX, originY, end.x, end.y);
        const preview = this._ensurePlanReferencePreview();
        preview.findOne('.previewHalo')?.points(points);
        preview.findOne('.previewLine')?.points(points);
        const dot = preview.findOne('.previewDot');
        if (dot) {
            dot.position({ x: end.x, y: end.y });
            dot.radius(target ? 6.5 : 4.5);
            dot.stroke(target ? '#5ff1b3' : PLAN_CONNECTION_PREVIEW_COLOR);
        }
        this._updatePlanReferencePreviewLabel(preview, end, target);
        preview.moveToTop();
        this.layer.batchDraw();
    }

    _stopPlanReferenceDrag() {
        this._isDraggingPlanReference = false;
        this._hidePlanConnectionHint();
        if (this.connectionPreviewGroup) {
            this.connectionPreviewGroup.destroy();
            this.connectionPreviewGroup = null;
        }
        this.layer.batchDraw();
    }

    _highlightReferenceDropTarget(handle) {
        const point = handle.getAbsolutePosition(this.layer);
        const target = this._findItemAtStagePoint(point);
        if (this.referenceDropTargetId && this.referenceDropTargetId !== target?.data?.id) {
            this._setItemReferenceHighlight(this.referenceDropTargetId, false);
        }
        this.referenceDropTargetId = target?.data?.id || null;
        if (this.referenceDropTargetId) {
            this._setItemReferenceHighlight(this.referenceDropTargetId, true);
        }
        return target;
    }

    _setItemReferenceHighlight(itemId, active, options = {}) {
        const item = this.items.get(itemId);
        const node = item?.group?.findOne('.displayNode') || item?.group?.findOne('.fallbackBg');
        if (!node) {
            if (!active) this._referenceHighlightIds?.delete(itemId);
            return;
        }
        let halo = item.group.findOne('.referenceDropHalo');
        let label = item.group.findOne('.referenceDropLabel');
        if (active) {
            this._referenceHighlightIds?.add(itemId);
            const rect = node.getClientRect({ relativeTo: item.group });
            const mode = options.mode || 'drop';
            const isConnection = mode === 'connection';
            const isMedia = mode === 'media';
            const stroke = isConnection ? PLAN_OUTPUT_CONNECTION_COLOR : isMedia ? '#fbbf24' : PLAN_CONNECTION_PREVIEW_COLOR;
            const fill = isConnection ? 'rgba(255, 255, 255, 0.06)' : isMedia ? 'rgba(251, 191, 36, 0.08)' : 'rgba(52, 211, 153, 0.08)';
            const mediaTone = Number(options.referenceIndex) % 2 === 0
                ? {
                    fill: 'rgba(62, 65, 71, 0.96)',
                    stroke: 'rgba(183, 187, 195, 0.5)',
                    text: '#e1e3e6'
                }
                : {
                    fill: 'rgba(190, 193, 199, 0.96)',
                    stroke: 'rgba(235, 236, 239, 0.72)',
                    text: '#25272b'
                };
            const referenceCount = isConnection
                ? this._countPlanReferencesToItem(item.data.id, item.data.filePath)
                : 0;
            const labelText = options.labelText || (isConnection
                ? `连接目标 · ${referenceCount || 1} 条关联`
                : '可连接');
            const labelWidth = Math.max(54, this._estimateTextWidth(labelText) + 18);
            if (isMedia) {
                halo?.destroy();
                halo = null;
            } else {
                if (!halo) {
                    halo = new Konva.Rect({
                        name: 'referenceDropHalo',
                        listening: false,
                        cornerRadius: 12,
                        perfectDrawEnabled: false
                    });
                    item.group.add(halo);
                }
                halo.stroke(stroke);
                halo.strokeWidth(isConnection ? 2.4 : 3);
                halo.dash(isConnection ? [] : [12, 7]);
                halo.fill(fill);
                halo.shadowColor(stroke);
                halo.shadowBlur(isConnection ? 22 : 18);
                halo.shadowOpacity(isConnection ? 0.42 : 0.35);
                halo.position({ x: rect.x - 7, y: rect.y - 7 });
                halo.size({ width: rect.width + 14, height: rect.height + 14 });
                halo.moveToTop();
            }
            if (!label) {
                label = new Konva.Group({
                    name: 'referenceDropLabel',
                    listening: false
                });
                label.add(new Konva.Rect({
                    name: 'referenceDropLabelBg',
                    height: 20,
                    cornerRadius: 10,
                    perfectDrawEnabled: false
                }));
                label.add(new Konva.Text({
                    name: 'referenceDropLabelText',
                    y: 5,
                    height: 10,
                    fontSize: 10,
                    fontStyle: 'bold',
                    align: 'center',
                    listening: false
                }));
                item.group.add(label);
            }
            label.position({
                x: rect.x + rect.width - labelWidth - 2,
                y: rect.y - 18
            });
            label.findOne('.referenceDropLabelBg')?.setAttrs({
                width: labelWidth,
                fill: isMedia ? mediaTone.fill : (isConnection ? 'rgba(8, 35, 48, 0.96)' : 'rgba(8, 45, 34, 0.96)'),
                stroke: isMedia ? mediaTone.stroke : (isConnection ? 'rgba(236, 238, 241, 0.38)' : 'rgba(52, 211, 153, 0.48)'),
                strokeWidth: 1,
                shadowColor: isMedia ? '#000000' : stroke,
                shadowBlur: isMedia ? 6 : 10,
                shadowOpacity: isMedia ? 0.18 : 0.2
            });
            label.findOne('.referenceDropLabelText')?.setAttrs({
                width: labelWidth,
                text: labelText,
                fill: isMedia ? mediaTone.text : (isConnection ? '#d6f6ff' : '#d5ffe9')
            });
            label.moveToTop();
        } else {
            this._referenceHighlightIds?.delete(itemId);
            halo?.destroy();
            label?.destroy();
        }
        this.layer.batchDraw();
    }

    _finishPlanReferenceDrag(handle) {
        const planId = handle.getAttr('planId');
        const rowId = handle.getAttr('rowId');
        const point = handle.getAbsolutePosition(this.layer);
        const target = this._findItemAtStagePoint(point);
        const previousTargetId = this.referenceDropTargetId;
        this.referenceDropTargetId = null;
        if (previousTargetId) this._setItemReferenceHighlight(previousTargetId, false);
        if (target) {
            this._togglePlanRowReference(planId, rowId, target);
        } else {
            this.refreshPlanNode(planId);
        }
    }

    _samePlanReference(reference, targetReference, kind = null) {
        if (!reference || !targetReference) return false;
        if (kind && this._getPlanReferenceKind(reference) !== kind) return false;
        if (reference === targetReference) return true;
        if (reference.itemId && targetReference.itemId && reference.itemId === targetReference.itemId) return true;
        if (reference.filePath && targetReference.filePath && reference.filePath === targetReference.filePath) return true;
        return Boolean(
            reference.name
            && targetReference.name
            && reference.name === targetReference.name
            && this._getPlanReferenceKind(reference) === this._getPlanReferenceKind(targetReference)
        );
    }

    _removePlanRowReference(planId, rowId, reference, kind = null) {
        const plan = this.planService?.getPlan?.(planId);
        const row = plan?.rows?.find(entry => entry.id === rowId);
        if (!plan || !row || !row.references?.length) return false;

        const before = row.references.length;
        row.references = row.references.filter(existing => !this._samePlanReference(existing, reference, kind));
        if (row.references.length === before) return false;
        if (
            this._selectedPlanConnection
            && this._selectedPlanConnection.planId === planId
            && this._selectedPlanConnection.rowId === rowId
            && this._samePlanReference(this._selectedPlanConnection.reference, reference, kind)
        ) {
            this._selectedPlanConnection = null;
            this._clearPlanConnectionFocusState();
        }

        this._syncRowAssetCell(row);
        this.planService.updatePlan(planId, { rows: plan.rows });
        this.refreshPlanNode(planId);
        this.emit('plansChanged');
        this.emit('change');
        this._showCanvasStatus(kind === 'output' ? '已断开这条输出线' : '已断开这条参考线');
        return true;
    }

    _togglePlanRowReference(planId, rowId, itemEntry) {
        const plan = this.planService?.getPlan?.(planId);
        const row = plan?.rows?.find(entry => entry.id === rowId);
        if (!plan || !row || !itemEntry?.data?.filePath) return;

        const sourceReferences = this._getSourcePlanRowReferences(row);
        const outputReferences = this._getOutputPlanRowReferences(row);
        const existingIndex = sourceReferences.findIndex(reference =>
            reference.itemId === itemEntry.data.id || reference.filePath === itemEntry.data.filePath
        );
        if (existingIndex >= 0) {
            sourceReferences.splice(existingIndex, 1);
            this._showCanvasStatus('已取消该行参考图片');
        } else {
            sourceReferences.push({
                itemId: itemEntry.data.id,
                filePath: itemEntry.data.filePath,
                name: this._fileNameFromPath(itemEntry.data.filePath),
                kind: 'source'
            });
            this._showCanvasStatus('已连接参考图片');
        }
        row.references = [...sourceReferences, ...outputReferences];
        this._syncRowAssetCell(row);
        this.planService.updatePlan(planId, { rows: plan.rows });
        this.refreshPlanNode(planId);
        this.emit('plansChanged');
        this.emit('change');
    }

    _clearPlanRowReference(planId, rowId) {
        const plan = this.planService?.getPlan?.(planId);
        const row = plan?.rows?.find(entry => entry.id === rowId);
        if (!row || !row.references?.length) return;
        row.references = this._getOutputPlanRowReferences(row);
        this._syncRowAssetCell(row);
        this.planService.updatePlan(planId, { rows: plan.rows });
        this.refreshPlanNode(planId);
        this.emit('plansChanged');
        this.emit('change');
        this._showCanvasStatus('已取消该行参考图片');
    }

    _syncRowAssetCell(row) {
        if (!row?.cells) return;
        row.cells.assets = this._getSourcePlanRowReferences(row)
            .map(reference => reference.name || this._fileNameFromPath(reference.filePath))
            .filter(Boolean)
            .join('\n');
    }

    _getPlanRowPrompt(plan, row) {
        if (!plan || !row) return '';
        const cells = row.cells || {};
        return [
            cells.title,
            cells.role,
            cells.content,
            cells.output ? `输出类型：${cells.output}` : '',
            cells.notes ? `风格约束：${cells.notes}` : ''
        ].map(value => String(value || '').trim()).filter(Boolean).join('\n');
    }

    async _generateOutputForPlanRow(planId, rowId) {
        if (this._isGeneratingPlanRow) return;
        const plan = this.planService?.getPlan?.(planId);
        const row = plan?.rows?.find(entry => entry.id === rowId);
        if (!plan || !row) return;
        const prompt = this._getPlanRowPrompt(plan, row);
        const wantsVideo = /(\u89c6\u9891|\u77ed\u7247|\u5f71\u7247|video)/i.test(String(row.cells?.output || ''));
        if (!prompt) {
            this._showCanvasStatus('请先填写这一行的标题或内容');
            return;
        }
        if (!window.flowCanvas?.mcp?.[wantsVideo ? 'generateVideo' : 'generateImage']) {
            this._showCanvasStatus('本地生图接口不可用，请重启应用后再试');
            return;
        }
        const imageProvider = this.options.getImageProvider?.();
        const videoProvider = this.options.getVideoProvider?.();
        const provider = wantsVideo ? videoProvider : imageProvider;
        if (wantsVideo && (!videoProvider?.apiKey || !videoProvider?.model || !videoProvider?.endpoint)) {
            this._showCanvasStatus('\u8bf7\u5148\u5728 Agent \u8bbe\u7f6e\u4e2d\u9009\u62e9\u53ef\u7528\u7684\u89c6\u9891 API');
            return;
        }
        if (!wantsVideo && (!imageProvider?.apiKey || !imageProvider?.model || !imageProvider?.endpoint)) {
            this._showCanvasStatus('请先在 Agent 设置中选择可用的生图 API');
            return;
        }

        this._isGeneratingPlanRow = true;
        this._setHoveredPlanRow(planId, rowId);
        this._showCanvasStatus(`正在使用 ${imageProvider.model} 生成结果图...`);
        try {
            const rowIndex = Math.max(0, (plan.rows || []).findIndex(entry => entry.id === rowId));
            const outputX = plan.x + (plan.width || PLAN_NODE_WIDTH) + 80;
            const metrics = this._getPlanTableMetrics(plan);
            const rowTop = metrics.rowTops[rowIndex] ?? (PLAN_HEADER_ROW_HEIGHT + rowIndex * PLAN_ROW_HEIGHT);
            const rowHeight = metrics.rowHeights[rowIndex] || PLAN_ROW_HEIGHT;
            const outputY = plan.y + rowTop + rowHeight / 2 - IMAGE_DEFAULT_WIDTH / 2;
            if (wantsVideo) {
                this._showCanvasStatus('\u6b63\u5728\u4f7f\u7528 ' + provider.model + ' \u751f\u6210\u89c6\u9891...');
            }
            const result = await window.flowCanvas.mcp[wantsVideo ? 'generateVideo' : 'generateImage']({
                provider: wantsVideo ? 'openai-video' : 'openai',
                providerConfig: provider,
                planId,
                rowId,
                prompt,
                title: row.cells?.title || plan.title || (wantsVideo ? 'Flow Canvas video' : 'Flow Canvas image'),
                x: outputX,
                y: outputY,
                width: wantsVideo ? 1280 : 1024,
                height: wantsVideo ? 720 : 1024,
                resolution: wantsVideo ? '720p' : undefined,
                ratio: wantsVideo ? '16:9' : undefined,
                duration: wantsVideo ? 5 : undefined,
                addToCanvas: true,
                includePlanAssets: false
            });
            if (!result?.success && result?.error) throw new Error(result.error);
            this._showCanvasStatus(result?.item ? '已生成并连接结果图' : '已生成图片');
        } catch (error) {
            console.error('[Canvas] plan row image generation failed:', error);
            this._showCanvasStatus(`生图失败：${error.message || error}`);
        } finally {
            this._isGeneratingPlanRow = false;
        }
    }

    openPlanEditor(planId) {
        const plan = this.planService?.getPlan?.(planId);
        if (!plan) return;
        this._removePlanEditor();

        const overlay = document.createElement('div');
        overlay.className = 'plan-editor-overlay';
        overlay.innerHTML = `
            <div class="plan-editor" role="dialog" aria-modal="true">
                <div class="plan-editor-header">
                    <input class="plan-editor-title" value="${escapeHtml(plan.title)}" aria-label="规划表标题">
                    <button class="plan-editor-close" type="button" title="关闭">×</button>
                </div>
                <div class="plan-editor-table-wrap">
                    <table class="plan-editor-table">
                        <thead>
                            <tr>${plan.columns.map(column => `<th style="min-width:${column.width}px">${escapeHtml(column.label)}</th>`).join('')}<th class="plan-row-actions"></th></tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>
                <div class="plan-editor-footer">
                    <button class="plan-editor-add" type="button">添加行</button>
                    <div class="plan-editor-footer-actions">
                        <button class="plan-editor-cancel" type="button">取消</button>
                        <button class="plan-editor-save" type="button">保存</button>
                    </div>
                </div>
            </div>
        `;

        const tbody = overlay.querySelector('tbody');
        const draftRows = plan.rows.map(row => ({
            id: row.id,
            cells: { ...row.cells },
            references: [...(row.references || [])]
        }));

        const renderRows = () => {
            tbody.innerHTML = '';
            draftRows.forEach((row, rowIndex) => {
                const tr = document.createElement('tr');
                plan.columns.forEach(column => {
                    const td = document.createElement('td');
                    if (column.key === 'status') {
                        const select = document.createElement('select');
                        select.className = 'plan-cell-input';
                        DEFAULT_STATUS_OPTIONS.forEach(status => {
                            const option = document.createElement('option');
                            option.value = status;
                            option.textContent = status;
                            option.selected = (row.cells[column.key] || '未开始') === status;
                            select.appendChild(option);
                        });
                        select.addEventListener('change', () => {
                            row.cells[column.key] = select.value;
                        });
                        td.appendChild(select);
                    } else {
                        const textarea = document.createElement('textarea');
                        textarea.className = 'plan-cell-input';
                        textarea.value = row.cells[column.key] || '';
                        textarea.rows = column.key === 'content' || column.key === 'assets' ? 3 : 2;
                        textarea.addEventListener('input', () => {
                            row.cells[column.key] = textarea.value;
                        });
                        td.appendChild(textarea);
                    }
                    tr.appendChild(td);
                });

                const actionTd = document.createElement('td');
                actionTd.className = 'plan-row-actions';
                const deleteBtn = document.createElement('button');
                deleteBtn.type = 'button';
                deleteBtn.className = 'plan-row-delete';
                deleteBtn.textContent = '删除';
                deleteBtn.addEventListener('click', () => {
                    draftRows.splice(rowIndex, 1);
                    renderRows();
                });
                actionTd.appendChild(deleteBtn);
                tr.appendChild(actionTd);
                tbody.appendChild(tr);
            });
        };

        renderRows();
        document.body.appendChild(overlay);
        overlay.querySelector('.plan-editor-title')?.focus();

        const close = () => this._removePlanEditor();
        overlay.querySelector('.plan-editor-close')?.addEventListener('click', close);
        overlay.querySelector('.plan-editor-cancel')?.addEventListener('click', close);
        overlay.addEventListener('mousedown', event => {
            if (event.target === overlay) close();
        });
        overlay.querySelector('.plan-editor-add')?.addEventListener('click', () => {
            draftRows.push(this.planService.createRow(draftRows.length));
            renderRows();
        });
        overlay.querySelector('.plan-editor-save')?.addEventListener('click', () => {
            const title = overlay.querySelector('.plan-editor-title')?.value || plan.title;
            this.planService.updatePlan(planId, { title, rows: draftRows });
            this.renderPlans();
            this._removePlanEditor();
            this.emit('plansChanged');
            this.emit('change');
            this._showCanvasStatus('规划表已保存');
        });
    }

    _removePlanEditor() {
        document.querySelectorAll('.plan-editor-overlay').forEach(node => node.remove());
    }

    async copyPlanAsMarkdown(planId) {
        const plan = this.planService?.getPlan?.(planId);
        if (!plan) return;
        const markdown = formatPlanMarkdown(plan);
        const res = await window.flowCanvas?.clipboard?.writeText?.(markdown);
        this._showCanvasStatus(res?.success ? '已复制规划表 Markdown' : '复制失败');
    }

    removePlanById(id) {
        const entry = this.plans.get(id);
        if (!entry) return false;
        this.selectedItems.delete(id);
        entry.group?.destroy();
        this._removePlanInlineEditor(id);
        this.plans.delete(id);
        this.planService?.deletePlan(id);
        this.layer.batchDraw();
        return true;
    }

    getSelectedFilePaths() {
        const selectedEntries = [];
        this.selectedItems.forEach(id => {
            const item = this.items.get(id);
            if (item?.data?.filePath && item.group.isVisible()) {
                selectedEntries.push({
                    filePath: item.data.filePath,
                    x: item.group.x(),
                    y: item.group.y()
                });
            }
        });
        selectedEntries.sort((a, b) => (a.y - b.y) || (a.x - b.x));
        return selectedEntries.map(item => item.filePath);
    }

    _showCanvasStatus(text, timeoutMs = 1800) {
        const status = document.getElementById('titlebarStatus');
        if (!status) return;
        status.textContent = text;
        status.classList.add('status-visible');
        clearTimeout(this.planStatusTimer);
        this.planStatusTimer = setTimeout(() => {
            if (status.textContent === text) {
                status.textContent = '';
                status.classList.remove('status-visible');
            }
        }, timeoutMs);
    }

    _capturePlanInlineFocus(planId) {
        const editor = this.planInlineEditors?.get(planId);
        const active = document.activeElement;
        if (!editor || !active || !editor.contains(active)) return null;
        return {
            planId,
            rowId: active.dataset?.rowId || active.closest('tr')?.dataset?.rowId || '',
            columnKey: active.dataset?.columnKey || active.closest('td')?.dataset?.columnKey || '',
            selectionStart: Number.isFinite(active.selectionStart) ? active.selectionStart : null,
            selectionEnd: Number.isFinite(active.selectionEnd) ? active.selectionEnd : null
        };
    }

    _restorePlanInlineFocus(snapshot) {
        if (!snapshot?.planId) return;
        const editor = this.planInlineEditors?.get(snapshot.planId);
        if (!editor) return;
        const fields = Array.from(editor.querySelectorAll('input, textarea, select'));
        const target = fields.find(field =>
            field.dataset.rowId === snapshot.rowId &&
            field.dataset.columnKey === snapshot.columnKey
        ) || fields[0];
        if (!target) return;
        target.focus();
        if (
            typeof target.setSelectionRange === 'function' &&
            snapshot.selectionStart != null &&
            snapshot.selectionEnd != null
        ) {
            target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
        }
    }

    refreshPlanNode(planId, options = {}) {
        const focusSnapshot = options.preserveInlineFocus
            ? this._capturePlanInlineFocus(planId)
            : null;
        const entry = this.plans.get(planId);
        const plan = this.planService?.getPlan?.(planId);
        if (!entry || !plan) return;
        entry.group?.destroy();
        this.plans.delete(planId);
        this._createPlanNode(plan);
        this._updateSelectionVisuals();
        this.layer.batchDraw();
        if (focusSnapshot) {
            requestAnimationFrame(() => this._restorePlanInlineFocus(focusSnapshot));
        }
    }

    // ══════════════════════════════════════════════════════════
    // ── 全量内容加载 ─────────────────────────────────────
    // ══════════════════════════════════════════════════════════

    /**
     * 延迟补加载（用于新增卡片或异步创建完成后）
     */
    _scheduleCullCheck(delay = this._CULL_THROTTLE_MS) {
        clearTimeout(this._cullTimer);
        this._cullPending = true;
        this._cullTimer = setTimeout(() => {
            this._cullPending = false;
            this._loadAllContent();
        }, delay);
    }

    setResourceSaverMode(enabled) {
        this.resourceSaverMode = !!enabled;
        this.storeData.resourceSaver = this.resourceSaverMode;
        this._contentLoadQueue = [];
        this._activeContentLoads = 0;

        this.items.forEach(item => {
            clearTimeout(item.hoverTimer);
            item.hoverTimer = null;
            item.hoverFull = false;
            item.autoPlayVideo = false;
            item.loadQueued = false;
            if (item.loaded || item.loading) {
                this._prepareQualityReload(item, this.resourceSaverMode);
            }
        });

        this._loadAllContent();
    }

    _scheduleResourceSaverPromote(item) {
        if (!this.resourceSaverMode || item.isResizing || !item.group.getLayer()) return;
        clearTimeout(item.hoverTimer);
        item.hoverTimer = setTimeout(() => {
            item.hoverTimer = null;
            if (!this.resourceSaverMode || item.isResizing || !item.group.getLayer() || item.hoverFull) return;
            item.hoverFull = true;
            if (item.loaded || item.loading || item.loadQueued) {
                this._prepareQualityReload(item, false);
            }
            this._queueContentLoad(item, false, true);
            this._drainContentLoadQueue();
        }, this._RESOURCE_HOVER_DELAY_MS);
    }

    _demoteResourceSaverItem(item) {
        clearTimeout(item.hoverTimer);
        item.hoverTimer = null;
        if (!this.resourceSaverMode || item.isResizing || !item.hoverFull || !item.group.getLayer()) return;
        if (item.autoPlayVideo || (item.videoElement && !item.videoElement.paused)) return;

        item.hoverFull = false;
        item.autoPlayVideo = false;
        if (item.loaded || item.loading || item.loadQueued) {
            this._prepareQualityReload(item, true);
        }
        this._queueContentLoad(item, true, true);
        this._drainContentLoadQueue();
    }

    _loadAllContent() {
        const useThumbnail = this.resourceSaverMode;
        this.items.forEach(item => {
            if (item.data?.kind === 'op') return;
            if (!item.loaded && !item.loading) {
                this._queueContentLoad(item, useThumbnail);
            } else if ((item.loaded || item.loading) && item.isThumbnail !== useThumbnail && !item.hoverFull) {
                this._prepareQualityReload(item, useThumbnail);
                this._queueContentLoad(item, useThumbnail);
            }
        });
        this._drainContentLoadQueue();
    }

    _queueContentLoad(item, useThumbnail, priority = false) {
        if (item.loaded || item.loading || item.loadQueued || !item.group.getLayer()) return;
        item.loadQueued = true;
        item.queuedUseThumbnail = useThumbnail;
        if (priority) {
            this._contentLoadQueue.unshift(item);
        } else {
            this._contentLoadQueue.push(item);
        }
    }

    _drainContentLoadQueue() {
        while (this._activeContentLoads < this._MAX_CONTENT_LOADS && this._contentLoadQueue.length > 0) {
            const item = this._contentLoadQueue.shift();
            if (!item || item.loaded || item.loading || !item.group.getLayer()) {
                if (item) item.loadQueued = false;
                continue;
            }

            const useThumbnail = !!item.queuedUseThumbnail;
            item.loadQueued = false;
            item.queuedUseThumbnail = false;
            item.loadActive = true;
            this._activeContentLoads += 1;
            this._loadContent(item, useThumbnail);
        }
    }

    _completeContentLoad(item) {
        if (!item.loadActive) return;
        item.loadActive = false;
        this._activeContentLoads = Math.max(0, this._activeContentLoads - 1);
        requestAnimationFrame(() => this._drainContentLoadQueue());
    }

    getResourceUsageStats() {
        let loaded = 0;
        let loading = 0;
        let queued = this._contentLoadQueue.length;
        let thumbnails = 0;
        let videos = 0;
        let gifs = 0;

        this.items.forEach(item => {
            if (item.loaded) loaded += 1;
            if (item.loading) loading += 1;
            if (item.loadQueued) queued += 1;
            if (item.isThumbnail) thumbnails += 1;
            if (item.videoElement) videos += 1;
            if (item.gifDomElement) gifs += 1;
        });

        return {
            total: this.items.size,
            loaded,
            loading,
            queued,
            thumbnails,
            videos,
            gifs,
            graphPortNodes: this.graphView?.portShapes?.size || 0,
            graphPortShapes: [...(this.graphView?.portShapes?.values?.() || [])]
                .reduce((total, entries) => total + entries.length, 0),
            graphEdges: this.graphView?.connections?.length || 0,
            resourceSaver: this.resourceSaverMode
        };
    }

    /**
     * 按需加载节点内容（完整图或缩略图）
     */
    _loadContent(item, useThumbnail) {
        if (item.data?.kind === 'op') return;
        const fileType = this._getItemMediaType(item.data);
        if (!item.data.filePath) {
            item.loading = false;
            item.loaded = true;
            item.loadError = false;
            this._completeContentLoad(item);
            return;
        }
        const isGif = String(item.data.filePath || '').toLowerCase().endsWith('.gif');
        const token = (item.loadToken || 0) + 1;

        item.loadToken = token;
        item.loading = true;
        item.loaded = false;
        item.isThumbnail = useThumbnail;

        if (fileType === 'image' || isGif) {
            if (useThumbnail) {
                this._loadLowRes(item, token);
            } else {
                this._loadThumbnail(item, token);
            }
        } else if (fileType === 'video') {
            if (!useThumbnail) {
                this._loadVideo(item, token);
            } else {
                this._loadVideoCover(item, token);
            }
        } else {
            this._finishLoad(item, token);
        }
    }

    _captureVideoTransitionFrame(item, displayNode) {
        let transitionNode = displayNode;
        const source = displayNode?.image?.();
        if (source?.tagName === 'VIDEO') {
            const naturalWidth = Number(source.videoWidth) || Math.round(displayNode.width()) || 1;
            const naturalHeight = Number(source.videoHeight) || Math.round(displayNode.height()) || 1;
            const captureWidth = Math.max(1, Math.min(960, naturalWidth));
            const captureHeight = Math.max(1, Math.round(captureWidth * naturalHeight / naturalWidth));
            const canvas = document.createElement('canvas');
            canvas.width = captureWidth;
            canvas.height = captureHeight;
            const context = canvas.getContext('2d');
            try {
                context?.drawImage(source, 0, 0, captureWidth, captureHeight);
            } catch (_) {
                if (context) {
                    context.fillStyle = '#2b2b2b';
                    context.fillRect(0, 0, captureWidth, captureHeight);
                }
            }

            transitionNode = new Konva.Image({
                name: 'displayNode',
                x: displayNode.x(),
                y: displayNode.y(),
                image: canvas,
                width: displayNode.width(),
                height: displayNode.height()
            });
            transitionNode.setAttr('videoFrameSnapshot', true);
            item.group.add(transitionNode);
            transitionNode.zIndex(displayNode.zIndex());
            displayNode.image(null);
            displayNode.destroy();
        }

        if (item.videoAnimation) {
            item.videoAnimation.stop();
            item.videoAnimation = null;
        }
        if (item.videoElement) {
            this._disposeVideoElement(item.videoElement);
            item.videoElement = null;
        }
        item.group.findOne('.videoControls')?.destroy();
        item.group.findOne('.videoCoverControls')?.destroy();
        item.group.off('mouseenter.video mouseleave.video');
        return transitionNode;
    }

    _prepareQualityReload(item, targetUseThumbnail = null) {
        const filePath = String(item?.data?.filePath || '').toLowerCase();
        const fileType = this._getFileType(filePath);
        const isStaticImage = fileType === 'image' && !filePath.endsWith('.gif');
        const isVideo = fileType === 'video';
        if (!isStaticImage && !isVideo) {
            this._unloadContent(item);
            return false;
        }

        if (item.loadQueued) {
            this._contentLoadQueue = this._contentLoadQueue.filter(queuedItem => queuedItem !== item);
            item.loadQueued = false;
        }

        // A quick pointer reversal can make the quality currently being loaded unnecessary.
        // Restore the still-visible previous image instead of exposing the fallback.
        if (item.loading && item.transitionOldNode?.getLayer()) {
            const oldNode = item.transitionOldNode;
            const previousIsThumbnail = item.transitionPreviousIsThumbnail;
            this._completeContentLoad(item);
            item.loadToken = (item.loadToken || 0) + 1;
            if (isVideo) {
                if (item.videoAnimation) {
                    item.videoAnimation.stop();
                    item.videoAnimation = null;
                }
                if (item.videoElement) {
                    this._disposeVideoElement(item.videoElement);
                    item.videoElement = null;
                }
            }
            item.loading = false;
            item.loaded = true;
            item.isThumbnail = previousIsThumbnail;
            item.transitionOldNode = null;
            item.transitionPreviousIsThumbnail = null;
            oldNode.name('displayNode');
            oldNode.listening(true);
            oldNode.opacity(1);
            oldNode.filters([]);
            oldNode.clearCache();

            const requiresLiveVideo = isVideo
                && targetUseThumbnail === false
                && oldNode.getAttr('videoFrameSnapshot');
            if (targetUseThumbnail === previousIsThumbnail && !requiresLiveVideo) {
                item.group.getLayer()?.batchDraw();
                return false;
            }
        }

        // If the previous fade is interrupted, settle its new image before using it as
        // the source for another transition. This avoids retaining a half-transparent blur.
        if (item.qualityTransition) {
            item.qualityTransition.destroy();
            item.qualityTransition = null;
        }
        let currentNode = item.group.findOne('.displayNode');
        if (currentNode) {
            currentNode.opacity(1);
            currentNode.filters([]);
            currentNode.clearCache();
        }
        if (item.transitionOldNode && item.transitionOldNode !== currentNode) {
            item.transitionOldNode.image?.(null);
            item.transitionOldNode.destroy();
            item.transitionOldNode = null;
            item.transitionPreviousIsThumbnail = null;
        }

        const requiresLiveVideo = isVideo
            && targetUseThumbnail === false
            && currentNode?.getAttr('videoFrameSnapshot');
        if (targetUseThumbnail === item.isThumbnail && item.loaded && currentNode && !requiresLiveVideo) {
            item.group.getLayer()?.batchDraw();
            return false;
        }

        if (isVideo && currentNode) {
            currentNode = this._captureVideoTransitionFrame(item, currentNode);
        }

        const canPreserveImage = item.loaded && !item.loading && currentNode;
        const displayNode = canPreserveImage ? currentNode : null;
        if (!displayNode) {
            this._unloadContent(item);
            return false;
        }

        this._completeContentLoad(item);
        item.loadToken = (item.loadToken || 0) + 1;
        item.loading = false;
        item.loaded = false;
        item.loadQueued = false;
        item.transitionPreviousIsThumbnail = item.isThumbnail;
        item.transitionOldNode = displayNode;
        displayNode.name('transitionOldDisplay');
        displayNode.listening(false);
        return true;
    }

    _placeLoadedDisplayNode(item, node, token) {
        this._styleMediaDisplayNode(item, node);
        const oldNode = item.transitionOldNode;
        if (!oldNode || !oldNode.getLayer() || oldNode.getParent() !== node.getParent()) {
            node.moveToBottom();
            item.group.findOne('.externalNodeTitle')?.moveToTop();
            return;
        }

        node.opacity(0);
        node.zIndex(oldNode.zIndex() + 1);
        let blurEnabled = false;
        try {
            node.cache({ pixelRatio: 1 });
            node.filters([Konva.Filters.Blur]);
            node.blurRadius(7);
            blurEnabled = true;
        } catch (error) {
            node.filters([]);
            node.clearCache();
        }

        const finishTransition = () => {
            if (item.qualityTransition !== tween) return;
            item.qualityTransition = null;
            node.opacity(1);
            if (blurEnabled) {
                node.filters([]);
                node.clearCache();
            }
            if (item.transitionOldNode === oldNode) {
                oldNode.image?.(null);
                oldNode.destroy();
                item.transitionOldNode = null;
                item.transitionPreviousIsThumbnail = null;
            }
            item.group.getLayer()?.batchDraw();
        };
        const tween = new Konva.Tween({
            node,
            duration: 0.32,
            opacity: 1,
            ...(blurEnabled ? { blurRadius: 0 } : {}),
            easing: Konva.Easings.EaseOut,
            onFinish: finishTransition
        });
        item.qualityTransition = tween;
        tween.play();
    }

    /**
     * 卸载节点内容 — 释放图片纹理和视频资源
     */
    _unloadContent(item) {
        // Operation nodes use vector shapes instead of media textures. Treat them as
        // already unloaded so the shared deletion path never calls Image-only APIs.
        if (item?.data?.kind === 'op') return;

        this._completeContentLoad(item);
        const transformerNode = this.imageTransformer?.nodes?.()[0];
        if (transformerNode?.getParent?.() === item.group) {
            this.imageTransformer.nodes([]);
        }
        if (item.qualityTransition) {
            item.qualityTransition.destroy();
            item.qualityTransition = null;
        }
        if (item.transitionOldNode) {
            item.transitionOldNode.image?.(null);
            item.transitionOldNode.destroy();
            item.transitionOldNode = null;
            item.transitionPreviousIsThumbnail = null;
        }
        item.loadToken = (item.loadToken || 0) + 1;
        item.loading = false;
        item.loaded = false;
        item.loadQueued = false;

        item.group.off('dragmove.gif mouseenter.gif mouseleave.gif');
        item.group.off('mouseenter.video mouseleave.video');

        // 销毁 Konva 显示节点
        const displayNode = item.group.findOne('.displayNode');
        if (displayNode) {
            displayNode.image(null); // 断开 Image 引用
            displayNode.destroy();
        }

        // 销毁视频控制组（进度条等）
        const children = item.group.getChildren();
        children.forEach(child => {
            if (
                child.getClassName() === 'Group'
                && child.name() !== 'fallbackIcon'
                && child.name() !== 'externalNodeTitle'
            ) {
                child.destroy();
            }
        });

        // 释放视频资源
        if (item.videoElement) {
            this._disposeVideoElement(item.videoElement);
            item.videoElement = null;
        }
        if (item.videoAnimation) {
            item.videoAnimation.stop();
            item.videoAnimation = null;
        }

        // 移除 GIF DOM 叠加层
        if (item.gifDomElement) {
            item.gifDomElement.remove();
            item.gifDomElement = null;
        }

        // 恢复占位框（保留尺寸信息）
        if (!item.group.findOne('.fallbackBg')) {
            const fileType = this._getItemMediaType(item.data);
            const { width: w, height: h } = this._mediaPlaceholderSize(fileType, item.data);
            item.group.add(this._createFallbackGroup(fileType, w, h, item.data.filePath));
        }
        this._syncExternalNodeTitle(item.group, item.data, this._getItemMediaType(item.data));

        item.isThumbnail = false;
        item.group.getLayer()?.batchDraw();
    }

    _isLoadCurrent(item, token) {
        return item.loadToken === token && item.loading && item.group.getLayer();
    }

    _finishLoad(item, token) {
        if (!this._isLoadCurrent(item, token)) {
            this._completeContentLoad(item);
            return false;
        }
        item.loading = false;
        item.loaded = true;
        item.loadError = false;
        item.loadErrorMessage = '';
        this._completeContentLoad(item);
        return true;
    }

    _failLoad(item, token, message = '加载失败') {
        if (!this._isLoadCurrent(item, token)) {
            this._completeContentLoad(item);
            return false;
        }
        item.loading = false;
        const oldNode = item.transitionOldNode;
        if (oldNode?.getLayer()) {
            oldNode.name('displayNode');
            oldNode.listening(true);
            item.transitionOldNode = null;
            item.loaded = true;
            item.isThumbnail = item.transitionPreviousIsThumbnail;
            item.transitionPreviousIsThumbnail = null;
            item.loadError = false;
            item.loadErrorMessage = '';
            this._completeContentLoad(item);
            item.group.getLayer()?.batchDraw();
            return false;
        }
        item.loaded = false;
        item.loadError = true;
        this._markFallbackLoadError(item, message);
        this._completeContentLoad(item);
        item.group.getLayer()?.batchDraw();
        return true;
    }

    async _inspectMediaFileExists(filePath) {
        try {
            const inspection = await window.flowCanvas?.file?.inspect?.(filePath);
            if (inspection?.exists === true && inspection?.isFile !== false) return true;
            if (inspection?.exists === false || inspection?.isFile === false) return false;
        } catch (_) {
            // Keep the generic load error when the native inspection bridge is unavailable.
        }
        return null;
    }

    async _failImageLoad(item, token, fallbackMessage = '加载失败') {
        const fileExists = await this._inspectMediaFileExists(item?.data?.filePath || '');
        if (!this._isLoadCurrent(item, token)) {
            this._completeContentLoad(item);
            return false;
        }
        return this._failLoad(
            item,
            token,
            fileExists === false ? '文件失联' : fileExists === true ? '无法解码' : fallbackMessage
        );
    }

    async _handleVideoLoadError(item, token, video, label = '视频') {
        if (video?.__flowCanvasHandlingError) return;
        if (video) video.__flowCanvasHandlingError = true;
        const mediaErrorCode = video?.error?.code || 0;
        const filePath = item?.data?.filePath || '';
        this._disposeVideoElement(video);
        if (item.videoElement === video) item.videoElement = null;

        let fileExists = null;
        try {
            fileExists = await this._inspectMediaFileExists(filePath);
        } catch (_) {
            fileExists = null;
        }
        if (!this._isLoadCurrent(item, token)) {
            this._completeContentLoad(item);
            return;
        }

        const badge = fileExists === false ? '文件失联' : fileExists === true ? '无法解码' : '加载失败';
        this._failLoad(item, token, badge);
        console.error(`[Canvas] ${label}加载失败:`, filePath, {
            mediaErrorCode,
            fileExists
        });
    }

    _disposeVideoElement(video) {
        try {
            video.pause();
            video.removeAttribute('src');
            video.load();
            video.remove();
        } catch (err) {
            console.warn('[Canvas] 释放视频资源失败:', err);
        }
    }

    _resolveMediaDisplaySize(data, naturalWidth, naturalHeight, defaultWidth = IMAGE_DEFAULT_WIDTH) {
        const aspect = naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : 1;
        const savedW = Number(data.width) || 0;
        const savedH = Number(data.height) || 0;
        const targetW = savedW || defaultWidth;
        const targetH = savedH > 0 ? savedH : (targetW / aspect);
        return { width: targetW, height: targetH };
    }

    _storeResolvedMediaSize(item, width, height) {
        if (!item?.data || !Number.isFinite(width) || !Number.isFinite(height)) return;
        const changed = Math.abs((Number(item.data.width) || 0) - width) > 0.01
            || Math.abs((Number(item.data.height) || 0) - height) > 0.01;
        item.data.width = width;
        item.data.height = height;
        if (changed) this._scheduleSelectionToolbarSync();
        if (changed) {
            this.emit('mediaDimensionsResolved', { id: item.data.id, width, height });
        }
    }

    _createVideoPlayPauseGlyph(playing = false) {
        const glyph = new Konva.Group({
            name: 'videoControlGlyph videoPlayPauseGlyph',
            x: VIDEO_CONTROL_BUTTON_WIDTH / 2,
            y: VIDEO_CONTROL_HEIGHT / 2,
            offsetX: VIDEO_CONTROL_BUTTON_WIDTH / 2,
            offsetY: VIDEO_CONTROL_HEIGHT / 2,
            listening: false
        });
        const play = new Konva.Line({
            name: 'videoPlayGlyph',
            points: [11.5, 9.5, 11.5, 18.5, 18.5, 14],
            closed: true,
            fill: '#c9cdd3',
            shadowColor: '#000000',
            shadowBlur: 3,
            shadowOpacity: 0.72,
            shadowOffsetY: 1,
            visible: !playing
        });
        const pauseLeft = new Konva.Rect({
            name: 'videoPauseGlyph',
            x: 10.5,
            y: 9.5,
            width: 2.6,
            height: 9,
            cornerRadius: 1,
            fill: '#c9cdd3',
            shadowColor: '#000000',
            shadowBlur: 3,
            shadowOpacity: 0.72,
            shadowOffsetY: 1,
            visible: playing
        });
        const pauseRight = pauseLeft.clone({ x: 15.3 });
        glyph.add(play, pauseLeft, pauseRight);
        return glyph;
    }

    _setVideoPlayPauseGlyph(glyph, playing) {
        glyph?.find('.videoPlayGlyph').forEach(node => node.visible(!playing));
        glyph?.find('.videoPauseGlyph').forEach(node => node.visible(playing));
    }

    _createVideoVolumeGlyph(muted = true) {
        const glyph = new Konva.Group({
            name: 'videoControlGlyph videoVolumeGlyph',
            x: VIDEO_CONTROL_BUTTON_WIDTH / 2,
            y: VIDEO_CONTROL_HEIGHT / 2,
            offsetX: VIDEO_CONTROL_BUTTON_WIDTH / 2,
            offsetY: VIDEO_CONTROL_HEIGHT / 2,
            listening: false
        });
        const speaker = new Konva.Line({
            points: [9.5, 12, 12, 12, 15, 9.5, 15, 18.5, 12, 16, 9.5, 16],
            closed: true,
            fill: '#b9bec6',
            shadowColor: '#000000',
            shadowBlur: 3,
            shadowOpacity: 0.72,
            shadowOffsetY: 1
        });
        const wave = new Konva.Path({
            name: 'videoVolumeWave',
            data: 'M 17 11.5 C 19 13 19 15 17 16.5 M 19 9.5 C 22.5 12 22.5 16 19 18.5',
            stroke: '#b9bec6',
            strokeWidth: 1.4,
            lineCap: 'round',
            shadowColor: '#000000',
            shadowBlur: 3,
            shadowOpacity: 0.72,
            shadowOffsetY: 1,
            visible: !muted
        });
        const slash = new Konva.Line({
            name: 'videoVolumeSlash',
            points: [9.5, 9.5, 20.5, 18.5],
            stroke: '#b9bec6',
            strokeWidth: 1.45,
            lineCap: 'round',
            shadowColor: '#000000',
            shadowBlur: 3,
            shadowOpacity: 0.72,
            shadowOffsetY: 1,
            visible: muted
        });
        glyph.add(speaker, wave, slash);
        return glyph;
    }

    _setVideoVolumeGlyph(glyph, muted) {
        glyph?.find('.videoVolumeWave').forEach(node => node.visible(!muted));
        glyph?.find('.videoVolumeSlash').forEach(node => node.visible(muted));
    }

    _layoutVideoControlGroup(controls, width, height) {
        if (!controls) return;
        const layout = getVideoControlLayout(this.stage?.scaleX?.(), width, height);
        const progressBg = controls.findOne('.videoProgressBg');
        const progressFg = controls.findOne('.videoProgressFg');
        const previousProgressWidth = Number(progressBg?.width?.()) || 0;
        const progressRatio = previousProgressWidth > 0
            ? Math.max(0, Math.min(1, (Number(progressFg?.width?.()) || 0) / previousProgressWidth))
            : 0;

        controls.y(layout.groupY);
        controls.findOne('.videoControlBg')?.setAttrs({
            x: 0,
            y: layout.backgroundY,
            width,
            height: layout.backgroundHeight
        });
        controls.find('.videoControlGlyph').forEach(glyph => {
            glyph.scale({ x: layout.glyphScale, y: layout.glyphScale });
            glyph.position({
                x: glyph.hasName('videoVolumeGlyph') ? layout.volumeCenterX : layout.playCenterX,
                y: layout.glyphCenterY
            });
        });
        controls.find('.videoControlHotspot').forEach(hotspot => {
            hotspot.scale({ x: 1, y: 1 });
            hotspot.setAttrs({
                x: hotspot.hasName('videoVolumeHotspot') ? layout.buttonWidth : 0,
                y: 0,
                width: layout.buttonWidth,
                height: layout.controlHeight
            });
        });
        progressBg?.setAttrs({
            x: layout.progressX,
            y: layout.progressY,
            width: layout.progressWidth,
            height: layout.progressHeight,
            cornerRadius: layout.progressCornerRadius
        });
        progressFg?.setAttrs({
            x: layout.progressX,
            y: layout.progressY,
            width: layout.progressWidth * progressRatio,
            height: layout.progressHeight,
            cornerRadius: layout.progressCornerRadius
        });
        controls.findOne('.videoProgressHotspot')?.setAttrs({
            x: layout.progressX,
            y: 0,
            width: layout.progressWidth,
            height: layout.controlHeight
        });
    }

    _syncVideoControlLayout() {
        this.items.forEach(item => {
            const displayNode = item.group?.findOne('.displayNode') || item.group?.findOne('.fallbackBg');
            const width = Number(displayNode?.width?.()) || Number(item.data?.width) || 0;
            const height = Number(displayNode?.height?.()) || Number(item.data?.height) || 0;
            this._layoutVideoControlGroup(item.group?.findOne('.videoControls'), width, height);
            this._layoutVideoControlGroup(item.group?.findOne('.videoCoverControls'), width, height);
        });
    }

    _syncViewportFixedControls() {
        this._syncVideoControlLayout();
        this.graphView?.syncViewportControlScale(this.stage?.scaleX?.());
        this.layer.batchDraw();
    }

    _setVideoControlsVisible(item, visible) {
        if (!item?.group?.getLayer()) return;
        const controls = [
            item.group.findOne('.videoControls'),
            item.group.findOne('.videoCoverControls')
        ].filter(Boolean);
        controls.forEach(control => {
            control.stop();
            control.listening(visible);
            control.to({
                opacity: visible ? 1 : 0,
                duration: visible ? 0.1 : 0.18,
                easing: Konva.Easings.EaseOut
            });
        });
    }

    _createVideoCoverControls(item, width, height) {
        item.videoMuted = item.videoMuted !== false;
        const controls = new Konva.Group({
            name: 'videoCoverControls',
            x: 0,
            y: height - VIDEO_CONTROL_HEIGHT,
            opacity: 1,
            listening: true
        });
        const playIcon = this._createVideoPlayPauseGlyph(false);
        const volumeIcon = this._createVideoVolumeGlyph(item.videoMuted);
        volumeIcon.x(VIDEO_CONTROL_BUTTON_WIDTH * 1.5);
        const hotspot = new Konva.Rect({
            name: 'videoControlHotspot videoPlayPauseHotspot',
            width: VIDEO_CONTROL_BUTTON_WIDTH,
            height: VIDEO_CONTROL_HEIGHT,
            fill: 'transparent'
        });
        const volumeHotspot = new Konva.Rect({
            name: 'videoControlHotspot videoVolumeHotspot',
            x: VIDEO_CONTROL_BUTTON_WIDTH,
            width: VIDEO_CONTROL_BUTTON_WIDTH,
            height: VIDEO_CONTROL_HEIGHT,
            fill: 'transparent'
        });
        hotspot.on('mousedown', event => {
            if (event.evt?.button != null && event.evt.button !== 0) return;
            if (this._pickMediaReferenceFromControl(item, event)) return;
            event.cancelBubble = true;
            event.evt.stopPropagation();
            this._promoteVideoForPlayback(item);
        });
        volumeHotspot.on('mousedown', event => {
            if (event.evt?.button != null && event.evt.button !== 0) return;
            if (this._pickMediaReferenceFromControl(item, event)) return;
            event.cancelBubble = true;
            event.evt.stopPropagation();
            item.videoMuted = !item.videoMuted;
            this._setVideoVolumeGlyph(volumeIcon, item.videoMuted);
            controls.getLayer()?.batchDraw();
        });
        controls.add(playIcon, volumeIcon, hotspot, volumeHotspot);
        this._layoutVideoControlGroup(controls, width, height);
        return controls;
    }

    _promoteVideoForPlayback(item) {
        if (!item?.group?.getLayer()) return;
        clearTimeout(item.hoverTimer);
        item.hoverTimer = null;
        item.hoverFull = true;
        item.autoPlayVideo = true;
        if (item.loaded || item.loading || item.loadQueued) {
            this._prepareQualityReload(item, false);
        }
        this._queueContentLoad(item, false, true);
        this._drainContentLoadQueue();
    }

    _loadVideoCover(item, token) {
        const group = item.group;
        const data = item.data;
        const video = document.createElement('video');
        video.src = 'local-res://' + encodeURIComponent(data.filePath);
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.style.display = 'none';
        item.videoElement = video;
        document.body.appendChild(video);

        let captured = false;
        const captureFrame = () => {
            if (captured || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
            captured = true;
            if (!this._isLoadCurrent(item, token)) {
                this._disposeVideoElement(video);
                if (item.videoElement === video) item.videoElement = null;
                this._completeContentLoad(item);
                return;
            }

            const { width: displayWidth, height: displayHeight } = this._resolveMediaDisplaySize(
                data,
                video.videoWidth,
                video.videoHeight
            );
            const coverWidth = Math.max(1, Math.min(320, video.videoWidth));
            const coverHeight = Math.max(1, Math.round(coverWidth * video.videoHeight / video.videoWidth));
            const canvas = document.createElement('canvas');
            canvas.width = coverWidth;
            canvas.height = coverHeight;
            canvas.getContext('2d')?.drawImage(video, 0, 0, coverWidth, coverHeight);

            this._storeResolvedMediaSize(item, displayWidth, displayHeight);
            group.findOne('.fallbackIcon')?.destroy();
            const cover = new Konva.Image({
                name: 'displayNode videoCover',
                image: canvas,
                width: displayWidth,
                height: displayHeight
            });
            group.add(cover);
            this._placeLoadedDisplayNode(item, cover, token);
            group.add(this._createVideoCoverControls(item, displayWidth, displayHeight));

            this._disposeVideoElement(video);
            if (item.videoElement === video) item.videoElement = null;
            this._finishLoad(item, token);
            if (this.selectedItems.has(data.id)) this._updateSelectionVisuals();
            group.getLayer()?.batchDraw();
        };

        video.addEventListener('loadedmetadata', () => {
            if (!this._isLoadCurrent(item, token)) return;
            video.preload = 'auto';
            const seekTime = Number.isFinite(video.duration) && video.duration > 0
                ? Math.min(0.08, video.duration / 2)
                : 0;
            try {
                video.currentTime = seekTime;
            } catch (_) {
                // loadeddata below still captures the first available frame.
            }
        });
        video.addEventListener('loadeddata', captureFrame);
        video.addEventListener('seeked', captureFrame);
        video.addEventListener('error', () => {
            this._handleVideoLoadError(item, token, video, '视频封面');
        });
    }

    /**
     * 加载低分辨率缩略图（LOD 模式）— 通过 IPC 获取 thumbnail dataURL
     */
    async _loadLowRes(item, token) {
        try {
            const dataUrl = await window.flowCanvas.thumb.get(item.data.filePath);
            if (!this._isLoadCurrent(item, token)) {
                this._completeContentLoad(item);
                return;
            }
            if (!dataUrl) {
                await this._failImageLoad(item, token);
                return;
            }

            const img = new window.Image();
            img.onload = () => {
                if (!this._isLoadCurrent(item, token)) {
                    this._completeContentLoad(item);
                    return;
                }

                const { width: targetW, height: targetH } = this._resolveMediaDisplaySize(item.data, img.width, img.height);
                this._storeResolvedMediaSize(item, targetW, targetH);

                const fallback = item.group.findOne('.fallbackIcon');
                if (fallback) fallback.destroy();

                const node = new Konva.Image({
                    name: 'displayNode',
                    image: img,
                    width: targetW,
                    height: targetH
                });
                item.group.add(node);
                this._placeLoadedDisplayNode(item, node, token);

                if (this.selectedItems.has(item.data.id)) {
                    this._updateSelectionVisuals();
                }
                this._finishLoad(item, token);
                item.group.getLayer()?.batchDraw();
            };
            img.onerror = () => void this._failImageLoad(item, token);
            img.src = dataUrl;
        } catch (err) {
            await this._failImageLoad(item, token);
            console.warn('[Canvas] _loadLowRes 失败:', item.data.filePath, err);
        }
    }

    async _loadThumbnail(item, token, retryCount = 0) {
        const MAX_RETRIES = 5;
        const RETRY_DELAY = 1500; // ms
        const group = item.group;
        const data = item.data;
        const filePath = data.filePath;

        try {
            const imgUrl = 'local-res://' + encodeURIComponent(filePath);

            const imgObj = new window.Image();
            imgObj.onload = () => {
                if (!this._isLoadCurrent(item, token)) {
                    this._completeContentLoad(item);
                    return;
                }

                const { width: targetW, height: targetH } = this._resolveMediaDisplaySize(data, imgObj.width, imgObj.height);

                this._storeResolvedMediaSize(item, targetW, targetH);

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
                this._placeLoadedDisplayNode(item, imageNode, token);

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
                    item.gifDomElement = gifImg;
                    group.on('dragmove.gif', () => this.syncGifs());

                    // 鼠标移入 -> 显示 GIF 动画层, 移出 -> 隐藏(只显示 Konva 静态首帧)
                    group.on('mouseenter.gif', () => {
                        if (!item.loaded) return;
                        this.syncGifs();
                        gifImg.style.display = 'block';
                    });
                    group.on('mouseleave.gif', () => {
                        gifImg.style.display = 'none';
                    });

                    this.syncGifs();
                }

                this._finishLoad(item, token);
                group.getLayer().batchDraw();
            };
            imgObj.onerror = async () => {
                if (!this._isLoadCurrent(item, token)) {
                    this._completeContentLoad(item);
                    return;
                }
                const fileExists = await this._inspectMediaFileExists(filePath);
                if (!this._isLoadCurrent(item, token)) {
                    this._completeContentLoad(item);
                    return;
                }
                if (fileExists === false) {
                    this._failLoad(item, token, '文件失联');
                    return;
                }
                if (retryCount < MAX_RETRIES) {
                    console.warn(`[Canvas] 图片加载失败，${RETRY_DELAY}ms 后重试 (${retryCount + 1}/${MAX_RETRIES}):`, filePath);
                    setTimeout(() => {
                        if (this._isLoadCurrent(item, token)) {
                            this._loadThumbnail(item, token, retryCount + 1);
                        }
                    }, RETRY_DELAY);
                } else {
                    console.error('[Canvas] 图片加载最终失败（已重试' + MAX_RETRIES + '次）:', filePath);
                    this._failLoad(item, token, fileExists === true ? '无法解码' : '加载失败');
                }
            };
            imgObj.src = imgUrl;
        } catch (err) {
            await this._failImageLoad(item, token);
            console.error('[Canvas] 图片异常:', filePath, err);
        }
    }

    // ── 视频内嵌播放 ──────────────────────────────────────
    _loadVideo(item, token) {
        const group = item.group;
        const data = item.data;
        const VIDEO_W = IMAGE_DEFAULT_WIDTH;
        const VIDEO_H = VIDEO_W * 9 / 16; // 默认 16:9

        // 创建一个隐藏的 HTML video 元素
        const video = document.createElement('video');
        video.src = 'local-res://' + encodeURIComponent(data.filePath);
        item.videoMuted = item.videoMuted !== false;
        video.muted = item.videoMuted;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.style.display = 'none';
        item.videoElement = video;
        document.body.appendChild(video);

        video.addEventListener('loadeddata', () => {
            if (!this._isLoadCurrent(item, token)) {
                this._disposeVideoElement(video);
                if (item.videoElement === video) item.videoElement = null;
                this._completeContentLoad(item);
                return;
            }

            const aspect = video.videoWidth / video.videoHeight;
            const savedW = Number(data.width) || 0;
            const savedH = Number(data.height) || 0;
            const hasSavedSize = savedW > 0 && savedH > 0;
            const looksLikePlaceholder = hasSavedSize
                && Math.abs(savedW - savedH) < 1
                && Math.abs(savedW - DOC_DEFAULT_SIZE) < 1;
            const w = looksLikePlaceholder ? VIDEO_W : (savedW || VIDEO_W);
            const h = w / aspect;

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
            this._placeLoadedDisplayNode(item, videoImage, token);

            // -- 进度条和控制按钮 --
            const controlsGroup = new Konva.Group({
                name: 'videoControls',
                x: 0,
                y: h - VIDEO_CONTROL_HEIGHT,
                opacity: 1,
                listening: true
            });

            const ctrlBg = new Konva.Rect({
                name: 'videoControlBg',
                width: w,
                height: VIDEO_CONTROL_HEIGHT,
                fill: 'rgba(0,0,0,0.52)',
                visible: false
            });

            const playPauseIcon = this._createVideoPlayPauseGlyph(false);
            const volumeIcon = this._createVideoVolumeGlyph(video.muted);
            volumeIcon.x(VIDEO_CONTROL_BUTTON_WIDTH * 1.5);

            // 增大按钮的热区
            const playPauseHotspot = new Konva.Rect({
                name: 'videoControlHotspot videoPlayPauseHotspot',
                width: VIDEO_CONTROL_BUTTON_WIDTH, height: VIDEO_CONTROL_HEIGHT, x: 0, y: 0,
                fill: 'transparent'
            });
            const volumeHotspot = new Konva.Rect({
                name: 'videoControlHotspot videoVolumeHotspot',
                width: VIDEO_CONTROL_BUTTON_WIDTH,
                height: VIDEO_CONTROL_HEIGHT,
                x: VIDEO_CONTROL_BUTTON_WIDTH,
                y: 0,
                fill: 'transparent'
            });

            // 进度条背景
            const progressBg = new Konva.Rect({
                name: 'videoProgressBg',
                x: VIDEO_CONTROL_PROGRESS_X,
                y: 12,
                width: Math.max(0, w - VIDEO_CONTROL_PROGRESS_X - VIDEO_CONTROL_PROGRESS_RIGHT_PADDING),
                height: 4,
                fill: '#555',
                cornerRadius: 2,
                visible: false
            });

            // 进度条前景
            const progressFg = new Konva.Rect({
                name: 'videoProgressFg',
                x: VIDEO_CONTROL_PROGRESS_X, y: 12, width: 0, height: 4, fill: '#b9bcc2', cornerRadius: 2, visible: false
            });

            // 进度条热区，方便点击
            const progressHotspot = new Konva.Rect({
                name: 'videoProgressHotspot',
                x: VIDEO_CONTROL_PROGRESS_X,
                y: 0,
                width: Math.max(0, w - VIDEO_CONTROL_PROGRESS_X - VIDEO_CONTROL_PROGRESS_RIGHT_PADDING),
                height: VIDEO_CONTROL_HEIGHT,
                fill: 'transparent', visible: false
            });

            controlsGroup.add(
                ctrlBg,
                progressBg,
                progressFg,
                playPauseIcon,
                volumeIcon,
                playPauseHotspot,
                volumeHotspot,
                progressHotspot
            );
            group.add(controlsGroup);
            this._layoutVideoControlGroup(controlsGroup, w, h);

            // 控制逻辑 —— 用 mousedown 替代 click，避免 Konva 动画层干扰点击检测
            const revealTimeline = () => {
                ctrlBg.visible(true);
                progressBg.visible(true);
                progressFg.visible(true);
                progressHotspot.visible(true);
            };
            const playVideo = () => {
                revealTimeline();
                return video.play().then(() => {
                    anim.start();
                    this._setVideoPlayPauseGlyph(playPauseIcon, true);
                    group.getLayer()?.batchDraw();
                }).catch(() => { });
            };
            playPauseHotspot.on('mousedown', (e) => {
                if (e.evt?.button != null && e.evt.button !== 0) return;
                if (this._pickMediaReferenceFromControl(item, e)) return;
                e.cancelBubble = true;
                e.evt.stopPropagation();
                if (video.paused) {
                    playVideo();
                } else {
                    video.pause();
                    anim.stop();
                    this._setVideoPlayPauseGlyph(playPauseIcon, false);
                    group.getLayer()?.batchDraw();
                }
            });
            volumeHotspot.on('mousedown', (e) => {
                if (e.evt?.button != null && e.evt.button !== 0) return;
                if (this._pickMediaReferenceFromControl(item, e)) return;
                e.cancelBubble = true;
                e.evt.stopPropagation();
                video.muted = !video.muted;
                item.videoMuted = video.muted;
                this._setVideoVolumeGlyph(volumeIcon, video.muted);
                group.getLayer()?.batchDraw();
            });

            // 进度跳转逻辑
            progressHotspot.on('mousedown', (e) => {
                if (e.evt?.button != null && e.evt.button !== 0) return;
                if (this._pickMediaReferenceFromControl(item, e)) return;
                e.cancelBubble = true;
                e.evt.stopPropagation();
                const ptrX = group.getRelativePointerPosition().x;
                let percent = (ptrX - progressHotspot.x()) / Math.max(1, progressHotspot.width());
                percent = Math.max(0, Math.min(1, percent));
                video.currentTime = video.duration * percent;
            });

            // 播放视频动画帧刷新
            const anim = new Konva.Animation(() => {
                if (!video.paused && video.duration) {
                    progressFg.width((video.currentTime / video.duration) * progressBg.width());
                }
            }, group.getLayer());
            // 不立即启动，视频播放时才 start

            // 存储引用到 item entry，方便 clearAll/removeItemById 释放
            item.videoElement = video;
            item.videoAnimation = anim;

            this._finishLoad(item, token);
            if (item.autoPlayVideo) {
                item.autoPlayVideo = false;
                playVideo();
            }
            group.getLayer().batchDraw();
        }, { once: true });

        video.addEventListener('error', () => {
            this._handleVideoLoadError(item, token, video);
        });
    }

    addFile(filePath) {
        if (this._isInternalProcessFile(filePath)) return null;
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
        this._scheduleCullCheck(); // 新卡片创建后补加载内容
        this._refreshCanvasBoundary();
        return data;
    }

    removeFile(filePath) {
        // 移除所有与此 filePath 关联的条目（可能有 Ctrl+拖拽的副本）
        const idsToRemove = [];
        const targetPath = normalizePathForCompare(resolveCanvasFilePath(filePath));
        if (!targetPath) return;
        this.items.forEach((item, id) => {
            if (normalizePathForCompare(resolveCanvasFilePath(item.data.filePath)) === targetPath) idsToRemove.push(id);
        });
        this._removeGeneratorResultsForFilePath(filePath);
        idsToRemove.forEach(id => this.removeItemById(id));
    }

    _removeGeneratorResultsForFilePath(filePath, excludeNodeId = '') {
        let changed = false;
        this.items.forEach(({ data }, id) => {
            if (id === excludeNodeId || data?.kind !== 'op' || !['image', 'video'].includes(data.nodeType)) return;
            const removed = removeGeneratorResultByFilePath(data, filePath);
            if (!removed.changed) return;
            changed = true;
            if (removed.entries.length === 0 && data.runStatus !== STATUS.RUNNING && data.runStatus !== STATUS.QUEUED) {
                data.runStatus = STATUS.IDLE;
                data.runError = '';
            }
            this.refreshOpNode(id);
        });
        return changed;
    }

    removeItemById(id) {
        const item = this.items.get(id);
        if (item) {
            if (item.data.filePath) this._removeGeneratorResultsForFilePath(item.data.filePath, id);
            this._removePersistentTextEditor(id);
            if (this._activeImageCrop?.itemId === id) this._closeImageCrop({ silent: true });
            if (this._hoveredMediaItemId === id) this._setHoveredMediaItem(null);
            if (this._activeOpPromptEditor?.nodeId === id) {
                this._closeInlineOpPromptEditor({ commit: false });
            }
            if (this._activeMediaTitleEditor?.nodeId === id) {
                this._closeMediaTitleEditor({ commit: false });
            }
            if (this._generationComposer?.nodeId === id) {
                this._closeGenerationComposer({ commit: false });
            }
            if (this._activeNodeReferenceTargetId === id) {
                this.endMediaReferencePick({ silent: true, clearHighlights: true });
            }
            if (this._planReferencePickTargetId === id) {
                this._planReferencePickTargetId = null;
            }
            if (
                this._selectedPlanConnection
                && this._referenceMatchesItem(this._selectedPlanConnection.reference, id, item.data.filePath)
            ) {
                this._selectedPlanConnection = null;
                this._clearPlanConnectionFocusState();
            }
            this._removeItemFromPlanReferences(id, item.data.filePath);
            this.graphView?.removeNode(id);
            this.selectedItems.delete(id);
            clearTimeout(item.hoverTimer);
            item.hoverTimer = null;
            this._unloadContent(item);
            item.group.destroy();
            this.items.delete(id);
            this._refreshCanvasBoundary();
        }
    }

    updateItemFilePath(id, filePath, options = {}) {
        const item = this.items.get(id);
        const samePath = item && normalizePathForCompare(item.data.filePath) === normalizePathForCompare(filePath);
        if (!item || !filePath || (samePath && !options.forceReload)) return false;

        const oldPath = item.data.filePath;
        const keepWidth = Number(item.data.width) || null;
        this._unloadContent(item);
        item.data.filePath = filePath;
        item.data.mediaType = this._getFileType(filePath);
        if (options.reflowToNewAspect) {
            item.data.width = keepWidth || IMAGE_DEFAULT_WIDTH;
            delete item.data.height;
        }
        item.loadError = false;
        item.loadErrorMessage = '';
        item.group.setAttr('filePath', filePath);
        item.group.findOne('.fallbackIcon')?.destroy();
        const fallbackSize = this._mediaPlaceholderSize(item.data.mediaType, item.data);
        item.group.add(this._createFallbackGroup(
            item.data.mediaType,
            fallbackSize.width,
            fallbackSize.height,
            item.data.filePath
        ));
        this._syncExternalNodeTitle(item.group, item.data, item.data.mediaType);
        this.graphView?.renderPorts(id);
        this.graphView?.scheduleSync(id);
        this._updatePlanReferencesForMovedItem(id, oldPath, filePath);
        this._scheduleCullCheck();
        this.emit('change');
        return true;
    }

    _removeItemFromPlanReferences(itemId, filePath) {
        let changed = false;
        this.planService?.listPlans?.().forEach(plan => {
            (plan.rows || []).forEach(row => {
                const before = row.references?.length || 0;
                row.references = (row.references || []).filter(reference =>
                    reference.itemId !== itemId && reference.filePath !== filePath
                );
                if ((row.references?.length || 0) !== before) {
                    this._syncRowAssetCell(row);
                    changed = true;
                }
            });
        });
        if (changed) {
            this.emit('plansChanged');
        }
    }

    _updatePlanReferencesForMovedItem(itemId, oldPath, newPath) {
        let changed = false;
        this.planService?.listPlans?.().forEach(plan => {
            (plan.rows || []).forEach(row => {
                (row.references || []).forEach(reference => {
                    if (reference.itemId === itemId || reference.filePath === oldPath) {
                        reference.itemId = itemId;
                        reference.filePath = newPath;
                        reference.name = this._fileNameFromPath(newPath);
                        changed = true;
                    }
                });
                if (changed) this._syncRowAssetCell(row);
            });
        });
        if (changed) {
            this.renderPlans();
            this.emit('plansChanged');
        }
    }

    _hasFilePath(filePath) {
        return Boolean(this._findItemByFilePath(filePath));
    }

    _findItemByFilePath(filePath) {
        const targetPath = normalizePathForCompare(resolveCanvasFilePath(filePath));
        if (!targetPath) return null;
        for (let [id, item] of this.items.entries()) {
            if (normalizePathForCompare(resolveCanvasFilePath(item.data.filePath)) === targetPath) return item;
            if (item.data.kind === 'op' && getGeneratorResultEntries(item.data).some(result =>
                normalizePathForCompare(resolveCanvasFilePath(result.filePath)) === targetPath
            )) return item;
        }
        return null;
    }

    _applyPlanFilterVisibility() {
        const types = Array.isArray(this.currentFilter) ? this.currentFilter : [this.currentFilter];
        const showPlans = types.includes('all') || types.length === 0 || types.includes('other');
        const previousSelection = new Set(this.selectedItems);
        let removedSelectedPlan = false;
        this.plans.forEach((plan, id) => {
            if (showPlans) {
                plan.group.show();
            } else {
                plan.group.hide();
                if (this.selectedItems.has(id)) removedSelectedPlan = true;
                this.selectedItems.delete(id);
            }
            const editor = this.planInlineEditors?.get(id);
            if (editor) editor.style.display = showPlans ? '' : 'none';
        });
        if (removedSelectedPlan) {
            this._refreshSelectionVisualState(previousSelection);
        }
    }

    setFilter(types) {
        this.currentFilter = types; // 现在是数组
        this.items.forEach((item, id) => {
            if (item.data?.kind === 'op') {
                item.group.show();
                return;
            }
            const filePath = item.data.filePath;
            if (this._isInternalProcessFile(filePath)) {
                item.group.hide();
                if (item.gifDomElement) item.gifDomElement.style.display = 'none';
                return;
            }
            if (types.includes('all') || types.length === 0 || types.includes(this._getItemMediaType(item.data))) {
                item.group.show();
                if (item.gifDomElement) item.gifDomElement.style.display = '';
            } else {
                item.group.hide();
                if (item.gifDomElement) item.gifDomElement.style.display = 'none';
            }
        });
        this._applyPlanFilterVisibility();
        this.layer.batchDraw();
        this._updateSelectionVisuals();
        this.syncGifs();
        this.syncPlanInlineEditors();
        this._scheduleMinimapDraw();
    }

    /**
     * 获取目标 items：有框选则返回框选的，否则返回全部可见的
     */
    _getTargetItems() {
        const targetItems = [];
        if (this.selectedItems.size > 0) {
            // 有框选内容，只操作框选的 items
            this._forEachNode(item => {
                if (this.selectedItems.has(item.data.id) && item.group.isVisible()) {
                    targetItems.push(item);
                }
            });
        } else {
            // 没有框选，操作全部可见内容
            this._forEachNode(item => {
                if (item.group.isVisible()) {
                    targetItems.push(item);
                }
            });
        }
        return targetItems;
    }
    exportAsMd() {
        if (this.items.size === 0 && this.plans.size === 0) return;

        // 按照视觉上的排列顺序导出（从上到下，从左到右）
        const sortedItems = Array.from(this.items.values()).sort((a, b) => {
            const rowDiff = Math.abs(a.group.y() - b.group.y());
            if (rowDiff < 50) return a.group.x() - b.group.x();
            return a.group.y() - b.group.y();
        });
        const sortedPlans = Array.from(this.plans.values()).sort((a, b) => {
            const rowDiff = Math.abs(a.group.y() - b.group.y());
            if (rowDiff < 50) return a.group.x() - b.group.x();
            return a.group.y() - b.group.y();
        });

        const escapeMarkdownLabel = (text) => String(text || '').replace(/([\\[\]])/g, '\\$1');
        const escapeMarkdownDestination = (text) => String(text || '').replace(/>/g, '\\>');
        const isImageFile = (filePath) => /\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|svg|ico)$/i.test(filePath);
        const toFileUri = (filePath) => {
            const normalized = String(filePath || '').replace(/\\/g, '/');
            if (normalized.startsWith('//')) {
                const parts = normalized.slice(2).split('/');
                const host = encodeURIComponent(parts.shift() || '');
                return `file://${host}/${parts.map(part => encodeURIComponent(part)).join('/')}`;
            }

            return 'file:///' + normalized.split('/').map((part, index) => {
                if (index === 0 && /^[A-Za-z]:$/.test(part)) return part;
                return encodeURIComponent(part);
            }).join('/');
        };
        const toMarkdownReference = (filePath) => {
            const name = filePath.split(/[/\\]/).pop() || filePath;
            const label = escapeMarkdownLabel(name);
            const destination = escapeMarkdownDestination(filePath);
            return isImageFile(filePath)
                ? `![${label}](<${destination}>)`
                : `[${label}](<${destination}>)`;
        };
        const stringifyAsciiJson = (value) => JSON.stringify(value, null, 2)
            .replace(/[^\x00-\x7F]/g, char => char.split('')
                .map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
                .join(''));

        const exportedItems = [];
        sortedItems.forEach(item => {
            const filePath = item.data.filePath;
            if (filePath) {
                const fileName = filePath.split(/[/\\]/).pop();
                const type = this._getFileType(filePath);
                exportedItems.push({
                    index: exportedItems.length + 1,
                    id: item.data.id,
                    name: fileName,
                    type,
                    path: filePath,
                    fileUri: toFileUri(filePath),
                    markdown: toMarkdownReference(filePath),
                    canvas: {
                        x: item.group.x(),
                        y: item.group.y(),
                        width: item.data.width || DOC_DEFAULT_SIZE,
                        height: item.data.height || DOC_DEFAULT_SIZE
                    }
                });
            }
        });

        const exportedPlans = sortedPlans.map((entry, index) => {
            const plan = entry.data;
            const columns = plan.columns || [];
            const rows = plan.rows || [];
            return {
                index: index + 1,
                id: plan.id,
                title: plan.title,
                schemaVersion: plan.schemaVersion || 1,
                columns: columns.map(column => ({ key: column.key, label: column.label })),
                rows: rows.map(row => ({ id: row.id, cells: { ...(row.cells || {}) } })),
                references: rows.map(row => ({
                    rowId: row.id,
                    files: [...(row.references || [])]
                })),
                canvas: {
                    x: entry.group.x(),
                    y: entry.group.y(),
                    width: plan.node?.width || plan.width || PLAN_NODE_WIDTH,
                    height: plan.node?.height || plan.height || PLAN_NODE_HEIGHT
                }
            };
        });

        const payload = {
            schema: 'flow-canvas.references.v1',
            encoding: 'utf-8',
            itemCount: exportedItems.length,
            planCount: exportedPlans.length,
            items: exportedItems,
            plans: exportedPlans
        };

        const markdownSections = [
            '# Flow Canvas References',
            '',
            'This file is exported for AI IDEs and scripts. Prefer the JSON block for parsing.',
            'The JSON block is ASCII escaped, so paths remain machine-readable even if a viewer misdetects text encoding.',
            '',
            '## Machine Readable JSON',
            '',
            '```json',
            stringifyAsciiJson(payload),
            '```',
            ''
        ];

        if (exportedItems.length > 0) {
            markdownSections.push(
                '## Plain Paths',
                '',
                '```text',
                ...exportedItems.map(item => item.path),
                '```',
                '',
                '## Markdown References',
                '',
                ...exportedItems.map(item => `${item.index}. ${item.markdown}`),
                ''
            );
        }

        if (exportedPlans.length > 0) {
            markdownSections.push(
                '## Planning Matrices',
                '',
                ...sortedPlans.flatMap(entry => [formatPlanMarkdown(entry.data, 3), ''])
            );
        }

        const markdownContent = markdownSections.join('\n');

        const blob = new Blob(['\ufeff', markdownContent], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `flow-canvas-references.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    fitAll() {
        if (this.items.size === 0 && this.plans.size === 0) return;
        const targetItems = this._getTargetItems();
        if (targetItems.length === 0) return;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        targetItems.forEach(item => {
            const g = item.group;
            const node = g.findOne('.displayNode') || g.findOne('.fallbackIcon') || g.findOne('.planHitArea');
            const w = node ? (node.width() || DOC_DEFAULT_SIZE) : DOC_DEFAULT_SIZE;
            const h = node ? (node.height() || DOC_DEFAULT_SIZE) : DOC_DEFAULT_SIZE;
            const titleY = Number(g.findOne('.externalNodeTitle')?.y?.()) || 0;
            minX = Math.min(minX, g.x()); minY = Math.min(minY, g.y() + Math.min(0, titleY));
            maxX = Math.max(maxX, g.x() + w); maxY = Math.max(maxY, g.y() + h);
        });
        if (minX === Infinity) return;
        const container = this.stage.container();
        const floatingToolsVisible = document.body.classList.contains('sidebar-closed');
        const inset = {
            left: floatingToolsVisible ? 250 : 32,
            top: floatingToolsVisible ? 82 : 42,
            right: 32,
            bottom: 76
        };
        const contentWidth = Math.max(1, maxX - minX);
        const contentHeight = Math.max(1, maxY - minY);
        const availableWidth = Math.max(1, container.offsetWidth - inset.left - inset.right);
        const availableHeight = Math.max(1, container.offsetHeight - inset.top - inset.bottom);
        const scaleX = availableWidth / contentWidth;
        const scaleY = availableHeight / contentHeight;
        const scale = Math.min(scaleX, scaleY, 1);
        this.stage.scale({ x: scale, y: scale });
        this.stage.position({
            x: inset.left + (availableWidth - contentWidth * scale) / 2 - minX * scale,
            y: inset.top + (availableHeight - contentHeight * scale) / 2 - minY * scale
        });
        this.stage.batchDraw();
        this.syncBackground();
        this.syncGifs();
        this.syncPlanInlineEditors();
        this.graphView?.sync();
        this._syncCanvasViewDock();
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
            const node = item.group.findOne('.displayNode') || item.group.findOne('.fallbackIcon') || item.group.findOne('.planHitArea');
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
                this._setEntryNodePosition(obj.item, currentX, currentY);

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
                this._setEntryNodePosition(obj.item, currentX, currentY);

                currentX += obj.w + padding;
                rowHeight = Math.max(rowHeight, obj.h);
            });
        }

        setTimeout(() => { this.emit('change'); this.syncGifs(); }, 300);
    }
}

function resolveCanvasFilePath(filePath) {
    const raw = String(filePath || '');
    if (!raw.toLowerCase().startsWith('local-res://')) return raw;
    try {
        return decodeURIComponent(raw.slice('local-res://'.length));
    } catch (_) {
        return raw.slice('local-res://'.length);
    }
}

function normalizePathForCompare(filePath) {
    const raw = String(filePath || '');
    if (!raw) return '';
    const normalized = raw
        .normalize('NFC')
        .replace(/\\/g, '/')
        .replace(/\/+$/g, '') || '/';
    return window.flowCanvas?.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatPlanMarkdown(plan, headingLevel = 1) {
    const columns = plan.columns || [];
    const rows = plan.rows || [];
    const titlePrefix = '#'.repeat(Math.max(1, Math.min(6, headingLevel)));

    return [
        `${titlePrefix} ${plan.title || '规划矩阵'}`,
        '',
        `| ${columns.map(column => column.label).join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
        ...rows.map(row => `| ${columns.map(column => escapeMarkdownCell(row.cells?.[column.key] || '')).join(' | ')} |`)
    ].join('\n');
}

function escapeMarkdownCell(value) {
    return String(value ?? '')
        .replace(/\|/g, '\\|')
        .replace(/\r?\n/g, '<br>');
}
