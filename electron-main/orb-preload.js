const { ipcRenderer, webUtils } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('orbButton');
    if (!button) return;

    let restoring = false;
    let dragging = false;
    let dragPointerId = null;
    let dragStart = null;
    let dragMoved = false;
    let dragDepth = 0;
    let dropStateTimer = null;

    const setDropState = (state = '') => {
        clearTimeout(dropStateTimer);
        button.classList.remove('drop-target', 'drop-success', 'drop-error');
        if (state) button.classList.add(state);
    };

    const getDroppedFilePath = (file) => {
        if (!file) return '';
        if (typeof file.path === 'string' && file.path) return file.path;
        try {
            return webUtils?.getPathForFile?.(file) || '';
        } catch (_) {
            return '';
        }
    };

    const getTransferText = (dataTransfer, type) => {
        try {
            return String(dataTransfer?.getData?.(type) || '').trim();
        } catch (_) {
            return '';
        }
    };

    const collectHttpUrls = (value) => String(value || '')
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#') && /^https?:\/\//i.test(line));

    const getDroppedPayload = (dataTransfer) => {
        const filePaths = Array.from(dataTransfer?.files || [])
            .map(getDroppedFilePath)
            .filter(Boolean);
        const urls = collectHttpUrls(getTransferText(dataTransfer, 'text/uri-list'));
        const html = getTransferText(dataTransfer, 'text/html');

        if (html) {
            try {
                const document = new DOMParser().parseFromString(html, 'text/html');
                document.querySelectorAll('img[src]').forEach(image => {
                    const src = image.getAttribute('src') || '';
                    if (/^https?:\/\//i.test(src)) urls.push(src);
                });
            } catch (_) { }
        }

        if (urls.length === 0) {
            urls.push(...collectHttpUrls(getTransferText(dataTransfer, 'text/plain')));
        }

        return {
            filePaths: Array.from(new Set(filePaths)),
            urls: Array.from(new Set(urls)).slice(0, 20)
        };
    };

    const stopDragging = () => {
        if (!dragging) return;
        dragging = false;
        dragPointerId = null;
        dragStart = null;
        dragMoved = false;
        button.classList.remove('dragging');
        ipcRenderer.send('window:stopOrbDrag');
    };

    const resetInteraction = () => {
        stopDragging();
        restoring = false;
        button.classList.remove('restoring', 'dragging');
    };

    const restoreFromOrb = async () => {
        if (restoring || dragging) return;
        restoring = true;
        button.classList.add('restoring');
        try {
            await ipcRenderer.invoke('window:restoreFromOrb');
        } catch (err) {
            console.error('[Orb] Failed to restore Flow Canvas:', err);
        } finally {
            button.classList.remove('restoring');
            restoring = false;
        }
    };

    button.addEventListener('pointerdown', event => {
        if (event.button !== 0 || restoring) return;
        event.preventDefault();
        dragging = true;
        dragPointerId = event.pointerId;
        dragStart = { x: event.screenX, y: event.screenY };
        dragMoved = false;
        button.classList.add('dragging');
        button.setPointerCapture(event.pointerId);
        ipcRenderer.send('window:startOrbDrag');
    });

    button.addEventListener('pointermove', event => {
        if (!dragging || event.pointerId !== dragPointerId) return;
        event.preventDefault();
        if (dragStart && Math.hypot(event.screenX - dragStart.x, event.screenY - dragStart.y) >= 4) {
            dragMoved = true;
        }
    });

    button.addEventListener('pointerup', event => {
        if (event.pointerId !== dragPointerId) return;
        event.preventDefault();
        const moved = dragMoved || (dragStart
            && Math.hypot(event.screenX - dragStart.x, event.screenY - dragStart.y) >= 4);
        if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
        stopDragging();
        if (!moved) void restoreFromOrb();
    });
    button.addEventListener('pointercancel', stopDragging);
    button.addEventListener('lostpointercapture', stopDragging);
    button.addEventListener('contextmenu', event => event.preventDefault());
    window.addEventListener('blur', stopDragging);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') resetInteraction();
    });

    window.addEventListener('dragenter', event => {
        event.preventDefault();
        dragDepth += 1;
        setDropState('drop-target');
    });

    window.addEventListener('dragover', event => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    });

    window.addEventListener('dragleave', event => {
        event.preventDefault();
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) setDropState();
    });

    window.addEventListener('drop', async event => {
        event.preventDefault();
        event.stopPropagation();
        dragDepth = 0;

        const payload = getDroppedPayload(event.dataTransfer);
        if (payload.filePaths.length === 0 && payload.urls.length === 0) {
            setDropState('drop-error');
            dropStateTimer = setTimeout(() => setDropState(), 900);
            return;
        }

        try {
            const result = await ipcRenderer.invoke('window:queueOrbFiles', payload);
            setDropState(result?.accepted > 0 ? 'drop-success' : 'drop-error');
        } catch (err) {
            console.error('[Orb] Failed to queue dropped files:', err);
            setDropState('drop-error');
        }
        dropStateTimer = setTimeout(() => setDropState(), 900);
    });

});
