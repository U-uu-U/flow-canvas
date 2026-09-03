# FlowCanvas 网关

网关不包含登录、账号或套餐。FlowCanvas 始终请求固定网关，并通过 `X-FlowCanvas-Model-Base-URL` 发送当前模型 Base URL。服务端只把这个值用于路由判断，不会请求客户端提交的任意地址。

## 路由规则

去掉首尾空白和末尾 `/` 后，只有下面两个精确值会进入 RavenHash 分支：

```text
https://ai.ravenhash.org/v1
https://art.ravenhash.org/v1
```

命中时，网关请求对应的硬编码 RavenHash 主机，并转发用户自己的 RavenHash API Key，由中转站判断余额和权限。用户 Key 通过 Electron `safeStorage` 加密保存在本机；解密和请求 Header 注入只发生在 Electron 主进程，渲染进程没有读取 Key 的 IPC。网关不落库。其他值，包括相似域名、子域名、查询参数、额外路径和完整接口地址，都固定路由到免费上游，并忽略客户端提交的 Key。

该规则只负责 Base URL 白名单，付费状态由 RavenHash 中转站根据用户 API Key 判断。

## 本地启动

1. 将 `.env.example` 复制为 `.env`，配置免费上游；RavenHash 用户 Key 不写入服务器环境变量。
2. 运行 `npm install`。
3. 运行 `npm run server:start`。
4. 同时设置相同的 `VITE_FLOWCANVAS_GATEWAY_URL` 和 `FLOWCANVAS_GATEWAY_URL`，再执行 `npm run electron:build`。构建脚本会把非敏感的网关 URL 写入客户端配置；服务器 `.env` 和免费上游 Key 不会写入客户端。前者供渲染进程请求，后者限制 Electron 主进程只向该网关注入凭证。

生产网关必须使用 HTTPS，因为用户 API Key 会随白名单请求发送到网关，再由网关转发给 RavenHash。网关只在请求期间使用该 Key，不写入数据库或日志。

用户 API Key 最长 4096 个字符。旧版本保存在 `localStorage` 的供应商配置会被删除且不会迁移，用户需要重新输入 Key。

文本对话使用 `/v1/chat/completions`，图片生成使用 `/v1/images/generations`，图片编辑使用 `/v1/images/edits`，视频使用 `/v1/videos`，上游文件接口使用 `/v1/files` 或 `/v1/uploads`。

## 素材 URL

只有命中两个 RavenHash Base URL 且提供用户 API Key 时，客户端才能将一个本地图片或视频上传到 `/api/media/upload`。上传前网关会使用 `RAVENHASH_KEY_VALIDATION_PATH`（默认 `/models`）向对应白名单主机验证 Key，并按 Key 哈希缓存短时验证结果。其他 Base URL 返回 `403`，缺少或无效 Key 返回 `401`。

素材上传默认限制为每 IP 每小时 20 次，使用 `MEDIA_UPLOAD_RATE_LIMIT_PER_HOUR` 调整。默认验证只能证明 Key 可用，最终余额仍由中转站在模型请求时判断。部署在反向代理后时应正确设置 `TRUST_PROXY`，否则 IP 限速无法识别真实来源。

生产环境必须把 `PUBLIC_MEDIA_BASE_URL` 设置为网关的公网 HTTPS 地址，确保 RavenHash 可以读取素材。上传大小由 `MAX_MEDIA_UPLOAD_BYTES` 控制，默认 512MB。

`CORS_ALLOWED_ORIGINS` 控制允许访问网关的浏览器来源，多个值用逗号分隔。默认只允许 Electron 开发地址、本地文件来源和 `null` 来源；生产部署应改为实际应用来源。CORS 不是身份认证，公网服务仍应在反向代理层增加连接数和总请求速率限制。

## Docker

配置 `.env` 后运行：

```powershell
docker compose up -d --build
```

`flowcanvas-data` 卷只保存临时媒体文件，不再包含用户数据库。

运行白名单边界测试：

```powershell
npm run server:test
```

公网反向代理、Docker 检查、日志、监控和 Windows 打包说明见 [`docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md)。
