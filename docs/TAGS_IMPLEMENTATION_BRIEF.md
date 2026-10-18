# Tags: implementation assignment

Prepared: 2026-10-18.

Status: proposed implementation handoff, not an implementation report. This request authorizes writing the guide only. Do not start application implementation merely because this file exists.

## 1. Objective and accepted scope

Implement local character organization through a persistent tag catalog, character assignments, import choices and library filtering.

The user's requirements are:

- A local database of tags.
- When importing a character card, choose **Import all**, **Import existing**, or **Import none**.
- Filter characters by tags in the library.

The assignment includes the management/editing controls, persistence, migration, import recovery and verification necessary to make those requirements usable. Section 3 supplies proposed product defaults; these recommendations are not previously accepted decisions. Have the coordinator/user accept or amend them when assigning implementation. Resolve only material product ambiguities with the coordinator; routine technical details remain the implementing agent's responsibility.

Read AGENTS.md, CONCEPTS.md, IMPLEMENTATION.md, README.md, package.json and docs/LOREBOOKS.md before implementation. The lorebook implementation brief records an earlier design; current accepted behavior is in the product/implementation/subsystem documents and source. Do not restore its retired lore markers or change the current field-based Character expansion.

This task does not add tags to lorebooks, personas, chats, Connections or presets. Those can be considered later. Tag colors, folders, automatic/model-generated tags, bulk editing, tag-specific backups, advanced exclusion filters and local-tag export options are outside the initial assignment. No new dependency or service is authorized.

## 2. Current implementation and references

Character import currently reads V1/V2/V3 JSON or embedded PNG metadata, preserves original card JSON, and atomically creates a linked library lorebook where present. Character exports overlay supported fields and the current book onto preserved metadata. Local tags and assignments do not yet exist.

Current integration points:

| Area | Files and constraints |
| --- | --- |
| Shared contracts | src/shared/library.ts owns characters, library snapshots and commands. Keep local organization separate from PromptSources and model input. |
| Card adapters | src/core/cards.ts owns card text import/export. Do not spread local tag IDs into exported card fields. |
| Persistence | src/persistence/store.ts owns library revisions, shared-edit restrictions, import transactions and durable import command identities. |
| Schema/upgrades | src/persistence/schema.ts, migrations and migration registration. Determine the actual next version at implementation time. |
| API | src/server/app.ts validates library/import/export commands and publishes change notifications. |
| Library UI | src/web/Libraries.tsx contains character import, duplication, editor and list. Extract cohesive tag/import components instead of enlarging it indiscriminately. |
| Refresh | Store.libraryUpdate and src/web/App.tsx use a known library revision to avoid loading unchanged libraries. Tag mutations must invalidate that cache. |

