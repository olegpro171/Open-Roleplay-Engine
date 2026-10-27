# Interface palette

## Approval and lock

The user visually approved Dark, Light and Midnight Black on 2026-10-26. The approval includes base colors and derived shades, including the Light status/meter/legend refinements and theme speech defaults. Current approved values live in `src/web/palette.css` and `tests/fixtures/approved-dark-palette.json` / `theme-palettes.json`; those files are the exact baseline, not values to reconstruct from a historical narrative. Twenty is the original Dark base count, not a quota for other themes.

- Reuse semantic roles and centralize all definitions/derivations in the palette. No raw component literals or local mixes.
- Obtain explicit user agreement for new colors/shades, changed base/derived values, aliases that change color, mix ratios or expanded exceptions. Existing authorization in the current task counts.
- A meaningful new alias to an approved role is allowed without changing color. Avoid component-specific shade variants.
- Preserve baseline fixtures and palette guards. Update them only for an agreed appearance change; never regenerate/weaken them merely to pass a check.
- Authorization for another theme does not authorize changing approved themes. Preserve semantic status, difference and allocation meanings as well as non-color labels/borders.

Dark and Light retain their approved surfaces/hues. Midnight Black uses pure-black ordinary surfaces and neutral decoration/controls/speech, preserving meaningful status/difference/category hues and explicit user colors. Theme speech defaults yield to explicit application overrides, then Character/Persona overrides. Light's Character/Persona defaults remain distinct; seed Persona overrides from its own role.

## Ownership

`src/web/palette.css` owns the interface's base colors and derived semantic roles.
The approved Dark interface has 20 base colors; its existing speech default has now
also moved into this stylesheet. Light overrides bases and selected derivations
under `:root[data-theme="light"]`, retaining the same semantic roles.
Midnight Black overrides its bases and decorative roles under
`:root[data-theme="midnight-black"]`. The shared `text-selection` role aliases the
existing information surface in Dark/Light and a neutral selection in Midnight Black.
`src/web/main.tsx` loads it before `style.css`, making the same roles
available to portals, modal dialogs and the CodeMirror comparison editor. Component
CSS and editor extensions use `var(--role)` rather than separate color literals.

| Base group | Colors |
| --- | --- |
| Neutral | Black, white, page, inset, chrome, surface, raised, border, text, muted |
| Accent | Orange |
| Status | Success, danger, destructive button, information, warning |
| Additional allocation hues | Purple, gold, teal, pink |

Values live in the stylesheet; the original dark fixture records the visually
approved definitions for the automated guard. A separate `theme-palettes.json`
fixture records the moved dark speech roles and visually approved light overrides.
It also records the visually approved Midnight Black palette. Both fixtures prevent
accidental changes to the recorded appearance.
Different roles can share one base without becoming the same concept: an information indicator and a history allocation can diverge in a later
approved theme. Reuse existing roles where the meaning matches. A new role may
alias an approved role when it serves a distinct purpose; a new mix requires
agreement because it introduces a shade. Avoid creating a
separate role for each component or recreating the old collection of near-identical
shades as individual mixes. Derivations also belong in `palette.css`.

Opaque `color-mix(in srgb, ...)` roles produce surfaces, borders and text shades;
their contrast does not depend on what happens to be behind them. Alpha is reserved
for intentional overlays, shadows, image-tool guides and subtle highlights. Whole
element opacity retains its existing disabled-state behavior; do not use it to
derive a background because it also fades the content.

Turn actions, Chat details navigation, Library and Settings category selectors,
Library secondary/quiet actions and the picture viewer close control share one
explicit palette hover rule using `--surface-raised`. Category navigation has no
separate hover fill; the selected Library category keeps its persistent accent
background, border and text, including while hovered. The shared rule
disables the generic button brightness filter so the approved fill is displayed
directly. In Light, brightening that fill would nearly match the page and removing
the filter before the background transition ends would produce a dark flash.

The consolidation keeps the dark page, header, primary button and principal text
colors. Previously similar panel shades, borders, muted labels, accent highlights
and status variants now share roles. Chart allocations share the matching Prompt
peek colors. Memory state labels, border styles and deletion stripes remain in
addition to color. The summary comparison uses the same addition/removal roles in
both wide and unified phone layouts. Checkbox marks use a mask so their visible
color comes from `--on-accent` rather than a color embedded inside an SVG URL.

