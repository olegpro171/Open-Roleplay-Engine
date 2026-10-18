# Lorebook contract review

Prepared and accepted 2026-10-18. The user approved the proposed defaults/state/pressure rules and upstream interpretations in this review before dependent implementation. This remains the reviewed contract, not an implementation report; current behavior and verification limits are documented in [LOREBOOKS.md](LOREBOOKS.md). The original implementation brief remains unchanged.

## Integration plan

Implement reusable books and a single selected book per chat through the existing library, selection and import APIs. Keep matching in the core, durable state and atomic imports in persistence, bounded regex execution and operation capture in the server, and editing/inspection in the web interface. Extend the existing tests rather than introducing another application stack.

The principal risk is changing lore while measuring alternative memory representations. Capture the original scan input and resolve lore once before planning, persist the frozen resolution with its operation, and pass it explicitly through planning, saved reuse, reselection, savings validation and final assembly. A later snapshot may update committed memory but cannot rescan lore during that operation. Extraction, promotion and repair keep their existing lore-free inputs.

Generation success commits its admitted-entry state delta together with response completion. Failed/cancelled/interrupted work retains the last committed state and requires an explicit retry. Recheck captured book selection/revision, chat epoch and operation ownership inside the committing transaction. Completed compaction steps remain saved if a later step fails.

## Proposed marker contract

| Marker | Authority and placement |
| --- | --- |
| `lore_before` | Ordinary explicit preset position; authorizes before-character lore and corresponding field-relative placement. |
| `lore_after` | Ordinary explicit preset position; authorizes after-character lore and corresponding field-relative placement. |
| `lore_history` | Authorizes depth placement in the Messages expansion; requires an enabled Messages marker. Its own position does not create a transcript message. |

Allow at most one enabled instance of each. Their configured role is the default; an applicable entry role overrides it. Before/after controls work even without a Character marker. Field-relative placement requires the corresponding active, nonempty field or combined Character source. Use the first eligible field occurrence when character sources repeat, insert each entry once, and leave later occurrences alone. A combined Character block may be segmented only when field-relative lore requires an anchor; no-lore requests retain their original messages exactly.

Missing/disabled controls make their destinations unavailable before cap admission and recursion. Standard fallback chains can select an available supported directive, but cannot bypass a disabled/missing lore control or re-enable Character/Messages. History depth counts outgoing nonempty original messages, with zero after the newest and excessive depth before the oldest; it never changes stored turns or coverage.

The new factory template is Instructions → Lore before Character → Character → Lore after Character → Persona → Summary → Lore in history → Messages. Upgrade only the exact untouched previous factory default; retain custom presets. Empty presets remain saveable.

## Upstream interpretation review

References inspected: [V2](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md), [V3](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md), [World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/).

| Ambiguity | Proposed ORE interpretation |
| --- | --- |
| V3 secondary-key prose describes a comma-separated string while its type declares an array. | Use the typed array for standard books. Reject an invalid standard field; legacy World Info uses an explicit separate adapter. |
| Prior-match directives say “more than once”. | Require two successful prior admissions in the applicable state epoch. Preview/candidates/failures do not count. |
| Several activation directives claim overriding precedence without specifying mutual conflicts. | Disabled/empty/unplaceable/cap rules always apply. A reached don't-activate-after-match gate takes precedence over force activation; explicit activate defeats don't-activate; eligible keep-after-match force defeats ordinary keyword/count filters. Document and test the conflict ordering. |
| V3 reverse-depth descriptions resemble chat placement but explicitly say to ignore them in chat contexts. | Follow the explicit applicability condition, report them inactive, and evaluate their fallback chain. |
| Pressure exclusion does not specify how lore and history should be resolved together. | Use the brief's bounded two-pass preliminary rule, then freeze lore across all alternative memory representations. |
| Missing numeric bounds and regex syntax details. | Enforce explicit server limits; accept JavaScript patterns and slash-delimited flags only when regex is explicitly requested. Literal punctuation stays literal. Match messages separately. Normalize literal matching to NFC and use locale-independent Unicode lowercase for case-insensitive matching; retain stored text unchanged. |

