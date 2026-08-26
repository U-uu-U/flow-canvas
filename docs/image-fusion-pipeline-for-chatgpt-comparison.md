# Flow Canvas 多参考图融图链路说明

更新时间：2026-08-25

用途：把 Flow Canvas 当前的多参考图融图实现交给 ChatGPT 或其他模型进行流程比对。本文描述的是当前代码中的真实执行链，不代表 ChatGPT 网站内部未公开的实现。

## 1. 当前实现结论

Flow Canvas 当前使用的是一条直接图片编辑链路：

```text
画布素材与连线
  -> 图片生成节点
  -> 拼装提示词和参考图数组
  -> IPC 进入 Electron 主进程
  -> POST /v1/images/edits
  -> RavenHash/OpenAI 兼容图片模型
  -> 下载结果并写入本地文件
  -> 回填到原图片生成节点
```

它不是一个对话式图像创作代理。目前没有在生图前调用文字/视觉模型理解两张图，也没有让主模型规划图片职责、改写提示词、检查结果或自动重试。

## 2. 代码框架

| 层级 | 文件 | 主要职责 |
| --- | --- | --- |
| 画布交互 | `src/canvas.js` | 创建图片生成节点、展示参考图、维护“图一/图二”引用胶囊、提交生成 |
| 图结构 | `src/graph-model.js` | 按连接顺序收集上游文本和图片输入 |
| 节点执行 | `src/graph-runner.js` | 计算拓扑顺序，执行上游素材节点和目标图片节点 |
| 图片节点 | `src/node-types.js` | 还原引用胶囊、合并提示词、整理参考图、选择图片 provider |
| 图片预处理 | `src/agent-sidebar.js` | 检查参考图总大小，超过阈值时提示压缩或使用原图 |
| Renderer IPC | `electron-main/preload.js` | 调用 `mcp:image:generate` |
| 主进程桥接 | `electron-main/mcp-bridge.js` | 校验图片、选择 `/images/edits`、发送请求、解析响应、保存文件 |
| Multipart 构造 | `electron-main/openai-image-request.js` | 把多张本地图片按顺序写成 `image[]` multipart 字段 |

关键函数：

- `CanvasManager.openGenerationComposer()`
- `CanvasManager._generationComposerCitationState()`
- `CanvasManager._runGeneratorFromComposer()`
- `collectInputs()`
- `GraphRunner.runFrom()`
- `NODE_TYPES.image.execute()`
- `expandGenerationPrompts()`
- `prepareGenerationReferences()`
- `FlowCanvasBridge.generateImageFromRenderer()`
- `collectImageSourceReferences()`
- `tryGenerateWithOpenAI()`
- `buildImageEditMultipart()`

## 3. 详细执行流程

### 3.1 画布输入

1. 每张素材通过一条连接进入图片生成节点的统一 `source` 端口。
2. 连接在画布连接数组中的先后顺序就是参考图上传顺序。
3. 图片引用胶囊单独存储，不直接混在纯文本字段里：

```js
config.prompt
config.referenceCitationIds
config.referenceCitationLabels
config.referenceCitationOffsets
```

4. 执行前，`restoreReferenceCitations()` 根据 offset 把“图一/图二”重新插回纯文本。
5. 代码会额外添加参考图顺序说明，避免模型不知道图片编号：

```text
参考图编号与上传顺序一致：图一=第1张，图二=第2张。
```

### 3.2 节点执行

`GraphRunner` 从图片生成节点向上回溯，先执行两个素材节点。素材节点输出：

```text
local-res://<本地绝对路径>
```

`collectInputs()` 按连接顺序把多个输出收集成数组。`NODE_TYPES.image.execute()` 将其中的文本和图片分流：

```js
sources = [上游文本, 图片1, 图片2, ...]
prompts = 合并后的提示词数组
refs = [{ filePath: 图片1 }, { filePath: 图片2 }, ...]
```

图片生成数量和并发数在这里展开。每个生成任务使用同一组参考图。

### 3.3 图片预处理

当前自动检查阈值为所有参考图合计 `6 MB`。

- 未超过阈值：使用原图。
- 超过阈值：弹窗让用户选择原图、压缩后加入画布、临时压缩但不加入画布，或取消。
- 压缩后的参考图数组保持原来的先后顺序。
- 主进程只接受 `.png`、`.jpg`、`.jpeg`、`.webp` 作为图片编辑输入。
- 单张图片硬限制为 `50 MB`。

压缩可能影响细节，但不是每次请求都会发生。

### 3.4 Electron 主进程请求

Renderer 调用：

```js
window.flowCanvas.mcp.generateImage({
  provider: 'openai',
  providerConfig,
  prompt,
  size,
  quality,
  responseFormat: 'url',
  sourceReferences,
  addToCanvas: false
})
```

主进程根据参考图数量选择接口：

- 有参考图：`POST /v1/images/edits`
- 无参考图：`POST /v1/images/generations`

当前多图编辑请求是 `multipart/form-data`：

```text
model=gpt-image-2
prompt=<最终提示词>
n=1
quality=high
response_format=url
size=<节点设置的尺寸>
image[]=@第一张参考图
image[]=@第二张参考图
...
```

请求头还包含：

```text
Authorization: Bearer <API Key>
Idempotency-Key: <request id>
X-Log-Id: <request id>
```

