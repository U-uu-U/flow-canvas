const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-routes-'));
    let app;
    try {
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        const page = await app.firstWindow();
        await page.waitForFunction(() => window.flowCanvas?.store);
        const source = await fs.readFile(path.join(__dirname, '../src/canvas.js'), 'utf8');
        const methods = source.slice(source.indexOf('    _showGenerationComposerModelMenu('), source.indexOf('    _showGenerationComposerPromptPresets('));
        await page.evaluate(methods => {
            const Fixture = new Function(`return class { ${methods} }`)();
            const fixture = new Fixture();
            const data = { nodeType: 'video', config: {} };
            const providers = [
                { id: 'r2', sourceProviderId: 'relay', name: 'RavenHash', model: 'sd2.5', routeLabel: '\u7ebf\u8def\u4e8c', routeGroup: 'seedance25-fixed', routeModelLabel: 'sd2.5' },
                { id: 'r1', sourceProviderId: 'relay', name: 'RavenHash', model: 'sd2.5-route1', routeLabel: '\u7ebf\u8def\u4e00', routeGroup: 'seedance25-fixed', routeModelLabel: 'sd2.5' },
                { id: 'other', sourceProviderId: 'relay', name: 'RavenHash', model: 'minimax-h3' },
                { id: 'variable', sourceProviderId: 'relay', name: 'RavenHash', model: 'seedance_v2.5' },
                { id: 'separate', sourceProviderId: 'another-account', name: 'Other API', model: 'sd2.5', routeLabel: '\u7ebf\u8def\u4e8c', routeGroup: 'seedance25-fixed', routeModelLabel: 'sd2.5' }
            ];
            fixture.items = new Map([['node', { data }]]);
            fixture._generationComposer = { nodeId: 'node' };
            fixture.options = { getGenerationProviders: () => providers };
            fixture._mountGenerationComposerPopover = (active, element) => {
                element.style.cssText = 'position:fixed;left:24px;top:24px;width:300px;z-index:999999';
                document.body.append(element);
                active.element = element;
            };
            fixture._closeGenerationComposerPopover = active => active.element?.remove();
            fixture._applyImageGenerationProviderSelection = (node, provider) => { node.config = { ...provider }; };
            for (const name of ['_syncGenerationComposerModelButton', '_renderGenerationComposerParameters', '_syncGenerationComposerCount', 'refreshOpNode', 'emit']) fixture[name] = () => {};
            window.routeFixture = { fixture, data, providers };
            fixture._showGenerationComposerModelMenu('node', {});
        }, methods);
        const options = page.locator('.generation-composer-model-option');
        assert.equal(await options.count(), 4);
        assert.equal(await page.locator('.generation-composer-segmented').count(), 0);
        const split = page.locator('.generation-composer-model-routes');
        assert.equal(await split.count(), 1);
        assert.deepEqual(await split.locator('strong').allTextContents(), ['\u7ebf\u8def\u4e00', '\u7ebf\u8def\u4e8c']);
        assert.equal(await page.locator('.generation-composer-model-options > .generation-composer-model-option').count(), 2);
        assert.equal(await options.filter({ hasText: 'seedance_v2.5' }).count(), 0);
        for (const [index, model] of [[0, 'sd2.5-route1'], [1, 'sd2.5']]) {
            await page.locator('.generation-composer-popover-search input').fill('absent');
            assert.equal(await options.count(), 0);
            await page.locator('.generation-composer-popover-search input').fill('');
            assert.equal(await options.count(), 4);
            const halves = split.locator('button');
            const left = await halves.nth(0).boundingBox();
            const right = await halves.nth(1).boundingBox();
            assert.ok(Math.abs(left.width - right.width) < 1);
            assert.ok(Math.abs(left.y - right.y) < 1);
            assert.ok(Math.abs(left.x + left.width - right.x) < 1);
            const fits = await page.locator('.generation-composer-model-popover').evaluate(element => element.scrollWidth <= element.clientWidth);
            assert.equal(fits, true);
            if (process.env.FLOW_ROUTE_SCREENSHOT) {
                await page.mouse.move(900, 600);
                await page.screenshot({ path: `${process.env.FLOW_ROUTE_SCREENSHOT}-${model}.png`, animations: 'disabled' });
            }
            await halves.nth(index).click();
            assert.deepEqual(await page.evaluate(() => ({ model: window.routeFixture.data.config.model, source: window.routeFixture.data.config.sourceProviderId })), { model, source: 'relay' });
            await page.evaluate(() => window.routeFixture.fixture._showGenerationComposerModelMenu('node', {}));
            assert.equal(await split.locator('[aria-selected="true"]').count(), 1);
        }
        await page.locator('.generation-composer-popover-search input').fill('sd2.5-route1');
        assert.equal(await options.count(), 2);
        await page.evaluate(() => {
            const { fixture, providers } = window.routeFixture;
            fixture._closeGenerationComposerPopover(fixture._generationComposer);
            providers.splice(providers.findIndex(provider => provider.id === 'r1'), 1);
            fixture._showGenerationComposerModelMenu('node', {});
        });
        assert.equal(await split.count(), 0);
        assert.equal(await options.filter({ hasText: 'seedance_v2.5' }).count(), 1);
        console.log('Video route picker passed: split rows, route order, account isolation, search, model binding, compact layout.');
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
