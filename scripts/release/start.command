#!/bin/bash
# Start the selected installed build with its private runtime.
set -euo pipefail
umask 077
unset NODE_OPTIONS NODE_PATH || true
ore_home=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
ore_release=$(sed -n '1p' "$ore_home/current")
ore_runtime=$(sed -n '2p' "$ore_home/current")
case "$ore_release" in release-*|dev-*) ;; *) echo 'Invalid application selection.' >&2; exit 1;; esac
case "$ore_release" in *[!a-z0-9-]*) echo 'Invalid application selection.' >&2; exit 1;; esac
case "$ore_runtime" in node-v[0-9]*-darwin-arm64|node-v[0-9]*-darwin-x64|node-v[0-9]*-linux-arm64|node-v[0-9]*-linux-x64) ;; *) echo 'Invalid runtime selection.' >&2; exit 1;; esac
case "$ore_runtime" in *[!a-zA-Z0-9._-]*) echo 'Invalid runtime selection.' >&2; exit 1;; esac
ore_app="$ore_home/app/$ore_release"
ore_tools="$ore_app/scripts/release"
# Recovery can select an application built before its own startup boundary.
if [ ! -f "$ore_tools/application-start.mjs" ] || [ ! -f "$ore_tools/portable-launch.mjs" ] || [ ! -f "$ore_tools/load-env.sh" ]; then
  ore_tool=$(sed -n '1p' "$ore_home/recovery/current")
  case "$ore_tool" in ''|.|..|*[!a-z0-9-]*) echo 'Invalid recovery toolkit.' >&2; exit 1;; esac
  ore_tools="$ore_home/recovery/$ore_tool"
fi
. "$ore_tools/load-env.sh"
ore_load_env "$ore_home/.env"
unset NODE_OPTIONS NODE_PATH || true
exec "$ore_home/runtime/$ore_runtime/bin/node" "$ore_tools/portable-launch.mjs" "$ore_home" "$ore_app"
