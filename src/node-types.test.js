import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL_CONFIG } from './model-config-default.js';
import { validateModelRequest } from './model-config-capabilities.js';

let helpers;
test.before(async () => {
    helpers = await import('./node-types.js');
});

function trackedNodeContext(t, kind, model, generate) {
    const previousWindow = global.window;
    const calls = [], tasks = [], updates = [], failures = [];
    global.window = { flowCanvas: { mcp: {
        [kind === 'image' ? 'generateImage' : 'generateVideo']: async request => {
            calls.push(structuredClone(request));
            return generate(request, calls.length - 1);
        }
    } } };
    t.after(() => { global.window = previousWindow; });
    const provider = { id: `${kind}-provider`, apiKey: 'test-key', endpoint: 'https://example.test/v1', model };
    const ctx = {
        item: { id: `${kind}-node` },
        getImageProvider: () => provider, getVideoProvider: () => provider,
        createGenerationTask(details) {
            const task = { id: `task-${tasks.length}`, ...structuredClone(details) };
            tasks.push(task);
            return task;
        },
        updateGenerationTask: (id, patch) => updates.push({ id, patch: structuredClone(patch) }),
        recordGenerationError: (id, error) => failures.push({ id, error })
    };
    return { calls, tasks, updates, failures, ctx };
}

test('image execute: a failed batch retains all late successful images in partialOutput', async t => {
    const failure = Object.assign(new Error('Image request failed'), { code: 'UPSTREAM_TASK_FAILED' });
    const filePaths = ['C:/output/late-a.png', 'C:/output/late-b.png'];
    const h = trackedNodeContext(t, 'image', 'gpt-image-2', async (_, index) => {
        if (index === 0) throw failure;
        await new Promise(resolve => setImmediate(resolve));
        return { filePaths, taskId: 'remote-success', mediaType: 'image' };
    });
    await assert.rejects(helpers.NODE_TYPES.image.execute({}, {
        prompt: 'batch', width: 1024, height: 1024, count: 4, concurrency: 2
    }, h.ctx), actual => actual === failure);

    assert.equal(h.calls.length, 2, 'unstarted batch items must not be submitted');
    assert.equal(h.tasks.length, 2);
    assert.deepEqual(h.failures, [{ id: 'task-0', error: failure }]);
    assert.equal(failure.code, 'UPSTREAM_TASK_FAILED');
    assert.deepEqual(failure.unstartedIndices, [2, 3]);
    assert.deepEqual(failure.partialOutput.image, filePaths.map(file => `local-res://${encodeURIComponent(file)}`));
    assert.deepEqual(failure.partialOutput._batchResults.map(result => result._resultFilePath), filePaths);
    assert.ok(failure.partialOutput._batchResults.every(result => result._generation.taskId === 'remote-success'));
    assert.deepEqual(h.updates.map(update => [update.id, update.patch.status]), [['task-1', 'success']]);
    assert.deepEqual(h.updates[0].patch.params.filePaths, filePaths);
});

test('video execute: partialOutput keeps late results while unstarted tasks become canceled/not_submitted', async t => {
    const failure = Object.assign(new Error('Video request failed'), { code: 'UPSTREAM_TASK_FAILED' });
    const h = trackedNodeContext(t, 'video', 'seedance_v2.5', async (_, index) => {
        if (index === 0) throw failure;
        await new Promise(resolve => setImmediate(resolve));
        return { filePath: `C:/output/late-${index}.mp4`, taskId: `remote-${index}` };
    });
    await assert.rejects(helpers.NODE_TYPES.video.execute({}, {
        prompt: 'batch', duration: 8, resolution: '720p', count: 5, concurrency: 3
    }, h.ctx), actual => actual === failure);

    assert.equal(h.tasks.length, 5, 'video tasks are created before the batch starts');
    assert.deepEqual(h.calls.map(call => call.clientTaskId), ['task-0', 'task-1', 'task-2']);
    assert.deepEqual(h.failures, [{ id: 'task-0', error: failure }]);
    assert.equal(failure.code, 'UPSTREAM_TASK_FAILED');
    assert.deepEqual(failure.unstartedIndices, [3, 4]);
    const partial = failure.partialOutput._batchResults;
    assert.deepEqual(partial.map(result => result._resultFilePath), ['C:/output/late-1.mp4', 'C:/output/late-2.mp4']);
    assert.deepEqual(partial.map(result => result._generation.taskId), ['remote-1', 'remote-2']);
    assert.deepEqual(failure.partialOutput.video, partial.map(result => result.video));
    assert.deepEqual(h.updates.filter(update => update.patch.params?.syncStage === 'submit').map(update => update.id),
        ['task-0', 'task-1', 'task-2']);
    assert.deepEqual(h.updates.filter(update => update.patch.status === 'success').map(update => update.id), ['task-1', 'task-2']);
    const unstarted = h.updates.filter(update => update.patch.status === 'canceled');
    assert.deepEqual(unstarted.map(update => update.id), ['task-3', 'task-4']);
    assert.ok(unstarted.every(update => update.patch.params.syncStage === 'not_submitted' && update.patch.error));
});

test('video execute: a fully failed serial batch has no partialOutput or queued orphan tasks', async t => {
    const failure = new Error('First request failed');
    const h = trackedNodeContext(t, 'video', 'seedance_v2.5', async () => { throw failure; });
    await assert.rejects(helpers.NODE_TYPES.video.execute({}, {
        prompt: 'batch', duration: 8, resolution: '720p', count: 3, concurrency: 1
    }, h.ctx), actual => actual === failure);
    assert.equal(failure.partialOutput, undefined);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.updates.filter(update => update.patch.status === 'canceled').map(update => [update.id, update.patch.params.syncStage]),
        [['task-1', 'not_submitted'], ['task-2', 'not_submitted']]);
});

