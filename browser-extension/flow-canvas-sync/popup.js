const enabled = document.getElementById('enabled');
const autoDownload = document.getElementById('autoDownload');
const downloadExisting = document.getElementById('downloadExisting');
const archiveOtherDownloads = document.getElementById('archiveOtherDownloads');
const targetFolder = document.getElementById('targetFolder');
const connectionText = document.getElementById('connectionText');
const connectionDot = document.getElementById('connectionDot');

async function request(message) {
  return chrome.runtime.sendMessage(message);
}

async function render() {
  const state = await request({ type: 'GET_SYNC_STATE' });
  enabled.checked = state.settings?.enabled !== false;
  autoDownload.checked = state.settings?.autoDownload !== false;
  downloadExisting.checked = state.settings?.downloadExisting === true;
  archiveOtherDownloads.checked = state.settings?.archiveOtherDownloads !== false;
  targetFolder.value = state.settings?.targetFolder || '';
  connectionDot.classList.toggle('connected', state.nativeConnected === true);
  connectionText.textContent = state.nativeConnected ? '已连接 Flow Canvas 本地服务' : 'Native Host 未连接';
  document.getElementById('taskCount').textContent = String(Object.keys(state.tasks || {}).length);
  document.getElementById('downloadCount').textContent = String(Object.keys(state.downloads || {}).length);
}

async function save() {
  await request({
    type: 'UPDATE_SYNC_SETTINGS',
    settings: {
      enabled: enabled.checked,
      autoDownload: autoDownload.checked,
      downloadExisting: downloadExisting.checked,
      archiveOtherDownloads: archiveOtherDownloads.checked,
      targetFolder: targetFolder.value.trim()
    }
  });
}

[enabled, autoDownload, downloadExisting, archiveOtherDownloads].forEach(input => input.addEventListener('change', save));
document.getElementById('applyFolder').addEventListener('click', save);
targetFolder.addEventListener('keydown', event => {
  if (event.key === 'Enter') save();
});
document.getElementById('scanNow').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  event.currentTarget.textContent = '同步中...';
  await request({ type: 'SCAN_NOW' });
  setTimeout(async () => {
    await render();
    event.currentTarget.disabled = false;
    event.currentTarget.textContent = '立即同步任务';
  }, 1200);
});
document.getElementById('openCapture').addEventListener('click', async event => {
  event.currentTarget.disabled = true;
  const result = await request({ type: 'OPEN_CAPTURE_PANEL' });
  if (!result?.success) {
    connectionText.textContent = result?.error || '无法打开素材采集侧栏';
    event.currentTarget.disabled = false;
    return;
  }
  window.close();
});

render();
