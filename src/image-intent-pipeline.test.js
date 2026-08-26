const test = require('node:test');
const assert = require('node:assert/strict');

let pipeline;
test.before(async () => {
    pipeline = await import('./image-intent-pipeline.js');
});

function makeContext() {
    return pipeline.buildReferenceContext({
        targetNodeId: 'generator',
        originalPrompt: '使用图一的比例重新绘制图二',
        promptWithReferenceTokens: '使用图一的比例重新绘制图二',
        sourceReferences: [
            { filePath: 'C:/refs/ratio.png' },
            { filePath: 'C:/refs/scene.png' }
        ],
        inputContext: [
            {
                connectionId: 'connection-a',
                connectionIndex: 0,
                sourceNodeId: 'source-a',
                values: ['local-res://' + encodeURIComponent('C:/refs/ratio.png')],
                source: { id: 'source-a', filePath: 'C:/refs/ratio.png' }
            },
            {
                connectionId: 'connection-b',
                connectionIndex: 1,
                sourceNodeId: 'source-b',
                values: ['local-res://' + encodeURIComponent('C:/refs/scene.png')],
                source: { id: 'source-b', filePath: 'C:/refs/scene.png', fromNodeId: 'older-generator' }
            }
        ],
        config: {
            referenceCitationIds: ['connection-a', 'connection-b'],
            referenceCitationLabels: ['图一', '图二']
        }
    });
}

test('buildReferenceContext: 保留引用胶囊、来源节点和上传顺序', () => {
    const context = makeContext();
    assert.equal(context.references.length, 2);
    assert.deepEqual(context.references.map(reference => ({
        id: reference.referenceId,
        label: reference.capsuleLabel,
        node: reference.sourceNodeId,
        connection: reference.sourceConnectionId,
        uploadIndex: reference.uploadIndex
    })), [
        { id: 'ref-1', label: '图一', node: 'source-a', connection: 'connection-a', uploadIndex: 0 },
        { id: 'ref-2', label: '图二', node: 'source-b', connection: 'connection-b', uploadIndex: 1 }
    ]);
    assert.equal(context.references[0].mentionSpans[0].start, 2);
    assert.equal(context.references[1].generationHistory.parentNodeId, 'older-generator');
});

test('buildReferenceContext: 节点自身素材不会借用外部连接身份', () => {
    const context = pipeline.buildReferenceContext({
        targetNodeId: 'generator',
        originalPrompt: '编辑图片',
        promptWithReferenceTokens: '编辑图片',
        sourceReferences: [
            { filePath: 'C:/refs/self.png' },
            { filePath: 'C:/refs/external.png' }
        ],
        inputContext: [{
            connectionId: 'external-connection',
            connectionIndex: 0,
            sourceNodeId: 'external-node',
            values: ['local-res://' + encodeURIComponent('C:/refs/external.png')]
        }]
    });

    assert.equal(context.references[0].sourceConnectionId, null);
    assert.equal(context.references[0].sourceNodeId, 'generator');
    assert.equal(context.references[1].sourceConnectionId, 'external-connection');
    assert.equal(context.references[1].sourceNodeId, 'external-node');
});

test('extractDeterministicSignals: 只输出事实，不推断参考图职责和普通坐标', () => {
    const signals = pipeline.extractDeterministicSignals(makeContext());
    assert.deepEqual(signals.referenceBindings.map(binding => binding.referenceId), ['ref-1', 'ref-2']);
    assert.deepEqual(signals.explicitSpatialSignals, []);
    assert.equal(JSON.stringify(signals).includes('提供比例'), false);
    assert.equal(JSON.stringify(signals).includes('"x"'), false);
});

test('validateEditPlan: 接受有效迁移计划并拒绝未知引用', () => {
    const context = makeContext();
    const valid = pipeline.validateEditPlan({
        schemaVersion: '1.0',
        task: 'multi_reference_edit',
        targetReferenceId: 'ref-2',
        referenceContributions: [
            { referenceId: 'ref-1', useFor: ['比例'], confidence: 0.9 },
            { referenceId: 'ref-2', useFor: ['场景'], confidence: 0.95 }
        ],
        operations: [{
            type: 'transfer_relation',
            sourceReferenceIds: ['ref-1'],
            targetReferenceId: 'ref-2',
            attribute: 'relative_scale',
            description: '把图一的相对比例应用到图二',
            evidence: [{ type: 'reference_text_context', referenceId: 'ref-1', text: '使用图一的比例' }],
            confidence: 0.9
        }],
        preserve: ['ref-2.scene'],
        change: ['ref-2.subject_scale'],
        exclude: [],
        uncertainties: [],
        overallConfidence: 0.9
    }, context);
    assert.equal(valid.valid, true);

    const invalid = pipeline.validateEditPlan({
        schemaVersion: '1.0',
        task: 'multi_reference_edit',
        targetReferenceId: 'ref-9',
        referenceContributions: [],
        operations: [{ sourceReferenceIds: ['ref-8'], attribute: 'style' }],
        preserve: [],
        change: [],
        exclude: [],
        uncertainties: []
    }, context);
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.some(error => error.code === 'UNKNOWN_REFERENCE'));
});

