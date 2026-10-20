#!/bin/bash
# Source development convenience; portable installations use their own start.command.
set -euo pipefail
ore_source=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
cd -- "$ore_source"
if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major===24||(major===22&&minor>=12)?0:1)' 2>/dev/null; then
  echo 'For a contained installation, run ./build-portable.sh --development "$HOME/ORE", then "$HOME/ORE/start.command".' >&2
  echo 'Source development requires Node 24 LTS or 22.12+ on this terminal PATH.' >&2
  exit 1
fi
if [ ! -d node_modules ]; then echo 'Run npm ci first for source development. See README.md.' >&2; exit 1; fi
npm run build
exec npm start
