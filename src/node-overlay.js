// ============================================================
// Flow Canvas — Node Overlay (op 节点的 DOM 卡片层)
// ============================================================
// 坐标同步复用 canvas.js syncGifs() 的模式：
//   translate(screenX, screenY) scale(scale) + transformOrigin: top left
//
// 容器 pointerEvents: none，只有表单控件和运行按钮设为 auto，
// 这样卡片空白处的拖拽会穿透到底下的 Konva Group，
// 直接复用既有的磁吸对齐 / 多选 / 框选逻辑。
// ============================================================

import { NODE_TYPES } from './node-types.js';
import { STATUS } from './graph-runner.js';

export const NODE_CARD_HEADER_H = 34;
export const NODE_CARD_PADDING = 10;

/** 估算卡片高度，供 Konva 命中矩形和布局算法使用。 */
export function estimateCardHeight(nodeType) {
    const def = NODE_TYPES[nodeType];
    if (!def) return NODE_CARD_HEADER_H + 20;

    let h = NODE_CARD_HEADER_H + NODE_CARD_PADDING;
    for (const field of def.config || []) {
        h += 18; // label
        h += field.type === 'textarea' ? 62 : 28;
        h += 8;  // gap
    }
    if ((def.inputs || []).length || (def.outputs || []).length) {
        h += Math.max((def.inputs || []).length, (def.outputs || []).length) * 4;
    }
    h += NODE_CARD_PADDING + 6; // 状态条
    return Math.max(h, 70);
}

export function nodeCardWidth(nodeType) {
    return NODE_TYPES[nodeType]?.width || 220;
}

export class NodeOverlay {
    /**
     * @param container 画布容器元素
     * @param hooks {{ onConfigChange, onConfigCommit, onRun, getStage, getResult }}
     */
    constructor(container, hooks) {
        this.hooks = hooks;
        this.cards = new Map(); // nodeId → { el, data, fields }

        this.root = document.createElement('div');
        this.root.className = 'node-overlay';
        container.appendChild(this.root);
    }

    createCard(data) {
        const def = NODE_TYPES[data.nodeType];
        if (!def) {
            console.warn('[NodeOverlay] 未知节点类型:', data.nodeType);
            return null;
        }

        const el = document.createElement('div');
        el.className = 'node-card';
        el.dataset.nodeId = data.id;
        el.style.width = `${nodeCardWidth(data.nodeType)}px`;
        el.style.setProperty('--node-accent', def.color || '#3a7bd5');

        el.appendChild(this._buildHeader(data, def));

        const body = document.createElement('div');
        body.className = 'node-card-body';
        const fields = new Map();
        (def.config || []).forEach(field => {
            const row = this._buildField(data, field, fields);
            if (row) body.appendChild(row);
        });
        el.appendChild(body);

        const preview = document.createElement('div');
        preview.className = 'node-card-preview';
        el.appendChild(preview);

        const status = document.createElement('div');
        status.className = 'node-card-status';
        status.innerHTML = '<span class="node-status-text"></span>';
        el.appendChild(status);

        this.root.appendChild(el);
        this.cards.set(data.id, { el, data, fields, preview, status });
        this.updateStatus(data.id);
        return el;
    }

    _buildHeader(data, def) {
        const header = document.createElement('div');
        header.className = 'node-card-header';
        header.style.height = `${NODE_CARD_HEADER_H}px`;

        const icon = document.createElement('span');
        icon.className = 'node-card-icon';
        icon.textContent = def.icon || '⬡';

        const title = document.createElement('span');
        title.className = 'node-card-title';
        title.textContent = def.title || data.nodeType;

        const run = document.createElement('button');
        run.className = 'node-card-run';
        run.type = 'button';
        run.title = '运行此节点及其上游依赖';
        run.textContent = '▶';
        run.addEventListener('mousedown', e => e.stopPropagation());
        run.addEventListener('click', e => {
            e.stopPropagation();
            this.hooks.onRun?.(data.id);
        });

        header.append(icon, title, run);
        return header;
    }