test('video execute: H3 legacy 720p is normalized before CONFIG validation and task creation', async t => {
    const h = trackedNodeContext(t, 'video', 'minimax-h3', async () => ({ filePath: 'C:/output/h3-768p.mp4' }));
    const checked = [];
    h.ctx.validateGenerationRequest = request => {
        assert.equal(h.tasks.length, 0, 'CONFIG must be validated before task creation');
        assert.equal(h.calls.length, 0);
        assert.equal(request.fields.resolutionTier, '768p');
        const result = validateModelRequest({ ...request, config: DEFAULT_MODEL_CONFIG,
            provider: { ...request.provider, kind: request.kind } });
        assert.equal(result.ok, true, JSON.stringify(result.errors));
        checked.push(structuredClone(request));
    };
    await helpers.NODE_TYPES.video.execute({}, {
        prompt: 'H3 legacy', resolution: '720p', ratio: '16:9', ratioMode: 'manual', duration: 5, count: 1
    }, h.ctx);
    assert.equal(checked.length, 1);
    assert.equal(h.tasks[0].params.resolution, '768p');
    assert.equal(h.calls[0].resolution, '768p');
    assert.equal(h.updates.at(-1).patch.params.resolution, '768p');
});

test('image execute: task snapshots preserve every MJ parameter and webSearch through success', async t => {
    const h = trackedNodeContext(t, 'image', 'mj_imagine', async () => ({ filePath: 'C:/output/mj-hd.png', taskId: 'mj-remote' }));
    await helpers.NODE_TYPES.image.execute({}, {
        prompt: 'MJ snapshot', size: '2048x1360', width: 512, height: 512, resolutionTier: '2K', ratio: '3:2',
        quality: 'medium', webSearch: true, responseFormat: 'b64_json', historyDisabled: false, stream: true,
        midjourneyVersion: '8.2', midjourneyRaw: true, midjourneyStylize: 250, midjourneyChaos: 20,
        midjourneyWeird: 400, midjourneyQuality: 2, midjourneyImageWeight: 1.5,
        midjourneyStyleReference: 'https://example.test/style.png', midjourneyStyleWeight: 80,
        midjourneyStyleVersion: 6, midjourneyOmniReference: 'https://example.test/subject.png', midjourneyOmniWeight: 100,
        midjourneyProfile: 'profile-1', midjourneySeed: 42, midjourneyTile: true, midjourneyDraft: true,
        midjourneyRepeat: 2, midjourneySpeed: 'turbo', midjourneyVisibility: 'stealth', negativePrompt: 'blur'
    }, h.ctx);
    const expected = {
        size: '2048x1360', quality: 'medium', responseFormat: 'url', historyDisabled: true, stream: false,
        webSearch: true, nodeId: 'image-node', midjourney: {
            ratio: '3:2', version: '8.2', raw: true, stylize: 250, chaos: 20, weird: 400,
            quality: 2, imageWeight: 1.5, styleReference: 'https://example.test/style.png', styleWeight: 80,
            styleVersion: 6, omniReference: 'https://example.test/subject.png', omniWeight: 100,
            profile: 'profile-1', seed: 42, tile: true, draft: true, repeat: 2, speed: 'turbo', visibility: 'stealth',
            definition: 'hd', negativePrompt: 'blur'
        }
    };
    assert.equal(h.tasks.length, 1);
    assert.deepEqual(h.tasks[0].params, expected);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(h.calls[0][key], value, key);
    assert.deepEqual(h.updates.at(-1).patch.params, { ...expected, filePaths: ['C:/output/mj-hd.png'] });
    assert.equal(h.updates.at(-1).patch.taskId, 'mj-remote');
});

test('expandGenerationPrompts: 默认把上游文本追加到节点提示词并展开生成数量', () => {
    assert.deepEqual(
        helpers.expandGenerationPrompts({ prompt: ['A', 'B'] }, { prompt: 'fallback', count: 2 }),
        ['fallback\n\nA', 'fallback\n\nA', 'fallback\n\nB', 'fallback\n\nB']
    );
});

test('expandGenerationPrompts: 支持前置与替换上游文本', () => {
    assert.deepEqual(
        helpers.expandGenerationPrompts({ prompt: ['A', 'B'] }, { prompt: 'local', promptMergeMode: 'prepend' }),
        ['A\n\nlocal', 'B\n\nlocal']
    );
    assert.deepEqual(
        helpers.expandGenerationPrompts({ prompt: ['A', 'B'] }, { prompt: 'local', promptMergeMode: 'replace' }),
        ['A', 'B']
    );
});

test('expandGenerationPrompts: 没有上游文本时始终使用节点提示词', () => {
    assert.deepEqual(
        helpers.expandGenerationPrompts({}, { prompt: 'fallback', promptMergeMode: 'replace', count: 3 }),
        ['fallback', 'fallback', 'fallback']
    );
});

test('expandGenerationPrompts: 把参考图胶囊转换为模型可理解的提示词', () => {
    assert.deepEqual(
        helpers.expandGenerationPrompts({}, {
            prompt: '把背景改成夜景',
            referenceCitationLabels: ['图一', '图三'],
            count: 1
        }),
        ['参考图编号与上传顺序一致：图一=第1张，图三=第3张。\n把背景改成夜景']
    );
});

test('expandGenerationPrompts: 按胶囊位置还原图一和图二的编辑职责', () => {
    assert.deepEqual(
        helpers.expandGenerationPrompts({}, {
            prompt: '使用的机器人和人的比例重新绘制',
            referenceCitationIds: ['first', 'second'],
            referenceCitationLabels: ['图一', '图二'],
            referenceCitationOffsets: { first: 2, second: 15 },
            count: 1
        }),
        ['参考图编号与上传顺序一致：图一=第1张，图二=第2张。\n使用图一的机器人和人的比例重新绘制图二']
    );
});

