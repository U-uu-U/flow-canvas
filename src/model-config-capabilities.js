// 模型能力查询与请求校验。
//
// 两层用途：
//   1. 「能做什么 / 不能做什么」——给 UI 渲染能力面板（describeModelCapabilities）；
//   2. 提交前校验——在 UI 层就把上游一定会拒绝的参数拦下来（validateModelRequest）。
//
// 两个刻意的设计决定：
//
//   · 匹配不到模型时**不做任何限制**。CONFIG 是白名单式的能力表，不是防火墙；未收录的
//     自定义线路必须能照常生成，只给出「未收录，未做参数限制」的提示。
//   · 同一个模型名命中多条线路时（例如 minimax-h3 同时存在「兼容线路」和「按秒线路」），
//     逐条校验后按「所有候选都报的问题 = 错误，部分候选报的问题 = 警告」归并。这样既不会
//     因为猜错线路而误拦，也不会放过所有线路都禁止的参数。
import { IMAGE_RESOLUTION_TIERS, inferImageResolutionTier } from './image-node-settings.js';

export const MODEL_CONFIG_ISSUE_CODES = Object.freeze({
    PROMPT_REQUIRED: 'PROMPT_REQUIRED',
    PROMPT_TOO_LONG: 'PROMPT_TOO_LONG',
    PARAM_UNSUPPORTED: 'PARAM_UNSUPPORTED',
    VALUE_NOT_ALLOWED: 'VALUE_NOT_ALLOWED',
    VALUE_OUT_OF_RANGE: 'VALUE_OUT_OF_RANGE',
    VALUE_MUST_BE: 'VALUE_MUST_BE',
    FEATURE_UNSUPPORTED: 'FEATURE_UNSUPPORTED',
    REFERENCE_LIMIT: 'REFERENCE_LIMIT',
    REFERENCE_TOO_LARGE: 'REFERENCE_TOO_LARGE',
    PARAM_UNVERIFIED: 'PARAM_UNVERIFIED'
});

// 会真正发到上游、且值得做「是否被接受」判定的字段。
//
// 刻意不包含：
//   · 图片的 responseFormat / historyDisabled / stream —— 渲染层对所有模型都会带上它们，
//     非 gpt-image-2 的线路在适配层直接忽略，拦下来只会误伤；
//   · 图片的 ratio —— 它被折算进 size 的宽高，不作为独立参数发送；
//   · 图片的 negativePrompt —— 非 MJ 线路是拼进提示词文本，不是独立参数；
//   · 各类能力开关（webSearch / cameraFixed / generateAudio / watermark）—— 它们走
//     「能力」通道，只按条目**明确声明** supported:false 拦截。
// 不在表里的字段仅在 CONFIG 显式声明了约束时才校验。
const WIRE_FIELDS_BY_KIND = Object.freeze({
    image: ['resolutionTier', 'n', 'quality'],
    video: ['resolutionTier', 'ratio', 'duration', 'workflowId'],
    text: ['messages', 'tools', 'stream']
});

// 能力开关 → 对应的 node 配置字段/key。用于「请求里开了某个能力，但模型不支持」的拦截。
const FEATURE_FIELDS = Object.freeze({
    webSearch: 'webSearch',
    cameraFixed: 'cameraFixed',
    generatedAudio: 'generateAudio',
    watermark: 'watermark',
    negativePrompt: 'negativePrompt'
});

const REFERENCE_KINDS = Object.freeze({
    referenceImages: { input: 'image', unit: '张', label: '参考图' },
    referenceVideos: { input: 'video', unit: '个', label: '参考视频' },
    referenceAudios: { input: 'audio', unit: '个', label: '参考音频' }
});

const DEFAULT_REFERENCE_LIMITS = Object.freeze({ image: 9, video: 3, audio: 3 });

const normalizeText = value => String(value ?? '').replace(/\s+/g, ' ').trim();

