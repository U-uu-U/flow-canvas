import { reusablePromptConfig } from './reference-citations.js';

const IMAGE_PARAMETER_KEYS = Object.freeze([
    ['resolutionTier', '画质'],
    ['size', '尺寸'],
    ['ratio', '比例'],
    ['quality', '质量'],
    ['count', '数量']
]);

const VIDEO_PARAMETER_KEYS = Object.freeze([
    ['resolution', '分辨率'],
    ['ratio', '比例'],
    ['duration', '时长'],
    ['generateAudio', '音频'],
    ['watermark', '水印']
]);

function cloneObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return JSON.parse(JSON.stringify(value));
}

function hasGeneratorProduct(data = {}) {
    return [
        data.resultEntries,
        data.resultFilePaths,
        data.resultUrls
    ].some(value => Array.isArray(value) && value.length > 0);
}

export function getGenerationRecord(data = {}) {
    const stored = data.generation && typeof data.generation === 'object'
        ? data.generation
        : null;
    const generatedOperation = data.kind === 'op'
        && ['image', 'video'].includes(data.nodeType)
        && hasGeneratorProduct(data);
    if (!stored && !generatedOperation) return null;

    const config = cloneObject(stored?.config || data.config);
    const nodeType = ['image', 'video'].includes(stored?.nodeType)
        ? stored.nodeType
        : (['image', 'video'].includes(data.nodeType) ? data.nodeType : data.mediaType);
    if (!['image', 'video'].includes(nodeType)) return null;
    const prompt = String(
        stored?.prompt
        || stored?.requestPrompt
        || config.agentCompiledPrompt
        || config.prompt
        || ''
    ).trim();
    const model = String(stored?.model || data.model || config.model || '').trim();

    return {
        ...cloneObject(stored),
        nodeType,
        prompt,
        model,
        config
    };
}

export function getGenerationReuseConfig(data = {}, defaults = {}) {
    const record = getGenerationRecord(data);
    if (!record) return cloneObject(defaults);
    const config = {
        ...cloneObject(defaults),
        ...cloneObject(record.config),
        ...reusablePromptConfig(record)
    };
    if (record.model) config.model = record.model;
    if (record.providerId && !config.providerId) config.providerId = record.providerId;
    if (record.sourceProviderId && !config.sourceProviderId) {
        config.sourceProviderId = record.sourceProviderId;
    }
    if (record.nodeType === 'image' && config.size) {
        const match = String(config.size).match(/^(\d+)x(\d+)$/i);
        if (match) {
            config.width = Number(match[1]);
            config.height = Number(match[2]);
        }
    }
    delete config.agentCompiledPrompt;
    delete config.skipImageIntentPipeline;
    return config;
}

function displayParameterValue(key, value) {
    if (value === undefined || value === null || value === '') return '';
    if (key === 'duration') return `${Number(value) || value}秒`;
    if (key === 'count') return `${Math.max(1, Number(value) || 1)}张`;
    if (key === 'generateAudio' || key === 'watermark') return value === true ? '开' : '';
    if (key === 'ratio' && value === 'adaptive') return '自适应';
    return String(value);
}

export function getGenerationParameterEntries(data = {}, limit = 4) {
    const record = getGenerationRecord(data);
    if (!record) return [];
    const config = record.config || {};
    const entries = [];
    if (record.model) entries.push({ key: 'model', label: '模型', value: record.model });
    const keys = record.nodeType === 'video' ? VIDEO_PARAMETER_KEYS : IMAGE_PARAMETER_KEYS;
    keys.forEach(([key, label]) => {
        let value = displayParameterValue(key, config[key]);
        if (!value && key === 'size' && Number(config.width) > 0 && Number(config.height) > 0) {
            value = `${Number(config.width)}x${Number(config.height)}`;
        }
        if (value) entries.push({ key, label, value });
    });
    return entries.slice(0, Math.max(0, Number(limit) || 0));
}

export function hasGenerationRecord(data = {}) {
    return Boolean(getGenerationRecord(data));
}