## Boundaries and exceptions

- **Saved speech colors:** application and Character/Persona overrides
  remain user data and retain their exact saved values. Null application defaults
  now follow the active theme’s speech roles; explicit application colors can be
  cleared using the theme-color actions in Chat appearance. Card overrides retain
  precedence. New installations follow the theme; legacy saved colors, including
  the old default blue, remain overrides until explicitly cleared.
- **Color picker:** preset swatches and HSL channel gradients represent selectable
  user colors. Their data declarations are excluded from the UI-literal guard;
  the picker's frame, labels, buttons, borders and errors still use palette roles.
- **Images and masks:** imported images, generated icon artwork, the send-icon SVG
  mask and the checkbox mask are not recolored as palette definitions. Black in a
  mask controls alpha only. Image crop grids and slider-thumb rings use explicit
  shared roles based on black/white to remain visible over arbitrary content.
- **Initial browser chrome:** `index.html` and `public/site.webmanifest` retain
  their dark fallback header/page values, checked by the guard. The server injects
  the saved theme into the HTML root before CSS loads, including at login; the
  browser updates theme-color from the active chrome role on startup and live
  changes. The installed manifest’s launch background remains the static dark
  fallback; actual phone/browser chrome behavior needs device review.
- **System accessibility colors:** `Highlight`, `currentColor`, `transparent` and
  inherited colors retain their CSS meaning. Do not replace forced-colors support
  with a palette literal.

Theme selection is server-wide in appearance sidecar version 4, using the existing
revision-checked atomic save and notification paths. Versions 1–3 load without
rewriting saved colors/revisions and upgrade on the next successful save. Failed
saves retain the previous committed theme and the latest editable choice with Retry;
competing saves rebase only locally edited fields. No dependency or SQLite migration
is needed. Themes and app speech overrides stay outside content backups/import/wipe.
Transcripts, request history, prompts and operation recovery remain unchanged.

## Verification and acceptance

`npm test -- tests/palette.test.ts tests/appearance.test.ts` checks centralized literals, base and derived
definition changes, local component mixes, reference resolution and initial browser
colors. The lock permits new aliases to approved roles but rejects new shades,
changed ratios, removed approved roles and duplicate definitions. Formatting-only
whitespace changes do not change the approved values. This is an accidental-regression
guard, not a general CSS parser or security boundary. Do not bypass it by encoding
colors, using named colors or expanding exceptions without user agreement.

For palette/stylesheet behavior changes shared across workflows, run `npm run check`. Keep
before/after screenshots from the existing settings, library actions, Markdown and
repair workflows. Inspect desktop and phone-sized rendering, including both sides
of relevant breakpoints. Browser emulation does not establish actual phone behavior.

For future approved appearance changes, the visual checklist is:

- Login; Story with ordinary prose, speech, links, code, tables and streaming text.
- Header/sidebar navigation, Chat details, composer, turn controls and tooltips.
- Every Library category and editor, menus, dropdowns and picture/crop controls.
- All Settings sections, color picker, backup inspection and confirmations.
- Memory's active, retained, manually corrected, stale, preparing and deleting
  states; allocations and request inspection; additions/removals in repair review.
- Hover, keyboard focus, selected, disabled, loading and error/retry states.

`tests/browser/themes.spec.ts` checks theme save failures/retry, competing saves,
cross-window updates, fresh-browser login, reload, Russian controls, theme speech
defaults and custom overrides. It checks key light text/status contrast pairs and
Midnight Black contrast, pure-black surfaces and neutral decorative roles, and
captures Story, settings, Library menus, Memory and editable repair at desktop,
phone-sized and breakpoint-adjacent widths. A live theme change must retain the
unapproved repair text and composer draft. Existing workflows also run in the full
suite. These checks do not establish universal accessibility or actual phone support.

Keep visual approval separate from the automated workflow results. The user's
acceptance above establishes the current Dark, Light and Midnight Black baselines;
actual phone verification remains separate.
