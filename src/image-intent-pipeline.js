const EDIT_PLAN_SCHEMA_VERSION = '1.0';
const PLANNER_PROMPT_VERSION = '1.1';
const PROVIDER_COMPILER_VERSION = 'openai-image.v1';

function asList(value) {
    if (Array.isArray(value)) return value.flat(Infinity).filter(entry => entry != null && entry !== '');
    return value == null || value === '' ? [] : [value];
}

function localResourceFilePath(value) {
    if (typeof value !== 'string' || !value.startsWith('local-res://')) return null;
    try {
        return decodeURIComponent(value.slice('local-res://'.length));
    } catch (_) {
        return value.slice('local-res://'.length);
    }
}

function normalizePath(value) {
    return String(value || '').replace(/\//g, '\\').toLowerCase();
}

function referenceLabel(index) {
    const numerals = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
    return `图${numerals[index] || index + 1}`;
}

function mentionSpans(text, token) {
    const source = String(text || '');
    const needle = String(token || '');
    if (!needle) return [];
    const spans = [];
    let cursor = 0;
    while (cursor <= source.length - needle.length) {
        const start = source.indexOf(needle, cursor);
        if (start < 0) break;
        const before = source.slice(0, start);
        spans.push({
            start,
            end: start + needle.length,
            sentenceIndex: (before.match(/[。！？!?\n]/g) || []).length,
            leftContext: source.slice(Math.max(0, start - 48), start),
            rightContext: source.slice(start + needle.length, start + needle.length + 48)
        });
        cursor = start + needle.length;
    }
    return spans;
}

function inputReferenceCandidates(inputContext = []) {
    return asList(inputContext).flatMap((entry, connectionIndex) => {
        const values = asList(entry?.values);
        const paths = values.map(localResourceFilePath).filter(Boolean);
        if (!paths.length && entry?.source?.filePath) paths.push(entry.source.filePath);
        return paths.map(filePath => ({
            connectionId: String(entry?.connectionId || ''),
            connectionIndex: Number.isFinite(entry?.connectionIndex) ? entry.connectionIndex : connectionIndex,
            sourceNodeId: String(entry?.sourceNodeId || entry?.source?.id || ''),
            sourcePort: String(entry?.sourcePort || ''),
            filePath,
            generationHistory: entry?.source?.fromNodeId
                ? { parentNodeId: String(entry.source.fromNodeId) }
                : undefined
        }));
    });
}

export function buildReferenceContext({
    targetNodeId,
    originalPrompt,
    promptWithReferenceTokens,
    sourceReferences = [],
    inputContext = [],
    config = {}
} = {}) {
    const citationIds = Array.isArray(config.referenceCitationIds) ? config.referenceCitationIds : [];
    const citationLabels = Array.isArray(config.referenceCitationLabels) ? config.referenceCitationLabels : [];
    const citationByConnection = new Map(citationIds.map((id, index) => [String(id), citationLabels[index] || '']));
    const candidates = inputReferenceCandidates(inputContext);
    const usedCandidateIndexes = new Set();
    const textWithTokens = String(promptWithReferenceTokens || originalPrompt || '').trim();

    const references = asList(sourceReferences).map((reference, uploadIndex) => {
        const filePath = String(reference?.filePath || reference || '').trim();
        const normalized = normalizePath(filePath);
        let candidateIndex = candidates.findIndex((candidate, index) =>
            !usedCandidateIndexes.has(index) && normalizePath(candidate.filePath) === normalized
        );
        if (candidateIndex >= 0) usedCandidateIndexes.add(candidateIndex);
        const candidate = candidateIndex >= 0 ? candidates[candidateIndex] : null;
        const capsuleLabel = citationByConnection.get(candidate?.connectionId) || referenceLabel(uploadIndex);

        return {
            referenceId: `ref-${uploadIndex + 1}`,
            capsuleLabel,
            sourceNodeId: candidate?.sourceNodeId || (uploadIndex === 0 ? String(targetNodeId || '') : ''),
            sourceConnectionId: candidate?.connectionId || null,
            originalFilePath: filePath,
            originalImageHash: null,
            uploadIndex,
            connectionIndex: candidate?.connectionIndex ?? uploadIndex,
            mentionSpans: mentionSpans(textWithTokens, capsuleLabel),
            ...(candidate?.generationHistory ? { generationHistory: candidate.generationHistory } : {})
        };
    });

    return {
        schema: 'flow-canvas.reference-context.v1',
        targetNodeId: String(targetNodeId || ''),
        originalPrompt: String(originalPrompt || ''),
        promptWithReferenceTokens: textWithTokens,
        references
    };
}

export function extractDeterministicSignals(context = {}) {
    const references = Array.isArray(context.references) ? context.references : [];
    return {
        schema: 'flow-canvas.deterministic-signals.v1',
        referenceMentions: references.map(reference => ({
            referenceId: reference.referenceId,
            spans: (reference.mentionSpans || []).map(span => ({
                start: span.start,
                end: span.end,
                sentenceIndex: span.sentenceIndex,
                nearbyText: `${span.leftContext || ''}${reference.capsuleLabel || ''}${span.rightContext || ''}`
            }))
        })),
        referenceBindings: references.map(reference => ({
            referenceId: reference.referenceId,
            sourceNodeId: reference.sourceNodeId,
            sourceConnectionId: reference.sourceConnectionId,
            uploadIndex: reference.uploadIndex,
            connectionIndex: reference.connectionIndex
        })),
        executionContext: {
            targetNodeId: String(context.targetNodeId || ''),
            incomingNodeIds: [...new Set(references.map(reference => reference.sourceNodeId).filter(Boolean))],
            previousGenerationIds: [...new Set(references
                .map(reference => reference.generationHistory?.parentGenerationId)
                .filter(Boolean))]
        },
        explicitSpatialSignals: []
    };
}

export function createPlannerRequest(context, signals) {
    const references = Array.isArray(context?.references) ? context.references : [];
    return {
        schemaVersion: EDIT_PLAN_SCHEMA_VERSION,
        plannerPromptVersion: PLANNER_PROMPT_VERSION,
        originalPrompt: String(context?.originalPrompt || '').slice(0, 20000),
        promptWithReferenceTokens: String(context?.promptWithReferenceTokens || '').slice(0, 24000),
        references: references.map(reference => ({
            referenceId: reference.referenceId,
            capsuleLabel: reference.capsuleLabel,
            uploadIndex: reference.uploadIndex,
            connectionIndex: reference.connectionIndex,
            mentionSpans: reference.mentionSpans || []
        })),
        deterministicSignals: signals,
        filePaths: references.map(reference => reference.originalFilePath)
    };
}

function addError(errors, code, message, path = '') {
    errors.push({ code, ...(path ? { path } : {}), message });
}

function checkConfidence(value, errors, path) {
    if (value == null) return;
    if (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1) {
        addError(errors, 'INVALID_CONFIDENCE', '置信度必须在 0 到 1 之间', path);
    }
}

function stringSet(value) {
    return new Set((Array.isArray(value) ? value : []).map(entry => String(entry || '').trim()).filter(Boolean));
}

export function validateEditPlan(plan, context = {}) {
    const errors = [];
    const warnings = [];
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        addError(errors, 'INVALID_PLAN', 'Planner 必须返回 JSON 对象');
        return { valid: false, errors, warnings };
    }

    const referenceIds = new Set((context.references || []).map(reference => reference.referenceId));
    const checkReference = (value, path, allowNull = false) => {
        if (value == null && allowNull) return;
        if (typeof value !== 'string' || !referenceIds.has(value)) {
            addError(errors, 'UNKNOWN_REFERENCE', `引用不存在：${String(value)}`, path);
        }
    };

    if (String(plan.schemaVersion || '') !== EDIT_PLAN_SCHEMA_VERSION) {
        addError(errors, 'INVALID_SCHEMA_VERSION', `schemaVersion 必须是 ${EDIT_PLAN_SCHEMA_VERSION}`, 'schemaVersion');
    }
    if (typeof plan.task !== 'string' || !plan.task.trim()) addError(errors, 'MISSING_TASK', 'task 不能为空', 'task');
    checkReference(plan.targetReferenceId ?? null, 'targetReferenceId', true);
    if (plan.targetReferenceId == null && plan.task === 'multi_reference_edit') {
        warnings.push({ code: 'EDIT_WITHOUT_TARGET', message: '编辑任务没有指定目标参考图' });
    }

    if (!Array.isArray(plan.referenceContributions)) {
        addError(errors, 'MISSING_REFERENCE_CONTRIBUTIONS', 'referenceContributions 必须是数组', 'referenceContributions');
    }
    const contributions = Array.isArray(plan.referenceContributions) ? plan.referenceContributions : [];
    contributions.forEach((entry, index) => {
        checkReference(entry?.referenceId, `referenceContributions[${index}].referenceId`);
        checkConfidence(entry?.confidence, errors, `referenceContributions[${index}].confidence`);
    });

    if (!Array.isArray(plan.operations)) addError(errors, 'MISSING_OPERATIONS', 'operations 必须是数组', 'operations');
    const operations = Array.isArray(plan.operations) ? plan.operations : [];
    if (operations.length > 20) addError(errors, 'TOO_MANY_OPERATIONS', 'operations 不能超过 20 项', 'operations');
    operations.forEach((operation, index) => {
        const sourceIds = [
            ...(Array.isArray(operation?.sourceReferenceIds) ? operation.sourceReferenceIds : []),
            ...(operation?.sourceReferenceId ? [operation.sourceReferenceId] : [])
        ];
        sourceIds.forEach((id, sourceIndex) => checkReference(id, `operations[${index}].sourceReferenceIds[${sourceIndex}]`));
        if (!sourceIds.length && !operation?.allowNoSource) {
            addError(errors, 'MISSING_OPERATION_SOURCE', 'operation 必须有来源引用或明确允许无来源', `operations[${index}]`);
        }
        if (!String(operation?.type || '').trim()) {
            addError(errors, 'MISSING_OPERATION_TYPE', 'operation.type 不能为空', `operations[${index}].type`);
        }
        checkReference(operation?.targetReferenceId ?? plan.targetReferenceId ?? null, `operations[${index}].targetReferenceId`, true);
        if (!String(operation?.attribute || '').trim()) {
            addError(errors, 'MISSING_OPERATION_ATTRIBUTE', 'operation 必须说明要迁移或修改的属性', `operations[${index}]`);
        }
        if (!String(operation?.description || '').trim()) {
            addError(errors, 'MISSING_OPERATION_DESCRIPTION', 'operation.description 不能为空', `operations[${index}].description`);
        }
        const evidence = Array.isArray(operation?.evidence) ? operation.evidence : [];
        if (!evidence.length) {
            addError(errors, 'MISSING_OPERATION_EVIDENCE', 'operation 必须说明推断依据', `operations[${index}].evidence`);
        }
        const evidenceTypes = new Set([
            'explicit_user_text',
            'reference_text_context',
            'visual_inference',
            'generation_history',
            'connection_order_fallback'
        ]);
        evidence.forEach((entry, evidenceIndex) => {
            if (!evidenceTypes.has(entry?.type)) {
                addError(errors, 'INVALID_EVIDENCE_TYPE', `不支持的证据类型：${String(entry?.type)}`, `operations[${index}].evidence[${evidenceIndex}].type`);
            }
            if (entry?.referenceId != null) {
                checkReference(entry.referenceId, `operations[${index}].evidence[${evidenceIndex}].referenceId`);
            }
        });
        checkConfidence(operation?.confidence, errors, `operations[${index}].confidence`);
    });

    ['preserve', 'change', 'exclude', 'uncertainties'].forEach(key => {
        if (!Array.isArray(plan[key])) addError(errors, 'MISSING_PLAN_ARRAY', `${key} 必须是数组`, key);
    });
    const preserve = stringSet(plan.preserve);
    const change = stringSet(plan.change);
    for (const path of preserve) {
        if (change.has(path)) addError(errors, 'PRESERVE_CHANGE_CONFLICT', `同一属性不能同时保留和修改：${path}`);
    }
    checkConfidence(plan.overallConfidence, errors, 'overallConfidence');

    const serialized = JSON.stringify(plan);
    if (serialized.length > 80000) addError(errors, 'PLAN_TOO_LARGE', 'EditPlan 内容过长');

    return {
        valid: errors.length === 0,
        errors,
        warnings,
        ...(errors.length === 0 ? { normalizedPlan: JSON.parse(serialized) } : {})
    };
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function shortHash(value) {
    const text = JSON.stringify(stableValue(value));
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildPlannerCacheKey(context, provider = {}) {
    return `image-intent:${shortHash({
        prompt: context?.promptWithReferenceTokens || '',
        references: (context?.references || []).map(reference => ({
            referenceId: reference.referenceId,
            filePath: normalizePath(reference.originalFilePath),
            connectionIndex: reference.connectionIndex,
            mentionSpans: reference.mentionSpans
        })),
        provider: provider?.sourceProviderId || provider?.id || provider?.name || '',
        model: provider?.model || '',
        plannerPromptVersion: PLANNER_PROMPT_VERSION,
        editPlanSchemaVersion: EDIT_PLAN_SCHEMA_VERSION
    })}`;
}

function compactList(value) {
    return (Array.isArray(value) ? value : [value])
        .map(entry => String(entry || '').trim())
        .filter(Boolean);
}

function numberedLines(values, prefix = '- ') {
    return compactList(values).map(value => `${prefix}${value}`).join('\n');
}

function compactConstraint(value) {
    if (value == null) return '';
    if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
    if (Array.isArray(value)) return compactList(value).join('；');
    if (typeof value === 'object') {
        return Object.entries(value)
            .map(([key, entry]) => `${key}=${typeof entry === 'object' ? JSON.stringify(entry) : String(entry)}`)
            .join('；');
    }
    return '';
}

function referencePosition(context, referenceId) {
    const reference = (context?.references || []).find(entry => entry.referenceId === referenceId);
    if (!reference) return referenceId || '未指定参考图';
    return `第${reference.uploadIndex + 1}张参考图（${reference.capsuleLabel || reference.referenceId}）`;
}

export function compileImageProviderRequest({ editPlan, context, provider = {} } = {}) {
    const plan = editPlan || {};
    const target = plan.targetReferenceId
        ? referencePosition(context, plan.targetReferenceId)
        : null;
    const mappings = (context?.references || []).map(reference =>
        `- ${referencePosition(context, reference.referenceId)} = ${reference.referenceId}`
    );
    const contributions = (plan.referenceContributions || []).map(contribution => {
        const lines = [`- ${referencePosition(context, contribution.referenceId)}`];
        const useFor = compactList(contribution.useFor);
        const preserve = compactList(contribution.preserve);
        const ignoreFor = compactList(contribution.ignoreFor);
        if (useFor.length) lines.push(`  仅用于：${useFor.join('；')}`);
        if (preserve.length) lines.push(`  从该图保留：${preserve.join('；')}`);
        if (ignoreFor.length) lines.push(`  不得采用：${ignoreFor.join('；')}`);
        return lines.join('\n');
    });
    const operations = (plan.operations || []).map((operation, index) => {
        const sources = compactList(operation.sourceReferenceIds).map(id => referencePosition(context, id));
        const operationTarget = operation.targetReferenceId
            ? referencePosition(context, operation.targetReferenceId)
            : target;
        const measurement = compactConstraint(operation.measurement || operation.targetConstraint);
        return [
            `${index + 1}. ${String(operation.description || operation.attribute || operation.type || '').trim()}`,
            sources.length ? `   来源：${sources.join('、')}` : '',
            operationTarget ? `   应用到：${operationTarget}` : '',
            operation.attribute ? `   只处理属性：${operation.attribute}` : '',
            measurement ? `   可执行约束：${measurement}` : ''
        ].filter(Boolean).join('\n');
    });

    const sections = [
        '这是一次严格的多参考图生成/编辑任务。请按下面的结构化要求执行，不要自行交换参考图职责。',
        `【用户原始要求，最高优先级】\n${String(context?.promptWithReferenceTokens || context?.originalPrompt || '').trim()}`,
        `【参考图映射】\n${mappings.join('\n')}`,
        target
            ? `【目标画面】\n以${target}为唯一基础画面进行编辑。除“需要改变”的内容外，目标画面的场景、构图、主体身份和视觉语言都应保持。`
            : '【目标画面】\n创建一张新图，各参考图只按下述职责提供内容。',
        contributions.length ? `【每张参考图的职责】\n${contributions.join('\n')}` : '',
        operations.length ? `【必须执行的编辑操作，优先级高于一般风格匹配】\n${operations.join('\n')}` : '',
        compactList(plan.preserve).length ? `【必须保持不变】\n${numberedLines(plan.preserve)}` : '',
        compactList(plan.change).length ? `【必须明确改变】\n${numberedLines(plan.change)}` : '',
        compactList(plan.exclude).length ? `【禁止出现或禁止复制】\n${numberedLines(plan.exclude)}` : '',
        compactList(plan.uncertainties).length
            ? `【不确定项处理】\n${numberedLines(plan.uncertainties)}\n不确定时采用最小修改原则，不得扩大修改范围。`
            : '',
        '【输出要求】\n优先满足用户指定的关系、比例和属性迁移；只修改明确要求改变的内容。不要把提供局部属性的参考图复制成整体构图，也不要用风格相似代替明确的尺寸、比例或空间关系。'
    ].filter(Boolean);

    return {
        providerId: provider.sourceProviderId || provider.id || null,
        model: provider.model || null,
        compilerVersion: PROVIDER_COMPILER_VERSION,
        prompt: sections.join('\n\n'),
        images: (context?.references || []).map(reference => ({
            referenceId: reference.referenceId,
            filePath: reference.originalFilePath,
            uploadIndex: reference.uploadIndex,
            purposeSummary: compactList((plan.referenceContributions || [])
                .find(contribution => contribution.referenceId === reference.referenceId)?.useFor)
        })),
        degradations: []
    };
}

function createTraceId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createGenerationTrace({ context, signals, planner, validation, compiler, generation, fallback } = {}) {
    return {
        schema: 'flow-canvas.image-generation-trace.v1',
        traceId: createTraceId(),
        createdAt: new Date().toISOString(),
        originalPrompt: context?.originalPrompt || '',
        promptWithReferenceTokens: context?.promptWithReferenceTokens || '',
        referenceMapping: (context?.references || []).map(reference => ({ ...reference })),
        deterministicSignals: signals || null,
        planner: planner || { enabled: false, cacheHit: false },
        editPlan: validation?.normalizedPlan || null,
        validation: {
            valid: validation?.valid === true,
            errors: validation?.errors || [],
            warnings: validation?.warnings || []
        },
        compiler: compiler || null,
        fallback: fallback || { used: true, reason: 'PLANNER_NOT_RUN' },
        generation: generation || null
    };
}

export const IMAGE_INTENT_PIPELINE = Object.freeze({
    editPlanSchemaVersion: EDIT_PLAN_SCHEMA_VERSION,
    plannerPromptVersion: PLANNER_PROMPT_VERSION,
    providerCompilerVersion: PROVIDER_COMPILER_VERSION
});