    _buildField(data, field, fields) {
        const row = document.createElement('label');
        row.className = 'node-field';

        const label = document.createElement('span');
        label.className = 'node-field-label';
        label.textContent = field.label || field.key;
        row.appendChild(label);

        const current = data.config?.[field.key] ?? field.default ?? '';
        let input;

        if (field.type === 'textarea') {
            input = document.createElement('textarea');
            input.rows = 3;
            input.value = current;
        } else if (field.type === 'select') {
            input = document.createElement('select');
            (field.options || []).forEach(opt => {
                const o = document.createElement('option');
                const isPair = opt && typeof opt === 'object';
                o.value = isPair ? opt.value : opt;
                o.textContent = isPair ? (opt.label ?? opt.value) : opt;
                input.appendChild(o);
            });
            input.value = current;
        } else if (field.type === 'number') {
            input = document.createElement('input');
            input.type = 'number';
            if (field.min !== undefined) input.min = field.min;
            if (field.max !== undefined) input.max = field.max;
            if (field.step !== undefined) input.step = field.step;
            input.value = current;
        } else {
            input = document.createElement('input');
            input.type = 'text';
            input.value = current;
        }

        input.className = 'node-field-input';
        if (field.placeholder) input.placeholder = field.placeholder;

        // 表单控件要能接收事件，且不能把 mousedown 冒泡给 Konva（否则会触发拖拽/框选）
        input.style.pointerEvents = 'auto';
        input.addEventListener('mousedown', e => e.stopPropagation());
        input.addEventListener('wheel', e => e.stopPropagation(), { passive: true });

        input.addEventListener('input', () => {
            const value = field.type === 'number' ? this._toNumber(input, field) : input.value;
            this.hooks.onConfigChange?.(data.id, field.key, value);
        });
        // blur 才入撤销栈，避免每个字符一次快照
        input.addEventListener('change', () => this.hooks.onConfigCommit?.(data.id));
        input.addEventListener('blur', () => this.hooks.onConfigCommit?.(data.id));

        row.appendChild(input);
        fields.set(field.key, input);
        return row;
    }

    _toNumber(input, field) {
        const n = parseFloat(input.value);
        if (Number.isNaN(n)) return field.default ?? 0;
        if (field.min !== undefined && n < field.min) return n; // 不在输入中途强改，交给 blur
        return n;
    }

    /** 状态条 + 错误信息 + 结果预览 */
    updateStatus(nodeId) {
        const card = this.cards.get(nodeId);
        if (!card) return;

        const { data, el, status } = card;
        const state = data.runStatus || STATUS.IDLE;
        el.dataset.status = state;

        const text = status.querySelector('.node-status-text');
        if (state === STATUS.ERROR) {
            text.textContent = data.runError || '执行失败';
            status.title = data.runError || '';
        } else if (state === STATUS.RUNNING) {
            text.textContent = '执行中…';
            status.title = '';
        } else if (state === STATUS.QUEUED) {
            text.textContent = '等待中';
            status.title = '';
        } else if (state === STATUS.DONE) {
            text.textContent = '完成';
            status.title = '';
        } else {
            text.textContent = '';
            status.title = '';
        }

        this._renderPreview(card);
    }

    /** image_preview 之类的节点把上游结果直接画在卡片里。 */
    _renderPreview(card) {
        const result = this.hooks.getResult?.(card.data.id);
        const url = this._pickImageUrl(result);
        const box = card.preview;

        if (!url) {
            if (box.firstChild) box.replaceChildren();
            box.style.display = 'none';
            return;
        }
        box.style.display = 'block';
        let img = box.querySelector('img');
        if (!img) {
            img = document.createElement('img');
            img.alt = '节点输出预览';
            box.replaceChildren(img);
        }
        if (img.getAttribute('src') !== url) img.src = url;
    }

    _pickImageUrl(result) {
        if (!result) return null;
        for (const value of Object.values(result)) {
            if (typeof value !== 'string') continue;
            if (/^(data:image\/|local-res:\/\/|https?:\/\/)/.test(value)) return value;
        }
        return null;
    }

    /** 表单值被外部改写（撤销/重做）后回填 DOM。 */
    syncFields(nodeId) {
        const card = this.cards.get(nodeId);
        if (!card) return;
        card.fields.forEach((input, key) => {
            const value = card.data.config?.[key];
            if (value !== undefined && input.value !== String(value)) {
                input.value = value;
            }
        });
    }

    /**
     * 坐标同步。与 syncGifs() 同一套算法。
     * @param positions Map<nodeId, {x, y, visible}>
     */
    sync(positions, scale, stagePos) {
        this.cards.forEach((card, id) => {
            const pos = positions.get(id);
            if (!pos || !pos.visible) {
                card.el.style.display = 'none';
                return;
            }
            card.el.style.display = '';
            const screenX = pos.x * scale + stagePos.x;
            const screenY = pos.y * scale + stagePos.y;
            card.el.style.transform = `translate(${screenX}px, ${screenY}px) scale(${scale})`;
        });
    }

    setSelected(nodeId, selected) {
        const card = this.cards.get(nodeId);
        if (card) card.el.classList.toggle('selected', selected);
    }

    remove(nodeId) {
        const card = this.cards.get(nodeId);
        if (!card) return;
        card.el.remove();
        this.cards.delete(nodeId);
    }

    clear() {
        this.cards.forEach(card => card.el.remove());
        this.cards.clear();
    }

    has(nodeId) { return this.cards.has(nodeId); }
}
