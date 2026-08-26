/**
 * 节点图渲染层：端口、连线、拖拽连接、执行状态。
 * 依赖 Konva 与 canvas 实例，纯数据计算全部委托 graph-model.js。
 */

import * as G from './graph-model.js';
import { NODE_TYPES } from './node-types.js';
import { nodeIconSvg } from './node-icons.js';
import { getGeneratorPlaceholderSize } from './generator-placeholder-layout.js';

const PORT_RADIUS = 9;
const PORT_GAP = 24;
const PORT_HIT = 14;
const EDGE_COLOR = '#46474a';
const EDGE_HISTORY_COLOR = '#3d3e41';
const EDGE_WIDTH = 3.2;
const EDGE_HISTORY_WIDTH = 2.2;

export function viewportFixedScale(stageScale, baseScale = 1) {
    const normalizedScale = Math.max(0.01, Number(stageScale) || 1);
    return (Number(baseScale) || 1) / normalizedScale;
}

const NODE_MENU_COPY = {
    text: { title: '文本生成', description: '脚本、广告词、品牌文案' },
    image: { title: '图片生成', description: '提示词与参考图生成图片' },
    video: { title: '视频生成', description: '提示词与参考图生成视频' },
    batch: { title: '批量生成', description: '展开多组生成任务' }
};

const DATA_TYPE_COLORS = {
    string: '#7dd3fc',
    number: '#fcd34d',
    image: '#c4b5fd',
    video: '#f9a8d4',
    file: '#a3a3a3',
    any: '#94a3b8'
};

export function portColor(dataType) {
    return DATA_TYPE_COLORS[dataType] || DATA_TYPE_COLORS.any;
}

export function boxIntersectsViewport(box, viewport, margin = 0) {
    if (!box || !viewport) return false;
    return box.x + box.width >= viewport.x - margin
        && box.x <= viewport.x + viewport.width + margin
        && box.y + box.height >= viewport.y - margin
        && box.y <= viewport.y + viewport.height + margin;
}

export function getCompatibleNodeOptions(drag) {
    if (!drag?.port?.dataType || (drag.side !== 'in' && drag.side !== 'out')) return [];
    const options = [];
    Object.entries(NODE_TYPES).forEach(([nodeType, def]) => {
        const candidate = { id: `candidate-${nodeType}`, kind: 'op', nodeType };
        const ports = G.getPorts(candidate);
        const candidates = drag.side === 'out' ? ports.inputs : ports.outputs;
        const compatible = candidates
            .filter(candidatePort => drag.side === 'out'
                ? G.portsCompatible(drag.port, candidatePort)
                : G.portsCompatible(candidatePort, drag.port))
            .sort((left, right) => {
                const leftExact = left.dataType === drag.port.dataType ? 1 : 0;
                const rightExact = right.dataType === drag.port.dataType ? 1 : 0;
                return rightExact - leftExact;
            })[0];
        if (compatible) options.push({ nodeType, def, port: compatible });
    });
    return options;
}

// id 生成沿用 canvas.js:2080 的惯例，c_ 前缀区分连线
function newConnectionId() {
    return 'c_' + Date.now().toString() + Math.random().toString(36).substr(2, 5);
}