export function fieldParamAliases(config, field) {
    const definition = config?.fields?.[field];
    const param = definition?.param;
    if (Array.isArray(param)) return param.map(normalizeText).filter(Boolean);
    const single = normalizeText(param);
    return single ? [single] : [field];
}

export function fieldForParam(config, param) {
    const target = normalizeText(param).toLowerCase();
    if (!target) return '';
    const fields = config?.fields || {};
    if (fields[target]) return target;
    for (const [field, definition] of Object.entries(fields)) {
        const aliases = Array.isArray(definition?.param) ? definition.param : [definition?.param];
        if (aliases.some(alias => normalizeText(alias).toLowerCase() === target)) return field;
    }
    return '';
}

export function entryAcceptsField(config, entry, field) {
    const accepts = Array.isArray(entry?.parameters?.accepts) ? entry.parameters.accepts : [];
    if (!accepts.length) return true;
    const accepted = new Set(accepts.map(value => normalizeText(value).toLowerCase()));
    if (accepted.has(normalizeText(field).toLowerCase())) return true;
    return fieldParamAliases(config, field).some(alias => accepted.has(normalizeText(alias).toLowerCase()));
}

export function entryCapabilitySupported(config, entry, key) {
    const declared = entry?.capabilities?.[key];
    if (declared && typeof declared.supported === 'boolean') return declared.supported;
    const vocabulary = config?.capabilities?.[key];
    const fields = Array.isArray(vocabulary?.fields) ? vocabulary.fields : [];
    if (entry?.parameters?.accepts?.length && fields.some(field => entryAcceptsField(config, entry, field))) return true;
    return null;
}

export function fieldLabel(config, field) {
    return normalizeText(config?.fields?.[field]?.label) || field;
}

export function kindLabel(config, kind) {
    return normalizeText(config?.kinds?.[kind]) || kind;
}

// ── 模型 → 条目匹配 ───────────────────────────────────────────
export function matchModelConfigEntries(config, provider = {}) {
    const model = normalizeText(provider.model);
    if (!model) return [];
    const endpoint = normalizeText(provider.endpoint).toLowerCase();
    const name = normalizeText(provider.name);
    const kind = normalizeText(provider.kind || provider.capability).toLowerCase();
    const matches = [];

    for (const entry of config?.models || []) {
        if (kind && entry.kind !== kind) continue;
        const modelMatched = (entry.match?.model || []).some(source => {
            try {
                return new RegExp(source, 'i').test(model);
            } catch (_) {
                return false;
            }
        });
        if (!modelMatched) continue;

        let score = Number(entry.priority) || 0;
        let endpointMatched = false;
        if (entry.match?.endpoint) {
            // 声明了 endpoint 的条目只在对应线路上生效（例如 MiniMax H3 原生任务中心），
            // 否则同名模型在没有 endpoint 信息时会被它错误地抢走。
            try {
                endpointMatched = Boolean(endpoint) && new RegExp(entry.match.endpoint, 'i').test(endpoint);
            } catch (_) {
                endpointMatched = false;
            }
            if (!endpointMatched) continue;
        }
        // 线路名（渠道）与用户填写的 API 名称对得上时，用来在「同名不同线路」之间消歧。
        const channel = normalizeText(entry.channel);
        const channelMatched = Boolean(channel) && Boolean(name)
            && (name.includes(channel) || channel.includes(name));
        if (endpointMatched) score += 40;
        if (channelMatched) score += 20;
        matches.push({ entry, score, endpointMatched, channelMatched });
    }

    return matches.sort((left, right) => right.score - left.score);
}

export function resolveModelConfigEntry(config, provider = {}) {
    const matches = matchModelConfigEntries(config, provider);
    if (!matches.length) {
        return { entry: null, candidates: [], ambiguous: false, matched: false, kind: normalizeText(provider.kind || provider.capability) };
    }
    const best = matches[0];
    const candidates = matches.filter(match => match.entry.kind === best.entry.kind).map(match => match.entry);
    return {
        entry: best.entry,
        candidates,
        // 只有「多条线路都命中、且没有任何证据（endpoint / 线路名）能区分」时才算歧义。
        // 此时校验会退化成「所有候选都禁止才拦截」，见 validateModelRequest。
        ambiguous: matches.length > 1 && !(best.endpointMatched || best.channelMatched),
        matched: true,
        kind: best.entry.kind
    };
}