test('expandGenerationPrompts: repeated citations retain occurrence order without duplicating upload labels', () => {
    const config = {
        prompt: 'A B C',
        referenceCitationIds: ['first', 'second'],
        referenceCitationLabels: ['图一', '图二'],
        referenceCitationOffsets: { first: 0, second: 0 },
        referenceCitationOccurrences: [
            { id: 'a', connectionId: 'first', offset: 0 },
            { id: 'b', connectionId: 'second', offset: 2 },
            { id: 'c', connectionId: 'first', offset: 4 },
            { id: 'd', connectionId: 'second', offset: 4 }
        ]
    };
    assert.deepEqual(helpers.expandGenerationPrompts({}, JSON.parse(JSON.stringify(config))), [
        '参考图编号与上传顺序一致：图一=第1张，图二=第2张。\n图一A 图二B 图一图二C'
    ]);
    config.referenceCitationOccurrences.splice(0, 1);
    assert.match(helpers.expandGenerationPrompts({}, config)[0], /\nA 图二B 图一图二C$/);
    config.referenceCitationOccurrences = [];
    assert.match(helpers.expandGenerationPrompts({}, config)[0], /\nA B C$/);
});

test('reference preprocessing cannot silently drop selected images', async () => {
    const refs = [{ filePath: 'first.png' }, { filePath: 'second.png' }];
    await assert.rejects(helpers.prepareGenerationReferences(refs, async () => []), /参考图处理不完整/);
    await assert.rejects(helpers.prepareGenerationReferences(refs, async () => ({ references: [refs[0]] })), /参考图处理不完整/);
    await assert.rejects(helpers.prepareGenerationReferences(refs, async () => [refs[0], {}]), /参考图处理不完整/);
    const compressed = [{ filePath: 'first-small.png' }, { filePath: 'second-small.png' }];
    assert.deepEqual(await helpers.prepareGenerationReferences(refs, async () => ({ references: compressed })), compressed);
});

test('prepareGenerationReferences: 用户取消参考图处理时中止而不是静默清空', async () => {
    const refs = [{ filePath: 'first.png' }, { filePath: 'second.png' }];
    await assert.rejects(
        helpers.prepareGenerationReferences(refs, async () => helpers.CANCELED_IMAGE_REFERENCES),
        /参考图处理未完成/
    );
    // 结构相同的普通对象也应被识别为取消标记
    await assert.rejects(
        helpers.prepareGenerationReferences(refs, async () => ({ canceled: true })),
        /参考图处理未完成/
    );
    // 准备器不可用属于异常，同样不能退化成空数组
    await assert.rejects(
        helpers.prepareGenerationReferences(refs, async () => null),
        /参考图准备服务不可用/
    );
});

test('取消参考图的错误文案不得被误判为用户中断', async () => {
    const refs = [{ filePath: 'first.png' }];
    const messages = [];
    for (const prepare of [
        async () => helpers.CANCELED_IMAGE_REFERENCES,
        async () => null
    ]) {
        await helpers.prepareGenerationReferences(refs, prepare).catch(error => messages.push(error.message));
    }
    assert.equal(messages.length, 2);
    for (const message of messages) {
        // graph-runner 旧版按文本匹配 /已取消|cancel/i 判定用户中断，会把真实失败
        // 原因吞掉、节点标成 canceled。这些文案必须避开这些字样。
        assert.doesNotMatch(message, /任务已中断|已取消|cancel/i, `文案不应含中断关键词：${message}`);
    }
});

test('image execute: 取消参考图处理时不提交任何生图请求', async () => {
    const calls = [];
    const previousWindow = global.window;
    global.window = {
        flowCanvas: {
            mcp: {
                generateImage: async options => {
                    calls.push(options);
                    return { filePath: 'C:/output/should-not-happen.png' };
                }
            }
        }
    };

    try {
        await assert.rejects(
            helpers.NODE_TYPES.image.execute(
                { reference: ['local-res://C%3A%2Frefs%2Fone.png'] },
                { prompt: '生成以图二色调为主的全景', width: 1024, height: 1024, count: 1, concurrency: 1 },
                {
                    item: { id: 'image-node' },
                    getImageProvider: () => ({
                        apiKey: 'test-key',
                        endpoint: 'https://example.test/v1',
                        model: 'gpt-image-2.5-sunburst'
                    }),
                    prepareImageReferences: async () => helpers.CANCELED_IMAGE_REFERENCES
                }
            ),
            /参考图处理未完成/
        );
        assert.deepEqual(calls, [], '取消后不应再向生图接口提交请求');
    } finally {
        global.window = previousWindow;
    }
});

test('mapWithConcurrency: 保持结果顺序并限制并发', async () => {
    let active = 0;
    let peak = 0;
    const values = [30, 5, 20, 1];
    const results = await helpers.mapWithConcurrency(values, 2, async value => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, value));
        active -= 1;
        return value * 2;
    });

    assert.deepEqual(results, [60, 10, 40, 2]);
    assert.equal(peak, 2);
});

test('mapWithConcurrency: 失败后不再领取新任务，避免孤儿请求继续扣费', async () => {
    const started = [];
    const values = [1, 2, 3, 4, 5, 6];
    // 并发 2：索引 0 立即失败；索引 1 稍慢。修复前 consume 会继续领取
    // 索引 2、3、4、5，对图片/视频节点意味着白花的生成请求与产物下载。
    const error = await helpers.mapWithConcurrency(values, 2, async value => {
        started.push(value);
        if (value === 1) throw new Error('第一个任务失败');
        await new Promise(resolve => setTimeout(resolve, 5));
        return value;
    }).then(() => null, err => err);

    assert.ok(error, '应当抛出第一个错误');
    assert.equal(error.message, '第一个任务失败', '应原样抛出第一个错误，而不是包装');
    // 索引 0、1 各领一次即可；断言没有继续领到后面四个任务
    assert.deepEqual(started, [1, 2], `失败后不应再领取新任务，实际领取了 ${started.join(',')}`);
});

