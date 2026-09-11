# Seedance Fixed-Duration Routes

Flow Canvas connects to RavenHash, not directly to upstream suppliers.

| Route | Public RavenHash model | Upstream model | Contract | Selling price |
| --- | --- | --- | --- | --- |
| Route 1 | `sd2.5-route1` | `sd2.5` (968API) | 30 seconds, 720p, up to 9 images | CNY 6 / request |
| Route 2 | `sd2.5` | `sd2.5` (existing supplier) | 30 seconds, 720p, up to 9 images | CNY 6 / request |

The separate `seedance_v2.5` variable-duration model is unchanged.
Existing nodes and tasks retain their original provider/model binding; route selection does not migrate them.

## Relay Configuration

- Route 1 maps `sd2.5-route1` to `sd2.5` on its dedicated channel.
- Route 1 uses the private `seedance968-adapter` service. The shared forward rule still supplies `/v1/videos` and `/v1/videos/${task_id}`, which the adapter translates to the supplier's `/v1/videos/generations` contract. Route 2 keeps its original base URL and protocol.
- Both fixed routes reuse billing rule 19. The backend accounting value is USD `0.8888888888888888`, equivalent to CNY 6 at its configured exchange rate of 6.75. This is a selling price, not verified supplier cost.
- Upstream credentials belong only in the relay channel; never add them to the desktop provider or this repository.

## Verification And Local Setup

As of 2026-09-11, authenticated RavenHash model discovery exposes both public model IDs. The first route-1 user task exposed an incorrect reuse of the old supplier protocol. The new adapter fixes submit/poll paths, parameter names, `request_id` normalization, 30-second polling, and authenticated result downloads. See `server/seedance968/README.md`. Mock integration tests cover the complete protocol; a real paid generation has not yet verified the corrected route end to end.

Pull models in the existing RavenHash API settings to expose the new alias. Alternatively, with Flow Canvas closed, run `electron scripts/configure-seedance-route.cjs --apply` to append both models using the existing encrypted API configuration and backup mechanism. Without `--apply`, this script only checks model visibility.

Run `node --test src/video-model-profiles.test.js src/provider-capabilities.test.js electron-main/openai-image-request.test.js` for contract checks and `node scripts/video-route-picker-smoke.cjs` for Electron UI checks. Set `PLAYWRIGHT_MODULE` to the Playwright installation when it is not in local dependencies.
