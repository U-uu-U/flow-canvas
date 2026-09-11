const { app, safeStorage } = require('electron');
const { ApiConfigStore } = require('../electron-main/api-config-store');
const profile = process.env.FLOW_MCP_SMOKE_PROFILE;
if (!profile) throw new Error('Isolated smoke profile required');
app.setPath('userData', profile);
Object.defineProperty(app, 'isPackaged', { value: true });
app.whenReady().then(() => {
    new ApiConfigStore(profile, { protect: value => safeStorage.encryptString(value), unprotect: value => safeStorage.decryptString(value) })
        .save({ version: 1, revision: 1, providers: [], globalConfig: {} });
});
require('../electron-main/main.js');