test('mapWithConcurrency: 全部失败时抛出第一个错误而不是 AggregateError', async () => {
    const error = await helpers.mapWithConcurrency([1, 2, 3], 3, async value => {
        throw new Error(`失败-${value}`);
    }).then(() => null, err => err);
    assert.ok(error);
    assert.match(error.message, /失败-\d/);
});

test('text execute: 开启文字 AI 后使用独立文字 provider', async () => {
    const calls = [];
    const previousWindow = global.window;
    global.window = {
        flowCanvas: {
            ai: {
                generateText: async options => {
                    calls.push(options);
                    return { success: true, text: '优化后的提示词' };
                }
            }
        }
    };

    try {
        const output = await helpers.NODE_TYPES.text.execute({ context: ['参考信息'] }, {
            useAi: true,
            text: '请优化',
            separator: '\n',
            splitBy: '',
            providerId: 'text-provider',
            model: 'gpt-5.5'
        }, {
            getTextProvider: binding => ({
                apiKey: 'test-key',
                endpoint: 'https://ai.ravenhash.org/v1',
                model: binding.model
            })
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].prompt, '参考信息\n请优化');
        assert.equal(calls[0].provider.model, 'gpt-5.5');
        assert.deepEqual(output, { text: '优化后的提示词' });
    } finally {
        global.window = previousWindow;
    }
});

test('image execute: 由节点 runner 唯一负责结果落地', async () => {
    const calls = [];
    const previousWindow = global.window;
    global.window = {
        flowCanvas: {
            mcp: {
                generateImage: async options => {
                    calls.push(options);
                    return {
                        item: null,
                        filePath: 'C:/output/result.png',
                        url: 'https://example.test/result.png'
                    };
                }
            }
        }
    };

    try {
        const output = await helpers.NODE_TYPES.image.execute({
            source: [
                '上游场景描述',
                [
                    'local-res://' + encodeURIComponent('C:/refs/first.png'),
                    'local-res://' + encodeURIComponent('C:/refs/second.png')
                ]
            ]
        }, {
            prompt: '测试图片',
            width: 1536,
            height: 1024,
            count: 1,
            concurrency: 1,
            providerId: 'image-provider',
            sourceProviderId: 'image-provider',
            model: 'gpt-image-2'
        }, {
            item: {},
            getImageProvider: () => ({ apiKey: 'test-key', endpoint: 'https://example.test/v1', model: 'gpt-image-2' }),
            prepareImageReferences: refs => ({ references: refs, outputs: [] })
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].prompt, '测试图片\n\n上游场景描述');
        assert.deepEqual(calls[0].sourceReferences, [
            { filePath: 'C:/refs/first.png' }, { filePath: 'C:/refs/second.png' }
        ]);
        assert.equal(calls[0].size, '1536x1024');
        assert.equal(calls[0].addToCanvas, false);
        assert.equal(output._resultFilePath, 'C:/output/result.png');
        assert.equal(output._generation.prompt, '测试图片\n\n上游场景描述');
        assert.equal(output._generation.model, 'gpt-image-2');
        assert.equal(output._generation.config.prompt, '测试图片');
        assert.equal(output._generation.requestPrompt, calls[0].prompt);
        assert.deepEqual(output._generation.promptDraftConfig.generationUpstreamPrompts, ['上游场景描述']);
        assert.equal(output._generation.promptDraftConfig.prompt, '测试图片');
    } finally {
        global.window = previousWindow;
    }
});

test('expandGenerationPrompts: Agent 编译提示词覆盖本次运行但保留生成数量', () => {
    assert.deepEqual(
        helpers.expandGenerationPrompts({ prompt: ['上游旧提示词'] }, {
            prompt: '节点旧提示词',
            agentCompiledPrompt: 'Agent 最终提示词',
            count: 2
        }),
        ['Agent 最终提示词', 'Agent 最终提示词']
    );
});

test('image execute: 上游返回视频时标记真实媒体类型供画布转换', async () => {
    const previousWindow = global.window;
    global.window = {
        flowCanvas: {
            mcp: {
                generateImage: async () => ({
                    filePath: 'C:/output/result.mp4',
                    filePaths: ['C:/output/result.mp4'],
                    mediaType: 'video',
                    images: [{ filePath: 'C:/output/result.mp4', mediaType: 'video' }]
                })
            }
        }
    };

    try {
        const output = await helpers.NODE_TYPES.image.execute({}, {
            prompt: 'animate this image',
            count: 1,
            concurrency: 1
        }, {
            item: {},
            getImageProvider: () => ({ apiKey: 'test-key', endpoint: 'https://example.test/v1', model: 'image-model' })
        });

        assert.equal(output._resultFilePath, 'C:/output/result.mp4');
        assert.equal(output._resultMediaType, 'video');
    } finally {
        global.window = previousWindow;
    }
});

test('image execute: 画布生成请求创建并完成一条可追踪任务记录', async () => {
    const calls = [];
    const created = [];
    const updates = [];
    const previousWindow = global.window;
    global.window = {
        flowCanvas: {
            mcp: {
                generateImage: async options => {
                    calls.push(options);
                    return { filePath: 'C:/output/tracked-result.png' };
                }
            }
        }
    };

    try {
        await helpers.NODE_TYPES.image.execute({}, {
            prompt: 'tracked image',
            width: 1024,
            height: 1024,
            count: 1,
            concurrency: 1
        }, {
            item: { id: 'image-node-1' },
            getImageProvider: () => ({
                id: 'image-provider',
                apiKey: 'test-key',
                endpoint: 'https://example.test/v1',
                model: 'gpt-image-2'
            }),
            createGenerationTask: details => {
                created.push(details);
                return { id: 'client-image-task-1' };
            },
            updateGenerationTask: (id, patch) => updates.push({ id, patch })
        });

        assert.equal(created.length, 1);
        assert.equal(created[0].kind, 'image');
        assert.equal(created[0].prompt, 'tracked image');
        assert.equal(calls[0].clientTaskId, 'client-image-task-1');
        assert.equal(updates.at(-1).id, 'client-image-task-1');
        assert.equal(updates.at(-1).patch.status, 'success');
        assert.equal(updates.at(-1).patch.filePath, 'C:/output/tracked-result.png');
    } finally {
        global.window = previousWindow;
    }
});

