#!/bin/bash
set -euo pipefail

EXT_ID="${1:-}"
if [[ -z "$EXT_ID" ]]; then
  printf 'Chrome extension ID: '
  read -r EXT_ID
fi

if [[ -z "$EXT_ID" ]]; then
  echo "Extension ID is required." >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js was not found in PATH." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_DIR="$SCRIPT_DIR/native-host"
RUNNER="$HOST_DIR/run_host_macos.sh"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST="$MANIFEST_DIR/com.flow.canvas_sync.json"

printf '#!/bin/sh\nexec "%s" "%s"\n' "$NODE_BIN" "$HOST_DIR/native_host.js" > "$RUNNER"
chmod 755 "$RUNNER"
mkdir -p "$MANIFEST_DIR"

EXT_ID="$EXT_ID" RUNNER="$RUNNER" MANIFEST="$MANIFEST" "$NODE_BIN" -e '
const fs = require("fs");
const manifest = {
  name: "com.flow.canvas_sync",
  description: "Flow Canvas browser task sync and download archive host",
  path: process.env.RUNNER,
  type: "stdio",
  allowed_origins: [`chrome-extension://${process.env.EXT_ID}/`]
};
fs.writeFileSync(process.env.MANIFEST, JSON.stringify(manifest, null, 2));
'

echo "Native Messaging host installed. Reload the extension in Chrome."
