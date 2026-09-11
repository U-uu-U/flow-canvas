const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// 非递归收集各目录下的 *.test.(js|cjs|mjs)。configserver 是独立部署的 CONFIG 服务，
// 它的测试也进这个门禁；configserver/node_modules 不在收集范围（只按文件名过滤）。
const files = ['configserver', 'electron-main', 'mcp', 'shared', 'src'].flatMap(directory => fs.readdirSync(path.join(root, directory))
    .filter(name => /\.test\.(?:js|cjs|mjs)$/.test(name)).sort().map(name => path.join(directory, name)));
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
