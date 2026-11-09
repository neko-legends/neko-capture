#!/usr/bin/env bash
# Build neko-capture for Linux:
#   ./build.sh            AppImage: dist/Neko-Capture_<version>_amd64.AppImage
#   ./build.sh folder     plain folder: dist/neko-capture-linux-x64/neko-capture
set -euo pipefail
cd "$(dirname "$0")"
npm install
if [ "${1:-}" = folder ]; then
  npm run build
  echo "Done: $(pwd)/dist/neko-capture-linux-x64/neko-capture"
else
  npm run dist
  ls -1 "$(pwd)"/dist/*.AppImage
fi
