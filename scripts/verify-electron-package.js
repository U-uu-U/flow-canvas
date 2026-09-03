const path = require('path');
const asar = require('@electron/asar');

const archivePath = path.resolve(
    process.argv[2] || path.join(__dirname, '../dist/win-unpacked/resources/app.asar')
);
const entries = asar.listPackage(archivePath)
    .map(entry => entry.replace(/\\/g, '/').replace(/^\/+/, ''));
const entrySet = new Set(entries);

const required = [
    'dist/index.html',
    'electron-main/main.js',
    'electron-main/preload.js',
    'electron-main/gateway-config.json',
    'shared/logger.js',
    'shared/url-utils.js',
    'node_modules/chokidar/index.js'
];
const forbiddenExact = new Set([
    '.env', '.env.example', '.git', '.dockerignore', 'Dockerfile', 'docker-compose.yml'
]);
const forbiddenPrefixes = [
    '.agents/', '.claude/', 'docs/', 'handoff/', 'scripts/', 'server/', 'src/', 'dist/win-unpacked/'
];

const missing = required.filter(entry => !entrySet.has(entry));
const forbidden = entries.filter(entry => (
    forbiddenExact.has(entry)
    || forbiddenPrefixes.some(prefix => entry.startsWith(prefix))
    || entry.endsWith('.test.js')
));

if (missing.length || forbidden.length) {
    if (missing.length) console.error(`安装包缺少运行文件: ${missing.join(', ')}`);
    if (forbidden.length) console.error(`安装包包含禁止文件: ${forbidden.slice(0, 20).join(', ')}`);
    process.exit(1);
}

console.log(`[Package] app.asar 验证通过，共 ${entries.length} 个条目`);
