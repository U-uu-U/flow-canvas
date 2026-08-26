const CATEGORY_OPTIONS = ['角色', '场景', '道具', '风格', '音效', 'Others'];
const MAX_SCAN_ITEMS = 360;

const dom = {
  pageTitle: document.getElementById('pageTitle'),
  connectionDot: document.getElementById('connectionDot'),
  library: document.getElementById('librarySelect'),
  folder: document.getElementById('folderSelect'),
  scan: document.getElementById('scanBtn'),
  capture: document.getElementById('captureBtn'),
  autoScroll: document.getElementById('autoScrollInput'),
  filterLowRes: document.getElementById('filterLowResInput'),
  autoClassify: document.getElementById('autoClassifyInput'),
  categoryChips: document.getElementById('categoryChips'),
  count: document.getElementById('countText'),
  selectAll: document.getElementById('selectAllBtn'),
  clear: document.getElementById('clearBtn'),
  grid: document.getElementById('assetGrid'),
  status: document.getElementById('statusText'),
  import: document.getElementById('importBtn')
};

let context = null;
let page = null;
let assets = [];
let selected = new Set();
let selectedCategories = new Set();

function request(message) {
  return chrome.runtime.sendMessage(message);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function setStatus(text, type = '') {
  dom.status.textContent = text || '';
  dom.status.className = type;
}

function mediaName(item) {
  if (item?.name) return item.name;
  if (/^data:/i.test(String(item?.url || ''))) return item.kind === 'image' ? '页面画面.png' : '网页素材';
  try {
    const name = decodeURIComponent(new URL(item.url).pathname.split('/').filter(Boolean).pop() || '');
    return name || new URL(item.url).hostname;
  } catch (_) {
    return '网页素材';
  }
}

function assetKey(item) {
  return String(item?.sourceUrl || item?.url || '');
}

function isLowResolution(item) {
  if (item.kind !== 'image' || /^data:/i.test(String(item.url || ''))) return false;
  const width = Number(item.width || 0);
  const height = Number(item.height || 0);
  return (width > 0 && width < 320) || (height > 0 && height < 320);
}

function visibleAssets() {
  return dom.filterLowRes.checked ? assets.filter(item => !isLowResolution(item)) : assets;
}

function renderCategories() {
  dom.categoryChips.innerHTML = CATEGORY_OPTIONS.map(category => (
    `<button class="category-chip ${selectedCategories.has(category) ? 'active' : ''}" type="button" data-category="${category}">${category}</button>`
  )).join('');
}

function renderTargets() {
  const libraries = Array.isArray(context?.libraries) ? context.libraries : [];
  dom.library.innerHTML = libraries.length
    ? libraries.map(library => `<option value="${escapeHtml(library.id)}">${escapeHtml(library.name)}</option>`).join('')
    : '<option value="">没有可用素材库</option>';
  const active = libraries.find(library => library.id === context?.activeGroupId) || libraries[0];
  if (active) dom.library.value = active.id;
  renderFolders();
}

function renderFolders() {
  const library = (context?.libraries || []).find(item => item.id === dom.library.value);
  const folders = Array.isArray(library?.folders) ? library.folders : [];
  dom.folder.innerHTML = folders.length
    ? folders.map(folder => `<option value="${escapeHtml(folder)}">${escapeHtml(folder.split(/[\\/]/).filter(Boolean).pop() || folder)}</option>`).join('')
    : '<option value="">请先在 Flow Canvas 关联目录</option>';
  if (library?.defaultFolder && folders.includes(library.defaultFolder)) dom.folder.value = library.defaultFolder;
  dom.import.disabled = selected.size === 0 || !folders.length;
}

function renderGrid() {
  const visible = visibleAssets();
  const visibleKeys = new Set(visible.map(assetKey));
  selected = new Set([...selected].filter(key => visibleKeys.has(key)));
  dom.count.textContent = assets.length
    ? `${visible.length} 项素材 · 已选 ${selected.size}${visible.length !== assets.length ? ` · 隐藏 ${assets.length - visible.length}` : ''}`
    : '未发现可用素材';
  dom.import.disabled = selected.size === 0 || !dom.folder.value;
  if (!visible.length) {
    dom.grid.className = 'asset-grid empty';
    dom.grid.innerHTML = '<div class="empty-state">没有扫描到符合条件的素材。可关闭小图过滤后再看一次。</div>';
    return;
  }
  dom.grid.className = 'asset-grid';
  dom.grid.innerHTML = visible.map((item, index) => {
    const key = assetKey(item);
    const disabled = item.streamType === 'stream';
    const preview = item.kind === 'video'
      ? `<video src="${escapeHtml(item.url)}" muted playsinline preload="metadata"></video>`
      : item.kind === 'audio'
        ? '<span class="media-fallback">AUDIO</span>'
        : `<img src="${escapeHtml(item.url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`;
    const size = item.width || item.height ? `${item.width || '?'}×${item.height || '?'}` : '';
    const badge = item.streamType === 'stream' ? '流媒体' : String(item.kind || 'image').toUpperCase();
    return `<article class="asset-card ${selected.has(key) ? 'selected' : ''} ${disabled ? 'disabled' : ''}" data-index="${index}" title="${escapeHtml(item.url)}">
      <div class="asset-thumb">${preview}<span class="asset-check">✓</span><span class="asset-kind">${badge}</span></div>
      <div class="asset-meta"><span class="asset-name">${escapeHtml(mediaName(item))}</span><span class="asset-size">${escapeHtml(size)}</span></div>
    </article>`;
  }).join('');
}

function mergeAssets(items) {
  const merged = new Map(assets.map(item => [assetKey(item), item]));
  (items || []).forEach(item => {
    const key = assetKey(item);
    if (!key || merged.has(key) || merged.size >= MAX_SCAN_ITEMS) return;
    merged.set(key, item);
  });
  assets = [...merged.values()];
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('没有可扫描的当前标签页');
  return tab;
}

async function loadLongPage(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const originalX = window.scrollX;
      const originalY = window.scrollY;
      const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const steps = Math.min(14, Math.max(2, Math.ceil(maxY / Math.max(window.innerHeight * .85, 500))));
      for (let step = 0; step <= steps; step += 1) {
        window.scrollTo(originalX, Math.round(maxY * step / steps));
        await new Promise(resolve => setTimeout(resolve, 230));
      }
      window.scrollTo(originalX, originalY);
    }
  });
}