test('image execute: 连续生成两张图片分别创建并完成任务记录', async () => {
    const created = [];
    const updates = [];
    const previousWindow = global.window;
    let requestIndex = 0;
    global.window = {
        flowCanvas: {
            mcp: {
                generateImage: async options => ({
                    filePath: `C:/output/tracked-result-${++requestIndex}.png`,
                    clientTaskId: options.clientTaskId
                })
            }
        }
    };

    try {
        const output = await helpers.NODE_TYPES.image.execute({}, {
            prompt: 'two tracked images',
            width: 1024,
            height: 1024,
            count: 2,
            concurrency: 2
        }, {
            item: { id: 'image-node-2' },
            getImageProvider: () => ({
                id: 'image-provider',
                apiKey: 'test-key',
                endpoint: 'https://example.test/v1',
                model: 'gpt-image-2'
            }),
            createGenerationTask: details => {
                const task = { id: `client-image-task-${created.length + 1}`, details };
                created.push(task);
                return task;
            },
            updateGenerationTask: (id, patch) => updates.push({ id, patch })
        });

        assert.equal(created.length, 2);
        assert.deepEqual(created.map(task => task.details.kind), ['image', 'image']);
        assert.deepEqual(updates.map(update => update.id).sort(), [
            'client-image-task-1',
            'client-image-task-2'
        ]);
        assert.ok(updates.every(update => update.patch.status === 'success'));
        assert.equal(output._batchResults.length, 2);
    } finally {
        global.window = previousWindow;
    }
});

test('image execute: mj_imagine 一次请求展开为四张候选并保留结果堆叠', async () => {
    const calls = [];
    const previousWindow = global.window;
    global.window = {
        flowCanvas: {
            mcp: {
                generateImage: async options => {
                    calls.push(options);
                    return {
                        filePath: 'C:/output/mj_U1.png',
                        filePaths: [
                            'C:/output/mj_U1.png',
                            'C:/output/mj_U2.png',
                            'C:/output/mj_U3.png',
                            'C:/output/mj_U4.png'
                        ],
                        images: [1, 2, 3, 4].map(candidateIndex => ({ candidateIndex })),
                        midjourney: { candidateCount: 4 }
                    };
                }
            }
        }
    };

    try {
        const output = await helpers.NODE_TYPES.image.execute({}, {
            prompt: 'editorial portrait',
            width: 1024,
            height: 1024,
            ratio: '3:2',
            resolutionTier: '2K',
            count: 4,
            concurrency: 4,
            midjourneyVersion: '8.2',
            midjourneyRaw: true,
            midjourneyStylize: 250,
            midjourneyChaos: 20,
            midjourneyWeird: 400,
            midjourneyQuality: '2',
            midjourneyImageWeight: 1.5,
            midjourneyStyleReference: '123456',
            midjourneyStyleWeight: 200,
            midjourneyStyleVersion: '6',
            midjourneyOmniReference: '',
            midjourneyOmniWeight: 300,
            midjourneyProfile: 'profile-1',
            midjourneySeed: 42,
            midjourneyTile: true,
            midjourneyDraft: false,
            midjourneyRepeat: 2,
            midjourneySpeed: 'turbo',
            midjourneyVisibility: 'stealth',
            negativePrompt: 'text, watermark'
        }, {
            item: {},
            getImageProvider: () => ({
                apiKey: 'test-key',
                endpoint: 'https://example.test/v1',
                model: 'mj_imagine'
            }),
            prepareImageReferences: refs => refs
        });

        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].midjourney, {
            ratio: '3:2',
            version: '8.2',
            raw: true,
            stylize: 250,
            chaos: 20,
            weird: 400,
            quality: '2',
            imageWeight: 1.5,
            styleReference: '123456',
            styleWeight: 200,
            styleVersion: '6',
            omniReference: '',
            omniWeight: 300,
            profile: 'profile-1',
            seed: 42,
            tile: true,
            draft: false,
            repeat: 2,
            speed: 'turbo',
            visibility: 'stealth',
            definition: 'hd',
            negativePrompt: 'text, watermark'
        });
        assert.equal(output._batchResults.length, 4);
        assert.deepEqual(
            output._batchResults.map(result => result._candidateIndex),
            [1, 2, 3, 4]
        );
        assert.ok(output._batchResults.every(result => result._preserveGeneratorStack === true));
        assert.ok(output._batchResults.every(result => result._forceSquarePreview === true));
    } finally {
        global.window = previousWindow;
    }
});