Primary compatibility references: [V2 tag field](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md#tags) and [SillyTavern tag organization/import](https://docs.sillytavern.app/usage/core-concepts/tags/). Card tags are string metadata used for organization; local assignment and embedded metadata are distinct concerns. These references do not authorize copying another application's code or reproducing all of its tag features.

## 3. Proposed product defaults for review

| Topic | Proposed behavior |
| --- | --- |
| Scope | One owner-wide tag catalog; assignments to characters only in this milestone. |
| Management location | Manage tags from the Characters library. A separate top-level library tab is unnecessary. |
| Import choice | Show the three required modes before commit; initially select Import none. Cancel performs no import. |
| Omitted API policy | Resolve to Import none for backward compatibility; include that effective policy in the command identity. |
| Name identity | Trim outer whitespace, normalize to NFC and apply locale-independent Unicode lowercase for matching. Preserve internal spaces and punctuation; do not transliterate or use compatibility normalization. |
| Display spelling | Store the trimmed NFC display name separately. Existing catalog spelling wins on import. First occurrence supplies spelling for a newly created tag. |
| Collisions | Reject create/rename to another tag's canonical name. No implicit merge. A case-only spelling change of the same tag is allowed. |
| Import metadata | Preserve original embedded tags independently of the chosen local import mode. |
| Export | Continue exporting preserved embedded tags. Local assignments, catalog renames/deletions and filters do not rewrite them. New local assignments do not become embedded tags automatically. |
| Existing characters | Start with no local assignments after upgrade. Offer an explicit Apply embedded tags action with the same three import modes. |
| Reapplying embedded tags | Additive set union; never remove manually assigned tags. Import none is a no-op for an existing character. |
| Duplicate character | Copy current local assignments, share catalog tag identities, preserve original embedded metadata and existing lorebook link semantics. |
| Remove assignment | Remove only that character/tag link. Keep the catalog tag. |
| Delete character | Remove its assignments atomically. Keep catalog tags, including tags that become unused. |
| Delete catalog tag | After showing its usage count and confirmation, remove it and all its assignments atomically. Keep characters and embedded metadata. |
| Filtering | Match all selected tags (AND). No selected tags means all characters. Display Clear filters and a meaningful no-results state. |
| Filter lifetime | Keep the current view's selection through editing/import/refresh. Clear when leaving Characters; no cross-restart or cross-device preference sync in this milestone. |
| Tag-only edits | Change organizational/library revisions, not character prompt revisions, chat revisions, lore epochs or memory. Retain existing shared-edit idle restrictions. |

Canonical equality here is the stated normalization/lowercase algorithm, not an assertion of full linguistic case folding. For example, do not silently collapse different punctuation, accents or width variants. Use the same pure helper at creation, rename, import matching and search boundaries; never rely on SQLite's ASCII-only default NOCASE behavior for Unicode identity.

If a default changes, update affected workflows, examples, contracts and tests together. Do not treat the earlier assessment's suggestions as additional accepted requirements.

## 4. Catalog and character editing workflows

### Manage tags

Provide create, rename and delete controls, searchable catalog display and character usage counts. Use stable tag identities so renaming preserves assignments and active filters. Show unused tags; do not silently garbage-collect them. Alphabetical display can use locale-aware presentation sorting, but identity must use the shared canonical algorithm.

Validate names as nonempty after normalization, with documented bounded lengths and catalog/assignment sizes. Select reasonable bounds using representative synthetic fixtures before finalizing them. Keep display names as text, never HTML. Separate a genuine conflict, invalid input, stale revision and unavailable server in error messages.

Apply name limits after local normalization. Evaluate assignment limits against the resulting unique assignment set, including existing links when applying tags to a saved character. Catalog limits count only genuinely new tags; do not reject a matching existing tag because the catalog is at capacity.

Deleting an assigned tag must state how many characters lose that local assignment. A failed delete leaves the tag and every assignment intact. A catalog name collision must preserve both records and the user's draft; do not offer an unimplemented merge action.

### Assign tags to characters

Show assigned tags on character library entries and in the editor. Provide a searchable chooser for existing tags, clear individual removal controls, and a route to create/manage tags without discarding character edits. Avoid a free-text comma-separated-only control: a tag itself may contain punctuation or commas.

Treat the editor selection as a draft until Save succeeds. Cancel discards assignment edits together with other local character drafts. When text fields and assignments change in the same save, commit them atomically. If only assignments change, use the organizational path without rewriting the character record.

Opening Manage tags or creating a catalog tag while editing must preserve the character draft. A successful self-originated catalog operation may advance the captured library revision only after validating that the character data the editor depends on is unchanged. An unrelated concurrent change still requires reconciliation; do not blindly replace a stale expected revision. Creating a catalog tag need not assign it until the editor saves; cancelling that editor may leave a visible unused catalog tag.

Ordinary APIs must distinguish omitted assignments from explicit empty assignments: omitted means preserve, empty means clear. Validate all referenced IDs as existing catalog tags and the target as a real character. Duplicate assignment IDs collapse to set membership or are rejected consistently; they must never create duplicate relation rows.

### Existing imported cards

Offer Apply embedded tags in the character editor or its actions. Review the source tags and apply all/existing/none without reimporting the character or duplicating its lorebook. This action changes only assignments/catalog entries. It must not save stale character text, change its source metadata, select a different book or reset lore state.

## 5. Import choices and preview

Extend the existing character JSON/PNG workflow so policy is reviewed before commit. The review shows character name, existing embedded-book information, existing/new eligible tag groups, malformed or unusable tag notices, the chosen mode and expected effects. Preserve existing lorebook diagnostics and success reporting. No provider call occurs during analysis/import.

Do not create the character and then ask which tags to import: that produces partial success and makes Cancel misleading. Analysis is read-only. The final explicit command commits the character, optional book, link, new tags and assignments together.

| Mode | Commit behavior |
| --- | --- |
| Import all | Match every eligible canonical source tag against the current catalog; create missing tags; assign the resulting set. |
| Import existing | Assign only source tags matching catalog records already present at commit; create no tags. |
| Import none | Create/assign no tags. Preserve all original source metadata and import the ordinary character/book data. |

The library revision check must make the preview meaningful: if the catalog changes before commit, return a conflict and let the user refresh/review. Do not silently reinterpret existing-only against a changed catalog. A tag created by this import cannot count as previously existing for another candidate in the same command; deduplicate candidates first.

### Metadata parsing and limits

Read V2/V3 tags from their nested authoritative card data; read legacy tags from the legacy root. Do not combine stale compatibility backfill fields with the authoritative nested list. Preserve all raw fields for export, regardless of local policy. Keep PNG ccv3 preference unchanged.

Normalize only local candidates. Deduplicate normalized equivalents while retaining a stable source-to-result explanation. Whitespace-only names are ineligible, with a notice. Missing tags is an empty candidate set. An empty list is valid.

Proposed tolerance: a wrong container type or non-string members produce bounded compatibility notices, remain preserved in original metadata, and do not become local candidates. Never coerce objects/numbers into tag names or execute macros in them. Accept only actual arrays of strings for this milestone; do not guess a split rule for a legacy single string. Explain that legacy representation as unsupported metadata. Valid strings with commas remain single tags.

A usable string that exceeds local limits must not be silently shortened or omitted from an all import. Report the limit and block that mode; the user can explicitly select None, or Existing if every applicable matching candidate can be evaluated safely. Oversized tag metadata that cannot be analyzed within the bounded parser budget must fail the analysis actionably; do not label incomplete results as the complete candidate set. The existing whole-card size limit still applies.

Document limits separately for preserved card input, local names, candidate count, catalog size, assignments per character and diagnostic pages. Import all must never partially succeed because a bound was reached. Empty/malformed/oversized cases need explicit results, not swallowed exceptions.

### Retry and cancellation

Extend the existing durable import-command mechanism. Its fingerprint must include source card data and the effective tag policy (plus any other user-selectable commit options). The reviewed library revision is a concurrency precondition; do not make a successful command unreplayable merely because the library revision has since advanced.

The same command ID and effective payload returns the recorded result without creating a second character/book/tag/assignment, including after server restart. The same ID with changed tag policy must conflict. An intentional new import uses a new ID and creates a separate character, reusing canonical catalog tags.

Preserve replay of pre-tags successful import commands. A legacy fingerprint for the same card can match the effective None policy through a narrowly defined compatibility check; it must not authorize All or Existing with that old ID. Keep recorded legacy results readable, with any newly absent tag-report fields treated as unavailable. Do not rewrite command history to make a changed fingerprint appear compatible.

Recorded success remains a historical result even if the imported character or tags were later renamed, changed or deleted. Replay must return that result rather than recreate deleted data or reapply assignments. The UI can reconcile current availability separately and explain that an original record no longer exists; a deliberate new import needs a new command ID.

Retain the captured command ID, policy and import source during ambiguous transport failures so an explicit retry uses the same command. Do not regenerate an ID for every retry button click. No automatic resend is required. Closing/cancelling before commit changes nothing; after an ambiguous response, explain the uncertain acknowledgement and allow status reconciliation or an idempotent retry rather than claiming the import was cancelled.

## 6. Filtering and list behavior

Provide a searchable multi-tag filter in Characters with visible selected values and result count. The rule is all selected tags must be assigned to a character. Apply filters to local assignments only, never directly to embedded metadata. Include untagged characters when no filter is active.

Example: A has fantasy/adventure, B has fantasy, C has neither. Selecting fantasy shows A/B; selecting fantasy and adventure shows A; clearing shows A/B/C. Renaming adventure preserves A's assignment and the active filter by identity. Deleting adventure removes that filter ID after the server confirms deletion.

Also prune missing selected tag IDs after an authoritative library refresh from another tab/device. Never prune filters from a temporary empty loading state or a stale response.

Provide a distinct empty-library state and no-filter-results state. Importing/creating a character that does not match the current filter must still report success and explain it may be hidden, with a way to clear filters. Do not silently modify assignments or clear unrelated filters to make the new record appear.

Filters cannot affect the active chat, character selection in existing chats, prompt assembly or exported cards. Do not apply library filters to the Setup selector unless separately requested. Preserve current lorebook search and other library sections. Release stale async results after section changes; treat server state as authoritative.

Use memoized sets/indexes or an equivalent bounded approach. Avoid database queries per character/tag chip and repeated full-library membership scans on every render. Test representative tag/character counts before claiming performance. Do not copy full card sources or lorebook payloads into tag-specific responses.

## 7. Model, migrations and integrity

Prefer a normalized catalog and assignment relation separate from Character's prompt-bearing data. A tag has a stable ID, display name, canonical key and revision. A character/tag link is unique and references live records. Add indexes for canonical lookup and assignment/filter access. Enforce uniqueness and reference integrity at commit, not only through UI checks.

Do not model tags as Connection-like prompt sources or as a new kind that accidentally enters existing fallback branches. Update explicit discriminated unions/public contracts where needed; avoid broad casts. Do not expose persistence rows directly. Keep the canonical helper browser-safe and independent of database/server frameworks.

Use a new versioned migration and consistent Drizzle definitions/registration. Create fresh storage and exercise upgrade from a populated current database. Existing cards receive no automatic local assignments or catalog entries. Their embedded source tags remain intact and available to the explicit Apply embedded tags action.

Preserve character/chat/turn identities and revisions, summaries/manual corrections, selections, credentials, saved request bodies/estimates, lorebook links, lore operation snapshots, activation epochs/state and command history. Restart must not reapply migrations or auto-import preserved tags.

Deletion of a character cleans only its assignments atomically; existing deletion-in-use rules still govern the character. Deleting a tag cleans its links atomically, with rollback on failure. Do not delete characters/books or alter source tags. Do not choose a migration strategy that deletes and recreates existing character rows to obtain convenient foreign keys.

## 8. Revisions, concurrency and roleplay isolation

Every committed catalog/assignment change must advance the library revision and publish the established change notification, so knownRevision refreshes do not retain stale tags. True no-op operations should not create duplicate assignments or unnecessary revision churn.

Tag-only commands must not call the ordinary character save path merely to record organization. That path currently bumps selecting chat revisions, and name changes can reset lore epochs. Keep tag IDs out of prompt-bearing Character data/PromptSources, or deliberately map them away at every boundary if another design is approved.

Prove that creating/renaming/deleting a tag, changing assignments, applying embedded tags, filtering and copying assignments leave existing model input, budgets, current chat revisions, summaries and lore activation state unchanged. Character duplication creates a new character normally; the original character and its selecting chats stay unchanged. A real text/name edit continues to use existing revision/reset behavior.

Preserve existing global shared-edit restrictions while response/preparation work runs. Metadata separation does not authorize relaxing those rules. Use the established library revision check for stale tabs and commit-time rechecks. Keep reads/filtering available while generation runs.

Combined editor saves and embedded imports must check all preconditions and commit all related writes in one short transaction. Test a failure after creating a book/tag as well as an early validation failure. Network calls and file review do not belong inside SQLite write transactions.

## 9. API and UI boundary requirements

Extend the established API with explicit commands for catalog management, assignment changes and import analysis/options. Reuse existing authentication/origin policy. Validate IDs, normalized-name bounds, enum modes, assignment arrays and revisions on the server. An unknown mode is an error, not None. Omitted and explicit empty values need the documented different semantics.

Choose additive library snapshot fields or a focused endpoint that participates in the same cache invalidation scheme. Public shapes should carry safe catalog/assignment data and usage counts without appending it to every historical generation snapshot or full lore resolution. Preserve backward-compatible reading of existing commands and saved records.

Export adapters must exclude every local ID, canonical key, assignment relation, usage count, filter preference and operation identity. Test both nested modern and legacy root fields so one path does not accidentally publish local data. None of these operations may touch saved credentials.

Use existing styled controls, accessible labels, keyboard-operable choosers and clear selected/removal states. Tag pills must wrap on narrow screens; long names must not hide controls. Paginate/search large catalogs as necessary. Avoid a UI that requires color alone to distinguish selection.

Loading/error states, duplicate-name validation, pending import, conflict recovery and no-results behavior are required. Keep drafts on failed saves. Disable repeat submissions in the UI and enforce integrity on the server; neither replaces the other. Tag import is a local data operation with no model cost or external service.

## 10. Implementation sequencing

1. Confirm proposed defaults, trace current flows and show a contract/migration sketch. Identify the existing import-idempotency and revision tests to extend.
2. Add the shared normalization/candidate parser and format fixtures, then catalog/assignment storage, constraints and migration tests.
3. Integrate atomic character/book/tag imports and durable policy-aware retries. Verify raw card metadata and current lorebook behavior remain intact.
4. Add assignment/catalog commands and combined editor/duplication/deletion paths. Verify tag-only roleplay isolation and library cache invalidation.
5. Add the import review, manager/chooser, apply-to-existing action, chips and filtering, with desktop/phone-sized browser workflows.
6. Review all affected callers/error paths and the final diff, update documentation and run final checks.

The coordinator owns product clarification and integration. One implementing agent can own this vertical slice. If delegating, stabilize contracts first and divide ownership explicitly; avoid concurrent incompatible edits to store.ts, Libraries.tsx or import schemas. No unrelated library/refactoring project is authorized.

## 11. Required evidence

Use isolated temporary SQLite databases, synthetic/copied fixtures and controlled local providers. Never destructively test the user's active database or private transcript. Establish regressions before fixes where feasible; do not replace meaningful expectations with implementation-shaped calculations.

| Area | Required cases |
| --- | --- |
| Identity | Trim/NFC/lowercase equality; composed/decomposed Unicode; multilingual names; accents/punctuation/internal spaces retained; empty and boundary names; normalization collisions; no ASCII-only uniqueness loophole |
| Catalog | Create/rename/delete; case-only rename; collision rejection; used/unused tags; usage counts; failed deletion rollback; stable IDs and assignments after rename |
| Assignments | Add/remove/clear; omitted means preserve; unknown/wrong-kind IDs rejected; duplicates cannot create repeated links; combined text/tag save atomicity; character duplicate copies assignments; character deletion preserves catalog |
| Import modes | All/existing/none for V1/V2/V3 JSON and PNG; ccv3 preference; no tags; duplicates/equivalent names; existing spelling wins; missing/wrong-shaped/mixed/empty/oversized metadata; notices and original source preserved |
| Import transaction | Character/book/link/new tags/assignments commit together; injected mid-transaction failure rolls everything back; stale preview/catalog revision; intentionally repeated import shares tags but creates a new character |
| Retry | Lost acknowledgement and server restart return one recorded result; effective omitted None equals explicit None consistently; populated upgrade/restart replays legacy no-policy commands; changed-policy same-ID conflict; replay after later deletion cannot resurrect records; failed commands do not leave orphan catalog records; UI explicit retry retains ID/policy |
| Existing cards/export | Upgrade leaves all assignments empty; Apply embedded tags is additive/idempotent; None is no-op; unrelated text/lore untouched; local rename/delete/assign does not rewrite embedded metadata; no internal tag data leaks on export/reimport |
| Filtering | AND semantics using an independently specified A/B/C fixture; no selection; zero results; clear/reset; renamed tag preserves selection; deleted tag reconciles; imported record hidden by active filter still reports success; other libraries/Setup unaffected |
| Isolation/refresh | Tag-only changes preserve exact outgoing messages/budgets, selecting chat and character revisions, summaries, lore state/epochs and historical requests; library revision invalidates knownRevision cache; no-op stability; concurrent tabs and stale saves |
| Migration | Fresh creation; populated current upgrade; rollback and restart idempotency; unchanged unrelated identities/revisions/history/credentials/books/state; SQL constraints and indexes actually exercised |
| Browser | Import review before any commit; each mode; cancel; create/assign/save/reopen/remove/rename/delete; conflict retains draft; manager while editor open; filter/no-results; two-tab refresh; desktop and phone-sized controls |
| Bounds/security | Large synthetic catalog/assignments; bounded diagnostics and parser work; malicious names rendered as text; server validation despite forged commands; credential exclusion |

Extend tests/libraries.test.ts, relevant lorebook persistence/import/lifecycle tests and browser library/chat suites; create focused tag suites for cohesive coverage. Use the actual core/persistence/import paths, not mocks that bypass the transaction under test. Mock only external transport when verifying no impact on generation.

Run focused checks while iterating. Before application handoff, run npm run check or all constituents successfully against the final changes using README's supported Node runtime. Build before browser tests. Report an exact environment blocker if a required check cannot run; do not claim clean verification from a build alone.

## 12. Documentation and completion

Once decisions are accepted and functionality is implemented, update CONCEPTS.md with product behavior, IMPLEMENTATION.md with contracts/migration/isolation rules, README.md with actual workflows/limits and a focused tag subsystem document where useful. Keep this brief separate from implementation status. Do not append a feature diary to AGENTS.md.

Final handoff must report the user-visible outcome, actual automated checks and results, migration evidence and unresolved limitations. Review the complete diff and callers for stale writes, ID/export leakage, lost assignments, unintended chat/lore revision changes and regressions in existing character/book imports.

Manual acceptance path: create fantasy locally; import a card containing Fantasy and adventure using Existing and verify only fantasy is assigned; import another copy with All and verify adventure is created; import with None and verify it remains untagged; filter by both tags; rename/remove/delete a tag; reopen the editor; export and verify the original embedded metadata remains unchanged. Repeat one import with an embedded lorebook and inspect an existing chat to confirm its prompt/lore behavior is unchanged.

Completion means the full management, import, assignment and filtering workflow works with its failure/recovery paths. A tag table or a few displayed pills alone is not completion.
