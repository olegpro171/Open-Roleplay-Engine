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

The favicon exports (16, 32 and 48px, including ICO) fill transparent exterior
pixels with the mark's dark background. The Apple touch icon remains unchanged.
Separate opaque full-square `maskable-*.png` exports are declared as `maskable`
in the manifest so Safari on macOS can apply its own system mask without placing
the transparent mark inside a padded white tile. The existing large transparent
exports remain available as `any` icons. The letter fits inside the maskable safe
zone; the decorative outer stroke may be cropped by platform masks.

See [WebKit's macOS web app icon guidance](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/).
