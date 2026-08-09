const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('orbButton');
    if (!button) return;

    let restoring = false;
    let dragging = false;
    let dragPointerId = null;

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