// ── 约束 → 摘要文本 ──────────────────────────────────────────
export function describeConstraint(config, field, constraint) {
    if (!constraint || typeof constraint !== 'object') return '';
    const label = fieldLabel(config, field);
    switch (constraint.type) {
        case 'enum': {
            const values = (constraint.values || []).map(value => formatOptionValue(config, value));
            const auto = constraint.allowAuto ? '自动' : '';
            return `${label}：${[auto, ...values].filter(Boolean).join(' / ')}`;
        }
        case 'tier':
            return `${label}：${(constraint.values || []).join(' / ')}`;
        case 'range': {
            const unit = constraint.unit === 'second' ? ' 秒' : '';
            const integer = constraint.integer ? ' 的整数' : '';
            return `${label}：${constraint.min}-${constraint.max}${unit}${integer}`;
        }
        case 'fixed':
            return `${label}：固定 ${formatOptionValue(config, constraint.value)}${constraint.unit === 'second' ? ' 秒' : ''}`;
        case 'unsupported':
            return `${label}：${normalizeText(constraint.reason) || '不支持'}`;
        case 'unknown':
            return `${label}：${normalizeText(constraint.reason) || '边界以下游为准'}`;
        default:
            return label;
    }
}

function formatOptionValue(config, value) {
    if (value === null || value === undefined) return '';
    const labels = config?.fields?.ratio?.labels;
    if (labels && typeof labels === 'object' && labels[String(value)]) return String(labels[String(value)]);
    return String(value);
}

// 「能做什么 / 不能做什么 / 限制」——UI 能力面板直接消费这个结构。
export function describeModelCapabilities(config, entry, { originLabel = '' } = {}) {
    if (!entry) return null;
    const can = [];
    const cannot = [];
    const limits = [];
    const notes = [];

    const vocabulary = config?.capabilities || {};
    const keys = new Set([...Object.keys(vocabulary), ...Object.keys(entry.capabilities || {})]);
    for (const key of keys) {
        const definition = vocabulary[key] || {};
        const kinds = Array.isArray(definition.kinds) ? definition.kinds : (definition.kind ? [definition.kind] : []);
        if (kinds.length && !kinds.includes(entry.kind)) continue;
        const declared = entry.capabilities?.[key] || {};
        const supported = entryCapabilitySupported(config, entry, key);
        const label = normalizeText(definition.label) || key;
        if (supported === null) {
            notes.push(`${label}：尚未确认`);
            continue;
        }
        if (supported === false) {
            const reason = normalizeText(declared.reason) || normalizeText(declared.note)
                || normalizeText(definition.note) || '该线路不支持';
            cannot.push({ key, label, reason });
            continue;
        }
        const details = [];
        if (Number.isFinite(Number(declared.max))) details.push(`最多 ${declared.max}${REFERENCE_KINDS[key]?.unit || ' 个'}`);
        if (Number.isFinite(Number(declared.maxBytesPerImage))) details.push(`单张 ≤ ${Math.round(declared.maxBytesPerImage / (1024 * 1024))}MB`);
        if (normalizeText(declared.note)) details.push(normalizeText(declared.note));
        const fieldNote = (definition.fields || []).map(field => describeConstraint(config, field, entry.options?.[field]))
            .find(text => text && !text.endsWith('边界以下游为准'));
        can.push({ key, label, detail: details.join('；') || (fieldNote || '').replace(`${label}：`, '') });
    }

    for (const [field, constraint] of Object.entries(entry.options || {})) {
        if (!constraint || constraint.type === 'unsupported') continue;
        const text = describeConstraint(config, field, constraint);
        if (!text) continue;
        if (constraint.type === 'unknown') notes.push(text);
        else limits.push(text);
    }

    const prompt = entry.prompt || {};
    if (prompt.required) limits.push('提示词：必填');
    else limits.push('提示词：可选');
    if (Number.isFinite(Number(prompt.maxLength))) limits.push(`提示词长度：≤ ${prompt.maxLength} 字`);

    const limitNotes = [];
    if (Number.isFinite(Number(entry.limits?.concurrency))) limitNotes.push(`并发：${entry.limits.concurrency}`);
    if (Number.isFinite(Number(entry.limits?.resultsPerRequest))) {
        limitNotes.push(`单次返回：${entry.limits.resultsPerRequest} 张`
            + (normalizeText(entry.limits?.resultsPerRequestNote) ? `（${normalizeText(entry.limits.resultsPerRequestNote)}）` : ''));
    }
    if (Number.isFinite(Number(entry.limits?.passRate))) {
        limitNotes.push(`通过率：约 ${Math.round(Number(entry.limits.passRate) * 100)}%`);
    } else if (normalizeText(entry.limits?.passRateNote)) {
        limitNotes.push(`通过率：${normalizeText(entry.limits.passRateNote)}`);
    }
    for (const [key, value] of Object.entries(entry.limits || {})) {
        if (value && typeof value === 'object' && value.type === 'unknown') {
            notes.push(`${key}：${normalizeText(value.reason) || '未维护'}`);
        }
    }
    if (normalizeText(entry.limits?.note)) notes.push(normalizeText(entry.limits.note));

    return {
        id: entry.id,
        label: normalizeText(entry.label) || entry.id,
        kind: entry.kind,
        kindLabel: kindLabel(config, entry.kind),
        channel: normalizeText(entry.channel),
        route: normalizeText(entry.route),
        originLabel,
        can,
        cannot,
        limits,
        notes,
        notesText: normalizeText(entry.notes)
    };
}

