#!/usr/bin/env bash
# Local MagicMirror dev runner for MMM-BartTimes.
# Clones MagicMirror into ./dev/MagicMirror, symlinks this repo as a module,
# drops a minimal config, and starts the server-only mode on http://localhost:8080.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="$ROOT/dev"
MM="$DEV/MagicMirror"
MM_REPO="${MM_REPO:-https://github.com/MagicMirrorOrg/MagicMirror.git}"
MM_REF="${MM_REF:-master}"

if [ ! -d "$MM" ]; then
    echo "==> Cloning MagicMirror into $MM"
    git clone --depth=1 --branch "$MM_REF" "$MM_REPO" "$MM"
fi

if [ ! -d "$MM/node_modules" ]; then
    echo "==> Installing MagicMirror dependencies (server-only, this takes a couple minutes)"
    (cd "$MM" && npm install --omit=dev --no-audit --no-fund)
fi

if [ ! -d "$ROOT/node_modules" ]; then
    echo "==> Installing MMM-BartTimes dependencies"
    (cd "$ROOT" && npm install --no-audit --no-fund)
fi

LINK="$MM/modules/MMM-BartTimes"
if [ -L "$LINK" ]; then
    if [ "$(readlink -f "$LINK")" != "$ROOT" ]; then
        rm "$LINK"
    fi
fi
if [ ! -e "$LINK" ]; then
    echo "==> Symlinking $ROOT -> $LINK"
    ln -s "$ROOT" "$LINK"
fi

echo "==> Installing dev config"
install -m 644 "$DEV/config.js" "$MM/config/config.js"

PORT="$(grep -oE 'port:\s*[0-9]+' "$DEV/config.js" | grep -oE '[0-9]+' | head -1)"
echo "==> Starting MagicMirror server (Ctrl-C to stop)"
echo "    Open http://localhost:${PORT:-8080} in your browser"
cd "$MM" && exec npm run server