export class GraphView {
    constructor(canvas, Konva) {
        this.canvas = canvas;
        this.Konva = Konva;
        this.connections = [];
        this.portShapes = new Map();   // nodeId -> [{shape, port, side}]
        this.edgeShapes = new Map();   // connectionId -> Konva.Line
        this.connectionsVisible = true;
        this.hoveredNodeIds = new Set();
        this.pending = null;           // 正在拖拽的连线
        this.connectionNodeMenu = null;
        this.connectionNodeMenuState = null;
        this._connectionNodeMenuClose = null;
        this._connectionNodeMenuKeydown = null;
        this._syncRaf = 0;             // 拖拽时合帧刷新的 rAF 句柄
        this._pendingScope = null;     // 本帧待刷新的节点范围
        this._fullScopePending = false;// 本帧是否需要全量刷新
        this._visiblePortsTimer = null;

        this.edgeLayer = new Konva.Layer({ listening: true });
        canvas.stage.add(this.edgeLayer);
        this.edgeLayer.moveToBottom();
        this.portLayer = new Konva.Layer({ listening: true });
        canvas.stage.add(this.portLayer);
        this.portLayer.moveToTop();
        canvas.transientLayer?.moveToTop();

        // 连线拖拽由 document 级 mousemove/mouseup 单路径驱动（移植自 Infinite-Canvas
        // 的 portDragState 模型）。只有在拖拽中（this.pending 存在）才介入，否则完全放行，
        // 不影响画布平移/框选。
        // 关键：不要再用 window 的 pointerup 去 cancelPending——原生 pointerup 早于
        // Konva 合成的 stage mouseup 触发，会在 _endDrag 之前把 pending 清空，导致连接永远
        // 建立不起来。改由 mouseup 统一走 _endDrag：命中目标就连线，没命中就清理，
        // 在窗口任意位置松手都能收到，顺带解决“画布外松手黏手”。
        this._onDocMove = (e) => { if (this.pending) this._syncPending(e); };
        this._onDocUp = (e) => { if (this.pending) this._endDrag(e); };
        document.addEventListener('mousemove', this._onDocMove);
        document.addEventListener('mouseup', this._onDocUp);
    }

    /** 放弃当前正在拖拽的连线（不建立连接），清理残留的 pending 状态 */
    cancelPending() {
        if (!this.pending) return;
        this.pending.line.destroy();
        this.pending = null;
        this.edgeLayer.batchDraw();
    }

    destroy() {
        clearTimeout(this._visiblePortsTimer);
        this.closeConnectionNodeMenu();
        document.removeEventListener('mousemove', this._onDocMove);
        document.removeEventListener('mouseup', this._onDocUp);
    }

    /** 节点在画布坐标系下的尺寸 */
    _nodeSize(nodeId) {
        const item = this.canvas.items.get(nodeId);
        const group = item?.group || this.canvas.plans.get(nodeId)?.group;
        if (!group) return null;
        const data = item?.data || this.canvas.plans.get(nodeId)?.data || {};
        const display = group.findOne?.('.displayNode')
            || group.findOne?.('.fallbackBg')
            || group.findOne?.('.planHitArea');
        const width = Number(data.width) || Number(display?.width?.()) || 1;
        const height = Number(data.height) || Number(display?.height?.()) || 1;
        return { x: group.x(), y: group.y(), width, height };
    }

    /** 端口在画布坐标系下的中心点 */
    portPosition(nodeId, portName, side) {
        const box = this._nodeSize(nodeId);
        if (!box) return null;
        const node = this._nodeData(nodeId);
        const ports = G.getPorts(node);
        const list = side === 'in' ? ports.inputs : ports.outputs;
        const index = list.findIndex(p => p.name === portName);
        if (index < 0) return null;
        const total = list.length;
        const spread = (total - 1) * PORT_GAP;
        const startY = box.y + box.height / 2 - spread / 2;
        return {
            x: side === 'in' ? box.x : box.x + box.width,
            y: startY + index * PORT_GAP
        };
    }

    _nodeData(nodeId) {
        const item = this.canvas.items.get(nodeId);
        if (item?.data) return item.data;
        const plan = this.canvas.plans.get(nodeId);
        return plan?.data || null;
    }

    /** 所有节点的数据快照，供 graph-model 校验使用 */
    _allNodes() {
        const nodes = [];
        this.canvas.items.forEach(item => { if (item?.data) nodes.push(item.data); });
        return nodes;
    }

    _portConnected(nodeId, portName, side) {
        return this.connections.some(connection =>
            (side === 'in' && connection.to.nodeId === nodeId && connection.to.port === portName)
            || (side === 'out' && connection.from.nodeId === nodeId && connection.from.port === portName)
        );
    }

    _portOpacity(nodeId, portName, side) {
        if (this._portConnected(nodeId, portName, side)) return 0.86;
        if (this.hoveredNodeIds.has(nodeId)) return 0.68;
        return this._nodeData(nodeId)?.kind === 'op' ? 0.5 : 0;
    }

    setNodeHovered(nodeId, hovered) {
        if (hovered) this.hoveredNodeIds.add(nodeId);
        else this.hoveredNodeIds.delete(nodeId);
        if (hovered && !this.portShapes.has(nodeId)) this.renderPorts(nodeId);
        this.refreshPortVisibility(nodeId);
    }

