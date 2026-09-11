# 模型能力 CONFIG（客户端）

目标：把「每个模型能做什么、不能做什么、边界是多少」从散落在代码里的特判，收敛成一份
**可从服务器更新的 JSON**，并让 UI 用它做两件事——

1. **展示**：在模型旁边直接看到「可以做 / 不能做 / 参数限制」；
2. **前置拦截**：在提交前就挡住上游一定会拒绝的参数，而不是等请求打过去才报错。

设计上有一条硬不变量：**CONFIG 缺失、过期、损坏、未收录模型，都不能让正常生成失败。**
任何不确定的情况一律「不限制 + 提示」，绝不误拦。

---

## 1. 数据流（单一真相链）

```
shared/model-channels.source.csv      权威表格（渠道 / 模型 / 入参 / 限制与说明）
        │  scripts/sync-model-config.mjs --check   ← 逐行覆盖 + notes 逐字校验
        ▼
shared/model-config.default.json      结构化后的默认配置（唯一真相，人工确认）
        │  scripts/sync-model-config.mjs --write
        ▼
src/model-config-default.js           渲染层打包用的生成产物（勿手改）
```

> 源表放在 `shared/` 而不是 `data/`：`data/` 属于用户数据目录、在 `.gitignore` 里，
> 而这张表是构建与测试的输入，必须进版本库。

为什么是「校验」而不是「从 CSV 自动翻译」：早期版本尝试用正则把限制列的自然语言解析成结构化
字段，结果 16 行里有 11 行解析错误或漏解析——`自动/5/10/12秒` 被解析成固定 12 秒、
`480p/768p/1080p/2K/4K` 丢掉 2K/4K、`3/5/10/15秒` 被解析成固定 15 秒。**猜错的边界比没有边界
更危险**：它会理直气壮地放行一个必然被拒绝的请求。因此结构化字段一律人工确认，脚本只强制
「CSV 每行都被恰好一个条目覆盖」+「notes 与表格逐字一致」+「schema 通过」。

命令：

```bash
node scripts/sync-model-config.mjs            # 校验（测试与 CI 会跑）
node scripts/sync-model-config.mjs --write    # 改完 JSON 后重新生成 src/model-config-default.js
node scripts/sync-model-config.mjs --scaffold # 为表格里新增的行打印骨架，人工补全
```

## 2. 运行期三层来源

| 优先级 | 来源 | 何时使用 | origin |
| --- | --- | --- | --- |
| 1 | 服务器 | 拉取并校验成功后 | `remote` |
| 2 | 本地缓存（localStorage） | 启动时先用，随后按需刷新 | `cache` |
| 3 | 内置默认（`src/model-config-default.js`） | 没配地址 / 拉取失败 / 配置损坏 | `builtin` |

**内置更新源**：`DEFAULT_MODEL_CONFIG_URL = 'https://artconfig.ravenhash.org/config'`（写死在
`src/model-config.js`，`src/model-config.test.js` 有回归断言，改地址必须是有意的）。服务的实现
与部署见 `configserver/README.md`。地址三态：

- 从未设置过 → 用内置更新源；
- 设置过自定义地址 → 用记录（设置面板可改，方便灰度/自建）；
- 显式清空 → 关闭远端更新，只用本地配置（状态卡会写「已关闭（仅用本地配置）」）。

- **刷新周期**：默认 1 小时（`refreshIntervalMs`，可被服务端覆盖，客户端夹在 5 分钟 ~ 24 小时）。
- **手动刷新**：设置面板「模型能力配置 CONFIG」里的「立即刷新」；「保存并刷新」会先存地址再拉。
- **到期检查**：每 60 秒醒来判断一次是否到期，窗口重新获得焦点时也检查一次
  （Electron 会降频隐藏窗口的长定时器，用 1 小时的 `setInterval` 会漂移）。
- **失败处理**：只记录 `lastError / lastErrorAt` 并保留当前配置，UI 明确显示「正在使用本地缓存 /
  内置默认」，不静默降级。
- **并发**：同一时刻只发一个请求；重复刷新复用同一个 Promise。

## 3. 网络与校验在主进程

