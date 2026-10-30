#!/usr/bin/env bash
# Package neko-capture into a standalone app: dist/neko-capture-linux-x64/neko-capture
set -euo pipefail
cd "$(dirname "$0")"
npm install
npm run build
echo "Done: $(pwd)/dist/neko-capture-linux-x64/neko-capture"
