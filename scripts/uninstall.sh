#!/bin/bash
set -euo pipefail
LABEL=com.primetrace.jobqueue
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$HOME/.local/bin/q"
echo "uninstalled (queue data kept in data/)"
