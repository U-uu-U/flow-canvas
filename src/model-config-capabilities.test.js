import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL_CONFIG } from './model-config-default.js';
import {
    MODEL_CONFIG_ISSUE_CODES,
    describeModelCapabilities,
    entryAcceptsField,
    fieldForParam,
    matchModelConfigEntries,
    mergeImageProfile,
    mergeVideoProfile,
    resolveModelConfigEntry,
    toImageProfileOverrides,
    toVideoProfileOverrides,
    validateModelRequest
} from './model-config-capabilities.js';

const config = DEFAULT_MODEL_CONFIG;
const image = model => ({ model, kind: 'image' });
const video = model => ({ model, kind: 'video' });

const findEntry = id => config.models.find(entry => entry.id === id);

test('按模型名匹配条目，并区分同名不同线路', () => {
    assert.equal(resolveModelConfigEntry(config, image('gpt-image-2')).entry.id, 'ravenhash-image.gpt-image-2');
    assert.equal(resolveModelConfigEntry(config, image('gpt-image-2.5-sunburst')).entry.id, 'ravenhash-image.gpt-image-2.5-sunburst');
    // sd2.5 与 sd2.5-route1 必须分开，否则会把「固定 30 秒」的约束漏掉
    assert.equal(resolveModelConfigEntry(config, video('sd2.5-route1')).entry.id, 'ravenhash-video.sd2.5-route1');
    assert.equal(resolveModelConfigEntry(config, video('sd2.5')).entry.id, 'ravenhash-video.sd2.5');
    assert.equal(resolveModelConfigEntry(config, video('seedance_v2.5')).entry.id, 'ravenhash-video.seedance-v2.5');
    // MiniMax-H3-c1 是按 endpoint（原生任务中心）区分的条目：没有 endpoint 时不生效，
    // 以免把它「固定 720p、不支持参考视频」的限制错加到兼容线路上。
    const nativeEndpoint = 'https://api.example.com/kyyReactApiServer/v2/model-center/tasks';
    assert.equal(resolveModelConfigEntry(config, { model: 'MiniMax-H3-c1', kind: 'video', endpoint: nativeEndpoint }).entry.id,
        'minimax-video.minimax-h3-c1');
    assert.equal(resolveModelConfigEntry(config, video('MiniMax-H3-c1')).matched, false);
    // 未收录模型：不匹配、不限制
    const unmatched = resolveModelConfigEntry(config, video('my-private-model'));
    assert.equal(unmatched.matched, false);
    assert.equal(unmatched.entry, null);
    // 无 model 时不匹配
    assert.equal(resolveModelConfigEntry(config, video('')).matched, false);
});

test('minimax-h3 同时命中两条线路时标记为 ambiguous 并保留全部候选', () => {
    const resolution = resolveModelConfigEntry(config, video('minimax-h3'));
    assert.equal(resolution.matched, true);
    assert.equal(resolution.ambiguous, true);
    assert.deepEqual(resolution.candidates.map(entry => entry.id).sort(), [
        'minimax-video.minimax-h3-seconds',
        'ravenhash-video.minimax-h3'
    ]);
});

test('endpoint 命中可给同名线路消歧', () => {
    const resolution = resolveModelConfigEntry(config, {
        model: 'minimax-h3',
        kind: 'video',
        endpoint: 'https://api.example.com/kyyReactApiServer/v2/model-center/tasks'
    });
    assert.equal(resolution.entry.id, 'minimax-video.minimax-h3-c1');
});

test('字段别名双向可查，accepts 判定兼容别名', () => {
    assert.equal(fieldForParam(config, 'aspect_ratio'), 'ratio');
    assert.equal(fieldForParam(config, 'seconds'), 'duration');
    assert.equal(fieldForParam(config, 'reference_images'), 'referenceImages');
    assert.equal(fieldForParam(config, '不存在的入参'), '');

    const route1 = findEntry('ravenhash-video.sd2.5-route1');
    assert.equal(entryAcceptsField(config, route1, 'duration'), true);
    assert.equal(entryAcceptsField(config, route1, 'ratio'), true);
    assert.equal(entryAcceptsField(config, route1, 'referenceImages'), true);
    assert.equal(entryAcceptsField(config, route1, 'referenceVideos'), false);

    const kling = findEntry('video-template.kling');
    // Kling 的 CSV 入参里没有 resolution，UI 必须隐藏分辨率控件
    assert.equal(entryAcceptsField(config, kling, 'resolutionTier'), false);
});

