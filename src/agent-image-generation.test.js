import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildAgentImageCompilationMessages,
    normalizeAgentGenerationSource,
    parseAgentImageCompilationResponse
} from './agent-image-generation.js';

test('normalizes generation context and removes credential-like parameters', () => {
    const source = normalizeAgentGenerationSource({
        nodeId: 'image-1',
        nodeType: 'image',
        originalPrompt: '保留主体',
        upstreamPrompts: ['改成夜景'],
        effectivePrompt: '保留主体\n\n改成夜景',
        parameters: {
            width: 2048,
            model: 'gpt-image-2',
            apiKey: 'must-not-leak',
            nested: { accessToken: 'must-not-leak', quality: 'high' }
        }
    });

    assert.equal(source.prompt, '保留主体\n\n改成夜景');
    assert.equal(source.parameters.width, 2048);
    assert.equal(source.parameters.apiKey, undefined);
    assert.deepEqual(source.parameters.nested, { quality: 'high' });
});

test('builds a fixed-parameter multimodal image compilation request', () => {
    const messages = buildAgentImageCompilationMessages({
        source: {
            nodeId: 'image-1',
            nodeType: 'image',
            title: '产品图',
            originalPrompt: '白色背景',
            upstreamPrompts: ['保留瓶身文字'],
            effectivePrompt: '白色背景\n\n保留瓶身文字',
            model: 'gpt-image-2',
            parameters: { ratio: '1:1', quality: 'high' }
        },
        instruction: '改成棚拍光线'
    });

    assert.equal(messages.length, 2);
    assert.match(messages[0].content, /只返回一个 JSON 对象/);
    assert.match(messages[1].content, /保留瓶身文字/);
    assert.match(messages[1].content, /棚拍光线/);
    assert.match(messages[1].content, /"ratio": "1:1"/);
});

test('parses structured Agent output and safely falls back to plain text', () => {
    assert.deepEqual(
        parseAgentImageCompilationResponse('```json\n{"prompt":"最终提示词","summary":"保留构图"}\n```'),
        {
            prompt: '最终提示词',
            summary: '保留构图',
            rawText: '```json\n{"prompt":"最终提示词","summary":"保留构图"}\n```',
            structured: true
        }
    );
    assert.equal(parseAgentImageCompilationResponse('直接可用的提示词').prompt, '直接可用的提示词');
    assert.equal(parseAgentImageCompilationResponse('{bad json}', '原始提示词').prompt, '原始提示词');
});
