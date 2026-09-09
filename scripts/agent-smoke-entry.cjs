const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { ApiConfigStore } = require('../electron-main/api-config-store');
const profile = process.env.FLOW_CANVAS_SMOKE_PROFILE;
if (!profile) throw new Error('FLOW_CANVAS_SMOKE_PROFILE is required');
app.setPath('userData', profile);
app.whenReady().then(() => {
    let config = JSON.parse(fs.readFileSync(path.join(profile, 'fixture-api.json'), 'utf8'));
    if (process.env.FLOW_CANVAS_SMOKE_LIVE === '1') {
        const live = new ApiConfigStore(path.join(app.getPath('appData'), 'flow-canvas'), {
            unprotect: bytes => safeStorage.decryptString(bytes)
        }).load();
        if (!live.success || !live.config) throw new Error('Live API configuration is unavailable');
        config = live.config;
        const text = config.providers.find(p => p.capability === 'text' && p.apiKey && p.model);
        if (text) config.globalConfig = { ...config.globalConfig, textProviderId: text.id };
        const image = config.providers.find(p => p.capability === 'image' && (p.models || [p.model]).includes('gpt-image-2'));
        if (!image) throw new Error('A configured gpt-image-2 route is required for the one-image live test');
        const liveVideo = process.env.FLOW_CANVAS_SMOKE_LIVE_VIDEO === '1';
        const video = liveVideo ? config.providers.find(p => p.capability === 'video' && (p.models || [p.model]).includes('sd2.5')) : null;
        if (liveVideo && !video) throw new Error('The configured sd2.5 backup route is required for the single-video test');
        const boardFile = path.join(profile, 'data', 'board.json');
        const board = JSON.parse(fs.readFileSync(boardFile, 'utf8'));
        for (const node of [board.items.find(n => n.id === 'generate'), board.folderGroups[0].savedItems.find(n => n.id === 'generate')]) {
            Object.assign(node.config, { providerId: image.id, sourceProviderId: image.id, model: 'gpt-image-2', size: '1024x1024' });
            if (liveVideo) {
                node.nodeType = 'video'; node.title = '视频生成';
                node.config = { prompt: '固定镜头，保持纯灰蓝色背景，轻微自然光线变化，无人物，无文字。', count: 1,
                    providerId: video.id, sourceProviderId: video.id, model: 'sd2.5', duration: 30, resolution: '720p', ratio: '16:9' };
            }
        }
        fs.writeFileSync(boardFile, JSON.stringify(board));
    }
    new ApiConfigStore(profile, { protect: text => safeStorage.encryptString(text), unprotect: bytes => safeStorage.decryptString(bytes) }).save(config);
});
if (process.env.FLOW_CANVAS_SMOKE_ASAR) {
    Object.defineProperty(app, 'isPackaged', { value: true });
    require(path.join(process.env.FLOW_CANVAS_SMOKE_ASAR, 'electron-main', 'main.js'));
} else require('../electron-main/main.js');
