# Embedded into ORE-launcher.command; installed copies never delegate again.
set -euo pipefail
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH || true
ore_log=''; ore_stage=''; ore_child=''; ore_lock=0; ore_failure=setupFailed
exec 5>&1
ore_language=en
if [ "$ore_entry_mode" = installed ]; then
  [ "$#" -eq 3 ] || exit 1
  ore_home=$1; ore_invoking=$2; ore_language=$3
  case "$ore_language" in en|ru) ;; *) ore_language=en;; esac
else
  ore_preference=$(defaults export NSGlobalDomain - 2>/dev/null | plutil -extract AppleLanguages.0 raw -expect string -o - - 2>/dev/null) || ore_preference=''
  if [[ "$ore_preference" =~ ^ru([-_][a-zA-Z0-9]{2,8})*$ ]]; then ore_language=ru; fi
  ore_invoking=$(pwd -P)
  ore_parent=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
  ore_home="$ore_parent/ORE-internal"
fi
ore_say() {
  local value
  value=$(ore_message "$1") || return 1
  # Named substitutions are literal Bash string operations, never printf formats.
  case "$1" in
    folderCollision) value=${value//\{folder\}/ORE-internal};;
    invalidEnv) value=${value//\{line\}/${ORE_ENV_ERROR_LINE:-1}};;
    logFile) value=${value//\{absolutePath\}/$ore_log};;
  esac
  printf '%s\n' "$value" >&5
}
ore_abort() {
  ore_say "$1"
  if [ -n "$ore_log" ] && [ "$1" != logFailed ]; then
    ore_say assistance
    printf '%s\n' "$ore_log" >&5
  fi
  exit "${2:-1}"
}
if [ "${ORE_LAUNCH_HEADING:-0}" != 1 ]; then ore_say heading; fi
unset ORE_LAUNCH_HEADING || true
[ "$ore_entry_mode" = installed ] || [ "$#" -eq 0 ] || ore_abort setupFailed
[ "$(uname -s)" = Darwin ] || ore_abort unsupportedSystem
case "$(uname -m)" in arm64) ore_cpu=arm64;; x86_64) ore_cpu=x64;; *) ore_abort unsupportedSystem;; esac
ore_system=$(sw_vers -productVersion)
awk -v version="$ore_system" 'BEGIN {split(version,v,"."); exit !(v[1]>13 || (v[1]==13 && v[2]>=5))}' || ore_abort unsupportedSystem
if [ -e "$ore_home" ] || [ -L "$ore_home" ]; then
  [ -d "$ore_home" ] && [ ! -L "$ore_home" ] && [ ! -L "$ore_home/.ore-installation" ] && [ -f "$ore_home/.ore-installation" ] && [ "$(cat "$ore_home/.ore-installation")" = ORE-installation:1 ] || ore_abort folderCollision
else
  mkdir -- "$ore_home" 2>/dev/null || ore_abort notWritable
  printf 'ORE-installation:1\n' > "$ore_home/.ore-installation" || ore_abort notWritable
fi
# Validate every managed ancestor before any write. No symlink may redirect a
# mutable directory, pointer, report or bootstrap outside this installation.
for ore_directory in cache cache/npm logs runtime app recovery data languages; do
  [ ! -L "$ore_home/$ore_directory" ] || ore_abort folderCollision
  if [ -e "$ore_home/$ore_directory" ]; then [ -d "$ore_home/$ore_directory" ] || ore_abort folderCollision; fi
done
for ore_file in current working previous .env updates-paused recovery/current; do
  [ ! -L "$ore_home/$ore_file" ] || ore_abort folderCollision
  if [ -e "$ore_home/$ore_file" ]; then [ -f "$ore_home/$ore_file" ] || ore_abort folderCollision; fi
