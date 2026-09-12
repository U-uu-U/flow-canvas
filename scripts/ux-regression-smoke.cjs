const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const sharp = require('sharp');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const root = path.resolve(__dirname, '..');
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-ux-regression-'));
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'));
        const videoPath = path.join(profile, '\u96e8\u591c\u8857\u9053_\u89c6\u9891_001.mp4');
        execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoPath]);
        const secondVideoPath = videoPath.replace('_001.mp4', '_002.mp4');
        await fs.copyFile(videoPath, secondVideoPath);
        const video = { id: 'original-video', kind: 'op', nodeType: 'video', x: 100, y: 80,
            width: 320, height: 180, config: { prompt: 'original prompt', providerId: 'video', model: 'minimax-h3' },
            runStatus: 'done', filePath: videoPath, resultEntries: [videoPath, secondVideoPath]
                .map(filePath => ({ filePath, item: { filePath, mediaType: 'video' } })) };
        const image = { id: 'generate', kind: 'op', nodeType: 'image', x: 100, y: 290,
            width: 264, height: 264, config: { providerId: 'image', model: 'gpt-image-2',
                prompt: 'Fixture composition', count: 1, size: '1024x1024', ratio: '1:1' } };
        const stackPaths = [1, 2].map(index => path.join(profile, `Long_generated_image_name_00${index}.png`));
        await sharp({ create: { width: 64, height: 64, channels: 3, background: '#808080' } }).png().toFile(stackPaths[0]);
        await fs.copyFile(stackPaths[0], stackPaths[1]);
        const stack = { id: 'image-stack', kind: 'op', nodeType: 'image', x: 480, y: 80,
            width: 264, height: 264, preserveGeneratorStack: true, runStatus: 'done',
            config: { prompt: 'Fixture stack' }, resultEntries: stackPaths.map(filePath => ({ filePath })) };
        const items = [video, image, stack];
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1,
            activeGroupId: 'audit', items, connections: [], sidebarClosed: false,
            folderGroups: [{ id: 'audit', name: 'Audit project', folders: [], savedItems: items, connections: [] }], mcp: { enabled: false } }));
        await fs.writeFile(path.join(profile, 'fixture-api.json'), JSON.stringify({ version: 1, revision: 1,
            providers: [{ id: 'image', name: 'Fixture', capability: 'image', type: 'openai',
                apiKey: 'fixture-only', endpoint: 'http://127.0.0.1:1/v1', model: 'gpt-image-2' },
                { id: 'video', name: 'Fixture video', capability: 'video', type: 'openai',
                    apiKey: 'fixture-only', endpoint: 'http://127.0.0.1:1/v1', model: 'minimax-h3' }],
            globalConfig: { imageProviderId: 'image' } }));
        const env = { ...process.env, FLOW_CANVAS_SMOKE_PROFILE: profile, FLOW_CANVAS_SMOKE_LIVE: '0' };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'agent-smoke-entry.cjs')], env });
        const page = await app.firstWindow();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.waitForSelector('[data-group-id="audit"] .group-header');
        const readBoard = async () => JSON.parse(await fs.readFile(path.join(profile, 'data/board.json'), 'utf8'));
        const poll = async predicate => {
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
                const board = await readBoard();
                if (predicate(board)) return board;
                await new Promise(resolve => setTimeout(resolve, 60));
            }
            throw new Error('Board state did not settle');
        };
        await page.evaluate(() => document.dispatchEvent(new CustomEvent('context-duplicate-node', { detail: { itemIds: ['original-video'] } })));
        let board = await poll(board => board.items.length === 4);
        const copy = board.items.find(item => !['original-video', 'generate', 'image-stack'].includes(item.id));
        assert.ok(copy);
        await page.evaluate(id => document.dispatchEvent(new CustomEvent('context-remove', { detail: { itemIds: [id] } })), copy.id);
        board = await poll(board => board.items.length === 3);
        assert.equal(board.items.find(item => item.id === video.id).filePath, videoPath);
        assert.equal(board.items.find(item => item.id === video.id).resultEntries.length, 2);
        await page.keyboard.press('Control+z');
        board = await poll(board => board.items.some(item => item.id === copy.id));
        assert.equal(board.items.find(item => item.id === video.id).filePath, videoPath);
        await page.keyboard.press('Control+Shift+z');
        await poll(board => !board.items.some(item => item.id === copy.id));
        await page.reload();
        await page.waitForSelector('[data-group-id="audit"] .group-header');
        board = await readBoard();
        assert.equal(board.items.find(item => item.id === video.id).filePath, videoPath);
        await fs.access(videoPath);
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#original-video')?.findOne('.externalNodeTitleText'));
        const stackLayout = await page.evaluate(() => {
            const group = window.Konva.stages[0].findOne('#image-stack');
            const title = group.findOne('.externalNodeTitle').getClientRect();
            const controls = group.findOne('.generatorResultLayoutToggle').getClientRect();
            return { titleRight: title.x + title.width, controlsLeft: controls.x };
        });
        assert.ok(stackLayout.titleRight <= stackLayout.controlsLeft, JSON.stringify(stackLayout));
        const nameLayout = await page.evaluate(() => {
            const group = window.Konva.stages[0].findOne('#original-video');
            const title = group.findOne('.externalNodeTitle');
            const name = group.findOne('.externalNodeTitleText').text();
            const bounds = title.getClientRect();
            const counter = group.findOne('.generatorStackPosition').getClientRect();
            title.fire('dblclick', { evt: {}, cancelBubble: false });
            return { name, right: bounds.x + bounds.width, counterLeft: counter.x };
        });
        assert.ok(nameLayout.name.startsWith('\u96e8\u591c\u8857\u9053'));
        assert.ok(nameLayout.right <= nameLayout.counterLeft, JSON.stringify(nameLayout));
        const nameEditor = page.locator('.media-title-inline-editor');
        assert.equal(await nameEditor.inputValue(), path.basename(videoPath, '.mp4'));
        await nameEditor.fill('Reviewed video');
        await nameEditor.press('Enter');
        await poll(board => board.items.find(item => item.id === video.id).displayName === 'Reviewed video');
        await page.reload();
        await page.waitForFunction(() => window.Konva?.stages[0]?.findOne('#original-video')?.findOne('.externalNodeTitleText')?.text() === 'Reviewed video');
        board = await readBoard();
        assert.equal(board.items.find(item => item.id === video.id).filePath, videoPath);
        await fs.access(videoPath);
        await page.evaluate(async () => {
            const { requestRecoveryTaskId } = await import('/generation-recovery-dialog.js');
            window.uxRecovery = 'pending';
            void requestRecoveryTaskId({ kind: 'video', model: 'fixture' }).then(value => { window.uxRecovery = value; });
        });
        await page.locator('.generation-recovery-dialog input').fill('fixture-task-id');
        await page.locator('.generation-recovery-dialog input').press('Enter');
        await page.waitForFunction(() => window.uxRecovery !== 'pending');
        assert.equal(await page.evaluate(() => window.uxRecovery), 'fixture-task-id');
        await page.evaluate(async () => {
            const { showStatusNotification } = await import('/status-notification.js');
            showStatusNotification('Fixture generation failure', { kind: 'error', duration: 1 });
            showStatusNotification('Unrelated success', { kind: 'success', duration: 1 });
        });
        await page.waitForTimeout(100);
        assert.equal(await page.locator('#titlebarStatus .titlebar-status-message').textContent(), 'Fixture generation failure');
        assert.equal(await page.locator('#titlebarStatus').evaluate(el => el.matches(':popover-open')), true);
        await page.locator('#titlebarStatus button').first().click();
        await page.waitForFunction(() => document.querySelector('#titlebarStatus button').querySelector('use').getAttribute('href').endsWith('#icon-check'));
        await page.locator('#titlebarStatus button').last().click();
        assert.equal(await page.locator('#titlebarStatus').getAttribute('popover'), null);
        const output = path.join(root, 'output/playwright');
        await fs.mkdir(output, { recursive: true });
        for (const nodeId of ['generate', 'original-video']) {
            await page.evaluate(nodeId => document.dispatchEvent(new CustomEvent('context-edit-node', { detail: { nodeId } })), nodeId);
            await page.waitForSelector('.generation-composer');
            for (const [width, height] of [[1300, 900], [820, 680]]) {
                await page.setViewportSize({ width, height });
                await page.waitForTimeout(300);
                const layout = await page.evaluate(() => {
                    const host = document.querySelector('.generation-composer');
                    const params = host.querySelector('[data-parameters]');
                    const bounds = host.getBoundingClientRect();
                    const submit = host.querySelector('[data-submit]').getBoundingClientRect();
                    return { right: bounds.right, bottom: bounds.bottom, submitRight: submit.right,
                        overflow: params.scrollWidth > params.clientWidth + 1 };
                });
                assert.ok(layout.right <= width + 1 && layout.bottom <= height + 1, JSON.stringify(layout));
                assert.ok(layout.submitRight <= width && !layout.overflow, JSON.stringify(layout));
                await page.screenshot({ path: path.join(output, `ux-regression-${nodeId}-${width}.png`) });
            }
        }
        assert.deepEqual(errors, []);
        console.log('UX regression passed: duplicate/delete/undo/redo/reload, video naming/edit/persistence, stack counter spacing, recovery Enter, persistent error/copy, desktop/compact composer.');
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
