# Flow Canvas Agent 画板控制与创作系统路线图

> 状态：设计基线
> 日期：2026-08-31
> 范围：Agent 画板控制、通用表格、编剧与分镜、Skill 复用、任务审阅

### 实施进度

- 已完成：`BoardSnapshot`、`BoardTransaction`、项目级 revision、幂等键、原子预演/提交、整笔 undo token。
- 已完成：节点增删改/复制、连线增删、横排/竖排/网格排列，以及共享画板工具注册表。
- 已完成：AgentSidebar 与标准 MCP 共用 `flow_canvas.board.get_snapshot`、`flow_canvas.board.transaction.preview/apply/undo`。
- 已完成：MCP stdio、localhost HTTP Bridge、Electron IPC 与 renderer 事务执行器端到端接通；写事务串行，支持 readiness、超时和结构化错误。
- 下一切片：文字 Provider 原生 tool-calling 循环、Agent 执行卡和 ghost preview。
- 后续切片：通用文档/表格和编剧分镜实体。

## 1. 目标

Flow Canvas 的下一阶段不应只是给侧边栏增加更多提示词，也不应让 Agent 模拟鼠标点击 UI。目标是建立一套稳定、可回滚、可审阅的语义化画板控制层，让以下能力共用同一套底层：

- 读取选中节点、上下游、可见区域、规划表和项目素材。
- 创建、修改、删除、连接、排列和执行画板节点。
- 通过自然语言生成和维护通用表格。
- 从创意简报生成故事设定、剧本、场景、镜头表和分镜。
- 调用图片、视频、音频模型并持续跟踪异步任务。
- 把成熟流程保存成可复用、可版本化的 Skill。
- 在高成本或破坏性步骤前集中审阅，而不是每一步弹确认。

核心原则：**Agent 产出结构化操作计划，画板执行器负责校验和落地，Konva 只负责显示。**

## 2. 竞品结论

| 产品 | 值得吸收 | 不建议照搬 |
| --- | --- | --- |
| Coze | 项目级上下文隔离、多人多 Agent、长期记忆、技能商店、视频项目从剧本到成片、后台任务 | 把所有能力做成聊天入口；云服务和账号体系优先于本地工作流 |
| LibTV | 面向人和 Agent 的同一创作画布；项目/会话隔离；上传、增量轮询、下载组成完整异步闭环；专业后端 Agent 负责拆解和选模型 | 用户侧 Agent 只是传话，画板内部步骤不透明；无法细粒度审阅每次画板变更 |
| MiniMax Design | 创意简报、自动任务图、文本/图片/视频/音乐同画布、Skill/插件、本地素材桥接、关键检查点 | 一句话包办一切容易掩盖中间结构，不能把黑盒自动化作为唯一模式 |
| Krea Nodes | Agent 先读取完整画布，再展示计划；构建前校验类型和参数；展示成本；只重跑变更节点的下游 | 工程化节点和参数过多会提高普通创作者门槛 |
| LTX Studio | 项目、故事板、单帧三级控制；脚本直接转故事板；角色和视觉连续性；团队可逐帧审阅 | 以线性影视流程为中心，不适合替代 Flow Canvas 的自由画板 |
| FLORA | Text/Image/Video 少量核心节点；Technique 封装流程；批量扩展；MCP/API | 如果所有逻辑都塞进节点，画布会再次变成参数面板 |
| Lovart | Brief 到交付物的 Agent 工作流；局部 Touch Edit；Brand Kit；批量多规格输出 | 结果导向强，但过程数据和依赖关系不够显式 |

综合结论：

1. 学 Krea 的“先计划、再验证、后执行”。
2. 学 MiniMax 的“连续生产流程 + 关键检查点”。
3. 学 Coze 的“项目、资产、记忆和 Skill 隔离”。
4. 学 LibTV 的“会话、异步任务、增量事件和自动下载”。
5. 学 LTX 的“项目到镜头的分层结构”，但保留自由画板。
6. 学 FLORA 的“少节点、多模板、可封装”，不要增加大量专用节点。

## 3. 当前基础与缺口

### 已有基础