// ── 请求校验 ─────────────────────────────────────────────────
function normalizeReferenceInput(references, key) {
    const raw = references?.[REFERENCE_KINDS[key].input];
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'number') return { count: Math.max(0, Math.trunc(raw)), maxBytes: null };
    return {
        count: Math.max(0, Math.trunc(Number(raw.count) || 0)),
        maxBytes: Number.isFinite(Number(raw.maxBytes)) ? Number(raw.maxBytes) : null
    };
}

function isAutoValue(value) {
    const text = normalizeText(value).toLowerCase();
    return text === '' || text === 'auto' || text === 'adaptive' || text === '-1' || text === '自动' || text === '智能';
}

function checkFieldConstraint(config, entry, field, value, issues) {
    const constraint = entry.options?.[field];
    const label = fieldLabel(config, field);
    if (!constraint || typeof constraint !== 'object') return;
    switch (constraint.type) {
        case 'unsupported':
            issues.push({
                code: MODEL_CONFIG_ISSUE_CODES.PARAM_UNSUPPORTED,
                field,
                message: `${label}：${normalizeText(constraint.reason) || '该模型不支持该参数'}`
            });
            return;
        case 'unknown':
            issues.push({
                code: MODEL_CONFIG_ISSUE_CODES.PARAM_UNVERIFIED,
                field,
                severity: 'warning',
                message: `${label}：${normalizeText(constraint.reason) || '边界以下游实际返回为准'}`
            });
            return;
        case 'enum': {
            const values = constraint.values || [];
            if (isAutoValue(value) && (constraint.allowAuto || values.some(candidate => isAutoValue(candidate)))) return;
            const matched = values.some(candidate => String(candidate) === String(value)
                || (typeof candidate === 'number' && Number(candidate) === Number(value)));
            if (!matched) {
                issues.push({
                    code: MODEL_CONFIG_ISSUE_CODES.VALUE_NOT_ALLOWED,
                    field,
                    message: `${label}：只支持 ${values.map(candidate => formatOptionValue(config, candidate)).join(' / ')}`,
                    suggestion: values.includes(Number(value)) ? Number(value) : values[0]
                });
            }
            return;
        }
        case 'tier': {
            const values = constraint.values || [];
            const tier = resolveTierValue(config, field, value);
            if (!tier) return;
            if (!values.includes(tier)) {
                issues.push({
                    code: MODEL_CONFIG_ISSUE_CODES.VALUE_NOT_ALLOWED,
                    field,
                    message: `${label}：只支持 ${values.join(' / ')}`,
                    suggestion: values.includes('1K') ? '1K' : values[0]
                });
            }
            return;
        }
        case 'range': {
            const number = Number(value);
            if (!Number.isFinite(number)) {
                issues.push({
                    code: MODEL_CONFIG_ISSUE_CODES.VALUE_OUT_OF_RANGE,
                    field,
                    message: `${label}：需要 ${constraint.min}-${constraint.max} 之间的数字`
                });
                return;
            }
            if (constraint.integer && !Number.isInteger(number)) {
                issues.push({
                    code: MODEL_CONFIG_ISSUE_CODES.VALUE_OUT_OF_RANGE,
                    field,
                    message: `${label}：需要整数秒（${constraint.min}-${constraint.max}）`
                });
                return;
            }
            if (number < constraint.min || number > constraint.max) {
                issues.push({
                    code: MODEL_CONFIG_ISSUE_CODES.VALUE_OUT_OF_RANGE,
                    field,
                    message: `${label}：需要在 ${constraint.min}-${constraint.max} 之间`,
                    suggestion: Math.min(constraint.max, Math.max(constraint.min, number))
                });
            }
            return;
        }
        case 'fixed': {
            if (String(constraint.value) !== String(value)) {
                issues.push({
                    code: MODEL_CONFIG_ISSUE_CODES.VALUE_MUST_BE,
                    field,
                    message: `${label}：固定为 ${formatOptionValue(config, constraint.value)}`,
                    suggestion: constraint.value
                });
            }
            return;
        }
        default:
            return;
    }
}

