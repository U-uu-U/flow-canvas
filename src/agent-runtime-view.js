const TERMINAL = new Set(['completed', 'partial_failed', 'failed', 'interrupted', 'canceled']);
const STATUS_LABELS = {
    planning: '正在规划', awaiting_confirmation: '待确认', running: '执行中',
    waiting_provider: '等待服务商', reviewing: '检查结果', completed: '已完成',
    partial_failed: '部分失败', failed: '失败', interrupted: '已中断', canceled: '已取消'
};

export const isRuntimeTerminal = status => TERMINAL.has(status);
export function formatAgentElapsed(milliseconds) {
    if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) return '';
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    return `用时 ${hours ? `${hours}小时 ` : ''}${minutes ? `${minutes}分钟 ` : ''}${seconds % 60}秒`;
}
export const runtimeScopeKey = (projectId, conversationId) => JSON.stringify([projectId ?? null, conversationId]);

export function runtimeActions(run) {
    if (run.status === 'awaiting_confirmation' && run.plan?.version != null) {
        return run.external ? ['confirm', 'cancel'] : ['confirm', 'revise', 'cancel'];
    }
    if (['partial_failed', 'failed'].includes(run.status)) {
        const unresolved = (run.steps || []).some(step => ['submitting', 'submitted', 'unknown'].includes(step.status)
            || (step.remoteTaskId && step.status !== 'completed' && step.confirmedFailure !== true));
        return unresolved ? ['resume'] : ['resume', 'retry'];
    }
    if (run.status === 'interrupted') return ['resume'];
    return isRuntimeTerminal(run.status) ? [] : ['cancel'];
}

export function mergeRuntimeSnapshot(previous, snapshot) {
    if (!snapshot?.id) return previous;
    if (previous && (previous.id !== snapshot.id
        || runtimeScopeKey(previous.projectId, previous.conversationId) !== runtimeScopeKey(snapshot.projectId, snapshot.conversationId))) return previous;
    const events = new Map();
    [...(previous?.events || []), ...(snapshot.events || [])].forEach(event => {
        if (Number.isFinite(event.seq)) events.set(event.seq, event);
    });
    const sorted = [...events.values()].sort((a, b) => a.seq - b.seq);
    if (previous && Number(snapshot.lastSeq || 0) < Number(previous.lastSeq || 0)) {
        return JSON.stringify(sorted) === JSON.stringify(previous.events) ? previous : { ...previous, events: sorted };
    }
    return { ...previous, ...snapshot, events: sorted };
}

export function runtimeOutputFiles(run) {
    const files = new Map();
    const collect = (result, depth = 0) => {
        if (!result || typeof result !== 'object' || depth > 4) return;
        const entries = [
            ...(Array.isArray(result.files) ? result.files : []),
            ...(Array.isArray(result.outputs) ? result.outputs : []),
            ...(Array.isArray(result.filePaths) ? result.filePaths.map(filePath => ({
                filePath, sourceNodeId: result.sourceNodeId || result.nodeIds?.[0]
            })) : [])
        ];
        if (result.filePath) entries.push(result);
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            const path = entry.filePath || entry.url;
            if (!path) continue;
            const extension = String(path).split(/[?#]/)[0].split('.').pop().toLowerCase();
            const mediaType = entry.mediaType || entry.kind || (
                ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension) ? 'image'
                    : ['mp4', 'mov', 'webm'].includes(extension) ? 'video'
                        : ['mp3', 'wav', 'm4a', 'ogg'].includes(extension) ? 'audio' : null
            );
            files.set(path, { ...files.get(path), ...entry, mediaType,
                sourceNodeId: entry.sourceNodeId || entry.nodeId || files.get(path)?.sourceNodeId });
        }
        for (const child of Array.isArray(result.results) ? result.results : []) collect(child, depth + 1);
    };
    for (const event of run.events || []) {
        if (event.type === 'tool_result' || (event.type === 'step' && event.data?.status === 'completed')) {
            collect(event.data?.result || event.data);
        }
    }
    collect({ results: run.results });
    return [...files.values()];
}

