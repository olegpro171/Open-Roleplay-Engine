# Imports, prompt content and presentation contracts

Agent reference for supported interchange and input transformations. Preserve supported round trips and inactive metadata without claiming full external-engine compliance. Use core/shared parsers at trust boundaries; do not make behavior depend on UI language. Memory rules are in [CONTEXT.md](CONTEXT.md); persistence/portable files are in [DATA.md](DATA.md).

## Cards, personas and transcript interchange

Import basic V1/V2/V3 character JSON or PNG metadata. Prefer `ccv3` over `chara` regardless of chunk order; support bounded compressed/uncompressed PNG text parsing. Preserve original unsupported fields and V3 export format without executing assets, scripts, remote includes or arbitrary macros. Editable fields include name, description, personality, scenario, example dialogue, primary/alternate greetings and separately authorized instruction fields. Supported linked lorebook edits overlay exported metadata. Export is JSON; updated artwork-bearing PNG export and CHARX are not implemented. CHARX export and opaque preservation of unsupported package contents are outside the accepted scope. Any later CHARX import needs separately authorized bounded extraction of ORE-compatible fields with an import report, not activation/preservation of an arbitrary asset package.

Primary and alternate greetings resolve names once at chat creation, skip blanks and preserve duplicates/order as variants of one completed opening turn. Optional normalized `alternate_greetings` takes precedence over preserved source metadata, including explicit empty arrays. Omitted old-client edits preserve existing alternatives. Up to 1,000 strings of 100,000 characters each are accepted. Malformed preserved values survive unrelated edits/exports but require explicit clearing/replacement before new-chat use. Exposing unchanged legacy fields is not a prompt-bearing edit. Creation/variants commit together; allocate distinct provenance for distinct saved text.

Persona imports read SillyTavern backup JSON and basic name/description JSON; compatible export contains those fields only. Local Title / comment and speech colors never enter compatible exports or prompt text. Title / comment trims, is single-line, at most 200 characters, and empty clears it. Speech colors are opaque six-digit hex normalized to lowercase; null clears and omitted old-client fields preserve. Metadata-only saves do not advance prompt-source revisions or reset lore. Character/Persona names, not display comments, resolve macros and label transcript speakers.

JSONL import reads active `mes` and `is_user` in order; reject unsupported system/group shapes. Never import foreign memories, alternate swipes or compaction exclusions as active ORE state. Pair ordinary exchanges, preserving same-speaker entries as separate whole turns with an empty opposite part. Only final unmatched user input is pending; assistant openings/historical user-only turns are complete. Preview counts and revision-check whole-history replacement transactionally. Transcript sources remain literal/read-only; byte/turn limits are enforced by the established importer and shared command schema.

## Card instructions

### System and post-history markers

**Card system prompt** reads `system_prompt`. **Card post-history instructions** reads `post_history_instructions`. Each marker has its own role, position, enabled state and optional fallback text. At most one enabled marker of each type is supported. The post-history name describes its normal position; the preset can deliberately place it elsewhere.

A nonblank card field replaces that marker's fallback. An absent/blank field, including a missing character, uses its fallback. Empty resolved content contributes no message. Other enabled preset blocks always remain included.

Case-insensitive `{{original}}` in either card field inserts that marker's fallback. `{{user}}` and `{{char}}` resolve once in both sources. The substitution is nonrecursive: fallback text and inserted names cannot execute additional macros; `{{original}}` elsewhere remains literal. Other macros remain literal. No general template engine is enabled.

The factory/new-prompt layout is Card system prompt → Character → Persona → Summary → Messages → Card post-history instructions. The system marker's fallback is the former Instructions text; the closing fallback is empty. Messages permits character depth injection in new templates. Restore original explicitly installs this layout. Existing saved presets and older prompt imports keep their blocks and injection permissions; missing permission means off. New chats selecting an existing saved preset inherit that preset's behavior.

### Character depth note

Messages exposes **Allow character depth prompt injection**. Injection requires an enabled Messages marker with this option checked. The selected card supplies note text, depth and role from the SillyTavern `extensions.depth_prompt` object (`prompt`, `depth`, `role`). V2/V3 read nested `data.extensions`; legacy cards read root `extensions`. Missing depth defaults to 2; missing role defaults to system. Supported roles are system/user/assistant; depth is an integer from 0 through 1,000. Note text and each instruction field are limited to 100,000 characters when consumed or edited.

Depth counts outgoing nonblank original history messages, including a pending user message or unsent preview input. Summaries, lore entries and the note itself do not count. Depth 0 follows the newest eligible message; depth 1 precedes it; excessive depth clamps before the oldest included eligible message. An enabled but empty Messages expansion still provides an insertion point. Missing/disabled Messages provides none.

