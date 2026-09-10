const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'flow-citations-'));
    let app;
    try {
        await fs.mkdir(path.join(profile, 'data'));
        await fs.writeFile(path.join(profile, 'data/board.json'), JSON.stringify({ version: 1, items: [], folderGroups: [], mcp: { enabled: false } }));
        const env = { ...process.env, FLOW_MCP_SMOKE_PROFILE: profile };
        delete env.ELECTRON_RUN_AS_NODE;
        app = await electron.launch({ executablePath: require('electron'), args: [path.join(__dirname, 'mcp-client-smoke-entry.cjs')], env });
        const page = await app.firstWindow();
        await page.waitForFunction(() => window.flowCanvas?.store);
        const source = await fs.readFile(path.join(__dirname, '../src/canvas.js'), 'utf8');
        // Exercise the production composer methods with real Electron selection/contenteditable behavior.
        const methods = source.slice(source.indexOf('    _generationComposerPromptValue('), source.indexOf('    _syncGenerationComposerModelButton('));
        await page.evaluate(methods => {
            const Fixture = new Function('resolveCanvasFilePath', `const GENERATION_COMPOSER_CARET_ANCHOR = '\\u200B'; return class { ${methods} }`)(value => value);
            const fixture = new Fixture();
            const data = { nodeType: 'image', config: { prompt: 'A B C' } };
            const references = ['first', 'second'].map(id => ({ connection: { id, transient: true }, source: { filePath: '', mediaType: 'image' } }));
            // Use an inline preview so this test does not depend on any user files.
            references.forEach(entry => { entry.source.filePath = 'fixture.png'; });
            const element = document.createElement('section');
            element.className = 'generation-composer';
            element.style.cssText = 'position:fixed;left:120px;top:160px;width:540px;z-index:999999';
            element.innerHTML = '<div class="generation-composer-references" data-reference-list></div><div class="generation-composer-prompt" data-prompt contenteditable="true"></div>';
            document.body.append(element);
            fixture.items = new Map([['test', { data }]]);
            fixture._generationComposer = { nodeId: 'test', element };
            fixture._opReferenceEntries = () => references;
            fixture._getItemMediaType = source => source.mediaType;
            fixture._fileNameFromPath = value => value;
            fixture._syncGenerationComposerPromptMergeButton = () => {};
            fixture._positionGenerationComposer = () => {};
            fixture._cacheMediaGenerationPromptDraft = () => {};
            fixture.emit = () => {};
            const prompt = element.querySelector('[data-prompt]');
            fixture._setGenerationComposerPromptValue(prompt, data.config.prompt);
            fixture._renderGenerationComposerReferences('test');
            window.citationFixture = { fixture, data, prompt, references };
        }, methods);
        const pills = page.locator('.generation-composer-citation');
        const first = page.locator('.generation-composer-reference.citable').nth(0);
        const second = page.locator('.generation-composer-reference.citable').nth(1);
        await page.evaluate(() => {
            const { fixture, prompt } = window.citationFixture;
            fixture._focusGenerationComposerPromptEnd(prompt);
        });
        await first.click();
        await first.click();
        await second.click();
        assert.deepEqual(await pills.allTextContents(), ['图一', '图一', '图二']);
        await pills.nth(0).click();
        assert.deepEqual(await pills.allTextContents(), ['图一', '图二']);
        assert.equal(await page.locator('.generation-composer-reference.citable').count(), 2);
        await page.evaluate(() => {
            const { fixture, prompt } = window.citationFixture;
            const range = document.createRange();
            range.setStart(prompt.firstChild, 2);
            range.collapse(true);
            prompt.focus();
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
        });
        await first.click();
        assert.deepEqual(await pills.allTextContents(), ['图一', '图一', '图二']);
        const before = await page.evaluate(() => {
            const { fixture, data, prompt } = window.citationFixture;
            return { text: fixture._generationComposerPromptValue(prompt), occurrences: data.config.referenceCitationOccurrences };
        });
        assert.deepEqual(before.occurrences.map(entry => entry.offset), [2, 5, 5]);
        assert.equal(new Set(before.occurrences.map(entry => entry.id)).size, 3);
        await page.evaluate(() => {
            const { fixture, data, prompt } = window.citationFixture;
            data.config = JSON.parse(JSON.stringify(data.config));
            prompt.replaceChildren();
            fixture._setGenerationComposerPromptValue(prompt, data.config.prompt);
            fixture._renderGenerationComposerReferences('test');
        });
        const after = await page.evaluate(() => window.citationFixture.data.config.referenceCitationOccurrences);
        assert.deepEqual(after, before.occurrences);
        await first.focus();
        await page.keyboard.press('Enter');
        assert.equal(await pills.count(), 4);
        // Simulate keyboard removal and the composer's input synchronization.
        await page.evaluate(() => {
            const { fixture, data, prompt } = window.citationFixture;
            prompt.querySelector('[data-citation-id]').remove();
            fixture._syncGenerationComposerCitationsFromPrompt(data, prompt);
            fixture._renderGenerationComposerReferences('test');
        });
        assert.equal(await pills.count(), 3);
        await page.evaluate(() => {
            const { fixture, references } = window.citationFixture;
            references.shift();
            fixture._renderGenerationComposerReferences('test');
        });
        assert.deepEqual(await pills.allTextContents(), ['图一']);
        await pills.click();
        assert.equal(await pills.count(), 0);
        assert.deepEqual(await page.evaluate(() => window.citationFixture.data.config.referenceCitationOccurrences), []);
        // Legacy single-reference configurations migrate with their saved offsets.
        await page.evaluate(() => {
            const { fixture, data, prompt } = window.citationFixture;
            data.config = { prompt: 'A B C', referenceCitationIds: ['second'], referenceCitationOffsets: { second: 2 } };
            prompt.replaceChildren();
            fixture._setGenerationComposerPromptValue(prompt, data.config.prompt);
            fixture._renderGenerationComposerReferences('test');
        });
        assert.equal(await pills.count(), 1);
        assert.equal(await page.evaluate(() => window.citationFixture.data.config.referenceCitationOccurrences[0].offset), 2);
        console.log('Reference citations smoke passed: append, remove one, caret, persistence, keyboard, disconnect, legacy migration.');
    } finally {
        await app?.close();
        await fs.rm(profile, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
