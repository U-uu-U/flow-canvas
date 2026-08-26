# 节点体系设计

本文记录 flow-canvas 节点体系的设计决策**及其理由**。理由比结论重要——半年后回看时，能避免反复推翻已经想清楚的事。

## 背景：为什么现在的节点没用

现有 [src/node-types.js](../src/node-types.js) 定义了 5 个节点类型，但它**没有被任何文件 import**。[src/canvas.js](../src/canvas.js) 里没有 connection、port、拓扑排序。所以这套注册表目前是死代码，画布只能摆素材，不能连线执行。

这解释了"节点不实用"的直觉，而且原因是结构性的：

1. **孤立的节点没有价值。** 单个 `image_gen` 节点确实不如侧栏聊天方便——因为它没有下游。节点体系的价值不在单点功能，而在**连线让输出成为下一步的输入**。
2. **素材卡片和生成节点是两套东西。** 侧栏生成完还得手动摆到画布上。节点体系里，生成结果应该**自动成为一个新节点**，可以立刻连出去做下一步。这一步做通，节点相对侧栏才第一次有优势。

## 对标结论

三个参考对象，结论出乎意料地一致：**节点种类都极少**。

| | Infinite-Canvas | Flora | Krea |
|---|---|---|---|
| 节点数 | 5 | 3 核心 | 模型多，节点抽象少 |
| 文本 | smart-prompt（带 LLM） | Text Node | 有 |
| 媒体+生成+输出 | 全归 smart-image | Image / Video 分开 | 按模态分 |
| 批量 | smart-loop | Batch Node | 有 |
| 封装管线 | 无 | **Techniques** | 有 |
| 自动搭图 | 无 | 无 | **Node Agent** |

关键更正：Infinite-Canvas 只有 **5 个真节点**（`smart-image` / `smart-prompt` / `smart-loop` / `smart-group` / `smart-minimax`）。代码里的 `llm`、`comfy`、`rh`、`video`、`jimeng` 等**不是节点类型**，而是配置在 `smart-image` 上的「生成引擎 / 模型家族」属性。midjourney 前后端均无实现。

没有任何一家做数值节点或数学节点。

Flora 只有 Text / Image / Video 三个，典型用法是串起来：Text 写场景 → Image 出图 → 那张图喂给 Video 动起来。补充机制是 Techniques（多步管线封装成单节点）和 Batch Node（多个输入灌进下游批量产出）。

Krea 的可发现性设计值得抄：连线**按数据类型颜色编码**，从任一 handle 拖出会**列出所有可连的节点**。

LovArt 不是节点图，走多智能体自动编排，不作为节点设计的参考。

## 决策

### 删除：数值节点、数学节点

这是 ComfyUI 思路的误植。ComfyUI 的用户是调参工程师，需要把 seed、steps、cfg 拆成可连线的数值。创作者不需要——他们要的是「这张图再来一版」，不是「把 7 这个数字连到 steps 端口」。

三个对标产品无一例外没有这类节点。

### 合并：素材节点 = 生成节点 = 输出节点

统一成**一个媒体节点**，同时承担三个角色：

- 你导入或拖进来的素材
- 挂上 prompt 和引擎后的生成器
- 生成结果的落地容器

抄 Infinite-Canvas 的做法：**没有独立的「输出节点」**。生成时自动新建一个媒体节点承接结果（参考 `createPendingOutputFromSource`，smart-canvas.js:4673），按产物类型改名为 Image / Video / Audio / Text。

这是让节点体系产生实际价值的最小闭环，应当**优先实现**。

### 保留并做强：文本节点

带 LLM 改写能力，且**多模态**——能吃上游的图和视频。参考 Infinite 的 `smart-prompt`：`promptSplitEnabled` 按分隔符把一个节点拆成多个 prompt 项，正好喂给批量节点。

### 新增：批量节点

抄 `smart-loop`。这是节点图相对侧栏聊天**最不可替代**的能力。

需要的参数：
- `count` 轮数
- `startIndex` 起始序号
- `imageBatchSize` 每轮消费几张上游图
- prompt 里的**计数占位符**（Infinite 用 `《计数》`），按轮次替换
- `serial` / `parallel` 模式，并行用 worker pool
- 协作式中断（run 按钮变 stop，检查 `stopRequested`）

输出行为：每轮产出一个独立输出槽，**追加而非覆盖**。

### 新增：封装节点

抄 Flora 的 Techniques——把多步管线存成一个有明确输入输出的单节点。

你已经有 workflow config 的雏形，这条路比增加节点种类划算得多：加新能力只需加一个 config，不改 JS。

## 连线模型

抄 Infinite-Canvas 的整套设计。

### 三种边类型

对应 `conn.kind`（smart-canvas.js:6343）：

- **`flow`** — 默认，执行链
- **`input`** — 显式数据输入边，同时把源 id 镜像进目标的 `inputNodeIds[]`
- **`history`** — 溯源链接，**不参与执行遍历**

`history` 边让「这张图是从哪张图生成的」可视化，又不会污染执行图。

### 数据传递：消费者拉取

不是推送。目标节点顺着 `inputNodeIds` 主动去上游拉 `images[]`：

1. 目标解析上游集合
2. 拉取上游的 `images[]`
3. 去重后分配**位置编号** `image_1 … image_N`
4. prompt 里的 `@提及` 可指定用哪张图，并给模型一份「图1：文件名」的图例
5. 上游文本前置拼进 prompt

### 单图屏蔽

参考 `blockedInputRefKeys`（smart-canvas.js:14591）：下游可以**屏蔽某一张**上游参考图，而不删掉整条边。实际用起来很关键——试「去掉这张参考图会怎样」时不必反复连线。

### 可发现性（抄 Krea）

- 连线按 dataType **颜色编码**。现有 node-types.js 已有 dataType 字段，底子在。
- 从端口拖出时**列出可连的节点类型**，而不是让用户猜。

### 移植注意

Infinite-Canvas 是 **DOM + SVG** 渲染，本项目是 **Konva canvas**。两套引擎不同，**源码不能照抄**，只能移植交互逻辑。详见 [architecture.md](architecture.md)。

## 待定问题

- 端口画在卡片边缘上，还是做成独立的可拖拽小控件？
- 媒体节点合并后，纯素材卡片（没有生成配置的）是否仍需要视觉上的区分？
- 封装节点的 config schema 格式，与现有 workflow config 如何统一？

## 参考来源

- [Flora Canvas 文档](https://docs.florafauna.ai/editor/canvas) · [Techniques](https://docs.flora.ai/nodes/techniques) · [Batch Node](https://docs.flora.ai/nodes/batch-node)
- [Krea Nodes 文档](https://www.krea.ai/docs/user-guide/features/nodes) · [Node Agent](https://www.krea.ai/index/ai-workflow-agent)
- Infinite-Canvas 源码：`E:/案例/Infinite-Canvas/static/js/smart-canvas.js`