Lore and character notes use the same history insertion helper. At a shared insertion point, admitted lore retains its established order and the character note follows. All instruction/injection framing and content are counted before selecting a recent whole-turn suffix with Summary disabled. Managed mode uses the committed verbatim tail. Complete assembled input remains subject to target and physical limits; notes are never dropped to make it fit.

Injection creates no stored turn, changes no coverage/cutoff, and never becomes a summary source. Extraction, promotion and repair continue to use their separate prompts. Editing card instructions changes future roleplay input without making existing narrative memories stale. Existing generation/preparation ownership and shared-library revision guards apply.

### Editing and preservation

Character editor's **Card instructions** disclosure exposes both instruction fields plus note text/depth/role. Shared contracts keep edited fields optional. Readers use explicit normalized values first, falling back to preserved import metadata for older cards; explicit empty values clear the effective field. No reimport or schema migration is required.

Card imports continue retaining their exact source metadata. Unrelated extensions and extra properties in a valid depth-note object survive export. Edited note fields are overlaid into `extensions.depth_prompt`, never exported as an ORE-only top-level depth field. Omitted older-client writes preserve already edited instruction fields. Materializing identical preserved values does not advance character/chat source revisions. Duplication copies instructions through the existing atomic character command.

Malformed preserved fields remain intact on unrelated saves and exports. The editor identifies invalid values and offers explicit clearing. Replacing a note also repairs a malformed extensions container on export; the editor identifies that consequence before clearing. Unrelated exports keep the malformed container intact. A malformed field consumed by an enabled marker or permitted note fails before a provider call. Disabling its insertion preserves the metadata without consuming it. Failed or uncertain saves retain the draft/frozen command and use the existing Retry same save workflow. Saved request bodies and earlier summaries remain immutable.

### Configuration warnings

Chat Settings lists structural warnings for the selected character, preset and lorebook, including unsaved selection changes. Story's Chat settings button shows the count for saved selections. Server diagnostics use the same field readers and lore destination/directive-fallback resolution as generation; they do not scan keywords, advance lore state or call models.

Warnings identify nonempty card instructions whose markers are unavailable, depth notes whose Messages permission is unavailable, malformed card instruction data, and enabled nonempty lore entries without a usable destination. Lore warnings group unavailable entries and show up to three names. Each warning opens the relevant saved library editor; leaving changed settings requires an explicit discard choice. Failed diagnostic requests show an error and an explicit retry. Aborted/superseded responses cannot populate another selection's list.

Deliberate omissions remain advisory and saveable. No keyword match, conditional activation timing and token-cap exclusion are request-specific outcomes shown in Prompt peek, rather than configuration warnings. Malformed actively consumed card data blocks generation with a correction message.

Prompt peek retains the resolved source field and card/fallback attribution for the two markers, and depth/role for notes. These labels are local inspection metadata, excluded from provider bodies.

## Lorebooks

### Records and workflows

A book is an independent library record with stable entry identities. Book revisions include entry edits and reordering. A character may select one default book. A new chat resolves an omitted selection from that default; explicit null means None. Existing chats with no field resolve to None. Omitted update fields preserve the saved selection, including through the legacy settings API. Changing an existing chat's character preserves its book selection. Duplicating a character shares its default; duplicating/importing a book creates independent identities. Names never identify or merge records.

Character JSON/PNG import validates the embedded book and saves character, independent book and link in one transaction. An absent or explicitly null `character_book` creates no book or link; an empty valid book does. Other malformed book values reject the import without partial records. Older saved cards expose explicit extraction only when a non-null embedded book exists; repeated extraction while linked returns the existing book. Stale commands fail before writes. Standalone preview is read-only, then an explicit import command commits the reviewed data. Durable identities make lost-acknowledgement retries idempotent; a new identity intentionally imports another copy.

The linked library book is authoritative. Character export receives that book explicitly and embeds current supported edits plus preserved metadata. Choosing None on a character suppresses its preserved raw embedded book in future exports. A chat override does not affect character export. Books linked by any character or selected by any chat cannot be deleted; unlinking a character never deletes a book.

Formats are detected structurally: standard V2 array books, V3 `lorebook_v3` envelopes, World Info entry maps and unambiguous legacy arrays. Conflicting standard/legacy shapes fail. Original external IDs, source order, optional-field absence, unknown fields, envelopes and extensions are retained separately from normalized policy. Edited supported fields overlay that metadata. Normalized local IDs, revisions, relation IDs, commands, requests and state are never exported as external fields. New books export a V3 envelope; imported books retain their format. Explicit conversion is supported by the core adapter; the interface exports the retained format.