async function scanFrame() {
  const found = new Map();
  const absoluteUrl = value => {
    try {
      const url = new URL(String(value || ''), document.baseURI).href;
      return /^(?:https?:|blob:|data:image\/)/i.test(url) ? url : '';
    } catch (_) { return ''; }
  };
  const add = (value, kind = 'image', width = 0, height = 0, name = '') => {
    const url = absoluteUrl(value);
    if (!url || found.has(url) || found.size >= 280) return;
    found.set(url, { url, sourceUrl: url, kind, width: Number(width || 0), height: Number(height || 0), name });
  };
  const bestSrcset = value => {
    const entries = String(value || '').split(',').map(part => {
      const match = part.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/);
      return match ? { url: match[1], score: Number(match[2] || 1) } : null;
    }).filter(Boolean).sort((left, right) => right.score - left.score);
    return entries[0]?.url || '';
  };
  const scanRoot = root => {
    root.querySelectorAll('img').forEach(image => {
      add(bestSrcset(image.getAttribute('srcset')) || image.currentSrc || image.src || image.getAttribute('data-src') || image.getAttribute('data-original'), 'image', image.naturalWidth || image.width, image.naturalHeight || image.height, image.alt);
    });
    root.querySelectorAll('picture source[srcset]').forEach(source => add(bestSrcset(source.srcset), 'image'));
    root.querySelectorAll('video, audio').forEach(media => add(media.currentSrc || media.src || media.poster, media.tagName === 'AUDIO' ? 'audio' : 'video', media.videoWidth, media.videoHeight));
    root.querySelectorAll('video source, audio source').forEach(source => add(source.src, source.closest('audio') ? 'audio' : 'video'));
    root.querySelectorAll('svg image').forEach(image => add(image.getAttribute('href') || image.getAttributeNS('http://www.w3.org/1999/xlink', 'href'), 'image'));
    root.querySelectorAll('canvas').forEach((canvas, index) => {
      if (!canvas.width || !canvas.height || canvas.width < 120 || canvas.height < 120) return;
      try { add(canvas.toDataURL('image/png'), 'image', canvas.width, canvas.height, `canvas-${index + 1}.png`); } catch (_) { }
    });
    [...root.querySelectorAll('*')].slice(0, 5000).forEach(element => {
      let background = '';
      try { background = getComputedStyle(element).backgroundImage; } catch (_) { }
      for (const match of String(background || '').matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(match[1], 'image');
      if (element.shadowRoot) scanRoot(element.shadowRoot);
    });
  };
  scanRoot(document);
  return [...found.values()].map(item => ({
    ...item,
    pageUrl: location.href,
    pageTitle: document.title
  }));
}

async function scanPage() {
  dom.scan.disabled = true;
  dom.scan.textContent = '扫描中...';
  setStatus('正在读取页面中的图片和媒体请求');
  try {
    page = await activeTab();
    if (dom.autoScroll.checked) await loadLongPage(page.id);
    const [frameResults, networkResult] = await Promise.all([
      chrome.scripting.executeScript({ target: { tabId: page.id, allFrames: true }, func: scanFrame }),
      request({ type: 'GET_CAPTURE_MEDIA', tabId: page.id })
    ]);
    assets = [];
    selected.clear();
    frameResults.forEach(frame => mergeAssets(Array.isArray(frame.result) ? frame.result : []));
    mergeAssets((networkResult?.items || []).map(item => ({ ...item, pageUrl: page.url, pageTitle: page.title })));
    dom.pageTitle.textContent = page.title || page.url || '当前页面';
    renderGrid();
    setStatus(assets.length ? `扫描完成，找到 ${assets.length} 项素材` : '当前页面没有发现可导入素材', assets.length ? 'success' : '');
  } catch (error) {
    setStatus(error?.message || String(error), 'error');
    assets = [];
    selected.clear();
    renderGrid();
  } finally {
    dom.scan.disabled = false;
    dom.scan.textContent = '扫描当前页面';
  }
}

