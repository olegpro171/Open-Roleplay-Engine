# Shared by generated entry points. Incomplete helpers may use recovery;
# unsafe paths and unknown protocols must fail closed instead.
ore_helper_status() {
  local tools="$1" root="$2" path="$1"
  while [ "$path" != "$root" ]; do
    [ ! -L "$path" ] || return 2
    case "$path" in "$root"/*) path=$(dirname -- "$path");; *) return 2;; esac
  done
  [ ! -L "$root" ] && [ ! -L "$tools/macos-launcher-protocol" ] && [ ! -L "$tools/macos-launcher.sh" ] || return 2
  [ -f "$tools/macos-launcher-protocol" ] && [ -r "$tools/macos-launcher-protocol" ] || return 1
  [ "$(cat "$tools/macos-launcher-protocol" 2>/dev/null)" = 1 ] || return 3
  [ -f "$tools/macos-launcher.sh" ] && [ -r "$tools/macos-launcher.sh" ] && [ -s "$tools/macos-launcher.sh" ] || return 1
  /bin/bash -n "$tools/macos-launcher.sh" 2>/dev/null || return 1
}
