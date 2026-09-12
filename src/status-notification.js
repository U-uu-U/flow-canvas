const states = new WeakMap();

export function showStatusNotification(message, { kind = 'info', duration = 2200, onDismiss } = {}) {
    const host = document.getElementById('titlebarStatus');
    if (!host) return;
    const previous = states.get(host);
    if (previous?.kind === 'error' && kind !== 'error') return;
    clearTimeout(previous?.timer);
    const state = { kind, timer: null };
    states.set(host, state);
    const textValue = String(message || '');
    const dismiss = () => {
        if (states.get(host) !== state) return;
        clearTimeout(state.timer);
        states.delete(host);
        if (host.hasAttribute('popover')) host.hidePopover?.();
        host.removeAttribute('popover');
        host.replaceChildren();
        host.classList.remove('status-visible', 'status-error', 'status-success', 'status-dismissible');
        onDismiss?.();
    };
    host.classList.remove('status-error', 'status-success', 'status-dismissible');
    host.classList.add('status-visible');
    host.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    host.removeAttribute('title');
    const text = document.createElement('span');
    text.className = 'titlebar-status-message';
    text.textContent = textValue;
    text.title = textValue;
    host.replaceChildren(text);
    if (kind === 'error') {
        host.classList.add('status-error', 'status-dismissible');
        const button = (icon, label) => {
            const element = document.createElement('button');
            element.type = 'button';
            element.className = 'titlebar-status-copy';
            element.title = label;
            element.setAttribute('aria-label', label);
            element.innerHTML = `<svg class="flow-icon flow-icon-sm" aria-hidden="true"><use href="./icons/flow-icons.svg#icon-${icon}"></use></svg>`;
            host.appendChild(element);
            return element;
        };
        const copy = button('copy', '\u590d\u5236\u62a5\u9519');
        copy.addEventListener('click', async () => {
            try {
                if (window.flowCanvas?.clipboard?.writeText) {
                    const result = await window.flowCanvas.clipboard.writeText(textValue);
                    if (result?.success === false) throw new Error(result.error);
                } else await navigator.clipboard.writeText(textValue);
                copy.querySelector('use').setAttribute('href', './icons/flow-icons.svg#icon-check');
                copy.title = '\u5df2\u590d\u5236';
                copy.setAttribute('aria-label', copy.title);
            } catch {
                copy.title = '\u590d\u5236\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5';
                copy.setAttribute('aria-label', copy.title);
            }
        });
        button('close', '\u5173\u95ed\u62a5\u9519').addEventListener('click', dismiss);
        host.setAttribute('popover', 'manual');
        host.showPopover?.();
    } else {
        if (kind === 'success') host.classList.add('status-success');
        state.timer = setTimeout(dismiss, duration);
    }
}
