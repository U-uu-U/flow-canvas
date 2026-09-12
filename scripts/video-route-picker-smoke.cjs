const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-routes-'));
    let app;
    try {
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        let page;
        for (let attempt = 0; attempt < 100; attempt++) {
            page = app.windows().find(window => /dist[\\/]index\.html/.test(window.url()));
            if (page) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(page, 'The renderer window must open');
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
        assert.equal(await options.count(), 5);
        assert.equal(await page.locator('.generation-composer-segmented').count(), 0);
        const split = page.locator('.generation-composer-model-routes');
        assert.equal(await split.count(), 1);
        assert.equal(await split.locator('.generation-composer-route-trigger strong').innerText(), 'Seedance 2.5 \u00b7 \u56fa\u5b9a 30 \u79d2');
        assert.equal(await split.locator('.generation-composer-route-trigger').getAttribute('aria-expanded'), 'false');
        assert.deepEqual(await split.locator('.generation-composer-route-options strong').allTextContents(), ['\u7ebf\u8def\u4e00\uff08\u63a8\u8350\uff09', '\u7ebf\u8def\u4e8c']);
        assert.deepEqual(await split.locator('.generation-composer-route-options small').allTextContents(), ['sd2.5-route1', 'sd2.5']);
        assert.equal(await page.locator('.generation-composer-model-options > .generation-composer-model-option').count(), 3);
        assert.equal(await options.filter({ hasText: 'seedance_v2.5' }).count(), 1);
        await options.filter({ hasText: 'seedance_v2.5' }).click();
        assert.deepEqual(await page.evaluate(() => ({ model: window.routeFixture.data.config.model, source: window.routeFixture.data.config.sourceProviderId })), { model: 'seedance_v2.5', source: 'relay' });
        await page.evaluate(() => window.routeFixture.fixture._showGenerationComposerModelMenu('node', {}));
        assert.equal(await options.filter({ hasText: 'seedance_v2.5' }).getAttribute('aria-selected'), 'true');
        for (const [index, model] of [[0, 'sd2.5-route1'], [1, 'sd2.5']]) {
            await page.locator('.generation-composer-popover-search input').fill('absent');
            assert.equal(await options.count(), 0);
            await page.locator('.generation-composer-popover-search input').fill('');
            assert.equal(await options.count(), 5);
            await page.locator('.generation-composer-model-popover').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
            await split.locator('.generation-composer-route-trigger').hover();
            await page.waitForFunction(() => getComputedStyle(document.querySelector('.generation-composer-route-panel')).opacity === '1');
            await split.locator('.generation-composer-route-panel').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
            const halves = split.locator('.generation-composer-model-option');
            const left = await halves.nth(0).boundingBox();
            const right = await halves.nth(1).boundingBox();
            assert.ok(Math.abs(left.width - right.width) < 1);
            assert.ok(Math.abs(left.x - right.x) < 1);
            assert.ok(Math.abs(left.y + left.height - right.y) < 1);
            const menu = await page.locator('.generation-composer-model-popover').boundingBox();
            const trigger = await split.locator('.generation-composer-route-trigger').boundingBox();
            const panel = await split.locator('.generation-composer-route-panel').boundingBox();
            assert.ok(panel.x >= menu.x + menu.width + 5, `Routes open outside the right edge of the model menu: ${JSON.stringify({ panel, menu })}`);
            assert.ok(Math.abs(panel.y - trigger.y) < 1, 'Routes align with their model card');
            const fits = await page.locator('.generation-composer-model-popover').evaluate(element => element.scrollWidth <= element.clientWidth);
            assert.equal(fits, true);
            if (process.env.FLOW_ROUTE_SCREENSHOT) {
                await page.screenshot({ path: `${process.env.FLOW_ROUTE_SCREENSHOT}-${model}.png`, animations: 'disabled' });
            }
            await halves.nth(index).click();
            assert.deepEqual(await page.evaluate(() => ({ model: window.routeFixture.data.config.model, source: window.routeFixture.data.config.sourceProviderId })), { model, source: 'relay' });
            await page.evaluate(() => window.routeFixture.fixture._showGenerationComposerModelMenu('node', {}));
            assert.equal(await split.locator('[aria-selected="true"]').count(), 1);
        }
        await split.locator('.generation-composer-route-trigger').hover();
        await page.mouse.move(900, 600);
        await page.waitForFunction(() => document.querySelector('.generation-composer-route-trigger').getAttribute('aria-expanded') === 'false');
        assert.equal(await split.locator('.generation-composer-route-trigger').getAttribute('aria-expanded'), 'false');
        await split.locator('.generation-composer-route-trigger').focus();
        assert.equal(await split.locator('.generation-composer-route-trigger').getAttribute('aria-expanded'), 'true');
        await page.keyboard.press('ArrowRight');
        assert.ok(await split.locator('.generation-composer-model-option').first().evaluate(button => document.activeElement === button));
        await page.keyboard.press('ArrowLeft');
        assert.equal(await split.locator('.generation-composer-route-trigger').getAttribute('aria-expanded'), 'false');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Escape');
        assert.equal(await split.locator('.generation-composer-route-trigger').getAttribute('aria-expanded'), 'false');
        await page.locator('.generation-composer-popover-search input').fill('sd2.5-route1');
        assert.equal(await options.count(), 2);
        await page.evaluate(() => {
            const { fixture, providers } = window.routeFixture;
            fixture._closeGenerationComposerPopover(fixture._generationComposer);
            providers.unshift(...Array.from({ length: 8 }, (_, index) => ({ id: `extra-${index}`, model: `video-${index}`, name: 'Video API' })));
            fixture._showGenerationComposerModelMenu('node', {});
        });
        await split.locator('.generation-composer-route-trigger').evaluate(trigger => {
            const list = trigger.closest('.generation-composer-model-options');
            list.scrollTop += trigger.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom;
        });
        await split.locator('.generation-composer-route-trigger').hover();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('.generation-composer-route-panel')).opacity === '1');
        await split.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
        const expanded = await split.locator('.generation-composer-route-panel').boundingBox();
        const secondRoute = split.locator('.generation-composer-model-option').nth(1);
        const secondBounds = await secondRoute.boundingBox();
        assert.ok(secondBounds.y + secondBounds.height <= expanded.y + expanded.height + 1,
            'the detached dropdown must contain both routes');
        const modelMenu = await page.locator('.generation-composer-model-popover').boundingBox();
        if (process.env.FLOW_ROUTE_SCREENSHOT) await page.screenshot({ path: `${process.env.FLOW_ROUTE_SCREENSHOT}-long-list.png`, animations: 'disabled' });
        assert.ok(expanded.x >= modelMenu.x + modelMenu.width + 5,
            `the route flyout should remain right of a scrolled model menu: ${JSON.stringify({ expanded, modelMenu })}`);
        const list = page.locator('.generation-composer-model-options');
        assert.equal(await list.evaluate(element => getComputedStyle(element, '::-webkit-scrollbar').display), 'none');
        const previousScroll = await list.evaluate(element => element.scrollTop);
        await page.locator('.generation-composer-popover-title').hover();
        await list.hover({ position: { x: 20, y: 20 } });
        await page.mouse.wheel(0, -150);
        await page.waitForFunction(previous => document.querySelector('.generation-composer-model-options').scrollTop < previous, previousScroll);
        await split.locator('.generation-composer-route-trigger').hover();
        await secondRoute.click();
        assert.equal(await page.evaluate(() => window.routeFixture.data.config.model), 'sd2.5');
        await page.evaluate(() => {
            const { fixture } = window.routeFixture;
            fixture._showGenerationComposerModelMenu('node', {});
            fixture._generationComposer.element.style.left = `${window.innerWidth - 324}px`;
        });
        await split.locator('.generation-composer-route-trigger').hover();
        await split.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
        const rightMenu = await page.locator('.generation-composer-model-popover').boundingBox();
        const edgePanel = await split.locator('.generation-composer-route-panel').boundingBox();
        assert.ok(edgePanel.x >= 10 && edgePanel.x + edgePanel.width < rightMenu.x,
            'Near the right window edge, the flyout flips left without clipping');
        if (process.env.FLOW_ROUTE_SCREENSHOT) await page.screenshot({ path: `${process.env.FLOW_ROUTE_SCREENSHOT}-right-edge.png`, animations: 'disabled' });
        await page.evaluate(() => {
            const { fixture, providers } = window.routeFixture;
            fixture._closeGenerationComposerPopover(fixture._generationComposer);
            providers.splice(providers.findIndex(provider => provider.id === 'r1'), 1);
            fixture._showGenerationComposerModelMenu('node', {});
        });
        assert.equal(await split.count(), 0);
        assert.equal(await options.filter({ hasText: 'seedance_v2.5' }).count(), 1);
        const { getVideoModelProfile, describeVideoModelProfile } = await import(pathToFileURL(path.join(__dirname, '../shared/video-model-profiles.mjs')));
        const hmModels = ['seedance_v2.5', 'seedance_v2.0-933', 'seedance_v2.5-101010', 'seedance_v2.5-301010'].map(model => {
            const provider = { id: model, model, sourceProviderId: 'relay', endpoint: 'https://art.ravenhash.org/v1', name: 'RavenHash' };
            const profile = getVideoModelProfile(provider);
            return { ...provider, modelLabel: profile.label, description: describeVideoModelProfile(profile) };
        });
        await page.evaluate(models => {
            const { fixture, providers } = window.routeFixture;
            fixture._closeGenerationComposerPopover(fixture._generationComposer);
            providers.splice(0, providers.length, ...models);
            fixture._showGenerationComposerModelMenu('node', {});
        }, hmModels);
        const screenshots = path.join(__dirname, '../output/playwright');
        await fs.mkdir(screenshots, { recursive: true });
        for (const [label, width] of [['desktop', 960], ['compact', 360]]) {
            await app.evaluate(({ BrowserWindow }, width) => {
                const win = BrowserWindow.getAllWindows()[0];
                win.setMinimumSize(320, 480);
                win.setSize(width, 720);
            }, width);
            await page.waitForFunction(width => window.innerWidth === width, width);
            assert.equal(await options.count(), 4);
            assert.deepEqual(await options.locator('small').allTextContents(), hmModels.map(model => model.description));
            assert.equal(await options.locator('small').evaluateAll(elements => elements.every(element =>
                element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)), true);
            await page.screenshot({ path: path.join(screenshots, `hm-model-picker-${label}.png`), animations: 'disabled' });
        }
        await options.filter({ hasText: '301010' }).click();
        assert.equal(await page.evaluate(() => window.routeFixture.data.config.model), 'seedance_v2.5-301010');
        console.log('Video route picker passed: right-side flyout, edge fallback, hidden scrollbar with wheel scrolling, keyboard, route order, account isolation, model binding.');
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
