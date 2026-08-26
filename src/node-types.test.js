const test = require('node:test');
const assert = require('node:assert/strict');

let helpers;
test.before(async () => {
    helpers = await import('./node-types.js');
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
                'local-res://' + encodeURIComponent('C:/refs/first.png')
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
        assert.deepEqual(calls[0].sourceReferences, [{ filePath: 'C:/refs/first.png' }]);
        assert.equal(calls[0].size, '1536x1024');
        assert.equal(calls[0].addToCanvas, false);
        assert.equal(output._resultFilePath, 'C:/output/result.png');
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
            item: {},
            getVideoProvider: binding => {
                bindingCalls.push(binding);
                return { apiKey: 'test-key', endpoint: 'https://example.test/v1', model: binding.model };
            },
            prepareImageReferences: refs => refs
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
        assert.equal(calls[0].addToCanvas, false);
        assert.equal(output._resultItem.id, 'video-item');
    } finally {
        global.window = previousWindow;
    }
});
