import awesomeGptImage2 from './prompt-packs/awesome-gpt-image-2.js';

const promptPacks = new Map();

function normalizeText(value) {
    return String(value || '').trim();
}

function validatePromptPack(pack) {
    if (!pack || typeof pack !== 'object') throw new TypeError('提示词包格式无效');
    if (!normalizeText(pack.id)) throw new TypeError('提示词包缺少 id');
    if (!normalizeText(pack.name)) throw new TypeError('提示词包缺少名称');
    if (!Array.isArray(pack.templates) || !pack.templates.length) {
        throw new TypeError('提示词包没有可用模板');
    }
    const ids = new Set();
    pack.templates.forEach(template => {
        if (!normalizeText(template?.id) || !normalizeText(template?.name)) {
            throw new TypeError(`提示词包 ${pack.id} 包含无效模板`);
        }
        if (ids.has(template.id)) throw new TypeError(`提示词模板 id 重复: ${template.id}`);
        ids.add(template.id);
    });
}

export function registerPromptPack(pack) {
    validatePromptPack(pack);
    promptPacks.set(pack.id, pack);
    return pack;
}

export function listPromptPacks() {
    return [...promptPacks.values()];
}

export function getPromptPack(packId) {
    return promptPacks.get(packId) || null;
}

export function findPromptTemplates(packId, { query = '', category = '' } = {}) {
    const pack = getPromptPack(packId);
    if (!pack) return [];
    const normalizedQuery = normalizeText(query).toLocaleLowerCase();
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
    return pack.templates.filter(template => {
        if (category && template.category !== category) return false;
        if (!tokens.length) return true;
        const haystack = [
            template.name,
            template.categoryName,
            template.summary,
            ...(template.styles || []),
            ...(template.scenes || []),
            ...(template.tags || []),
            ...(template.guidance || [])
        ].join(' ').toLocaleLowerCase();
        return tokens.every(token => haystack.includes(token));
    });
}

export function composePromptFromTemplate(template, currentPrompt = '', mode = 'enhance') {
    if (!template) throw new TypeError('请选择提示词模板');
    const prompt = normalizeText(currentPrompt);
    const guidance = (template.guidance || []).map(item => `- ${normalizeText(item)}`).filter(item => item !== '-');
    const pitfalls = (template.pitfalls || []).map(item => `- ${normalizeText(item)}`).filter(item => item !== '-');
    const tags = [...new Set([...(template.styles || []), ...(template.tags || [])])].filter(Boolean);
    const sections = [];

    if (mode === 'enhance' && prompt) sections.push(prompt);
    else {
        sections.push('创作任务：\n[描述主体、内容、用途和必须保留的细节]');
    }

    sections.push([
        `创作方向：${template.name}`,
        normalizeText(template.summary),
        tags.length ? `视觉标签：${tags.join('、')}` : ''
    ].filter(Boolean).join('\n'));

    if (guidance.length) sections.push(`执行要求：\n${guidance.join('\n')}`);
    if (pitfalls.length) sections.push(`约束：\n${pitfalls.join('\n')}`);
    return sections.filter(Boolean).join('\n\n');
}

registerPromptPack(awesomeGptImage2);

export const DEFAULT_IMAGE_PROMPT_PACK_ID = awesomeGptImage2.id;
