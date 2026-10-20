#!/usr/bin/env bash
# neko-capture launcher for Linux (Omarchy / Hyprland). First run installs dependencies.
set -euo pipefail
cd "$(dirname "$0")"
[ -x node_modules/electron/dist/electron ] || npm install
exec npx electron . "$@"
