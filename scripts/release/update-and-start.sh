#!/bin/bash
# Shared Mac/Linux startup. Only the managed checkout is advanced; user checkouts
# and installed payloads are never reset or edited in place.
set -euo pipefail
umask 077
unset NODE_OPTIONS NODE_PATH || true
ore_env_tools=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
. "$ore_env_tools/load-env.sh"
ore_load_env "${2:-${1:?Expected installation directory}}/.env"
unset NODE_OPTIONS NODE_PATH || true
if [ "${ROLEPLAY_DATABASE+x}" = x ] && [ -z "${ROLEPLAY_DATABASE//[[:space:]]/}" ]; then
  echo 'ROLEPLAY_DATABASE must name a database file. Unset it to use the installation default.' >&2
  exit 1
fi
ore_home=${1:?Expected installation directory}
ore_source_hint=${2:-}
mkdir -p -- "$ore_home/cache" "$ore_home/logs" || { echo 'ORE: select a writable installation directory.' >&2; exit 1; }
ore_home=$(CDPATH='' cd -- "$ore_home" && pwd -P)
case "${ORE_SKIP_UPDATE:-0}" in 0|1) ;; *) echo 'ORE_SKIP_UPDATE must be 0 or 1.' >&2; exit 1;; esac

read_selection() {
  [ -f "$ore_home/current" ] || return 1
  ore_release=$(sed -n '1p' "$ore_home/current")
  ore_runtime=$(sed -n '2p' "$ore_home/current")
  case "$ore_release" in ''|.|..|*[!a-zA-Z0-9._-]*) return 1;; esac
  case "$ore_runtime" in node-v[0-9]*-darwin-arm64|node-v[0-9]*-darwin-x64|node-v[0-9]*-linux-arm64|node-v[0-9]*-linux-x64) ;; *) return 1;; esac
  case "$ore_runtime" in *[!a-zA-Z0-9._-]*) return 1;; esac
  ore_node="$ore_home/runtime/$ore_runtime/bin/node"
  ore_application="$ore_home/app/$ore_release"
  [ -x "$ore_node" ] && [ -f "$ore_application/scripts/release/portable-launch.mjs" ]
}

# Source checkouts need a stable bootstrap, while the installed updater must
# receive future fixes too. Delegate before taking a lock, never recursively.
ore_entry=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)/$(basename -- "$0")
if [ -n "$ore_source_hint" ] && read_selection && [ -f "$ore_application/scripts/release/launcher-protocol" ] && [ "$(cat "$ore_application/scripts/release/launcher-protocol")" = 2 ] && [ "$ore_entry" != "$ore_application/scripts/release/update-and-start.sh" ]; then
  exec /bin/bash "$ore_application/scripts/release/update-and-start.sh" "$ore_home" "$ore_source_hint"
fi