export function runtimeDisplayText(run) {
    const output = String(run.outputText || '');
    if (isRuntimeTerminal(run.status)) return output;
    const events = run.events || [];
    const lastAssistant = events.findLastIndex(event => event.type === 'assistant');
    const delta = events.slice(lastAssistant + 1).filter(event => event.type === 'text_delta')
        .map(event => typeof event.data?.text === 'string' ? event.data.text : '').join('');
    if (!delta || output.endsWith(delta)) return output;
    return [output, delta].filter(Boolean).join('\n\n');
}

export function runtimeDisplayPlan(run) {
    if (run.plan) return run.plan;
    if (!isRuntimeTerminal(run.status)) return null;
    const data = [...(run.events || [])].reverse().find(event => event.type === 'plan')?.data;
    return data?.plan || (data?.version != null ? data : null);
}

// The receipt and final message are persisted together in the conversation record.
// Resuming a run updates its one message instead of adding a second final answer.
export function settleRuntimeConversation(conversation, run) {
    if (!conversation || conversation.id !== run.conversationId || !isRuntimeTerminal(run.status)) return conversation;
    const receipt = conversation.runtimeReceipts?.[run.id];
    if (receipt?.ignored || (receipt && receipt.seq >= run.lastSeq)) return conversation;
    const messages = [...(conversation.messages || [])];
    const content = String(run.outputText || '').trim();
    const index = messages.findIndex(message => message.role === 'assistant' && message.runtimeRunId === run.id);
    if (content) {
        const timing = Number.isFinite(run.createdAt) && Number.isFinite(run.updatedAt)
            ? { createdAt: run.updatedAt, elapsedMs: Math.max(0, run.updatedAt - run.createdAt) } : {};
        const message = { role: 'assistant', content, runtimeRunId: run.id, ...timing };
        if (index >= 0) messages[index] = { ...messages[index], ...message };
        else if (!receipt?.hasMessage) messages.push(message);
    }
    return {
        ...conversation, messages,
        runtimeReceipts: {
            ...conversation.runtimeReceipts,
            [run.id]: { seq: Number(run.lastSeq) || 0, hasMessage: Boolean(content || receipt?.hasMessage) }
        }
    };
}

export function runtimePriceText(price) {
    if (price?.kind !== 'sale' || !price.source || !price.currency
        || typeof price.amount !== 'number' || !Number.isFinite(price.amount) || price.amount < 0) return '';
    const units = { request: '次', image: '张', second: '秒' };
    return `${price.currency} ${price.amount}${price.unit ? '/' + (units[price.unit] || price.unit) : ''}`;
}

export function runtimeTaskTitle(run) {
    const plan = runtimeDisplayPlan(run);
    const kinds = new Set((plan?.steps || []).map(step => step.kind));
    let title = { memory: '保存项目记忆', board: '修改画板', generation: '生成素材', external: '操作外部软件' }[plan?.kind];
    if (plan?.kind === 'generation') {
        if (kinds.has('image') && kinds.has('video')) title = '生成图片与视频';
        else if (kinds.has('image')) title = '生成图片';
        else if (kinds.has('video')) title = '生成视频';
    }
    return `${run.status === 'awaiting_confirmation' ? '待确认：' : ''}${title || '执行任务'}`;
}

export function runtimeEstimateText(plan) {
    if (!plan || (plan.kind && plan.kind !== 'generation')) return '';
    const known = plan.priceKnown === true && plan.steps?.length
        && plan.steps.every(step => runtimePriceText(step.price) && step.price.currency === plan.currency)
        && typeof plan.estimatedCost === 'number' && Number.isFinite(plan.estimatedCost)
        && plan.estimatedCost >= 0 && plan.currency;
    return known ? `预计费用：${plan.currency} ${plan.estimatedCost}` : '预计费用：未知';
}

export function runtimeStepSources(step) {
    return (Array.isArray(step.references) ? step.references : []).map((reference, index) => {
        const path = reference.filePath || reference.url || '';
        const name = reference.name || reference.title || String(path).replace(/\\/g, '/').split('/').pop();
        return { name: name || `参考素材 ${index + 1}`, path };
    });
}

