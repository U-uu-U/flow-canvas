# Codex 迁移恢复工具

生成日期：2026-06-10
项目根目录：`handoff/migration-recovery`

## 用途

这是一个独立的小工具项目，用来在切换 API、切换会话空间，或旧线程不显示时，从本机 Codex 历史记录中恢复旧线程上下文。

它和应用项目保持分离。这里不放应用修复补丁、不放源码快照，也不放应用专属恢复档案。

## 目录内容

- `build-codex-thread-index.mjs`
  - 扫描本机 Codex session 文件，生成可搜索的线程索引。
- `package.json`
  - 提供索引、导出、恢复和语法检查命令。
- `output/codex-thread-index/`
  - 生成结果目录。索引和恢复档案都可以重新生成。

## 数据来源

脚本读取本机 Codex 数据：

- `C:\Users\19636\.codex\session_index.jsonl`
- `C:\Users\19636\.codex\sessions`
- `C:\Users\19636\.codex\archived_sessions`

脚本只读取这些文件，不修改原始 Codex 会话记录。

## 常用命令

以下命令都在 `handoff/migration-recovery` 目录里运行。

重建完整本地线程索引：

```powershell
npm.cmd run index
```

按关键词搜索旧线程：

```powershell
npm.cmd run index -- --query "恢复"
```

搜索并在 JSON 里包含完整消息正文：

```powershell
npm.cmd run index -- --query "恢复" --include-full-messages
```

按线程 ID 导出单条完整恢复档案：

```powershell
npm.cmd run export -- 019ea087-e19e-7643-a3f3-c8f1511b8ef6
```

按关键词恢复最新匹配线程：

```powershell
npm.cmd run recover -- "恢复" --before 2026-06-10
```

按关键词和排序恢复第 N 条匹配结果：

```powershell
npm.cmd run recover -- "恢复" --before 2026-06-10 --rank 2
```

检查脚本语法：

```powershell
npm.cmd run check
```

## 输出文件

默认输出目录是 `output/codex-thread-index/`：

- `threads.json`
- `threads.md`
- `threads.filtered.json`
- `threads.filtered.md`
- `thread-exports/thread-<id>.json`
- `thread-exports/thread-<id>.md`

## 注意事项

- 这个工具要和应用项目保持分离。
- 不要把应用修复补丁或源码快照放进这个目录。
- PowerShell 里使用 `npm.cmd`。
- 如果搜索结果混入了当前新会话，用 `--before YYYY-MM-DD` 排除。
- 如果最新匹配不是想要的线程，用 `--rank <n>` 选择第 N 条。
