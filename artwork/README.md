# ORE icon artwork

The Bold bird marks live in [public/icons](../public/icons/). ORE uses Dark Bold
by default, and uses the matching mark for Light, Midnight Black and Porcelain
in the header and on sign-in and setup screens.

Browser tabs use a transparent Bold SVG and 32px PNG for the active theme. Dark
uses [Peach Bold](../public/icons/favicon-peach-bold.svg) with its
[32px PNG](../public/icons/icon-32.png). The match for each other theme uses the
corresponding `favicon-*-bold` files in `public/icons/`. ORE sends the saved
theme's links in the initial page and updates them after a theme change.

The legacy `/favicon.ico` uses transparent Peach Bold at 16, 32 and 48px. The
generator renders the PNGs from the SVGs.

Installed icons use the active theme's bird and tile colors, with the crest
inset to about 78% of the tile height. Safari on iPhone uses a dedicated opaque
180px Apple touch icon and applies its own corner mask. The manifest's 192px
and 512px general-purpose PNGs include rounded corners with transparency for
Chrome installs on Windows. Safari Add to Dock can use the opaque full-bleed
1024px maskable PNG for its system mask. All manifests identify the same ORE
app at `/`.

Regenerate the exports and manifests from the repository root with the supported
Node runtime.

```sh
node scripts/generate-icons.mjs
```
