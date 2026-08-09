(() => {
  'use strict';

  if (window.__flowCanvasTaskPageBridge) return;
  window.__flowCanvasTaskPageBridge = true;

  const REQUEST_TYPE = 'FLOW_CANVAS_TASK_SCAN_REQUEST';
  const RESPONSE_TYPE = 'FLOW_CANVAS_TASK_SCAN_RESPONSE';
  const syncTimes = new Map();

  function getToken() {
    return sessionStorage.getItem('token') || localStorage.getItem('token') || '';
  }

  function taskStatus(task) {
    if (Array.isArray(task.preview_urls) && task.preview_urls.length > 0) return 'ready';
    if (task.billing_failed || task.error_message || Number(task.status_code) >= 400) return 'failed';
    if (task.is_completed === 1 || task.is_completed === true) return 'ready';
    return 'running';
  }

  function normalizeTask(task) {
    return {
      remoteTaskId: String(task.task_id || task.log_id || task.id || ''),
      logId: String(task.log_id || task.id || ''),
      status: taskStatus(task),
      model: String(task.model || ''),
      actionType: String(task.action_type || ''),
      createdAt: task.created_at || null,
      error: task.error_message || null,
      downloadUrls: Array.isArray(task.preview_urls)
        ? task.preview_urls.filter(url => typeof url === 'string' && /^https?:\/\//i.test(url))
        : []
    };
  }

  async function requestJson(url, options = {}) {
    const token = getToken();
    if (!token) throw new Error('NOT_LOGGED_IN');
    const response = await fetch(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      },
      credentials: 'same-origin'
    });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return response.json();
  }

  async function refreshPendingTasks(tasks) {
    const now = Date.now();
    const candidates = tasks
      .filter(task => task.task_id && task.log_id && taskStatus(task) === 'running')
      .filter(task => now - (syncTimes.get(String(task.log_id)) || 0) > 45000)
      .slice(0, 5);
    await Promise.allSettled(candidates.map(async task => {
      syncTimes.set(String(task.log_id), now);
      await requestJson(`/api/v1/task_logs/${encodeURIComponent(task.log_id)}/sync`, { method: 'POST' });
    }));
  }

  async function scanTasks(requestId) {
    try {
      const payload = await requestJson('/api/v1/task_logs?page=1&per_page=50&action_type=video');
      const tasks = Array.isArray(payload?.data) ? payload.data : [];
      refreshPendingTasks(tasks).catch(() => {});
      window.postMessage({
        type: RESPONSE_TYPE,
        requestId,
        sourceHost: location.host,
        tasks: tasks.map(normalizeTask).filter(task => task.remoteTaskId)
      }, location.origin);
    } catch (error) {
      window.postMessage({
        type: RESPONSE_TYPE,
        requestId,
        sourceHost: location.host,
        error: error?.message || String(error),
        tasks: []
      }, location.origin);
    }
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type !== REQUEST_TYPE) return;
    scanTasks(String(event.data.requestId || Date.now()));
  });
})();
