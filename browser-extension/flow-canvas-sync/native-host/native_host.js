const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const MAX_EVENT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const ASSET_METADATA_SUFFIX = '.flow-asset.json';
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
    process.env.APPDATA && path.join(process.env.APPDATA, 'Flow Canvas', 'data'),
    process.env.HOME && path.join(process.env.HOME, 'Library', 'Application Support', 'flow-canvas', 'data'),
    process.env.HOME && path.join(process.env.HOME, 'Library', 'Application Support', 'Flow Canvas', 'data')
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
  const managedFolder = path.join(dataDir, 'asset-library');
  fs.mkdirSync(managedFolder, { recursive: true });
  const configuredFolders = Array.isArray(board?.assetLibrary?.folders)
    ? board.assetLibrary.folders.filter(folder => typeof folder === 'string' && folder.trim())
    : [];
  const libraryFolders = [...new Set([managedFolder, ...configuredFolders])];
  const libraryDefault = libraryFolders.includes(board?.assetLibrary?.defaultFolder)
    ? board.assetLibrary.defaultFolder
    : managedFolder;
  const libraries = [{
    id: 'flow-asset-library',
    name: '素材库',
    folders: libraryFolders,
    defaultFolder: libraryDefault
  }];
  return {
    dataDir,
    activeGroupId: activeGroup?.id || null,
    activeGroupName: activeGroup?.name || null,
    folders,
    targetFolder,
    libraries
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

function uniqueTargetName(targetFolder, fileName) {
  fs.mkdirSync(targetFolder, { recursive: true });
  const parsed = path.parse(path.basename(fileName || 'web-asset'));
  const safeName = (parsed.name || 'web-asset')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 120) || 'web-asset';
  const safeExtension = String(parsed.ext || '').replace(/[^.a-zA-Z0-9]/g, '').slice(0, 12);
  let candidate = path.join(targetFolder, `${safeName}${safeExtension}`);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(targetFolder, `${safeName} (${index})${safeExtension}`);
    index += 1;
  }
  return candidate;
}

function normalizedPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function resolveLibraryTarget(libraryId, requestedFolder) {
  const context = boardContext();
  const library = context.libraries.find(item => item.id === String(libraryId || ''))
    || context.libraries[0];
  if (!library) throw new Error('Flow Canvas 没有可用的素材库');
  const allowedFolders = library.folders.filter(folder => path.isAbsolute(folder));
  const targetFolder = requestedFolder || library.defaultFolder;
  if (!targetFolder || !allowedFolders.some(folder => normalizedPath(folder) === normalizedPath(targetFolder))) {
    throw new Error('目标目录不属于所选 Flow Canvas 素材库');
  }
  fs.mkdirSync(targetFolder, { recursive: true });
  return { context, library, targetFolder };
}

const EXTENSION_BY_CONTENT_TYPE = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/apng': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac'
};

function extensionForAsset(item, contentType) {
  const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (EXTENSION_BY_CONTENT_TYPE[mime]) return EXTENSION_BY_CONTENT_TYPE[mime];
  for (const value of [item?.name, item?.url]) {
    try {
      const pathname = /^https?:/i.test(String(value || '')) ? new URL(value).pathname : String(value || '');
      const extension = path.extname(pathname).toLowerCase();
      if (/^\.(?:jpe?g|png|webp|gif|bmp|tiff?|svg|mp4|webm|mov|m4v|mp3|m4a|wav|ogg|flac|aac)$/.test(extension)) {
        return extension === '.jpeg' ? '.jpg' : extension;
      }
    } catch (_) { }
  }
  if (String(item?.kind || '') === 'video') return '.mp4';
  if (String(item?.kind || '') === 'audio') return '.mp3';
  return '.bin';
}

function baseNameForAsset(item, extension) {
  let candidate = String(item?.name || '').trim();
  if (!candidate && /^https?:/i.test(String(item?.url || ''))) {
    try { candidate = decodeURIComponent(path.basename(new URL(item.url).pathname)); } catch (_) { }
  }
  const parsed = path.parse(candidate || '');
  const base = parsed.name || `web_${crypto.createHash('md5').update(String(item?.url || Date.now())).digest('hex').slice(0, 10)}`;
  return `${base}${extension}`;
}

function decodeDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/i);
  if (!match) throw new Error('无效的 data URL');
  const contentType = match[1] || 'application/octet-stream';
  const buffer = match[2]
    ? Buffer.from(match[3], 'base64')
    : Buffer.from(decodeURIComponent(match[3]), 'utf8');
  if (buffer.length === 0) throw new Error('素材内容为空');
  if (buffer.length > MAX_ASSET_BYTES) throw new Error('素材超过 256 MB');
  return { buffer, contentType };
}

