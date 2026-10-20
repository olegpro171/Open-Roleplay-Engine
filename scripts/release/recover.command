#!/bin/bash
set -euo pipefail
unset NODE_OPTIONS NODE_PATH || true
ore_home=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
ore_tool=$(sed -n '1p' "$ore_home/recovery/current")
ore_runtime=$(sed -n '2p' "$ore_home/recovery/current")
case "$ore_tool" in ''|.|..|*[!a-zA-Z0-9._-]*) echo 'Invalid recovery toolkit.' >&2; exit 1;; esac
case "$ore_runtime" in node-v[0-9]*-darwin-arm64|node-v[0-9]*-darwin-x64|node-v[0-9]*-linux-arm64|node-v[0-9]*-linux-x64) ;; *) echo 'Invalid recovery runtime.' >&2; exit 1;; esac
case "$ore_runtime" in *[!a-zA-Z0-9._-]*) exit 1;; esac
exec "$ore_home/runtime/$ore_runtime/bin/node" "$ore_home/recovery/$ore_tool/recover.mjs" "$ore_home" "$@"
