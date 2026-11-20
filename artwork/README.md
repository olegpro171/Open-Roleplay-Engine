# ORE icon artwork

The Bold bird marks live in [public/icons](../public/icons/). ORE uses Dark Bold
by default, and uses the matching mark for Light, Midnight Black and Porcelain
in the header and on sign-in and setup screens.

Browser tabs use the supplied Bold SVG and 32px PNG for the active theme. Dark
uses [Peach Bold](../public/icons/favicon-peach-bold.svg) with its
[32px PNG](../public/icons/icon-32.png). The match for each other theme uses the
corresponding `favicon-*-bold` files in `public/icons/`. The favicons fill
the canvas with their tile color. ORE sends the saved theme's links in the
initial page and updates them after a theme change.

The legacy `/favicon.ico` uses Peach Bold at 16, 32 and 48px. The generator renders the
16px and 48px PNGs from the SVG and includes the supplied 32px PNG as-is.

Safari Add to Dock and Chrome app installs use the active theme's manifest.
Each manifest includes the exact favicon SVG and 192px and 512px PNGs rendered
from it. The Apple touch icon uses the matching 192px PNG. The opaque 1024px
maskable PNG insets the crest so system masks can round the tile without
clipping the bird. All manifests identify the same ORE app at `/`.

Regenerate the exports and manifests from the repository root with the supported
Node runtime.

```sh
node scripts/generate-icons.mjs
```
