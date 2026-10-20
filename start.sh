#!/bin/bash
set -euo pipefail
ore_source=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
exec /bin/bash "$ore_source/start-app.command" "$@"
