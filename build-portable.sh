#!/bin/bash
# Conservative Bash 3.2; no system Node/npm or package-manager modifications.
set -euo pipefail
umask 077
ore_source=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
fail() { echo "ORE build: $*" >&2; exit 1; }
mode=${1:-}
case "$mode" in
  --release) [ "$#" -eq 3 ] || fail 'Usage: build-portable.sh --release FULL_COMMIT INSTALL_DIRECTORY'; commit=$2; destination=$3 ;;
  --development) [ "$#" -eq 2 ] || fail 'Usage: build-portable.sh --development INSTALL_DIRECTORY'; commit=$(git -C "$ore_source" rev-parse HEAD); destination=$2 ;;
  --snapshot)
    [ "$#" -eq 4 ] || fail 'Snapshot input requires a downloaded archive, complete commit and installation.'
    commit=$2; destination=$3; snapshot=$4
    [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid snapshot commit.'
    [ "${ORE_SNAPSHOT_SOURCE:-}" = "https://github.com/olegpro171/Roleplay-Engine/archive/$commit.tar.gz" ] || fail 'Missing downloaded-main provenance.'
    [[ "${ORE_SNAPSHOT_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || fail 'Missing snapshot digest.'
    [ "$(shasum -a 256 "$snapshot" | awk '{print $1}')" = "$ORE_SNAPSHOT_SHA256" ] || fail 'Snapshot bytes changed after download.'
    ;;
  *) fail 'Choose --release FULL_COMMIT INSTALL_DIRECTORY or --development INSTALL_DIRECTORY.' ;;
esac
for command in curl tar awk sed; do command -v "$command" >/dev/null || fail "Required tool missing: $command. No system packages were installed."; done
if [ "$mode" != --snapshot ]; then command -v git >/dev/null || fail 'Git is required for source-checkout builds.'; fi
if [ "$mode" = '--release' ]; then
  [ -z "$(git -C "$ore_source" status --porcelain --untracked-files=all)" ] || fail 'Release source must be clean, including untracked files. Commit the intended changes first.'
  [ "$commit" = "$(git -C "$ore_source" rev-parse HEAD)" ] || fail 'Release requires the exact full checked-out commit.'
  git -C "$ore_source" merge-base --is-ancestor "$commit" main || fail 'Release commit must be reachable on local main.'
fi
# A short, explicit allowlist is also used for developer builds.
. "$ore_source/scripts/release/snapshot-input.sh"
inputs=("${ore_inputs[@]}")
for input in "${inputs[@]}"; do [ -e "$ore_source/$input" ] || fail "Missing required source input: $input"; done
case "$(uname -s)" in Darwin) os=darwin;; Linux) os=linux;; *) fail 'Bash delivery targets macOS and glibc Linux. Use the Windows handoff on Windows.';; esac
case "$(uname -m)" in arm64|aarch64) cpu=arm64;; x86_64) cpu=x64;; *) fail 'Only arm64 and x64 are candidate targets.';; esac
if [ "$os" = linux ]; then
  command -v getconf >/dev/null && getconf GNU_LIBC_VERSION >/dev/null 2>&1 || fail 'Only glibc Linux is targeted; musl/Alpine is unqualified.'
  libc=$(getconf GNU_LIBC_VERSION)
  awk -v version="$libc" 'BEGIN { split(version,parts," "); split(parts[2],v,"."); exit !(v[1]>2 || (v[1]==2 && v[2]>=28)) }' || fail "Node/sharp require glibc 2.28 or newer; detected $libc. Use a qualified Linux system. No system packages were changed."
  kernel=$(uname -r)
  awk -v version="$kernel" 'BEGIN { split(version,v,"."); exit !(v[1]>4 || (v[1]==4 && v[2]>=18)) }' || fail "This ORE runtime targets Linux kernel 4.18 or newer; detected $kernel."
else
  macos=$(sw_vers -productVersion)
  awk -v version="$macos" 'BEGIN { split(version,v,"."); exit !(v[1]>13 || (v[1]==13 && v[2]>=5)) }' || fail "Node 24 requires macOS 13.5 or newer; detected $macos."