test('image execute: Shadow Planner 与图片 Provider 并行且不改写真实请求', async () => {
    const generationCalls = [];
    const plannerCalls = [];
    const traces = [];
    const previousWindow = global.window;
    global.window = {
        flowCanvas: {
            ai: {
                planImageEdit: async request => {
                    plannerCalls.push(request);
                    return {
                        success: true,
                        durationMs: 12,
                        referenceHashes: { 'ref-1': 'hash-a', 'ref-2': 'hash-b' },
                        plan: {
                            schemaVersion: '1.0',
                            task: 'multi_reference_edit',
                            targetReferenceId: 'ref-2',
                            referenceContributions: [
                                { referenceId: 'ref-1', useFor: ['比例'], confidence: 0.9 },
                                { referenceId: 'ref-2', useFor: ['基础场景'], confidence: 0.95 }
                            ],
                            operations: [{
                                type: 'transfer_relation',
                                sourceReferenceIds: ['ref-1'],
                                targetReferenceId: 'ref-2',
                                attribute: 'relative_scale',
                                description: '把图一的比例应用到图二',
                                evidence: [{ type: 'reference_text_context', referenceId: 'ref-1', text: '使用图一的比例' }],
                                confidence: 0.9
                            }],
                            preserve: ['ref-2.scene'],
                            change: ['ref-2.relative_scale'],
                            exclude: [],
                            uncertainties: [],
                            overallConfidence: 0.9
                        },
                        rawText: '{"task":"multi_reference_edit"}'
                    };
                },
                saveGenerationTrace: async trace => {
                    traces.push(trace);
                    return { success: true, filePath: 'C:/traces/test.json' };
                }
            },
            mcp: {
                generateImage: async request => {
                    generationCalls.push(request);
                    return { filePath: 'C:/output/shadow-result.png' };
                }
            }
        }
    };

    try {
        await helpers.NODE_TYPES.image.execute({
            source: [
                'local-res://' + encodeURIComponent('C:/refs/ratio.png'),
                'local-res://' + encodeURIComponent('C:/refs/scene.png')
            ]
        }, {
            prompt: '使用图一的比例重新绘制图二 shadow-test',
            referenceCitationIds: ['connection-a', 'connection-b'],
            referenceCitationLabels: ['图一', '图二'],
            width: 1024,
            height: 1024,
            count: 1,
            concurrency: 1
        }, {
            item: { id: 'generator' },
            inputContext: [
                {
                    connectionId: 'connection-a',
                    connectionIndex: 0,
                    sourceNodeId: 'source-a',
                    values: ['local-res://' + encodeURIComponent('C:/refs/ratio.png')]
                },
                {
                    connectionId: 'connection-b',
                    connectionIndex: 1,
                    sourceNodeId: 'source-b',
                    values: ['local-res://' + encodeURIComponent('C:/refs/scene.png')]
                }
            ],
            getImageIntentPipelineMode: () => 'shadow',
            getTextProvider: () => ({
                id: 'text-provider',
                apiKey: 'text-key',
                endpoint: 'https://text.example.test/v1',
                model: 'gpt-5.5'
            }),
            getImageProvider: () => ({
                id: 'image-provider',
                apiKey: 'image-key',
                endpoint: 'https://image.example.test/v1',
                model: 'gpt-image-2'
            }),
            prepareImageReferences: refs => refs
        });
        await new Promise(resolve => setTimeout(resolve, 20));

        assert.equal(plannerCalls.length, 1);
        assert.deepEqual(plannerCalls[0].filePaths, ['C:/refs/ratio.png', 'C:/refs/scene.png']);
        assert.equal(generationCalls.length, 1);
        assert.equal(
            generationCalls[0].prompt,
            '参考图编号与上传顺序一致：图一=第1张，图二=第2张。\n使用图一的比例重新绘制图二 shadow-test'
        );
        assert.equal(traces.length, 1);
        assert.equal(traces[0].planner.model, 'gpt-5.5');
        assert.equal(traces[0].generation.model, 'gpt-image-2');
        assert.equal(traces[0].fallback.reason, 'SHADOW_MODE');
        assert.equal(traces[0].editPlan.targetReferenceId, 'ref-2');
        assert.equal(traces[0].referenceMapping[0].originalImageHash, 'hash-a');
    } finally {
        global.window = previousWindow;
    }
});

test('image execute: 编译模式等待有效计划并把强约束 Prompt 交给图片 Provider', async () => {
    const generationCalls = [];
    const traces = [];
    let resolvePlanner;
    const plannerResult = new Promise(resolve => { resolvePlanner = resolve; });
    const previousWindow = global.window;
    global.window = {
        flowCanvas: {
            ai: {
                planImageEdit: () => plannerResult,
                saveGenerationTrace: async trace => {
                    traces.push(trace);
                    return { success: true };
                }
            },
            mcp: {
                generateImage: async request => {
                    generationCalls.push(request);
                    return { filePath: 'C:/output/compiled-result.png' };
                }
            }
        }
    };

    try {
        const execution = helpers.NODE_TYPES.image.execute({
            source: [
                'local-res://' + encodeURIComponent('C:/refs/compiled-ratio.png'),
                'local-res://' + encodeURIComponent('C:/refs/compiled-scene.png')
            ]
        }, {
            prompt: '使用图一比例重新绘制图二 compiled-test',
            referenceCitationIds: ['compiled-a', 'compiled-b'],
            referenceCitationLabels: ['图一', '图二'],
            width: 1024,
            height: 1024,
            count: 1,
            concurrency: 1
        }, {
            item: { id: 'compiled-generator' },
            inputContext: [
                {
                    connectionId: 'compiled-a',
                    connectionIndex: 0,
                    sourceNodeId: 'compiled-source-a',
                    values: ['local-res://' + encodeURIComponent('C:/refs/compiled-ratio.png')]
                },
                {
                    connectionId: 'compiled-b',
                    connectionIndex: 1,
                    sourceNodeId: 'compiled-source-b',
                    values: ['local-res://' + encodeURIComponent('C:/refs/compiled-scene.png')]
                }
            ],
            getImageIntentPipelineMode: () => 'compiled',
            getTextProvider: () => ({
                id: 'compiled-text-provider',
                apiKey: 'text-key',
                endpoint: 'https://text.example.test/v1',
                model: 'gpt-5.6-terra'
            }),
            getImageProvider: () => ({
                id: 'compiled-image-provider',
                apiKey: 'image-key',
                endpoint: 'https://image.example.test/v1',
                model: 'gpt-image-2'
            }),
            prepareImageReferences: refs => refs
        });

        await new Promise(resolve => setImmediate(resolve));
        assert.equal(generationCalls.length, 0, '图片请求必须等待 Planner 完成');

        resolvePlanner({
            success: true,
            durationMs: 15,
            plan: {
                schemaVersion: '1.0',
                task: 'multi_reference_edit',
                targetReferenceId: 'ref-2',
                referenceContributions: [
                    { referenceId: 'ref-1', useFor: '比例', ignoreFor: '背景', preserve: '较矮机器人', confidence: 0.98 },
                    { referenceId: 'ref-2', useFor: '目标场景', preserve: '构图', confidence: 0.97 }
                ],
                operations: [{
                    type: 'adjust_relative_scale',
                    sourceReferenceIds: ['ref-1'],
                    targetReferenceId: 'ref-2',
                    attribute: 'robot_to_human_proportion',
                    description: '让图二机器人明显低于人物',
                    evidence: [{ type: 'explicit_user_text', text: '使用图一比例' }],
                    confidence: 0.99
                }],
                preserve: ['图二构图'],
                change: ['机器人相对高度'],
                exclude: ['图一背景'],
                uncertainties: [],
                overallConfidence: 0.97
            },
            rawText: '{}'
        });

        await execution;
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(generationCalls.length, 1);
        assert.match(generationCalls[0].prompt, /以第2张参考图（图二）为唯一基础画面/);
        assert.match(generationCalls[0].prompt, /让图二机器人明显低于人物/);
        assert.equal(generationCalls[0].prompt.includes('参考图编号与上传顺序一致'), false);
        assert.equal(traces[0].planner.mode, 'compiled');
        assert.equal(traces[0].fallback.used, false);
        assert.equal(traces[0].compiler.compilerVersion, 'openai-image.v1');
        assert.equal(traces[0].generation.requestPrompt, generationCalls[0].prompt);
    } finally {
        global.window = previousWindow;
    }
});

