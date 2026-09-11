# 968API Route Adapter

This private Docker-network service sits between RavenHash channel 4 and 968API.
It keeps the existing fixed-30-second client contract and does not affect route 2.
There is no published host port and no credential in the image, source or state DB.
The relay supplies the original channel Bearer token on every request.

- Submit: `/v1/videos` -> `/v1/videos/generations`.
- Translate `seconds`, `ratio`, `image_urls` -> `duration`, `aspect_ratio`, `reference_images`; omit `resolution`.
- Preserve reference order and duplicates. Normalize `request_id` to `id`/`task_id`.
- Poll `/v1/videos/generations/{id}` at most once per 30 seconds per credential/task. Cache in SQLite across restarts. Stop `failed` and one-hour `pending` tasks.
- Download relative `/v1/videos/{id}/content` with the same upstream credential. Never forward it to another origin or redirect.
- Publish downloaded MP4s through the existing `/fc-media/files/` service. Downloads stream to disk; failed transfers remain recoverable. No task is marked completed before media is available.
- Never retry a POST automatically. An interrupted submission has an unknown outcome.

## Deployment

Install this folder at `/opt/tokensbyte/seedance968-adapter`. Create `state` owned by UID 1000. The existing media folder must be writable by UID 1000.
Run `docker compose -f compose.yml up -d`, verify `/health` inside the container, and then set only channel 4 `base_url` to `http://seedance968-adapter:3011`.
Keep its API key, model mapping, billing and rule 37 unchanged. Snapshot the database configuration before the change. Restore the prior channel base URL to roll back.

Run `python -B -m unittest discover -s server/seedance968 -p test_adapter.py` locally. The integration tests use a mock upstream and never create paid tasks.

The supplier document dated 2026-09-03 supports sd2.5 duration 1-30, no resolution input, and quotes USD 1.50/request. RavenHash continues to expose the user-requested fixed 30-second route at CNY 6/request; these are different cost/sale figures. Expanding the desktop duration controls is a separate change.

The media service expires files after 24 hours. Desktop clients should download promptly. Querying the adapter directly can rematerialize a cached completed result while the supplier still retains its content; RavenHash's own terminal-response cache may require operator recovery before it queries the adapter again.
