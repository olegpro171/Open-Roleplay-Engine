#!/bin/bash
# Source-side recovery also works for installations predating the new toolkit.
set -euo pipefail
unset NODE_OPTIONS NODE_PATH || true
ore_source=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
. "$ore_source/scripts/release/load-env.sh"
ore_load_env "$ore_source/.env"
unset NODE_OPTIONS NODE_PATH || true
ore_home="$ore_source/ore-portable"
for ore_pointer in recovery/current current previous working; do
  [ -f "$ore_home/$ore_pointer" ] || continue
  ore_runtime=$(sed -n '2p' "$ore_home/$ore_pointer")
  case "$ore_runtime" in node-v[0-9]*-darwin-arm64|node-v[0-9]*-darwin-x64|node-v[0-9]*-linux-arm64|node-v[0-9]*-linux-x64) ;; *) continue;; esac
  case "$ore_runtime" in *[!a-zA-Z0-9._-]*) continue;; esac
  if [ -x "$ore_home/runtime/$ore_runtime/bin/node" ]; then
    export ORE_DATABASE_DEFAULT=repository
    exec "$ore_home/runtime/$ore_runtime/bin/node" "$ore_source/scripts/release/recover.mjs" "$ore_home" "$@"
  fi
done
echo 'No bundled runtime is available for recovery. Restore the retained runtime first.' >&2
exit 1
