const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    appendMidjourneyParameters,
    buildImageEditMultipart,
    buildImageTaskEndpoint,
    buildMidjourneyImaginePayload,
    buildMidjourneySubmitEndpoint,
    buildMidjourneyTaskEndpoint,
    collectImageEditInputs,
    getGeneratedImageData,
    getGeneratedImageDataList,
    getImageTaskId,
    getImageTaskIdFromLocation,
    imageHttpErrorMessage,
    imageTaskErrorMessage,
    imageTaskRetryDelayMs,
    isCompletedImageTaskStatus,
    isFailedImageTaskStatus,
    isImageTaskPayload,
    isMidjourneyImagineModel,
    isMidjourneyImageModel,
    isNativeMidjourneyEndpoint,
    midjourneyGridRegions,
    shouldUseNativeMidjourneyRoute
} = require('./openai-image-request');

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
            n: 1
        }, images);
        const payloadText = multipart.body.toString('latin1');

        assert.match(multipart.contentType, /^multipart\/form-data; boundary=----flow-canvas-/);
        assert.equal((payloadText.match(/name="image\[\]"/g) || []).length, 2);
        assert.match(payloadText, /filename="first\.png"/);
        assert.match(payloadText, /filename="second\.webp"/);
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
