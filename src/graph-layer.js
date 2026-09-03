// ============================================================
// Flow Canvas — Graph Layer (端口 + 连线的 Konva 层)
// ============================================================
// 独立 Layer 叠在素材层之上，只画端口圆点和贝塞尔连线，
// 避免和素材卡片的 hit 检测互相干扰。
// ============================================================

import Konva from 'konva';
import { getPorts, canConnect } from './graph-model.js';

const PORT_RADIUS = 5;
const PORT_HIT_RADIUS = 11;
const PORT_GAP = 18;
const LINE_COLOR = '#5a6472';
const LINE_ACTIVE = '#3a7bd5';
const OK_COLOR = '#3ecf8e';
const BAD_COLOR = '#e5484d';

const TYPE_COLORS = {
    string: '#c9a227',
    image: '#3ecf8e',
    video: '#9b6dff',
    file: '#8a8f98',
    any: '#8a8f98'
};

export class GraphLayer {
    /**
     * @param hooks {{ getItems, getConnections, getBounds, onConnect, onDisconnect, onNotice }}
     *   getBounds(nodeId) → { x, y, width, height } 画布坐标下的卡片矩形
     */
    constructor(stage, hooks) {
        this.stage = stage;
        this.hooks = hooks;

        this.layer = new Konva.Layer({ listening: true });
        stage.add(this.layer);

        this.edgeGroup = new Konva.Group({ listening: true });
        this.portGroup = new Konva.Group({ listening: true });
        this.layer.add(this.edgeGroup, this.portGroup);

        this.tempLine = new Konva.Path({
            stroke: LINE_ACTIVE,
            strokeWidth: 2,
            visible: false,
            listening: false
        });
        this.layer.add(this.tempLine);

        this.portShapes = new Map();  // `${nodeId}:${dir}:${port}` → Konva.Circle
        this.edgeShapes = new Map();  // connectionId → Konva.Path
        this.selectedEdgeId = null;
        this.drag = null;             // 正在拖拽的连线

        this._bindStageEvents();
    }

    // ── 几何 ────────────────────────────────────────────────

    /** 端口在画布坐标下的位置。输入在左缘，输出在右缘，纵向均分。 */
    portPosition(nodeId, direction, portName) {
        const bounds = this.hooks.getBounds(nodeId);
        if (!bounds) return null;

        const item = this._item(nodeId);
        if (!item) return null;

        const ports = getPorts(item);
        const list = direction === 'output' ? ports.outputs : ports.inputs;
        const index = list.findIndex(p => p.name === portName);
        if (index < 0) return null;

        const x = direction === 'output' ? bounds.x + bounds.width : bounds.x;

        // 单端口贴中线；多端口从卡片上部往下排，避开标题栏
        let y;
        if (list.length === 1) {
            y = bounds.y + bounds.height / 2;
        } else {
            const startY = bounds.y + Math.min(44, bounds.height * 0.3);
            const span = Math.min(PORT_GAP * (list.length - 1), bounds.height - 50);
            const step = list.length > 1 ? span / (list.length - 1) : 0;
            y = startY + step * index;
        }
        return { x, y };
    }

    _item(nodeId) {
        const items = this.hooks.getItems();
        return items instanceof Map ? items.get(nodeId) : items.find(i => i.id === nodeId);
    }

    _bezier(from, to) {
        const dx = Math.abs(to.x - from.x);
        const offset = Math.max(30, dx * 0.5);
        return `M ${from.x} ${from.y} C ${from.x + offset} ${from.y}, ${to.x - offset} ${to.y}, ${to.x} ${to.y}`;
    }

    // ── 重建 ────────────────────────────────────────────────

    /** 节点增删或连线变化后整体重建。数据量小，不做增量 diff。 */
    rebuild() {
        this.portGroup.destroyChildren();
        this.edgeGroup.destroyChildren();
        this.portShapes.clear();
        this.edgeShapes.clear();

        const items = this.hooks.getItems();
        const list = items instanceof Map ? [...items.values()] : (items || []);

        list.forEach(item => {
            const ports = getPorts(item);
            ports.inputs.forEach(p => this._addPort(item, 'input', p));
            ports.outputs.forEach(p => this._addPort(item, 'output', p));
        });

        (this.hooks.getConnections() || []).forEach(conn => this._addEdge(conn));
        this.layer.batchDraw();
    }

