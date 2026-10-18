# Lorebooks: implementation assignment

Prepared: 2026-10-18.

Status: handoff instructions, not an implementation report. The current request authorizes preparing these instructions; it does not start application implementation. Do not describe the functionality below as already available.

## 1. Objective and authority

Implement a complete, usable lorebook workflow in ORE: a reusable Lorebooks library, an entry editor, embedded character-book import, standalone import/export, character defaults, one selected lorebook per chat, activation, prompt placement, budgeting, and inspection of actual outgoing lore.

The user explicitly selected **V2/V3 standard lorebook behavior, preserving and reporting unsupported extras**. SillyTavern-specific probability, inclusion groups, sticky activation, cooldowns and delays are outside this assignment. Multiple simultaneous books are a future possibility; the server must enforce a maximum of one now.

Read AGENTS.md, CONCEPTS.md, IMPLEMENTATION.md, README.md, docs/CONTEXT_EDITING.md and docs/TOKEN_COUNTING.md before implementation. Existing prompt authority, turn identity, protected history, summary freshness, credential handling and asynchronous operation rules continue to apply.

The requirements explicitly approved above are distinguished from the **proposed defaults** in section 3. Those defaults make this handoff concrete; they are recommendations from the coordinating agent, not previously accepted product decisions. When assigning implementation, the coordinator/user should accept or amend that section first. Do not silently substitute different behavior. Independent tracing and test-fixture preparation can proceed while a material decision is pending.

Implement only lorebooks and their necessary integration. Tags, portrait storage/cropping, title/comment, general alternate greetings, card instruction overrides, a general macro engine, Markdown rendering, CHARX and PNG export remain separate tasks. Preserve their imported metadata.

## 2. Standards and compatibility profile

Use these primary references; inspect their current contents rather than another application's implementation as the specification:

- [Character Card V2](https://github.com/malfoyslastname/character-card-spec-v2/blob/main/spec_v2.md).
- [Character Card V3](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md).
- [SillyTavern World Info](https://docs.sillytavern.app/usage/core-concepts/worldinfo/) for standalone-file interoperability and identifying unsupported extensions.

Support standard book and entry fields, including regex and constant activation, secondary keys, ordering, priority, recursion, scan depth and budgets. Read/write V2 character books, the V3 standalone envelope and SillyTavern World Info JSON. Preserve unknown fields, external IDs and extensions. Do not execute unknown semantics.

Implement chat-applicable standard V3 decorators with their precedence and fallback rules. Produce a coverage matrix against the upstream decorator section. Explicitly classify directives needing unavailable text-completion, asset, greeting-selection or prompt-override features as unsupported; preserve them and apply the specified fallback where applicable. They must never silently enable those separate product features. Decorator control lines must not accidentally become model-facing lore prose.

This profile covers lorebook functionality, not whole-card V3 compliance. In particular, the separate macro-engine task remains deferred even when a macro appears inside a book.

Maintain a separate matrix for SillyTavern extension fields: supported mapping, preserved inactive behavior, or invalid input. Do not claim complete SillyTavern engine compatibility.

Where a reference contradicts its own type definition or leaves behavior unspecified, document the precise ambiguity and the proposed ORE interpretation before implementing it. Do not resolve a product-significant ambiguity by copying whichever behavior is easiest.

## 3. Proposed product defaults for review

These recommendations are part of the proposed assignment, not a record of accepted decisions.

| Topic | Proposed behavior |
| --- | --- |
| New chat | Prefill the selected character's linked book. An omitted API selection resolves that default; explicit `null` means None. Persist the resolved selection. |
| Existing chat | Changing character preserves the selected book. The user changes the book explicitly in Setup. |
| Embedded import | Create one independent library book and link it as that character's default, atomically with character creation. |
| Separate import | Create an independent library book. Do not attach it to the current chat or a character without an explicit selection. |
| Duplicate character | Retain its book link and explain that the book is shared. Duplicating a book explicitly creates independent book/entry identities. |
| Same names | Names are labels, never identifiers. Importing a same-named book does not overwrite or merge existing data. |
| Remove character link | Remove embedded book content from future character exports. Preserve the original imported source internally; do not let it resurrect the removed book. |
| Export character | Embed the current linked book, including supported edits and preserved unknown metadata. A chat override does not change character export. |
| Existing cards on upgrade | Expose an explicit Extract embedded lorebook action. Do not automatically activate previously inactive books or change existing chats. |
| Existing chat on upgrade | Resolve absence of the new selection as None, never as a newly inferred character default. |
| Existing prompts | Preserve custom presets. Upgrade only an exact untouched factory preset to the new factory template, transactionally and once. |
| Factory/new prompt | Include enabled lore controls before and after Character plus a control for history placement. Restore original installs the new template. |
| New local book | Scan the latest 4 eligible messages, use a 2,048-token lore cap, disable recursion, and default entries to after-character/system placement. These values are editable starting values, not quality claims. |
| Scan source | Original recent nonempty user/assistant messages, including the pending user input or preview draft. Do not scan summaries, fixed prompts or partial assistant output. |
| Keywords | Case-insensitive literal substring matching unless the entry requests case sensitivity or regex. Do not silently add word-boundary matching. |
| Cap pressure | Admit complete entries deterministically within the lore cap; report exclusions. Once resolved, lore is required fixed input for history planning. |
| Optional lore under pressure | Apply the standard pressure-exclusion directive in the bounded preliminary phase described in section 8, then freeze the final resolution. |
| Historical summaries | Do not include live lore in extraction, promotion or repair inputs; editing lore therefore does not itself stale summaries. |
| Imported unsupported behavior | Show a compatibility notice and preserve data. Unknown extension behavior stays inactive. |

Persist None distinctly from omitted create input. A UI-prefilled selection and the server default must agree. Existing API callers updating a chat without the new field must preserve the saved selection; they must not silently clear or infer it.

If these recommendations are changed, update all affected examples, tests and contracts together before implementation proceeds.

For imports, preserve explicit valid settings. Where an optional setting is absent and the format supplies no different default, use the local-book defaults above: scan depth 4, cap 2,048, recursion off, case sensitivity off, priority zero and after-character placement. Preserve the original absence in export metadata unless that setting is explicitly edited. Required malformed fields are validation errors; format adapters may supply documented legacy defaults but must not pretend an invalid standard field was valid. Book description and entry comments are never prompt content.

## 4. Expected user workflows

### Lorebooks library and editor

Add Lorebooks alongside existing libraries. Show name, optional description, total/enabled entry counts and useful linked-use information. Provide New, Edit, Duplicate, Export and Delete. Add a book-name/entry search where needed to make large imported books usable; avoid rendering every large entry editor at once.

The editor must support book settings and entry creation, editing, duplication, deletion, enabling/disabling and ordering. Entry controls cover the supported matching, content, placement and budget-priority settings. Separate human-facing names/comments from the content actually inserted into prompts. Display validation errors at their source. Preserve unsaved editor input on failed saves and revision conflicts. Save success means server-confirmed commit.

Use existing controls/styles and accessible labels. Long entry content, long names, empty books, no matching entries, unsupported settings and failed imports need understandable states. Desktop and phone-sized layouts must keep actions reachable. Do not introduce a portrait redesign as part of this task.

### Import with a character

Extend current JSON/PNG character import. Keep existing metadata preference and card validation. Parse an embedded book into the normalized model, create the character and book, and establish the default relationship in one transaction. Show the resulting book name/count and compatibility notices in the success result.

A character with no embedded book creates no empty placeholder. An explicitly empty valid embedded book remains a real editable book. A malformed embedded book must produce a useful validation error and leave neither a partial character nor a partial book. A valid book containing unsupported extension behavior can import with notices.

Keep the current card-size policy unless separately changed within approved scope. Standalone book limits can differ, but must be explicit, enforced by the server, and tested. Never truncate oversized entries or discard fields to make an import pass.

For cards already saved with an inactive embedded source, provide Extract embedded lorebook. Extraction must preserve character identity, editable basic fields and historical chats. Repeated extraction with no intervening unlink/change should open or identify the existing extracted book rather than create accidental duplicates. A stale extraction request must fail safely.

### Separate import/export

Accept standalone JSON in the supported source shapes. Detect format from parsed structure, not filename alone. Normalize entry arrays and object maps through explicit adapters. Preserve source order and external identifiers without using those identifiers as ORE primary keys. Reject conflicting/ambiguous shapes with an actionable error.

Use a bounded import preview/review: detected format, book name, entry counts, effective defaults, unsupported behavior and validation failures. A successful command creates the book transactionally. Retrying an ambiguous command with the same command identity must not duplicate it; an intentional second import remains possible.

Offer an interoperable standalone export; preserve imported format when supported, and use the V3 standalone format for new books. Make any explicit conversion choice visible. Overlay edited supported fields onto preserved metadata instead of exporting stale original values. Do not serialize local links, primary keys, command IDs, request history or credentials into external formats. Strip only ORE-internal fields, not unknown imported extensions.

### Character defaults and chat selection

Add a default lorebook selector to the character editor, plus an Open book action. Link an existing book or choose None. Editing a linked book affects future requests in selecting chats; say so in the same manner as other shared records.

Add a single Lorebook selector to New chat and Setup, including None. Saving a selection must not rewrite the transcript, greeting, saved summaries or historical request bodies. The server validates that the selected record exists and enforces one selected book regardless of UI behavior.

Use stable relation identities/order or an equivalently extensible contract internally; do not build multi-book merging or additional selectors now. Reject a second attachment on the server instead of silently retaining only one.

Block deletion while a book is linked by a character or selected by a chat. Explain where it is used. Unlinking/deleting a character must not delete a separately stored book. Do not invent cascading data loss.

## 5. Domain model and persistence

Add shared Zod schemas/types for normalized books, entries, supported placements, import options/results and compatibility diagnostics. Keep source preservation separate from active normalized policy. Browser-safe contracts must not expose server internals.

Each book and entry needs a stable local identity. Book revision checks must cover entry mutations and reordering. Preserve entry identity across edits/reorder; duplication/import creates new identities. Retain original external IDs separately for export. Request snapshots must remain understandable after subsequent edits or deletion, without loading current entry text.

There must be one authoritative editable book. The character's preserved raw source must not become a competing active copy. Export adapters receive the resolved linked book explicitly; core card code must not query persistence.

Use the existing library persistence model unless tracing demonstrates a concrete reason to change it. Extend library kind validation, schema types, snapshots, selection validation, revision propagation, API routes and delete-in-use checks together. Do not leave legacy saveSettings, direct HTTP callers or character duplication paths behind.

Reuse short transactions, global shared-edit blocking during response/preparation work, library revision checks and affected-chat revision bumps. Include books selected independently of characters. Capture/recheck the relevant book revision and chat selection at commit boundaries; UI disabling is insufficient. Preserve independence of generation in unrelated chats.

Register a new versioned migration; do not edit applied migrations or assume the next version from this brief. Cover fresh creation and upgrade from a populated current database. Preserve every existing identity, revision, transcript, manual correction, selection, credential and historical request except for an explicitly approved factory-prompt upgrade. Old request records lacking lore metadata remain valid and mean metadata unavailable, not an invented empty activation report.

## 6. Activation engine

Own matching/selection policy in a pure core module. Make inputs explicit: book revision, original scan messages with source identities/revisions, selected names, applicable directive state and placement availability. Return resolved candidate/admitted/excluded entries, reasons, resolved text, destinations and any proposed state transition. No database, React, Fastify, provider or network dependencies belong in this policy.

### Scanning and matching

Flatten eligible original turn parts in chronological role order, excluding empty strings and unfinished assistant output. The greeting is an ordinary completed assistant message. A preview draft replaces the hypothetical pending input for that preview; never count the same text twice. Count scan depth in eligible messages, not completed turns. A zero depth scans no original messages; constants can still qualify. Preserve message boundaries: keywords must not match by concatenating the end of one message with the start of another.

Compaction does not change the scan window. Recent archived original messages remain eligible if inside that window. A missing Messages marker prevents sending transcript turns but does not by itself disable an explicitly enabled lore control. Summary-off mode still permits lore and uses the same scan rules.

Apply the current one-pass name resolver consistently to supported lore content and match keys. Unknown macros stay literal and receive a compatibility notice when relevant; do not create the separately deferred general macro engine. Do not mutate stored text during activation.

Handle disabled, empty, primary/secondary-key, constant and regex cases explicitly according to the selected standards profile. Use deterministic Unicode-aware case handling without changing preserved source text. Spell out normalization and test multilingual text. Never introduce regex semantics for a literal key merely because it contains punctuation.

Invalid imported regex makes that entry nonmatching with a diagnostic. Do not run untrusted backtracking patterns unrestricted on the server event loop. Use bounded execution/isolation with built-in Node facilities while keeping the evaluator framework-independent, or bring a concrete alternative to the coordinator before introducing a dependency. A timeout/resource failure must fail resolution actionably before any paid call; do not silently treat it as no match. Bound worker concurrency, caches, recursion and imported sizes; clean up cancelled/superseded work.

### Admission, ordering and recursion

Keep admission priority separate from final insertion order. Proposed admission order: descending priority (missing priority is zero), then constants first among equal priorities, then ascending insertion order, then preserved source order. Constants bypass keyword conditions, not higher-priority admission. Final placement order follows insertion order and a stable tie-breaker. State this policy in the UI/help and tests.

Use the shared reference token counter on fully resolved lore, including actual separators/framing. Admit whole entries within the effective book cap. Continue considering smaller lower-ranked entries after an oversized exclusion. Constants bypass keyword activation, not the cap. Never duplicate an entry because several keys matched.

When recursion is enabled, only admitted, actually placeable content can trigger further entries. Process deterministic rounds, keep already admitted entries, and use visited identities so cycles terminate. Recursive discoveries do not evict previously admitted direct entries. Enforce a bounded pass count; reaching a safety limit must be reported, not mistaken for complete resolution. With recursion disabled, entry text cannot trigger other entries.

Resolve eligible destination controls before budget admission. Entries excluded by a disabled/missing destination must not consume the cap or trigger recursion. Standard-specific precedence takes priority over the proposed tie-breaking rules where the standard actually specifies it.

### Standard directives with state

Some standard V3 directives depend on prior matches even though SillyTavern timed-effect extensions are deferred. Do not mistake those two scopes for each other. Implement the applicable standard directives, with durable per-chat state where needed, and test restart behavior.

Proposed lifecycle: previews, plans and preparation steps are read-only. A successful roleplay response atomically commits its activation-state delta with response completion; failure, cancellation, interruption and duplicate commands do not advance it. Use actual admitted entries, not merely keyword candidates. After/every directives count original completed nonempty assistant messages specifically, including a copied greeting, never user messages or summary-layer counts. Preserve state between retries until a response succeeds.

Record state provenance by chat, book/entry identity, activation epoch and relevant semantic fingerprint. The proposed reconciliation rules below also require product review with section 3:

| Event | Proposed state behavior |
| --- | --- |
| Switch book or choose None | Retain each book's state independently. Returning to an unchanged book resumes its own state; never transfer state between books. |
| Change matching/content/placement/priority of an entry | Start a fresh state epoch for that entry. Keep old request provenance immutable. |
| Change book activation settings | Start fresh state epochs for affected entries. |
| Rename book/entry or edit a human-only comment | Preserve activation state; a cosmetic revision is not a semantic reset. |
| Add/duplicate/delete an entry | New identities start unused; deleted entries lose current state; remaining entries retain theirs. |
| Edit/delete a transcript turn or replace history | Start a fresh chat activation epoch atomically. Do not simulate/replay old paid requests or rewrite historical events. Explain this consequence when stateful directives are in use. |
| Change selected character/persona, or their resolved names | Start a fresh activation epoch because matching/name inputs changed. |
| Change prompt placement, target or Connection | Preserve past-match state; recompute current eligibility/placement without retroactive events. |
| Clear memory or edit/repair a summary | Preserve lore state; these operations do not change the original transcript. |
| Failed/cancelled/interrupted request or explicit retry | Leave committed state unchanged until one response successfully commits. |

Keep fingerprints explicit and versioned. Avoid an unrelated book revision resetting every entry. Capture the epoch with an in-flight operation and reject a stale state delta. Do not manufacture historical matches when enabling a previously unused stateful directive. Implement and test these rules rather than leaving the lifecycle as an unresolved TODO.

## 7. Prompt authority and placement

Add explicit lore controls to Prompt presets. Use distinguishable before-character, after-character and in-history destinations, or an equivalent clear configuration. Each destination has at most one enabled insertion control. Their order, enabled state and default role must remain inspectable/editable. No selected book means no inserted lore. A missing/disabled destination means no implicit insertion at that destination.

Before/after-character controls are ordinary explicit preset positions. For history-relative placement, the enabled control authorizes insertion into the Messages expansion; absence of Messages makes that destination unavailable. If a standard directive defines a fallback, apply it only through a corresponding enabled fallback lore control; otherwise omit that entry and explain the unavailable destination. A fallback cannot bypass prompt authority. Do not insert a synthetic transcript turn or move the saved cutoff. Apply depth to the outgoing eligible history messages, clamp beyond-history depth at its beginning, and preserve whole stored turns for history selection. Depth placement may interleave outgoing messages but must not split text or change turn membership/coverage.

Honor supported entry roles within the explicitly enabled lore destination. Do not implement provider assistant prefill as a side effect. Field-relative standard positions can target only explicit active field/composite-character content; if unavailable, apply the standard's fallback and report it. Never re-enable a missing character source to create an anchor.

The implementing agent must show the proposed marker contract and placement/decorator coverage table before changing shared contracts. Pay particular attention to combined Character markers, separate field markers, repeated character sources, disabled blocks, no Messages and an empty preset. Keep no-lore requests byte-for-byte unchanged where the approved factory upgrade does not apply.

Keep generic reusable-preset warnings separate from chat-specific diagnostics. An explicit empty preset remains saveable and an empty resolved request still fails before transport.

## 8. Budgeting and context integration: critical invariant

**Resolve lore from explicit original scan input, never from whichever reduced turn list a budget calculation happens to assemble. Reuse one resolution across alternative memory representations of that same request.**

Current context planning assembles minimum-required requests from reduced verbatim history. Manual reselection and saved-summary reuse also measure hypothetical representations. Scanning those subsets would change activation and corrupt fit/savings decisions. Trace every assembleRequest caller, including context-plan, context-refresh, context-reuse, persistence savings validation, previews and final generation.

Create a coherent request-resolution context carrying immutable activation input/result and relevant revisions. A core representation change may remeasure placement/framing, but must not rescan a different transcript or advance state. If regex work is asynchronous, perform it before pure candidate planning and pass the result explicitly. Guard previews against stale completions after draft/chat/settings changes.

Capture this context at the originating generation/preparation operation boundary and carry it through every committed compaction step; reloading a newer context snapshot must not create a fresh lore decision halfway through the same operation. Persist the information needed for inspection/recovery with that operation. A later explicit retry is a new attempt and may resolve against current inputs, while still observing command idempotency and leaving already committed summaries intact.

The standard pressure-exclusion directive requires one explicit preliminary phase before that result freezes. First resolve ordinary candidates/cap admission from the original scan input. Test the current committed managed representation against the effective ceiling (the smaller of target and physical capacity after output reservation). In recent-history mode, pressure also exists when that tentative request would have to exclude completed history to fit. If pressure exists, make pressure-optional entries ineligible, recompute admission/recursion once from the same scan input so their dependent activations cannot survive accidentally, and freeze this second result. Otherwise freeze the first result. Report pressure exclusions. Never reintroduce those optional entries during later compaction/reselection of that attempt, and never let this preliminary phase mutate saved history or activation state. This bounded two-pass policy is a proposed ORE interpretation of an upstream underspecified pressure rule and needs review with section 3.

Apart from that explicit preliminary exception, resolve the lore cap independently of whichever candidate history representation happens to fit. Include final admitted lore in fixed input before selecting history. Do not create a loop that alternately drops lore and restores history. If fixed blocks, required pending input and final admitted lore cannot fit, fail clearly; the user can lower the lore cap, change entries or adjust the target. Cap/directive exclusions are explicit lore-policy outcomes, not silent transcript truncation.

Use authoritative complete-request measurement with cl100k_base for previews, manual Prepare, single-step work, automatic preparation, saved replacement checks and generation. Include roles, separators, destination placement and pending input. Retain target/physical-window/output-reservation separation. Preserve fixed batches, protected tails, residual turns, saved correction protection, no-call saved reuse and ordinary selection stability.

In Summary-off mode, budget lore first and then select the newest contiguous suffix of whole turns. Do not silently split/skip turns to rescue an oversized required request. In Summary-enabled mode, lore-induced pressure may trigger normal preparation, but cannot authorize a different compaction policy.

Keep live lore out of extraction/promotion/repair requests. Editing lore changes future roleplay input and may change budgets; it does not rewrite historical requests, clear memory, automatically restore old detail or invalidate summaries which never consumed it.

## 9. Inspection and history

Add a Lore allocation to the existing budget/prompt inspection surfaces. Show the selected book, admitted entry names, exact resolved content, destinations/roles, token contribution and activation reasons. Explain relevant exclusions: disabled, no match, secondary condition, cap, unavailable destination, unsupported directive and invalid pattern. Large diagnostics should be bounded/paginated and fetched on demand rather than attached in full to every SSE refresh.

New saved roleplay requests must retain enough immutable lore provenance to explain what actually went out: resolver version, book/entry identities and revisions, scan-source references, relevant settings/state, admitted/excluded outcomes, and resolved inserted text/placement. Keep this inspection metadata outside the provider body. Snapshot display labels/text needed after a library edit or deletion; do not reinterpret old requests using today's book.

Historical records with no lore metadata show it as unavailable. Current previews with drafts are hypothetical and never write activation state. Exact provider messages remain the final authority for what the model received. Do not label successful keyword matching as semantic relevance or guaranteed model recall.

## 10. Server/API and recovery

Extend established library/import/export and chat-selection APIs rather than building a parallel server. Validate all external shapes, bounds, roles, IDs, revisions, indexes, pattern flags and entry destinations at their trust boundaries. Explicitly map safe public fields.

File analysis/import creates no model requests. No embeddings, external retrieval service or automatic paid retries are authorized. Preserve authentication, origin checks and credential exclusion. Treat JSON, card metadata and model-facing lore as untrusted text/data, not executable HTML/scripts.

Parsing/validation completes before mutating saved data. Import commits all coupled records or none. State-bearing commands use durable identities so lost acknowledgements can be retried without duplicate effects. Repeated explicit imports with new identities may create separate books; do not deduplicate by content or name without agreement.

Generation still belongs to the server. SSE observer disconnection cannot cancel it. Reject late results after cancellation/supersession and recheck captured selections/revisions before response/state commit. Restart retains committed books, selections, lore state and completed summary steps; it must not automatically repeat paid work.

## 11. Suggested implementation ownership and sequencing

The coordinator owns product clarification, shared contracts, integration order and final review. Use one implementing agent for a coherent vertical slice, or delegate bounded work after contracts stabilize. Do not have several agents independently redesign the same resolver or edit shared integration files concurrently.

1. Trace workflows; present the defaults/ambiguities, contract sketch, placement matrix, migration plan and state reconciliation policy to the coordinator. Add independent format fixtures and failing tests for required behavior.
2. Implement shared models, adapters and pure activation policy with deterministic focused tests.
3. Implement migrations, relationships, transactional imports, revisions, durable state and API commands with real temporary SQLite tests.
4. Integrate the one resolution context through authoritative assembly, context planning/reuse/savings and historical request metadata. Verify exact model input through the local mock provider.
5. Implement library/editor/import review, character defaults, chat selection and inspection. Exercise browser workflows and both viewport sizes.
6. Review the entire final diff and affected callers; update product/implementation/subsystem documentation; run complete required checks against final changes.

Likely ownership map:

| Area | Existing integration points |
| --- | --- |
| Public schemas | src/shared/library.ts, src/shared/contracts.ts, src/shared/context.ts where needed |
| Core adapters/policy | src/core/cards.ts, new focused lorebook modules |
| Assembly/budgeting | src/core/prompt.ts, context-plan.ts, context-refresh.ts, context-reuse.ts and their callers |
| Persistence | src/persistence/store.ts, context-store.ts, schema.ts, migration registration and new versioned migrations |
| API/coordination | src/server/app.ts, coordinator.ts, context-coordinator.ts, card-import.ts |
| UI | src/web/Libraries.tsx, PromptPeek.tsx, Memory.tsx, App.tsx and existing controls/styles |

This is a tracing map, not permission to rewrite these files wholesale. Extract cohesive lorebook responsibilities; keep provider transport free of activation/history policy. Preserve pre-existing changes.

## 12. Required automated evidence

Use deterministic synthetic/copied fixtures, temporary databases and the local mock provider. No active database, original transcript or saved credentials may be used for destructive tests. Add behavior tests, not implementation-shaped assertions.

| Area | Required scenarios |
| --- | --- |
| Formats | Embedded V2/V3 JSON/PNG; standalone supported shapes; empty book; malformed nested input; unknown metadata/IDs preserved; edited values survive export/reimport; unlink cannot resurrect raw embedded data |
| Import transactions | Character/book/link success; forced failure rolls all back; stale library revision; lost-acknowledgement retry; deliberate duplicate import; extraction is safe and repeatable |
| Selection/ownership | Default vs explicit None; old-chat absence; character changes preserve chat selection; independent chat override; shared edits affect subsequent requests; delete-in-use protection; duplicate/link ownership |
| Activation | Literal/Unicode/case rules; message boundaries; every primary/secondary/constant combination; zero and boundary scan depths; greeting/pending/draft/blanks; no partial output; valid/invalid/timed-out regex |
| Recursion/order/cap | A to B; A/B cycles; repeated matching inserts once; disabled/unplaceable/excluded content cannot trigger children; recursion off; deterministic ties; exact-fit and one-over cap; oversized entry followed by a smaller fitting entry |
| Placement | Every supported destination/decorator; roles/depth/clamping; precedence/fallback; missing/disabled/repeated markers; missing Messages/character anchor; empty preset; no-lore requests unchanged |
| Standard state | Preview/plan is read-only; successful atomic response commit; cancellation/failure/interruption; explicit retry and duplicate commands; restart; entry edits/selection/history changes use reviewed reconciliation rules |
| Context integration | Same scan input through reduced-history required checks, reuse and reselection; pending input triggers lore before planning; managed/recent modes; protected-tail overflow; fixed batches; no-call saved reuse; complete-request savings; no lore in summary/repair requests |
| Historical integrity | Book/entry rename/edit/unlink/delete does not change old provider bodies, estimates, provenance or displayed inserted text; old metadata-free requests remain readable |
| Migration | Fresh database; populated upgrade preserving all unrelated records; exact factory-only upgrade; custom/edited prompts intact; interrupted migration rollback; restart does not reapply |
| UI | Create/edit/save/reopen; embedded and separate import review; compatibility notices; selection/None; shared-edit/revision failures preserve input; inspection matches saved state; desktop and phone-sized layouts |
| Bounds | Representative large synthetic book and long chat; bounded scan/caches/workers; no unbounded repeated history scans or UI freezes; cleanup after timeout/cancel |

Extend tests/libraries.test.ts, prompt-control tests, context core/application/reuse/refresh suites and relevant browser suites. Create focused new suites where cohesive. Establish regressions before fixes when feasible.

Run focused tests during development. Before application handoff, run npm run check (or all constituents successfully against final changes), using README's supported Node environment. Build before browser tests. Report exact blockers rather than claiming skipped checks passed. Passing mock checks does not establish real-model lore usefulness, perfect recall or actual phone behavior.

## 13. Documentation and handoff acceptance

Update CONCEPTS.md only with accepted product decisions; IMPLEMENTATION.md with implemented contracts; README.md with actual workflows/formats/limits; and a focused subsystem document with resolution, compatibility and provenance details. Keep this assignment clearly separate from implementation status. Do not put a feature diary in AGENTS.md.

Before completion, the implementing agent must supply:

- User-visible outcome and compatibility coverage, including preserved inactive features.
- Migration and state-reconciliation behavior, with evidence of populated-upgrade preservation.
- Exact tests/commands run and their results, plus any unresolved limitations.
- A final diff review tracing changed behavior through planning, persistence, previews and generation.
- A short manual acceptance path: import a card with a book; inspect its new library entry; create a chat using its default; trigger a known entry; inspect exact outgoing lore; choose None; select a separately imported book; edit it; verify the old saved request stays unchanged.

The assignment is complete only when this full lorebook workflow and its failure/recovery paths are implemented and verified. Creating the library tab or parsing book JSON alone is not completion.
