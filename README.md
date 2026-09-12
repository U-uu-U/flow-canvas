# Flow Canvas

Flow Canvas 是一款面向 Windows 和 macOS 的本地素材管理与 AI 创作桌面应用。它把文件夹中的图片、视频和音频组织到无限画布上，并将多 API 模型、图片生成、视频生成、任务恢复和 MCP 自动化集中在同一个工作区中。

当前稳定版本：`v1.3.0`

最新测试版本：[`v1.5.0-beta.10`](https://github.com/U-uu-U/flow-canvas/releases/tag/v1.5.0-beta.10)，提供 Windows 安装版 / 便携版和 macOS 通用 DMG。详见[本版更新内容](docs/releases/v1.5.0-beta.10.md)。

## v1.3.0 更新内容

- 重构图片生成节点交互：从画布素材直接打开紧凑生成面板，支持文本与参考素材连线、生成数量和节点参数联动。
- 完善 Midjourney 适配：提供版本、画质、Raw、Stylize、Chaos、Weird、Seed、速度等参数，并按四宫格顺序保留全部候选结果。
- 多结果节点支持堆叠与分支展开、悬停轮换和准确序号；复制、拖出及右键文件操作始终以当前首图为准。
- 生图节点右键菜单补齐复制、文件地址、AI 引用、资源管理器定位、默认打开、修补、替换和文件夹操作，移动后会同步更新结果路径。
- 新增精简版 Awesome GPT Image 2 提示词模板库，支持模板搜索、结构化写入和在原提示词后追加增强约束。
- 文本节点支持自由拉伸，并在低缩放级别隐藏正文；画布连线、生成占位尺寸和生成面板定位进一步优化。
- 增强 OpenAI 兼容异步任务与 Midjourney 任务轮询，补充任务 ID 恢复、跨域鉴权保护和更明确的供应商错误提示。

## v1.2.0 更新内容

- 新增画布节点系统：支持文本、图片生成、视频生成与处理节点，通过连线传递提示词和参考素材，并按依赖顺序执行。
- 图片创作迁移到画布节点；支持多参考图职责编译、可选 Agent 规划、异步任务恢复、参考素材缓存和生成链路记录。
- 图片裁切会创建新的子素材并保留父子连线；生成占位符继承首张参考图的显示尺寸和比例。
- 多张生成结果改为可轮换堆叠，显示当前序号；删除、复制和拖出时始终以当前首图为准。
- 新增独立素材库与分类界面，可关联多个本地目录，并在“设置 > 创作”中选择默认素材库地址。
- 浏览器扩展升级为素材采集与任务同步工具，支持从网页侧边栏批量捕捉可下载图片并归档到 Flow Canvas。
- 增加可配置快捷键、完整撤销/重做、选中素材快捷工具栏、节点搜索和更稳定的缩放与清晰度加载。
- API 配置按文字、图片和视频用途隔离；补充 OpenAI 兼容异步图片任务、Midjourney 任务信封和多供应商能力识别。

## v1.1.1 更新内容

- 修复参考素材临时服务器不稳定导致的 `ERR_CONNECTION_TIMED_OUT`：上传失败时自动切换备用临时存储节点。
- 优化多张参考素材上传：支持有限并发、同素材上传合并、按文件大小调整超时，并补充节点失败原因。
- 素材预上传失败时明确提示任务尚未提交到模型服务，避免误以为已经生成或重复扣费。
- 文件夹组增加任务状态点：运行中灰白呼吸，成功后浅绿色常亮，失败或断连显示淡红色。
- 生成任务记录所属项目，切换文件夹组时不再串用任务状态。

## v1.1.0 更新内容

- 统一图片、视频和音频参考素材的添加入口，实时显示分类数量，并修复视频素材无法选中、滚轮误选素材的问题。
- 图片参考图支持生成前批量压缩，也可仅输出压缩文件而不放入画板；服务端返回 `413` 时提供明确提示。
- 图片与视频创作参数按项目独立缓存，切换项目不再串用提示词、参考素材和生成设置。
- 视频创作提示词区域支持拖动调整高度，素材入口移至底部，生成任务继续支持并行提交。
- RavenHash 文字/图片与视频 API 分别适配 `ai.ravenhash.org/v1` 和 `art.ravenhash.org/v1`，并自动迁移旧地址。
- 增加 macOS Apple Silicon/Intel 构建流程，补充 Finder 文件操作、`Command` 快捷键和 Chrome Native Messaging 安装支持。

## 功能概览

### 本地无限画布

- 关联多个本地文件夹，并按文件夹组保存独立画板和视口。
- 支持缩放、平移、框选、拖放、边角等比缩放和素材排布。
- 直接索引原始文件路径，无需复制整个素材库。
- 支持图片、视频、音频及常见文档类型的识别和预览。
- 支持断联素材的手动重接、自动修补和模糊匹配。
- 支持把画板素材复制到 Windows 资源管理器或 macOS Finder。
- 针对大型画板提供缩略图、视口裁剪和资源节省模式。

### 节点式图片与视频创作

- 在画布上创建文本、图片生成和视频生成节点，并通过连线组合提示词、图片、视频和音频输入。
- 图片生成节点支持比例、质量、输出数量、多参考图、提示词预设和可选 Agent 规划。
- 视频模式与视频生成节点会根据所选模型显示可用的时长、分辨率、画面比例、音频、联网搜索和水印参数。
- 支持配置多个 OpenAI 兼容 API，并分别调用不同供应商的文字、图片或视频模型。
- 支持从 `/v1/models` 拉取模型列表，也可以手动添加模型位。
- 大尺寸参考图提交前会询问是否压缩，压缩结果只用于上传，不覆盖原图。
- 生成节点支持并行输出；画布会立即创建占位动画，完成后替换为可轮换的本地结果堆叠。
- 支持对画布图片进行真实裁切，裁切结果与原素材保留父子连线。
- 图片清晰度切换与视频封面更新使用模糊过渡，减少黑屏闪烁。

### 素材库与网页采集

- 左侧浮动工具栏可打开独立素材库，按来源、媒体类型、分类和收藏状态筛选素材。
- 可关联多个本地素材目录，并在“设置 > 创作”中切换默认归档地址。
- 浏览器扩展支持扫描当前网页中的图片候选项、批量选择和自动下载归档。
- 素材分类可以调用已配置的文字与视觉理解模型，并把标签写入本地元数据。

### 任务记录与断线恢复

- 记录任务状态、提示词、模型、参数、参考素材和输出路径。
- 提示词可直接复制，失败任务可重试，断连任务可重新连接。
- 视频请求使用唯一 `X-Log-Id`。POST 连接意外关闭时，Flow Canvas 不会盲目重复提交，而是优先恢复轮询，降低重复任务和重复扣费风险。
- 应用重启后保留任务记录；已获得远端任务 ID 的视频可以继续查询和下载。
- 对不支持恢复协议的平台，可选用仓库内的 Chrome 同步扩展补充下载链路。

### MCP 与规划表

- Codex 等 MCP 客户端可以读取当前文件夹组、画板素材和规划表。
- 支持创建、读取和更新规划表及表格行。
- 支持通过 MCP 新增、更新、删除画板元素，并调用已授权的图片或视频模型。
- 本地桥接只监听 `127.0.0.1`，工具权限由 Flow Canvas 设置中的允许列表控制。

## 安装

### 使用安装包

从 [GitHub Releases](https://github.com/U-uu-U/flow-canvas/releases) 下载 `Flow.Canvas.Setup.1.3.0.exe`，按提示完成安装。

也可以下载便携版 `Flow.Canvas.1.3.0.exe` 直接运行。当前安装包未进行商业代码签名，Windows 首次启动时可能显示 SmartScreen 提示。

macOS 测试版由 GitHub Actions 分别生成 Apple Silicon (`arm64`) 和 Intel (`x64`) 的 `dmg/zip`。未签名测试包首次运行时，需要在“系统设置 > 隐私与安全性”中确认打开；正式分发建议配置 Apple Developer 签名与公证。

### 从源码运行

环境要求：

- Windows 10/11，或 macOS 12 及以上版本
- Node.js 18 或更高版本
- npm 9 或更高版本

```powershell
git clone https://github.com/U-uu-U/flow-canvas.git
cd flow-canvas
npm ci
npm run electron:dev
```

依赖已经安装时，也可以运行：

```powershell
.\start.bat
```

macOS 使用：

```bash
npm run electron:dev
```

仅预览前端界面：

```powershell
npm run dev
```

浏览器预览无法使用 Electron 文件系统、系统剪贴板、窗口置顶和资源管理器映射能力，完整功能应使用桌面应用。

## 快速开始

1. 启动 Flow Canvas，在左侧创建文件夹组并关联本地素材目录。
2. 从右下角进入设置模式，添加 API 名称、Base URL 和 API Key。
3. 点击“拉取模型”，选择模型并设置文本与视觉理解、图片生成或视频生成用途。
4. 通过画布左侧的加号创建文本、图片生成或视频生成节点，并把提示词和参考素材连接到生成节点。
5. 在节点弹窗中选择模型与参数后运行；结果完成后会自动下载并写入当前画板。

RavenHash 入口可从设置页直接打开：

- [AI 中转站](https://ai.ravenhash.org/)
- [创作中转站](https://art.ravenhash.org/)

## API 兼容约定

Flow Canvas 面向 OpenAI 兼容服务设计。模型列表默认请求：

```text
GET /v1/models
```

视频服务通常需要支持：

```text
POST /v1/video/generations
GET  /v1/video/generations/{task_id}
```

也兼容使用 `/v1/tasks/{task_id}` 查询的视频服务。不同供应商的字段和能力并不完全一致，Flow Canvas 会根据模型配置决定可提交的时长、分辨率、比例及附加参数。

若要在 POST 响应提前关闭后无插件恢复任务，服务端需要：

1. 接收并持久化请求头 `X-Log-Id`。
2. 允许通过 `/v1/tasks/{log_id}` 或 `/v1/video/generations/{log_id}` 查询任务。
3. 上游任务 ID 尚未返回时响应 `202 pending`，获得后返回真实任务 ID。

## MCP 接入

先启动 Flow Canvas，再把 stdio 服务加入支持 MCP 的客户端。Windows 配置示例：

```json
{
  "mcpServers": {
    "flow-canvas": {
      "command": "node",
      "args": [
        "C:\\path\\to\\flow-canvas\\mcp\\flow-canvas-mcp.mjs"
      ],
      "env": {
        "FLOW_CANVAS_BRIDGE_URL": "http://127.0.0.1:18765"
      }
    }
  }
}
```

常用工具：

| 工具 | 用途 |
| --- | --- |
| `flow_canvas.context.get_active_group` | 读取当前文件夹组和画板上下文 |
| `flow_canvas.plan.*` | 创建、读取和更新规划表 |
| `flow_canvas.item.*` | 读取和维护画板素材 |
| `flow_canvas.image.generate` | 生成图片并写入当前画板 |
| `flow_canvas.video.generate` | 提交视频任务并将结果写入画板 |
| `flow_canvas.board.get_snapshot` | 按选择、上下游、视口或整个项目读取带 revision 的画板快照 |
| `flow_canvas.board.transaction.preview` | 原子校验整笔节点、连线和排列事务，不修改画板 |
| `flow_canvas.board.transaction.apply` | 按 `baseRevision` 提交事务，并返回幂等结果和 `undoToken` |
| `flow_canvas.board.transaction.undo` | 使用 `undoToken` 整笔撤销一次 Agent 画板事务 |

默认本地桥接地址是 `http://127.0.0.1:18765`。可通过 `FLOW_CANVAS_MCP_PORT` 修改端口，或使用 `FLOW_CANVAS_BRIDGE_URL` 指向已经运行的桥接服务。

Harness 修改画板时应固定遵循 `get_snapshot → preview → apply`。每笔事务使用快照中的 `revision` 作为 `baseRevision`，并提供稳定的 `idempotencyKey`；如果返回 `REVISION_CONFLICT`，重新读取快照后再规划，不要覆盖用户刚完成的操作。`apply` 和 `undo` 在 Flow Canvas 内部串行执行，刷新或画板尚未加载完成时会返回可重试的 renderer readiness 错误。

## 浏览器同步扩展

扩展主要用于兼容无法通过 API 恢复历史任务的平台，并不是正常生成流程的必需组件。

1. 在 Chrome 打开 `chrome://extensions`。
2. 启用“开发者模式”。
3. 选择“加载已解压的扩展程序”。
4. 加载 `browser-extension/flow-canvas-sync/`。
5. 按照[扩展说明](browser-extension/flow-canvas-sync/README.md)安装 Native Messaging 主机。

macOS 安装 Native Messaging 主机时，在扩展目录执行：

```bash
bash install-macos.sh <扩展ID>
```

扩展仅注入以下站点：

- `https://ai.ravenhash.org/*`
- `https://art.ravenhash.org/*`

## 数据与隐私

画板主数据默认保存在：

```text
%APPDATA%\flow-canvas\data\board.json
```

macOS 默认路径：

```text
~/Library/Application Support/flow-canvas/data/board.json
```

同目录的 `backups/` 保存自动备份。画板数据包含文件路径、坐标、文件夹组和规划表，不包含原始素材文件本身。

API 配置和任务记录目前保存在 Electron 本地存储中。当前版本尚未接入系统凭据库，因此不要提交 `%APPDATA%\flow-canvas`、浏览器用户数据、包含密钥的截图或本地配置文件。仓库的 `.gitignore` 已排除常见凭据、用户数据、生成媒体和安装包。

## 项目结构

```mermaid
flowchart LR
    F["本地文件夹"] --> W["Watcher / Store"]
    W --> C["Konva 无限画布"]
    C --> U["画布图片与视频生成节点"]
    U --> B["Electron 本地桥接"]
    B --> A["OpenAI 兼容 API"]
    A --> D["任务轮询与本地下载"]
    D --> C
    M["Codex / MCP 客户端"] --> S["stdio MCP Server"]
    S --> B
    X["可选 Chrome 扩展"] --> D
```

| 目录 | 用途 |
| --- | --- |
| `src/` | Vite 前端、Konva 画布、素材侧栏、Agent 及图片/视频生成节点 |
| `electron-main/` | Electron 主进程、文件监听、缩略图、剪贴板、任务恢复与下载 |
| `shared/` | Electron、renderer 与 MCP 共用的数据服务、schema 和画板工具契约 |
| `mcp/` | stdio MCP 服务入口和工具定义 |
| `browser-extension/flow-canvas-sync/` | 可选 Chrome 任务同步扩展 |

核心技术：Electron 28、Vite 5、Konva 9、Sharp、Chokidar 和 GSAP。

## 开发与构建

```powershell
# 前端开发服务
npm run dev

# Electron 完整开发环境
npm run electron:dev

# 构建生产前端
npm run build

# 构建 Windows 安装版和便携版
npm run electron:build

# 在 macOS 构建 Apple Silicon 和 Intel 安装包
npm run electron:build:mac

# 单独启动 MCP stdio 服务
npm run mcp
```

Windows 和 macOS 构建产物写入 `release/`。提交代码前至少执行：

```powershell
node --check src/agent-sidebar.js
node --check src/canvas.js
node --check electron-main/mcp-bridge.js
npm run build
git diff --check
```

## v1.3.0 支持范围

- 桌面文件系统、剪贴板和资源管理器工作流已适配 Windows 10/11。
- macOS 已加入 Apple Silicon/Intel 打包、Finder 拖放、文件剪贴板和 `Command` 快捷键适配，仍需在真实 Mac 上完成发布前回归测试。
- Linux 尚未完成桌面能力适配。
- API 参数兼容程度取决于供应商对 OpenAI 风格端点和任务查询协议的实现。
- 安装包尚未进行代码签名，也没有内置自动更新。
- API Key 当前为本地应用存储，尚未使用系统凭据库加密。

## License

当前仓库尚未包含开源许可证。在许可证文件补充前，公开源码不代表自动授予使用、修改或再分发权利。
