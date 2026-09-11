import crypto from 'node:crypto';
import { appendGeneratorResult, getGeneratorResultEntries } from '../src/generator-result-stack.js';

function signature(node) {
    return JSON.stringify([node?.config, node?.filePath, node?.generation?.taskId, node?.resultFilePaths]);
}

export function installGenerationRecoveryBoard(bridge, board) {
    bridge.captureRecoveryTarget = request => {
        if (!request.projectId) throw new Error('原项目未记录，请在原项目中恢复此任务');
        const project = board.readProject(request.projectId);
        return signature(project.items.find(node => node.id === request.nodeId));
    };
    bridge.attachRecoveredGeneration = async (request, result, signal) => {
        const key = crypto.createHash('sha256').update(`${request.clientTaskId}:${request.taskId}`).digest('hex').slice(0, 24);
        const fallbackId = `recovered-${key}`;
        let nodeId;
        await board.updateProject(request.projectId, project => {
            if (signal?.aborted) throw new Error('已停止拉取，下载文件已保留');
            const original = project.items.find(node => node.id === request.nodeId);
            let node = project.items.find(node => node.metadata?.recoveryKey === key || node.id === fallbackId);
            const filePaths = (result.filePaths?.length ? result.filePaths : [result.filePath]).filter(Boolean);
            if (node && filePaths.every(filePath => getGeneratorResultEntries(node).some(entry => entry.filePath === filePath))) {
                nodeId = node.id;
                return;
            }
            if (signature(original) !== request.targetSignature) throw new Error('恢复期间原节点被修改，产物已保存；请再次拉取以重新检查');
            if (!node) {
                if (original?.kind === 'op' && original.nodeType === request.kind && !original.filePath) node = original;
                else if (original?.kind === 'op' && original.generation?.taskId === request.taskId) node = original;
                else {
                    node = { id: fallbackId, kind: 'op', nodeType: request.kind,
                        title: request.kind === 'video' ? '恢复的视频' : '恢复的图片',
                        x: (original?.x || 0) + (original?.width || 320) + 48, y: original?.y || 0,
                        width: original?.width || result.images?.[0]?.width || 320,
                        height: original?.height || result.images?.[0]?.height || (request.kind === 'video' ? 180 : 320),
                        config: { ...(request.params || {}), ...(request.promptDraftConfig || { prompt: request.prompt }), model: request.providerConfig.model } };
                    project.items.push(node);
                    if (original) project.connections.push({ id: `recovery-link-${key}`, kind: 'history',
                        from: { nodeId: original.id, port: original.nodeType || request.kind }, to: { nodeId: node.id, port: 'source' } });
                }
            }
            const generation = { ...node.generation, kind: request.kind, prompt: request.prompt,
                nodeType: request.kind, requestPrompt: request.prompt,
                ...(request.promptDraftConfig ? { promptDraftConfig: structuredClone(request.promptDraftConfig) } : {}),
                ...(request.referenceBindings ? { referenceBindings: structuredClone(request.referenceBindings) } : {}),
                model: request.providerConfig.model, providerId: request.providerConfig.id,
                config: { ...node.config }, taskId: result.taskId || request.taskId,
                references: (request.sourcePaths || []).map(filePath => ({ filePath })), generatedAt: Date.now() };
            for (const filePath of filePaths.filter(Boolean)) appendGeneratorResult(node, {
                filePath, item: { filePath, mediaType: result.mediaType || request.kind, generation }
            });
            node.filePath = filePaths[0];
            node.mediaType = result.mediaType || request.kind;
            node.generation = generation;
            node.runStatus = 'done';
            node.runError = '';
            node.metadata = { ...node.metadata, recoveryKey: key };
            nodeId = node.id;
        });
        return { nodeId, projectId: request.projectId };
    };
}
