# 诊断日志

入口：设置底部的“诊断日志”。刷新查看最近错误，复制诊断摘要，或导出 JSON 报告。

## 记录范围

- 应用版本、Electron/Chromium/Node 版本、操作系统与架构、内存和启动会话。
- 主进程异常、未处理 Promise、页面错误、加载失败及进程退出原因。
- 关键 IPC 的 invocationId、开始结束时间、耗时、返回错误与取消状态。
- 生成任务的 projectId、nodeId、clientTaskId、taskId；提交、下载、恢复和失败阶段。
- 图片请求的 requestId、服务端响应编号、HTTP 状态、请求大小、参考数量和完整响应耗时。
- 图片请求的 referenceManifest 按实际上传顺序记录每张图片的 SHA-256、字节数、MIME 和 multipart 字段名，不含图片内容。可据此与中转站核对是否收到全部文件；客户端记录不能证明上游模型采用了素材。
- 视频进度按阶段和进度区间记录，避免每次轮询刷屏。
- Agent 状态、步骤、工具名、用量与错误；不记录逐字输出。
- 画布同步保存的 revision 冲突。

## 存储与导出

日志在 Electron userData 下的 `diagnostics/events.jsonl`，最多三个 2 MiB 文件，自动轮转。
内存队列最多 1000 条，每秒写入；强制终止可能丢失最后一秒。写入失败不阻断生成，并在摘要显示。
报告包含最近 1500 条事件及最多 200 条任务元数据；复制摘要取最近 150 条事件。
跨会话日志保留原 sessionId，导出报告另有当前 sessionId 和导出时间。

不导出画板、API 配置、提示词字段、原始响应体或素材文件。结构化凭据字段、认证头、URL 查询参数和已知密钥脱敏。
控制台错误中的文字与堆栈仍可能包含业务内容或本地路径，分享前可以检查导出的 JSON。
请求编号用于关联客户端日志；上游是否保留 `X-Log-Id` 取决于其实现，它不是服务器任务 ID。

诊断报告不是服务器日志，无法单独证明一次断连的生成是否被上游受理，也不会自动重新提交生成。

## 验证

`node --test electron-main/diagnostics.test.cjs`

`npm run build` 后运行 `node scripts/diagnostics-smoke.cjs`。桌面 smoke 使用独立临时配置与模拟错误，不调用付费模型。
