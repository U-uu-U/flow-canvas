const SECRET_KEY_PATTERN = /(api.?key|authorization|bearer|password|secret|token)/i;
const MAX_CONTEXT_STRING_LENGTH = 12000;
const MAX_PARAMETER_KEYS = 120;

function compactString(value, limit = MAX_CONTEXT_STRING_LENGTH) {
    return String(value || '').trim().slice(0, limit);
}

function sanitizeValue(value, depth = 0) {
    if (depth > 4 || value == null) return value == null ? null : undefined;
    if (typeof value === 'string') return value.slice(0, MAX_CONTEXT_STRING_LENGTH);
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
        return value.slice(0, 40)
            .map(entry => sanitizeValue(entry, depth + 1))
            .filter(entry => entry !== undefined);
    }
    if (typeof value !== 'object') return undefined;

    const result = {};
    Object.entries(value).slice(0, MAX_PARAMETER_KEYS).forEach(([key, entry]) => {
        if (SECRET_KEY_PATTERN.test(key)) return;
        const sanitized = sanitizeValue(entry, depth + 1);
        if (sanitized !== undefined) result[key] = sanitized;
    });
    return result;
}

export function sanitizeAgentGenerationParameters(parameters = {}) {
    const sanitized = sanitizeValue(parameters);
    return sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : {};
}

export function normalizeAgentGenerationSource(source = null) {
    if (!source?.nodeId) return null;
    const originalPrompt = compactString(source.originalPrompt ?? source.prompt);
    const upstreamPrompts = (Array.isArray(source.upstreamPrompts) ? source.upstreamPrompts : [])
        .map(prompt => compactString(prompt, 6000))
        .filter(Boolean)
        .slice(0, 20);
    const effectivePrompt = compactString(source.effectivePrompt)
        || originalPrompt
        || upstreamPrompts.join('\n\n').slice(0, MAX_CONTEXT_STRING_LENGTH);
    return {
        nodeId: String(source.nodeId),
        nodeType: ['image', 'video'].includes(source.nodeType) ? source.nodeType : null,
        title: compactString(source.title, 120),
        prompt: effectivePrompt,
        originalPrompt,
        effectivePrompt,
        upstreamPrompts,
        promptMergeMode: ['append', 'prepend', 'replace'].includes(source.promptMergeMode)
            ? source.promptMergeMode
            : 'append',
        parameters: sanitizeAgentGenerationParameters(source.parameters),
        model: compactString(source.model || source.parameters?.model, 240)
    };
}

export function buildAgentImageCompilationMessages({ source, instruction = '', skillInstructions = [] } = {}) {
    const normalized = normalizeAgentGenerationSource(source);
    if (!normalized || normalized.nodeType !== 'image') return [];
    const userInstruction = compactString(instruction);
    const upstream = normalized.upstreamPrompts.length
        ? normalized.upstreamPrompts.map((prompt, index) => `${index + 1}. ${prompt}`).join('\n')
        : '无';
    const parameters = JSON.stringify(normalized.parameters, null, 2);
    const skills = (Array.isArray(skillInstructions) ? skillInstructions : [])
        .map(value => compactString(value, 2000))
        .filter(Boolean)
        .slice(0, 8);
    const system = [
        '你是 Flow Canvas 的图片生成执行 Agent。你的任务是把节点上下文编译成一条可以直接提交给图片模型的最终提示词。',
        '必须保留用户的明确要求、数量关系、主体身份、构图、文字内容和参考图职责，不得用泛化描述替换具体约束。',
        '参考素材按收到的顺序编号。需要引用素材时使用“第1张参考图”“第2张参考图”等明确称呼。',
        '生成参数是固定执行参数，只用于理解目标能力；不要擅自修改，也不要把 API、模型或内部字段写进画面描述。',
        '只返回一个 JSON 对象，不要 Markdown 或解释。格式：{"prompt":"最终生图提示词","summary":"一句话说明整理重点"}。',
        ...skills
    ].join('\n');
    const user = [
        `目标节点：${normalized.title || '图片生成'}（${normalized.nodeId}）`,
        normalized.model ? `图片模型：${normalized.model}` : '',
        `节点原始提示词：\n${normalized.originalPrompt || '无'}`,
        `上游提示词：\n${upstream}`,
        `当前合并提示词：\n${normalized.effectivePrompt || '无'}`,
        `固定生成参数：\n${parameters || '{}'}`,
        userInstruction ? `用户本次补充要求（最高优先级）：\n${userInstruction}` : '',
        '请结合随请求提供的参考素材，输出最终生图提示词。'
    ].filter(Boolean).join('\n\n');
    return [
        { role: 'system', content: system },
        { role: 'user', content: user }
    ];
}

function responseCandidates(value) {
    const text = compactString(value, 40000);
    const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(match => match[1].trim());
    return [...fenced, text].filter(Boolean);
}

export function parseAgentImageCompilationResponse(value, fallbackPrompt = '') {
    const candidates = responseCandidates(value);
    for (const candidate of candidates) {
        try {
            const payload = JSON.parse(candidate);
            const prompt = compactString(payload?.prompt || payload?.finalPrompt || payload?.imagePrompt, 30000);
            if (prompt) {
                return {
                    prompt,
                    summary: compactString(payload?.summary, 1000),
                    rawText: compactString(value, 40000),
                    structured: true
                };
            }
        } catch (_) { }
    }

    const plainText = compactString(candidates[0], 30000);
    const prompt = plainText && !plainText.startsWith('{') ? plainText : compactString(fallbackPrompt, 30000);
    return {
        prompt,
        summary: '',
        rawText: compactString(value, 40000),
        structured: false
    };
}