渲染层不发网络请求（仓库既有约定），而是 `window.flowCanvas.modelConfig.fetch({url})` →
`ipcMain.handle('model-config:fetch')` → `electron-main/model-config-service.cjs`。这样做有三个好处：

- 生产环境渲染层是 `file://` 源，直接 fetch 会被 CORS 挡（`Origin: null`）；
- 远端 JSON 是**不可信输入**，由主进程用 `shared/schemas/model-config.schema.json` + ajv 整包校验，
  校验不过就整包丢弃——绝不部分采用一份坏配置；
- 协议校验（只接受 `http(s)://`，非 http(s) 协议在发请求之前就被拒）——不强制 https，
  协议与 TLS 由部署方的反代决定。

渲染层仍会做一次廉价的结构兜底（`readModelConfig`）：schema 版本、`models` 数组、id/kind/正则可编译，
单条损坏只丢该条。两道校验的关系是「主进程严格、渲染层容错」。

## 4. CONFIG 格式

```jsonc
{
  "schemaVersion": 1,              // 目前只认 1，未知版本整包忽略
  "revision": 7,                   // 服务端自增，用于展示与判断变更
  "updatedAt": "2026-09-11T00:00:00Z",
  "source": "server:ravenhash",    // 仅展示
  "refreshIntervalMs": 3600000,    // 可选，服务端可调刷新周期

  "kinds": { "image": "图片", "video": "视频", "text": "文字" },

  // 参数词表：canonical 字段名 → 展示名 + 上游入参别名 + 对应节点配置 key
  "fields": {
    "ratio": { "label": "画面比例", "param": ["aspect_ratio", "ratio", "ar"], "type": "enum", "nodeKey": "ratio" },
    "resolutionTier": { "label": "画质", "param": ["size", "resolution"], "type": "tier", "nodeKey": "resolutionTier" }
  },

  // 能力词表：展示名 + 适用类型 + 由哪些字段支撑
  "capabilities": {
    "referenceImages": { "label": "参考图", "fields": ["referenceImages"], "kinds": ["image", "video"] },
    "nsfw": { "label": "无内容审核 / NSFW", "kinds": ["video"] }
  },

  "models": [{
    "id": "ravenhash-video.sd2.5-route1",   // 稳定 id，用于展示与去重
    "label": "sd2.5-route1",
    "kind": "image | video | text",
    "channel": "RavenHash视频",             // 与 CSV 的「渠道」一致
    "route": "SD2.5线路一（推荐）",           // 与 CSV 的「上游/线路」一致
    "priority": 120,                        // 多条命中时取最高分
    "match": {
      "model": ["^sd2[._-]?5-route1$"],     // 正则源码，客户端按 i 编译
      "endpoint": "kyyReactApiServer"        // 可选：声明后该条目**只**在匹配的 endpoint 上生效
    },
    "parameters": {
      "accepts": ["model", "prompt", "duration", "aspect_ratio", "reference_images"], // CSV 入参原文
      "required": ["model", "prompt"]
    },
    // 只有「真实知道的边界」才写进 options；四种类型 + 两种"不知道"
    "options": {
      "duration": { "type": "fixed", "value": 30, "unit": "second" },
      "ratio": { "type": "enum", "values": ["adaptive", "16:9"], "default": "adaptive", "allowAuto": true },
      "resolutionTier": { "type": "range", "min": 0, "max": 0 },       // range: min/max/integer/step
      "n": { "type": "unknown", "reason": "复用通用图片请求，未单独维护上限" },
      "resolutionTier": { "type": "unsupported", "reason": "当前不发送独立分辨率参数" }
    },
    // 能力位：能做什么（supported:true，可带 max / maxBytesPerImage / note）与不能做什么（supported:false + reason）
    "capabilities": {
      "referenceImages": { "supported": true, "max": 9, "maxBytesPerImage": 52428800 },
      "webSearch": { "supported": false, "reason": "该线路不发送联网搜索参数" },
      "face": { "supported": true, "note": "支持人脸，通过率约 90%" }
    },
    "prompt": { "required": true, "maxLength": 5000 },
    "limits": {
      "concurrency": 1, "resultsPerRequest": 4, "passRate": 0.9,
      "contextWindow": { "type": "unknown", "reason": "未维护专属上下文窗口" }
    },
    "notes": "…… CSV「限制与说明」列的原文，逐字保留，UI 原样展示 ……"
  }]
}
```

