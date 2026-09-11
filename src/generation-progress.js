export function formatGenerationElapsed(startedAt, now = Date.now()) {
    const start = Number(startedAt);
    const seconds = Number.isFinite(start) && start > 0 ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
    const minutes = Math.floor(seconds / 60);
    const pad = value => String(value).padStart(2, '0');
    return minutes < 60 ? `${pad(minutes)}:${pad(seconds % 60)}`
        : `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
}

export function isGenerationRecoveryActive(task) {
    return task?.status === 'running'
        && (Number(task.params?.recoveryStartedAt) > 0 || task.params?.syncStage === 'recovering');
}

export function canRecoverGenerationTask(task) {
    return ['image', 'video'].includes(task?.kind) && Boolean(task.taskId || task.filePath);
}