test('video execute: 使用节点绑定模型并透传完整参数与参考素材', async () => {
    const calls = [];
    const createdTasks = [];
    const taskUpdates = [];
    const previousWindow = global.window;
    global.window = {
        flowCanvas: {
            mcp: {
                generateVideo: async options => {
                    calls.push(options);
                    return {
                        item: { id: 'video-item', filePath: 'C:/output/result.mp4' },
                        url: 'https://example.test/result.mp4'
                    };
                }
            }
        }
    };

    const bindingCalls = [];
    try {
        const output = await helpers.NODE_TYPES.video.execute({
            prompt: ['测试提示词'],
            image: ['local-res://' + encodeURIComponent('C:/refs/first.png')],
            video: ['local-res://' + encodeURIComponent('C:/refs/motion.mp4')],
            audio: ['local-res://' + encodeURIComponent('C:/refs/music.wav')]
        }, {
            providerId: 'provider::model:seedance',
            sourceProviderId: 'provider',
            model: 'seedance-2.0',
            ratio: '9:16',
            resolution: '1080p',
            duration: 8,
            cameraFixed: true,
            generateAudio: true,
            webSearch: true,
            watermark: true,
            count: 1,
            concurrency: 2
        }, {
            item: { id: 'video-node-1' },
            getVideoProvider: binding => {
                bindingCalls.push(binding);
                return { id: 'provider', apiKey: 'test-key', endpoint: 'https://example.test/v1', model: binding.model };
            },
            prepareImageReferences: refs => refs,
            createGenerationTask: details => {
                createdTasks.push(details);
                return { id: 'client-video-task-1' };
            },
            updateGenerationTask: (id, patch) => taskUpdates.push({ id, patch })
        });

        assert.equal(bindingCalls[0].model, 'seedance-2.0');
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].sourceReferences, [{ filePath: 'C:/refs/first.png' }]);
        assert.deepEqual(calls[0].videoReferences, [{ filePath: 'C:/refs/motion.mp4' }]);
        assert.deepEqual(calls[0].audioReferences, [{ filePath: 'C:/refs/music.wav' }]);
        assert.equal(calls[0].ratio, '9:16');
        assert.equal(calls[0].resolution, '1080p');
        assert.equal(calls[0].duration, 8);
        assert.equal(calls[0].cameraFixed, true);
        assert.equal(calls[0].generateAudio, true);
        assert.equal(calls[0].webSearch, true);
        assert.equal(calls[0].watermark, true);
        assert.equal(calls[0].provider, 'openai-video');
        assert.equal(calls[0].clientTaskId, 'client-video-task-1');
        assert.equal(calls[0].addToCanvas, false);
        assert.equal(createdTasks.length, 1);
        assert.deepEqual(createdTasks[0].params, {
            resolution: '1080p',
            ratio: '9:16',
            duration: 8,
            cameraFixed: true,
            generateAudio: true,
            webSearch: true,
            watermark: true,
            compressReferenceImages: false,
            nodeId: 'video-node-1',
            syncStage: 'prepare',
            videoSourcePaths: ['C:/refs/motion.mp4'],
            audioSourcePaths: ['C:/refs/music.wav']
        });
        assert.equal(taskUpdates.at(-1).id, 'client-video-task-1');
        assert.equal(taskUpdates.at(-1).patch.status, 'success');
        assert.equal(taskUpdates.at(-1).patch.params.generateAudio, true);
        assert.equal(taskUpdates.at(-1).patch.params.webSearch, true);
        assert.equal(output._resultItem.id, 'video-item');
        assert.equal(output._generation.prompt, '测试提示词');
        assert.equal(output._generation.model, 'seedance-2.0');
        assert.equal(output._generation.config.duration, 8);
        assert.equal(output._generation.config.ratio, '9:16');
    } finally {
        global.window = previousWindow;
    }
});

