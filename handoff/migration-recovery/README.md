# Codex Migration Recovery

Generated: 2026-06-10
Project root: `handoff/migration-recovery`

## Purpose

This is a standalone utility project for recovering local Codex thread history after changing API providers or session spaces.

It is intentionally separate from the application project. It does not contain application repair patches, source snapshots, or app-specific recovery dossiers.

## Contents

- `build-codex-thread-index.mjs`
  - Scans local Codex session files and builds searchable thread indexes.
- `package.json`
  - Contains local commands for indexing, exporting, recovering, and syntax checking.
- `output/codex-thread-index/`
  - Output directory for generated indexes and thread recovery dossiers. Generated files can be rebuilt at any time.

## Data Sources

The script reads local Codex data from:

- `C:\Users\19636\.codex\session_index.jsonl`
- `C:\Users\19636\.codex\sessions`
- `C:\Users\19636\.codex\archived_sessions`

No original Codex session files are modified.

## Commands

Run these from `handoff/migration-recovery`.

Build the full local thread index:

```powershell
npm.cmd run index
```

Search threads by keyword:

```powershell
npm.cmd run index -- --query "恢复"
```

Search with full message bodies included in JSON output:

```powershell
npm.cmd run index -- --query "恢复" --include-full-messages
```

Export one exact thread by ID:

```powershell
npm.cmd run export -- 019ea087-e19e-7643-a3f3-c8f1511b8ef6
```

Recover the latest matching thread by keyword:

```powershell
npm.cmd run recover -- "恢复" --before 2026-06-10
```

Recover the Nth matching thread after query/date filtering:

```powershell
npm.cmd run recover -- "恢复" --before 2026-06-10 --rank 2
```

Check script syntax:

```powershell
npm.cmd run check
```

## Output Files

Generated output defaults to `output/codex-thread-index/`:

- `threads.json`
- `threads.md`
- `threads.filtered.json`
- `threads.filtered.md`
- `thread-exports/thread-<id>.json`
- `thread-exports/thread-<id>.md`

## Important Notes

- Keep this utility separate from the application project.
- Do not add application repair patches or source snapshots here.
- Use `npm.cmd` in PowerShell.
- If search results include unrelated current-session threads, use `--before YYYY-MM-DD`.
- Use `--rank <n>` when the latest match is not the thread you want.