    refreshPortVisibility(nodeId = null) {
        this.portShapes.forEach((entries, currentNodeId) => {
            if (nodeId && currentNodeId !== nodeId) return;
            entries.forEach(entry => {
                entry.shape.opacity(this._portOpacity(currentNodeId, entry.port.name, entry.side));
            });
        });
        this.portLayer.batchDraw();
    }

    _viewportWorldBounds() {
        const scale = this.canvas.stage.scaleX() || 1;
        const position = this.canvas.stage.position();
        return {
            x: -position.x / scale,
            y: -position.y / scale,
            width: this.canvas.stage.width() / scale,
            height: this.canvas.stage.height() / scale
        };
    }

    _shouldMaintainPorts(nodeId) {
        const node = this._nodeData(nodeId);
        if (!node) return false;
        if (node.kind === 'op') return true;
        if (this.hoveredNodeIds.has(nodeId) || this.canvas.selectedItems?.has(nodeId)) return true;
        if (this.connections.some(connection => connection.from.nodeId === nodeId || connection.to.nodeId === nodeId)) {
            return true;
        }
        const entry = this.canvas.items.get(nodeId);
        if (!entry?.group?.isVisible?.()) return false;
        return boxIntersectsViewport(this._nodeSize(nodeId), this._viewportWorldBounds(), 120);
    }

    renderPorts(nodeId) {
        this.clearPorts(nodeId);
        const node = this._nodeData(nodeId);
        if (!node || !this._shouldMaintainPorts(nodeId)) return;
        const ports = G.getPorts(node);
        const entries = [];

        const build = (list, side) => {
            list.forEach(port => {
                const pos = this.portPosition(nodeId, port.name, side);
                if (!pos) return;
                const shape = new this.Konva.Group({
                    x: pos.x,
                    y: pos.y,
                    name: 'graphPort',
                    opacity: this._portOpacity(nodeId, port.name, side),
                    scaleX: viewportFixedScale(this.canvas.stage.scaleX()),
                    scaleY: viewportFixedScale(this.canvas.stage.scaleY())
                });
                const hit = new this.Konva.Circle({
                    radius: PORT_HIT,
                    fill: 'rgba(255,255,255,0.001)',
                    listening: true
                });
                const body = new this.Konva.Circle({
                    radius: PORT_RADIUS,
                    fill: '#1a1b1d',
                    stroke: '#686b71',
                    strokeWidth: 1.2,
                    listening: false
                });
                const horizontal = new this.Konva.Line({
                    points: [-3.5, 0, 3.5, 0],
                    stroke: '#a3a6ac',
                    strokeWidth: 1.45,
                    lineCap: 'round',
                    listening: false
                });
                const vertical = new this.Konva.Line({
                    points: [0, -3.5, 0, 3.5],
                    stroke: '#a3a6ac',
                    strokeWidth: 1.45,
                    lineCap: 'round',
                    listening: false
                });
                shape.add(hit, body, horizontal, vertical);
                shape.on('mouseenter', () => {
                    shape.opacity(1);
                    body.radius(PORT_RADIUS + 1.5);
                    body.stroke(portColor(port.dataType));
                    horizontal.stroke('#f1f2f3');
                    vertical.stroke('#f1f2f3');
                    document.body.style.cursor = 'crosshair';
                    this.portLayer.batchDraw();
                });
                shape.on('mouseleave', () => {
                    shape.opacity(this._portOpacity(nodeId, port.name, side));
                    body.radius(PORT_RADIUS);
                    body.stroke('#686b71');
                    horizontal.stroke('#a3a6ac');
                    vertical.stroke('#a3a6ac');
                    document.body.style.cursor = 'default';
                    this.portLayer.batchDraw();
                });
                shape.on('mousedown touchstart', evt => {
                    evt.cancelBubble = true;
                    this._beginDrag(nodeId, port, side);
                });
                this.portLayer.add(shape);
                entries.push({ shape, port, side });
            });
        };

        build(ports.inputs, 'in');
        build(ports.outputs, 'out');
        this.portShapes.set(nodeId, entries);
        this.portLayer.batchDraw();
    }