The proposed defaults and state-reconciliation tables in brief §§3/6 are adopted only after user review. In particular, existing chats resolve the absent selection as None, unlinking cannot resurrect raw embedded content, and transcript/name changes start a fresh chat activation epoch without replaying old requests.

## V3 decorator coverage

All decorator lines, including unsupported/invalid ones and their fallback lines, are removed from inserted prose. Preserve original content for editing/export. Process fallback chains in source order; first supported valid directive in a chain wins. First occurrence per directive wins except repeatable additional-key groups.

| Directive | Planned behavior |
| --- | --- |
| `activate_only_after`, `activate_only_every` | Completed original nonempty assistant-message count, including copied greeting; never summary count or partial output. |
| `keep_activate_after_match`, `dont_activate_after_match` | Durable successful-admission state, with semantic fingerprints and epochs. |
| `depth` | Chat placement through enabled history control, with standard position precedence and clamping. Assistant role remains an ordinary message; no prefill feature. |
| `role` | system/user/assistant override within an authorized destination. |
| `scan_depth` | Per-entry eligible original-message window. |
| `position` | before_desc/after_desc/personality/scenario at active field anchors; fallback when unavailable. |
| `ignore_on_max_context` | Preliminary pressure exclusion, followed by frozen recomputed admission/recursion. |
| `additional_keys` | Each repeated group requires a match; regex follows the entry's explicit regex setting. |
| `exclude_keys` | Literal exclusion filter; ignored in regex mode as specified. |
| `dont_activate`, `activate` | Explicit activation controls with documented conflict precedence. |
| `instruct_depth`, `reverse_depth`, `reverse_instruct_depth`, `instruct_scan_depth` | Inactive in this chat-completion environment; fallback chains remain applicable. |
| `is_greeting` | Inactive: existing chats do not record selectable greeting indexes; do not infer historical indexes. |
| `is_user_icon` | Inactive: asset selection is unavailable. |
| `disable_ui_prompt` | Inactive: card prompt overrides are outside scope. |
| Unknown/invalid directives | Preserve, diagnose, strip from prose, then consider fallback. |

## World Info extension matrix

| Input | Planned classification |
| --- | --- |
| Entry object map, external UID, source order | Adapt explicitly; preserve external identity separately from fresh local identities. |
| key/keysecondary, content/comment, constant, disable, order, before/after position | Supported normalized mapping. Comments are human-only. |
| caseSensitive, supported scan depth, role/history depth | Supported bounded mapping. |
| Regex-like key text without explicit regex policy | Preserve literally; do not infer regex semantics from punctuation. Any format-specific inference must be explicit in the adapter and preview. |
| Probability, groups, sticky/cooldown/delay, vectorized activation, whole-word matching, recursion overrides, unsupported selective logic, outlets, author's notes and example-message positions | Preserve inactive with compatibility notices; do not claim engine equivalence. |
| Other unknown fields/extensions | Preserve inactive, never execute. |
| Malformed required fields, invalid typed settings, conflicting/ambiguous shapes, excessive sizes | Reject before mutation; do not truncate or replace invalid values with defaults. |

## Persistence and verification plan

Current schema version is 6. Add version 7, with an idempotent migration registration, atomic exact-factory-prompt upgrade and durable lore command/state/operation storage. Reuse library JSON records for the authoritative book and stable entry identities. Extend chat/character relations, runtime validation, direct saves, legacy settings updates, duplication, deletion checks and affected-chat revision propagation together.

Standalone import uses preview then an explicit durable command identity. Embedded import creates character/book/link together. Extraction checks the current library revision and returns an existing extracted link on repeated commands. No mutation deduplicates by name. Export overlays edited normalized fields onto preserved metadata and receives the currently linked book explicitly.

Verification covers adapters/round trips, deterministic activation and recursion, cap boundaries, marker/decorator precedence, worker timeout/cancellation, real temporary SQLite transactions/state/restart/migration, exact mock-provider requests, frozen lore through reduced-history checks and savings, immutable historical inspection, and desktop/phone-sized browser workflows. Final application handoff requires `npm run check` under the README's supported Node runtime and a full diff review. No active database or real provider credentials are used.
