# Shared archive policy. No archive bytes are extracted until BOTH listings pass.
# Source snapshots deliberately allow only regular files/directories, never links.
ore_inputs=(build-portable.sh package.json package-lock.json tsconfig.json tsconfig.server.json vite.config.ts vitest.config.ts playwright.config.ts index.html src public migrations scripts/release LICENSE docs/RELEASES.md)
ore_extract_snapshot() {
  local archive="$1" commit="$2" destination="$3" listing="$4" input
  [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || return 1
  tar -tzf "$archive" > "$listing.names" || return 1
  awk -v root="Open-Roleplay-Engine-$commit" '
    !/^[A-Za-z0-9_.\/@+-]+\/?$/ {exit 1}
    {n=split($0,p,"/"); if(p[1]!=root) exit 1; for(i=1;i<=n;i++) if(p[i]==".." || p[i]==".") exit 1}
    END {if(NR==0) exit 1}' "$listing.names" || return 1
  tar -tvzf "$archive" > "$listing.types" || return 1
  awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {exit 1} END {if(NR==0) exit 1}' "$listing.types" || return 1
  mkdir "$destination" || return 1
  local selected=()
  for input in "${ore_inputs[@]}"; do selected+=("Open-Roleplay-Engine-$commit/$input"); done
  tar -xzf "$archive" --strip-components 1 -C "$destination" "${selected[@]}" || return 1
  for input in "${ore_inputs[@]}"; do [ -e "$destination/$input" ] && [ ! -L "$destination/$input" ] || return 1; done
}
