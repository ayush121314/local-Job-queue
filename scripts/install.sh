#!/bin/bash
# Installs the runner as a launchd agent: it runs at login/boot and every 5 minutes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LABEL=com.primetrace.jobqueue
TARGET="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$ROOT/logs" "$ROOT/data" "$HOME/Library/LaunchAgents"
sed -e "s#__NODE__#$NODE#g" -e "s#__ROOT__#$ROOT#g" "$ROOT/launchd/$LABEL.plist.template" > "$TARGET"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$TARGET"
mkdir -p "$HOME/.local/bin"
ln -sf "$ROOT/bin/q.js" "$HOME/.local/bin/q"
chmod +x "$ROOT/bin/q.js"
echo "installed: $TARGET"
echo "q command: $HOME/.local/bin/q (add ~/.local/bin to PATH if 'q' is not found)"