update_application() (
  set -e
  command -v git >/dev/null || { echo 'Git is required to check updates. No system tools were installed.' >&2; exit 1; }
  mkdir "$ore_home/cache/update.lock" 2>/dev/null || { echo 'Another startup owns cache/update.lock. Wait for it to finish. After an interruption, verify it stopped before removing that lock directory.' >&2; exit 75; }
  trap 'rmdir "$ore_home/cache/update.lock"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  repository='https://github.com/olegpro171/Roleplay-Engine.git'
  if [ -f "$ore_home/update-source.txt" ]; then repository=$(cat "$ore_home/update-source.txt"); fi
  if [ -n "$ore_source_hint" ]; then repository=$(git -C "$ore_source_hint" remote get-url origin); fi
  case "$repository" in ''|*$'\n'*|http://*@*|https://*@*) echo 'Invalid update source. Use a Git URL without embedded credentials and authenticate with Git.' >&2; exit 1;; esac
  source="$ore_home/cache/update-source"
  if [ ! -d "$source" ]; then
    mkdir "$source"
    git -C "$source" init -q -b main
    git -C "$source" remote add origin "$repository"
  fi
  # A missing .git would make Git discover a parent repository (the user's
  # checkout when ORE lives inside it). Never fetch/merge through that fallback.
  [ ! -L "$source" ] && [ -d "$source/.git" ] && [ ! -L "$source/.git" ] || { echo 'Managed update checkout is incomplete or linked elsewhere. Preserve/move cache/update-source aside and retry.' >&2; exit 1; }
  [ "$(git -C "$source" rev-parse --show-toplevel)" = "$source" ] || { echo 'Managed update checkout root differs; update cancelled.' >&2; exit 1; }
  [ "$(git -C "$source" remote get-url origin)" = "$repository" ] || { echo 'Managed update source differs from the configured repository. Preserve it and move cache/update-source aside before switching repositories.' >&2; exit 1; }
  [ "$(git -C "$source" symbolic-ref --short HEAD)" = main ] || { echo 'Managed update checkout must stay on main; local changes were preserved.' >&2; exit 1; }
  [ -z "$(git -C "$source" status --porcelain --untracked-files=all)" ] || { echo 'Managed update checkout has local changes. Preserve them before retrying; nothing was reset.' >&2; exit 1; }
  # Never prompt for a password in a startup pipeline. Existing Git credential
  # helpers/SSH keys still work; failures leave the installed version available.
  export GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
  export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=10}"
  echo 'Checking ORE main for updates…'
  git -c gc.auto=0 -c http.lowSpeedLimit=1024 -c http.lowSpeedTime=15 -C "$source" fetch --quiet --no-tags origin main
  target=$(git -C "$source" rev-parse --verify 'FETCH_HEAD^{commit}')
  installed_commit=''
  installed_kind=''
  if read_selection; then
    identity=$("$ore_node" -e 'const fs=require("node:fs"); const info=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(!/^[0-9a-f]{40}$/.test(info.commit)||!["release","development"].includes(info.kind)) throw Error("Invalid installed identity"); console.log(info.kind); console.log(info.commit);' "$ore_application/build-info.json")
    installed_kind=$(printf '%s\n' "$identity" | sed -n '1p')
    installed_commit=$(printf '%s\n' "$identity" | sed -n '2p')
  fi
  if [ "$installed_kind" = release ]; then
    git -C "$source" merge-base --is-ancestor "$installed_commit" "$target" || { echo 'Remote main does not continue the installed release. Refusing an automatic downgrade or history replacement.' >&2; exit 1; }
  fi
  if git -C "$source" rev-parse --verify HEAD >/dev/null 2>&1; then
    git -c core.hooksPath=/dev/null -C "$source" merge --quiet --ff-only "$target"
  else
    git -c core.hooksPath=/dev/null -C "$source" checkout -q -b main "$target"
  fi
  [ "$(git -C "$source" rev-parse HEAD)" = "$target" ] || { echo 'Managed checkout contains local commits. They were preserved; update cancelled.' >&2; exit 1; }
  printf '%s\n' "$repository" > "$ore_home/update-source.txt.part"
  mv -- "$ore_home/update-source.txt.part" "$ore_home/update-source.txt"
  if [ "$installed_kind" = release ] && [ "$installed_commit" = "$target" ]; then
    echo "ORE is up to date ($target). No build needed."
    exit 0
  fi
  echo "Building ORE ${target}…"
  /bin/bash "$source/build-portable.sh" --release "$target" "$ore_home"
)

if [ "${ORE_SKIP_UPDATE:-0}" = 0 ] && [ ! -f "$ore_home/updates-paused" ]; then
  log="$ore_home/logs/update-$(date +%Y%m%d-%H%M%S)-$$.log"
  echo "ORE update log: $log"
  set +e
  update_application 2>&1 | tee "$log"
  statuses=("${PIPESTATUS[@]}")
  set -e
  update_status=${statuses[0]}
  case "$update_status" in 75|129|130|143) exit "$update_status";; esac
  if [ "${statuses[1]}" -ne 0 ]; then echo 'ORE could not write its update log.' >&2; exit 1; fi
  if [ "$update_status" -ne 0 ]; then
    read_selection || { echo "ORE has no usable installed version. Resolve the update error in $log and start again." >&2; exit 1; }
    echo 'Update unavailable or failed. Starting the last installed version; the next launch will retry.' >&2
  fi
else
  echo 'ORE update check skipped (explicit skip or recovery pause; recover.command --resume-updates resumes checks).'
fi
read_selection || { echo 'ORE has no usable installed application/runtime. Start again online, or repair the installation.' >&2; exit 1; }
ore_controller="$(dirname -- "$ore_entry")/portable-launch.mjs"
if [ -f "$ore_application/scripts/release/launcher-protocol" ] && [ "$(cat "$ore_application/scripts/release/launcher-protocol")" = 2 ]; then
  ore_controller="$ore_application/scripts/release/portable-launch.mjs"
fi
exec "$ore_node" "$ore_controller" "$ore_home" "$ore_application"