done
ore_selection() {
  local pointer="$ore_home/${1:-current}" extra
  [ -f "$pointer" ] && [ ! -L "$pointer" ] || return 1
  { IFS= read -r ore_release; IFS= read -r ore_runtime; ! IFS= read -r extra; } < "$pointer" || return 1
  [[ "$ore_release" =~ ^(release|dev)-[a-z0-9-]+$ ]] && [[ "$ore_runtime" =~ ^node-v[0-9.]+-darwin-(arm64|x64)$ ]] || return 1
  ore_application="$ore_home/app/$ore_release"
  ore_node="$ore_home/runtime/$ore_runtime/bin/node"
  if [ "${1:-current}" = recovery/current ]; then
    # Recovery tooling must remain usable even if its original app payload was
    # lost after selecting another compatible retained application.
    [ ! -L "$ore_home/recovery/$ore_release" ] && [ ! -L "$ore_node" ] && [ ! -L "$ore_home/runtime/$ore_runtime" ] && [ ! -L "$ore_home/runtime/$ore_runtime/bin" ] || return 1
    [ -x "$ore_node" ] && [ -f "$ore_home/recovery/$ore_release/portable-launch.mjs" ]
    return
  fi
  for ore_path in "$ore_application" "$ore_application/scripts" "$ore_application/scripts/release" "$ore_home/runtime/$ore_runtime" "$ore_home/runtime/$ore_runtime/bin" "$ore_node"; do [ ! -L "$ore_path" ] || ore_abort folderCollision; done
  for ore_file in portable-launch.mjs macos-install.mjs macos-launcher-protocol build-info.json manifest.json; do
    case "$ore_file" in *.json) ore_path="$ore_application/$ore_file";; *) ore_path="$ore_application/scripts/release/$ore_file";; esac
    [ ! -L "$ore_path" ] || ore_abort folderCollision
  done
  [ -x "$ore_node" ] && [ -f "$ore_application/scripts/release/portable-launch.mjs" ]
}
# Only the selected version can update its helper contract. Recovery/current is
# retained before pointer activation so an interrupted helper update is usable.
if [ "$ore_entry_mode" = standalone ]; then
  ore_helper=''
  for ore_pointer in current recovery/current; do
    if ! ore_selection "$ore_pointer"; then continue; fi
    if [ "$ore_pointer" = current ]; then ore_candidate="$ore_application/scripts/release";
    else ore_candidate="$ore_home/recovery/$ore_release"; fi
    ore_helper_result=0
    ore_helper_status "$ore_candidate" "$ore_home" || ore_helper_result=$?
    case "$ore_helper_result" in
      0) ore_helper="$ore_candidate"; break;;
      2) ore_abort folderCollision;;
      3) ore_abort setupFailed;;
    esac
  done
  if [ -n "$ore_helper" ]; then
    # Heading is printed by the installed presenter only once.
    export ORE_LAUNCH_HEADING=1
    exec /bin/bash "$ore_helper/macos-launcher.sh" "$ore_home" "$ore_invoking" "$ore_language"
  fi
  if [ -e "$ore_home/current" ] || [ -e "$ore_home/recovery/current" ]; then ore_abort setupFailed; fi
fi
mkdir -p -- "$ore_home/logs" 2>/dev/null || ore_abort logFailed
ore_temporary_log=$(mktemp "$ore_home/logs/launcher-$(date +%Y%m%d-%H%M%S)-$$.XXXXXXXX" 2>/dev/null) || ore_abort logFailed
# BSD mktemp requires the random suffix at the end. Publish a text filename
# without overwriting any existing report, then remove the temporary name.
if ! ln "$ore_temporary_log" "$ore_temporary_log.txt" 2>/dev/null; then
  rm -- "$ore_temporary_log" 2>/dev/null || true
  ore_abort logFailed