// 图片的 size 可能是 '4K' 这样的档位，也可能是 '3840x2160' 这样的实际像素。
function resolveTierValue(config, field, value) {
    const text = normalizeText(value);
    if (!text) return '';
    if (IMAGE_RESOLUTION_TIERS.includes(text)) return text;
    const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(text);
    if (match) return inferImageResolutionTier(Number(match[1]), Number(match[2]));
    const constraint = config?.fields?.[field];
    if (constraint?.type === 'tier') return text;
    return text;
}

// 单条候选线路的校验结果。
function collectEntryIssues(config, entry, request) {
    const issues = [];
    const prompt = String(request.prompt ?? '').trim();
    const promptConfig = entry.prompt || {};
    if (request.promptResolved !== false && promptConfig.required && !prompt) {
        issues.push({
            code: MODEL_CONFIG_ISSUE_CODES.PROMPT_REQUIRED,
            field: 'prompt',
            message: '该模型必须填写提示词'
        });
    }
    if (request.promptResolved !== false && Number.isFinite(Number(promptConfig.maxLength)) && prompt.length > Number(promptConfig.maxLength)) {
        issues.push({
            code: MODEL_CONFIG_ISSUE_CODES.PROMPT_TOO_LONG,
            field: 'prompt',
            message: `提示词最长 ${promptConfig.maxLength} 字，当前 ${prompt.length} 字`
        });
    }

    const wireFields = new Set(WIRE_FIELDS_BY_KIND[entry.kind] || []);
    for (const [field, value] of Object.entries(request.fields || {})) {
        if (value === undefined || value === null || value === '') continue;
        const declared = Boolean(entry.options?.[field]);
        if (!declared && wireFields.has(field) && !entryAcceptsField(config, entry, field)) {
            issues.push({
                code: MODEL_CONFIG_ISSUE_CODES.PARAM_UNVERIFIED,
                field,
                message: `${fieldLabel(config, field)}：当前渠道文档未确认此参数`
            });
            continue;
        }
        checkFieldConstraint(config, entry, field, value, issues);
    }

    for (const [feature, field] of Object.entries(FEATURE_FIELDS)) {
        const requested = feature === 'negativePrompt'
            ? Boolean(normalizeText(request.fields?.negativePrompt))
            : (request.features?.[field] ?? request.features?.[feature]) === true;
        if (!requested) continue;
        const declared = entry.capabilities?.[feature];
        // 只有条目明确写了 supported:false 才拦截。未声明的能力一律放行——CONFIG 不可能
        // 穷举所有线路的每个开关，把「未声明」当成「不支持」会误拦本来可用的请求。
        if (declared?.supported !== false) continue;
        const label = normalizeText(config?.capabilities?.[feature]?.label) || fieldLabel(config, field);
        issues.push({
            code: MODEL_CONFIG_ISSUE_CODES.FEATURE_UNSUPPORTED,
            field,
            feature,
            message: `${label}：${normalizeText(declared.reason) || '该模型不支持'}`,
            suggestion: feature === 'negativePrompt' ? '' : false
        });
    }

    for (const [key, definition] of Object.entries(REFERENCE_KINDS)) {
        const input = normalizeReferenceInput(request.references, key);
        if (!input || input.count <= 0) continue;
        const declared = entry.capabilities?.[key];
        if (declared?.supported === false) {
            issues.push({
                code: MODEL_CONFIG_ISSUE_CODES.FEATURE_UNSUPPORTED,
                field: key,
                feature: key,
                message: `${definition.label}：${normalizeText(declared.reason) || '该模型不支持'}`,
                suggestion: 0
            });
            continue;
        }
        if (declared?.supported !== true) continue;
        const max = Number(declared.max);
        if (Number.isFinite(max) && input.count > max) {
            issues.push({
                code: MODEL_CONFIG_ISSUE_CODES.REFERENCE_LIMIT,
                field: key,
                feature: key,
                message: `${definition.label}最多 ${max}${definition.unit}，当前 ${input.count}${definition.unit}`,
                suggestion: max
            });
        }
        const maxBytes = Number(declared.maxBytesPerImage);
        if (Number.isFinite(maxBytes) && input.maxBytes !== null && input.maxBytes > maxBytes) {
            issues.push({
                code: MODEL_CONFIG_ISSUE_CODES.REFERENCE_TOO_LARGE,
                field: key,
                feature: key,
                message: `${definition.label}单张最大 ${Math.round(maxBytes / (1024 * 1024))}MB`
            });
        }
    }

    // 首帧 / 尾帧是独立能力位（H3 三态里才有），单独校验。
    for (const key of ['firstFrame', 'lastFrame']) {
        if (request.features?.[key] !== true) continue;
        const declared = entry.capabilities?.[key];
        if (declared?.supported !== false) continue;
        issues.push({
            code: MODEL_CONFIG_ISSUE_CODES.FEATURE_UNSUPPORTED,
            field: key,
            feature: key,
            message: `${normalizeText(config?.capabilities?.[key]?.label) || key}：${normalizeText(declared.reason) || '该模型不支持'}`,
            suggestion: false
        });
    }

    return issues;
}