### Activation and placement

New local books use scan depth 4, cap 2,048 and recursion off. Optional absent source settings use those effective defaults without fabricating source fields on export. Eligible scan input is original nonblank user/assistant messages in chronological role order, including copied greetings and pending input. Incomplete assistant output, fixed prompts and summaries are excluded. A draft replaces hypothetical input for that preview and is counted once. Archived originals remain eligible. Depth counts messages, not turns; zero scans no originals. Message boundaries are preserved.

Literal keys use NFC normalization and locale-independent Unicode lowercase unless case-sensitive matching is requested. They use substring matching without implicit word boundaries or punctuation-based regex inference. Only the existing one-pass `{{user}}`/`{{char}}` name resolver runs on lore prose and keys. Other macros remain literal with notices. Stored/imported text is not rewritten by activation.

Primary keys use any-match. Selective literal entries require any secondary key as well. Constants bypass keywords, with V3's explicit regex precedence: regex mode ignores constant and standard secondary/exclusion keys. Repeated additional-key directives form separate required groups. Disabled and empty entries never insert. Invalid regex yields a nonmatching entry with a diagnostic; timeout/resource failures fail the attempt before transport.

Admission order is descending priority, constant-first among ties, ascending insertion order, then source order. Final placement order is insertion order then source order. Each admitted entry is a separate message and consumes its fully resolved content, role and framing against the cap. Consider smaller lower-ranked entries after an oversized exclusion. Constants obey the cap. Recursion discovers only from admitted, actually placeable prose; prior admissions remain selected and cycles cannot insert an identity twice. Safety-limit failures are explicit.

| Lore destination | Automatic anchor |
| --- | --- |
| Before/after Character | Before the first / after the last enabled nonempty character source in preset order. |
| Before/after description, after personality/scenario | The first included nonempty corresponding field, separate or checked within Character. |
| In history | Depth insertion inside the enabled Messages expansion. |