async function captureVisiblePage() {
  try {
    page = await activeTab();
    const dataUrl = await chrome.tabs.captureVisibleTab(page.windowId, { format: 'png' });
    const dimensions = await new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolve({ width: 0, height: 0 });
      image.src = dataUrl;
    });
    mergeAssets([{
      url: dataUrl,
      sourceUrl: `screenshot:${page.url || ''}`,
      kind: 'image',
      name: `网页截屏-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
      pageUrl: page.url || '',
      pageTitle: page.title || '',
      ...dimensions
    }]);
    selected.add(assetKey(assets.at(-1)));
    renderGrid();
    setStatus('已加入当前可见画面', 'success');
  } catch (error) {
    setStatus(error?.message || String(error), 'error');
  }
}

async function blobUrlAsData(tabId, url) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: async targetUrl => {
      try {
        const response = await fetch(targetUrl);
        if (!response.ok) return null;
        const blob = await response.blob();
        if (blob.size > 256 * 1024 * 1024) throw new Error('素材超过 256 MB');
        return await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      } catch (_) { return null; }
    },
    args: [url]
  });
  return results.map(result => result.result).find(Boolean) || null;
}

async function prepareAsset(item) {
  if (/^blob:/i.test(String(item.url || ''))) {
    const tab = page || await activeTab();
    const dataUrl = await blobUrlAsData(tab.id, item.url);
    if (!dataUrl) throw new Error('网页已释放这项临时素材，请重新扫描后再导入');
    return { ...item, dataUrl };
  }
  return item;
}

async function importSelected() {
  const chosen = assets.filter(item => selected.has(assetKey(item)) && item.streamType !== 'stream');
  if (!chosen.length) return;
  dom.import.disabled = true;
  dom.scan.disabled = true;
  let importedCount = 0;
  const failures = [];
  try {
    for (let index = 0; index < chosen.length; index += 1) {
      const item = chosen[index];
      setStatus(`正在导入 ${index + 1}/${chosen.length} · ${mediaName(item)}`);
      try {
        const prepared = await prepareAsset(item);
        const result = await request({
          type: 'IMPORT_CAPTURE_ASSETS',
          libraryId: dom.library.value,
          targetFolder: dom.folder.value,
          categories: [...selectedCategories],
          autoClassify: dom.autoClassify.checked,
          assets: [prepared]
        });
        if (!result?.success) throw new Error(result?.errors?.[0]?.error || result?.error || '导入失败');
        importedCount += result.imported?.length || 1;
        selected.delete(assetKey(item));
      } catch (error) {
        failures.push(`${mediaName(item)}: ${error?.message || String(error)}`);
      }
    }
    renderGrid();
    if (failures.length) {
      setStatus(`已导入 ${importedCount} 项，${failures.length} 项失败：${failures[0]}`, 'error');
    } else {
      setStatus(`已导入 ${importedCount} 项，Flow Canvas 素材库会自动刷新`, 'success');
    }
  } finally {
    dom.scan.disabled = false;
    dom.import.disabled = selected.size === 0 || !dom.folder.value;
  }
}

dom.library.addEventListener('change', renderFolders);
dom.filterLowRes.addEventListener('change', renderGrid);
dom.scan.addEventListener('click', scanPage);
dom.capture.addEventListener('click', captureVisiblePage);
dom.import.addEventListener('click', importSelected);
dom.categoryChips.addEventListener('click', event => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  const category = button.dataset.category;
  if (selectedCategories.has(category)) selectedCategories.delete(category);
  else selectedCategories.add(category);
  renderCategories();
});
dom.grid.addEventListener('click', event => {
  const card = event.target.closest('.asset-card');
  if (!card || card.classList.contains('disabled')) return;
  const item = visibleAssets()[Number(card.dataset.index)];
  const key = assetKey(item);
  if (selected.has(key)) selected.delete(key);
  else selected.add(key);
  renderGrid();
});
dom.selectAll.addEventListener('click', () => {
  visibleAssets().filter(item => item.streamType !== 'stream').forEach(item => selected.add(assetKey(item)));
  renderGrid();
});
dom.clear.addEventListener('click', () => {
  selected.clear();
  renderGrid();
});

async function initialize() {
  renderCategories();
  context = await request({ type: 'GET_CAPTURE_CONTEXT' });
  dom.connectionDot.classList.toggle('connected', context?.success === true);
  if (!context?.success) {
    setStatus(context?.error || '未连接 Native Host，请重新运行插件安装脚本', 'error');
    renderTargets();
    return;
  }
  renderTargets();
  const tab = await activeTab().catch(() => null);
  if (tab) {
    page = tab;
    dom.pageTitle.textContent = tab.title || tab.url || '当前页面';
  }
  setStatus(context.libraries?.length ? '已连接 Flow Canvas 素材库' : 'Flow Canvas 素材库不可用');
}

initialize().catch(error => setStatus(error?.message || String(error), 'error'));