test('能力描述把「能做/不能做/限制」拆开', () => {
    const described = describeModelCapabilities(config, findEntry('ravenhash-video.sd2.5-route1'));
    const canKeys = described.can.map(item => item.key);
    const cannotKeys = described.cannot.map(item => item.key);
    assert.ok(canKeys.includes('referenceImages'));
    assert.ok(canKeys.includes('face'));
    assert.ok(cannotKeys.includes('firstFrame'));
    assert.match(described.limits.join(' '), /固定 30 秒/);
    assert.match(described.limits.join(' '), /画面比例/);
    assert.equal(described.kindLabel, '视频');
    assert.match(described.notesText, /通过率约90%/);

    const c1 = describeModelCapabilities(config, findEntry('minimax-video.minimax-h3-c1'));
    const c1Cannot = c1.cannot.find(item => item.key === 'referenceVideos');
    assert.equal(c1Cannot.reason, '该线路不支持参考视频');

    const text = describeModelCapabilities(config, findEntry('text.openai.gpt-5.6-terra'));
    assert.ok(text.can.some(item => item.key === 'tools'));
    assert.ok(text.notes.some(note => /上下文窗口/.test(note)));
});

test('提交校验：枚举、固定值、范围、数量、提示词', () => {
    // 图片档位：'8K' 非法；'3840x2160' 折算为 4K 合法
    const badTier = validateModelRequest({
        config, provider: image('gpt-image-2'), prompt: 'a cat', fields: { resolutionTier: '8K' }
    });
    assert.equal(badTier.ok, false);
    assert.equal(badTier.errors[0].code, MODEL_CONFIG_ISSUE_CODES.VALUE_NOT_ALLOWED);

    const pixelTier = validateModelRequest({
        config, provider: image('gpt-image-2'), prompt: 'a cat', fields: { resolutionTier: '3840x2160' }
    });
    assert.equal(pixelTier.ok, true, JSON.stringify(pixelTier.errors));

    // 固定时长线路
    const wrongDuration = validateModelRequest({
        config, provider: video('sd2.5-route1'), prompt: 'a cat', fields: { duration: 20 }
    });
    assert.equal(wrongDuration.ok, false);
    assert.equal(wrongDuration.errors[0].code, MODEL_CONFIG_ISSUE_CODES.VALUE_MUST_BE);
    assert.equal(wrongDuration.errors[0].suggestion, 30);

    // 范围 + 整数
    const outOfRange = validateModelRequest({
        config, provider: video('seedance_v2.5'), prompt: 'a cat', fields: { duration: 45 }
    });
    assert.equal(outOfRange.ok, false);
    assert.equal(outOfRange.errors[0].code, MODEL_CONFIG_ISSUE_CODES.VALUE_OUT_OF_RANGE);

    const notInteger = validateModelRequest({
        config, provider: video('seedance_v2.5'), prompt: 'a cat', fields: { duration: 12.5 }
    });
    assert.equal(notInteger.ok, false);

    // 参考图数量
    const tooManyReferences = validateModelRequest({
        config, provider: video('sd2.5-route1'), prompt: 'a cat', references: { image: { count: 12 } }
    });
    assert.equal(tooManyReferences.ok, false);
    assert.equal(tooManyReferences.errors[0].code, MODEL_CONFIG_ISSUE_CODES.REFERENCE_LIMIT);

    // 提示词
    const noPrompt = validateModelRequest({ config, provider: video('sd2.5-route1'), prompt: '   ' });
    assert.equal(noPrompt.ok, false);
    assert.equal(noPrompt.errors[0].code, MODEL_CONFIG_ISSUE_CODES.PROMPT_REQUIRED);

    const longPrompt = validateModelRequest({
        config, provider: video('minimax-h3'), prompt: 'x'.repeat(5001)
    });
    assert.equal(longPrompt.ok, false);
    assert.equal(longPrompt.warnings.some(item => item.code === MODEL_CONFIG_ISSUE_CODES.PROMPT_TOO_LONG), false);
    assert.ok(longPrompt.errors.some(item => item.code === MODEL_CONFIG_ISSUE_CODES.PROMPT_TOO_LONG));
});

