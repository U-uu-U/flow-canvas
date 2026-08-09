const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const MAX_EVENT_FILE_BYTES = 5 * 1024 * 1024;
let inputBuffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function dataDirCandidates() {
  return [
    process.env.FLOW_CANVAS_DATA_DIR,
    process.env.APPDATA && path.join(process.env.APPDATA, 'flow-canvas', 'data'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'Flow Canvas', 'data')
  ].filter(Boolean);
}

function resolveDataDir() {
  const candidates = dataDirCandidates();
  return candidates.find(dir => fs.existsSync(path.join(dir, 'board.json')))
    || candidates[0]
    || path.join(process.cwd(), 'flow-canvas-data');
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function boardContext() {
  const dataDir = resolveDataDir();
  const board = readJson(path.join(dataDir, 'board.json'), {});
  const groups = Array.isArray(board.folderGroups) ? board.folderGroups : [];
  const activeGroup = groups.find(group => group.id === board.activeGroupId) || null;
  const folders = Array.isArray(activeGroup?.folders) ? activeGroup.folders : [];
  const targetFolder = activeGroup?.defaultSaveFolder
    || folders[0]
    || board.defaultSaveFolder
    || board.watchFolders?.[0]
    || null;
  return {
    dataDir,
    activeGroupId: activeGroup?.id || null,
    activeGroupName: activeGroup?.name || null,
    folders,
    targetFolder
  };
}

function resolveTask(remoteTaskId) {
  const context = boardContext();
  const routes = readJson(path.join(context.dataDir, 'browser-task-routes.json'), {});
  const route = routes[String(remoteTaskId || '')] || null;
  return {
    ...context,
    hasRoute: Boolean(route),
    clientTaskId: route?.clientTaskId || null,
    targetFolder: route?.targetDir || context.targetFolder,
    route
  };
}

function uniqueTarget(targetFolder, sourcePath) {
  fs.mkdirSync(targetFolder, { recursive: true });
  const parsed = path.parse(path.basename(sourcePath));
  let candidate = path.join(targetFolder, parsed.base);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(targetFolder, `${parsed.name} (${index})${parsed.ext}`);
    index += 1;
  }
  return candidate;
}

function moveVerified(source, targetFolder) {
  if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`下载文件不存在: ${source || '(empty)'}`);
  }
  if (!targetFolder || !path.isAbsolute(targetFolder)) {
    throw new Error('Flow Canvas 没有可用的目标目录');
  }
  const target = uniqueTarget(targetFolder, source);
  fs.copyFileSync(source, target);
  const sourceSize = fs.statSync(source).size;
  const targetSize = fs.statSync(target).size;
  if (sourceSize !== targetSize) {
    try { fs.unlinkSync(target); } catch (_) { }
    throw new Error('文件复制校验失败，已保留下载目录原文件');
  }
  fs.unlinkSync(source);
  return target;
}

function appendEvent(event) {
  const context = boardContext();
  fs.mkdirSync(context.dataDir, { recursive: true });
  const eventPath = path.join(context.dataDir, 'browser-task-events.jsonl');
  const route = resolveTask(event.remoteTaskId);
  const payload = {
    ...event,
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    clientTaskId: event.clientTaskId || route.clientTaskId || null,
    targetDir: event.targetDir || route.targetFolder || null,
    model: event.model || route.route?.model || '',
    prompt: event.prompt || route.route?.prompt || '',
    createdAt: event.createdAt || route.route?.createdAt || null
  };
  fs.appendFileSync(eventPath, `${JSON.stringify(payload)}\n`, 'utf8');
  try {
    if (fs.statSync(eventPath).size > MAX_EVENT_FILE_BYTES) {
      const lines = fs.readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-1000);
      fs.writeFileSync(eventPath, `${lines.join('\n')}\n`, 'utf8');
    }
  } catch (_) { }
  return payload;
}

async function handle(message) {
  switch (message?.action) {
    case 'ping':
      return { success: true, version: '1.0.0', dataDir: resolveDataDir() };
    case 'flow_context':
      return { success: true, ...boardContext() };
    case 'resolve_task':
      return { success: true, ...resolveTask(message.remoteTaskId) };
    case 'notify_task': {
      const event = appendEvent(message.event || {});
      return { success: true, eventId: event.eventId };
    }
    case 'archive_task_download': {
      const task = message.task || {};
      const route = resolveTask(task.remoteTaskId);
      const targetFolder = message.targetFolder || route.targetFolder;
      const target = moveVerified(message.source, targetFolder);
      const event = appendEvent({
        remoteTaskId: task.remoteTaskId,
        logId: task.logId,
        status: 'imported',
        model: task.model,
        prompt: task.prompt || '',
        createdAt: task.createdAt,
        sourceHost: task.sourceHost,
        filePath: target,
        targetDir: targetFolder
      });
      return { success: true, target, eventId: event.eventId };
    }
    case 'archive_download': {
      const target = moveVerified(message.source, message.targetFolder);
      return { success: true, target };
    }
    case 'open_in_explorer':
      execFile('explorer.exe', ['/select,', message.path], { windowsHide: true });
      return { success: true };
    default:
      return { success: false, error: `未知操作: ${message?.action || '(empty)'}` };
  }
}

async function consumeFrames() {
  while (inputBuffer.length >= 4) {
    const length = inputBuffer.readUInt32LE(0);
    if (inputBuffer.length < 4 + length) return;
    const frame = inputBuffer.subarray(4, 4 + length);
    inputBuffer = inputBuffer.subarray(4 + length);
    try {
      const response = await handle(JSON.parse(frame.toString('utf8')));
      send(response);
    } catch (error) {
      send({ success: false, error: error?.message || String(error) });
    }
  }
}

process.stdin.on('data', chunk => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  consumeFrames().catch(error => send({ success: false, error: error.message }));
});