- `graph-model.js` 已支持端口、类型检查、环检测、拓扑排序和上下游收集。
- `graph-runner.js` 已支持节点执行、并发隔离、失败传播和结果缓存。
- `plan-service` 已支持规划表 CRUD、素材引用和 Markdown 导出。
- MCP 已支持规划表、素材项、图片生成和视频生成。
- Agent 已能读取项目规划上下文，且对话和输入缓存按项目隔离。
- 图片生成 Agent 模式已能汇总上游提示词、素材和参数。
- 画板已有撤销栈、任务记录、生成占位、父子溯源线和异步轮询基础。

### 关键缺口

- Agent 仍主要走普通文字对话，没有真正的 tool-calling 循环。
- 当前“Skill”只是硬编码提示词片段，不是有输入输出和权限的可执行模块。
- MCP 已补齐节点、连线、排列和整笔撤销，但分组、聚焦视口和节点运行仍未进入事务工具集。
- 基础事务已支持 `baseRevision`、预演、冲突检测、原子提交、幂等和撤销令牌；撤销令牌目前仅在当前应用进程内有效。
- 规划表列结构固定，不能作为通用表格、镜头表、角色表或资产表。
- Agent 返回的规划表依赖从回复文本中截取 JSON，稳定性不足。
- 编剧数据目前只能放在文本或固定表格里，缺少故事设定、场景、镜头等稳定实体。
- 缺少统一成本预估、检查点和部分失败恢复。

## 4. 总体架构

```text
用户指令
   ↓
Agent Orchestrator
   ↓ 读取最小必要上下文
Context Resolver
   ↓
Planner / Skill
   ↓ 生成 BoardTransaction
Validator + Cost Estimator
   ↓
Preview / Checkpoint
   ↓
Transaction Executor
   ↓
Store + Graph + Task Runtime
   ↓
Konva 画板刷新 + Agent 事件流
```

### 4.1 单一工具注册表

建立 `tool-registry`，同一份工具定义同时提供给：

- Flow Canvas 内置 Agent。
- `mcp/flow-canvas-mcp.mjs`。
- 未来的插件或外部 Agent。

工具实现只存在一份，MCP 和不同模型 Provider 只做协议适配。这样不会再次出现“侧边栏能做、MCP 不能做”或两边行为不一致。

### 4.2 上下文按范围读取

Agent 默认不读取整个画板，更不默认上传所有素材。上下文范围按下列优先级扩展：

1. 当前选中节点。
2. 选中节点的上下游邻域。
3. 当前可见视口。
4. 当前项目的表格、故事设定和素材索引。
5. 用户明确要求时才读取完整画板。

快照必须携带 `boardRevision`、稳定节点 ID、连接、尺寸、媒体类型、生成状态和父子来源。图片内容按需取缩略图或原图，不把二进制塞进普通上下文。

### 4.3 事务而非直接改画板

所有 Agent 写操作先形成事务：

```json
{
  "id": "tx_xxx",
  "baseRevision": 42,
  "reason": "把三段文案整理为分镜流程",
  "operations": [
    { "op": "node.create", "tempId": "shot_1", "nodeType": "text", "data": {} },
    { "op": "connection.create", "from": { "nodeId": "source_1" }, "to": { "nodeId": "shot_1" } },
    { "op": "layout.arrange", "nodeIds": ["source_1", "shot_1"], "mode": "horizontal" }
  ],
  "estimatedCost": 0,
  "warnings": []
}
```

执行器必须提供：

- `preview`：校验结构、类型、权限、模型参数、磁盘目录和估算成本。
- `apply`：同一事务原子提交，返回新 revision 和 undo token。
- `undo`：一次撤回整个事务，而不是让用户逐项撤销。
- `idempotencyKey`：任务重试时不重复创建节点或重复扣费。
- 冲突检测：画板 revision 已变化时重新规划或只重算受影响操作。

## 5. 工具族设计

### 5.1 读取工具

| 工具 | 作用 |
| --- | --- |
| `board.get_snapshot` | 按 selection / neighborhood / viewport / project / full 获取快照 |
| `board.query` | 按类型、标签、文件名、状态和来源查询节点 |
| `node.get` | 读取节点完整配置和生成结果 |
| `graph.inspect` | 读取上下游、无效连接、环和缺失输入 |
| `document.get` | 读取表格、剧本、故事设定等结构化文档 |
| `task.list/get` | 读取生成和 Agent 后台任务 |

### 5.2 画板写入工具