    syncViewportControlScale(stageScale = this.canvas.stage.scaleX()) {
        const scale = viewportFixedScale(stageScale);
        this.portShapes.forEach(entries => {
            entries.forEach(entry => entry.shape.scale({ x: scale, y: scale }));
        });
        this.portLayer.batchDraw();
    }

    clearPorts(nodeId) {
        const entries = this.portShapes.get(nodeId);
        if (!entries) return;
        entries.forEach(entry => entry.shape.destroy());
        this.portShapes.delete(nodeId);
        this.portLayer.batchDraw();
    }

    renderAllPorts() {
        const wanted = new Set();
        this.canvas.items.forEach((_, id) => {
            if (this._shouldMaintainPorts(id)) wanted.add(id);
        });
        [...this.portShapes.keys()].forEach(id => {
            if (!wanted.has(id)) this.clearPorts(id);
        });
        wanted.forEach(id => {
            if (!this.portShapes.has(id)) this.renderPorts(id);
        });
    }

    scheduleVisiblePortsRefresh(delay = 120) {
        clearTimeout(this._visiblePortsTimer);
        this._visiblePortsTimer = setTimeout(() => {
            this._visiblePortsTimer = null;
            this.renderAllPorts();
        }, Math.max(0, Number(delay) || 0));
    }

    _beginDrag(nodeId, port, side) {
        // 起线前清掉任何残留的 pending，保证每次都是干净状态。
        this.closeConnectionNodeMenu();
        this.cancelPending();
        const line = new this.Konva.Line({
            points: [],
            stroke: EDGE_COLOR,
            strokeWidth: EDGE_WIDTH,
            opacity: 0.92,
            lineCap: 'round',
            lineJoin: 'round',
            bezier: true,
            strokeScaleEnabled: false,
            shadowColor: '#000000',
            shadowBlur: 2,
            shadowOpacity: 0.24,
            listening: false
        });
        this.edgeLayer.add(line);
        line.moveToTop();
        this.pending = { nodeId, port, side, line };
        this._syncPending();
    }

    /**
     * 统一的指针取值。优先用原生事件的 clientX/Y 换算——document 级事件在画布外或
     * 经过其它 DOM 元素时，Konva 缓存的 getPointerPosition() 可能是过期值；从 client
     * 坐标直接算则始终准确。无事件时回退到 Konva 缓存。
     * 返回 { stage } 屏幕坐标（供 getIntersection）与 { world } 世界坐标。
     */
    _pointerFrom(evt) {
        const stage = (evt && Number.isFinite(evt.clientX))
            ? this.canvas._getStagePointerFromClient(evt.clientX, evt.clientY)
            : this.canvas.stage.getPointerPosition();
        if (!stage) return null;
        const scale = this.canvas.stage.scaleX();
        const pos = this.canvas.stage.position();
        const world = { x: (stage.x - pos.x) / scale, y: (stage.y - pos.y) / scale };
        return { stage, world };
    }

    _syncPending(evt) {
        if (!this.pending) return;
        const { nodeId, port, side, line } = this.pending;
        const from = this.portPosition(nodeId, port.name, side);
        const p = this._pointerFrom(evt);
        if (!from || !p) return;
        line.points(curvePoints(from, p.world));
        this.edgeLayer.batchDraw();
    }

    /** 松手：命中兼容端口则建立连线 */
    _endDrag(evt) {
        if (!this.pending) return;
        const drag = this.pending;
        const { nodeId, port, side, line } = drag;
        const pointer = this._pointerFrom(evt);
        const target = this._hitPort(side === 'out' ? 'in' : 'out', evt);
        this.pending = null;
        if (!target) {
            if (pointer && this._isBlankCanvasDrop(evt, pointer.stage)) {
                const options = this._compatibleNodeOptions(drag);
                if (options.length) {
                    const sourcePoint = this.portPosition(nodeId, port.name, side);
                    if (!sourcePoint) {
                        line.destroy();
                        this.edgeLayer.batchDraw();
                        return null;
                    }
                    line.points(curvePoints(sourcePoint, pointer.world));
                    this._openConnectionNodeMenu(evt, pointer.world, drag, options);
                    this.edgeLayer.batchDraw();
                    return null;
                }
            }
            line.destroy();
            this.edgeLayer.batchDraw();
            return null;
        }

        line.destroy();
        this.edgeLayer.batchDraw();

        const from = side === 'out'
            ? { nodeId, port: port.name }
            : { nodeId: target.nodeId, port: target.port.name };
        const to = side === 'out'
            ? { nodeId: target.nodeId, port: target.port.name }
            : { nodeId, port: port.name };

        return this.connect(from, to);
    }

