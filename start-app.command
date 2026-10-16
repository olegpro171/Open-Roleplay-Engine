#!/bin/zsh
set -e
cd "${0:A:h}"

# Prefer the user's working LTS installation; the desktop runtime is a local fallback.
for roleplay_node in /opt/homebrew/opt/node@24/bin/node /opt/homebrew/opt/node@22/bin/node "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" "$(command -v node)"; do
  if [[ -x "$roleplay_node" ]] && "$roleplay_node" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major===24||(major===22&&minor>=12)?0:1)' 2>/dev/null; then
    export PATH="${roleplay_node:h}:$PATH"
    break
  fi
done
if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major===24||(major===22&&minor>=12)?0:1)' 2>/dev/null; then
  print 'Install Node.js 24 LTS or Node.js 22.12+ before starting the application.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  print 'Install dependencies first with npm ci using Node.js LTS. See README.md.'
  exit 1
fi
npm run build
exec npm start
