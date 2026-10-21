#!/bin/bash
# Daily source launcher: check main, build only if needed, then run private Node.
set -euo pipefail
umask 077
[ "$#" -eq 0 ] || { echo 'Usage: start-app.command (no arguments; installation is repository/ore-portable)' >&2; exit 1; }
ore_source=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
echo 'ORE - starting your roleplay app'
echo 'We will check for updates, build if needed, then start the app.'
echo 'First-time setup can take several minutes. Progress and any errors appear below.'
echo
. "$ore_source/scripts/release/load-env.sh"
ore_load_env "$ore_source/.env"
unset NODE_OPTIONS NODE_PATH || true
ore_home="$ore_source/ore-portable"
[ ! -L "$ore_home" ] || { echo 'ORE: ore-portable must be a real directory inside this repository, not a symbolic link.' >&2; exit 1; }
# Persist a relative default in the launcher after a private runtime is available.
# Existing legacy absolute metadata is migrated conservatively there.
export ORE_DATABASE_DEFAULT=repository
exec /bin/bash "$ore_source/scripts/release/update-and-start.sh" "$ore_home" "$ore_source"