/**
 * 提交前的 UI 层校验。
 *
 * @param {object} options
 * @param {object} options.config       当前 CONFIG
 * @param {object} options.provider     { model, endpoint, name, kind }
 * @param {object} [options.fields]     规范化字段值（resolutionTier/ratio/duration/quality/n/...）
 * @param {object} [options.features]   请求的能力开关（webSearch/cameraFixed/generateAudio/watermark）
 * @param {object} [options.references] { image:{count,maxBytes}, video:{count}, audio:{count} }
 * @param {string} [options.prompt]
 * @returns {{ ok:boolean, matched:boolean, errors:Array, warnings:Array, entry:object|null, candidates:Array, ambiguous:boolean }}
 */
export function validateModelRequest(options = {}) {
    const { config, provider = {}, fields = {}, features = {}, references = {}, prompt = '', promptResolved = true } = options;
    const resolution = resolveModelConfigEntry(config, provider);
    if (!resolution.matched) {
        return {
            ok: true,
            matched: false,
            ambiguous: false,
            entry: null,
            candidates: [],
            errors: [],
            warnings: [{
                code: 'MODEL_NOT_IN_CONFIG',
                field: 'model',
                message: `模型 ${normalizeText(provider.model) || '(未选择)'} 未收录在模型配置中，本次不做参数限制`
            }]
        };
    }

    const request = { fields, features, references, prompt, promptResolved };
    const candidates = resolution.ambiguous ? resolution.candidates : [resolution.entry];
    const perCandidate = candidates.map(entry => collectEntryIssues(config, entry, request));

    // 归并：所有候选都报 = 错误；只有部分候选报 = 警告（可能换了线路就不支持）。
    const tally = new Map();
    perCandidate.forEach(issues => {
        for (const issue of new Set(issues.map(item => `${item.code}::${item.field}`))) {
            const [code, field] = issue.split('::');
            const record = tally.get(issue) || { code, field, count: 0, sample: null };
            record.count += 1;
            record.sample = issues.find(item => item.code === code && item.field === field) || record.sample;
            tally.set(issue, record);
        }
    });

    const errors = [];
    const warnings = [];
    const total = Math.max(1, perCandidate.length);
    for (const record of tally.values()) {
        const item = { code: record.code, field: record.field, message: record.sample?.message || '' };
        if (record.sample?.suggestion !== undefined) item.suggestion = record.sample.suggestion;
        if (record.code === MODEL_CONFIG_ISSUE_CODES.PARAM_UNVERIFIED || record.count < total) {
            warnings.push({ ...item, message: record.count < total ? `${item.message}（部分线路限制）` : item.message });
        } else {
            errors.push(item);
        }
    }

    return {
        ok: errors.length === 0,
        matched: true,
        ambiguous: resolution.ambiguous,
        entry: resolution.entry,
        candidates: resolution.candidates,
        errors,
        warnings
    };
}

