const NATIVE_HOST = 'com.flow.canvas_sync';
const ROUTED_TASK_TAKEOVER_DELAY_MS = 60000;
const DEFAULT_SETTINGS = {
  enabled: true,
  autoDownload: true,
  downloadExisting: false,
  autoDownloadSince: Date.now(),
  archiveOtherDownloads: true,
  targetFolder: '',
  pathHistory: []
};

async function getState() {
  const stored = await chrome.storage.local.get(['settings', 'tasks', 'downloads']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(stored.settings || {}) },
    tasks: stored.tasks || {},
    downloads: stored.downloads || {}
  };
}

async function saveState(state) {
  const orderedTasks = Object.fromEntries(
    Object.entries(state.tasks)
      .sort((a, b) => String(b[1]?.updatedAt || '').localeCompare(String(a[1]?.updatedAt || '')))
      .slice(0, 500)
  );
  await chrome.storage.local.set({
    settings: state.settings,
    tasks: orderedTasks,
    downloads: state.downloads
  });
}

function sendNative(message) {
  return new Promise(resolve => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, message, response => {
      if (chrome.runtime.lastError) {
        resolve({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { success: false, error: 'Native Host 无响应' });
    });
  });
}

function taskKey(task) {
  return `${task.sourceHost || 'unknown'}:${task.remoteTaskId}`;
}

