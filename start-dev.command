#!/bin/bash
# Build the current working tree with the contained runtime; never fetch main.
set -euo pipefail
umask 077
[ "$#" -eq 0 ] || { echo 'Usage: start-dev.command (no arguments)' >&2; exit 1; }
unset NODE_OPTIONS NODE_PATH || true
ore_source=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
ore_home="$ore_source/ore-development"
[ ! -L "$ore_home" ] || { echo 'ORE: ore-development must be a real directory inside this repository, not a symbolic link.' >&2; exit 1; }
export ORE_DATABASE_DEFAULT=repository
/bin/bash "$ore_source/build-portable.sh" --development "$ore_home"
export ORE_SKIP_UPDATE=1
exec /bin/bash "$ore_home/start.command"