export function runtimeProgressText(run) {
    const latest = [...(run.events || [])].reverse().find(event =>
        ['tool_started', 'tool_result', 'review', 'step'].includes(event.type));
    if (!latest) return '';
    const eventLabels = { tool_started: '正在执行', tool_result: '执行结果已返回', review: '正在检查结果' };
    const stepLabels = { queued: '步骤待执行', preparing: '正在准备步骤', submitting: '正在提交步骤',
        submitted: '步骤已提交', downloaded: '产出已下载', completed: '步骤已完成', failed: '步骤失败', unknown: '步骤状态待核对' };
    const step = [...(run.steps || []), ...(runtimeDisplayPlan(run)?.steps || [])]
        .find(entry => entry.id === latest.data?.stepId && entry.title);
    const label = latest.type === 'step' ? stepLabels[latest.data?.status] || '步骤状态更新' : eventLabels[latest.type];
    return [label, latest.data?.title || step?.title || latest.data?.summary].filter(Boolean).join(' · ');
}

export class AgentRuntimeClient {
    constructor(api, { onChange = () => {}, onError = () => {}, onSync = () => {}, beforeExecute } = {}) {
        this.api = api;
        this.onChange = onChange;
        this.onError = onError;
        this.onSync = onSync;
        this.beforeExecute = beforeExecute;
        this.runs = new Map();
        this.cursors = new Map();
        this.pending = new Map();
        this.refreshAgain = new Set();
        this.actions = new Set();
        this.confirmedVersions = new Map();
        this.scopes = new Map();
        this.listPending = new Set();
        this.closed = false;
    }

    connect() {
        if (this.timer || this.closed) return;
        try {
            this.unsubscribe = this.api.onEvent?.(event => {
                if (event?.runId) void this.refresh(event.runId);
            });
        } catch (error) { this.onError(error); }
        this.timer = setInterval(() => {
            for (const run of this.runs.values()) {
                if (!isRuntimeTerminal(run.status)) void this.refresh(run.id);
            }
            for (const scope of this.scopes.values()) void this.watch(scope);
        }, 2500);
    }

    accept(snapshot) {
        if (this.closed || !snapshot?.id) return null;
        const previous = this.runs.get(snapshot.id);
        const run = mergeRuntimeSnapshot(previous, snapshot);
        if (run === previous) return previous;
        if (previous && JSON.stringify(previous) === JSON.stringify(run)) return previous;
        this.runs.set(run.id, run);
        this.onChange(run);
        return run;
    }

    async watch(scope) {
        if (this.closed) return;
        const key = runtimeScopeKey(scope.projectId, scope.conversationId);
        this.scopes.set(key, scope);
        if (this.listPending.has(key)) return;
        this.listPending.add(key);
        try {
            const snapshots = await this.api.list(scope);
            if (this.closed) return;
            if (!Array.isArray(snapshots)) throw new Error('运行列表格式无效');
            this.onSync(scope);
            for (const snapshot of snapshots) {
                if (snapshot.projectId === scope.projectId && (!scope.conversationId || snapshot.conversationId === scope.conversationId)) {
                    this.accept(snapshot);
                    if (!this.cursors.has(snapshot.id) || this.cursors.get(snapshot.id) < snapshot.lastSeq) {
                        void this.refresh(snapshot.id);
                    }
                }
            }
        } catch (error) { if (!this.closed) this.onError(error, scope); }
        finally {
            this.listPending.delete(key);
        }
    }

    refresh(runId) {
        if (this.closed) return Promise.resolve(null);
        if (this.pending.has(runId)) {
            this.refreshAgain.add(runId);
            return this.pending.get(runId);
        }
        const request = (async () => {
            try {
                const snapshot = await this.api.get({ runId, afterSeq: this.cursors.get(runId) || 0 });
                if (this.closed) return null;
                if (snapshot?.id !== runId) throw new Error('运行快照格式无效');
                this.onSync(snapshot);
                this.cursors.set(runId, Math.max(this.cursors.get(runId) || 0, Number(snapshot.lastSeq) || 0));
                return this.accept(snapshot);
            } catch (error) {
                if (!this.closed) this.onError(error, this.runs.get(runId));
                return null;
            }
        })();
        this.pending.set(runId, request);
        void request.finally(() => {
            this.pending.delete(runId);
            if (this.refreshAgain.delete(runId) && !this.closed) void this.refresh(runId);
        });
        return request;
    }

