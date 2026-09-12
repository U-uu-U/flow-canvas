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

## HM Multimodal Models (2026-09-12)

These models reuse the working `seedance_v2.5` channel, not the two fixed-30s routes above.
The upstream Base URL is `https://video.zhubo.asia/v1`. RavenHash channel 3 stores the host
without `/v1` because forward rule 37 supplies `/v1/videos` and `/v1/videos/${task_id}`.
Do not append `/v1` twice or replace this channel's credentials.

| Public and upstream model ID | Duration | Image / video / audio limits | RavenHash sale (CNY/request) | Billing rule |
| --- | --- | --- | --- | --- |
| `seedance_v2.5` | 4-30s | 10 / 0 / 0 | 5 (unchanged) | 18 |
| `seedance_v2.0-933` | 4-15s | 9 / 3 / 3 | 6.5 | 20 |
| `seedance_v2.5-101010` | 4-30s | 10 / 10 / 10 | 7 | 21 |
| `seedance_v2.5-301010` | 4-30s | 30 / 10 / 10 | 10 | 22 |

All four output 720p. The three new models have upstream face-reference restrictions.
The upstream's `/api/video/models` lists its own costs as CNY 2.5, 3 and **5.5** for the new
models; the user's requested **selling prices** remain 6.5, 7 and 10. Never publish costs as sales.
Upstream success-rate samples are dynamic (some have very few calls), so they are not advertised.

Verified sources: authenticated `/v1/models`, public `/api/video/models`, and the upstream site's
Unified Video Entry documentation (`/assets/DocsPage-ByUAcoeC.js`, retrieved 2026-09-12).
Submit JSON uses `model`, `prompt`, `seconds`, `ratio`, `resolution`, `image_urls`, `video_urls`,
`audio_urls`. Omit empty reference arrays. Query `/v1/videos/{task_id}` after submission;
recovery must query the existing task, never create another billed task.

`server/seedance-hm/add-models.sql` adds only these three models and separate billing rules in
one transaction, inheriting the working channel/forwarding contract. It refuses duplicate models
or an unexpected base billing contract. Accounting remains USD internally; the live rate was
6.75 CNY/USD, so new fixed rates are `6.5/6.75`, `7/6.75`, and `10/6.75`.
Server-side backup: `/opt/tokensbyte-backups/hm-seedance-20260912T113212Z/`.
For rollback, disable the three new models rather than restoring entire tables over later usage.

With Flow Canvas closed, `electron scripts/configure-seedance-route.cjs --hm --apply` verifies
model visibility with the existing API key and appends the three models to the existing HM provider.
The built-in encrypted API store retains a backup and does not replace credentials or old models.
Without `--apply`, the command is read-only. Other installations can use API Settings > Pull Models.

The client defaults and configserver seed contain all three profiles. The independent
`https://artconfig.ravenhash.org/config` service returned HTTP 502 during this update and was not
reconfigured on the relay host; do not claim its active CONFIG was deployed.
No paid generation was submitted. Mock tests cover 30/10/10 reference transport, order, limits,
request fields and recovery; Electron smoke tests cover model selection and description wrapping.
