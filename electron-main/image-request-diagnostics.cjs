function imageRequestFailure(error, { requestId, startedAt, payloadBytes, imageCount, phase, timedOut, now = Date.now() }) {
    const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
    const detail = timedOut ? '等待完整响应超过 300 秒' : String(error?.message || error);
    const explanation = /ERR_EMPTY_RESPONSE/i.test(detail)
        ? '连接在返回有效响应前被关闭，可能发生在网络、中转网关或上游服务，不能据此认定生成失败。'
        : '连接中断，无法确认服务端是否已受理或完成任务。';
    const failure = new Error(`${explanation}\n${detail}\n请求编号：${requestId}；阶段：${phase}；耗时：${elapsed} 秒；参考图：${imageCount} 张；请求大小：${(payloadBytes / 1024 / 1024).toFixed(2)} MB。\n请先核查中转站任务记录；已有任务 ID 时使用“拉取产物”，不要连续重复生成。`);
    // 结构化标记：这条错误的语义是「结果未知」，不是「确定失败」。
    // 渲染层（agent-sidebar 的 _isGenerationDisconnect / canRetry）据此归类，
    // 不要再依赖对中文文案做关键词匹配——那样文案一改判定就漂移，而且
    // 这条消息自身就带着「连接中断」字样，会被误判为可重试的普通失败，
    // 界面随即给出「重新提交」建议，与本条消息末尾「不要连续重复生成」
    // 的告诫直接矛盾，可能导致重复计费。
    failure.submissionUnknown = true;
    failure.timedOut = Boolean(timedOut);
    return failure;
}

module.exports = { imageRequestFailure };