// ── CONFIG → 既有 profile 形状 ───────────────────────────────
// 渲染层已有大量基于 video-model-profiles / image model profile 的裁剪逻辑（算力都花在
// 「按 profile 隐藏控件、回落非法值、断开超额连线」上）。与其另起一套，不如把 CONFIG
// 翻译成同样的形状，让既有逻辑自动生效。
export function toVideoProfileOverrides(config, entry) {
    if (!entry || entry.kind !== 'video') return null;
    const ratioOption = entry.options?.ratio;
    const durationOption = entry.options?.duration;
    const resolutionOption = entry.options?.resolutionTier;
    const overrides = {
        label: normalizeText(entry.label) || entry.id,
        capabilitySource: 'config',
        configId: entry.id
    };
    // Missing or unknown constraints must not erase working controls or references.
    if (['enum', 'fixed', 'unsupported'].includes(ratioOption?.type)) {
        const ratios = resolutionValues(ratioOption);
        Object.assign(overrides, {
            ratios, defaultRatio: pickDefault(ratioOption, ratios),
            resolveAdaptiveRatio: ratios.includes('adaptive'), adaptiveFallbackRatio: '16:9'
        });
    }
    if (['enum', 'fixed', 'unsupported'].includes(resolutionOption?.type)) {
        const resolutions = resolutionValues(resolutionOption);
        Object.assign(overrides, { resolutions, defaultResolution: pickDefault(resolutionOption, resolutions) });
    }
    let durations = null;
    let durationControl;
    if (durationOption?.type === 'fixed') {
        durations = [Number(durationOption.value)];
        durationControl = 'fixed';
    } else if (durationOption?.type === 'enum' && Array.isArray(durationOption.values)) {
        durations = durationOption.allowAuto ? [-1, ...durationOption.values.map(Number)] : durationOption.values.map(Number);
        durationControl = durationOption.allowAuto ? 'select' : 'segmented';
    } else if (durationOption?.type === 'range') {
        const min = Math.ceil(Number(durationOption.min));
        const max = Math.floor(Number(durationOption.max));
        durations = [];
        for (let value = min; value <= max && durations.length < 120; value += 1) durations.push(value);
        durationControl = 'slider';
    } else if (durationOption?.type === 'unsupported') {
        durations = [];
        durationControl = null;
    }
    if (durations !== null) {
        Object.assign(overrides, { durations, durationControl, defaultDuration: durationOption?.type === 'fixed'
            ? Number(durationOption.value)
            : (Number.isFinite(Number(durationOption?.default)) ? Number(durationOption.default) : (durations[0] ?? null)) });
    }
    for (const [key, field] of Object.entries({
        webSearch: 'supportsWebSearch', cameraFixed: 'supportsCameraFixed',
        generatedAudio: 'supportsGeneratedAudio', watermark: 'supportsWatermark'
    })) {
        const supported = entryCapabilitySupported(config, entry, key);
        if (supported !== null) overrides[field] = supported;
    }
    const referenceLimits = {};
    for (const [key, { input }] of Object.entries(REFERENCE_KINDS)) {
        const declared = entry.capabilities?.[key];
        if (declared?.supported === false) referenceLimits[input] = 0;
        else if (declared?.supported === true && Number.isFinite(declared.max)) referenceLimits[input] = declared.max;
    }
    if (Object.keys(referenceLimits).length) overrides.referenceLimits = referenceLimits;
    return overrides;
}

