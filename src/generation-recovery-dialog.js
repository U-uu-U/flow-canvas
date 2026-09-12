export function requestRecoveryTaskId(task) {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'generation-recovery-dialog';
        dialog.innerHTML = `<form method="dialog">
            <h3>按任务 ID 拉取产物</h3>
            <p class="recovery-route"></p>
            <label>上游任务 ID<input name="taskId" required autocomplete="off" spellcheck="false" placeholder="粘贴服务商后台的任务 ID"></label>
            <div class="recovery-dialog-actions"><button type="button" value="cancel">取消</button><button type="submit" value="recover">拉取产物</button></div>
        </form>`;
        dialog.querySelector('.recovery-route').textContent = `${task.providerName || '原 API'} · ${task.model || task.kind}`;
        const input = dialog.querySelector('input');
        input.value = task.taskId || '';
        dialog.querySelector('button[value="cancel"]').addEventListener('click', () => dialog.close('cancel'));
        dialog.querySelector('form').addEventListener('submit', event => {
            event.preventDefault();
            if (input.value.trim()) dialog.close('recover');
            else input.focus();
        });
        dialog.addEventListener('close', () => {
            const value = dialog.returnValue === 'recover' ? input.value.trim() : null;
            dialog.remove();
            resolve(value || null);
        }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
        input.focus();
        input.select();
    });
}
