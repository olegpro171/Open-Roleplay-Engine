# Lorebooks

Implemented for local testing on 2026-10-18 after the user accepted the [brief](LOREBOOK_IMPLEMENTATION_BRIEF.md), its proposed defaults/state/pressure rules, and the upstream interpretations in the [contract review](LOREBOOK_CONTRACT_REVIEW.md). Automated fixtures establish structural behavior; relevance, real-model usefulness and perfect recall are not established.

## Records and workflows

A book is an independent library record with stable entry identities. Book revisions include entry edits and reordering. A character may select one default book. A new chat resolves an omitted selection from that default; explicit null means None. Existing chats with no field resolve to None. Omitted update fields preserve the saved selection, including through the legacy settings API. Changing an existing chat's character preserves its book selection. Duplicating a character shares its default; duplicating/importing a book creates independent identities. Names never identify or merge records.

Character JSON/PNG import validates the embedded book and saves character, independent book and link in one transaction. An absent book creates no record; an empty valid book does. Older saved cards expose explicit extraction; repeated extraction while linked returns the existing book. Stale commands fail before writes. Standalone preview is read-only, then an explicit import command commits the reviewed data. Durable identities make lost-acknowledgement retries idempotent; a new identity intentionally imports another copy.

The linked library book is authoritative. Character export receives that book explicitly and embeds current supported edits plus preserved metadata. Choosing None on a character suppresses its preserved raw embedded book in future exports. A chat override does not affect character export. Books linked by any character or selected by any chat cannot be deleted; unlinking a character never deletes a book.

Formats are detected structurally: standard V2 array books, V3 `lorebook_v3` envelopes, World Info entry maps and unambiguous legacy arrays. Conflicting standard/legacy shapes fail. Original external IDs, source order, optional-field absence, unknown fields, envelopes and extensions are retained separately from normalized policy. Edited supported fields overlay that metadata. Normalized local IDs, revisions, relation IDs, commands, requests and state are never exported as external fields. New books export a V3 envelope; imported books retain their format. Explicit conversion is supported by the core adapter; the interface exports the retained format.

## Activation and placement

New local books use scan depth 4, cap 2,048 and recursion off. Optional absent source settings use those effective defaults without fabricating source fields on export. Eligible scan input is original nonblank user/assistant messages in chronological role order, including copied greetings and pending input. Incomplete assistant output, fixed prompts and summaries are excluded. A draft replaces hypothetical input for that preview and is counted once. Archived originals remain eligible. Depth counts messages, not turns; zero scans no originals. Message boundaries are preserved.

Literal keys use NFC normalization and locale-independent Unicode lowercase unless case-sensitive matching is requested. They use substring matching without implicit word boundaries or punctuation-based regex inference. Only the existing one-pass `{{user}}`/`{{char}}` name resolver runs on lore prose and keys. Other macros remain literal with notices. Stored/imported text is not rewritten by activation.

Primary keys use any-match. Selective literal entries require any secondary key as well. Constants bypass keywords, with V3's explicit regex precedence: regex mode ignores constant and standard secondary/exclusion keys. Repeated additional-key directives form separate required groups. Disabled and empty entries never insert. Invalid regex yields a nonmatching entry with a diagnostic; timeout/resource failures fail the attempt before transport.

Admission order is descending priority, constant-first among ties, ascending insertion order, then source order. Final placement order is insertion order then source order. Each admitted entry is a separate message and consumes its fully resolved content, role and framing against the cap. Consider smaller lower-ranked entries after an oversized exclusion. Constants obey the cap. Recursion discovers only from admitted, actually placeable prose; prior admissions remain selected and cycles cannot insert an identity twice. Safety-limit failures are explicit.

| Prompt control | Authority |
| --- | --- |
| Lore before Character (`lore_before`) | Insert before-character entries at this explicit preset position; authorize before-description anchors. |
| Lore after Character (`lore_after`) | Insert after-character entries at this explicit preset position; authorize after-description/personality/scenario anchors. |
| Lore in history (`lore_history`) | Authorize depth insertion inside the enabled Messages expansion. |

At most one enabled control of each kind is allowed. Controls supply the default role; supported entry/decorator roles override it. Before/after controls do not require Character. Field-relative lore requires a corresponding active nonempty field, either separate or inside Character; only the first eligible repeated source anchors the lore. Personality/scenario lore follows its field. Combined Character text is segmented only when anchored lore requires it. No-lore bodies/layout/estimates retain their original form.

