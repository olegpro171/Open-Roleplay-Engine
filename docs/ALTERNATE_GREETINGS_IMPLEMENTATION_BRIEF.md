# Alternate greetings: implementation assignment

Prepared: 2026-10-18.

Status: proposed handoff, not implemented behavior. The user redirected the next task from Title / comment to alternate greetings. Title / comment remains deferred; no implementation of it is authorized by this assignment. The current request authorizes preparing instructions only.

## 1. Objective and scope

Make standard character alternate greetings editable, interoperable and usable when starting a story. Provide a clear opening chooser, preserve the copied-opening turn model, and prevent choosing another greeting from rewriting an established conversation.

The user requested this feature as the next character-card task. The detailed policies in section 3 are **proposed defaults**, not previously accepted decisions. Have the coordinator/user accept or amend them when assigning implementation. Do not silently invent a different switching, empty-text or history policy.

Read AGENTS.md, CONCEPTS.md, IMPLEMENTATION.md, README.md, package.json and docs/PICTURES.md, TAGS.md, LOREBOOKS.md and CONTEXT_EDITING.md. Pictures/tags and automatic field-relative lore injection are implemented. Preserve their current behavior and later UI refinements: compact picture rows, description directly below name, tags in editor/filter controls rather than library rows.

In scope: alternate-greeting import/export, authoring, new-chat selection/preview, narrowly guarded opening switches, immutable choice provenance, necessary greeting-conditioned lore support, transactions/recovery and verification. No general response swipes, regeneration variants, conversation branching, random selection, group chats, group-only greetings, new macros, Markdown/HTML renderer or card instruction overrides. No new dependency is needed.