超时时间为 300 秒。当前没有发送 mask，也没有发送对话历史。

### 3.5 响应与回填

1. 只读取响应中的第一张图：`data[0]`。
2. 支持 `url`、`b64_json`、`base64` 等结果形态。
3. URL 结果会被下载到内存。
4. 使用 Sharp 读取真实格式和尺寸。
5. 文件写入当前目标目录，文件名由提示词摘要和随机/唯一信息生成。
6. Renderer 收到本地路径后，将结果写入原图片生成节点的 `resultFilePaths`。
7. 当前不会自动分析输出是否满足提示词，也不会自动重新生成。

## 4. 本次两图融图的实际请求语义

当前连接顺序：

```text
图一 / 第1张：白底的人类与机器人合照
图二 / 第2张：BANK 门店入口、人类与机器人场景
```

用户界面中的原始文字和引用胶囊会被还原为：

```text
参考图编号与上传顺序一致：图一=第1张，图二=第2张。
使用图一的机器人和人的比例重新绘制图二
```

节点参数：

```text
model: gpt-image-2
size: 2880x2880
quality: high
n: 1
```

这个提示词仍然比较宽泛。它没有明确要求必须保留图二中的 BANK 标牌、入口构图、台阶、植栽和视角，也没有明确禁止改成工厂或工作台场景。

## 5. 与 ChatGPT 网站可能存在的关键差异

### 5.1 已由 OpenAI 官方文档确认的 API 差异

OpenAI 官方文档把两条路线区分为：

- Image API：适合一次提示词的一次生成或编辑。
- Responses API：适合对话式、多步骤和多轮图片编辑；主模型可以在上下文中调用图片生成工具。

Flow Canvas 当前使用第一条，即直接调用 Image API 的 `/v1/images/edits`。它没有使用 Responses API，也没有 `previous_response_id` 或多轮上下文。

官方文档还说明：`gpt-image-2` 会自动以高保真方式处理所有输入图片，因此不应该为这个模型发送 `input_fidelity`。当前 Flow Canvas 没有发送该字段是符合官方要求的，这不是当前主要差异。

官方资料：

- [OpenAI Image generation guide](https://developers.openai.com/api/docs/guides/image-generation)
- [OpenAI Edit Images](https://developers.openai.com/api/docs/guides/image-generation#edit-images)

### 5.2 当前代码确定没有的步骤

Flow Canvas 当前没有以下步骤：

1. 生图前调用视觉理解模型分别描述两张图。
2. 将图片转换为结构化职责，例如“图一只提供比例，图二提供构图和场景”。
3. 使用主语言模型扩写或审查最终生图提示词。
4. 使用 Responses API 的 `image_generation` 工具。
5. 保留对话历史并进行多轮编辑。
6. 对结果做视觉比对、评分或自动重试。
7. 为不同参考图设置权重、锁定区域或 mask。
8. 明确指定哪张图片是底图、哪张只提供局部属性，除了自然语言和数组顺序之外没有额外结构。

### 5.3 无法从公开资料确认的部分

ChatGPT 网站内部是否使用额外系统提示词、怎样自动改写用户提示词、是否先做图像理解、是否自动尝试多次，这些属于未公开实现，不能从 Flow Canvas 代码或公开 API 文档中确认。

另外，Flow Canvas 当前通过 RavenHash 中转站调用名为 `gpt-image-2` 的模型。仅凭模型名无法证明中转站的实际路由、快照版本、参数处理和 ChatGPT 网站完全一致。

## 6. 建议让 ChatGPT 重点回答的问题

可以把本文发给 ChatGPT，并附上下面的问题：

```text
请将这份 Flow Canvas 多参考图融图流程与你在 ChatGPT 网站中处理多图生图时的公开可说明流程进行比较。

请重点分析：
1. 直接调用 /v1/images/edits 与通过 Responses API + image_generation 工具的差异；
2. ChatGPT 是否会先理解每张图片并重写提示词；
3. 两张参考图的先后顺序和角色描述应该如何表达；
4. 当前请求参数是否遗漏了会明显影响多图融合质量的公开参数；
5. 如何设计“图一只提供人物与机器人比例，图二必须保留场景和构图”的稳定流程；
6. 是否应该先生成结构化编辑计划，再调用图片模型；
7. 是否应该支持多轮编辑、结果检查和自动重试。

请把官方文档能确认的事实和对 ChatGPT 网站内部实现的推测分开，不要把未公开的系统提示词当成事实。
```

## 7. 一个更明确的当前 Image API 提示词示例

如果仍使用 `/v1/images/edits`，可以先测试更严格的提示词：

```text
参考图编号与上传顺序一致：图一为第1张，图二为第2张。

以图二作为唯一的基础场景和主体构图重新绘制。必须保留图二中的 BANK 门店标牌、入口、台阶、植栽、人物行走方向、机器人站位以及原始相机视角。

图一仅用于参考人类与机器人的相对身高、体量和比例关系。不要复制图一的白色背景、人物服装、机器人造型或构图。

将图二中的人类和机器人调整为图一所展示的相对比例，除此之外不要改变图二的场景类型。不要生成工厂、车间、仓库、工作台或工业操作场景。
```

这个示例仍然只是在改善一次性 Image API 的提示词，不等同于 ChatGPT 网站的对话式图片创作流程。
