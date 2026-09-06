export const AGENT_CONVERSATION_LIMIT = 40;
export const AGENT_CONVERSATION_FILE_LIMIT = 64;

function cleanText(value, maxLength = 120) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function defaultConversationId() {
    return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function deriveAgentConversationTitle(messages = [], fallback = '新任务') {
    const firstUserMessage = (Array.isArray(messages) ? messages : [])
        .find(message => message?.role === 'user' && cleanText(message.content, 200));
    const content = cleanText(firstUserMessage?.content, 200)
        .replace(/^#+\s*/, '')
        .replace(/^[`*_>\-\s]+|[`*_\s]+$/g, '');
    if (!content) return cleanText(fallback, 40) || '新任务';
    return content.length > 24 ? `${content.slice(0, 24)}...` : content;
}

export function normalizeAgentConversationFiles(value = []) {
    const seen = new Set();
    return (Array.isArray(value) ? value : []).map(entry => {
        const kind = ['image', 'video', 'audio'].includes(entry?.kind)
            ? entry.kind
            : null;
        const id = cleanText(entry?.id, 600);
        if (!kind || !id || seen.has(id)) return null;
        seen.add(id);
        return {
            id,
            kind,
            direction: entry?.direction === 'output' ? 'output' : 'input',
            name: cleanText(entry?.name, 120) || '素材',
            detail: cleanText(entry?.detail, 200),
            nodeId: cleanText(entry?.nodeId, 160) || null,
            filePath: cleanText(entry?.filePath, 1000) || null,
            url: cleanText(entry?.url, 2000) || null
        };
    }).filter(Boolean).slice(-AGENT_CONVERSATION_FILE_LIMIT);
}

export function mergeAgentConversationFiles(existing = [], files = [], direction = 'input') {
    const incoming = [];
    (Array.isArray(files) ? files : []).forEach(file => {
        const kind = ['image', 'video', 'audio'].includes(file?.mediaType)
            ? file.mediaType
            : null;
        const location = cleanText(file?.filePath || file?.url, 2000);
        if (!kind || !location) return;
        const normalizedDirection = direction === 'output' ? 'output' : 'input';
        incoming.push({
            id: `${normalizedDirection}:${kind}:${location.replace(/\\/g, '/').toLowerCase()}`,
            kind,
            direction: normalizedDirection,
            name: cleanText(file?.name, 120) || location.replace(/\\/g, '/').split('/').pop(),
            detail: `${normalizedDirection === 'output' ? '产出' : '输入'} · ${{ image: '图片', video: '视频', audio: '音频' }[kind]}`,
            nodeId: cleanText(file?.sourceNodeId, 160) || null,
            filePath: cleanText(file?.filePath, 1000) || null,
            url: cleanText(file?.url, 2000) || null
        });
    });
    const merged = new Map();
    [...normalizeAgentConversationFiles(existing), ...normalizeAgentConversationFiles(incoming)]
        .forEach(entry => merged.set(entry.id, entry));
    return [...merged.values()].slice(-AGENT_CONVERSATION_FILE_LIMIT);
}

export function createAgentConversation({
    id,
    title = '新任务',
    messages = [],
    files = [],
    customTitle = false,
    now = Date.now(),
    createId = defaultConversationId,
    normalizeMessages = value => Array.isArray(value) ? value : []
} = {}) {
    const timestamp = Math.max(0, Number(now) || Date.now());
    const normalizedMessages = normalizeMessages(messages);
    return {
        id: cleanText(id, 160) || createId(),
        title: cleanText(title, 40) || deriveAgentConversationTitle(normalizedMessages),
        customTitle: customTitle === true,
        messages: normalizedMessages,
        files: normalizeAgentConversationFiles(files),
        createdAt: timestamp,
        updatedAt: timestamp
    };
}

export function normalizeAgentConversationProject(state, options = {}) {
    const normalizeMessages = options.normalizeMessages || (value => Array.isArray(value) ? value : []);
    const createId = options.createId || defaultConversationId;
    const now = Math.max(0, Number(options.now) || Date.now());
    const legacyMessages = normalizeMessages(state?.messages);
    let conversations = (Array.isArray(state?.conversations) ? state.conversations : [])
        .map((conversation, index) => {
            const messages = normalizeMessages(conversation?.messages);
            const createdAt = Math.max(0, Number(conversation?.createdAt) || now - index);
            return {
                id: cleanText(conversation?.id, 160) || createId(),
                title: cleanText(conversation?.title, 40) || deriveAgentConversationTitle(messages),
                customTitle: conversation?.customTitle === true,
                messages,
                files: normalizeAgentConversationFiles(conversation?.files || conversation?.sources),
                createdAt,
                updatedAt: Math.max(createdAt, Number(conversation?.updatedAt) || createdAt)
            };
        })
        .slice(0, AGENT_CONVERSATION_LIMIT);
    if (conversations.length === 0) {
        conversations = [createAgentConversation({
            title: deriveAgentConversationTitle(legacyMessages),
            messages: legacyMessages,
            now: Number(state?.updatedAt && Date.parse(state.updatedAt)) || now,
            createId,
            normalizeMessages
        })];
    }
    const requestedActiveId = cleanText(state?.activeConversationId, 160);
    const activeConversationId = conversations.some(conversation => conversation.id === requestedActiveId)
        ? requestedActiveId
        : conversations[0].id;
    return { activeConversationId, conversations };
}
