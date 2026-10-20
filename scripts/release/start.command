#!/bin/bash
set -euo pipefail
unset NODE_OPTIONS NODE_PATH || true
ore_root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
[ -f "$ore_root/current" ] || { echo 'ORE has no installed application. Use the source launcher to install it.' >&2; exit 1; }
ore_release=$(sed -n '1p' "$ore_root/current")
case "$ore_release" in ''|.|..|*[!a-zA-Z0-9._-]*) echo 'Invalid ORE current release pointer.' >&2; exit 1;; esac
ore_application="$ore_root/app/$ore_release"
if [ -f "$ore_application/scripts/release/load-env.sh" ]; then
  . "$ore_application/scripts/release/load-env.sh"
  ore_load_env "$ore_root/.env"
  unset NODE_OPTIONS NODE_PATH || true
fi
if [ -f "$ore_application/scripts/release/update-and-start.sh" ] && [ -f "$ore_application/scripts/release/launcher-protocol" ] && [ "$(cat "$ore_application/scripts/release/launcher-protocol")" = 2 ]; then
  exec /bin/bash "$ore_application/scripts/release/update-and-start.sh" "$ore_root"
fi
if [ -f "$ore_root/recovery/current" ]; then
  ore_tool=$(sed -n '1p' "$ore_root/recovery/current")
  case "$ore_tool" in ''|.|..|*[!a-zA-Z0-9._-]*) echo 'Invalid recovery toolkit pointer.' >&2; exit 1;; esac
  exec /bin/bash "$ore_root/recovery/$ore_tool/update-and-start.sh" "$ore_root"
fi
# The root launcher may be replaced before the atomic pointer switch. Retain
# compatibility with the previous release if activation is interrupted there.
echo 'Launcher update was not activated. Starting the previous application; use the source launcher to finish updating.' >&2
ore_runtime=$(sed -n '2p' "$ore_root/current")
case "$ore_runtime" in node-v[0-9]*-darwin-arm64|node-v[0-9]*-darwin-x64|node-v[0-9]*-linux-arm64|node-v[0-9]*-linux-x64) ;; *) echo 'Invalid ORE runtime pointer.' >&2; exit 1;; esac
case "$ore_runtime" in *[!a-zA-Z0-9._-]*) echo 'Invalid ORE runtime pointer.' >&2; exit 1;; esac
exec "$ore_root/runtime/$ore_runtime/bin/node" "$ore_application/scripts/release/portable-launch.mjs" "$ore_root"
