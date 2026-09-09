const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = ['electron-main', 'mcp', 'shared', 'src'].flatMap(directory => fs.readdirSync(path.join(root, directory))
    .filter(name => /\.test\.(?:js|cjs|mjs)$/.test(name)).sort().map(name => path.join(directory, name)));
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
