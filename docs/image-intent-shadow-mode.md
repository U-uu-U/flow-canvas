# Image Intent Pipeline

Flow Canvas runs the image intent pipeline for image generation with references.

```text
Reference Context Builder
-> Deterministic Signal Extractor
-> Visual Intent Planner
-> EditPlan Validator
-> Provider Request Compiler
-> Generation Trace
```

In compiled mode, the selected text/vision provider plans the edit first. A deterministic compiler then converts the validated EditPlan into the prompt and ordered reference request used by the selected image provider. Invalid plans automatically fall back to the original request.

## Runtime behavior

- Default mode: `compiled`
- Observation-only mode: `shadow`
- Rollback mode: `off`
- Planner failures never block image generation.
- Planner requests use previews up to 1024 px and at most 10 reference images.
- A 30-second in-memory cache avoids duplicate planner calls during batch generation.
- API keys and authorization values are redacted before a trace is written.

The mode is stored in `flow-canvas-agent-global` as `imageIntentPipelineMode`. No generation workflow control is exposed in the UI.

## Traces

Traces are stored under Electron's user-data directory:

```text
data/generation-traces/<traceId>.json
```

Only the 200 newest traces are retained. Each trace records reference bindings, mention spans, planner/provider identity, validated EditPlan, fallback reason, actual image request summary, timings, and output path.

## Validation criteria

Use fixed A/B cases to verify that the Planner and compiler consistently identify:

- the target reference;
- each reference contribution;
- the source, target, and attribute of every operation;
- content that must be preserved or excluded;
- uncertainty instead of invented references.