test('提交校验：不支持的能力开关、不支持的入参、未知边界降级为警告', () => {
    const klingResolution = validateModelRequest({
        config, provider: video('kling-v2'), prompt: 'a cat', fields: { resolutionTier: '1080p' }
    });
    assert.equal(klingResolution.ok, false);
    assert.equal(klingResolution.errors[0].code, MODEL_CONFIG_ISSUE_CODES.PARAM_UNSUPPORTED);

    const unsupportedFeature = validateModelRequest({
        config, provider: video('sd2.5-route1'), prompt: 'a cat', features: { webSearch: true }
    });
    assert.equal(unsupportedFeature.ok, false);
    assert.equal(unsupportedFeature.errors[0].code, MODEL_CONFIG_ISSUE_CODES.FEATURE_UNSUPPORTED);

    // 「以上游为准」的字段只提示不拦截
    const unknownLimit = validateModelRequest({
        config, provider: image('gpt-image-2.5-sunburst'), prompt: 'a cat', fields: { n: 4 }
    });
    assert.equal(unknownLimit.ok, true);
    assert.ok(unknownLimit.warnings.some(item => item.code === MODEL_CONFIG_ISSUE_CODES.PARAM_UNVERIFIED));

    // 未收录模型：放行 + 提示
    const unmatched = validateModelRequest({
        config, provider: video('my-private-model'), prompt: 'a cat', fields: { duration: 999 }
    });
    assert.equal(unmatched.ok, true);
    assert.equal(unmatched.matched, false);
    assert.match(unmatched.warnings[0].message, /未收录/);
});

test('同名多线路：只有全部候选都禁止的才算错误', () => {
    // workflow_id 只有「按秒线路」接受，兼容线路不接受 → 警告而非拦截
    const partial = validateModelRequest({
        config, provider: video('minimax-h3'), prompt: 'a cat', fields: { workflowId: 'fl2v' }
    });
    assert.equal(partial.ok, true, JSON.stringify(partial.errors));
    assert.ok(partial.warnings.some(item => item.field === 'workflowId'));

    // 时长两条线路都限制 4-15 → 错误
    const shared = validateModelRequest({
        config, provider: video('minimax-h3'), prompt: 'a cat', fields: { duration: 30 }
    });
    assert.equal(shared.ok, false);
    assert.equal(shared.errors[0].code, MODEL_CONFIG_ISSUE_CODES.VALUE_OUT_OF_RANGE);
});

test('CONFIG 翻译成视频 profile：时长控件形态与既有实现一致', () => {
    const route1 = toVideoProfileOverrides(config, findEntry('ravenhash-video.sd2.5-route1'));
    assert.deepEqual(route1.durations, [30]);
    assert.equal(route1.durationControl, 'fixed');
    assert.deepEqual(route1.resolutions, ['720p']);
    assert.equal(route1.referenceLimits.image, 9);
    assert.equal(route1.supportsWebSearch, false);
    assert.equal(route1.defaultDuration, 30);

    const hm = toVideoProfileOverrides(config, findEntry('ravenhash-video.seedance-v2.5'));
    assert.equal(hm.durationControl, 'slider');
    assert.equal(hm.durations[0], 4);
    assert.equal(hm.durations.at(-1), 30);
    assert.deepEqual(hm.resolutions, ['720p']);

    // seedance-1.5 的「自动」用 -1 表示，与既有 profile 的 select 形态一致
    const seedance15 = toVideoProfileOverrides(config, findEntry('video-template.seedance-1.5'));
    assert.deepEqual(seedance15.durations, [-1, 5, 10, 12]);
    assert.equal(seedance15.durationControl, 'select');
    assert.equal(seedance15.defaultResolution, '720p');

    const h3 = toVideoProfileOverrides(config, findEntry('ravenhash-video.minimax-h3'));
    assert.deepEqual(h3.durations[0], 4);
    assert.deepEqual(h3.durations.at(-1), 15);
    assert.deepEqual(h3.resolutions, ['480p', '768p', '1080p', '2k', '4k']);
    assert.equal(h3.referenceLimits.audio, 3);

    const kling = toVideoProfileOverrides(config, findEntry('video-template.kling'));
    assert.deepEqual(kling.resolutions, []);
    assert.deepEqual(kling.durations, [3, 5, 10, 15]);

    assert.equal(toVideoProfileOverrides(config, findEntry('ravenhash-image.gpt-image-2')), null);
});

