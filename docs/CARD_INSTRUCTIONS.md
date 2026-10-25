# Card-specific instructions

Accepted and implemented 2026-10-19. The Prompt preset authorizes card instructions through two explicit markers and a Messages option. Character's existing Name/Description/Personality/Scenario/Example dialogue selection does not activate them.

## System and post-history markers

**Card system prompt** reads `system_prompt`. **Card post-history instructions** reads `post_history_instructions`. Each marker has its own role, position, enabled state and optional fallback text. At most one enabled marker of each type is supported. The post-history name describes its normal position; the preset can deliberately place it elsewhere.

A nonblank card field replaces that marker's fallback. An absent/blank field, including a missing character, uses its fallback. Empty resolved content contributes no message. Other enabled preset blocks always remain included.

Case-insensitive `{{original}}` in either card field inserts that marker's fallback. `{{user}}` and `{{char}}` resolve once in both sources. The substitution is nonrecursive: fallback text and inserted names cannot execute additional macros; `{{original}}` elsewhere remains literal. Other macros remain literal. No general template engine is enabled.

The factory/new-prompt layout is Card system prompt → Character → Persona → Summary → Messages → Card post-history instructions. The system marker's fallback is the former Instructions text; the closing fallback is empty. Messages permits character depth injection in new templates. Restore original explicitly installs this layout. Existing saved presets and older prompt imports keep their blocks and injection permissions; missing permission means off. New chats selecting an existing saved preset inherit that preset's behavior.

## Character depth note

Messages exposes **Allow character depth prompt injection**. Injection requires an enabled Messages marker with this option checked. The selected card supplies note text, depth and role from the SillyTavern `extensions.depth_prompt` object (`prompt`, `depth`, `role`). V2/V3 read nested `data.extensions`; legacy cards read root `extensions`. Missing depth defaults to 2; missing role defaults to system. Supported roles are system/user/assistant; depth is an integer from 0 through 1,000. Note text and each instruction field are limited to 100,000 characters when consumed or edited.

Depth counts outgoing nonblank original history messages, including a pending user message or unsent preview input. Summaries, lore entries and the note itself do not count. Depth 0 follows the newest eligible message; depth 1 precedes it; excessive depth clamps before the oldest included eligible message. An enabled but empty Messages expansion still provides an insertion point. Missing/disabled Messages provides none.

Lore and character notes use the same history insertion helper. At a shared insertion point, admitted lore retains its established order and the character note follows. All instruction/injection framing and content are counted before selecting a recent whole-turn suffix with Summary disabled. Managed mode uses the committed verbatim tail. Complete assembled input remains subject to target and physical limits; notes are never dropped to make it fit.

Injection creates no stored turn, changes no coverage/cutoff, and never becomes a summary source. Extraction, promotion and repair continue to use their separate prompts. Editing card instructions changes future roleplay input without making existing narrative memories stale. Existing generation/preparation ownership and shared-library revision guards apply.

## Editing and preservation

Character editor's **Card instructions** disclosure exposes both instruction fields plus note text/depth/role. Shared contracts keep edited fields optional. Readers use explicit normalized values first, falling back to preserved import metadata for older cards; explicit empty values clear the effective field. No reimport or schema migration is required.

Card imports continue retaining their exact source metadata. Unrelated extensions and extra properties in a valid depth-note object survive export. Edited note fields are overlaid into `extensions.depth_prompt`, never exported as an ORE-only top-level depth field. Omitted older-client writes preserve already edited instruction fields. Materializing identical preserved values does not advance character/chat source revisions. Duplication copies instructions through the existing atomic character command.

Malformed preserved fields remain intact on unrelated saves and exports. The editor identifies invalid values and offers explicit clearing. Replacing a note also repairs a malformed extensions container on export; the editor identifies that consequence before clearing. Unrelated exports keep the malformed container intact. A malformed field consumed by an enabled marker or permitted note fails before a provider call. Disabling its insertion preserves the metadata without consuming it. Failed or uncertain saves retain the draft/frozen command and use the existing Retry same save workflow. Saved request bodies and earlier summaries remain immutable.

## Configuration warnings

Chat Settings lists structural warnings for the selected character, preset and lorebook, including unsaved selection changes. Story's Chat settings button shows the count for saved selections. Server diagnostics use the same field readers and lore destination/directive-fallback resolution as generation; they do not scan keywords, advance lore state or call models.

Warnings identify nonempty card instructions whose markers are unavailable, depth notes whose Messages permission is unavailable, malformed card instruction data, and enabled nonempty lore entries without a usable destination. Lore warnings group unavailable entries and show up to three names. Each warning opens the relevant saved library editor; leaving changed settings requires an explicit discard choice. Failed diagnostic requests show an error and an explicit retry. Aborted/superseded responses cannot populate another selection's list.

Deliberate omissions remain advisory and saveable. No keyword match, conditional activation timing and token-cap exclusion are request-specific outcomes shown in Prompt peek, rather than configuration warnings. Malformed actively consumed card data blocks generation with a correction message.

Prompt peek retains the resolved source field and card/fallback attribution for the two markers, and depth/role for notes. These labels are local inspection metadata, excluded from provider bodies.

## Verification scope

`tests/card-instructions.test.ts` covers preserved legacy/V2/V3 data, export overlays, explicit clearing, fallback and nonrecursive macros, disabled/missing markers, malformed data, marker uniqueness, depth and role boundaries, lore ordering, empty/managed/recent history, exact budgeting and structural diagnostics. `tests/card-instructions-persistence.test.ts` uses real temporary SQLite and authenticated server routes for restart preservation, immutable requests, revision/no-op behavior, rollback, exact-command retry, duplication, active-operation restrictions, credential exclusion and rejection before provider calls.

`tests/browser/prompt-card-instructions.spec.ts` exercises editing, Messages permission, marker creation/reordering, warning counts and unsaved selections, links to editors, failed-save retry, export, Prompt peek and exact mock-provider input. Screenshots cover desktop and phone-sized warnings/editing; these checks do not establish actual phone behavior or real-model instruction compliance.

Primary references: [Character Card V2 instruction fields and original macro](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md), [SillyTavern Character's Note](https://docs.sillytavern.app/usage/core-concepts/characterdesign/). Chat-level [Author’s notes](AUTHOR_NOTE.md) are implemented separately. Frequency controls, scripts and additional macros remain outside this implementation.
