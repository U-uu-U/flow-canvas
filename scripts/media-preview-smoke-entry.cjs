const { app, safeStorage } = require('electron');
const path = require('node:path');
const { ApiConfigStore } = require('../electron-main/api-config-store');
const profile = process.env.FLOW_MEDIA_SMOKE_PROFILE;
if (!profile) throw new Error('Isolated media smoke profile required');
app.setPath('userData', profile);
Object.defineProperty(app, 'isPackaged', { value: true });
app.whenReady().then(() => {
    new ApiConfigStore(profile, { protect: value => safeStorage.encryptString(value), unprotect: value => safeStorage.decryptString(value) })
        .save({ version: 1, revision: 1, providers: [], globalConfig: {} });
});
require(process.env.FLOW_MEDIA_SMOKE_ASAR
    ? path.join(process.env.FLOW_MEDIA_SMOKE_ASAR, 'electron-main/main.js') : '../electron-main/main.js');