History depth counts outgoing eligible nonblank original messages: zero follows the newest, one precedes it, and excessive depth clamps before the oldest. Whitespace-only historical parts do not affect lore depth. Whole stored turns remain the unit of history budgeting and coverage. Depth never creates a stored turn, cuts text or changes the saved cutoff. There is no assistant-prefill feature. Missing destinations exclude entries before cap admission/recursion; standard depth fallback uses an enabled before/after control. Fallback cannot restore a missing Character/Messages source or bypass prompt authority.

## V3 decorator matrix

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

## World Info matrix

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

## Budgets and operation state

`resolveRequestLore` resolves from the complete original scan input before context planning. The first tentative request uses the current committed managed representation. Pressure means input above the smaller of target and physical input capacity, or completed history being excluded to fit in recent-history mode. Under pressure, `ignore_on_max_context` entries become ineligible and admission/recursion recomputes once from the same original input. Freeze that second result; otherwise freeze the first.

Generation/preparation persist the frozen resolution with their operation. Required-input checks, alternate memory representations, saved replacement reuse, manual reselection and commit-time savings use it explicitly. They may remeasure placement/framing, but never rescan reduced history. Final admitted lore is required fixed input. If it plus other required input cannot fit, fail and let the user change settings/content. There is no alternating lore/history-dropping loop. Summary-off mode budgets lore before selecting a contiguous newest suffix of whole turns. Summary-enabled mode keeps existing fixed batches, residual/protected tails and correction/reuse policies.

Live lore never enters extraction, promotion or repair model requests. Editing it changes future roleplay input/budgets without invalidating summaries or rewriting historical requests.

Only successful roleplay completion commits admitted-entry match state, atomically with the response. Previews/plans/preparation, failures, cancellation, interruption and duplicate commands cannot advance it. Each chat/book retains independent state across switches. Semantic entry/settings edits advance affected entry activation revisions and clear their state immediately, including when later reverted; renames/human comments preserve it. Original transcript edits/deletion/replacement and selected character/persona/name changes reset the chat epoch. Prompt/Connection/target changes, Clear memory and summary edits preserve past-match state. No historical paid requests are replayed to manufacture matches.

Async commits recheck operation ownership, book revision/selection and captured epoch/state. Shared edits are blocked during response/preparation work and affected chats advance revisions. Late cancelled/superseded results cannot commit. Explicit repair regeneration captures current lore for the new attempt; approval continuing an untouched repair preserves its existing operation context. Shutdown cancels preflight work before it can create a new job. Restart marks interrupted paid work and never repeats it automatically.

Schema 7 adds durable lore commands, operation resolution, chat epochs and per-book state under process ownership. Its transaction upgrades only the exact untouched old factory prompt. Existing chat selections, transcript/summary identities, revisions, corrections, credentials and historical requests remain intact. Explicit extraction/selection enables older inactive books. Historical requests without metadata mean unavailable, not an inferred empty activation report.

## Bounds, inspection and verification

Source JSON: 5 MB; normalized storage: 16 million UTF-16 code units (allows retained root/entry metadata plus editable fields). Card files remain 2 MB. Books: 2,000 entries; content/comment: 100,000 characters; key groups: 64 keys of at most 2,000 characters; scan/depth controls: 0–1,000. Metadata nesting is at most 100. Parsing never truncates source text/fields.

Per resolution: at most 20 million scanned original characters, 200 million literal character-by-key work units, 20 million regex work units, 4,096 regex tasks, 32 recursion rounds and 256 decorator lines per entry. Exceeding a work bound is actionable failure before transport. Regex workers use built-in Node isolation with two concurrent workers, 32 queued tasks, resource limits, 500 ms task execution and a shared five-second matcher deadline including queue wait. Cancellation/timeout terminates affected workers; the pool can accept later work. No external regex service/dependency is introduced.

Compatibility previews bound detailed notices and report omitted counts. Lore inspection pages outcomes. Routine chat refreshes omit full books/state and detailed historical lore reports; selecting a saved request fetches immutable details on demand. Current previews include hypothetical drafts and are guarded against stale completion. Provider messages are the final authority; provenance stays outside the provider body. Credentials are excluded from all ordinary inspection/export paths.

Tests use synthetic fixtures, temporary real SQLite and controlled provider behavior. Coverage includes all supported formats, preserved absence/metadata/IDs, atomic import/migration failures, command retry/extraction/link ownership, matching/directives/caps/recursion/placements, frozen reduced-history planning/reuse/savings, worker failure/cancellation/recovery, response/state atomicity/restart and browser editing/import/selection/inspection/conflict recovery at desktop and phone-sized viewports. See README for the full verification command and current manual limits.

Primary references: [V2](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md), [V3](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md), [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/). The assignment and contract review remain separate from this implemented subsystem description.
