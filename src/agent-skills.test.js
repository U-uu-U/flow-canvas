import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createCustomAgentSkill,
    normalizeCustomAgentSkills,
    removeCustomAgentSkill
} from './agent-skills.js';

test('custom Agent Skills are normalized and reserved ids are rejected', () => {
    const skills = normalizeCustomAgentSkills([
        { id: 'built-in', name: '覆盖内置', instruction: '不要保留' },
        { id: 'custom-a', name: '  分镜检查  ', category: 'review', description: '', instruction: '  检查节奏  ' },
        { id: 'custom-a', name: '重复', instruction: '不要保留' }
    ], { reservedIds: ['built-in'] });
    assert.deepEqual(skills, [{
        id: 'custom-a',
        name: '分镜检查',
        category: 'review',
        description: '自定义 Skill',
        instruction: '检查节奏',
        custom: true,
        createdAt: 0
    }]);
});

test('custom Agent Skill creation validates duplicates and produces stable fields', () => {
    const skill = createCustomAgentSkill({
        name: '编剧',
        category: 'planning',
        description: '整理剧情结构',
        instruction: '按三幕结构检查故事。'
    }, { existingSkills: [], now: 1234, random: () => 0.5 });
    assert.match(skill.id, /^custom-/);
    assert.equal(skill.category, 'planning');
    assert.equal(skill.custom, true);
    assert.throws(() => createCustomAgentSkill({
        name: '编剧',
        instruction: '重复'
    }, { existingSkills: [skill] }), /同名/);
});

test('custom Agent Skill deletion does not mutate the source list', () => {
    const source = [{ id: 'custom-a' }, { id: 'custom-b' }];
    const result = removeCustomAgentSkill(source, 'custom-a');
    assert.deepEqual(result, [{ id: 'custom-b' }]);
    assert.equal(source.length, 2);
});
