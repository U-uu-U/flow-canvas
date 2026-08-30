const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    appendMidjourneyParameters,
    buildMidjourneyCompatibilityPrompt,
    buildImageEditMultipart,
    buildOpenAiImageRequestBody,
    buildImageTaskEndpoint,
    buildMidjourneyImaginePayload,
    buildMidjourneySubmitEndpoint,
    buildMidjourneyTaskEndpoint,
    collectImageEditInputs,
    describeGeneratedMedia,
    getGeneratedImageData,
    getGeneratedImageDataList,
    getImageTaskId,
    getImageTaskIdFromLocation,
    imageHttpErrorMessage,
    imageTaskErrorMessage,
    imageTaskRetryDelayMs,
    isAllVendorsFailedImageResponse,
    isCompletedImageTaskStatus,
    isFailedImageTaskStatus,
    isImageTaskPayload,
    isMidjourneyImagineModel,
    isMidjourneyImageModel,
    isNativeMidjourneyEndpoint,
    isRetryableImageHttpStatus,
    isRetryableImageNetworkError,
    midjourneyGridRegions,
    parseImageApiResponseText,
    prependMidjourneyImagePrompts,
    shouldUseNativeMidjourneyRoute
} = require('./openai-image-request');
const {
    buildMiniMaxH3RequestBody,
    buildMiniMaxH3TaskEndpoint,
    buildVideoGenerationEndpoint,
    isMiniMaxH3NativeEndpoint,
    isMiniMaxH3PerSecondEndpoint,
    isMiniMaxH3UnavailableResponse
} = require('./video-provider-adapters');

test('MiniMax H3 视频协议: 中转地址不被改写，显式任务中心按 ID 查询', () => {
    const endpoint = buildVideoGenerationEndpoint(
        'https://art.ravenhash.org/v1',
        'minimax-h3'
    );
    assert.equal(
        endpoint,
        'https://art.ravenhash.org/v1/video/generations'
    );
    const relayEndpointWithLegacyOption = buildVideoGenerationEndpoint(
        'https://art.ravenhash.org/v1',
        'minimax-h3',
        { preferMiniMaxH3Native: true }
    );
    assert.equal(
        relayEndpointWithLegacyOption,
        'https://art.ravenhash.org/v1/video/generations'
    );
    const nativeEndpoint = 'https://zcbservice.aizfw.cn/kyyReactApiServer/v2/model-center/tasks';
    assert.equal(
        buildMiniMaxH3TaskEndpoint(nativeEndpoint, 'mcp_example_123456'),
        'https://zcbservice.aizfw.cn/kyyReactApiServer/v2/model-center/tasks/mcp_example_123456'
    );
    assert.equal(
        buildVideoGenerationEndpoint('https://art.ravenhash.org/v1', 'seedance-2.0'),
        'https://art.ravenhash.org/v1/video/generations'
    );
    assert.equal(isMiniMaxH3NativeEndpoint(nativeEndpoint), true);
    assert.equal(isMiniMaxH3NativeEndpoint('https://art.ravenhash.org/v1'), false);
    assert.equal(
        buildVideoGenerationEndpoint(nativeEndpoint, 'minimax-h3'),
        nativeEndpoint
    );
    assert.equal(isMiniMaxH3UnavailableResponse(400, '{"error":{"message":"模型不可用"}}'), true);
    assert.equal(isMiniMaxH3UnavailableResponse(401, '模型不可用'), false);
});

