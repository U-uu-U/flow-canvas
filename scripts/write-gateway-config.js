const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const mainProcessValue = String(process.env.FLOWCANVAS_GATEWAY_URL || '').replace(/\/+$/, '');
const rendererValue = String(process.env.VITE_FLOWCANVAS_GATEWAY_URL || '').replace(/\/+$/, '');
if (mainProcessValue && rendererValue && mainProcessValue !== rendererValue) {
    throw new Error('FLOWCANVAS_GATEWAY_URL 与 VITE_FLOWCANVAS_GATEWAY_URL 必须完全一致');
}

const value = String(
    mainProcessValue
    || rendererValue
    || 'http://localhost:8787'
).replace(/\/+$/, '');
const gatewayUrl = new URL(value);
if (!['http:', 'https:'].includes(gatewayUrl.protocol) || gatewayUrl.username || gatewayUrl.password
    || gatewayUrl.search || gatewayUrl.hash) {
    throw new Error('FlowCanvas 网关必须是无内嵌凭证、查询参数或锚点的 HTTP(S) URL');
}

const target = path.resolve(__dirname, '../electron-main/gateway-config.json');
fs.writeFileSync(target, `${JSON.stringify({ gatewayBaseUrl: value }, null, 4)}\n`, 'utf8');
console.log(`[Config] Electron gateway: ${value}`);
