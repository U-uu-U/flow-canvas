---
name: codex-migration-recovery
description: Recover local Codex thread context after API provider changes, session-space changes, hidden old threads, lost visible chat history, or requests to search/export previous Codex conversations. Use when the user asks to build or use the local Codex thread index, find an old thread by keyword/date, export a thread by ID, or hand off recovered context to another agent.
---

# Codex Migration Recovery

Use the standalone recovery utility in `handoff/migration-recovery` to search and export local Codex session history. Keep this workflow separate from application repair work: do not add source patches, app snapshots, or app-specific dossiers to the recovery utility.

## Quick Workflow

1. Confirm the utility exists at `handoff/migration-recovery`.
2. Run commands from that directory using `npm.cmd` on Windows PowerShell.
3. Start with a syntax check before indexing:

```powershell
npm.cmd run check
```

4. Build or refresh the full local thread index:

```powershell
npm.cmd run index
```

5. Search by keyword when the user describes the lost thread:

```powershell
npm.cmd run index -- --query "recovery"
```

6. If current-session noise appears, filter by date:

```powershell
npm.cmd run recover -- "recovery" --before 2026-06-10
```

7. If the newest match is not the right thread, use rank selection:

```powershell
npm.cmd run recover -- "recovery" --before 2026-06-10 --rank 2
```

8. Export an exact thread when the ID is known:

```powershell
npm.cmd run export -- 019ea087-e19e-7643-a3f3-c8f1511b8ef6
```

## Output

Generated files stay under `handoff/migration-recovery/output/codex-thread-index/`:

- `threads.json`
- `threads.md`
- `threads.filtered.json`
- `threads.filtered.md`
- `thread-exports/thread-<id>.json`
- `thread-exports/thread-<id>.md`

Treat these as regenerated artifacts. Summarize useful recovered context for the user instead of pasting huge exports into chat.

## Safety Rules

- Read local Codex session data only; do not modify files under `C:\Users\19636\.codex`.
- Keep generated outputs inside `handoff/migration-recovery/output/codex-thread-index`.
- Do not mix application fixes or handoff patches into the migration recovery folder.
- If a command fails due to sandbox or permission limits, retry with the narrowest required escalation and explain why.
- Prefer `npm.cmd` over bare `npm` in PowerShell.
