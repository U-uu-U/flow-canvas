# Flow Canvas Experimental

Flow Canvas 是一个面向本地图片、视频与创作规划的 Electron 无限画布。本仓库当前发布的是实验版框架，重点验证本地素材管理、画布交互、多模型 API 配置、图片/视频生成工作区，以及浏览器任务同步链路。

> 实验版尚未完成稳定性、迁移兼容性和安全加固，不建议作为唯一的生产资料库。升级或测试前请自行备份 Flow Canvas 用户数据。

## 当前能力

- 本地文件夹索引、素材预览、拖放与画布组织。
- 图片、视频、阅览和设置模式切换。
- 多 API、多模型配置与模型能力参数选择。
- 图片和视频生成占位、任务记录、失败重试与本地落盘。
- Flow Canvas 本地 MCP/HTTP 桥接，用于读取和更新画板规划。
- 浏览器扩展同步 RavenHash/TokensByte 兼容的视频任务，并将完成文件归档到对应画板目录。
- Windows 悬浮球收起、恢复和跨屏移动。

## 技术结构

- `src/`：Vite 前端、Konva 画布和工作区 UI。
- `electron-main/`：Electron 主进程、文件监听、缩略图、生成接口和浏览器同步服务。
- `shared/`：主进程与 MCP 共用的规划服务核心。
- `mcp/`：独立 Flow Canvas MCP 服务入口。
- `browser-extension/flow-canvas-sync/`：Chrome Manifest V3 任务同步与下载归档扩展。

## 本地运行

环境要求：Windows 10/11、Node.js 18 或更高版本。

```powershell
npm install
npm run electron:dev
```

开发模式默认使用：

- Vite：`http://127.0.0.1:15321`
- Flow Canvas 本地桥接：`http://127.0.0.1:18765`

生产前端构建：

```powershell
npm run build
```

Windows 安装版与便携版：

```powershell
npm run electron:build
```

默认产物写入 `release/`。当前未配置发布者证书和正式应用图标，Windows 可能显示 SmartScreen 提示。

## 浏览器任务同步

扩展源码位于 `browser-extension/flow-canvas-sync/`。

1. 在 Chrome 打开 `chrome://extensions` 并启用开发者模式。
2. 选择“加载已解压的扩展程序”，加载上述扩展目录。
3. 复制扩展 ID，运行 `install.bat <扩展ID>` 注册 Native Messaging Host。
4. 重新加载扩展，并保持兼容站点处于登录状态。

扩展只在以下站点注入任务适配器：

- `https://ai.ravenhash.org/`
- `https://art.ravenhash.org/`

页面登录令牌仅在页面上下文内用于读取同源任务接口，不会发送给扩展后台或 Flow Canvas。任务完成后，扩展通过 Native Messaging 将下载文件归档到 Flow Canvas 记录的目标目录。

## 数据与隐私

仓库只包含框架源码，不应提交以下内容：

- API Key、访问令牌、Cookie 或 `.env` 文件。
- `board.json`、任务路由、任务事件和其他用户画板数据。
- 本地素材、生成图片/视频、下载文件和测试截图。
- 安装包、便携版、解包目录和 Playwright 临时记录。

Electron 用户数据默认位于 `%APPDATA%\flow-canvas\data`，不在项目目录内。浏览器扩展的设置和同步状态保存在 Chrome 扩展本地存储中。

当前 API 配置保存在 Electron `localStorage`，尚未使用系统凭据保险库加密。请勿在共享 Windows 账户中保存敏感 API Key，也不要上传 Electron 用户数据目录。

## 实验版限制

- 浏览器任务同步目前依赖兼容站点已登录的页面，尚无独立云同步服务。
- 自动任务恢复与下载链路需要 Chrome 扩展和 Native Host 同时可用。
- 不同视频模型的参数能力依赖本地模型配置，仍需按真实接口持续校验。
- 大型画板和高分辨率素材的内存占用仍需继续优化。
- 安装包尚未进行代码签名。

## 发布检查

提交实验版前至少执行：

```powershell
npm run build
git diff --check
```

同时确认 `git status` 中没有用户数据、生成媒体、测试输出、安装包或凭据文件。
