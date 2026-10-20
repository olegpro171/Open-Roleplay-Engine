#!/bin/bash
set -euo pipefail
unset NODE_OPTIONS NODE_PATH || true
ore_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
if [ ! -f "$ore_root/current" ]; then
  echo 'ORE has no installed application. Run build-portable.sh first.' >&2
  exit 1
fi
ore_release=$(sed -n '1p' "$ore_root/current")
ore_runtime=$(sed -n '2p' "$ore_root/current")
case "$ore_release" in ''|*[!a-zA-Z0-9._-]*) echo 'Invalid ORE current release pointer.' >&2; exit 1;; esac
case "$ore_runtime" in node-v[0-9]*-darwin-arm64|node-v[0-9]*-darwin-x64|node-v[0-9]*-linux-arm64|node-v[0-9]*-linux-x64) ;;
  *) echo 'Invalid ORE runtime pointer.' >&2; exit 1;; esac
case "$ore_runtime" in *[!a-zA-Z0-9._-]*) echo 'Invalid ORE runtime pointer.' >&2; exit 1;; esac
ore_node="$ore_root/runtime/$ore_runtime/bin/node"
if [ ! -x "$ore_node" ]; then echo 'ORE runtime is missing. Re-run the build procedure.' >&2; exit 1; fi
exec "$ore_node" "$ore_root/app/$ore_release/scripts/release/portable-launch.mjs" "$ore_root"