test('MiniMax H3 中转请求体: 使用 RavenHash 统一视频协议', () => {
    const references = ['https://example.com/1.png', 'https://example.com/2.png'];
    const relayBody = buildMiniMaxH3RequestBody({
        endpoint: 'https://art.ravenhash.org/v1/video/generations',
        model: 'minimax-h3',
        prompt: 'cinematic movement',
        duration: 4,
        aspectRatio: '16:9',
        resolution: '2k',
        referenceImages: references,
        referenceAudios: ['https://example.com/voice.mp3']
    });
    assert.deepEqual(relayBody, {
        model: 'minimax-h3',
        prompt: 'cinematic movement',
        resolution: '2k',
        duration: 4,
        aspect_ratio: '16:9',
        first_image: references[0],
        last_image: references[1],
        reference_audios: ['https://example.com/voice.mp3']
    });

    assert.deepEqual(buildMiniMaxH3RequestBody({
        endpoint: 'https://art.ravenhash.org/v1/video/generations',
        model: 'minimax-h3',
        prompt: 'animate the reference',
        duration: 5,
        aspectRatio: '9:16',
        resolution: '2k',
        referenceImages: ['https://example.com/frame.png']
    }), {
        model: 'minimax-h3',
        prompt: 'animate the reference',
        resolution: '2k',
        duration: 5,
        aspect_ratio: '9:16',
        first_image: 'https://example.com/frame.png'
    });
});

test('MiniMax H3 按秒直连请求体: 自动选择工作流并编译上游尺寸', () => {
    const endpoint = 'https://video.example.com/v1/videos';
    assert.equal(isMiniMaxH3PerSecondEndpoint(endpoint), true);
    assert.equal(buildVideoGenerationEndpoint(endpoint, 'minimax-h3'), endpoint);
    assert.deepEqual(buildMiniMaxH3RequestBody({
        endpoint,
        model: 'minimax-h3',
        prompt: 'text only',
        duration: 10,
        aspectRatio: '16:9',
        resolution: '1080p'
    }), {
        model: 'minimax-h3',
        prompt: 'text only',
        seconds: 10,
        workflow_id: 'text-to-video',
        size: '1920x1088'
    });

    assert.deepEqual(buildMiniMaxH3RequestBody({
        endpoint,
        model: 'minimax-h3',
        prompt: 'animate the reference',
        duration: 5,
        aspectRatio: '9:16',
        resolution: '2k',
        referenceImages: ['https://example.com/frame.png']
    }), {
        model: 'minimax-h3',
        prompt: 'animate the reference',
        seconds: 5,
        workflow_id: 'cf-fl2v',
        size: '2K',
        aspect_ratio: '9:16',
        images: ['https://example.com/frame.png']
    });
});

test('MiniMax H3 直连请求体: 保留 GlobalAIOPC C1 兼容协议', () => {
    const nativeBody = buildMiniMaxH3RequestBody({
        endpoint: 'https://zcbservice.aizfw.cn/kyyReactApiServer/v2/model-center/tasks',
        model: 'minimax-h3',
        prompt: 'cinematic movement',
        duration: 15
    });
    assert.equal(nativeBody.model, 'MiniMax-H3-c1');
    assert.equal(nativeBody.resolution, '720p');
    assert.throws(
        () => buildMiniMaxH3RequestBody({ model: 'minimax-h3', prompt: 'x', duration: 3 }),
        /4 到 15 秒/
    );
    assert.throws(
        () => buildMiniMaxH3RequestBody({ model: 'minimax-h3', prompt: 'x'.repeat(5001), duration: 4 }),
        /5000 个字符/
    );
});

test('生成媒体识别: 根据文件签名和地址区分图片与视频', () => {
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);

    assert.deepEqual(describeGeneratedMedia(mp4), { mediaType: 'video', extension: '.mp4' });
    assert.deepEqual(describeGeneratedMedia(webm), { mediaType: 'video', extension: '.webm' });
    assert.deepEqual(
        describeGeneratedMedia(Buffer.from('unknown'), {}, { source: 'https://cdn.example/result.mov?token=1' }),
        { mediaType: 'video', extension: '.mov' }
    );
    assert.deepEqual(
        describeGeneratedMedia(Buffer.from('png'), { format: 'png' }),
        { mediaType: 'image', extension: '.png' }
    );
});

