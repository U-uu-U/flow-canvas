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
                { id: 'r1', sourceProviderId: 'relay', name: 'RavenHash', model: 'sd2.5-route1', routeLabel: '\u8def\u7ebf\u4e00' },
                { id: 'r2', sourceProviderId: 'relay', name: 'RavenHash', model: 'sd2.5', routeLabel: '\u8def\u7ebf\u4e8c' },
                { id: 'other', sourceProviderId: 'relay', name: 'RavenHash', model: 'minimax-h3' }
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
            window.routeFixture = { fixture, data };
            fixture._showGenerationComposerModelMenu('node', {});
        }, methods);
        const options = page.locator('.generation-composer-model-option');
        assert.equal(await options.count(), 3);
        for (const [route, model] of [['\u8def\u7ebf\u4e00', 'sd2.5-route1'], ['\u8def\u7ebf\u4e8c', 'sd2.5']]) {
            await page.locator(`[data-route="${route}"]`).click();
            assert.equal(await options.count(), 1);
            assert.ok((await options.innerText()).includes(model));
            await page.locator('.generation-composer-popover-search input').fill('absent');
            assert.equal(await options.count(), 0);
            await page.locator('.generation-composer-popover-search input').fill('');
            assert.equal(await options.count(), 1);
            const fits = await page.locator('.generation-composer-model-popover').evaluate(element => element.scrollWidth <= element.clientWidth);
            assert.equal(fits, true);
            if (process.env.FLOW_ROUTE_SCREENSHOT) await page.screenshot({ path: `${process.env.FLOW_ROUTE_SCREENSHOT}-${model}.png` });
            await options.click();
            assert.deepEqual(await page.evaluate(() => ({ model: window.routeFixture.data.config.model, source: window.routeFixture.data.config.sourceProviderId })), { model, source: 'relay' });
            await page.evaluate(() => window.routeFixture.fixture._showGenerationComposerModelMenu('node', {}));
        }
        console.log('Video route picker passed: route filtering, search, model binding, compact layout.');
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