    _addPort(item, direction, port) {
        const pos = this.portPosition(item.id, direction, port.name);
        if (!pos) return;

        const circle = new Konva.Circle({
            x: pos.x, y: pos.y,
            radius: PORT_RADIUS,
            fill: TYPE_COLORS[port.dataType] || TYPE_COLORS.any,
            stroke: '#0f0f14',
            strokeWidth: 1.5,
            hitStrokeWidth: PORT_HIT_RADIUS,
            name: 'graphPort'
        });
        circle.setAttrs({ nodeId: item.id, direction, portName: port.name, dataType: port.dataType });

        circle.on('mouseenter', () => {
            document.body.style.cursor = 'crosshair';
            if (!this.drag) circle.radius(PORT_RADIUS + 2);
            else this._highlightTarget(circle);
            this.layer.batchDraw();
        });
        circle.on('mouseleave', () => {
            document.body.style.cursor = 'default';
            circle.radius(PORT_RADIUS);
            circle.stroke('#0f0f14');
            this.layer.batchDraw();
        });
        circle.on('mousedown', e => {
            e.cancelBubble = true;
            this._startDrag(circle);
        });

        this.portShapes.set(`${item.id}:${direction}:${port.name}`, circle);
        this.portGroup.add(circle);
    }

    _addEdge(conn) {
        const from = this.portPosition(conn.from.nodeId, 'output', conn.from.port);
        const to = this.portPosition(conn.to.nodeId, 'input', conn.to.port);
        if (!from || !to) return; // 引用了不存在的节点/端口，静默跳过

        const path = new Konva.Path({
            data: this._bezier(from, to),
            stroke: conn.id === this.selectedEdgeId ? LINE_ACTIVE : LINE_COLOR,
            strokeWidth: conn.id === this.selectedEdgeId ? 3 : 2,
            hitStrokeWidth: 12,
            name: 'graphEdge'
        });
        path.setAttr('connectionId', conn.id);

        path.on('mouseenter', () => {
            document.body.style.cursor = 'pointer';
            path.stroke(LINE_ACTIVE);
            this.layer.batchDraw();
        });
        path.on('mouseleave', () => {
            document.body.style.cursor = 'default';
            path.stroke(conn.id === this.selectedEdgeId ? LINE_ACTIVE : LINE_COLOR);
            this.layer.batchDraw();
        });
        path.on('click', e => {
            e.cancelBubble = true;
            this.selectEdge(conn.id);
        });
        path.on('contextmenu', e => {
            e.evt.preventDefault();
            e.cancelBubble = true;
            this.hooks.onDisconnect?.(conn.id);
        });

        this.edgeShapes.set(conn.id, path);
        this.edgeGroup.add(path);
    }

    /** 只更新几何，不重建对象。节点拖动时调用。 */
    syncGeometry() {
        this.portShapes.forEach(circle => {
            const pos = this.portPosition(
                circle.getAttr('nodeId'),
                circle.getAttr('direction'),
                circle.getAttr('portName')
            );
            if (pos) {
                circle.position(pos);
                circle.visible(true);
            } else {
                circle.visible(false);
            }
        });

        (this.hooks.getConnections() || []).forEach(conn => {
            const path = this.edgeShapes.get(conn.id);
            if (!path) return;
            const from = this.portPosition(conn.from.nodeId, 'output', conn.from.port);
            const to = this.portPosition(conn.to.nodeId, 'input', conn.to.port);
            if (from && to) {
                path.data(this._bezier(from, to));
                path.visible(true);
            } else {
                path.visible(false);
            }
        });

        this.layer.batchDraw();
    }

    // ── 连线拖拽 ────────────────────────────────────────────

    _startDrag(circle) {
        this.drag = {
            nodeId: circle.getAttr('nodeId'),
            direction: circle.getAttr('direction'),
            portName: circle.getAttr('portName'),
            dataType: circle.getAttr('dataType')
        };
        this.tempLine.visible(true);
        this.tempLine.stroke(LINE_ACTIVE);
    }

