const { app, net, safeStorage } = require('electron');
const path = require('node:path');
const { ApiConfigStore } = require('../electron-main/api-config-store');

app.setPath('userData', path.join(app.getPath('appData'), 'flow-canvas'));
app.whenReady().then(async () => {
    const hm = process.argv.includes('--hm');
    const requiredModels = hm
        ? ['seedance_v2.0-933', 'seedance_v2.5-101010', 'seedance_v2.5-301010']
        : ['sd2.5-route1', 'sd2.5'];
    const store = new ApiConfigStore(app.getPath('userData'), {
        protect: value => safeStorage.encryptString(value),
        unprotect: value => safeStorage.decryptString(value)
    });
    const loaded = store.load();
    if (!loaded.config) throw new Error('No saved API configuration');
    const provider = loaded.config.providers.find(provider => {
        try { return new URL(provider.endpoint).hostname === 'art.ravenhash.org' && provider.apiKey
            && (!hm || [...(provider.models || []), provider.model].includes('seedance_v2.5')); }
        catch { return false; }
    });
    if (!provider) throw new Error('No configured RavenHash video API');
    const response = await net.fetch('https://art.ravenhash.org/v1/models', {
        headers: { Authorization: `Bearer ${provider.apiKey}` }, signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`RavenHash model query: HTTP ${response.status}`);
    const payload = await response.json();
    const models = (payload.data || []).map(model => model.id);
    console.log(JSON.stringify({ endpoint: provider.endpoint,
        routes: models.filter(model => hm ? /^seedance_v2/.test(model) : /^sd2\.5/.test(model)) }));
    if (requiredModels.some(model => !models.includes(model))) throw new Error('Required relay models are not all visible');
    const taskIndex = process.argv.indexOf('--task');
    if (taskIndex >= 0) {
        const taskId = process.argv[taskIndex + 1] || '';
        if (!/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) throw new Error('Invalid task ID');
        const result = await net.fetch(`https://art.ravenhash.org/v1/tasks/${encodeURIComponent(taskId)}`, {
            headers: { Authorization: `Bearer ${provider.apiKey}` }, signal: AbortSignal.timeout(30000)
        });
        const task = await result.json();
        console.log(JSON.stringify({ taskId, httpStatus: result.status, status: task.status || task.data?.status,
            error: task.error?.message || task.data?.error?.message, hasVideo: !!(task.video_url || task.data?.video_url) }));
    }
    if (process.argv.includes('--apply')) {
        const latest = store.load().config;
        if (JSON.stringify(latest) !== JSON.stringify(loaded.config)) throw new Error('API configuration changed during discovery; retry with Flow Canvas closed');
        const current = Array.isArray(provider.models) ? provider.models : [provider.model];
        if (requiredModels.every(model => current.includes(model))) {
            console.log('Required models are already configured; no changes.');
            return;
        }
        provider.models = [...new Set([...current, ...requiredModels].filter(Boolean))];
        loaded.config.revision += 1;
        loaded.config.updatedAt = new Date().toISOString();
        const result = store.save(loaded.config);
        if (!result.success) throw new Error(result.error);
        console.log('Saved route models to existing RavenHash provider; credentials unchanged.');
    }
}).then(() => app.quit()).catch(error => { console.error(error.message); app.exit(1); });
