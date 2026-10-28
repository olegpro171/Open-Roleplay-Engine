# Used by the contained builder and embedded in the standalone bootstrap.
ore_runtime_identity() {
  local declaration="$1" checksums="$2" os="$3" cpu="$4"
  ORE_NODE_VERSION=$(awk '/^ORE_NODE_VERSION=[0-9]+\.[0-9]+\.[0-9]+$/ {n++; sub(/^ORE_NODE_VERSION=/, ""); value=$0} !/^#/ && NF && !/^[0-9]+\.[0-9]+\.[0-9]+$/ {bad=1} END {if(n!=1 || bad) exit 1; print value}' "$declaration") || return 1
  runtime="node-v$ORE_NODE_VERSION-$os-$cpu"
  archive="$runtime.tar.gz"
  expected=$(awk -v name="$archive" '$2==name {n++; value=$1} END {if(n!=1) exit 1; print value}' "$checksums") || return 1
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || return 1
}
ore_checksum() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1" | awk '{print $1}';
  elif command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}';
  else return 1; fi
}
ore_private_runtime() {
  local home="$1" temporary="$2" download="$1/cache/$archive"
  if [ -e "$home/runtime/$runtime" ]; then
    [ -d "$home/runtime/$runtime" ] && [ ! -L "$home/runtime/$runtime" ] || return 23
  else
    if [ ! -f "$download" ]; then
      ore_toolkit_phase
      ore_download "https://nodejs.org/dist/v$ORE_NODE_VERSION/$archive" "$temporary/runtime.part" || return 20
      [ "$(ore_checksum "$temporary/runtime.part")" = "$expected" ] || return 21
      mv -- "$temporary/runtime.part" "$download" || return 23
    fi
    [ ! -L "$download" ] && [ "$(ore_checksum "$download")" = "$expected" ] || return 22
    # The official, checksum-verified archive is trusted, unlike source tarballs.
    tar -xzf "$download" -C "$temporary" || return 21
    [ -x "$temporary/$runtime/bin/node" ] || return 21
    [ "$("$temporary/$runtime/bin/node" --version)" = "v$ORE_NODE_VERSION" ] || return 21
    mv -- "$temporary/$runtime" "$home/runtime/$runtime" || return 23
  fi
  [ ! -L "$home/runtime/$runtime/bin" ] && [ ! -L "$home/runtime/$runtime/bin/node" ] || return 21
  [ "$("$home/runtime/$runtime/bin/node" --version)" = "v$ORE_NODE_VERSION" ] || return 21
}
