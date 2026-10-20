# ORE icon artwork

`ore-mark.svg` is the source for the PNG icons, Apple touch icon and ICO favicon.
Regenerate them from the repository root with the supported Node runtime:

```sh
node scripts/generate-icons.mjs
```

The dark fill and bronze stroke share one closed path, leaving the canvas outside
the stroke transparent. The letter, colors, 26px stroke and 28px outline inset
are retained from the original mark.

The outline uses a cubic approximation of the iOS continuous-corner shape,
with a 216.8px nominal radius on the 968px outline (about 22.4%). Unlike an SVG
`rect` with `rx`, the curve eases into the straight edges. Control-point ratios
follow [PaintCode's measurements of UIKit's continuous corners](https://www.paintcodeapp.com/news/code-for-ios-7-rounded-rectangles).
This is a static approximation, not a claim of pixel identity with every OS mask.

[Apple's current icon guidance](https://developer.apple.com/design/human-interface-guidelines/app-icons)
uses a system-applied rounded-square mask for iOS, iPadOS and macOS. Native icon
submission should follow that platform pipeline. These assets are flattened web
icons with the requested transparent exterior; the web manifest therefore declares
`purpose: "any"`, rather than advertising them as full-bleed maskable artwork.