function requestBuffer(url, headers = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 6) {
      reject(new Error('素材地址跳转次数过多'));
      return;
    }
    let parsed;
    try { parsed = new URL(url); } catch (_) {
      reject(new Error('素材地址无效'));
      return;
    }
    const transport = parsed.protocol === 'https:' ? https : http;
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reject(new Error(`不支持的素材协议: ${parsed.protocol}`));
      return;
    }
    const request = transport.get(parsed, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,video/*,audio/*,*/*;q=0.6',
        ...headers
      }
    }, response => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, parsed).toString();
        requestBuffer(nextUrl, headers, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status || '请求失败'}`));
        return;
      }
      const contentLength = Number(response.headers['content-length'] || 0);
      if (contentLength > MAX_ASSET_BYTES) {
        response.destroy();
        reject(new Error('素材超过 256 MB'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_ASSET_BYTES) {
          response.destroy(new Error('素材超过 256 MB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (size === 0) {
          reject(new Error('素材内容为空'));
          return;
        }
        resolve({
          buffer: Buffer.concat(chunks),
          contentType: String(response.headers['content-type'] || '').split(';', 1)[0].trim(),
          finalUrl: parsed.toString()
        });
      });
      response.on('error', reject);
    });
    request.setTimeout(45000, () => request.destroy(new Error('素材下载超时')));
    request.on('error', reject);
  });
}

async function readAssetPayload(item) {
  const url = String(item?.dataUrl || item?.url || '').trim();
  if (/^data:/i.test(url)) return decodeDataUrl(url);
  if (!/^https?:/i.test(url)) throw new Error('此素材需要先在网页中转换后再导入');
  const referer = /^https?:/i.test(String(item?.pageUrl || '')) ? item.pageUrl : undefined;
  return requestBuffer(url, referer ? { Referer: referer } : {});
}

function writeAssetMetadata(filePath, item, options, library) {
  const selectedCategories = (Array.isArray(options?.categories) ? options.categories : [])
    .map(value => String(value || '').trim()).filter(Boolean);
  if (String(item?.kind || '') === 'audio' && selectedCategories.length === 0) selectedCategories.push('音效');
  const manualCategories = [...new Set(selectedCategories)].slice(0, 12);
  const metadata = {
    schemaVersion: 1,
    assetPath: filePath,
    libraryId: library.id,
    libraryName: library.name,
    source: {
      url: String(item?.sourceUrl || item?.url || ''),
      pageUrl: String(item?.pageUrl || ''),
      pageTitle: String(item?.pageTitle || ''),
      kind: String(item?.kind || ''),
      width: Number(item?.width || 0),
      height: Number(item?.height || 0),
      capturedAt: new Date().toISOString()
    },
    categories: manualCategories,
    tags: manualCategories,
    classification: {
      status: options?.autoClassify ? 'pending' : 'manual',
      requestedAt: options?.autoClassify ? new Date().toISOString() : null,
      attempts: 0
    }
  };
  fs.writeFileSync(`${filePath}${ASSET_METADATA_SUFFIX}`, JSON.stringify(metadata, null, 2), 'utf8');
}

async function importAssets(message) {
  const { library, targetFolder } = resolveLibraryTarget(message.libraryId, message.targetFolder);
  const assets = (Array.isArray(message.assets) ? message.assets : []).slice(0, 80);
  if (assets.length === 0) throw new Error('没有选择要导入的素材');
  const imported = [];
  const errors = [];
  for (const item of assets) {
    const sourceUrl = String(item?.sourceUrl || item?.url || '').slice(0, 2048);
    try {
      if (item?.streamType === 'stream' || /\.(?:m3u8|mpd)(?:[?#]|$)/i.test(String(item?.url || ''))) {
        throw new Error('暂不支持直接导入流媒体清单');
      }
      const payload = await readAssetPayload(item);
      const extension = extensionForAsset(item, payload.contentType);
      if (extension === '.bin') throw new Error(`无法识别素材格式${payload.contentType ? ` (${payload.contentType})` : ''}`);
      const target = uniqueTargetName(targetFolder, baseNameForAsset(item, extension));
      fs.writeFileSync(target, payload.buffer);
      writeAssetMetadata(target, { ...item, sourceUrl }, message, library);
      imported.push({ sourceUrl, filePath: target });
    } catch (error) {
      errors.push({ sourceUrl, error: error?.message || String(error) });
    }
  }
  return {
    success: imported.length > 0,
    libraryId: library.id,
    targetFolder,
    imported,
    errors
  };
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
    case 'import_assets':
      return await importAssets(message);
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
      if (process.platform === 'darwin') {
        execFile('/usr/bin/open', ['-R', message.path]);
      } else {
        execFile('explorer.exe', ['/select,', message.path], { windowsHide: true });
      }
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
