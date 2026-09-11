const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const name = value => `t_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 60)}`;
const tool = (id, internal, args) => ({ id, type: 'function', function: { name: name(internal), arguments: JSON.stringify(args) } });
async function poll(read, test, timeout = 30000) {
    const deadline = Date.now() + timeout;
    let value;
    while (Date.now() < deadline) {
        value = await read();
        if (test(value)) return value;
        await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error(`Smoke timeout: ${JSON.stringify(value)}`);
}

(async () => {
    const live = process.env.FLOW_CANVAS_SMOKE_LIVE === '1';
    const liveVideo = process.env.FLOW_CANVAS_SMOKE_LIVE_VIDEO === '1';
    const multiReference = process.env.FLOW_CANVAS_SMOKE_MULTI_REFERENCE === '1' && !live;
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-agent-smoke-'));
    if (live) await fs.copyFile(path.join(process.env.APPDATA, 'flow-canvas', 'Local State'), path.join(profile, 'Local State'));
    const assets = path.join(profile, 'assets');
    await fs.mkdir(path.join(profile, 'data'), { recursive: true });
    await fs.mkdir(assets);
    const image = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#759da8' } }).png().toBuffer();
    const refPath = path.join(assets, 'reference.png');
    await fs.writeFile(refPath, image);
    const secondImage = multiReference
        ? await sharp({ create: { width: 160, height: 240, channels: 3, background: '#a85c39' } }).png().toBuffer() : null;
    const secondRefPath = path.join(assets, 'second-reference.png');
    if (multiReference) await fs.writeFile(secondRefPath, secondImage);
    const receivedImages = [];
    const videoPath = path.join(assets, 'clip.mp4');
    const videoTest = process.env.FLOW_CANVAS_SMOKE_VIDEO === '1';
    if (videoTest) {
        const encoded = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath], { encoding: 'utf8' });
        if (encoded.status !== 0) throw new Error(encoded.stderr || 'ffmpeg is required for the optional video fixture');
    }
    let submissions = 0, electronApp;
    const requests = [];
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* Image edit multipart. */ }
        res.setHeader('content-type', 'application/json');
        if (req.url.includes('/images/')) {
            submissions++;
            if (multiReference) {
                const request = new Request('http://localhost' + req.url, { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) });
                const form = await request.formData();
                for (const file of form.getAll('image[]')) receivedImages.push(Buffer.from(await file.arrayBuffer()));
            }
            res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] })); return;
        }
        requests.push(body);
        const outputs = (body.messages || []).filter(m => m.role === 'tool').map(m => { try { return JSON.parse(m.content); } catch { return {}; } });
        let message = { role: 'assistant', content: '审阅通过：已检查画面，声音与完整运动未验证。' };
        if (body.tools?.length) {
            const savingRun = (body.messages || []).find(m => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('SAVE:'))?.content.slice(5);
            if (savingRun) {
                if (!outputs.length) message = { role: 'assistant', content: '', tool_calls: [tool('save-workflow', 'flow_canvas.skill.save', { runId: savingRun, name: '验收流程' })] };
                else if (!outputs.some(output => output.nodeIds)) message = { role: 'assistant', content: '', tool_calls: [tool('instantiate', 'flow_canvas.skill.instantiate', {
                    skillId: outputs.find(output => output.workflow).workflow.id, referenceNodeIds: ['reference']
                })] };
                else message = { role: 'assistant', content: '流程已保存并用新引用实例化，尚未提交新的生成。' };
            } else if (!outputs.length) message = { role: 'assistant', content: '先读取画布和模型。', tool_calls: [
                tool('snapshot', 'flow_canvas.board.get_snapshot', { scope: 'project' }),
                tool('models', 'flow_canvas.model.list', {}),
                tool('inspect', 'flow_canvas.asset.read', { nodeId: 'reference' }),
                ...(videoTest ? [tool('video', 'flow_canvas.asset.read', { nodeId: 'clip', time: 0.5 })] : [])
            ] };
            else if (!outputs.some(output => output.document)) message = { role: 'assistant', content: '', tool_calls: [
                tool('document', 'flow_canvas.document.create', { title: '验收分镜表', templateId: 'shots',
                    rows: [{ id: 'shot-smoke', cells: { shot: '1', action: '固定镜头', duration: '5秒' }, references: [{ itemId: 'reference' }] }] })
            ] };
            else if (!outputs.some(output => output.completed)) message = { role: 'assistant', content: '已准备一张图片的生成计划。',
                tool_calls: [tool('generate', 'flow_canvas.graph.run', { nodeIds: ['generate'], summary: '保留参考图主体，生成一张图片' })] };
            else message = { role: 'assistant', content: '图片已生成并保存到原项目，已完成结果审阅。' };
        }
        res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    const providers = [{ id: 'text', name: 'Smoke Text', capability: 'text', type: 'openai', endpoint, model: 'mock-text', apiKey: 'smoke-key' },
        { id: 'image', name: 'Smoke Image', capability: 'image', type: 'openai', endpoint, model: 'gpt-image-2', apiKey: 'smoke-key' }];
    await fs.writeFile(path.join(profile, 'fixture-api.json'), JSON.stringify({ version: 1, revision: 1, providers,
        globalConfig: { textProviderId: 'text', imageProviderId: 'image', agentExecutionMode: 'auto' } }));
    const items = [{ id: 'reference', kind: 'media', mediaType: 'image', filePath: refPath, x: 100, y: 80, width: 240, height: 180 },
        { id: 'generate', kind: 'op', nodeType: 'image', title: '图片生成', config: { prompt: '保留参考图主体，改为干净背景', model: 'gpt-image-2', providerId: 'image', count: 1 }, x: 430, y: 80, width: 240, height: 180 }];
    const connections = [{ id: 'input', from: { nodeId: 'reference', port: 'out' }, to: { nodeId: 'generate', port: 'source' } }];
    if (multiReference) {
        items.push({ id: 'reference-2', kind: 'media', mediaType: 'image', filePath: secondRefPath, x: 100, y: 300, width: 160, height: 240 });
        connections.push({ id: 'input-2', from: { nodeId: 'reference-2', port: 'out' }, to: { nodeId: 'generate', port: 'source' } });
    }
    if (videoTest) items.push({ id: 'clip', kind: 'media', mediaType: 'video', filePath: videoPath, x: 80, y: 360, width: 240, height: 180 });
    await fs.writeFile(path.join(profile, 'data', 'board.json'), JSON.stringify({ version: 1, activeGroupId: 'smoke',
        folderGroups: [{ id: 'smoke', name: 'Agent 验收', folders: [assets], defaultSaveFolder: assets, savedItems: items, connections, boardRevision: 0 },
            { id: 'other', name: '另一个项目', folders: [], savedItems: [], connections: [], boardRevision: 0 }], items, connections,
        sidebarClosed: true, viewport: { x: 0, y: 0, scale: 1 }, mcp: { enabled: false } }));
    try {
        const launchEnv = { ...process.env, FLOW_CANVAS_SMOKE_PROFILE: profile };
        delete launchEnv.ELECTRON_RUN_AS_NODE;
        electronApp = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'agent-smoke-entry.cjs')], env: launchEnv });
        electronApp.process().stderr.on('data', chunk => process.stderr.write(chunk));
        electronApp.process().stdout.on('data', chunk => process.stdout.write(chunk));
        const page = await electronApp.firstWindow();
        await page.waitForFunction(() => window.flowCanvas?.agent && document.querySelector('#agentInput'), { timeout: 20000 });
        await page.waitForFunction(() => !document.body.classList.contains('app-startup-error'));
        if (live) console.log(await page.evaluate(async () => {
            const loaded = await window.flowCanvas.apiConfig.load();
            return { models: (loaded.config?.providers || []).map(p => ({ capability: p.capability, model: p.model, configured: !!p.apiKey })),
                textSelected: !!loaded.config?.globalConfig?.textProviderId };
        }));
        const instruction = liveVideo
            ? '这是一次单条视频工具链验收。读取画布和 reference 参考图，读取可用模型，对现有 generate 视频节点调用 graph.run 提交计划。只允许一次 sd2.5 备用路线，30秒720p，保留已有提示词和参数。确认后生成并审阅，不要再次生成，不要改用别的模型。'
            : '这是一次单张图片工具链验收。读取画布和 reference 图片，读取可用模型，然后对现有 generate 节点调用 graph.run 提交计划，只允许一张图片，不新建或修改其他生成节点。确认后生成并审阅即可，不要再次生成。';
        const run = await page.evaluate(text => window.flowCanvas.agent.start({ projectId: 'smoke', conversationId: 'smoke-conversation',
            messages: [{ role: 'user', content: text }] }), instruction);
        const pending = await poll(() => page.evaluate(id => window.flowCanvas.agent.get({ runId: id }), run.id),
            state => state.status === 'awaiting_confirmation' || ['failed', 'completed'].includes(state.status), live ? 180000 : 30000);
        assert.equal(pending.status, 'awaiting_confirmation', pending.error || pending.outputText);
        assert.equal(submissions, 0);
        assert.equal(pending.plan.steps.length, 1);
        if (liveVideo) {
            assert.equal(pending.plan.currency, 'CNY');
            assert.equal(pending.plan.estimatedCost, 6);
        } else assert.equal(pending.plan.priceKnown, false);
        await page.evaluate(async ({ id, version }) => {
            await window.flowCanvas.agent.confirm({ runId: id, planVersion: version });
            const data = await window.flowCanvas.store.load();
            data.activeGroupId = 'other'; data.items = []; data.connections = [];
            return window.flowCanvas.store.save(data);
        }, { id: run.id, version: pending.plan.version });
        const result = await poll(() => page.evaluate(id => window.flowCanvas.agent.get({ runId: id }), run.id),
            state => ['completed', 'failed', 'partial_failed'].includes(state.status), live ? 600000 : 45000);
        assert.equal(result.status, 'completed', result.error);
        if (videoTest) {
            const inspected = result.events.find(event => event.type === 'tool_result' && event.data?.result?.nodeId === 'clip')?.data.result;
            assert.ok(inspected?.frames?.length, 'The actual Electron video decoder must return frames');
            assert.equal(inspected.frames[0].time, 0.5);
        }
        if (!live) assert.equal(submissions, 1);
        if (multiReference) {
            assert.equal(receivedImages.length, 2, 'Both references must reach the HTTP server');
            assert.deepEqual(receivedImages[0], image);
            assert.deepEqual(receivedImages[1], secondImage);
            // The file comparison above verifies the actual wire body, not just renderer attachments.
            console.log('Two-reference HTTP check passed: both multipart files match their source bytes in upload order.');
        }
        assert.equal(result.steps.filter(step => step.status === 'completed').length, 1);
        if (!live && !multiReference) {
            const workflowRun = await page.evaluate(id => window.flowCanvas.agent.start({ projectId: 'smoke', conversationId: 'workflow-conversation',
                messages: [{ role: 'user', content: `SAVE:${id}` }] }), run.id);
            const workflow = await poll(() => page.evaluate(id => window.flowCanvas.agent.get({ runId: id }), workflowRun.id),
                state => ['completed', 'failed'].includes(state.status));
            assert.equal(workflow.status, 'completed', workflow.error);
            assert.ok(workflow.events.some(event => event.type === 'tool_result' && event.data?.result?.nodeIds?.length));
            assert.equal(submissions, 1);
        }
        const board = JSON.parse(await fs.readFile(path.join(profile, 'data', 'board.json'), 'utf8'));
        assert.equal(board.folderGroups.find(g => g.id === 'other').savedItems.length, 0);
        if (!live) {
            const project = board.folderGroups.find(g => g.id === 'smoke');
            assert.equal(project.plans[0].rows[0].id, 'shot-smoke');
            if (!multiReference) assert.equal(project.agentWorkflows.length, 1);
        }
        assert.ok(board.folderGroups.find(g => g.id === 'smoke').savedItems.some(item => item.metadata?.agentRunId === run.id && item.filePath));
        if (!live) assert.ok(requests.some(request => (request.messages || []).some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url'))));
        const directory = path.resolve('output', 'agent-smoke');
        await fs.mkdir(directory, { recursive: true });
        if (!process.env.FLOW_CANVAS_SMOKE_ASAR) await page.evaluate(async snapshot => {
            const { createRuntimeCard } = await import('/agent-runtime-view.js');
            const card = createRuntimeCard({ onAction: async () => {} });
            card.update(snapshot);
            const host = document.createElement('aside');
            host.style.cssText = 'position:fixed;right:0;top:40px;width:420px;bottom:0;background:#1b1c1f;z-index:10000;padding:16px;overflow:auto';
            host.append(card.root); document.body.append(host);
        }, result);
        await page.screenshot({ path: path.join(directory, 'runtime-desktop.png') });
        await page.setViewportSize({ width: 800, height: 700 });
        await page.screenshot({ path: path.join(directory, 'runtime-narrow.png') });
        console.log(JSON.stringify({ ok: true, live, status: result.status, generationRequests: result.steps.length, originalProject: result.projectId,
            results: result.results.length, screenshots: directory }, null, 2));
    } finally {
        await electronApp?.close();
        await new Promise(resolve => server.close(resolve));
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