function resolutionValues(option) {
    if (!option) return [];
    if (option.type === 'enum' && Array.isArray(option.values)) return [...option.values];
    if (option.type === 'fixed') return [option.value];
    return [];
}

function pickDefault(option, values) {
    if (!option) return values[0] ?? null;
    if (option.default !== undefined && option.default !== null) return option.default;
    if (option.type === 'fixed') return option.value;
    return values[0] ?? null;
}

export function toImageProfileOverrides(config, entry) {
    if (!entry || entry.kind !== 'image') return null;
    const option = entry.options?.resolutionTier;
    if (!option) return null;
    if (option.type !== 'tier' && option.type !== 'enum' && option.type !== 'fixed') return null;
    const values = option.type === 'fixed' ? [option.value] : [...(option.values || [])];
    if (!values.length) return null;
    const tiers = values.filter(value => IMAGE_RESOLUTION_TIERS.includes(value));
    if (!tiers.length) return null;
    return {
        resolutionTiers: IMAGE_RESOLUTION_TIERS.filter(tier => tiers.includes(tier)),
        defaultResolutionTier: tiers.includes(option.default) ? option.default : tiers[0],
        capabilitySource: 'config',
        configId: entry.id
    };
}

// 用 CONFIG 覆盖既有 profile 的能力字段，但保留线路元数据（routeLabel/routeGroup/price 等）：
// Seedance 线路拆分、价格标签这些还在代码里维护，CONFIG 不接管它们。
export function mergeVideoProfile(baseProfile, overrides) {
    if (!overrides) return baseProfile;
    if (!baseProfile) return overrides;
    return {
        ...baseProfile,
        ...overrides,
        referenceLimits: { ...baseProfile.referenceLimits, ...overrides.referenceLimits },
        label: baseProfile.label || overrides.label,
        routeLabel: baseProfile.routeLabel,
        routeGroup: baseProfile.routeGroup,
        routeModelLabel: baseProfile.routeModelLabel,
        price: baseProfile.price
    };
}

export function mergeImageProfile(baseProfile, overrides) {
    if (!overrides) return baseProfile;
    if (!baseProfile) return overrides;
    return { ...baseProfile, ...overrides };
}

export { DEFAULT_REFERENCE_LIMITS };