| 操作 | 说明 |
| --- | --- |
| `node.create/update/delete/duplicate` | 文本、媒体、生成、文档等统一节点操作 |
| `connection.create/delete` | 显式创建 flow/input/history 连接 |
| `group.create/update/ungroup` | 组织一组节点，不改变其业务数据 |
| `layout.arrange` | 横排、竖排、网格、时间线、故事板排列 |
| `selection.set` / `viewport.focus` | 只改变当前 UI 关注区域，不修改业务内容 |
| `board.transaction.preview/apply/undo` | 统一承载所有批量变更 |

### 5.3 运行工具

| 工具 | 说明 |
| --- | --- |
| `graph.validate` | 类型、必填参数、Provider 能力、成本和输出目录预检 |
| `graph.run` | 执行目标节点的上游闭包 |
| `graph.rerun_downstream` | 只重跑变更点下游，复用上游缓存 |
| `graph.cancel` | 协作式取消，不删除已完成产物 |
| `task.watch` | 使用事件游标增量获取状态，断线后续传 |

### 5.4 文档和表格工具

| 工具 | 说明 |
| --- | --- |
| `document.create/update/delete` | 创建通用结构化文档 |
| `table.schema.update` | 增删改列、类型、枚举和视图配置 |
| `table.row.add/update/delete/batch` | 以稳定 row ID 局部修改，不整表覆盖 |
| `table.link_assets` | 单元格引用画板节点或本地素材 |
| `table.export` | Markdown、CSV、JSON；后续再接 XLSX |

### 5.5 媒体工具

保留现有图片和视频生成能力，但统一成任务接口：

- `media.generate`：image / video / audio。
- `media.edit`：裁切、局部编辑、扩图、续写、超分。
- `media.branch`：从既有产物建立新分支并保留 history 线。
- `media.retry`：沿用相同输入和参数重试。
- `media.download/import`：下载到项目素材目录并加入画板。

Provider 参数继续由 capability profile 约束，Agent 不凭空猜时长、比例或分辨率。

## 6. 通用表格设计

不要继续扩展现在的固定八列表。新增通用 `document` 数据模型，规划表只是一个模板。

```json
{
  "id": "doc_xxx",
  "documentType": "table",
  "templateId": "shot-list.v1",
  "title": "第一集镜头表",
  "schema": [
    { "key": "shot", "label": "镜号", "type": "text" },
    { "key": "duration", "label": "时长", "type": "duration" },
    { "key": "status", "label": "状态", "type": "enum" },
    { "key": "references", "label": "参考素材", "type": "asset_ref", "multiple": true }
  ],
  "rows": []
}
```

首批字段类型：

- `text`、`rich_text`、`number`、`boolean`、`enum`、`duration`。
- `asset_ref`、`node_ref`、`document_ref`。
- `prompt`、`status`、`formula`。

首批模板：

- 普通任务表。
- 故事设定表。
- 角色表。
- 场景表。
- 镜头表。
- 素材清单。
- 生成任务表。

表格生成必须返回结构化工具调用。Agent 修改一个镜头时只 patch 对应行，不能重新生成整张表覆盖用户手工编辑。

## 7. 编剧与分镜系统

### 7.1 领域实体

编剧不是“一段长文本”，应拆成有稳定 ID、可引用、可检查的实体：

- `story_bible`：主题、世界观、风格、受众、硬约束。
- `character`：角色设定、关系、外观锚点、声音锚点。
- `beat`：叙事节拍和目标。
- `episode`：集级结构。
- `scene`：地点、时间、出场角色、冲突和剧情结果。
- `shot`：景别、机位、运动、时长、动作、对白、声音和生成提示词。
- `asset`：角色参考、场景参考、道具、音乐和已生成结果。

镜头表、故事板和画布节点只是这些实体的不同视图，不能各存一份互相漂移的数据。

### 7.2 标准创作链

```text
创意简报
  → 故事设定 / 风格圣经
  → 角色与场景资产
  → 节拍表
  → 分场剧本
  → 镜头表
  → 分镜占位节点
  → 选定镜头生成图片
  → 图片生成视频
  → 审阅、重试、分支和导出
```

每一步都可单独审阅、局部重做。用户可以直接从任意层开始，例如导入已有剧本后只做镜头拆解。

