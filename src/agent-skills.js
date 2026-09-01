export const AGENT_SKILL_CATEGORY_IDS = Object.freeze(['planning', 'creative', 'review']);
export const CUSTOM_AGENT_SKILL_LIMIT = 50;

function cleanText(value, maxLength) {
    return String(value || '').trim().slice(0, maxLength);
}

function normalizeCategory(value) {
    return AGENT_SKILL_CATEGORY_IDS.includes(value) ? value : 'creative';
}

export function normalizeCustomAgentSkills(value, { reservedIds = [] } = {}) {
    if (!Array.isArray(value)) return [];
    const reservedIdList = reservedIds && typeof reservedIds[Symbol.iterator] === 'function'
        ? [...reservedIds]
        : [];
    const seen = new Set(reservedIdList.map(String));
    const normalized = [];
    value.forEach(skill => {
        const id = cleanText(skill?.id, 120);
        const name = cleanText(skill?.name, 40);
        const instruction = cleanText(skill?.instruction, 2000);
        if (!id.startsWith('custom-') || !name || !instruction || seen.has(id)) return;
        seen.add(id);
        normalized.push({
            id,
            name,
            category: normalizeCategory(skill?.category),
            description: cleanText(skill?.description, 100) || '自定义 Skill',
            instruction,
            custom: true,
            createdAt: Math.max(0, Number(skill?.createdAt) || 0)
        });
    });
    return normalized.slice(0, CUSTOM_AGENT_SKILL_LIMIT);
}

export function createCustomAgentSkill(input = {}, { existingSkills = [], now = Date.now(), random = Math.random() } = {}) {
    const name = cleanText(input.name, 40);
    const instruction = cleanText(input.instruction, 2000);
    if (!name) throw new Error('请输入 Skill 名称');
    if (!instruction) throw new Error('请输入完整的 Skill 指令');
    if ((existingSkills || []).some(skill => String(skill?.name || '').trim().toLowerCase() === name.toLowerCase())) {
        throw new Error('已存在同名 Skill');
    }
    const timestamp = Math.max(0, Number(now) || Date.now());
    const suffix = Math.floor(Math.max(0, Math.min(0.999999, Number(random) || 0)) * 0xFFFFFF)
        .toString(36)
        .padStart(4, '0');
    return {
        id: `custom-${timestamp.toString(36)}-${suffix}`,
        name,
        category: normalizeCategory(input.category),
        description: cleanText(input.description, 100) || '自定义 Skill',
        instruction,
        custom: true,
        createdAt: timestamp
    };
}

export function removeCustomAgentSkill(skills, skillId) {
    const targetId = String(skillId || '');
    return (Array.isArray(skills) ? skills : []).filter(skill => skill?.id !== targetId);
}
