# 架构现状

本文记录 flow-canvas **既成事实的架构**，不是规划。规划见 [roadmap.md](roadmap.md)，节点体系设计见 [node-system-design.md](node-system-design.md)。

## 技术栈

Electron + Vite + Konva，无框架（原生 JS ES module）。

依赖只有 4 个：`konva`（画布渲染）、`chokidar`（文件监听）、`sharp`（缩略图）、`gsap`（侧栏动画）。刻意保持精简。

```
npm run electron:dev   # Vite (127.0.0.1:15321) + Electron 并行
npm test               # node --test，3 个测试文件
npm run electron:build # vite build + electron-builder
```

## 进程划分

**主进程** `electron-main/`
- `main.js` — 窗口、IPC
- `store.js` — 持久化
- `watcher.js` — chokidar 文件监听
- `thumbnailer.js` — sharp 生成缩略图
- `local-resource.js` — 本地文件协议
- `mcp-bridge.js` — MCP 桥接
- `browser-sync.js` — 浏览器扩展同步
- `preload.js` / `orb-preload.js` — 渲染进程桥

**渲染进程** `src/`
- `canvas.js` — Konva 画布主体（最大的文件）
- `graph-model.js` — 图数据模型（纯函数，可测试）
- `graph-view.js` — 端口与连线的 Konva 渲染
- `graph-runner.js` — 节点执行
- `node-types.js` — 节点类型注册表
- `undo-stack.js` — 撤销栈
- `sidebar.js` / `agent-sidebar.js` — 侧栏
- `context-menu.js` — 右键菜单
- `plan-service.js` — 计划服务

**MCP** `mcp/flow-canvas-mcp.mjs`（`npm run mcp`）

注意：本项目**没有 Express 网关，没有 `server/` 目录**。外部能力走 MCP 和 `mcp-bridge.js`。

## 存储：零拷贝索引

`electron-main/store.js` 把整个画布存成**单个 `board.json`**，位于 app 数据目录。

核心设计：**只存 filePath + 坐标，不复制素材文件**。画布引用磁盘上的原始位置，所以往画布上放 5000 张图不会产生 5000 份拷贝。

两处防误删保护：
- 拒绝可疑的空数据覆盖（store.js:59）——防止渲染进程异常时把 board.json 清空
- 写入前备份（store.js:157）

没有数据库。数据量是 KB 级，JSON 足够。

## 渲染性能

三个已实现的优化，都在 `canvas.js`：

- **视口裁剪** — 只渲染可见区域的节点
- **LOD 缩略图** — 按缩放级别切换清晰度，`sharp` 在主进程预生成
- **懒加载** — 图片按需载入

`chokidar` 监听素材目录，磁盘上改名/删除会实时反映到画布。

## 图模型已经落地

`graph-model.js` 是纯函数模块，已被 `graph-view.js` / `graph-runner.js` / `canvas.js` 使用，有测试覆盖：

| 函数 | 作用 |
|---|---|
| `getPorts(item)` | 从 node-types 注册表解析节点端口 |
| `typesCompatible(a, b)` | dataType 兼容性判断 |
| `reachable(from, to, conns)` | 可达性，用于成环检测 |
| `canConnect(...)` | 连线合法性总校验 |
| `topoOrder(targetId, ...)` | 拓扑排序，决定执行顺序 |
| `collectInputs(item, ...)` | 收集上游输入（消费者拉取） |
| `mediaOutput(item)` | 取节点的媒体产物 |
| `connectionsWithout(nodeId)` | 删节点时清理边 |
| `downstreamOf(targetId)` | 下游节点集合 |

`undo-stack.js` 导出 `snapshot(items, connections)` 和 `UndoStack` 类——深拷贝快照入栈的朴素做法，对 KB 级数据完全够用。

测试：`npm test` 跑 graph-model / graph-runner / undo-stack 三个文件。

## 移植 Infinite-Canvas 的注意事项

**这一条能省掉一次错误尝试。**

Infinite-Canvas（`E:/案例/Infinite-Canvas`）是 **DOM + SVG** 渲染：HTML div 做节点，SVG 画连线，document 级事件驱动交互。本项目是 **Konva canvas**：所有东西画在 canvas 上，事件走 Konva 的合成事件系统。

**两套引擎不同，源码不能复制粘贴，只能移植交互逻辑。**

已经踩过的坑：Konva 的合成 `mouseup` **晚于**原生 `pointerup` 触发。如果同时注册 window 级 `pointerup` 兜底和 Konva stage 的 `mouseup` 处理器，前者会先把拖拽状态清空，导致后者永远拿不到状态——连线永远建不起来。

解法（已实施，见 `graph-view.js`）：
- **单一 document 级 mouseup 驱动**拖拽结束，不要双路径竞争
- 指针坐标**从原生事件 clientX/Y 换算**，不依赖 Konva 缓存的 pointerPosition——document 事件在画布外触发时缓存会过期
- 命中判定**容错**：先试精确命中端口，命中不到就落到指针下的节点、取对端应有一侧的端口，不要求对准几像素的小圆点

另一个结构差异：Infinite-Canvas 的 `smart-canvas.js` 是 963KB 单文件（约 19000 行），后端 `main.py` 也是单文件。**这是不该学的部分**——本项目的模块划分明显更健康，保持下去。

## 已知薄弱点

- 无异步任务模型。生成走同步 await，视频生成会超时，刷新丢任务。
- workflow 参数硬编码在 `node-types.js`，加新模型要改 JS。
- 单画布。只有一个 `board.json`，误删无法恢复（无回收站）。
- 无小地图。素材多了会迷路。
- 无触屏支持。`canvas.js` 里没有 touchstart / pointerdown，触屏笔记本不能用。
- 无深色模式，无 i18n。
- 根目录堆积了 `test2.js` ~ `test8.js`、`test_electron*.js` 等调试脚本，与 `npm test` 的正式测试无关，建议清理。
