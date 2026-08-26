# 路线图

按**投入产出比**排序，不是按功能大小。每项标注为什么在这个位置。

设计依据见 [node-system-design.md](node-system-design.md)，现状见 [architecture.md](architecture.md)。

## 已完成

- 零拷贝素材索引 + chokidar 实时监听
- 视口裁剪 + LOD 缩略图 + 懒加载
- 图数据模型（`graph-model.js`，含拓扑排序、连线校验、成环检测，有测试）
- 撤销栈（`undo-stack.js`，有测试）
- 端口与连线渲染（`graph-view.js`）
- 连线拖拽交互（单 document 路径 + 容错命中，修掉了连不上和节点黏手）
- GSAP 手风琴侧栏 + 文件夹分组
- MCP 桥接、浏览器扩展同步

## 1. 媒体节点合并 + 生成结果自动落地

**最高优先级。这是让节点体系产生实际价值的最小闭环。**

把「素材卡片」和「生成节点」统一成一个媒体节点，生成结果**自动新建节点承接**，可以立刻连出去做下一步。

为什么排第一：不做这个，节点相对侧栏聊天没有任何优势——侧栏生成完还得手动摆到画布上。这是「节点不实用」的结构性原因。

同时删掉数值节点和数学节点（ComfyUI 思路误植，创作者不需要）。

## 2. 异步任务模型

生成提交返回 `task_id`，前端轮询状态，任务状态存在主进程侧，刷新不丢。

为什么排第二：现在是同步 await 一个 HTTP 请求，视频生成动辄几分钟，会直接超时。**加视频能力前这层必须先补**，否则第 5 项没法做。

参考 Infinite-Canvas：`POST` 拿 task_id → 定时轮询 → 写回节点。它对超长队列（jimeng）还有 60 秒 × 1440 的独立轮询，能跨重启存活。

## 3. workflow config 外置成 JSON

每个字段声明 `node` / `input` / `type` / `default` / `min` / `max` / `options`，UI 从 JSON 自动生成表单。

为什么排第三：低成本高回报。现在加第二个模型就得改 JS。外置后加新能力只需加一个 config 文件，顺带能拿到 seed 随机化这类细节。这也是第 6 项「封装节点」的前置。

参考 `E:/案例/Infinite-Canvas/workflows/MiniMax_H3.config.json`。

## 4. 批量节点

`count` 轮数、`startIndex` 起始序号、`imageBatchSize` 每轮消费几张图、prompt 计数占位符、serial / parallel 模式、协作式中断。每轮产出独立输出槽，追加而非覆盖。

为什么排第四：这是节点图**最不可替代**的能力（一个 prompt 列表 × 多个变体一次跑完），但依赖第 1 项的媒体节点和第 2 项的异步任务先就位。

参考 Infinite-Canvas 的 `smart-loop`，以及 Flora 的 Batch Node。

## 5. 视频生成

依赖第 2 项。放在批量节点之后，因为视频单次成本高，先有批量控制再放开视频更合理。

## 6. 封装节点（Techniques）

把多步管线存成一个有明确输入输出的单节点。依赖第 3 项的 config schema。

比增加节点种类划算得多——这是 Flora 用 3 个节点覆盖复杂场景的关键。

## 7. 多画布 + 回收站

projects → canvases 两级，每个画布独立文件，带回收站和恢复。

为什么排这里：现在误删一个分组不可恢复（撤销栈只在会话内）。风险真实存在，但不阻塞前面的能力建设。

## 8. 体验补齐

按需做，互不依赖：

- **小地图** — 素材上千张后没有导航会迷路。rAF 节流重绘，可点击跳转。
- **触屏桥接** — 单指 touch → mouse 事件，双指捏合 → wheel，跳过 input 和可滚动容器。`E:/案例/Infinite-Canvas/static/js/touch-mouse.js` 只有 6KB，逻辑可直接移植（注意 Konva 与 DOM 的差异）。
- **深色模式 + UI 缩放** — 高分屏需要 60%~140% 缩放。
- **i18n** — 极简双语字典 + 漏翻校验脚本。
- **图像编辑** — crop / outpaint 扩图 / mask inpaint。
- **清理根目录** — `test2.js` ~ `test8.js`、`test_electron*.js` 等调试脚本与正式测试无关。

## 明确不做

- **数值节点 / 数学节点** — 见 [node-system-design.md](node-system-design.md)
- **多智能体自动编排**（LovArt 路线）— 与节点图是两种范式，不混
- **单文件巨型模块** — Infinite-Canvas 的 963KB `smart-canvas.js` 是反面教材