Selecting a book authorizes its eligible insertions; None disables lore. The preset controls base sources and the book places conditional entries relative to them. Lore defaults to system; supported entry/decorator roles override it. Character always expands checked Name, Description, Personality, Scenario and Example dialogue fields as separate messages in fixed order with the marker role, just like adjacent individual field markers. Empty/unchecked fields cannot anchor lore. Prompt peek shows those messages and any interleaved field lore in the flat assembled-prompt list, using the Lore color for inserted entries. Its separate Lore inspection disclosure remembers its open/closed state in this browser. No extra lore markers are needed. Card-specific depth notes use the same history placement helper when permitted under Messages; lore precedes the character note at a shared depth. Chat Settings reports enabled nonempty entries whose destinations are structurally unavailable. See [card instructions](#card-instructions).

History depth counts outgoing eligible nonblank original messages: zero follows the newest, one precedes it, and excessive depth clamps before the oldest. Whitespace-only historical parts do not affect lore depth. Whole stored turns remain the unit of history budgeting and coverage. Depth never creates a stored turn, cuts text or changes the saved cutoff. There is no assistant-prefill feature. Missing destinations exclude entries with diagnostics before cap admission/recursion. In this profile, missing Messages does not implicitly redirect depth entries to character placement. Explicit decorator fallback chains may still choose another available supported destination; they cannot restore an unchecked/missing source.

### V3 decorator matrix

Control lines and decorator-adjacent newlines are removed from model-facing prose, including invalid/unknown directives and fallback lines. They remain in saved/exported content. Fallback chains are processed in order; the first supported, valid and applicable directive wins. First occurrence of each directive wins except repeatable additional-key groups.

| Directive | Behavior |
| --- | --- |
| `activate_only_after`, `activate_only_every` | Count completed original nonblank assistant messages, including a copied greeting. |
| `keep_activate_after_match`, `dont_activate_after_match` | Durable state after two successful prior admissions, following the accepted literal reading of “more than once”. |
| `depth` | Authorized history insertion; negative depths within the numeric safety bound normalize to zero. A valid position takes precedence. |
| `role` | system/user/assistant within an enabled destination. |
| `scan_depth` | Override the book's original-message scan depth. |
| `position` | before_desc/after_desc/personality/scenario at the first eligible active field. Unavailable anchors consider fallback. |
| `ignore_on_max_context` | Bounded preliminary pressure exclusion, then frozen results. |
| `additional_keys` | Repeated required any-match groups; regex follows explicit regex mode. |
| `exclude_keys` | Literal exclusion; ignored in regex mode. |
| `dont_activate`, `activate` | Explicit activation controls. Disabled/empty/destination/cap and reached don't-after-match gates remain binding; activate defeats don't-activate, which otherwise defeats keep. Keep/activate bypass ordinary keyword/count filters. |
| `instruct_depth`, `reverse_depth`, `reverse_instruct_depth`, `instruct_scan_depth` | Inactive in this chat environment; fallbacks remain eligible. |
| `is_greeting`, `is_user_icon`, `disable_ui_prompt` | Inactive: historical greeting indexes, asset selection and card prompt overrides are unavailable. Fallbacks remain eligible. |
| Unknown/invalid directives | Preserve inactive, diagnose, strip from prose and consider fallback. |

The upstream prose/type conflict for secondary keys is resolved using its typed array form. Reverse-depth applicability follows the explicit instruction to ignore it in chat. Upstream references to an undefined `after` directive do not add an ORE directive. General V3 macros, nickname behavior and other whole-card features are outside this profile.

### World Info matrix

| Fields | Treatment |
| --- | --- |
| entries array/map, UID/map key | Adapt source order, preserve external identity, create fresh local IDs. |
| key/keysecondary, content, name/comment, constant, selective, disable, order, priority | Map to normalized fields; names/comments remain human-only. Standard primary-plus-any-secondary matching applies. |
| position 0/1/4, role, depth, caseSensitive, scanDepth, explicit useRegex/use_regex | Map bounded before/after/history placement and matching settings. |
| Other selectiveLogic or positions | Preserve unsupported behavior with notices. Unsupported selective logic uses the standard secondary condition; unsupported positions use after-character placement. These mappings are shown in compatibility notices. |
| Probability/useProbability, groups/weights, sticky/cooldown/delay, vectorized/whole-word matching, recursion overrides, outlets, author-note/example-message behavior | Preserve inactive and report; no corresponding engine feature is executed. |
| Unknown fields/extensions | Preserve inactive and report. |
| Invalid supported types/limits, conflicting aliases or ambiguous shapes | Reject; never truncate or silently replace malformed values. |

This is interoperability with explicit supported mappings, not complete SillyTavern engine compatibility. The per-format adapter preserves unsupported source values while normalized supported behavior remains inspectable/editable.

### Budgets and operation state

`resolveRequestLore` resolves from the complete original scan input before context planning. The first tentative request uses the current committed managed representation. Pressure means input above the smaller of target and physical input capacity, or completed history being excluded to fit in recent-history mode. Under pressure, `ignore_on_max_context` entries become ineligible and admission/recursion recomputes once from the same original input. Freeze that second result; otherwise freeze the first.

Generation/preparation persist the frozen resolution with their operation. Required-input checks, alternate memory representations, saved replacement reuse, manual reselection and commit-time savings use it explicitly. They may remeasure placement/framing, but never rescan reduced history. Final admitted lore is required fixed input. If it plus other required input cannot fit, fail and let the user change settings/content. There is no alternating lore/history-dropping loop. Summary-off mode budgets lore before selecting a contiguous newest suffix of whole turns. Summary-enabled mode keeps existing fixed batches, residual/protected tails and correction/reuse policies.

Live lore never enters extraction, promotion or repair model requests. Editing it changes future roleplay input/budgets without invalidating summaries or rewriting historical requests.

Only successful roleplay completion commits admitted-entry match state, atomically with the response. Previews/plans/preparation, failures, cancellation, interruption and duplicate commands cannot advance it. Each chat/book retains independent state across switches. Semantic entry/settings edits advance affected entry activation revisions and clear their state immediately, including when later reverted; renames/human comments preserve it. Original transcript edits/deletion/replacement and selected character/persona/name changes reset the chat epoch. Prompt/Connection/target changes, Clear memory and summary edits preserve past-match state. No historical paid requests are replayed to manufacture matches.

Async commits recheck operation ownership, book revision/selection and captured epoch/state. Shared edits are blocked during response/preparation work and affected chats advance revisions. Late cancelled/superseded results cannot commit. Explicit repair regeneration captures current lore for the new attempt; approval continuing an untouched repair preserves its existing operation context. Shutdown cancels preflight work before it can create a new job. Restart marks interrupted paid work and never repeats it automatically.

An unfinished operation retaining an old lore-control resolution cannot assemble a new request with it. Regenerate the repair or start preparation again to capture current destinations; approved progress and historical request inspection remain available. No paid work repeats automatically.

### Bounds, inspection and verification

Source JSON: 5 MB; normalized storage: 16 million UTF-16 code units (allows retained root/entry metadata plus editable fields). Character JSON files remain 2 MB; PNG cards allow 10 MB with independent 2 MB embedded-metadata bounds (see [pictures](COMPATIBILITY.md#character-pictures)). Books: 2,000 entries; content/comment: 100,000 characters; key groups: 64 keys of at most 2,000 characters; scan/depth controls: 0–1,000. Metadata nesting is at most 100. Parsing never truncates source text/fields.

Per resolution: at most 20 million scanned original characters, 200 million literal character-by-key work units, 20 million regex work units, 4,096 regex tasks, 32 recursion rounds and 256 decorator lines per entry. Exceeding a work bound is actionable failure before transport. Regex workers use built-in Node isolation with two concurrent workers, 32 queued tasks, resource limits, 500 ms task execution and a shared five-second matcher deadline including queue wait. Cancellation/timeout terminates affected workers; the pool can accept later work. No external regex service/dependency is introduced.

Compatibility previews bound detailed notices and report omitted counts. Lore inspection pages outcomes. Routine chat refreshes omit full books/state and detailed historical lore reports; selecting a saved request fetches immutable details on demand. Current previews include hypothetical drafts and are guarded against stale completion. Provider messages are the final authority; provenance stays outside the provider body. Credentials are excluded from all ordinary inspection/export paths.

Literal key editors split commas and line breaks together, trimming/ignoring empty separators. Regex mode keeps one pattern per line so pattern commas remain literal. Saved/imported arrays retain boundaries until explicitly edited.

## Chat Author's notes

Each chat owns an independent note, separate from character cards and reusable presets. Open **Chat details → Author’s note**, directly below **Inspect memory**. The popup uses the Yandex TagOutline icon, a multiline textbox, depth and the shared custom role dropdown. New/older chats without a saved note start with empty text, depth 2 and System role. Text is limited to 100,000 characters; depth is an integer from 0 through 1,000. System, User and Assistant roles are supported. Only valid depths save; leaving an invalid depth field restores its last valid value. The role menu stays inside the modal; Escape closes an open menu before closing the popup.

### Placement and input

An enabled Messages marker supplies the insertion boundary, including when no history is included. Missing/disabled Messages omits the note and produces a configuration/preview warning. Character depth permission does not govern this chat-owned note. Empty/whitespace-only text sends nothing and preserves the selected depth and role.

Depth 0 follows the newest eligible outgoing history message; depth 1 precedes it; depth 2 precedes the last two. Only nonblank original outgoing history messages count, including pending user input or unsent preview input. Summaries, character instructions, lore and notes do not count. Excessive depth clamps before the oldest eligible included history message. At a shared insertion point, all other injections precede the Author’s note. Depth 0 remains inside Messages, before blocks following that marker. No final-prompt placement is implemented.

The existing one-pass `{{user}}` and `{{char}}` replacements apply, with the same fallback names and model-text normalization as other prompt text. `{{original}}` has no special meaning here. Full message framing and note text count in generation, previews and context planning. With Summary disabled, reserve the note before choosing the newest contiguous suffix of whole turns. Never discard it to fit a budget.

The note is prompt content in Prompt peek and retained request inspection. It creates no transcript turn, does not change managed coverage, and is excluded from extraction/promotion/repair inputs. Editing it leaves summaries and old requests intact, and never starts automatic preparation merely because it was edited. Normal Send/post-response preparation rules use the complete resulting input.

### Saving and recovery

Valid edits save immediately without a Save button. Closing with ×, Escape or outside the popup retains changes and does not cancel an accepted save. Response and memory work disable editing; server writes independently enforce per-chat operation ownership and revisions. Work in unrelated chats remains independent.

Rapid edits serialize. Competing writes reconcile only the locally edited fields. A successful save updates only the note and chat revision. Sending, response retry and regeneration wait for unresolved note changes. Ordinary saves show no transient status; after one second a delay notice appears. Requests time out after 15 seconds, release the pending request state, retain the edits and expose Retry. Recovery remains available in Story after closing the popup. Retry reads the server first, so a committed write with a lost acknowledgement can unlock sending without another mutation. A queued revert remains pending after an uncertain write, even when its text equals the older acknowledged value; reconciliation must establish the actual server state first. Memory cancellation remains available while a note needs recovery.

Explicit unsaved field changes, including reversions, are stored synchronously in browser storage under separate dataset-epoch/chat keys. Reload restores locally edited fields over current saved state and resumes ordinary autosave when editing is permitted. These recovery copies are browser/device-local and subject to browser storage availability. A storage failure asks the user to keep the page open or copy the note until saving succeeds. Server-confirmed notes are durable and part of ordinary chat backups; older records/settings writes without a note remain compatible without a migration or backfill. Switching chats never applies a delayed response or draft to the newly selected chat. An acknowledged note retires any superseded transcript request together with its loading state, so future refreshes and response completion remain available.

## Local character tags

Tags are an owner-wide catalog independent of embedded card tags. Identity is trimmed NFC plus locale-independent Unicode lowercase; preserve internal spaces, punctuation, accents/width differences. Existing catalog spelling wins on import, otherwise first source spelling wins. Case-only renames are allowed; collisions fail rather than merge. Stable IDs survive rename; deleting a tag removes assignments after usage confirmation, not characters. Character deletion retains unused catalog entries.

Embedded analysis uses authoritative nested V2/V3 data, otherwise legacy root arrays. Preserve malformed/unsupported metadata with notices; a comma inside a valid tag string is part of one name. Import review defaults to All in the UI; omitted API policy means None. All creates every eligible missing tag atomically, Existing assigns only reviewed catalog matches, None assigns nothing. Overlong candidates block All without truncation. Apply reviewed tags on an existing character is explicitly additive and preserves unsaved character text. Duplication copies assignments using the shared catalog. Local organization never rewrites embedded export tags, model input, memory or lore.

Character/book/link/new tags/assignments/pictures/command receipt save together after reviewed library revision and idle checks. Catalog changes require renewed review. Uncertain acknowledgements retain frozen source/policy/ID for exact explicit retry; no automatic resend. Legacy fingerprints remain readable: omitted/explicit None are equivalent, pre-tags fingerprints replay only None, and absent old reports mean unavailable. Revision is a precondition, not part of the payload fingerprint. Replay after deletion returns its recorded result without recreating data.

Filters match all selected local tags (AND), include untagged items when none selected, survive edits/imports/refresh, and clear when leaving Characters. Renames retain selections; authoritative deletion prunes them. Popup outside clicks only dismiss, never activating/focusing controls beneath; outside scrolling stays available without dismissal. Mobile up to 800px detaches it to the workspace top-right. Search reserves current chooser/results height to prevent scroll clamping. Manage tags retains character drafts, blocks close while saving and advances a captured editor revision only when all dependencies (including picture) still match. Organization-only writes update cache/dates without prompt-source mutation; no-ops retain revisions.

| Bound | Value |
| --- | --- |
| Local name | 100 UTF-16 units after trim/NFC |
| Catalog / assignments per Character | 2,000 / 128 unique |
| Raw embedded array / unique analyzed candidates | 4,096 / 1,024 |
| Total embedded strings | 500,000 UTF-16 units |
| Detailed notices / chooser pages | 50 plus omitted count / 50 items |

## Character pictures

Pictures are separate immutable originals/previews with independent Character crop/thumbnail associations; duplication can share original bytes but cannot couple crop edits. No Persona picture/background/remote-asset system is implemented. Cropped portraits appear in Character/Chats libraries, Character selectors and chat sidebars. Library placeholders are independent of the chat portrait visibility setting. Clicking a chat portrait opens the authenticated original with centered fit and Close/Escape/background dismissal.

Manual PNG/JPEG/WebP replacement validates before replacing the recoverable editor draft. Crop uses normalized oriented geometry v1, integer-rounded square pixels and 1×–4× zoom. Use crop accepts a draft; Cancel/Escape restores it; editor Save commits text/tags/picture together. Keep original bytes for recrop/concurrent replacement recovery, not repeated downloads while dragging. Stale saves retain local image/crop while explicitly adopting saved text/tags; exact uncertain-save retries freeze the whole command. Closing/reloading does not persist picture drafts.

Image-bearing PNG card import validates metadata before art, defaults to centered crop, and blocks the UI commit if art is invalid. No Import without picture UI exists; legacy explicit API modes/receipts remain compatible. Bound metadata extraction/hash and receipt lookup precede strict decode so historical successful receipts remain replayable after stricter decoder changes or deletion. A legacy receipt never attaches newly supplied art. New fingerprints include original digest and effective picture policy, excluding derived encoding versions.

Pinned sharp validates signature/decoder, applies EXIF orientation, converts sRGB and produces alpha-preserving PNG previews/thumbnails from original pixels. Originals remain exact bytes privately. WebP uses frame zero; APNG uses the IDAT first frame and rejects containers whose default is outside the animation. At most 256 frames are accepted. Renditions strip metadata. Low resolution is a hint, not rejection.

| Bound | Value |
| --- | --- |
| Source/image-bearing PNG card | 10,000,000 bytes |
| JSON / decoded embedded JSON | 2,000,000 bytes |
| PNG metadata scan | 20,000 chunks; 79-byte keyword bound |
| Relevant/expanded metadata before base64 decode | Independently 2,000,000 bytes |
| Decoded first frame / oriented edge | 40,000,000 pixels / 16,384 pixels |
| Thumbnail | 320×320 PNG, compression 6, at most 600,000 bytes |
| Preview | At most 1,600px edge without enlargement; PNG at most 12,000,000 bytes |
| Native processing | Two processes, eight queued; 15 seconds including wait |
| Upload base64 / combined save envelope | 13,333,336 characters / 30,000,000 bytes; field bounds still apply |

Each native task uses one libvips thread, no sharp cache, 256 MiB V8 heap; native memory is not capped by that heap. Cancellation/timeout kills the child and frees its slot only on exit. Preview disconnect cancels work; submitted saves may finish and need receipt reconciliation. Process decoding outside write transactions. Check picture/library/global-idle preconditions at commit and clean only proven unreferenced assets. Picture-only saves advance picture/cache metadata without changing prompt sources, lore or historical input. Auth precedes resource existence/304; versioned raster resources use private revalidation/ETags and nosniff, originals no-store/safe attachment names. No public upload directory or filesystem URL is created.

## Markdown and speech

Story uses one Markdown renderer for greetings, user input, assistant responses, selected response versions and streamed/failed/cancelled partial text. Emphasis, strong emphasis, headings, ordered/unordered lists, blockquotes, inline/fenced code and the GitHub-flavored table, strikethrough and task-list extensions are supported. Soft line breaks remain visible. Code and tables scroll horizontally inside the conversation when needed.

Editors and persistence keep the original source. Speech/prose styling is a display transformation; Markdown images additionally have the model-input exclusion described below. Lore scanning retains the original transcript, and saved historical requests stay immutable. Existing records need no migration. Raw HTML is displayed literally and never executed. Links accept HTTP(S), mailto and same-page fragments, with external destinations opening in a separate tab without opener/referrer access. Relative and unsafe schemes are inert. Markdown images with absolute HTTP(S) destinations load inline, including empty-alt and reference-style images. They load lazily, fit the message width without changing aspect ratio, and send no referrer. Blocked schemes, relative URLs and failed loads display `[Image: alt text]` (or the localized generic image label). Raw HTML images remain literal text. Remote resources load directly in the browser; no server proxy or saved image copy is introduced. Their continued availability and browser mixed-content restrictions still apply. Turn-size observation keeps the latest reply in view when an image finishes loading, while retaining an earlier reading position.

### Images and model input

Before assembling future model requests, the shared core parser removes rendered Markdown images, their alt text and destinations. Image-only links and definitions used only by images are also removed; definitions shared with ordinary text links stay available to those links. Escaped syntax, code examples and raw HTML remain literal prose. Surrounding source Markdown is preserved without serialization. Editors, stored greetings, alternate replies, exports and backups retain the original image syntax. An image-only part contributes no outgoing message, but its turn retains its identity, completion, coverage and compaction membership.

The same filtering applies to resolved prompt/card/persona/lore text and memory, and to summary extraction, promotion, earlier context and repair before JSON encoding. Token budgets measure the filtered outgoing input. First-layer requests retain original source baselines as local provenance outside the provider body, so repairs still compare the actual saved source revisions. Saved summaries and historical requests are never rewritten; legacy summaries can still contain prose previously derived from images. Image edits retain ordinary source-revision/staleness rules.

### Quoted speech

Balanced `"…"`, `“…”`, `«…»` and `„…“` spans are bold and use the selected speech color, including the quotation marks. Nested pairs are included in the outer span. Straight and curly single quotes never start or end a quotation, including leading apostrophes such as `'em`. This recognizes quoted text, including quotations that are not literally spoken dialogue; it does not infer narrative meaning. Unclosed streamed quotations remain ordinary text until their closing mark arrives.

Speech styling covers complete detected spans, including em dashes (`—`) inside quotations and opening/resuming dialogue dashes. Dashes separating speech from recognized author clauses remain plain because they fall outside those spans.

Detection runs on inline prose after Markdown parsing. A quotation may cross emphasis, strong emphasis or link-label boundaries. Code, images, raw HTML and other non-prose nodes form barriers; code contents and link destinations are never restyled. Parsing is local to an inline block, so a quotation does not extend across blank paragraphs, table cells or unrelated list items.

### Optional Russian dialogue

`russian-dialogue.ts` is independent of the quotation detector. Its deliberately limited heuristic:

1. Requires an em dash followed by horizontal whitespace at the start of a line, allowing indentation and nonbreaking spaces. An em dash inside ordinary narration does not activate dialogue mode.
2. Uses the opening dash to identify speech. Spaced em dashes inside balanced quotations do not divide its detected coverage; the opening dash and internal dashes receive speech styling.
3. Checks at most twelve words of the first clause after a separating dash, stopping at sentence punctuation, a colon or a quotation. An explicit vocabulary recognizes common attribution/action verbs, including inflected `передразнила`, `буркнула`, `пробормотали` and present-tense `отвечает`. A later sentence or quoted phrase cannot supply an attribution for an earlier spoken aside.
4. After a speech punctuation boundary, also recognizes third-person action/body-language clauses with a past-tense predicate: `она отшатнулась`, `у Аири голос сорвался`, `Щёки у неё горели`, or `её голос дрожал`. This fallback requires an initial third-person pronoun or body/voice subject (including an owner introduced by `у`). First/second-person subject cues such as `у меня` or `руки у тебя` prevent the fallback from consuming the speaker's own aside. The separating dash and the entire author clause, including subsequent narrative sentences, stay plain.
5. Resumes speech at a following spaced em dash when the author clause ends with a comma, colon or sentence punctuation. The resuming dash receives speech styling. Other speech punctuation remains styled; whitespace before an author separator stays plain.
6. Resets at each line. A line containing code or another non-prose barrier is left to quotation-only detection.

This is a bounded word-pattern heuristic, not a Russian grammar parser. Unfamiliar attributions, unusual punctuation or narration resembling speech can produce missed/incorrect boundaries. Body-language clauses need a recognized subject/past-tense predicate; line-wrapped em-dash dialogue is not inferred across separate lines. No model or language service is used.

Set `defaultSpeechOptions.russianDialogue` to `false` in `src/web/ChatMarkdown.tsx` to disable this detector while retaining quotes. The component also accepts independent `speech` options for tests/future controls. The combiner in `direct-speech.ts` is the only integration point for removing the Russian module. Each Character and Persona editor has a **Speech color** selector. Story uses the selected character’s color for assistant speech and the selected persona’s color for user speech, including greetings, response versions and streamed/terminal partial text. Cards start at **Not set**. **Set color** enables an override; **Clear color** removes it when the card is saved. Unset cards and missing selections use the matching default from **Application Settings → Chat appearance**, initially following the theme (light blue `#a8c9f0` in Dark; Character `#343a42` and Persona `#562a0a` in Light). Explicit card colors take precedence over app defaults. Changing a saved color updates existing chat presentation. The renderer sets `--direct-speech-color` separately on each Markdown container; detection remains unchanged.

Colors are optional local library metadata (`speechColor`, opaque six-digit hex; null in a save command clears the saved value), stored in the existing JSON records without a migration or rewrite of older data. Omitted values preserve saved colors in older-client/internal updates. Color-only saves advance the library cache revision while preserving prompt-bearing record revisions, chat revisions, memory, lore and historical requests. Colors never enter prompt sources or compatible character/persona exports. Duplication and application backups retain them. Unsaved colors follow the ordinary editor close, failed-save and conflict handling. Application defaults can follow the active theme (null) or use a saved color override. Dark uses light blue; Light uses `#343a42` for Character and `#562a0a` for Persona. Existing saved colors are preserved; the theme-color actions in Chat appearance explicitly clear app overrides. Character/Persona overrides still take precedence. Application defaults are saved together with a revision check in a private `<database>.appearance.json` sidecar. They update other open windows through existing change notifications, survive restarts and content import/wipe, and are excluded from content backups. Failed writes preserve the prior configuration; malformed files report an error instead of silently resetting defaults. If loading appearance fails, Story remains available with a visible error and Retry, using the last successfully loaded appearance or factory defaults on first load. The appearance editor saves valid changes immediately, retains failed choices with Retry, and automatically reconciles competing revisions without overwriting unrelated fields. App-default color pickers save on valid hex, HSL or palette changes and close without undo; library pickers keep Apply/Cancel.

Text scale applies to both chat prose and the composer, independently of controls/source editors. Appearance/theme/default-color persistence is owned by settings, not transcript revision. Raw imported/model content remains untrusted regardless of display formatting.

## Verification boundaries

Extend existing card/lore/tag/picture/inline-image/author-note suites with temporary real SQLite and mock transport. Check exact outgoing input, preserved inactive metadata, bounds, no-op/isolation, stale writes, rollback, legacy receipts and cancellation/restart. UI layout changes need desktop/phone-sized checks in all shipped themes. Structural round trips and regex/formatting heuristics do not establish external-engine equivalence, semantic relevance, universal speech detection or real-device behavior.
