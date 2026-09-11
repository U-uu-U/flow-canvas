// 打一个可直接上传到 Linux 服务器的部署包。
//
//   node scripts/pack-configserver.mjs                 # → release/configserver-<ver>-<日期>.tgz
//   node scripts/pack-configserver.mjs --zip           # 同时产出 .zip
//
// 包里只有跑服务需要的东西（server.mjs / lib / schema / seed / deploy / README / package.json），
// 不含 data/（运行时数据）与 node_modules（到服务器上 npm install 装）。
// 解压后目录名带版本号，避免和已有部署混在一起。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'configserver');
const releaseDir = path.join(root, 'release');
const include = ['server.mjs', 'package.json', 'README.md', 'lib', 'schema', 'seed', 'deploy', '.gitignore'];
const exclude = new Set(['data', 'node_modules', 'package-lock.json']);

const version = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8')).version;
const stamp = new Date().toISOString().slice(0, 10);
const bundleName = `configserver-${version}-${stamp}`;
const stageRoot = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'pack-configserver-'));
const stageDir = path.join(stageRoot, bundleName);

function copyRecursive(from, to) {
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(from)) {
            if (exclude.has(name)) continue;
            copyRecursive(path.join(from, name), path.join(to, name));
        }
        return;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    // 部署脚本要在 Linux 上执行：无论本机检出成了 CRLF 还是 LF，打进包里一律 LF，
    // 否则 shebang 会变成 "#!/usr/bin/env bash\r" 直接 bad interpreter。
    if (/\.(sh|service)$/.test(from)) {
        fs.writeFileSync(to, fs.readFileSync(from, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
        return;
    }
    fs.copyFileSync(from, to);
}

for (const name of include) {
    const from = path.join(sourceDir, name);
    if (!fs.existsSync(from)) throw new Error(`缺少待打包文件：${name}`);
    copyRecursive(from, path.join(stageDir, name));
}
// 可执行位（Windows 上 copyFileSync 不保留，显式补上，免得服务器上还要 chmod）
fs.chmodSync(path.join(stageDir, 'deploy', 'install.sh'), 0o755);

fs.mkdirSync(releaseDir, { recursive: true });
const tgzPath = path.join(releaseDir, `${bundleName}.tgz`);
const tarResult = spawnSync('tar', ['-czf', tgzPath, '-C', stageRoot, bundleName], { stdio: 'inherit' });
if (tarResult.status !== 0) throw new Error('tar 打包失败');

const outputs = [tgzPath];
if (process.argv.includes('--zip')) {
    const zipPath = path.join(releaseDir, `${bundleName}.zip`);
    const zipResult = spawnSync('tar', ['-a', '-cf', zipPath, '-C', stageRoot, bundleName], { stdio: 'inherit' });
    if (zipResult.status === 0) outputs.push(zipPath);
    else console.warn('（zip 打包失败，可忽略：服务器上用 tgz 即可）');
}

const listFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : [full];
});
const files = listFiles(stageDir).map(file => path.relative(stageDir, file).split(path.sep).join('/')).sort();

console.log(`部署包已生成（解压后目录名 ${bundleName}/）：`);
for (const output of outputs) {
    const size = fs.statSync(output).size;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
    console.log(`  ${path.relative(root, output)}  ${(size / 1024).toFixed(1)} KB`);
    console.log(`    SHA256 ${hash}`);
}
console.log(`  共 ${files.length} 个文件：${files.join(', ')}`);
fs.rmSync(stageRoot, { recursive: true, force: true });