### 7.3 首批创作 Skill

| Skill | 输入 | 输出 |
| --- | --- | --- |
| `story-architect` | brief、已有素材、限制 | story bible、beats、角色草案 |
| `screenwriter` | story bible、beats | episode / scene 文档 |
| `shot-director` | scene、角色和场景参考 | shot list、镜头参数、分镜占位 |
| `continuity-reviewer` | scenes、shots、assets | 连贯性问题，不直接改稿 |
| `asset-librarian` | 项目素材和实体 | 引用匹配、缺失资产报告 |
| `table-builder` | 用户目标和模板 | 表格 schema 与行 patch |

这些首先实现为 Skill，不要默认启动六个长期 Agent。只有在任务可以真正并行且上下文边界清晰时，Orchestrator 才并行调用多个 Skill 或子 Agent。

### 7.4 连贯性检查

生成前至少检查：

- 同一角色的外观、服装、声音和关系是否漂移。
- 场景时间、空间、天气、道具和人物位置是否连续。
- 镜头时长总和是否符合目标片长。
- 相邻镜头轴线、动作方向和景别变化是否合理。
- 每个生成节点是否绑定了正确角色、场景和风格参考。

检查结果作为 issue 列表展示，用户可选择“应用全部”“逐项应用”或忽略；Reviewer 不应静默重写已确认内容。

## 8. Agent 交互设计

侧边栏保持 Codex 风格，但消息区要支持结构化执行卡：

1. **理解**：显示 Agent 使用了哪些画板范围和素材。
2. **计划**：列出将新增、修改、删除和运行的内容。
3. **预检**：显示警告、预计生成次数和成本。
4. **执行**：逐项显示 tool call、耗时和状态。
5. **结果**：定位到画布节点，提供撤销、重试和创建分支。

画布上对未提交的事务使用 ghost preview，确认后再变成真实节点。确认策略分级：

- 读取、检查、定位：自动。
- 可撤销且不产生费用的画板变更：按用户的自动/询问设置执行。
- 付费生成：低于项目预算可自动，超过阈值集中确认一次。
- 删除大量内容、覆盖文件、发布到外部：必须明确确认。

这里的“确认”是产品内的业务检查点，不应变成每个工具调用都弹窗。

## 9. Skill 规范

Skill 至少包含：

```text
skill.json
SKILL.md
schemas/input.json
schemas/output.json
templates/
tests/
```

Manifest 字段：

- `id`、`name`、`version`、`description`。
- `triggers`、`inputSchema`、`outputSchema`。
- `allowedTools`、`requiredCapabilities`。
- `riskLevel`、`estimatedCostPolicy`。
- `projectMemoryKeys`、`contextScopes`。

借鉴 LibTV 的开放 Skill 包形式，但 Flow Canvas Skill 必须调用细粒度语义工具，不能只把用户原话转发给一个黑盒后端。Provider 专业 Agent 可以负责 prompt 和模型编排，画板结构和执行记录仍由 Flow Canvas 掌握。

## 10. 分版本实施

### v1.5：Agent 画板控制内核

范围：

- 建立 tool registry 和 Provider tool-calling 适配。
- 增加 board revision、事务 preview/apply/undo 和幂等键。
- 实现 snapshot、query、node CRUD、connection CRUD、group、layout、focus。
- Agent 侧边栏显示计划卡、执行卡和整笔撤销。
- MCP 改用同一工具注册表。

验收：

- 用户说“把选中的三张图右侧创建三个文本节点并依次连接”，Agent 能预演、执行并一次撤销。
- 画板在预演后被用户手工修改，旧事务不会覆盖新内容。
- 重试同一事务不会产生重复节点。

### v1.6：通用文档与表格

范围：

- 引入 document v2 和数据迁移。
- 动态列、稳定行 ID、批量 patch、素材引用。
- 提供任务表、角色表、场景表、镜头表和素材表模板。
- Markdown / CSV / JSON 导入导出。

验收：

- Agent 从一句需求创建自定义表格，并可只修改指定三行。
- 删除或移动画板素材不会破坏表格引用，断联时可定位和修补。
- 旧规划表无损迁移为 `planning-matrix.v1` 模板。

### v1.7：编剧、镜头与故事板

范围：