Primary references: [V2 alternate greetings](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md#alternate_greetings), [V3 greeting-index directive](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md#is_greeting), and [SillyTavern greeting UX](https://docs.sillytavern.app/usage/core-concepts/characterdesign/#alternate-greetings). The interchange field is an ordered string array. Index zero identifies the primary greeting; alternates follow at one-based indexes. Preserve unknown metadata. Implement a documented ORE profile rather than claiming all frontend behavior is identical.

## 2. Current behavior and integration points

`first_mes` is active, while `alternate_greetings` exists only in preserved Character.source. Export currently retains that imported array. createChat resolves the primary greeting's name macros once, trims boundary blank lines and inserts an assistant-only completed opening turn when the resolved text is nonempty. An empty primary creates no turn. No greeting-choice index/provenance or durable create-chat receipt is currently stored.

Opening turns already support ordinary edits, whole-turn deletion and compaction. They count toward fixed batches and protected tails. History import adds no greeting. The lore directive `is_greeting` is explicitly unsupported because a reliable selected index is unavailable.

| Area | Integration points |
| --- | --- |
| Contracts | src/shared/library.ts character/selection/save schemas; src/shared/contracts.ts safe chat/inspection state; create-only commands must be separate from Setup updates |
| Import/export | src/core/cards.ts and server card/import analysis; preserve JSON/PNG ccv3 preference, picture mode, tag policy and linked-book export |
| Authoring | src/web/CharacterEditor.tsx combined text/tag/picture drafts, dirty guards, reconciliation and exact-command retry |
| New chat | SelectionFields and New chat in src/web/Libraries.tsx; current selection/revision and character-default-lorebook behavior |
| Story | src/web/App.tsx opening turn display, edit/delete controls and saved-state refresh |
| Persistence | Store.createChat/saveCharacter/duplicateCharacter/begin/editPart/deleteTurn/replaceHistory; short atomic transactions and receipts |
| Lore/context | src/core/lorebook-directives.ts, lorebook.ts, server lore-resolution and frozen operation/inspection contracts |

Trace all callers before editing. Do not simply add another textarea and change createChat's first matching line.

## 3. Proposed product defaults for review

| Topic | Proposed behavior |
| --- | --- |
| Primary opening | Keep first_mes as the default greeting and the default choice for a new chat. |
| Alternates | Ordered plain text; retain duplicates and intentional empty entries. Do not deduplicate by text. |
| Empty selection | Explain No opening text. Create no opening turn, preserving current empty-primary behavior. Never fall back to another greeting automatically. |
| No character | No character greeting chooser or opening. Old no-character create calls retain their behavior. |
| New-chat preview | Show the selected opening resolved using the reviewed character/persona names, with full text available. |
| After creation | Offer a compact Choose opening control while the server says the pristine opening is switchable. Switching requires an explicit commit. |
| Switch source | Use the bounded opening catalog captured for that chat, with its name-resolution inputs, rather than today's edited card. |
| Lock | Permanently lock the special chooser after the first accepted user submission, a manual opening edit/deletion, history replacement, relevant Setup identity change, or saved generation/preparation work begins. |
| Locked story | Keep ordinary transcript editing/deletion and repair behavior. Starting with another greeting requires a new chat; do not rewrite later turns. |
| Old/imported chats | Unknown choice provenance; special switching stays unavailable. Do not infer an index from text. |
| Card edits | Apply to later new chats; copied openings and captured catalogs in existing chats stay unchanged. |
| Shared name changes | A relevant character/persona rename permanently locks switching, but does not erase a known selected index for the same originating character. |
| Setup identity changes | Changing selected character or persona permanently locks switching and invalidates active greeting applicability; changing back does not revive it. Retain historical provenance. |
| Group-only fields | Preserve inactive and export unchanged; do not mix them into single-character alternatives. |
| Character duplication | Copy authored primary/alternate texts in order, retaining current tag/picture/book-link ownership behavior. |
| Lore condition | Support is_greeting for known, applicable choice provenance; keep the previous unsupported/unknown behavior otherwise, with explicit diagnostics. |
| Limits | Starting proposal: 256 alternates, 100,000 characters per entry, 2,000,000 characters aggregate including primary. Validate actual imported/local workloads before finalizing. Never truncate/reorder to fit. |

The switching policy is intentionally narrower than general response swipes. Its lock is durable and monotonic; deleting subsequent turns, clearing their text or clearing memory must never make an established story switchable again. Read-only previews do not lock anything.

## 4. Character authoring, formats and compatibility

Add an Alternate greetings section next to the existing Greeting field, clearly identifying the primary/default separately. Use an indexed list with a short snippet and a single selected editor rather than hundreds of expanded textareas. Provide Add, Duplicate, Remove and Move up/down; optional drag reorder must have keyboard equivalents. Keep selection/focus attached to a draft row identity during reorder; browser array position alone is not a safe editing key.

Numbers describe current order, not permanent identities. Local editor keys must not leak into external arrays. Mark duplicate/empty text clearly without treating it as invalid. Confirm removal when it would discard a nonempty unsaved entry. Full content remains plain text, with the same one-pass macro support and text limits as other greeting text. Do not execute HTML or introduce a new rendering engine.

Save character commits the whole primary/alternate set together with text, tags and any picture mutation. Add alternates to dirty comparisons, open-book/extraction guards, reconciliation displays, frozen save payloads and receipt fingerprints. Failed saves preserve all text, current selected entry, tag and picture/crop drafts. Closing follows existing discard rules. Tag manager/Apply embedded tags must not discard the greeting draft or falsely rebase over another tab's changed character.

Use one authoritative normalized alternate array. Read V2/V3 from nested authoritative data and legacy cards from the root where supported. Preserve ordering, duplicate strings, empty strings, Unicode and internal formatting. Normalize copied text using existing boundary-newline rules; do not destructively trim authored/imported arrays on ordinary read. Validate member types/count/aggregate size before commit. New malformed input fails with indexed diagnostics and no partial character/book/tag/picture writes. Existing malformed preserved metadata must remain readable/exportable with a notice until explicitly corrected; do not make the upgrade destroy or silently invent it.

For existing saved cards, recommend a shared compatibility reader: absent normalized alternatives resolve from the valid preserved source array, while an explicitly saved empty normalized array is authoritative. Omitted fields in older update callers preserve current effective alternatives; they must not clear them through a schema default. New locally created cards without alternatives mean an empty set. If the implementer proposes eager migration instead, get agreement on exact revision/data changes and demonstrate populated upgrade preservation.

Malformed legacy arrays need a distinct unavailable/needs-correction state, not an implicitly authoritative empty array. Unrelated text/tag/picture saves and exports must preserve that raw metadata until the user explicitly corrects or clears alternatives. Do not send a compatibility-reader fallback [] as an authored edit. An old card can still use its valid primary opening with an explanatory notice; malformed alternatives cannot be selected.

Export current authored alternatives over preserved original values. Explicit removal/clearing cannot resurrect an old source array. Keep V2/V3 envelope behavior, source tags, linked-book export and all unrelated fields unchanged; strip internal editor/snapshot IDs. Download original picture continues returning untouched original bytes and may contain old embedded metadata. Updated PNG-card export remains deferred.

## 5. New-chat chooser and preview

Show an Opening section in New chat after the character/persona selections. Default greeting and Alternate 1…N have short snippets; the full selected text is visible in a bounded scrollable preview. With no alternates, avoid a redundant selector but keep the ordinary preview where useful. Empty text gets a clear No opening text state, not a fake assistant message or a failed-generation warning.

Changing character resets the draft choice to that character's default. Changing persona refreshes the preview with that persona's name. Preserve existing default-lorebook prefilling and explicit None choices. Do not filter choices by local tags or introduce portraits inside shared dropdowns as unrelated work.

Use one authoritative pure greeting resolver for preview, creation and permitted switching: selected raw text plus reviewed name inputs, one-pass name substitution, then existing boundary trimming. Unknown macros remain literal. The primary and all alternates stay outside Character prompt-field expansion; only the copied selected opening becomes history.

Add a create-specific schema/command rather than putting writable greeting choice into generic selectionsSchema or legacy saveSettings. Existing callers omitting choice retain default-primary behavior. The new UI supplies a reviewed character identity/revision, chosen standard index and relevant persona/name revisions (or one coherent reviewed library precondition). Reject an out-of-range/stale choice; do not clamp to zero or accidentally select a different text after card reorder.

The UI must explain stale review and preserve its unsent chat title/settings while refreshing choices. Do not silently change the selected opening because a background library refresh occurred. All labels/selection values must identify an actual index in the reviewed set, even when several entries have identical text.

After refreshing a stale catalog, require renewed review/reselection, or a server-verified identity mapping that proves the chosen candidate is unchanged. Carrying the same numeric index into a reordered catalog is unsafe.

New-chat creation gets a durable command identity. Save the chat, choice/catalog provenance, optional completed opening and receipt in one transaction. Lost acknowledgement must offer explicit retry of the exact reviewed settings/choice without creating a second chat. Existing clients lacking a request ID can retain legacy behavior, but the new UI must not promise safe retries without one. A successful replay returns the recorded result even after deletion; never recreate the chat.

On uncertain acknowledgement, freeze the submitted settings, choice/snapshot and command ID, show that creation may already have saved, and offer Retry same creation. Do not let a changed preview/settings payload reuse that identity. Closing does not undo a saved chat. A definite rejection allows a new reviewed attempt with a fresh identity where appropriate.

Creation itself makes no model call. The copied nonempty opening has an empty user part, completed assistant part, stable turn/part identities and ordinary revision/coverage behavior. The first user submission creates the next turn. Empty choice still records provenance even though there is no opening turn.

## 6. Captured catalog and choice provenance

Persist a bounded immutable opening catalog for the new chat, or an equivalent immutable snapshot shared by originating character revision. Retain the primary/alternate order and raw text needed for pre-start switching without rereading a mutated library record. Capture character/persona identity and resolved name inputs. Do not build a generic record-versioning framework for unrelated libraries.

Store the chosen standard index, originating character identity/revision, raw and resolved selected text, snapshot identity, current opening-turn identity if present, and switching eligibility/lock reason. Switching updates the current choice atomically while prior receipts remain immutable. An optional small transition history can explain explicit switches, but is not a general branching system.

Do not infer provenance for old/imported chats by comparing text or by assigning zero to every first assistant message. History replacement invalidates active greeting-choice applicability and permanently locks switching; original provenance can remain historical, clearly distinguished from the replaced transcript. Deleting the opening makes the active greeting unknown. A manually edited opening also makes the active greeting unknown, while retaining its original historical choice record. Shared card edits alone do not change known copied-choice provenance.

Separate switch eligibility from known index provenance. A shared rename of the originating character/persona permanently locks switching, retaining known selected-index provenance for the same originating character. A Setup change to either selected character or persona permanently invalidates active greeting applicability as well as locking switching; switching those identities back does not revive it. Keep the original choice as historical provenance. Do not model these conditions as a temporary current-ID/name comparison that can reverse itself.

Keep large catalog data out of routine chat/SSE responses. Fetch the chooser's bounded list/selected text on demand. Public snapshot state should expose only the small eligibility/current-choice information needed to display controls. Delete unreferenced snapshots with their ownership records; never retain every unsaved draft as history. Captured catalogs are server data, not browser localStorage drafts.

Once switching is permanently locked, retain the compact selected-choice provenance but release that chat's full catalog ownership. Delete a shared catalog only when no remaining switchable owner needs it. A rename/other lock need not rewrite selected text to perform this cleanup. Recorded create/switch receipts remain replayable without the full catalog and must be checked before catalog-availability preconditions on a retry.

## 7. Switching before a story starts

Provide a compact Choose opening control beside/above the copied opening, with labelled previous/next or a numbered chooser and full preview. Empty-opening chats still need a reachable control. Previewing a choice is local/read-only; Apply opening commits it. Do not send a mutation on each hover, touch swipe movement or keyboard highlight.

Preserve the chat's unsent composer draft through chooser preview/cancel/commit. Switching an opening must never submit or clear that text automatically. After commit, let the existing authoritative preview/counting path recompute against the changed opening and the same unsent input.

Reuse accessible dialog/picker patterns: keyboard navigation, visible focus, Escape/Cancel and focus restoration. Narrow screens need readable full prose and reachable controls without horizontal scrolling. Long greeting lists need bounded rendering/search or pagination. Keep the normal Story interface quiet once the chooser is locked/unavailable; a brief explanation can accompany its disabled state or Setup inspection.

If another tab switches or locks the opening while the chooser is open, reconcile authoritative eligibility/revision, disable stale Apply and explain the change while retaining the reviewed preview and a working Cancel. An uncertain switch freezes its exact index/snapshot/command and offers Retry same opening change; changed choices require a fresh definite/reviewed attempt. Never imply that a timeout proved the old opening remains active.

Server-side switch preconditions include captured chat revision, idle state, valid snapshot/index, intact pristine opening provenance and an unset monotonic lock. Validate the actual turn/part identities/revisions and absence of incompatible memory/job/request state, not just turns.length or empty user text. Enforce the same rule for direct forged API commands.

Set the lock transactionally when the first user turn is accepted, even if its provider call later fails/cancels. Set it before beginning any saved generation/preparation operation and on manual opening edits/deletion/history replacement. Preserve it through restart, whole-turn deletion, blank edits and Clear memory. Failed validation or read-only plans do not set it. Check alternate entry points, including legacy APIs and retries, so none bypass it.

An ordinary Save of exactly unchanged normalized opening text is not an edit for this policy: do not lock the chooser or invalidate known provenance just because its edit form was submitted. Ensure the pristine revision guard remains coherent if the existing mutation path would otherwise advance a revision on an identical save. An actual text change, including an intentional clear, locks/invalidate as specified; do not infer this from text length alone.

For a permitted nonempty-to-nonempty switch, retain the opening turn/user/assistant identities and increment only the changed assistant part revision under ordinary mutation rules. For an empty-to-nonempty switch, insert the ordinary completed opening. For nonempty-to-empty, remove that whole opening turn as an explicit switch operation and save no opening turn. Normal manual clearing of a completed part still preserves its turn membership; do not change that invariant globally. Exactly unchanged resolved text/index is a no-op; changing index with identical text still updates provenance/lore context without inventing a text edit.

Commit selected choice, turn mutation, chat/library revision visibility and relevant lore epoch reset together. Preserve settings, source catalogs and unrelated records. The pristine/no-processing precondition means this operation must never repair/delete summaries or historical provider requests to make itself eligible. Reject it instead. Preview caches are invalidated on a committed switch.

Use durable switch command identities and payload fingerprints. A lost acknowledgement retries the exact selected index/snapshot; replay precedes stale-revision checks and cannot undo a later switch. Concurrent switch/send commands serialize so only the valid winner commits. Distinguish lock/conflict errors from network uncertainty; preserve the user's reviewed preview until reconciled.

## 8. Greeting-conditioned lore and context safety

The current is_greeting directive is unsupported. The proposed feature enables it only when active greeting provenance is known and applicable to the selected character. Match the recorded standard index, not current text or today's reordered array. A known index mismatch is a real nonmatch: a generic activate/constant rule or fallback must not bypass that condition.

For old/imported/manually changed openings and other unknown cases, retain the existing unsupported/inapplicable interpretation and diagnostics, including valid fallback handling. Do not silently suppress all formerly active lore by pretending an unknown choice is zero. Document this profile transition explicitly; do not claim existing chats acquired historical provenance.

Pass greeting context as an explicit input to pure lore resolution. Record it in frozen operation data and historical inspection, outside provider messages. It must remain the same through reduced-history planning, budget pressure passes, saved summary reuse and compaction. The original greeting turn may be archived without losing its known choice index; summary-off selection omitting that turn also must not erase provenance.

A permitted opening switch invalidates current lore previews and resets relevant chat activation state before a subsequent attempt. A saved name/identity change continues existing lore epoch rules, with the separate known-index/identity-invalidation policy in section 6. Live lore remains excluded from extraction/promotion/repair inputs. Do not add every alternate to model input or treat inactive alternatives as summary coverage.

Ordinary later opening edits/deletion still use established transcript revision/staleness propagation. They may invalidate summaries, but cannot become a shortcut to a new scenario or reopen greeting switching. Keep completed-turn counting, empty-part omission, pending-turn limits, protected tails and fixed batches unchanged.

## 9. Persistence, migration and receipts

Add versioned migration(s) for scoped greeting catalog/provenance/lock/command storage with validated schemas and ownership constraints. Determine the actual next version from the checkout. Test fresh creation and populated upgrades preserving all existing character/chat/turn identities, revisions, primary text, source metadata, picture/tag/book relations, summaries, lore state, credentials and historical requests/receipts. Existing chats remain unknown/locked without replaying model work or adding greetings.

Do not add full greeting catalogs to credentials-bearing records or serialize internal persistence rows into APIs. Keep core greeting logic independent of database/server/UI. Extend Character's normal authoring validation deliberately, preserving legacy omitted-update semantics.

Real reusable greeting edits follow existing character authoring revision/shared-idle rules and refresh affected library/editor state. They do not rewrite copied chat openings or name inputs, reset lore epochs as if the character were renamed, or regenerate history. Do not create a separate prompt marker for alternatives.

Preserve old save/import command fingerprint compatibility. In particular, schema defaults must not inject a new empty array into a previously recorded omitted-field payload before receipt lookup. New supplied alternate text/order is part of the exact save intent; changed alternatives under the same command ID must conflict. Successful replay after later edits/deletion returns the original result and never restores old alternatives/chats. Character/card/tag/picture import still commits its existing coupled data atomically.

Combined saves use the current text/tag/picture exact-command recovery and picture preconditions. Greeting drafts join its frozen command and reconciliation, rather than a second independent save. No new external service, dependency or paid generation is authorized. No automatic network/model retries.

## 10. Sequence and required evidence

1. Confirm proposed scope/defaults, especially switching, empty choices, snapshot retention and known/unknown lore behavior. Show the coordinator the create/switch contracts and durable eligibility state machine before editing shared code.
2. Implement authoritative greeting parsing/resolution and source-presence compatibility; add observable tests for import/export/removal and copied text.
3. Implement transactional provenance/catalog/create/switch commands, lock transitions and migration/replay tests with temporary SQLite.
4. Integrate known/unknown greeting lore context through frozen planning/inspection without changing coverage or summary input.
5. Implement authoring, new-chat chooser and pre-start switch UI; review desktop/phone screenshots and exercise recovery.
6. Review affected callers and final diff, update accepted/current documents and run complete final verification.

| Area | Required cases |
| --- | --- |
| Formats/authoring | V1 where supported/V2/V3 JSON and PNG; ccv3 preference; missing/empty/duplicate/blank strings; Unicode/formatting; invalid members and limits; add/edit/reorder/delete/export/reimport; removed entries cannot resurrect from source; group-only metadata stays inactive |
| Legacy compatibility | Existing valid preserved alternatives exposed; malformed old source survives unrelated text/tag/picture save and export until explicit correction; omitted update preserves alternatives; explicit empty clears; pre-feature save/import receipts replay after upgrade/restart |
| Create | Default/each explicit alternate; persona/character macro resolution exactly once; primary/alternate empty creates no turn; stale reorder/name/persona revision rejected; title/settings draft retained; atomic failure rollback; lost acknowledgement yields one chat |
| Provenance | Duplicate text has distinct index; source edits/reorder do not change copied catalog; shared rename locks but retains known index; Setup identity away/back cannot revive applicability; unknown imported history; locked-chat full catalog release and shared-owner cleanup; receipt replay after cleanup |
| Switch | Nonempty/empty transitions; preserved turn IDs where present; index-only change with identical text; unchanged choice no-op; concurrent switch/send; stale/duplicate/replayed commands; restart; no paid request |
| Lock integrity | First submission then failure/cancel/deletion; blank completed parts; manual opening edit/delete; history replacement; saved preparation starts/fails; Clear memory; legacy APIs; no transcript-length or text-equality bypass |
| Lore/context | Known matching/mismatching index; unknown fallback; selected-character mismatch; recorded frozen context; switch state reset; archived greeting/summary-off omission retains known provenance; no inactive greetings or live lore in summary requests |
| Editor integration | Combined greeting/text/tags/picture atomic save and injected rollback; uncertain frozen retry; dirty navigation/extraction guards; TagManager/apply preserves draft; stale reconciliation explicitly reviews/replaces greetings while retaining intended picture draft |
| Existing history | Ordinary opening edit/delete stales dependents correctly; original request bodies/estimates/provenance immutable; whole-turn counting and blank omission unchanged; history import never prepends a greeting |
| Browser/UX | Keyboard/touch chooser and reorder controls; selected preview matches saved Story/provider input; Cancel vs Apply; long/empty/duplicate openings; 390px/320px and short landscape; reachable controls/focus and no overflow; unchanged library/tag/picture layouts |

Use synthetic cards, real temporary databases/coordinators and controlled local providers. Check exact outgoing messages: only the selected copied opening appears, with assistant role, while its blank user part is omitted. Assert model-call counts for all chooser/switch operations. Do not mock away transaction, lock or coverage rules.

Extend libraries, character/picture/tag persistence, lorebook directive/integration/lifecycle and context/browser suites as relevant. Run focused tests while iterating and npm run check (or all constituents successfully on final changes) before handoff with README's supported Node runtime. Build before browser tests. Inspect actual screenshots; do not claim real phone behavior from emulation or semantic story quality from mock responses.

## 11. Documentation and completion

Update CONCEPTS.md with accepted greeting/switch/unknown-lore policies; IMPLEMENTATION.md with contracts, migration and operation ownership; README.md with actual workflows/limits; and focused greeting/lore documents with exact directive behavior. Revise old statements that alternate greetings and is_greeting are wholly inactive only where the new profile actually changes them. Keep this assignment distinct from implementation status.

Final handoff reports implemented behavior, checks/results, migration/replay evidence, visual review and remaining compatibility limits. Review for stale index use, lost authoring drafts, unwanted source-array resurrection, lock bypasses, receipt changes and accidental transcript/summary deletion.

Manual acceptance: import a card with two alternatives, choose the second with a persona, verify the copied text, switch the pristine opening and cancel another preview, then send a turn and confirm switching stays locked even after deleting that turn. Start another chat after editing/reordering the card and confirm the earlier chat remains unchanged. Exercise one greeting-conditioned lore entry and a failed/uncertain create/save recovery. Title / comment remains deferred.
