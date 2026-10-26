# Interface palette

## Approval and lock

The user **visually approved the dark palette on 2026-10-26**, after checking
application menus and reporting no noticeable difference from the previous colors.
The consolidation and palette checkpoint are complete. The subsequently authorized
Dark/Light theme selector and Light palette are implemented. The user also visually
approved Light on 2026-10-26; both shipped palettes follow this approval boundary.

The approved appearance includes both the base colors and their derived shades.
Twenty was a working target during consolidation; it is this palette's approved
base count, not a demonstrated minimum or a quota for future themes.

Future agents must:

- Reuse existing semantic roles in components and keep definitions/derivations in
  `src/web/palette.css`. Do not insert raw literals or local mixes into components.
- Obtain explicit user agreement before introducing a new base color or derived
  shade, changing an existing role's color/alias/mix ratio, or expanding exceptions.
  Approval already given in the current task counts; do not request it again.
- Allow a meaningful new semantic alias to an approved role when it changes no
  color. This needs no new color approval. Avoid component-specific shade variants.
- Preserve the approved baseline in `tests/fixtures/approved-dark-palette.json` and
  the checks in `tests/palette.test.ts`. Update that baseline only for an agreed
  palette change, alongside its source and documentation. Never regenerate it or
  weaken a guard just because a check failed.

An explicitly authorized new theme may define its own palette within the agreed
design. It must preserve the approved Dark palette unless the user also authorizes
changes to Dark. Theme implementation should extend the guard for each approved
palette and retain shared semantic roles, rather than reopening scattered color
definitions. The palette lock does not authorize new themes or settings by itself.

The user subsequently requested lighter category-bar and input-meter colors in
Light for visual review. The current refinement lightens the existing accent,
success, danger, information and allocation base hues, keeping their shared uses.
Existing text/on-fill roles derive readable foregrounds from those hues; the
Character allocation uses the lighter accent base and framing uses the existing
border neutral. No palette entries or meter-specific roles are added for these
fills; Dark remains unchanged. The user approved these lighter fills, then requested
matching Summary layers legend swatches and more solid summary fills. Legend
swatches use the existing fill roles independently of their readable text labels.
Light's success/danger/warning surface mixes now carry 65–80% status color, and
warning uses a lighter gold with a dark text derivation. These shared surface roles
also appear in alerts and repair comparisons. Summary outlines in Light reuse the
darker status-text roles (muted for retained alternatives), preserving dashed and
deletion styles; this does not change the shared border roles elsewhere. The user
accepted the refinement batch for commit on 2026-10-26 after visual review. The
fixture tracks these authorized values; automated checks remain separate from
visual acceptance.

Light speech defaults were explicitly set by the user to Character `#343a42` and
Persona `#562a0a`. These are theme defaults; saved application and card overrides
retain precedence. The Persona editor seeds a new override from the Persona theme
role, independently of Character. Dark speech remains unchanged.

## Ownership

`src/web/palette.css` owns the interface's base colors and derived semantic roles.
The approved Dark interface has 20 base colors; its existing speech default has now
also moved into this stylesheet. Light overrides bases and selected derivations
under `:root[data-theme="light"]`, retaining the same semantic roles.
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
Both fixtures prevent accidental changes to the accepted appearance.
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
captures Story, settings, Library menus, Memory and editable repair at desktop,
phone-sized and breakpoint-adjacent widths. A live theme change must retain the
unapproved repair text and composer draft. Existing workflows also run in the full
suite. These checks do not establish universal accessibility or actual phone support.

Keep visual approval separate from the automated workflow results. The user's
acceptance above establishes the current Dark and Light baselines; actual phone
verification remains separate.
