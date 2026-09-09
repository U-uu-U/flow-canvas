# Agent Runtime v1

## Execution

The desktop Agent and external harness share the project board service and model adapters. The renderer owns presentation; runs, ordered events, submitted task IDs and generation checkpoints live under `data/agent-runs`. API keys remain in the encrypted API configuration and are resolved only at execution time.

Normal chat and node Agent generation both enter `agent.start`. Models may read scoped snapshots, search project assets, inspect image crops/video frames, read model capabilities, and apply validated board transactions. Image/video runs are proposed as one batch and wait for desktop confirmation of the exact plan version. Additional generations require a new confirmation.

OpenAI-compatible and Anthropic transports support tool calls and streamed text. Dotted tool names are mapped reversibly to vendor-safe function names. Explicit unsupported-tool errors fall back once to chat; prose is never executed as tools.

## IPC And MCP

`window.flowCanvas.agent` exposes `start`, `get`, `list`, `confirm`, `revise`, `cancel`, `resume`, `retry`, and `onEvent`.

- `start` binds a real project ID, conversation ID, language provider reference, ordered attachments and optional source-node context.
- `get({runId, afterSeq})` returns a snapshot and events newer than the cursor; `list` returns filtered snapshots without old events.
- `confirm({runId, planVersion})` consumes one version of a pending plan; `revise` invalidates the previous version.
- `resume` queries submitted provider tasks or continues steps that were never submitted. `retry` produces a new confirmation for known failed steps and excludes completed steps.
- `cancel` stops local execution and rejects late output writes. It does not promise upstream cancellation or refunds.

MCP exposes the same Agent tools through `/agent/tools/<tool-name>` behind the existing tool allowlist. External harnesses can start/query/cancel/resume runs, inspect assets and propose graph generation. Paid confirmation is performed in the desktop task card. Existing `flow_canvas.board.*` tools use the project service without requiring the visible renderer.

## Data And Recovery

`AgentBoardService` serializes mutations. Each folder group keeps its items, graph, viewport, memory and revision; background writes never activate another project. Renderer saves carry the authoritative revisions originally read, not merely a locally incremented counter. Conflicting edits are preserved under `data/agent-conflicts` while the UI reloads the authoritative board. Undo is revision-checked and currently valid during the process lifetime.

Generation plans freeze prompt, model, parameters, reference ordering, and source fingerprints. Source changes invalidate execution. Each API call has a distinct local step ID. Unknown submission outcomes are not resubmitted. Returned task IDs allow image/video polling to resume. Locally downloaded outputs are kept even if a later board write cannot proceed.

Image inspection uses previews or normalized crops; video inspection uses a hidden Electron decoder and timestamped frames. Unsupported codecs fail explicitly. Preview and observation caches are keyed by file metadata, inspection settings, and analysis/model version. Model observations are separate from user-confirmed project memory.

Prices are per-route sale metadata with currency, unit, source and timestamp. HM upstream cost is not treated as a retail quote. Unknown prices stay unknown, with approval limited to a specified number of calls. Generation outputs are reviewed once; automatic quality-based regeneration is not enabled.

## Verification

`npm test` includes the provider, board-service, runtime, generation, media and UI regression suites. These are deterministic structural checks, not an estimate of real-model creative success rate.

`PLAYWRIGHT_MODULE=<path-to-playwright> node scripts/agent-smoke.cjs` starts an isolated Electron profile and a local mock provider. It verifies approval before submission, one-call execution, project switching, output persistence, multimodal inspection and task-card layout. It deletes its temporary profile after closing the app.

Set `FLOW_CANVAS_SMOKE_LIVE=1` only for an explicitly authorized single-image live test using the existing encrypted desktop API configuration. The live test copies encrypted local configuration into its isolated profile and never edits the primary profile. The test allows exactly one planned image request; further plans are not confirmed.

## Documents And Workflow Reuse

Five versioned workflow recipes are available to the runtime: asset organization, multiple references, series images, image-to-video and review. Existing custom Skills remain instruction-based.

`flow_canvas.document.list/get/create/update` creates editable general tables, scripts, character sheets and shot lists using the existing canvas table UI. Updates merge cells by stable row ID and require the last read project revision. References bind to existing project nodes instead of arbitrary paths.

`flow_canvas.skill.list/save/instantiate` turns a completed generation run into a versioned graph recipe with ordered input slots. Saved recipes omit credentials, local source paths and provider IDs. Instantiation builds actual connected nodes through a single undoable transaction. `graph.run` still requires approval before paid calls. Arbitrary external scripts are not executed.

External `graph.run` proposals do not require an internal language API. They appear under the desktop external-assistant conversation for confirmation. The external harness owns result reasoning; direct `asset.read` returns visual content without charging an extra internal analysis call.

Native audio understanding, web research, editing timelines and collaboration are outside this release. The fixed acceptance cases and mocked suites do not establish a 90% real-model task success rate. A real image run completed; the single sd2.5 video trial received task ID `task_5262`, but subsequent upstream queries returned 502, so no successful live-video result is claimed.