test('validateEditPlan: 阻止同一属性同时保留和修改', () => {
    const result = pipeline.validateEditPlan({
        schemaVersion: '1.0',
        task: 'multi_reference_edit',
        targetReferenceId: 'ref-2',
        referenceContributions: [],
        operations: [{
            type: 'transfer_relation',
            sourceReferenceIds: ['ref-1'],
            attribute: 'scale',
            description: '迁移比例',
            evidence: [{ type: 'explicit_user_text', text: '迁移比例' }]
        }],
        preserve: ['ref-2.robot.scale'],
        change: ['ref-2.robot.scale'],
        exclude: [],
        uncertainties: []
    }, makeContext());
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(error => error.code === 'PRESERVE_CHANGE_CONFLICT'));
});

test('buildPlannerCacheKey: 引用顺序和模型变化都会失效', () => {
    const context = makeContext();
    const base = pipeline.buildPlannerCacheKey(context, { id: 'text', model: 'gpt-5.5' });
    const reordered = { ...context, references: [...context.references].reverse() };
    assert.notEqual(base, pipeline.buildPlannerCacheKey(reordered, { id: 'text', model: 'gpt-5.5' }));
    assert.notEqual(base, pipeline.buildPlannerCacheKey(context, { id: 'text', model: 'another-model' }));
});

test('compileImageProviderRequest: 确定性编译目标图、参考职责和强约束', () => {
    const context = makeContext();
    const editPlan = {
        schemaVersion: '1.0',
        task: 'multi_reference_edit',
        targetReferenceId: 'ref-2',
        referenceContributions: [
            {
                referenceId: 'ref-1',
                useFor: '机器人与人的相对比例',
                ignoreFor: '背景和人物服装',
                preserve: '机器人明显低于成年人',
                confidence: 0.98
            },
            {
                referenceId: 'ref-2',
                useFor: '银行场景和整体构图',
                preserve: 'BANK 门头与人物动作',
                confidence: 0.97
            }
        ],
        operations: [{
            type: 'adjust_relative_scale',
            sourceReferenceIds: ['ref-1'],
            targetReferenceId: 'ref-2',
            attribute: 'robot_to_human_proportion',
            description: '机器人应明显低于成年男性',
            measurement: { ratio: '0.7-0.8', basis: 'adult_human_height' },
            evidence: [{ type: 'explicit_user_text', text: '使用图一的比例' }],
            confidence: 0.99
        }],
        preserve: ['图二的银行入口和构图'],
        change: ['图二中机器人的相对高度'],
        exclude: ['不要采用图一的白色背景'],
        uncertainties: [],
        overallConfidence: 0.97
    };
    const options = { editPlan, context, provider: { id: 'image-api', model: 'gpt-image-2' } };
    const first = pipeline.compileImageProviderRequest(options);
    const second = pipeline.compileImageProviderRequest(options);

    assert.deepEqual(first, second);
    assert.match(first.prompt, /以第2张参考图（图二）为唯一基础画面/);
    assert.match(first.prompt, /机器人应明显低于成年男性/);
    assert.match(first.prompt, /可执行约束：ratio=0.7-0.8；basis=adult_human_height/);
    assert.match(first.prompt, /不要采用图一的白色背景/);
    assert.deepEqual(first.images.map(image => image.referenceId), ['ref-1', 'ref-2']);
    assert.equal(first.compilerVersion, 'openai-image.v1');
});

test('createGenerationTrace: 保存计划、校验和回退结果', () => {
    const context = makeContext();
    const validation = pipeline.validateEditPlan({
        schemaVersion: '1.0',
        task: 'multi_reference_fusion',
        targetReferenceId: null,
        referenceContributions: [],
        operations: [{
            type: 'fuse_references',
            sourceReferenceIds: ['ref-1', 'ref-2'],
            attribute: 'visual_identity',
            description: '融合两张参考图',
            evidence: [{ type: 'explicit_user_text', text: '融合参考图' }]
        }],
        preserve: [],
        change: ['new_image'],
        exclude: [],
        uncertainties: [],
        overallConfidence: 0.8
    }, context);
    const trace = pipeline.createGenerationTrace({
        context,
        signals: pipeline.extractDeterministicSignals(context),
        planner: { enabled: true, mode: 'shadow' },
        validation,
        fallback: { used: true, reason: 'SHADOW_MODE' },
        generation: { status: 'success', model: 'gpt-image-2' }
    });
    assert.match(trace.traceId, /\S+/);
    assert.equal(trace.editPlan.task, 'multi_reference_fusion');
    assert.equal(trace.fallback.reason, 'SHADOW_MODE');
});
