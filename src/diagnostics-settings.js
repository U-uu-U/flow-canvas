import './diagnostics-settings.css';

function mountDiagnostics() {
    const host = document.querySelector('#agentSettings');
    const api = window.flowCanvas?.diagnostics;
    if (!host || !api || document.getElementById('diagnosticsSettings')) return;
    const root = document.createElement('details');
    root.id = 'diagnosticsSettings';
    root.innerHTML = `<summary>诊断日志</summary>
        <div class="diagnostics-actions">
            <span class="diagnostics-environment"></span>
            <button type="button" data-debug="refresh" title="刷新日志" aria-label="刷新日志"><svg class="flow-icon flow-icon-sm"><use href="./icons/flow-icons.svg#icon-replace"></use></svg></button>
            <button type="button" data-debug="copy" title="复制诊断摘要" aria-label="复制诊断摘要"><svg class="flow-icon flow-icon-sm"><use href="./icons/flow-icons.svg#icon-copy"></use></svg></button>
            <button type="button" data-debug="export" title="导出诊断报告" aria-label="导出诊断报告"><svg class="flow-icon flow-icon-sm"><use href="./icons/flow-icons.svg#icon-download"></use></svg></button>
        </div><div class="diagnostics-status" role="status"></div><pre class="diagnostics-errors"></pre>`;
    host.append(root);
    const status = root.querySelector('[role=status]');
    const refresh = async () => {
        const data = await api.summary();
        root.querySelector('.diagnostics-environment').textContent = `v${data.version} · ${data.platform} ${data.arch}`;
        status.textContent = data.writeError ? `日志写入失败：${data.writeError}`
            : `${data.eventCount} 条记录${data.droppedEvents ? `，${data.droppedEvents} 条未记录` : ''}`;
        root.querySelector('pre').textContent = data.errors.length ? data.errors.map(entry =>
            `${entry.time}  ${entry.event}\n${JSON.stringify(entry.data, null, 2)}`).join('\n\n') : '暂无错误记录';
    };
    root.addEventListener('toggle', () => { if (root.open) refresh().catch(error => { status.textContent = error.message; }); });
    root.addEventListener('click', async event => {
        const button = event.target.closest('[data-debug]');
        if (!button || button.disabled) return;
        button.disabled = true;
        try {
            if (button.dataset.debug === 'refresh') await refresh();
            else {
                const result = await api[button.dataset.debug]();
                if (!result.canceled) status.textContent = button.dataset.debug === 'copy' ? '诊断摘要已复制' : '诊断报告已导出';
            }
        } catch (error) { status.textContent = error.message; }
        finally { button.disabled = false; }
    });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountDiagnostics, { once: true });
else mountDiagnostics();
