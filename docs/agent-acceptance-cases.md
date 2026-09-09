# Agent Acceptance Cases

These fixed cases define the initial acceptance set. Automated provider mocks verify structural behavior; live model task success and visual quality must be measured separately. Passing unit tests is not a claim of 90% real-world creative success.

1. Read a selected image: return actual pixels and its stable node identity.
2. Read the second of two references: preserve user/connection order.
3. Inspect a normalized image crop: return cropped pixels without changing the original.
4. Inspect a video at a specified timestamp: return the decoded frame and timestamp.
5. Encounter unsupported media: show an explicit error without inventing observations.
6. Arrange selected nodes: retain IDs, files and graph connections.
7. Create a connected generation branch: validate ports and avoid cycles.
8. Replay a board transaction: apply its idempotency key exactly once.
9. Undo one transaction: reject undo after a newer conflicting edit.
10. List video models: report real per-model durations, resolutions and reference limits.
11. Propose two image generations: show two calls and wait for one batch confirmation.
12. Double-click confirmation: never submit the paid batch twice.
13. Change a pending plan: invalidate the old version and show the revised batch.
14. Modify a source after approval: refuse stale execution before submitting.
15. Reuse a completed upstream generator: do not pay to generate it again.
16. Explicitly regenerate an upstream: use the new result in the dependent step.
17. Switch projects while generating: write all results into the original project.
18. Lose connection after receiving a remote ID: query that same task when resumed.
19. Lose connection without a remote ID: do not resubmit an ambiguous call.
20. Restart after download but before placement: place the saved file without a new call.
21. Stop during generation: preserve existing results and refuse late writes.
22. Retry a partial failure: exclude successful calls and require fresh approval.
23. Review a generated result: report visible mismatches; do not auto-regenerate.
24. Reopen a conversation: restore progress and append the final reply only once.

The first complete live image smoke run used a deliberately featureless reference with a subject-preservation prompt. The API completed, and the reviewer correctly reported that the generated person was not present in the reference. This validates discrepancy reporting, not successful subject preservation.
