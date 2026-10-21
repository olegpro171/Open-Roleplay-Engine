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
  *) fail 'Choose --release FULL_COMMIT INSTALL_DIRECTORY or --development INSTALL_DIRECTORY.' ;;
esac
for command in git curl tar awk sed; do command -v "$command" >/dev/null || fail "Required tool missing: $command. No system packages were installed."; done
if [ "$mode" = '--release' ]; then
  [ -z "$(git -C "$ore_source" status --porcelain --untracked-files=all)" ] || fail 'Release source must be clean, including untracked files. Commit the intended changes first.'
  [ "$commit" = "$(git -C "$ore_source" rev-parse HEAD)" ] || fail 'Release requires the exact full checked-out commit.'
  git -C "$ore_source" merge-base --is-ancestor "$commit" main || fail 'Release commit must be reachable on local main.'
fi
# A short, explicit allowlist is also used for developer builds.
inputs=(package.json package-lock.json tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts playwright.config.ts index.html src public migrations scripts/release docs/RELEASES.md docs/RELEASE_IMPLEMENTATION_BRIEF.md docs/RELEASE_VERIFICATION.md docs/WINDOWS_RELEASE_HANDOFF.md docs/WINDOWS_RELEASE_VERIFICATION.md docs/TEST_RELEASE.md)
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
. "$ore_source/scripts/release/runtime.conf"
runtime="node-v$ORE_NODE_VERSION-$os-$cpu"
archive="$runtime.tar.gz"
expected=$(awk -v name="$archive" '$2 == name {print $1}' "$ore_source/scripts/release/node-SHASUMS256.txt")
[ "${#expected}" -eq 64 ] || fail 'Pinned runtime checksum is missing.'
mkdir -p -- "$destination" || fail 'Cannot create installation. Select a user-writable directory.'
ore_home=$(CDPATH='' cd -- "$destination" && pwd -P)
[ "$ore_home" != "$ore_source" ] || fail 'Use a separate installation directory, not the source checkout.'
mkdir -p -- "$ore_home/cache" "$ore_home/runtime" "$ore_home/app" "$ore_home/logs" "$ore_home/languages" "$ore_home/data" || fail 'Installation is not writable.'
mkdir "$ore_home/cache/build.lock" 2>/dev/null || fail 'Another build owns cache/build.lock. If interrupted, check that it stopped before removing the lock directory.'
stage=''
cleanup() { [ -z "$stage" ] || rm -rf -- "$stage"; rmdir "$ore_home/cache/build.lock"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
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
checksum() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1" | awk '{print $1}';
  elif command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}';
  else fail 'shasum or sha256sum is required to verify downloads.'; fi
}
echo "[Build 1/6] Preparing ORE's private Node.js $ORE_NODE_VERSION runtime..."
if [ ! -d "$ore_home/runtime/$runtime" ]; then
  download="$ore_home/cache/$archive"
  if [ ! -f "$download" ]; then
    echo "Downloading official Node $ORE_NODE_VERSION for ${os}/${cpu}…"
    curl -q --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 600 "https://nodejs.org/dist/v$ORE_NODE_VERSION/$archive" -o "$stage/runtime.part" || fail 'Runtime download failed; installed version is unchanged. Retry explicitly.'
    [ "$(checksum "$stage/runtime.part")" = "$expected" ] || fail 'Runtime checksum mismatch; nothing was installed. Remove any bad cached archive and retry.'
    mv -- "$stage/runtime.part" "$download"
  fi
  [ "$(checksum "$download")" = "$expected" ] || fail 'Cached runtime checksum mismatch. Remove only that archive from cache and retry.'
  echo '[Build 1/6] Download verified. Unpacking the private runtime...'
  tar -xzf "$download" -C "$stage"
  [ -x "$stage/$runtime/bin/node" ] || fail 'Runtime archive is incomplete.'
  mv -- "$stage/$runtime" "$ore_home/runtime/$runtime"
else
  echo '[Build 1/6] Reusing the runtime already installed for ORE.'
fi
export PATH="$ore_home/runtime/$runtime/bin:$PATH"
node="$ore_home/runtime/$runtime/bin/node"
npm="$ore_home/runtime/$runtime/lib/node_modules/npm/bin/npm-cli.js"
[ "$("$node" --version)" = "v$ORE_NODE_VERSION" ] || fail 'Installed private runtime is invalid; restore it from the verified archive.'
work="$stage/source"
mkdir "$work"
if [ "$mode" = '--release' ]; then
  git -C "$ore_source" archive "$commit" -- "${inputs[@]}" | tar -xf - -C "$work"
else
  for input in "${inputs[@]}"; do
    mkdir -p -- "$work/$(dirname -- "$input")"
    cp -R -- "$ore_source/$input" "$work/$input"
  done
fi
cd -- "$work"
echo '[Build 2/6] Installing the packages needed to build ORE. Downloads may take a few minutes...'
"$node" "$npm" ci --include=dev --include=optional --ignore-scripts
# Fail before build if prebuilt native dependencies cannot load. Never compile.
echo '[Build 3/6] Checking database/image support, then building the interface and server...'
"$node" scripts/release/native-smoke.mjs || fail 'Locked prebuilt SQLite/sharp dependencies do not work on this OS/CPU/libc. No compiler or global image library was installed.'
"$node" "$npm" --silent run build
echo '[Build 4/6] Collecting third-party licenses and notices...'
"$node" scripts/release/stage.mjs notices "$work" "$stage/notices"
echo '[Build 5/6] Preparing the packages needed to run the finished app...'
"$node" "$npm" ci --omit=dev --ignore-scripts --include=optional --prefer-offline
echo '[Build 6/6] Staging and verifying the new app before activation...'
"$node" scripts/release/stage.mjs install "$work" "$ore_home" "$mode" "$commit" "$runtime" "$expected" "$stage/notices"
echo "ORE installed in $ore_home"
echo "Start (also offline): $ore_home/start.command"
echo 'The running version, if any, continues until you stop it. Start again to use the new version.'