`options` 的两种「不知道」是刻意的：

- `unknown`：参数会被发送，但边界以上游为准 → **只提示，不拦截**；
- `unsupported`：这个参数不该发（CSV 里写了「当前不发送独立分辨率参数」）→ **拦截**，并且 UI 隐藏控件。

Schema 用 `additionalProperties: true`，服务端可以先加字段而不被旧客户端拒绝；客户端只校验自己消费
的部分。

## 5. 匹配与歧义

`resolveModelConfigEntry(config, { model, endpoint, kind })`：

1. 遍历条目，`kind` 不一致直接跳过；`match.endpoint` 存在时 endpoint 必须命中（否则跳过）；
2. `match.model` 的正则对模型名（忽略大小写）取或；
3. 计分：`priority` + endpoint 命中 40 + 线路名（渠道）与 API 名称互相包含 20；
4. 取最高分为主条目；**没有 endpoint/线路名证据且命中多条**时标记 `ambiguous`。

歧义时的校验语义是「**所有候选都禁止的才算错误**，只有部分候选禁止的降级为警告」。
典型例子：`minimax-h3` 同时存在于「兼容线路」和「按秒线路」，两条的 `workflow_id`、首尾帧支持情况
不同——猜错线路就会误拦，所以按交集处理。

未命中任何条目 → `matched: false`，返回空错误 + 一条「未收录，未做参数限制」的警告。

## 6. 校验规则

`validateModelRequest({ config, provider, fields, features, references, prompt })` 返回
`{ ok, matched, ambiguous, entry, candidates, errors, warnings }`。判定为 **error（拦截）** 的情况：

| 场景 | code |
| --- | --- |
| 必填提示词为空 / 超过 `prompt.maxLength` | `PROMPT_REQUIRED` / `PROMPT_TOO_LONG` |
| 参数明确 `unsupported`，或该参数不在 `accepts` 里（仅限确实会发到上游的字段） | `PARAM_UNSUPPORTED` |
| 枚举不在白名单（含图片档位按 `WxH` 折算 tier 后判断） | `VALUE_NOT_ALLOWED` |
| 范围越界 / 非整数 | `VALUE_OUT_OF_RANGE` |
| 固定值不符（例：线路一固定 30 秒） | `VALUE_MUST_BE` |
| 条目**明确声明** `supported:false` 的能力开关被打开 | `FEATURE_UNSUPPORTED` |
| 参考素材数量 / 单张字节超限 | `REFERENCE_LIMIT` / `REFERENCE_TOO_LARGE` |

判定为 **warning（放行 + 提示）**：`unknown` 边界（`PARAM_UNVERIFIED`）、部分候选限制、
未收录模型（`MODEL_NOT_IN_CONFIG`）。

刻意不参与「不在 accepts 里就拦」判定的字段，因为它们并不是独立发出去的参数：图片的
`ratio`（折算进 `size` 宽高）、`negativePrompt`（拼进提示词文本）、
`responseFormat/historyDisabled/stream`（渲染层对所有图片模型都会带上，非 gpt-image-2 在适配层忽略）。
把「未声明」一律当成「不支持」会造成大面积误拦，所以能力开关只按条目**明确写下的** `supported:false` 拦截。

## 7. UI 接入点

| 位置 | 行为 |
| --- | --- |
| 侧栏图像 / 视频工作区 | 模型卡片下方新增能力面板：`可以做` / `不能做` / `参数限制` / `原表说明`，并标注配置来源（服务器 r12 / 本地缓存 / 内置默认） |
| 侧栏设置 → 「模型能力配置 CONFIG」 | 服务器地址、立即刷新、恢复内置默认、当前来源与版本、上次拉取、下次自动刷新、错误原因 |
| 视频模型 profile（`agent-sidebar.getVideoModelProfile`） | 用 CONFIG 覆盖能力与限制，**保留** `routeLabel/routeGroup/price` 等线路元数据 → 既有的控件隐藏、非法值回落、超额连线断开全部自动跟随 CONFIG |
| 图片模型 profile（`agent-sidebar.getImageModelProfile`） | 用 CONFIG 覆盖 `resolutionTiers/defaultResolutionTier`（例如 mj_imagine 只有 1K/2K） |
| 侧栏「生成图片 / 生成视频」 | 提交前校验；有 error 则内联报错并中止 |
| 画布生成器气泡「开始生成」 | 提交前校验；有 error 时在气泡内报错并中止，`unknown` 类警告走顶栏状态条 |