    _bindStageEvents() {
        this.stage.on('mousemove', () => {
            if (!this.drag) return;
            const pointer = this._pointerInCanvas();
            const anchor = this.portPosition(this.drag.nodeId, this.drag.direction, this.drag.portName);
            if (!anchor || !pointer) return;

            const [from, to] = this.drag.direction === 'output'
                ? [anchor, pointer]
                : [pointer, anchor];
            this.tempLine.data(this._bezier(from, to));
            this.layer.batchDraw();
        });

        this.stage.on('mouseup', () => {
            if (!this.drag) return;
            const target = this._portUnderPointer();
            const pending = this.drag;
            this._endDrag();

            if (!target) return;
            this._tryConnect(pending, {
                nodeId: target.getAttr('nodeId'),
                direction: target.getAttr('direction'),
                portName: target.getAttr('portName')
            });
        });
    }

    _tryConnect(a, b) {
        if (a.direction === b.direction) {
            this.hooks.onNotice?.('需要连接输出端口到输入端口');
            return;
        }
        const source = a.direction === 'output' ? a : b;
        const sink = a.direction === 'output' ? b : a;

        const fromItem = this._item(source.nodeId);
        const toItem = this._item(sink.nodeId);
        const connections = this.hooks.getConnections() || [];

        const check = canConnect(fromItem, source.portName, toItem, sink.portName, connections);
        if (!check.ok) {
            this.hooks.onNotice?.(check.reason);
            return;
        }
        this.hooks.onConnect?.({
            from: { nodeId: source.nodeId, port: source.portName },
            to: { nodeId: sink.nodeId, port: sink.portName }
        }, check.replaces || null);
    }

    /** hover 到候选端口时按兼容性染色。 */
    _highlightTarget(circle) {
        if (!this.drag) return;
        const a = this.drag;
        const b = {
            nodeId: circle.getAttr('nodeId'),
            direction: circle.getAttr('direction'),
            portName: circle.getAttr('portName')
        };
        if (a.direction === b.direction) {
            circle.stroke(BAD_COLOR);
            return;
        }
        const source = a.direction === 'output' ? a : b;
        const sink = a.direction === 'output' ? b : a;
        const check = canConnect(
            this._item(source.nodeId), source.portName,
            this._item(sink.nodeId), sink.portName,
            this.hooks.getConnections() || []
        );
        circle.stroke(check.ok ? OK_COLOR : BAD_COLOR);
        circle.radius(PORT_RADIUS + 2);
    }

    _endDrag() {
        this.drag = null;
        this.tempLine.visible(false);
        this.layer.batchDraw();
    }

    cancelDrag() {
        if (this.drag) this._endDrag();
    }

    _pointerInCanvas() {
        const pointer = this.stage.getPointerPosition();
        if (!pointer) return null;
        const scale = this.stage.scaleX();
        const pos = this.stage.position();
        return { x: (pointer.x - pos.x) / scale, y: (pointer.y - pos.y) / scale };
    }

    _portUnderPointer() {
        const pointer = this.stage.getPointerPosition();
        if (!pointer) return null;
        const shape = this.layer.getIntersection(pointer);
        return shape?.name() === 'graphPort' ? shape : null;
    }

    // ── 连线选中 / 删除 ─────────────────────────────────────

    selectEdge(connectionId) {
        this.selectedEdgeId = connectionId;
        this.edgeShapes.forEach((path, id) => {
            const active = id === connectionId;
            path.stroke(active ? LINE_ACTIVE : LINE_COLOR);
            path.strokeWidth(active ? 3 : 2);
        });
        this.layer.batchDraw();
        this.hooks.onEdgeSelected?.(connectionId);
    }

    clearEdgeSelection() {
        if (this.selectedEdgeId) this.selectEdge(null);
    }

    getSelectedEdgeId() { return this.selectedEdgeId; }

    /** 端口层在框选时要让位，否则会挡住画布的 mousedown。 */
    setPortsListening(listening) {
        this.portGroup.listening(listening);
        this.edgeGroup.listening(listening);
    }

    destroy() {
        this.layer.destroy();
    }
}