fi
. "$ore_source/scripts/release/private-runtime.sh"
ore_runtime_identity "$ore_source/scripts/release/runtime.conf" "$ore_source/scripts/release/node-SHASUMS256.txt" "$os" "$cpu" || fail 'Invalid pinned runtime declaration/checksum.'
mkdir -p -- "$destination" || fail 'Cannot create installation. Select a user-writable directory.'
ore_home=$(CDPATH='' cd -- "$destination" && pwd -P)
[ "$ore_home" != "$ore_source" ] || fail 'Use a separate installation directory, not the source checkout.'
mkdir -p -- "$ore_home/cache" "$ore_home/runtime" "$ore_home/app" "$ore_home/logs" "$ore_home/languages" "$ore_home/data" || fail 'Installation is not writable.'
mkdir "$ore_home/cache/build.lock" 2>/dev/null || { echo 'Another build owns cache/build.lock.' >&2; exit 75; }
stage=''
cleanup() {
  local build_status=$? attempt
  trap - EXIT
  # Finder or another external writer can recreate files during removal. Keep
  # these diagnostics visible, but do not let optional cleanup prevent startup
  # or mask the original build failure. Always attempt to release our lock.
  if [ -n "$stage" ] && cd -- "$ore_home"; then
    for attempt in 1 2 3; do
      if rm -rf -- "$stage"; then break; fi
    done
  fi
  if ! rmdir "$ore_home/cache/build.lock"; then
    if [ "$build_status" -eq 0 ]; then build_status=75; fi
  fi
  exit "$build_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
stage=$(mktemp -d "$ore_home/cache/build.XXXXXXXX")
export TMPDIR="$stage" TMP="$stage" TEMP="$stage"
for ore_setting in ${!npm_config_@} ${!NPM_CONFIG_@}; do unset "$ore_setting"; done
export npm_config_cache="$ore_home/cache/npm" npm_config_userconfig="$stage/npmrc" npm_config_globalconfig="$stage/global-npmrc"
export npm_config_update_notifier=false npm_config_audit=false npm_config_fund=false npm_config_ignore_scripts=true
export SHARP_IGNORE_GLOBAL_LIBVIPS=1
# Ignore external Node/npm injection and cross-compilation settings.
unset NODE_OPTIONS NODE_PATH npm_config_prefix npm_config_arch npm_config_platform npm_config_target npm_config_runtime npm_config_build_from_source || true
: > "$npm_config_userconfig"
: > "$npm_config_globalconfig"
ore_download() { curl -q --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 600 "$1" -o "$2"; }
ore_toolkit_phase() { echo "Downloading official Node $ORE_NODE_VERSION for ${os}/${cpu}…"; }
echo "[Build 1/6] Preparing ORE's private Node.js $ORE_NODE_VERSION runtime..."
runtime_status=0
ore_private_runtime "$ore_home" "$stage" || runtime_status=$?
case "$runtime_status" in 0) ;; 20) fail 'Runtime download failed; installed version is unchanged. Retry explicitly.';; 21) fail 'Runtime checksum mismatch or invalid runtime; nothing was installed.';; 22) fail 'Cached runtime checksum mismatch. Remove only that archive from cache and retry.';; *) fail 'Cannot prepare private runtime.';; esac
export PATH="$ore_home/runtime/$runtime/bin:$PATH"
node="$ore_home/runtime/$runtime/bin/node"
npm="$ore_home/runtime/$runtime/lib/node_modules/npm/bin/npm-cli.js"
[ "$("$node" --version)" = "v$ORE_NODE_VERSION" ] || fail 'Installed private runtime is invalid; restore it from the verified archive.'
work="$stage/source"
if [ "$mode" = --snapshot ]; then
  ore_extract_snapshot "$snapshot" "$commit" "$work" "$stage/archive-list" || fail 'Downloaded source archive is invalid.'
elif [ "$mode" = '--release' ]; then
  mkdir "$work"
  git -C "$ore_source" archive "$commit" -- "${inputs[@]}" | tar -xf - -C "$work"
else
  mkdir "$work"
  for input in "${inputs[@]}"; do
    mkdir -p -- "$work/$(dirname -- "$input")"
    cp -R -- "$ore_source/$input" "$work/$input"
  done
fi
cd -- "$work"
echo '[Build 2/6] Installing the packages needed to build ORE. Downloads may take a few minutes...'
"$node" "$npm" ci --include=dev --include=optional --ignore-scripts 3>&-
# Fail before build if prebuilt native dependencies cannot load. Never compile.
echo '[Build 3/6] Checking database/image support, then building the interface and server...'
"$node" scripts/release/native-smoke.mjs 3>&- || fail 'Locked prebuilt SQLite/sharp dependencies do not work on this OS/CPU/libc. No compiler or global image library was installed.'
"$node" "$npm" --silent run build 3>&-
echo '[Build 4/6] Collecting third-party licenses and notices...'
"$node" scripts/release/stage.mjs notices "$work" "$stage/notices"
echo '[Build 5/6] Preparing the packages needed to run the finished app...'
"$node" "$npm" ci --omit=dev --ignore-scripts --include=optional --prefer-offline 3>&-
echo '[Build 6/6] Staging and verifying the new app before activation...'
"$node" scripts/release/stage.mjs install "$work" "$ore_home" "$mode" "$commit" "$runtime" "$expected" "$stage/notices"
echo "ORE installed in $ore_home"
echo "Start (also offline): $ore_home/start.command"
echo 'The running version, if any, continues until you stop it. Start again to use the new version.'