function selectVideoUrl(urls) {
  const candidates = (Array.isArray(urls) ? urls : []).filter(url => /^https?:\/\//i.test(url));
  return candidates.find(url => /\.(mp4|mov|webm|mkv)(?:$|[?#])/i.test(url)) || candidates[0] || null;
}

async function notifyTask(task, status = task.status, extra = {}) {
  return sendNative({
    action: 'notify_task',
    event: {
      remoteTaskId: task.remoteTaskId,
      logId: task.logId,
      status,
      model: task.model,
      prompt: task.prompt || '',
      createdAt: task.createdAt,
      sourceHost: task.sourceHost,
      error: task.error || null,
      downloadUrls: task.downloadUrls || [],
      ...extra
    }
  });
}

async function beginDownload(task, state) {
  const key = taskKey(task);
  const existing = state.tasks[key] || {};
  if (existing.downloadId || existing.filePath || existing.downloadStarted) return;
  const url = selectVideoUrl(task.downloadUrls);
  if (!url) return;

  const route = await sendNative({ action: 'resolve_task', remoteTaskId: task.remoteTaskId });
  if (route.hasRoute && route.route?.status === 'completed') {
    state.tasks[key] = {
      ...existing,
      ...task,
      status: 'imported',
      filePath: route.route.filePath || existing.filePath || null,
      downloadStarted: false,
      downloadId: null,
      updatedAt: new Date().toISOString()
    };
    return;
  }
  const readyAt = Number(existing.readyAt || Date.now());
  if (route.hasRoute && Date.now() - readyAt < ROUTED_TASK_TAKEOVER_DELAY_MS) return;
  const createdAt = new Date(task.createdAt || 0).getTime();
  const isNewTask = createdAt > 0 && createdAt >= Number(state.settings.autoDownloadSince || 0) - 60000;
  if (!route.hasRoute && !isNewTask && !state.settings.downloadExisting) return;

  try {
    const downloadId = await chrome.downloads.download({
      url,
      saveAs: false,
      conflictAction: 'uniquify'
    });
    state.downloads[String(downloadId)] = {
      key,
      remoteTaskId: task.remoteTaskId,
      sourceHost: task.sourceHost,
      targetFolder: route.targetFolder || null
    };
    state.tasks[key] = {
      ...existing,
      ...task,
      status: 'downloading',
      downloadStarted: true,
      downloadId,
      updatedAt: new Date().toISOString()
    };
    await saveState(state);
    await notifyTask(task, 'downloading', { targetDir: route.targetFolder || null });
  } catch (error) {
    state.tasks[key] = {
      ...existing,
      ...task,
      status: 'failed',
      error: error?.message || String(error),
      updatedAt: new Date().toISOString()
    };
    await saveState(state);
    await notifyTask(state.tasks[key], 'failed');
  }
}

async function mergeRemoteTasks(payload) {
  const state = await getState();
  if (!state.settings.enabled) return;
  for (const rawTask of Array.isArray(payload?.tasks) ? payload.tasks : []) {
    const task = { ...rawTask, sourceHost: payload.sourceHost || location?.host || 'unknown' };
    if (!task.remoteTaskId) continue;
    const key = taskKey(task);
    const previous = state.tasks[key] || null;
    const localStatus = ['downloading', 'imported'].includes(previous?.status)
      ? previous.status
      : task.status;
    const changed = !previous
      || previous.status !== localStatus
      || JSON.stringify(previous.downloadUrls || []) !== JSON.stringify(task.downloadUrls || []);
    state.tasks[key] = {
      ...(previous || {}),
      ...task,
      status: localStatus,
      readyAt: task.status === 'ready'
        ? (previous?.readyAt || Date.now())
        : previous?.readyAt,
      updatedAt: new Date().toISOString()
    };
    if (changed) await notifyTask(state.tasks[key]);
    if (state.settings.autoDownload && task.status === 'ready' && localStatus === 'ready') {
      await beginDownload(task, state);
    }
  }
  await saveState(state);
}

chrome.runtime.onInstalled.addListener(async () => {
  const state = await getState();
  if (!state.settings.autoDownloadSince) state.settings.autoDownloadSince = Date.now();
  await saveState(state);
  await sendNative({ action: 'ping' });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'REMOTE_TASKS_SYNC') {
    mergeRemoteTasks(message.payload).then(() => sendResponse({ success: true }));
    return true;
  }
  if (message?.type === 'GET_SYNC_STATE') {
    Promise.all([getState(), sendNative({ action: 'ping' })]).then(([state, native]) => {
      sendResponse({ ...state, nativeConnected: native.success === true });
    });
    return true;
  }
  if (message?.type === 'UPDATE_SYNC_SETTINGS') {
    getState().then(async state => {
      state.settings = { ...state.settings, ...(message.settings || {}) };
      await saveState(state);
      sendResponse({ success: true });
    });
    return true;
  }
  if (message?.type === 'SCAN_NOW') {
    chrome.tabs.query({ url: ['https://ai.ravenhash.org/*', 'https://art.ravenhash.org/*'] }).then(tabs => {
      tabs.forEach(tab => tab.id && chrome.tabs.sendMessage(tab.id, { type: 'FLOW_SYNC_SCAN_NOW' }).catch(() => {}));
      sendResponse({ success: true, tabs: tabs.length });
    });
    return true;
  }
});

chrome.downloads.onChanged.addListener(async delta => {
  if (!delta.state?.current || !['complete', 'interrupted'].includes(delta.state.current)) return;
  const state = await getState();
  const route = state.downloads[String(delta.id)];
  if (!route) {
    if (delta.state.current !== 'complete' || !state.settings.enabled
      || !state.settings.archiveOtherDownloads || !state.settings.targetFolder) return;
    const items = await chrome.downloads.search({ id: delta.id });
    const sourcePath = items?.[0]?.filename;
    if (!sourcePath) return;
    await sendNative({
      action: 'archive_download',
      source: sourcePath,
      targetFolder: state.settings.targetFolder
    });
    return;
  }
  const task = state.tasks[route.key];
  if (!task) return;

  if (delta.state.current === 'interrupted') {
    task.status = 'failed';
    task.error = '浏览器下载被中断';
    task.downloadStarted = false;
    delete state.downloads[String(delta.id)];
    await saveState(state);
    await notifyTask(task, 'failed');
    return;
  }

  const items = await chrome.downloads.search({ id: delta.id });
  const sourcePath = items?.[0]?.filename;
  if (!sourcePath) return;
  const result = await sendNative({
    action: 'archive_task_download',
    source: sourcePath,
    targetFolder: route.targetFolder,
    task
  });
  delete state.downloads[String(delta.id)];
  task.downloadStarted = false;
  task.downloadId = null;
  task.status = result.success ? 'imported' : 'failed';
  task.filePath = result.target || null;
  task.error = result.success ? null : result.error;
  task.updatedAt = new Date().toISOString();
  await saveState(state);
  if (!result.success) await notifyTask(task, 'failed');
});