- story bible、character、beat、scene、shot 实体。
- 编剧、镜头导演、连贯性检查和素材匹配 Skill。
- 剧本、镜头表、画板占位节点双向联动。
- 选定镜头批量生成，不默认一次生成全片。

验收：

- 从 brief 生成故事设定、5 个场景和镜头表，用户修改角色后能定位受影响镜头。
- 从镜头表选择若干行生成分镜，结果节点保留 scene/shot/parent 来源。
- 删除或重做一个分镜只影响该镜头及其下游。

### v1.8：Skill 与项目记忆

范围：

- Skill 安装、启用、禁用、版本和权限管理。
- 项目级风格、角色、品牌和用户决策记忆。
- Skill 组合、并行分支和可复用 Technique。
- 把成熟画板流程发布为本地 Skill。

验收：

- 不同项目的 Agent 对话、记忆、表格和素材完全隔离。
- Skill 升级有版本记录且可以回滚。
- 同一个创作模板能在新项目复用但不携带旧项目私有素材。

### v1.9：生产稳定性

范围：

- 成本预算、检查点策略和 Provider 降级。
- Agent/task 事件日志、断线续传和应用重启恢复。
- 部分失败重试、缓存命中和下游增量重跑。
- Windows/macOS 一致性、迁移和压力测试。

验收：

- 应用在长视频任务中关闭并重启后，可以恢复任务和未完成事务。
- 50+ 镜头项目局部修改时不会全链重跑。
- 每个产物都能追溯到工具调用、输入素材、参数、Provider 和父节点。

## 11. 首轮开发切片

第一轮只做 v1.5 的最小闭环，不同时开做编剧 UI：

1. 定义 `BoardSnapshot`、`BoardOperation`、`BoardTransaction` schema。
2. 给 store 增加 revision 和原子事务入口。
3. 让现有 undo stack 支持 transaction token。
4. 实现只读工具和 node/connection/layout 写工具。
5. 接通一个文字 Provider 的 tool-calling 循环。
6. 在 Agent 侧边栏显示 preview、apply 和 undo。
7. 再把 MCP 现有工具迁入统一 registry。

完成这七项后，再开始通用表格。否则编剧和表格会继续建立在“模型输出一段 JSON、前端自行猜测”的脆弱基础上。

## 12. 测试策略

- Schema：非法操作、未知字段、旧版本迁移。
- Graph：连接类型、成环、删除级联、下游重跑。
- Transaction：revision 冲突、幂等、原子回滚、整笔撤销。
- Agent：工具选择、上下文范围、超限截断、失败重试。
- Table：局部 patch、动态 schema、引用修补、导入导出。
- Story：稳定 ID、场景/镜头关系、连续性规则、局部再生成。
- Task：断网、服务器提前关闭、应用重启、重复事件、部分成功。
- E2E：自然语言指令到 ghost preview、提交、画布结果和撤销。

## 13. 明确不做

- 不让 Agent 通过屏幕坐标模拟点击来控制画板。
- 不让模型直接修改 `board.json`。
- 不继续依赖从普通回复文本中截取自由格式 JSON。
- 不为了“多 Agent”而默认启动大量角色；优先一个 Orchestrator + 可复用 Skill。
- 不把模型参数全部做成独立节点。
- 不在第一阶段引入云账号和云同步依赖。
- 不立刻把本地 JSON 全量迁移到数据库；先通过 schema 和 revision 稳定数据边界。

## 14. 参考资料

- [Coze：什么是扣子](https://docs.coze.cn/what_is_coze.md)
- [Coze：视频创作](https://docs.coze.cn/cozespace_video.md)
- [Coze：技能概述](https://docs.coze.cn/cozespace_what_is_skill.md)
- [Coze：Excel 处理](https://docs.coze.cn/cozespace_excel.md)
- [LibTV 官网](https://www.liblib.tv/)
- [LibTV Agent Skills](https://github.com/libtv-labs/libtv-skills)
- [MiniMax Design](https://design.minimax.io/)
- [Krea Nodes 与 Node Agent](https://www.krea.ai/docs/user-guide/features/nodes)
- [LTX AI Storyboard](https://ltx.io/studio/platform/ai-storyboard-generator)
- [FLORA Canvas](https://flora.ai/)
- [Lovart AI Storyboard](https://www.lovart.ai/features/ai-storyboard)
