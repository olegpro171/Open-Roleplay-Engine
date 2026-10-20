#!/bin/bash
# Daily source launcher: check main, build only if needed, then run private Node.
set -euo pipefail
umask 077
[ "$#" -eq 0 ] || { echo 'Usage: start-app.command (no arguments; installation is repository/ore-portable)' >&2; exit 1; }
ore_source=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
ore_home="$ore_source/ore-portable"
[ ! -L "$ore_home" ] || { echo 'ORE: ore-portable must be a real directory inside this repository, not a symbolic link.' >&2; exit 1; }
# Remember the legacy default so the source and installed entries open the
# same saved database. Explicit per-launch overrides still take precedence.
if [ ! -f "$ore_home/database-path.txt" ]; then
  mkdir -p -- "$ore_home"
  printf '%s\n' "$ore_source/data/roleplay.sqlite" > "$ore_home/database-path-$$.tmp"
  mv -- "$ore_home/database-path-$$.tmp" "$ore_home/database-path.txt"
fi
exec /bin/bash "$ore_source/scripts/release/update-and-start.sh" "$ore_home" "$ore_source"
