(() => {
  'use strict';

  if (window.__flowCanvasTaskContent) return;
  window.__flowCanvasTaskContent = true;

  const REQUEST_TYPE = 'FLOW_CANVAS_TASK_SCAN_REQUEST';
  const RESPONSE_TYPE = 'FLOW_CANVAS_TASK_SCAN_RESPONSE';
  let requestCounter = 0;
  let timer = null;

  function scanNow() {
    requestCounter += 1;
    window.postMessage({
      type: REQUEST_TYPE,
      requestId: `${Date.now()}-${requestCounter}`
    }, location.origin);
  }

  function schedule() {
    clearInterval(timer);
    timer = setInterval(scanNow, document.hidden ? 30000 : 12000);
  }

  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type !== RESPONSE_TYPE) return;
    chrome.runtime.sendMessage({
      type: 'REMOTE_TASKS_SYNC',
      payload: event.data
    }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'FLOW_SYNC_SCAN_NOW') scanNow();
  });

  document.addEventListener('visibilitychange', () => {
    schedule();
    if (!document.hidden) scanNow();
  });

  schedule();
  scanNow();
})();
