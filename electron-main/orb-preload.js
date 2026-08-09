const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('orbButton');
    if (!button) return;

    let restoring = false;
    let dragging = false;
    let dragPointerId = null;
    let dragDepth = 0;
    let dropStateTimer = null;

    const setDropState = (state = '') => {
        clearTimeout(dropStateTimer);
        button.classList.remove('drop-target', 'drop-success', 'drop-error');
        if (state) button.classList.add(state);
    };

    const getDroppedFilePaths = (dataTransfer) => {
        return Array.from(dataTransfer?.files || [])
            .map(file => file?.path)
            .filter(filePath => typeof filePath === 'string' && filePath.length > 0);
    };

    const stopDragging = () => {
        if (!dragging) return;
        dragging = false;
        dragPointerId = null;
        button.classList.remove('dragging');
        ipcRenderer.send('window:stopOrbDrag');
    };

    const resetInteraction = () => {
        stopDragging();
        restoring = false;
        button.classList.remove('restoring', 'dragging');
    };

    button.addEventListener('pointerdown', event => {
        if (event.button === 0 && dragging) stopDragging();
        if (event.button !== 2 || restoring) return;
        event.preventDefault();
        dragging = true;
        dragPointerId = event.pointerId;
        button.classList.add('dragging');
        button.setPointerCapture(event.pointerId);
        ipcRenderer.send('window:startOrbDrag');
    });

    button.addEventListener('pointermove', event => {
        if (!dragging || event.pointerId !== dragPointerId) return;
        event.preventDefault();
    });

    button.addEventListener('pointerup', event => {
        if (event.pointerId !== dragPointerId) return;
        event.preventDefault();
        if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
        stopDragging();
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

        const filePaths = getDroppedFilePaths(event.dataTransfer);
        if (filePaths.length === 0) {
            setDropState('drop-error');
            dropStateTimer = setTimeout(() => setDropState(), 900);
            return;
        }

        try {
            const result = await ipcRenderer.invoke('window:queueOrbFiles', filePaths);
            setDropState(result?.accepted > 0 ? 'drop-success' : 'drop-error');
        } catch (err) {
            console.error('[Orb] Failed to queue dropped files:', err);
            setDropState('drop-error');
        }
        dropStateTimer = setTimeout(() => setDropState(), 900);
    });

    button.addEventListener('click', async event => {
        if (event.button !== 0 || restoring || dragging) return;
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
    });
});
