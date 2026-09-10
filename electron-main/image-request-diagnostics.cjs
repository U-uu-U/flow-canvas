function imageRequestFailure(error, { requestId, startedAt, payloadBytes, imageCount, phase, timedOut, now = Date.now() }) {
    const elapsed = Math.max(0, Math.round((now - startedAt) / 1000));
    const detail = timedOut ? '等待完整响应超过 300 秒' : String(error?.message || error);
    const explanation = /ERR_EMPTY_RESPONSE/i.test(detail)
        ? '连接在返回有效响应前被关闭，可能发生在网络、中转网关或上游服务，不能据此认定生成失败。'
        : '连接中断，无法确认服务端是否已受理或完成任务。';
    return new Error(`${explanation}\n${detail}\n请求编号：${requestId}；阶段：${phase}；耗时：${elapsed} 秒；参考图：${imageCount} 张；请求大小：${(payloadBytes / 1024 / 1024).toFixed(2)} MB。\n请先核查中转站任务记录；已有任务 ID 时使用“拉取产物”，不要连续重复生成。`);
}

module.exports = { imageRequestFailure };
