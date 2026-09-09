# MCP 客户端

Flow Canvas 的内置 Agent 现在可以调用外部 MCP 服务。原有 `flow_canvas.board.*` MCP **服务端**不变；新客户端用于反方向控制 Rhino、Blender 等外部软件。

## 连接方式

进入 **设置 > API > MCP 外部工具**，点击加号。

| 类型 | 配置 |
| --- | --- |
| 本地程序（stdio） | 程序路径或命令、参数 JSON 数组、可选工作目录和环境变量 |
| Streamable HTTP | 完整 MCP URL、可选认证请求头 |
| SSE | 旧版 SSE URL、可选认证请求头 |

参数必须是数组，例如 `["/absolute/path/to/server.js"]`，不能把整行 shell 命令塞进“程序”。工作目录使用绝对路径。安装包不会捆绑 Node、Python、uv、Rhino 或 Blender；按外部 MCP 项目的要求安装运行环境和软件侧插件。macOS 图形应用的 PATH 可能与终端不同，程序使用绝对路径更可靠。

保存并连接后会显示连接状态和完整工具列表。已有配置可编辑、停用、删除或重新连接；重连会重新读取工具。模型使用启用并已连接的工具。服务断开时不会反复拉起进程，修复后点击连接按钮。

环境变量和请求头不会回传到表单。编辑时留空保留原值，输入 `{}` 清空。配置使用 Electron `safeStorage` 加密，单独保存在应用数据目录的 `data/mcp-clients.json`，不改动已有 API 配置。解密失败时保留原文件，不静默覆盖。

## Agent 行为

- 通过官方 MCP SDK 完成初始化、工具发现、调用、超时和取消。内部工具名按服务 ID 和远端工具名哈希，避免不同软件的同名工具冲突。
- 同一个连接上的操作串行提交；工具参数按发现的 JSON Schema 校验。配置或工具 schema 变更后，旧规划不能直接执行。
- 自动模式按任务执行外部工具；询问模式对未声明只读的工具沿用现有任务卡确认。服务的 `readOnlyHint` 是服务提供的提示，并非本地可证明的性质。
- 工具文本、结构化数据和资源链接进入原项目、原对话的运行记录；PNG/JPEG/WebP 图像可以作为视觉上下文交给 Agent。图片块限 8 MB base64，单次保留最多 8 张，文字结果有长度上限。
- 调用前写入检查点。崩溃、超时或断连造成修改结果不明时，中止该轮执行；恢复不能自动重发。已保存的完成结果可复用，避免再次操作场景。
- 停止请求会通知 MCP 服务，但不能保证外部程序撤回已经执行的操作。Flow Canvas 的画布撤销不等于 Rhino/Blender 的场景撤销。

## 当前边界

这是通用客户端，并未自动安装或配置 Rhino/Blender 的软件侧插件，也没有对用户实际建模场景做联调。两者的地址、启动命令和工具能力应以用户安装的 MCP 服务为准，不将普通软件 socket 端口当成标准 MCP HTTP 地址。

外部软件的活动文档是全局状态，不会随 Flow Canvas 项目切换而隔离；Agent 会被要求先读取场景，再操作。不同连接即使指向同一个外部场景，目前也不能保证互斥，避免重复配置同一场景。

当前支持工具发现与调用，不含 OAuth 浏览器授权、MCP prompts/resources 浏览器或对外部生成文件的自动入库。资源链接会保留，图像用于 Agent 理解；它们不会被宣称已经导入画布。外部 Harness 不经 Flow Canvas 转发调用这些工具。

## 验证

```powershell
node --test electron-main/mcp-client.test.cjs electron-main/agent-runtime.test.cjs
npm run build
node scripts/mcp-client-smoke.cjs
```

桌面冒烟测试使用 Playwright（可通过 `PLAYWRIGHT_MODULE` 指定模块路径）、隔离的临时配置和本地模拟 Provider，不读取用户 API、不产生付费调用。覆盖真实 stdio 子进程、HTTP/SSE 协议、认证头、工具发现、Agent 多轮调用、加密保存、重启幂等、询问确认、取消和连接失败。测试结束关闭进程并删除临时配置。