test('Image 2 请求体: 保留返回格式、历史和流式配置', () => {
    assert.deepEqual(buildOpenAiImageRequestBody({
        model: 'gpt-image-2',
        prompt: 'a red chair',
        size: '1536x1024',
        responseFormat: 'b64_json',
        options: { quality: 'medium', historyDisabled: false, stream: true }
    }), {
        model: 'gpt-image-2',
        prompt: 'a red chair',
        n: 1,
        quality: 'medium',
        response_format: 'b64_json',
        history_disabled: false,
        stream: true,
        size: '1536x1024'
    });
});

test('Image 2 请求体: 默认值遵循上游协议并限制生成数量', () => {
    assert.deepEqual(buildOpenAiImageRequestBody({
        model: 'gpt-image-2',
        prompt: 'a clear product photo',
        n: 99
    }), {
        model: 'gpt-image-2',
        prompt: 'a clear product photo',
        n: 8,
        quality: 'high',
        response_format: 'b64_json',
        history_disabled: true,
        stream: false
    });
});

test('parseImageApiResponseText: 兼容标准 SSE 事件块并合并最终状态', () => {
    const payload = parseImageApiResponseText([
        'event: image',
        'data: {"data":[{"b64_json":"encoded-image"}]}',
        '',
        'event: done',
        'data: {"status":"completed"}',
        '',
        'data: [DONE]'
    ].join('\n'), 'text/event-stream');

    assert.equal(payload.status, 'completed');
    assert.deepEqual(getGeneratedImageDataList(payload), [{ b64_json: 'encoded-image' }]);
});

