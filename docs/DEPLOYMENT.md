# FlowCanvas 部署与打包

## 架构边界

FlowCanvas 没有登录和账号系统。Electron 渲染进程只把模型 Base URL 发送到固定网关；RavenHash API Key 由 Electron `safeStorage` 加密保存，并只在主进程向已配置网关发请求时注入。

网关仅允许下面两个 Base URL 进入 RavenHash 路由：

```text
https://ai.ravenhash.org/v1
https://art.ravenhash.org/v1
```

其他 Base URL 一律使用服务端配置的免费上游并忽略客户端 Authorization。服务端不会请求客户端提交的任意主机，也不会保存用户 RavenHash Key。

## Docker 部署

1. 从 `.env.example` 创建服务器自己的 `.env`。
2. 至少配置 `FREE_UPSTREAM_URL`、`FREE_UPSTREAM_KEY` 和 `FREE_MODEL`。
3. 把 `PUBLIC_MEDIA_BASE_URL` 改为网关的公网 HTTPS 地址。
4. 把 `CORS_ALLOWED_ORIGINS` 限制为实际使用的来源。
5. 启动并检查健康状态。

```powershell
docker compose up -d --build
docker compose exec flowcanvas-gateway node -e "fetch('http://127.0.0.1:8787/health').then(async r => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1) })"
```

`.dockerignore` 会排除 `.env`、本地媒体、构建产物和依赖目录。镜像只复制运行网关所需的 `server/` 与 `shared/`，不要把服务器 `.env` 放进 Electron 安装包。

## Nginx 示例

```nginx
limit_req_zone $binary_remote_addr zone=flowcanvas_gateway:10m rate=20r/s;

upstream flowcanvas_gateway {
    server 127.0.0.1:8787;
    keepalive 32;
}

server {
    listen 443 ssl http2;
    server_name flowcanvas-api.example.com;

    ssl_certificate /etc/letsencrypt/live/flowcanvas-api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/flowcanvas-api.example.com/privkey.pem;
    client_max_body_size 512m;

    location / {
        limit_req zone=flowcanvas_gateway burst=40 nodelay;
        proxy_pass http://flowcanvas_gateway;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180s;
        proxy_send_timeout 180s;
        proxy_buffering off;
        proxy_request_buffering off;
    }
}
```

反向代理部署时设置 `TRUST_PROXY`，并确认 `req.ip` 解析为真实客户端地址，否则素材上传限速会按代理地址统计。Nginx 的总请求限速是外围保护，应用内仍会执行 RavenHash Key 验证和素材上传限速。

## 监控与日志

生产环境设置 `NODE_ENV=production` 后，网关和 Electron 主进程日志使用单行 JSON。`LOG_LEVEL` 支持 `debug`、`info`、`warn`、`error`，生产建议使用 `info` 或 `warn`。

建议监控 `/health`、HTTP 5xx 比例、上游 401/429/502、P95 响应时间、媒体目录大小和磁盘使用率。不要记录 Authorization、完整请求 Header 或请求体。

## Electron 构建

构建时 `VITE_FLOWCANVAS_GATEWAY_URL` 与 `FLOWCANVAS_GATEWAY_URL` 必须一致。前者供渲染进程请求，后者限定主进程的凭证注入目标；构建脚本会在二者不一致时直接失败。

中文项目路径下 NSIS 可能失败，可临时映射 ASCII 盘符：

```powershell
subst W: "E:\案例\flow-canvas-test-1"
try {
    Push-Location W:\
    npm run electron:build
} finally {
    Pop-Location
    subst W: /d
}
```

构建后会自动检查 `dist/win-unpacked/resources/app.asar`：应包含 `electron-main/gateway-config.json`，且不应包含 `.env*`、服务端、迁移恢复项目、测试或服务器密钥。校验失败会让 `electron:build` 返回非零退出码。

## 发布前检查

```powershell
npm test
npm run build
node --check electron-main/main.js
node --check server/index.js
git diff --check
```

还应手动验证免费与 RavenHash 的聊天流、图片、视频和素材 URL 上传，并确认 RavenHash 余额不足由中转站原样拒绝。
