#!/usr/bin/env bash
# neko-capture launcher for Linux (Omarchy / Hyprland). First run installs dependencies.
set -euo pipefail
cd "$(dirname "$0")"
[ -f node_modules/electron/install.js ] || npm install
# A checkout shared with Windows (or an npm that skips install scripts) has no Linux Electron yet: fetch it.
[ -x node_modules/electron/dist/electron ] || node node_modules/electron/install.js
exec node_modules/electron/dist/electron . "$@"