    _isBlankCanvasDrop(evt, stagePointer) {
        if (!Number.isFinite(evt?.clientX) || !Number.isFinite(evt?.clientY)) return false;
        const container = this.canvas.stage.container();
        const domTarget = document.elementFromPoint(evt.clientX, evt.clientY);
        if (!domTarget || !(domTarget === container || container.contains(domTarget))) return false;
        return !this._nodeIdAtPointer(stagePointer);
    }

    _compatibleNodeOptions(drag) {
        return getCompatibleNodeOptions(drag);
    }

    _openConnectionNodeMenu(evt, worldPoint, drag, options) {
        this.closeConnectionNodeMenu();
        this.canvas._removePlanContextMenu?.();

        const menu = document.createElement('section');
        menu.className = 'connection-node-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', drag.side === 'out' ? '引用该节点生成' : '创建并连接上游节点');

        const heading = document.createElement('div');
        heading.className = 'connection-node-menu-heading';
        heading.textContent = drag.side === 'out' ? '引用该节点生成' : '创建并连接上游节点';
        menu.appendChild(heading);

        options.forEach(option => {
            const copy = NODE_MENU_COPY[option.nodeType] || {};
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'connection-node-menu-item';
            button.setAttribute('role', 'menuitem');
            button.innerHTML = `
                <span class="connection-node-menu-icon">${nodeIconSvg(option.nodeType, 20)}</span>
                <span class="connection-node-menu-copy">
                    <strong></strong>
                    <small></small>
                </span>
            `;
            button.querySelector('strong').textContent = copy.title || option.def.title || option.nodeType;
            button.querySelector('small').textContent = copy.description || option.def.title || '';
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                this._createConnectedNodeFromMenu(worldPoint, drag, option);
            });
            menu.appendChild(button);
        });

        document.body.appendChild(menu);
        const gap = 12;
        let left = evt.clientX + gap;
        let top = evt.clientY - 30;
        const rect = menu.getBoundingClientRect();
        if (left + rect.width > window.innerWidth - gap) left = evt.clientX - rect.width - gap;
        if (top + rect.height > window.innerHeight - gap) top = window.innerHeight - rect.height - gap;
        if (top < gap) top = gap;
        menu.style.left = `${Math.round(left)}px`;
        menu.style.top = `${Math.round(top)}px`;

        this.connectionNodeMenu = menu;
        this.connectionNodeMenuState = { line: drag.line, drag, worldPoint };
        this._connectionNodeMenuClose = event => {
            if (!menu.contains(event.target)) this.closeConnectionNodeMenu();
        };
        this._connectionNodeMenuKeydown = event => {
            if (event.key === 'Escape') this.closeConnectionNodeMenu();
        };
        setTimeout(() => {
            document.addEventListener('mousedown', this._connectionNodeMenuClose);
            document.addEventListener('keydown', this._connectionNodeMenuKeydown);
        }, 0);
        requestAnimationFrame(() => menu.querySelector('button')?.focus({ preventScroll: true }));
    }

    _createConnectedNodeFromMenu(worldPoint, drag, option) {
        const isGenerator = option.nodeType === 'image' || option.nodeType === 'video';
        const nodeWidth = isGenerator
            ? getGeneratorPlaceholderSize(option.nodeType).width
            : Math.max(300, Number(option.def.width) || 0);
        const horizontalOffset = nodeWidth / 2 + 28;
        const placement = {
            x: worldPoint.x + (drag.side === 'out' ? horizontalOffset : -horizontalOffset),
            y: worldPoint.y
        };
        const created = this.canvas.addOpNode?.(option.nodeType, placement);
        if (!created) {
            this.closeConnectionNodeMenu();
            return null;
        }

        const from = drag.side === 'out'
            ? { nodeId: drag.nodeId, port: drag.port.name }
            : { nodeId: created.id, port: option.port.name };
        const to = drag.side === 'out'
            ? { nodeId: created.id, port: option.port.name }
            : { nodeId: drag.nodeId, port: drag.port.name };
        this.closeConnectionNodeMenu();
        const connection = this.connect(from, to);
        if (connection) {
            this.canvas._showCanvasStatus?.(`已创建${option.def.title || '节点'}并连接`);
            if (isGenerator) requestAnimationFrame(() => this.canvas.openGenerationComposer?.(created.id));
        }
        return connection;
    }

    closeConnectionNodeMenu() {
        if (this._connectionNodeMenuClose) {
            document.removeEventListener('mousedown', this._connectionNodeMenuClose);
            this._connectionNodeMenuClose = null;
        }
        if (this._connectionNodeMenuKeydown) {
            document.removeEventListener('keydown', this._connectionNodeMenuKeydown);
            this._connectionNodeMenuKeydown = null;
        }
        this.connectionNodeMenu?.remove();
        this.connectionNodeMenu = null;
        this.connectionNodeMenuState?.line?.destroy();
        this.edgeLayer.batchDraw();
        this.connectionNodeMenuState = null;
    }

    /**
     * 松手命中判定，移植自 Infinite-Canvas 的 handlePortDrop：
     * 1) 优先精确命中端口小圆点；
     * 2) 命中不到就找指针下的节点，按指针落在节点左半/右半推断 in/out 端口，
     *    取该侧第一个兼容端口。容错高得多，不必对准 6px 的小圆点。
     * wantSide 为对端应有的一侧（起点是 out 就找 in，反之亦然）。
     */
    _hitPort(wantSide, evt) {
        const p = this._pointerFrom(evt);
        if (!p) return null;
        const pointer = p.stage;

        // 1) 精确命中端口
        const hitShape = this.portLayer.getIntersection(pointer);
        let shape = hitShape;
        while (shape && shape !== this.portLayer && shape.name?.() !== 'graphPort') {
            shape = shape.getParent?.();
        }
        if (shape?.name?.() === 'graphPort') {
            for (const [nodeId, entries] of this.portShapes) {
                const found = entries.find(e => e.shape === shape && e.side === wantSide);
                if (found) return { nodeId, port: found.port, side: found.side };
            }
        }

        // 2) 容错：命中指针下的节点，取其对端应有一侧（wantSide）的第一个端口。
        // 连线兼容性已强制对端只能是 wantSide，无需再按左右半推断。
        const nodeId = this._nodeIdAtPointer(pointer);
        if (!nodeId || nodeId === this.pending?.nodeId) return null;
        const node = this._nodeData(nodeId);
        const ports = G.getPorts(node);
        const list = wantSide === 'in' ? ports.inputs : ports.outputs;
        if (!list.length) return null;
        const compatible = list.find(candidate => {
            const from = wantSide === 'in'
                ? { nodeId: this.pending.nodeId, port: this.pending.port.name }
                : { nodeId, port: candidate.name };
            const to = wantSide === 'in'
                ? { nodeId, port: candidate.name }
                : { nodeId: this.pending.nodeId, port: this.pending.port.name };
            return G.canConnect(this._nodeData(from.nodeId), from.port, this._nodeData(to.nodeId), to.port, this.connections).ok;
        });
        return compatible ? { nodeId, port: compatible, side: wantSide } : null;
    }

    /** 指针（stage 坐标）下最上层的节点组 id */
    _nodeIdAtPointer(pointer) {
        const target = this.canvas.layer.getIntersection(pointer);
        if (!target) return null;
        const group = target.findAncestor?.('Group', true);
        const id = group?.attrs?.id ?? target.attrs?.id;
        return id && this.canvas._getNodeEntry?.(id) ? id : null;
    }

    /**
     * @param opts.kind 'flow'（默认，执行边）或 'history'（溯源边，不参与执行）
     * @param opts.silent 校验失败时不弹提示。自动落地走这条路径——
     *        产物节点是程序建的，失败应该静默，不该打扰正在看画布的人。
     */
    connect(from, to, opts = {}) {
        const fromItem = this._nodeData(from.nodeId);
        const toItem = this._nodeData(to.nodeId);
        const result = G.canConnect(fromItem, from.port, toItem, to.port, this.connections);
        if (!result.ok) {
            if (!opts.silent) this.canvas._showCanvasStatus?.(result.reason);
            return null;
        }
        // 同一输入端口只允许一条连线：新线替换旧线
        if (result.replaces) this.disconnect(result.replaces.id);
        const conn = { id: newConnectionId(), from, to };
        if (opts.kind && opts.kind !== 'flow') conn.kind = opts.kind;
        this.connections.push(conn);
        this.canvas.refreshOpNode?.(to.nodeId);
        this.renderPorts(from.nodeId);
        this.renderPorts(to.nodeId);
        this.drawEdge(conn);
        this.canvas.emit?.('change');
        return conn;
    }

    disconnect(connectionId) {
        const removed = this.connections.find(connection => connection.id === connectionId);
        this.connections = this.connections.filter(c => c.id !== connectionId);
        this.edgeShapes.get(connectionId)?.destroy();
        this.edgeShapes.delete(connectionId);
        if (removed) {
            this.canvas.refreshOpNode?.(removed.to.nodeId);
            this.renderPorts(removed.from.nodeId);
            this.renderPorts(removed.to.nodeId);
        }
        this.edgeLayer.batchDraw();
        this.portLayer.batchDraw();
        this.canvas.emit?.('change');
    }

    setConnectionsVisible(visible) {
        this.connectionsVisible = visible !== false;
        this.edgeShapes.forEach(line => line.visible(this.connectionsVisible));
        this.edgeLayer.batchDraw();
    }

    drawEdge(conn) {
        this.edgeShapes.get(conn.id)?.destroy();
        const a = this.portPosition(conn.from.nodeId, conn.from.port, 'out');
        const b = this.portPosition(conn.to.nodeId, conn.to.port, 'in');
        if (!a || !b) return;
        const node = this._nodeData(conn.from.nodeId);
        const ports = G.getPorts(node);
        const dataType = ports.outputs.find(p => p.name === conn.from.port)?.dataType || 'any';
        // 溯源边画成细虚线并压暗，与执行边区分：它不影响执行，视觉上不该抢注意力
        const isHistory = conn.kind === 'history';
        const line = new this.Konva.Line({
            points: curvePoints(a, b),
            stroke: isHistory ? EDGE_HISTORY_COLOR : EDGE_COLOR,
            strokeWidth: isHistory ? EDGE_HISTORY_WIDTH : EDGE_WIDTH,
            opacity: isHistory ? 0.48 : 0.9,
            bezier: true,
            lineCap: 'round',
            lineJoin: 'round',
            strokeScaleEnabled: false,
            shadowColor: '#000000',
            shadowBlur: 2,
            shadowOpacity: isHistory ? 0.12 : 0.24,
            hitStrokeWidth: 16,
            name: 'graphEdge',
            id: conn.id,
            visible: this.connectionsVisible
        });
        const baseWidth = isHistory ? EDGE_HISTORY_WIDTH : EDGE_WIDTH;
        const baseOpacity = isHistory ? 0.48 : 0.9;
        line.on('mouseenter', () => {
            line.strokeWidth(baseWidth + 1.2);
            line.stroke(portColor(dataType));
            line.opacity(1);
            document.body.style.cursor = 'pointer';
            this.edgeLayer.batchDraw();
        });
        line.on('mouseleave', () => {
            line.strokeWidth(baseWidth);
            line.stroke(isHistory ? EDGE_HISTORY_COLOR : EDGE_COLOR);
            line.opacity(baseOpacity);
            document.body.style.cursor = 'default';
            this.edgeLayer.batchDraw();
        });
        // 双击删除连线。单击删除会与「从端口起线」的 mousedown 冲突：
        // 删线后紧接着的 mousedown 落到线下方的端口上，导致残留的 pending
        // 把之后每次 mouseup 吞掉，端口被锁死无法再连。
        line.on('dblclick dbltap', evt => {
            evt.cancelBubble = true;
            this.disconnect(conn.id);
        });
        this.edgeLayer.add(line);
        line.moveToBottom();
        this.edgeShapes.set(conn.id, line);
        this.edgeLayer.batchDraw();
    }

    /**
     * 节点移动或视口变化后重算连线与端口位置。
     * 传入 scope（nodeId 的 Set/数组）时只重算这些节点的端口，以及与它们相连的边；
     * 不传则全量重算。拖动单个/多个节点时务必传 scope——否则每帧都会对全画布所有卡片
     * 调用 getClientRect（强制 layout），卡片一多就掉帧，端口和连线会“跟不过来”。
     */
    sync(scope = null) {
        const scoped = scope ? (scope instanceof Set ? scope : new Set(scope)) : null;
        const controlScale = viewportFixedScale(this.canvas.stage.scaleX());

        this.portShapes.forEach((entries, nodeId) => {
            if (scoped && !scoped.has(nodeId)) return;
            entries.forEach(entry => {
                const pos = this.portPosition(nodeId, entry.port.name, entry.side);
                if (pos) entry.shape.position(pos);
                entry.shape.scale({ x: controlScale, y: controlScale });
            });
        });
        this.connections.forEach(conn => {
            if (scoped && !scoped.has(conn.from.nodeId) && !scoped.has(conn.to.nodeId)) return;
            const line = this.edgeShapes.get(conn.id);
            if (!line) return;
            const a = this.portPosition(conn.from.nodeId, conn.from.port, 'out');
            const b = this.portPosition(conn.to.nodeId, conn.to.port, 'in');
            if (a && b) line.points(curvePoints(a, b));
        });
        this._syncPending();
        this.edgeLayer.batchDraw();
        this.portLayer.batchDraw();
    }

    /**
     * 拖拽节点时用它代替 sync()：每个 dragmove 都全量重算端口 + 连线会掉帧，
     * 用 requestAnimationFrame 合并成每帧最多刷新一次（节点本身的位移仍是即时的）。
     * scope 会在同一帧内累积，覆盖多选拖动时移动的所有节点。
     * 参考 Infinite-Canvas 的 scheduleConnectionLayerRefresh。
     */
    scheduleSync(scope = null) {
        if (scope) {
            if (!this._pendingScope) this._pendingScope = new Set();
            (scope instanceof Set || Array.isArray(scope) ? scope : [scope])
                .forEach(id => this._pendingScope.add(id));
        } else {
            this._pendingScope = null;
            this._fullScopePending = true;
        }
        if (this._syncRaf) return;
        this._syncRaf = requestAnimationFrame(() => {
            this._syncRaf = 0;
            const s = this._fullScopePending ? null : this._pendingScope;
            this._pendingScope = null;
            this._fullScopePending = false;
            this.sync(s);
        });
    }

    /** 节点被删除时清理其端口与相连的边 */
    removeNode(nodeId) {
        this.connections
            .filter(c => c.from.nodeId === nodeId || c.to.nodeId === nodeId)
            .forEach(c => this.disconnect(c.id));
        this.clearPorts(nodeId);
    }

    load(connections) {
        this.edgeShapes.forEach(line => line.destroy());
        this.edgeShapes.clear();
        this.connections = G.normalizeGeneratorInputConnections(connections, this._allNodes());
        new Set(this.connections.map(connection => connection.to.nodeId))
            .forEach(nodeId => this.canvas.refreshOpNode?.(nodeId));
        // 卡片尺寸在内容加载后才稳定，先画一遍再于下一帧重算坐标
        this.renderAllPorts();
        this.connections.forEach(conn => this.drawEdge(conn));
        requestAnimationFrame(() => {
            this.renderAllPorts();
            this.connections.forEach(conn => this.drawEdge(conn));
        });
    }

    serialize() {
        return this.connections.map(c => {
            const out = { id: c.id, from: { ...c.from }, to: { ...c.to } };
            if (c.kind && c.kind !== 'flow') out.kind = c.kind;
            return out;
        });
    }
}

/** 水平贝塞尔控制点：长距离和大高度差会形成更松弛的线缆曲线。 */
export function curvePoints(a, b) {
    const horizontal = Math.abs(b.x - a.x);
    const vertical = Math.abs(b.y - a.y);
    const forward = b.x >= a.x;
    const rawHandle = forward
        ? horizontal * 0.46 + vertical * 0.08
        : horizontal * 0.35 + vertical * 0.18;
    const handle = Math.max(forward ? 56 : 88, Math.min(forward ? 320 : 360, rawHandle));
    return [a.x, a.y, a.x + handle, a.y, b.x - handle, b.y, b.x, b.y];
}