test('video execute: 参考图预处理失败时仍立即创建并标记任务记录', async () => {
    const createdTasks = [];
    const errors = [];
    const previousWindow = global.window;
    global.window = { flowCanvas: { mcp: { generateVideo: async () => ({}) } } };

    try {
        await assert.rejects(
            helpers.NODE_TYPES.video.execute({
                source: [
                    '测试提示词',
                    'local-res://' + encodeURIComponent('C:/refs/broken.png')
                ]
            }, {
                model: 'seedance_v2.5',
                ratio: '16:9',
                resolution: '720p',
                duration: 30,
                count: 1,
                concurrency: 1
            }, {
                item: { id: 'seedance-video-node' },
                getVideoProvider: () => ({
                    id: 'video-provider',
                    apiKey: 'test-key',
                    endpoint: 'https://example.test/v1',
                    model: 'seedance_v2.5'
                }),
                prepareImageReferences: async () => {
                    throw new Error('参考图读取失败');
                },
                createGenerationTask: details => {
                    createdTasks.push(details);
                    return { id: 'seedance-client-task' };
                },
                recordGenerationError: (id, error) => errors.push({ id, error: error.message })
            }),
            /参考图读取失败/
        );

        assert.equal(createdTasks.length, 1);
        assert.equal(createdTasks[0].params.syncStage, 'prepare');
        assert.deepEqual(createdTasks[0].sourcePaths, ['C:/refs/broken.png']);
        assert.deepEqual(errors, [{ id: 'seedance-client-task', error: '参考图读取失败' }]);
    } finally {
        global.window = previousWindow;
    }
});

test('video execute: MiniMax H3 旧节点自动继承第一张参考图比例', async () => {
    const calls = [];
    const createdTasks = [];
    const previousWindow = global.window;
    global.window = {
        flowCanvas: {
            mcp: {
                generateVideo: async options => {
                    calls.push(options);
                    return { filePath: 'C:/output/h3-result.mp4' };
                }
            }
        }
    };

    try {
        await helpers.NODE_TYPES.video.execute({
            source: [
                '测试提示词',
                'local-res://' + encodeURIComponent('C:/refs/portrait.png')
            ]
        }, {
            model: 'minimax-h3',
            ratio: '16:9',
            resolution: '2k',
            duration: 5,
            count: 1,
            concurrency: 1
        }, {
            item: { id: 'h3-video-node' },
            inputContext: [{
                source: {
                    filePath: 'C:/refs/portrait.png',
                    mediaType: 'image',
                    width: 300,
                    height: 450
                }
            }],
            getVideoProvider: () => ({
                id: 'h3-provider',
                apiKey: 'test-key',
                endpoint: 'https://example.test/v1',
                model: 'minimax-h3'
            }),
            prepareImageReferences: refs => refs,
            createGenerationTask: details => {
                createdTasks.push(details);
                return { id: 'h3-client-task' };
            },
            updateGenerationTask: () => {}
        });

        assert.equal(calls[0].ratio, '2:3');
        assert.equal(createdTasks[0].params.ratio, '2:3');
    } finally {
        global.window = previousWindow;
    }
});

test('video execute: MiniMax H3 尊重明确选择的固定比例', async () => {
    const calls = [];
    const previousWindow = global.window;
    global.window = {
        flowCanvas: {
            mcp: {
                generateVideo: async options => {
                    calls.push(options);
                    return { filePath: 'C:/output/h3-manual-result.mp4' };
                }
            }
        }
    };

    try {
        await helpers.NODE_TYPES.video.execute({
            source: [
                '测试提示词',
                'local-res://' + encodeURIComponent('C:/refs/portrait.png')
            ]
        }, {
            model: 'minimax-h3',
            ratio: '16:9',
            ratioMode: 'manual',
            resolution: '2k',
            duration: 5,
            count: 1,
            concurrency: 1
        }, {
            item: { id: 'h3-manual-video-node' },
            inputContext: [{
                source: {
                    filePath: 'C:/refs/portrait.png',
                    mediaType: 'image',
                    width: 300,
                    height: 450
                }
            }],
            getVideoProvider: () => ({
                id: 'h3-provider',
                apiKey: 'test-key',
                endpoint: 'https://example.test/v1',
                model: 'minimax-h3'
            }),
            prepareImageReferences: refs => refs
        });

        assert.equal(calls[0].ratio, '16:9');
    } finally {
        global.window = previousWindow;
    }
});

test('video execute: Seedance 2.5 自适应比例会按第一张参考图映射为受支持比例', async () => {
    const calls = [];
    const createdTasks = [];
    const previousWindow = global.window;
    global.window = {
        flowCanvas: {
            mcp: {
                generateVideo: async options => {
                    calls.push(options);
                    return { filePath: 'C:/output/seedance-result.mp4' };
                }
            }
        }
    };

    try {
        await helpers.NODE_TYPES.video.execute({
            source: [
                '测试提示词',
                'local-res://' + encodeURIComponent('C:/refs/portrait.jpg')
            ]
        }, {
            model: 'seedance_v2.5',
            ratio: 'adaptive',
            ratioMode: 'auto',
            resolution: '720p',
            duration: 30,
            count: 1,
            concurrency: 1
        }, {
            item: { id: 'seedance-video-node' },
            inputContext: [{
                source: {
                    filePath: 'C:/refs/portrait.jpg',
                    mediaType: 'image',
                    width: 1280,
                    height: 1920
                }
            }],
            getVideoProvider: () => ({
                id: 'seedance-provider',
                apiKey: 'test-key',
                endpoint: 'https://art.ravenhash.org/v1',
                model: 'seedance_v2.5'
            }),
            prepareImageReferences: refs => refs,
            createGenerationTask: details => {
                createdTasks.push(details);
                return { id: 'seedance-client-task' };
            },
            updateGenerationTask: () => {}
        });

        assert.equal(calls[0].ratio, '3:4');
        assert.equal(calls[0].duration, 30);
        assert.equal(createdTasks[0].params.ratio, '3:4');
    } finally {
        global.window = previousWindow;
    }
});