test('CONFIG 覆盖 profile 能力但保留线路元数据', () => {
    const base = {
        label: 'Seedance 2.5',
        routeLabel: '线路一（推荐）',
        routeGroup: 'seedance25-fixed',
        routeModelLabel: 'sd2.5',
        price: { amount: 6, currency: 'CNY' },
        supportsWebSearch: true,
        referenceLimits: { image: 99, video: 9, audio: 9 }
    };
    const merged = mergeVideoProfile(base, toVideoProfileOverrides(config, findEntry('ravenhash-video.sd2.5-route1')));
    assert.equal(merged.routeLabel, '线路一（推荐）');
    assert.equal(merged.routeGroup, 'seedance25-fixed');
    assert.deepEqual(merged.price, { amount: 6, currency: 'CNY' });
    assert.equal(merged.referenceLimits.image, 9);
    assert.equal(merged.supportsWebSearch, false);
    assert.equal(merged.capabilitySource, 'config');
});

test('CONFIG 翻译成图片 profile：档位来自 CONFIG，未收录返回 null', () => {
    const gpt = toImageProfileOverrides(config, findEntry('ravenhash-image.gpt-image-2'));
    assert.deepEqual(gpt.resolutionTiers, ['1K', '2K', '4K']);
    assert.equal(gpt.defaultResolutionTier, '1K');

    const mj = toImageProfileOverrides(config, findEntry('midjourney.mj-imagine'));
    assert.deepEqual(mj.resolutionTiers, ['1K', '2K']);
    assert.equal(mj.defaultResolutionTier, '1K');

    assert.equal(toImageProfileOverrides(config, findEntry('ravenhash-video.sd2.5')), null);
    // 未声明档位的图片条目不应覆盖既有尺寸清单
    const mergedImage = mergeImageProfile({ sizes: [{ value: '1024x1024' }], resolutionTiers: ['1K', '2K', '4K'] }, null);
    assert.deepEqual(mergedImage.resolutionTiers, ['1K', '2K', '4K']);
});

test('每条 CONFIG 条目都有可编译的正则与唯一 id', () => {
    const ids = new Set();
    for (const entry of config.models) {
        assert.ok(entry.id && !ids.has(entry.id), `id 重复或缺失: ${entry.id}`);
        ids.add(entry.id);
        for (const source of entry.match.model) {
            assert.doesNotThrow(() => new RegExp(source), `${entry.id} 的正则非法: ${source}`);
        }
        if (entry.match.endpoint) {
            assert.doesNotThrow(() => new RegExp(entry.match.endpoint), `${entry.id} 的 endpoint 正则非法`);
        }
        // 条目必须能被自己的正则命中：把「锚点 + 转义」还原成朴素的模型名做探针。
        // 含真实正则元字符（字符类/分组/或）的别名跳过——它们由 CSV 逐行覆盖测试保证可达。
        for (const source of entry.match.model) {
            if (/[[\](){}|+*?]/.test(source)) continue;
            const probe = source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\(.)/g, '$1');
            const matched = matchModelConfigEntries(config, { model: probe, kind: entry.kind });
            assert.ok(matched.some(item => item.entry.id === entry.id), `${entry.id} 无法被探针 ${probe} 命中`);
        }
    }
    assert.equal(config.models.length, 16);
});
