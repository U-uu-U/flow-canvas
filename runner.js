const { spawn } = require('child_process');

console.log('>>> [Runner] Spawning Electron with clean environment...');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const proc = spawn('npm', ['run', 'electron:dev'], {
    env,
    stdio: 'inherit',
    shell: true,
    cwd: __dirname
});

proc.on('close', (code) => {
    console.log(`>>> [Runner] Electron exited with code ${code}`);
});