test('buildImageEditMultipart: 多张参考图使用 image[] multipart 字段并保持顺序', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-canvas-image-edit-'));
    const firstPath = path.join(tempDir, 'first.png');
    const secondPath = path.join(tempDir, 'second.webp');
    const firstBytes = Buffer.from('first-image-bytes');
    const secondBytes = Buffer.from('second-image-bytes');
    fs.writeFileSync(firstPath, firstBytes);
    fs.writeFileSync(secondPath, secondBytes);

    try {
        const images = collectImageEditInputs([
            { filePath: firstPath },
            { filePath: secondPath }
        ]);
        const multipart = buildImageEditMultipart({
            model: 'gpt-image-2',
            prompt: 'use image one and image two',
            n: 1,
            response_format: 'url',
            stream: true
        }, images);
        const payloadText = multipart.body.toString('latin1');

        assert.match(multipart.contentType, /^multipart\/form-data; boundary=----flow-canvas-/);
        assert.equal((payloadText.match(/name="image\[\]"/g) || []).length, 2);
        assert.match(payloadText, /filename="first\.png"/);
        assert.match(payloadText, /filename="second\.webp"/);
        assert.match(payloadText, /name="response_format"[\s\S]*?\r\n\r\nurl/);
        assert.match(payloadText, /name="stream"[\s\S]*?\r\n\r\ntrue/);
        assert.equal(payloadText.includes('name="history_disabled"'), false);
        assert.ok(multipart.body.indexOf(firstBytes) < multipart.body.indexOf(secondBytes));
        assert.equal(payloadText.includes('image_url'), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('buildImageEditMultipart: 单张参考图使用 OpenAI 兼容的 image 字段', () => {
    const multipart = buildImageEditMultipart({ prompt: 'edit' }, [{
        fileName: 'single.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.from('single-image')
    }]);
    const payloadText = multipart.body.toString('latin1');

    assert.match(payloadText, /name="image"; filename="single\.jpg"/);
    assert.equal(payloadText.includes('name="image[]"'), false);
});

test('异步图片任务: 识别 202 任务信封并提取任务 ID', () => {
    const payload = {
        id: 'task_01JTEST',
        object: 'image.generation.task',
        status: 'queued',
        progress: '0%'
    };

    assert.equal(getImageTaskId(payload), 'task_01JTEST');
    assert.equal(isImageTaskPayload(payload, 202), true);
    assert.equal(getGeneratedImageData(payload), null);
});

test('异步图片任务: 兼容 output 中的任务信封', () => {
    const payload = {
        output: {
            id: 'task_01JOUTPUT',
            object: 'image.generation.task',
            status: 'queued'
        }
    };
    assert.equal(getImageTaskId(payload), 'task_01JOUTPUT');
    assert.equal(isImageTaskPayload(payload, 200), true);
});

test('异步图片任务: 识别没有 status 的 Image 2 generation 信封', () => {
    const payload = {
        id: 'task_01JIMAGE2_NOSTATUS',
        object: 'image.generation'
    };

    assert.equal(getImageTaskId(payload), 'task_01JIMAGE2_NOSTATUS');
    assert.equal(isImageTaskPayload(payload, 200), true);
});

test('异步图片任务: 从 completed.result.data 提取最终图片', () => {
    const payload = {
        id: 'task_01JTEST',
        status: 'completed',
        result: {
            created: 1760000012,
            data: [{ url: 'https://cdn.example/image.png' }]
        }
    };

    assert.equal(isCompletedImageTaskStatus(payload.status), true);
    assert.deepEqual(getGeneratedImageData(payload), { url: 'https://cdn.example/image.png' });
});

test('异步图片任务: 规范化失败状态和错误信息', () => {
    const payload = {
        status: 'failed',
        error: { message: 'image generation failed', code: 'bad_response_status_code' }
    };

    assert.equal(isFailedImageTaskStatus(payload.status), true);
    assert.equal(imageTaskErrorMessage(payload), 'image generation failed');
});

test('异步图片任务: Location 优先且编辑任务回退到 generations 查询路由', () => {
    assert.equal(
        buildImageTaskEndpoint(
            'https://ai.ravenhash.org/v1/images/generations',
            'task_01JTEST',
            '/v1/images/generations/task_01JTEST'
        ),
        'https://ai.ravenhash.org/v1/images/generations/task_01JTEST'
    );
    assert.equal(
        buildImageTaskEndpoint('https://ai.ravenhash.org/v1/images/edits', 'task_01JEDIT'),
        'https://ai.ravenhash.org/v1/images/generations/task_01JEDIT'
    );
});

test('异步图片任务: 不向跨域 Location 发送 API Key 并遵循 Retry-After', () => {
    assert.equal(
        buildImageTaskEndpoint(
            'https://ai.ravenhash.org/v1/images/generations',
            'task_safe',
            'https://unexpected.example/tasks/task_safe'
        ),
        'https://ai.ravenhash.org/v1/images/generations/task_safe'
    );
    assert.equal(imageTaskRetryDelayMs('2'), 2000);
    assert.equal(imageTaskRetryDelayMs('999'), 10000);
});

test('Midjourney 任务: 识别 result 任务 ID 并构建原生查询回退', () => {
    const payload = {
        code: 1,
        description: 'Submit success',
        result: '1730621718151844'
    };

    assert.equal(getImageTaskId(payload, 202), '1730621718151844');
    assert.equal(isImageTaskPayload(payload, 200), true);
    assert.equal(isMidjourneyImageModel('mj_imagine'), true);
    assert.equal(
        buildMidjourneySubmitEndpoint('https://ai.ravenhash.org/v1'),
        'https://ai.ravenhash.org/mj/submit/imagine'
    );
    assert.equal(
        buildMidjourneyTaskEndpoint('https://ai.ravenhash.org/v1/images/generations', payload.result),
        'https://ai.ravenhash.org/mj/task/1730621718151844/fetch'
    );
});

test('Midjourney 路由: NewAPI 兼容地址不会被模型名强制改为原生端点', () => {
    assert.equal(isNativeMidjourneyEndpoint('https://ai.ravenhash.org/v1'), false);
    assert.equal(isNativeMidjourneyEndpoint('https://ai.ravenhash.org/v1/images/generations'), false);
    assert.equal(shouldUseNativeMidjourneyRoute('mj_imagine', 'https://ai.ravenhash.org/v1'), false);

    assert.equal(isNativeMidjourneyEndpoint('https://ai.ravenhash.org/mj'), true);
    assert.equal(isNativeMidjourneyEndpoint('https://ai.ravenhash.org/mj/submit/imagine'), true);
    assert.equal(
        shouldUseNativeMidjourneyRoute('mj_imagine', 'https://ai.ravenhash.org/mj/submit/imagine'),
        true
    );
    assert.equal(
        shouldUseNativeMidjourneyRoute('gpt-image-2', 'https://ai.ravenhash.org/mj/submit/imagine'),
        false
    );
});

test('Midjourney 任务: 原生请求携带参考图并由图片尺寸补充画幅比例', () => {
    const payload = buildMidjourneyImaginePayload('ancient city', [{
        mimeType: 'image/png',
        buffer: Buffer.from('reference')
    }], '3840x2160');

    assert.equal(payload.prompt, 'ancient city --ar 16:9');
    assert.equal(payload.botType, 'MID_JOURNEY');
    assert.deepEqual(payload.base64Array, [
        `data:image/png;base64,${Buffer.from('reference').toString('base64')}`
    ]);
    assert.equal(buildMidjourneyImaginePayload('cat --ar 1:1', [], '3840x2160').prompt, 'cat --ar 1:1');
});

test('Midjourney 参数: 编译模型专属参数并尊重提示词内的显式设置', () => {
    assert.equal(
        appendMidjourneyParameters('editorial portrait', {
            ratio: '3:2',
            version: '8.2',
            raw: true,
            stylize: 250,
            chaos: 20,
            weird: 400,
            quality: 2,
            definition: 'hd',
            negativePrompt: 'text, watermark'
        }),
        'editorial portrait --ar 3:2 --v 8.2 --raw --s 250 --c 20 --w 400 --q 2 --hd --no text, watermark'
    );
    assert.equal(
        appendMidjourneyParameters('cat --ar 1:1 --s 50', { ratio: '16:9', stylize: 800 }),
        'cat --ar 1:1 --s 50'
    );
    assert.equal(appendMidjourneyParameters('anime city', { version: 'niji-7' }), 'anime city --niji 7');
    assert.equal(
        appendMidjourneyParameters('documentary scene', { version: '7', definition: 'hd' }),
        'documentary scene --v 7'
    );
    assert.equal(
        appendMidjourneyParameters('product portrait', {
            version: '7',
            raw: true,
            quality: 4,
            imageWeight: 3,
            hasImagePrompt: true,
            styleReference: '123456 789012',
            styleWeight: 1000,
            styleVersion: 6,
            profile: 'profile-1',
            seed: 4294967295,
            tile: true,
            repeat: 4,
            speed: 'turbo',
            visibility: 'stealth'
        }),
        'product portrait --v 7 --raw --q 4 --iw 3 --sref 123456 789012 --sw 1000 --sv 6 --p profile-1 --seed 4294967295 --tile --r 4 --turbo --stealth'
    );
    assert.equal(
        appendMidjourneyParameters('character portrait', {
            version: '8.2',
            quality: 4,
            omniReference: 'https://example.test/person.png',
            omniWeight: 1000,
            draft: true,
            speed: 'fast'
        }),
        'character portrait --v 7 --oref https://example.test/person.png --ow 1000'
    );
});

test('Midjourney 兼容回退: 仅保留提示词正文与画幅比例', () => {
    assert.equal(
        buildMidjourneyCompatibilityPrompt(
            'editorial robot --v 7 --raw --s 1000 --c 100 --w 3000 --q 4 --seed 4294967295 --r 4 --turbo',
            { ratio: '16:9' },
            '1024x1024'
        ),
        'editorial robot --ar 16:9'
    );
    assert.equal(
        buildMidjourneyCompatibilityPrompt('editorial robot --ar 3:2 --v 8.2 --hd', {}, '1024x1024'),
        'editorial robot --ar 3:2'
    );
    assert.equal(
        buildMidjourneyCompatibilityPrompt('editorial robot', {}, '1536x1024'),
        'editorial robot --ar 3:2'
    );
});

test('Midjourney 图片提示: 将公开参考图 URL 去重后放在文字提示词前面', () => {
    assert.equal(
        prependMidjourneyImagePrompts('editorial robot --ar 3:2', [
            'https://assets.example/first.png',
            'invalid-local-path',
            'https://assets.example/second.jpg',
            'https://assets.example/first.png'
        ]),
        'https://assets.example/first.png https://assets.example/second.jpg editorial robot --ar 3:2'
    );
    assert.equal(prependMidjourneyImagePrompts('editorial robot', []), 'editorial robot');
});

test('Midjourney 四宫格: 保持像素完整并按 U1 U2 U3 U4 顺序切分', () => {
    assert.deepEqual(midjourneyGridRegions(2049, 1025), [
        { left: 0, top: 0, width: 1024, height: 512 },
        { left: 1024, top: 0, width: 1025, height: 512 },
        { left: 0, top: 512, width: 1024, height: 513 },
        { left: 1024, top: 512, width: 1025, height: 513 }
    ]);
    assert.deepEqual(midjourneyGridRegions(1, 100), []);
});

test('Midjourney 结果: 保留 API 返回的所有独立图片', () => {
    const images = getGeneratedImageDataList({ data: [{ url: 'one' }, { url: 'two' }] });
    assert.equal(images.length, 2);
    assert.equal(getGeneratedImageData({ data: images }).url, 'one');
    assert.equal(isMidjourneyImagineModel('mj_imagine'), true);
    assert.equal(isMidjourneyImagineModel('mj_upscale'), false);
});

test('Image 2 结果: 兼容对象 data、output URL 和 Responses 风格 Base64', () => {
    const base64 = 'A'.repeat(600);
    const images = getGeneratedImageDataList({
        data: { images: [{ image_url: { url: 'https://cdn.example/one.png' } }] },
        output: [
            { type: 'image_generation_call', result: base64 },
            { type: 'image_url', output_url: 'https://cdn.example/two.png' }
        ]
    });

    assert.equal(images.length, 3);
    assert.equal(images[0].url, 'https://cdn.example/one.png');
    assert.equal(images[1].b64_json, base64);
    assert.equal(images[2].url, 'https://cdn.example/two.png');
});

test('生成媒体结果: 兼容上游使用 video_url 返回视频', () => {
    assert.deepEqual(getGeneratedImageDataList({
        output: [{ video_url: 'https://cdn.example/generated.mp4' }]
    }), [{
        video_url: 'https://cdn.example/generated.mp4',
        url: 'https://cdn.example/generated.mp4'
    }]);
});

test('Image 2 结果: 保留 data/output 数组中的相对图片地址', () => {
    const images = getGeneratedImageDataList({
        data: ['/v1/files/image-one', 'images/image-two.png']
    });
    assert.deepEqual(images, [
        { url: '/v1/files/image-one' },
        { url: 'images/image-two.png' }
    ]);
});

test('Image 2 结果: 兼容中转站把结果 JSON 再包成 data 字符串', () => {
    const images = getGeneratedImageDataList({
        data: JSON.stringify({
            images: [{ url: '/v1/files/image-two.png' }]
        })
    });
    assert.deepEqual(images, [{ url: '/v1/files/image-two.png' }]);
});

test('Image 2 结果: 不把任务 ID、状态和普通文本误当成图片', () => {
    const images = getGeneratedImageDataList({
        id: 'task_01JIMAGE2',
        status: 'completed',
        message: { content: [{ type: 'output_text', text: 'generation completed' }] },
        result: 'task_01JIMAGE2'
    });
    assert.deepEqual(images, []);
});

test('Image 2 结果: 解析 SSE 中分段返回的图片数据', () => {
    const payload = parseImageApiResponseText([
        'event: image_generation',
        'data: {"status":"processing"}',
        '',
        'data: {"status":"completed","output":[{"type":"image_generation_call","result":"' + 'A'.repeat(600) + '"}]}',
        '',
        'data: [DONE]'
    ].join('\n'), 'text/event-stream');

    assert.equal(payload.status, 'completed');
    assert.equal(getGeneratedImageDataList(payload).length, 1);
});

test('异步图片任务: 可从 Location 或 NewAPI 嵌套错误恢复任务 ID', () => {
    const location = '/v1/images/generations/task_01JLOCATION';
    assert.equal(getImageTaskIdFromLocation(location), 'task_01JLOCATION');
    assert.equal(getImageTaskId({ error: { message: 'bad response' } }, 202, location), 'task_01JLOCATION');
    assert.equal(getImageTaskId({
        error: {
            body: '{"id":"task_01JEMBEDDED","object":"image.generation.task","status":"queued"}'
        }
    }, 202), 'task_01JEMBEDDED');
});

test('Midjourney 任务: 将 NewAPI 上游解析失败转换为可操作的鉴权提示', () => {
    const message = imageHttpErrorMessage(400, JSON.stringify({
        code: 5,
        description: 'unmarshal_response_body_failed',
        type: 'upstream_error'
    }), { nativeMidjourney: true });

    assert.match(message, /mj-api-secret/);
    assert.match(message, /Authorization: Bearer/);
    assert.match(message, /RavenHash/);
});

test('图片请求重试: 仅重试上游临时故障并解释全部通道失败', () => {
    assert.equal(isRetryableImageHttpStatus(429), true);
    assert.equal(isRetryableImageHttpStatus(502), true);
    assert.equal(isRetryableImageHttpStatus(503), true);
    assert.equal(isRetryableImageHttpStatus(504), true);
    assert.equal(isRetryableImageHttpStatus(400), false);

    const message = imageHttpErrorMessage(503, JSON.stringify({
        error: {
            message: '生成失败，请稍后重试',
            type: 'yamlrunner_error',
            code: 'all_vendors_failed'
        }
    }), { midjourneyModel: true, attempts: 3 });

    assert.match(message, /Midjourney/);
    assert.match(message, /RavenHash/);
    assert.match(message, /已自动重试 2 次/);
    assert.doesNotMatch(message, /Image API failed/);

    const responseText = JSON.stringify({
        error: {
            message: '生成失败，请稍后重试',
            type: 'yamlrunner_error',
            code: 'all_vendors_failed'
        }
    });
    assert.equal(isAllVendorsFailedImageResponse(503, responseText), true);
    assert.equal(isAllVendorsFailedImageResponse(500, responseText), false);

    const fallbackMessage = imageHttpErrorMessage(503, responseText, {
        midjourneyModel: true,
        compatibilityFallbackUsed: true
    });
    assert.match(fallbackMessage, /完整参数/);
    assert.match(fallbackMessage, /兼容参数/);
});

test('图片请求重试: 识别 Electron 连接异常并排除永久请求错误', () => {
    assert.equal(isRetryableImageNetworkError(new Error('net::ERR_CONNECTION_TIMED_OUT')), true);
    assert.equal(isRetryableImageNetworkError(new Error('net::ERR_CONNECTION_CLOSED')), true);
    assert.equal(isRetryableImageNetworkError(new Error('socket hang up')), true);
    assert.equal(isRetryableImageNetworkError({
        message: 'fetch failed',
        cause: { code: 'ECONNRESET' }
    }), true);
    assert.equal(isRetryableImageNetworkError({ name: 'AbortError', message: 'This operation was aborted' }), true);
    assert.equal(isRetryableImageNetworkError(new Error('Invalid URL')), false);
    assert.equal(isRetryableImageNetworkError(new Error('HTTP 400 invalid_request_error')), false);
});