fi
ore_log="$ore_temporary_log.txt"
rm -- "$ore_temporary_log" || ore_abort logFailed
exec 1>>"$ore_log" 2>&1
ore_say logFile
ore_note() { printf '%s\n' "$*" || ore_abort logFailed; }
ore_note "Bootstrap protocol 1; macOS $ore_system; CPU $ore_cpu; language $ore_language"
cleanup() {
  local status=$? attempt
  trap - EXIT
  if [ -n "$ore_child" ]; then kill -TERM "$ore_child" 2>/dev/null || true; wait "$ore_child" 2>/dev/null || true; fi
  if [ -n "$ore_stage" ]; then
    cd -- "$ore_home" || true
    for attempt in 1 2 3; do if rm -rf -- "$ore_stage"; then break; fi; done
  fi
  if [ "$ore_lock" -eq 1 ]; then
    if [ "$(cat "$ore_home/cache/update.lock/owner")" = "$(printf '%s\n%s' "$$" "$ore_lock_token")" ]; then
      rm -- "$ore_home/cache/update.lock/owner" || { [ "$status" -ne 0 ] || status=75; }
      rmdir "$ore_home/cache/update.lock" || { [ "$status" -ne 0 ] || status=75; }
    else
      ore_note 'Installation lock owner changed; preserving lock.'
      [ "$status" -ne 0 ] || status=75
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'ore_abort cancelled 130' INT
trap 'ore_abort cancelled 143' TERM
trap 'ore_abort cancelled 129' HUP
trap 'ore_abort logFailed 74' XFSZ
mkdir -p -- "$ore_home/cache" "$ore_home/app" "$ore_home/runtime" "$ore_home/recovery" "$ore_home/data" "$ore_home/languages" || ore_abort notWritable
mkdir "$ore_home/cache/update.lock" 2>/dev/null || ore_abort installationLocked 75
ore_lock=1
ore_lock_token="$$-$RANDOM-$RANDOM"
printf '%s\n%s\n' "$$" "$ore_lock_token" > "$ore_home/cache/update.lock/owner" || ore_abort notWritable
export ORE_LAUNCH_LOCK_TOKEN="$ore_lock_token"
[ ! -e "$ore_home/cache/build.lock" ] || ore_abort installationLocked 75
if [ ! -e "$ore_home/.env" ]; then (set -o noclobber; : > "$ore_home/.env") || ore_abort notWritable; fi
ore_accept_env_key() {
  case "$1" in ore_*|ORE_HOME|ORE_LAUNCH_*|ORE_SNAPSHOT_*|ORE_DATABASE_*|IFS|PATH|BASH*|ENV|SHELLOPTS|CDPATH|GLOBIGNORE|PS4) return 1;; esac
}
ore_load_env "$ore_home/.env" || ore_abort invalidEnv
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset NODE_OPTIONS NODE_PATH BASH_ENV ENV CDPATH ORE_LAUNCH_EVENTS ORE_LAUNCH_REPORT ORE_DATABASE_MUST_EXIST ORE_DATABASE_DEFAULT || true
case "${ORE_SKIP_UPDATE:-0}" in 0|1) ;; *) ore_abort setupFailed;; esac
if [ "${ROLEPLAY_DATABASE+x}" = x ]; then
  [ -n "${ROLEPLAY_DATABASE//[[:space:]]/}" ] || ore_abort startupFailed
  case "$ROLEPLAY_DATABASE" in /*) ;; *) export ROLEPLAY_DATABASE="$ore_invoking/$ROLEPLAY_DATABASE";; esac
fi
# Resolve TLS files before downloaded tools change the working directory too.
for ore_key in ROLEPLAY_TLS_CERT ROLEPLAY_TLS_KEY; do
  ore_value=${!ore_key-}
  case "$ore_value" in ''|/*) ;; *) export "$ore_key=$ore_invoking/$ore_value";; esac
done
ore_stage=$(mktemp -d "$ore_home/cache/bootstrap.XXXXXXXX") || ore_abort notWritable
ore_download() {
  ore_note "HTTPS request: $1"
  curl -q --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 10 --max-time "${3:-120}" "$1" -o "$2" &
  ore_child=$!
  local result=0
  wait "$ore_child" || result=$?
  ore_child=''
  return "$result"
}
ore_toolkit_phase() { ore_note 'Runtime download'; ore_say downloadingToolkit; }
ore_installed=0
ore_tools=''
if [ "$ore_entry_mode" = installed ]; then ore_tools=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P); fi
if ore_selection; then
  ore_installed=1
  [ -n "$ore_tools" ] || ore_tools="$ore_application/scripts/release"
  # Verify payload/runtime identity and asset hashes WITHOUT opening saved data.
  "$ore_node" "$ore_tools/macos-install.mjs" verify "$ore_home" "$ore_application" || ore_abort startupFailed
fi
ore_update() {
  ore_update_status=1
  ore_failure=downloadFailed
  ore_say checkingUpdates
  ore_download 'https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/commits/main' "$ore_stage/main.json" 30 || return 1
  ore_target=$(plutil -extract sha raw -expect string -o - "$ore_stage/main.json") || return 1
  [[ "$ore_target" =~ ^[0-9a-f]{40}$ ]] || { ore_note 'Invalid full commit in main metadata.'; return 1; }
  ore_note "Resolved main $ore_target"
  if [ "$ore_installed" -eq 1 ]; then
    ore_commit=$(plutil -extract commit raw -expect string -o - "$ore_application/build-info.json") || return 1
    [[ "$ore_commit" =~ ^[0-9a-f]{40}$ ]] || return 1
    if [ "$ore_commit" = "$ore_target" ]; then ore_say upToDate; return 0; fi
    ore_download "https://api.github.com/repos/olegpro171/Open-Roleplay-Engine/compare/$ore_commit...$ore_target?per_page=1" "$ore_stage/compare.json" 30 || return 1
    [ "$(plutil -extract status raw -expect string -o - "$ore_stage/compare.json")" = ahead ] && [ "$(plutil -extract base_commit.sha raw -expect string -o - "$ore_stage/compare.json")" = "$ore_commit" ] && [ "$(plutil -extract merge_base_commit.sha raw -expect string -o - "$ore_stage/compare.json")" = "$ore_commit" ] || { ore_note 'Main ancestry was not verified as a forward continuation.'; return 1; }
  fi
  ore_fallback=updateFallback
  ore_say downloadingVersion
  ore_download "https://github.com/olegpro171/Open-Roleplay-Engine/archive/$ore_target.tar.gz" "$ore_stage/source.tar.gz" 300 || return 1
  ore_failure=verificationFailed
  ore_say preparingVersion
  ore_extract_snapshot "$ore_stage/source.tar.gz" "$ore_target" "$ore_stage/source" "$ore_stage/list" || { ore_note 'Source archive path/type/input validation failed.'; return 1; }
  [ "$(cat "$ore_stage/source/scripts/release/macos-launcher-protocol")" = 1 ] || { ore_note 'Downloaded snapshot requires an unsupported standalone helper protocol.'; return 1; }
  ore_runtime_identity "$ore_stage/source/scripts/release/runtime.conf" "$ore_stage/source/scripts/release/node-SHASUMS256.txt" darwin "$ore_cpu" || return 1
  ore_note "Source $ore_target; archive SHA256 $(ore_checksum "$ore_stage/source.tar.gz"); runtime $runtime; official SHA256 $expected"
  local result=0
  ore_private_runtime "$ore_home" "$ore_stage" || result=$?
  case "$result" in 0) ;; 20) ore_failure=downloadFailed; return 1;; 21|22) ore_failure=verificationFailed; return 1;; *) ore_failure=setupFailed; return 1;; esac
  # This entry consumes the archive itself, revalidates it and builds only the
  # allowlisted inputs. No arbitrary local directory can be called a release.
  ore_node="$ore_home/runtime/$runtime/bin/node"
  ore_failure=buildFailed
  ore_say buildingVersion
  "$ore_node" "$ore_stage/source/scripts/release/macos-install.mjs" build "$ore_home" "$ore_stage/source.tar.gz" "$ore_target" "$ore_log" "$ore_language" >&5 &
  ore_child=$!
  result=0
  wait "$ore_child" || result=$?
  ore_child=''
  ore_update_status=$result
  case "$result" in 0) return 0;; 75) ore_abort installationLocked 75;; 129|130|143) ore_abort cancelled "$result";; 24) ore_failure=activationFailed;; 74) ore_abort logFailed;; esac
  return 1
}
if [ "${ORE_SKIP_UPDATE:-0}" = 1 ] || [ -f "$ore_home/updates-paused" ]; then
  [ "$ore_installed" -eq 1 ] || ore_abort setupFailed
  ore_say updatesPaused
else
  [ "$ore_installed" -eq 1 ] || ore_say firstSetup
  ore_fallback=checkFallback
  # No subshell: retain the exact failure phase and exit status for presentation.
  if ore_update; then :; else
    ore_note "Update failed at $ore_failure"
    [ "$ore_installed" -eq 1 ] || ore_abort "$ore_failure" "$ore_update_status"
    ore_selection || ore_abort startupFailed
    "$ore_node" "$ore_tools/macos-install.mjs" verify "$ore_home" "$ore_application" || ore_abort startupFailed
    ore_say "$ore_fallback"
  fi
fi
ore_selection || ore_abort startupFailed
ore_note "Selected $ore_release; runtime $ore_runtime; starting application (automatic fallback ends here)"
# Lock is retained for the whole foreground lifetime. Contention cannot turn
# into fallback, and another launcher cannot activate code while ORE starts.
export ORE_LAUNCH_LANGUAGE="$ore_language" ORE_LAUNCH_REPORT="$ore_log"
ore_controller="$ore_application/scripts/release/portable-launch.mjs"
if [ ! -f "$ore_application/scripts/release/macos-launcher-protocol" ] && [ -n "$ore_tools" ]; then ore_controller="$ore_tools/portable-launch.mjs"; fi
"$ore_node" "$ore_controller" "$ore_home" "$ore_application" >&5 &
ore_child=$!
trap 'kill -INT "$ore_child" 2>/dev/null || true; wait "$ore_child" || true; ore_child=""; exit 130' INT
trap 'kill -TERM "$ore_child" 2>/dev/null || true; wait "$ore_child" || true; ore_child=""; exit 143' TERM
trap 'kill -HUP "$ore_child" 2>/dev/null || true; wait "$ore_child" || true; ore_child=""; exit 129' HUP
ore_status=0
wait "$ore_child" || ore_status=$?
ore_child=''
exit "$ore_status"