CONFIG 变化（首次拉取成功 / 手动刷新 / 恢复默认）会通过 `modelConfigStore.subscribe` 触发能力面板重绘，
不需要重启应用。

## 8. 运维：更新流程

**改模型能力（不改客户端代码）**：登录 `https://artconfig.ravenhash.org/admin` → 在编辑器里改
→ 「校验」→「保存并应用」。服务端立刻生成一个带时间戳的新版本（`20260911T230012-r7.json`）并
把 `current` 指针指过去，客户端在 1 小时内（或用户点「立即刷新」）就能拿到。老版本自动留档；
任意历史版本可一键「应用为现行」回滚。服务端的版本/备份/回滚语义见 `configserver/README.md`。

**新增一条线路（改代码）**：先加到 `shared/model-channels.source.csv`，跑
`node scripts/sync-model-config.mjs --scaffold` 拿骨架，人工补全 `options / capabilities / prompt`
（**只写真的知道的边界**，不知道就用 `unknown`），并入 `shared/model-config.default.json`，
然后 `--write` 重新生成渲染层模块，最后 `npm test` 会强制校验逐行覆盖与 notes 一致。

**服务端地址**：客户端内置 `https://artconfig.ravenhash.org/config`（只要求是 http(s) URL，
可改成自建地址，或清空以关闭远端更新）。若这台服务器还没上线，界面上会显示「拉取失败：…」并
**继续使用本地缓存/内置默认配置**，功能完全可用。

## 9. 验证

```bash
npm run check:model-config        # CSV ↔ CONFIG 逐行覆盖 + notes 一致 + 生成产物/服务端副本同步
npm test                          # 客户端 + configserver 全部测试（含 HTTP 端到端）
npm run test:model-config:smoke   # 真实 configserver + 真实 Electron 渲染层的端到端烟测
```

烟测（`scripts/model-config-smoke.cjs`）不依赖 Playwright：它**以独立进程启动真实的
`configserver`**，再起真实 Electron 主进程 + 真实 `dist` 产物，隐藏窗口后在渲染进程里断言 DOM。
链路是完整的「管理面板写入 r1 → 客户端自动拉取并应用到能力面板 → 管理面板回滚 r0 → 界面点
『立即刷新』跟着回退」，用来兜住单元测试覆盖不到的「打包后加载顺序 / 挂载点 / preload 桥 /
CONFIG→既有 profile→控件 / 真机网络路径」这一层。

## 10. 已知边界

- **应用内既有的视频参数强约束仍以代码为准**：例如 `video-provider-adapters.js` 对
  `sd2.5-route1/route2/haidiyue-face` 一律要求恰好 30 秒，而 CSV 写的是「线路二时长可调整，以上游为准」。
  CONFIG 按**客户端实际约束**收敛（否则界面会放行一个必被自己代码拒绝的值），CSV 原文仍完整保留在
  `notes` 里，条目里也写明了这处偏离的原因。
- **文字模型**目前没有维护上下文窗口/最大输出 Token，CONFIG 里以 `unknown` 记录并展示为「未维护」。
- 参考素材的**字节**上限目前只有图片单张 50MB 进了 CONFIG；视频/音频的字节预算仍在
  `mcp-bridge.js` 的压缩流程里，尚未纳入 CONFIG。
- `match.endpoint` 的条目（如 MiniMax H3 原生任务中心）只在 endpoint 命中时生效；只填模型名不填
  endpoint 时不会套用它的「固定 720p、不支持参考视频」限制——宁可不限制，也不错限制。