    async act(runId, action, instruction) {
        const run = this.runs.get(runId);
        if (this.closed || !run || this.actions.has(runId) || !runtimeActions(run).includes(action)) return;
        if (action === 'confirm' && this.confirmedVersions.get(runId) === run.plan.version) return;
        if (action === 'revise' && !String(instruction || '').trim()) return;
        this.actions.add(runId);
        try {
            this.onChange(run);
            if (['confirm', 'resume'].includes(action) && await this.beforeExecute?.() === false) {
                throw new Error('本地画板保存失败，任务未执行。请先解决保存问题后重试。');
            }
            if (this.closed) return;
            const args = { runId };
            if (action === 'confirm') args.planVersion = run.plan.version;
            if (action === 'revise') args.instruction = String(instruction).trim();
            const result = await this.api[action](args);
            if (action === 'confirm') this.confirmedVersions.set(runId, run.plan.version);
            if (result?.id === runId) this.accept(result);
            await this.refresh(runId);
        } finally {
            this.actions.delete(runId);
            if (!this.closed) this.onChange(this.runs.get(runId));
        }
    }

    dispose() {
        this.closed = true;
        clearInterval(this.timer);
        this.timer = null;
        if (typeof this.unsubscribe === 'function') this.unsubscribe();
        this.unsubscribe = null;
    }
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

export function createRuntimeCard({ onAction, onLocate }) {
    const root = element('section', 'agent-runtime-card');
    const elapsed = element('div', 'agent-msg-duration');
    elapsed.title = '从发送到当前状态的总用时';
    const header = element('div', 'agent-runtime-header');
    const title = element('strong', '', '执行任务');
    const status = element('span', 'agent-runtime-status');
    status.setAttribute('role', 'status');
    header.append(title, status);
    const summary = element('p', 'agent-runtime-summary');
    const steps = element('ol', 'agent-runtime-steps');
    const estimate = element('p', 'agent-runtime-progress');
    const proposed = element('details', 'agent-runtime-proposed');
    const proposedLabel = element('summary', '');
    const proposedText = element('pre', '');
    proposed.append(proposedLabel, proposedText);
    const progress = element('p', 'agent-runtime-progress');
    const output = element('div', 'agent-runtime-output');
    const review = element('p', 'agent-runtime-review');
    const error = element('p', 'agent-runtime-error');
    error.setAttribute('role', 'alert');
    const actions = element('div', 'agent-runtime-actions');
    const feedback = element('form', 'agent-runtime-feedback');
    feedback.hidden = true;
    const input = element('textarea', '');
    input.rows = 2;
    input.placeholder = '修改意见';
    input.setAttribute('aria-label', '修改意见');
    const submit = element('button', '', '提交修改');
    submit.type = 'submit';
    feedback.append(input, submit);
    root.append(elapsed, header, summary, steps, estimate, proposed, progress, output, review, error, actions, feedback);
    let current;
    let localError = '';
    let renderedPlan = '';
    let renderedActions = '';
    const invoke = async (action, instruction) => {
        localError = '';
        try {
            await onAction(current.id, action, instruction);
            if (action === 'revise') { feedback.hidden = true; input.value = ''; }
        } catch (failure) {
            localError = String(failure?.message || failure);
        }
        error.textContent = localError || String(current.error?.message || current.error || '');
        error.hidden = !error.textContent;
    };
    feedback.addEventListener('submit', event => {
        event.preventDefault();
        if (input.value.trim()) void invoke('revise', input.value);
    });
    return {
        root,
        update(run, { busy = false, saved = false, confirmed = false } = {}) {
            current = run;
            elapsed.textContent = Number.isFinite(run.createdAt) && Number.isFinite(run.updatedAt)
                ? formatAgentElapsed(Math.max(0, run.updatedAt - run.createdAt)) : '';
            elapsed.hidden = !elapsed.textContent || (saved && isRuntimeTerminal(run.status));
            const plan = runtimeDisplayPlan(run);
            root.dataset.runId = run.id;
            root.dataset.status = run.status;
            title.textContent = runtimeTaskTitle(run);
            title.title = plan ? String(plan.version) : '';
            status.textContent = STATUS_LABELS[run.status] || '同步状态';
            summary.textContent = plan?.summary || '';
            summary.hidden = !summary.textContent;
            const planKey = JSON.stringify(plan);
            if (planKey !== renderedPlan) {
                renderedPlan = planKey;
                steps.replaceChildren();
                for (const step of plan?.steps || []) {
                    const row = element('li', '');
                    row.append(element('span', '', step.title));
                    const price = runtimePriceText(step.price);
                    const detail = element('small', '', [
                        step.model, step.count != null ? `数量 ${step.count}` : '',
                        price || (plan.kind === 'generation' || !plan.kind ? '价格未知' : '')
                    ].filter(Boolean).join(' · '));
                    if (price) detail.title = [step.price.source, step.price.updatedAt].filter(Boolean).join(' · ');
                    row.append(detail);
                    if (step.prompt || step.originalPrompt || step.config || step.references?.length) {
                        const parameters = element('details', 'agent-runtime-proposed');
                        parameters.append(element('summary', '', '参考素材、提示词与参数'));
                        const sources = runtimeStepSources(step);
                        if (sources.length) {
                            const references = element('ol', 'agent-runtime-sources');
                            for (const source of sources) {
                                const item = element('li', '', source.name);
                                item.title = source.path;
                                references.append(item);
                            }
                            parameters.append(references);
                        }
                        if (step.originalPrompt && step.originalPrompt !== step.prompt) {
                            parameters.append(element('p', 'agent-runtime-step-prompt', `原始提示词：\n${step.originalPrompt}`));
                        }
                        if (step.prompt) parameters.append(element('p', 'agent-runtime-step-prompt', `生成提示词：\n${step.prompt}`));
                        if (step.config) parameters.append(element('pre', '', JSON.stringify(step.config, null, 2)));
                        row.append(parameters);
                    }
                    steps.append(row);
                }
            }
            steps.hidden = !steps.childElementCount;
            estimate.textContent = runtimeEstimateText(plan);
            estimate.hidden = !estimate.textContent;
            proposed.hidden = !plan?.proposed;
            proposedLabel.textContent = plan?.kind === 'memory' ? '记忆约束' : plan?.kind === 'external' ? '外部工具参数' : '画板变更';
            const proposedJson = plan?.proposed ? JSON.stringify(plan.proposed, null, 2) : '';
            if (proposedText.textContent !== proposedJson) {
                proposedText.textContent = proposedJson;
                proposed.open = plan?.kind === 'memory';
            }
            progress.textContent = runtimeProgressText(run);
            progress.hidden = !progress.textContent;
            output.textContent = saved && isRuntimeTerminal(run.status) ? '' : runtimeDisplayText(run);
            output.hidden = !output.textContent;
            review.textContent = run.review ? `审阅：${run.review}` : '';
            review.hidden = !review.textContent;
            error.textContent = localError || String(run.error?.message || run.error || '');
            error.hidden = !error.textContent;
            submit.disabled = busy;
            if (!runtimeActions(run).includes('revise')) feedback.hidden = true;
            const outputFiles = onLocate ? runtimeOutputFiles(run).filter(file => file.filePath) : [];
            const actionKey = JSON.stringify([run.id, runtimeActions(run), busy, confirmed, outputFiles]);
            if (actionKey === renderedActions) return;
            renderedActions = actionKey;
            actions.replaceChildren();
            const labels = { confirm: '确认执行', revise: '修改计划', cancel: '取消任务', resume: '恢复查询', retry: '重试失败项' };
            for (const action of runtimeActions(run)) {
                const button = element('button', '', labels[action]);
                button.type = 'button';
                button.disabled = busy;
                if (action === 'confirm' && confirmed) {
                    button.disabled = true;
                    button.textContent = '已确认';
                }
                button.addEventListener('click', () => {
                    if (action === 'revise') {
                        feedback.hidden = !feedback.hidden;
                        if (!feedback.hidden) input.focus();
                    } else void invoke(action);
                });
                actions.append(button);
            }
            for (const file of outputFiles) {
                const button = element('button', 'agent-runtime-locate');
                button.type = 'button';
                button.title = `定位产出：${file.filePath}`;
                button.setAttribute('aria-label', button.title);
                button.innerHTML = '<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-folder"></use></svg>';
                button.addEventListener('click', () => onLocate(file, run));
                actions.append(button);
            }
        }
    };
}
