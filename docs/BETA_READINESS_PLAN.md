# ORE: assessment and private-beta plan

Assessment date: 2026-10-19. Code baseline: `b351db4`; the working tree was clean when assessment began.

This is a proposed delivery plan, not authorization to implement every recommendation. The user confirmed a private beta for themselves and a few invited testers, each running an independent local installation, with English and Russian available at launch. The accepted application architecture remains unchanged.

## Recommended checkpoint

Aim for **Private Beta 1: dependable local roleplay in English and Russian**. A tester should be able to install ORE, configure their own Connections, import a supported character and an ongoing conversation, prepare memory, continue the story, inspect what was sent, correct memory, restart, and recover their data without developer intervention.

The application has a substantial working core. It is ready for a stabilization milestone, but the available evidence does not yet justify inviting testers to entrust it with their only copies of long-running stories. The largest gaps are recoverability, long-chat responsiveness, localization, reproducible installation, and real-model memory evaluation. Completing every cosmetic card would not close those gaps.

Updated delivery direction: single-owner local installations, text Chat Completions, supported JSON/PNG cards and transcript imports. The user requests Windows delivery as an executable with a supporting folder, and macOS/Linux Bash build procedures with contained dependencies. Each advertised platform needs native installation/runtime verification. Desktop use is the baseline. Phone access is a separately verified capability: either complete HTTPS and real-device checks before advertising it, or explicitly exclude phone use from this beta's supported matrix. No shared hosted service or multiplayer work is needed.

The user's CHARX decision supersedes the other agent's recommendation: **no CHARX export, opaque asset archive, or preservation of unsupported package contents**. CHARX itself is not a beta requirement. If useful later, add only bounded extraction of ORE-compatible fields, with a clear import report. Existing JSON/PNG metadata preservation need not be removed to implement this narrower package policy.

## Current state and evidence

| Area | Assessment |
| --- | --- |
| Persistent chat | Implemented: independent chats, streaming, cancellation/retry, response variants, reasoning inspection, local composer drafts, request inspection, and restart recovery. |
| Prompt and context engine | Implemented: explicit markers, shared request assembly/token measurement, budget-driven layered compaction, saved reuse, manual corrections, reviewed repair, dependency tracking and immutable historical requests. This is the central product strength; avoid rewriting it for the beta. |
| Libraries and cards | Implemented: Connections, characters, personas, prompts, context presets, lorebooks, search, character tags/pictures, alternate greetings and explicit card-instruction controls. Remaining card work is bounded interchange/metadata work, not a new card engine. |
| Data safety | Transactional storage, revision checks and crash tests exist. A dependable user backup/restore workflow is not provided. Credential storage remains plaintext in the private local database; backups therefore contain secrets. |
| Long conversations | Full-history refresh and rendering are still present. The user's slowness report has credible implementation-level causes, but browser profiling is needed to attribute time between server, transfer, parsing and rendering. |
| Localization | UI and many server/core messages are English literals. No runtime language-pack system was found. Russian dialogue formatting is separate from localization. |
| Delivery | A Mac launcher and installation instructions exist. The launcher rebuilds on each start and can use this developer machine's Codex runtime fallback. Installation and upgrade on a clean tester machine remain unverified. |
| Real-world evidence | README records a successful OpenRouter response on 2026-10-16. This does not establish current real-model compaction/repair quality, broad endpoint compatibility, or actual phone behavior. |

Evidence was gathered from the current code, project documents, existing tests, and the chat titled **Review character card compatibility** (`01a1536d-0c91-78f2-bb71-6ddf7ce34bf6`). That review is useful for metadata/export gaps, but its recommendation to build full CHARX interchange is superseded, and its statement that card prompt overrides remain entirely inactive predates the implemented explicit permission controls.

Important source paths:

- [Chat loading/rendering](../src/web/App.tsx), [snapshot reads](../src/persistence/store.ts), [public snapshot mapping](../src/server/app.ts), and [context snapshots](../src/persistence/context-store.ts).
- [Card adapters](../src/core/cards.ts), [PNG import](../src/server/card-import.ts), [pictures](PICTURES.md), and [card instructions](CARD_INSTRUCTIONS.md).
- [Libraries and duplication](../src/web/Libraries.tsx), [turn controls](../src/web/TurnControls.tsx), [Prompt peek](../src/web/PromptPeek.tsx), and [stored schemas](../src/persistence/schema.ts).

### Long-chat findings

`App.refresh` fetches the library update and then the selected chat snapshot. SSE notifications trigger that refresh. `Store.snapshot` loads all turns, response variants and generation records, including saved request bodies; context snapshots also include all summary versions and the latest 20 jobs. The public mapping strips detailed lore data but retains historical request messages. Story maps every turn into the DOM; navigating back remounts the transcript. Memoized Markdown helps, but does not bound the overall work.

A synthetic probe used real in-memory SQLite and the ordinary history-replacement/snapshot paths, with approximately 200 input and 800 response characters per completed turn. No real database, provider, browser or network was involved:

| Fixture | Source text | Serialized internal snapshot | Snapshot read | Serialization |
| --- | ---: | ---: | ---: | ---: |
| 1,000 turns | 999,890 characters | 2,246,387 bytes | 7 ms | 2 ms |
| 10,000 turns | 10,008,890 characters | 22,469,388 bytes | 46 ms | 19 ms |

These single-run numbers are a lower-complexity illustration, not latency guarantees: the fixtures had no generation history, summaries, artwork or lore. Saved selected response text also appears in its variant. Real request history can add considerably more data. Loading feedback is necessary, but cannot by itself fix repeated transfer and remount costs. The production build also reports a 1.64 MB main JavaScript chunk before gzip (about 644 KB gzip); profile its startup contribution before deciding how much code splitting is worthwhile.

### Verification performed for this assessment

- Production build and strict TypeScript checks passed with Node 24.19.0.
- The first full-check attempt could not exercise local-server tests under the restricted environment. A direct loopback-listen probe returned `EPERM`; that run was stopped and restarted with local networking allowed. Its timeout failures are not counted as established application regressions.
- The network-enabled `npm run check` passed: build/typecheck, **581 Vitest tests across 34 files**, and **75 Playwright tests**. The browser suite includes desktop and phone-sized workflows; it does not establish actual phone support.
- The synthetic snapshot probe above completed successfully.
- A separate in-memory card-adapter probe confirmed the export/version and malformed-metadata cases described in package 4.
- No saved user database or original transcript was used, and no real-provider request was made. Actual phone behavior, clean-machine installation, restore reliability and narrative quality were not verified here.

## Disposition of all 18 cards

“Beta” below is a recommendation for the checkpoint, not a claim that a feature is already accepted or complete. Existing MVP labels are retained as beta priorities.

| Card | Current state | Proposed disposition and completion criterion |
| --- | --- | --- |
| S1. Avatar support for persona & character cards — MVP | Character library pictures, import, crop, replacement, removal and duplication exist. Persona pictures and chat/selector avatars do not. | **Beta:** split the card into completed character-library work and remaining persona portraits. Reuse the existing image pipeline with proper persona ownership and transactional save/retry behavior. Scope initial display to libraries/editors; decide separately whether Story/selection avatars are required. |
| S2. Localization — MVP | Not implemented as a system. | **Beta:** complete EN/RU UI, validation/error presentation, dialogs, accessibility labels, plural/date/number formatting and runtime JSON language packs. Adding a pack must not require rebuilding JS. |
| S3. Complete character card support — MVP | JSON/PNG import, basic V1/V2/V3 fields, greetings, artwork, linked lorebooks and preset-authorized instructions exist. JSON export exists; updated card PNG export does not. | **Beta:** rename to “ORE character-card compatibility profile.” Finish current-artwork PNG export, creator metadata, import/compatibility reporting and supported-field round trips. No full external-engine equivalence or CHARX export. |
| S4. App name on OpenRouter | No attribution headers in the provider adapter. | **Optional before beta:** a small transport change once a stable app URL is chosen. Cover roleplay, summaries/repair and diagnostic generation consistently; limit attribution to the intended host. Verify actual display separately from mock header tests. |
| S5. Better expand/collapse arrows | Prompt blocks already have collapse controls with accessible names, using text glyphs `⌃` / `⌄`. | **Polish:** replace the glyphs with consistent chevrons, retaining keyboard behavior and expanded state. Small enough to bundle with the final UI pass. |
| S6. Update documents / clean repository | Extensive documentation exists, with historical/proposed material mixed with current descriptions. Some descriptions lag code. | **Beta:** consolidate current operational guidance, support limits, upgrade/recovery steps and compatibility claims. Keep design history identifiable; avoid unrelated refactors or deleting useful fixtures. |
| S7. Import/export summaries | Inspection exists; portable summary import/export does not. | **Split:** readable per-layer text export is useful early beta work. Lossless JSON/JSONL import is a separate, higher-risk follow-up because identities, source revisions, corrections and dependencies must be restored coherently. A verified full backup is the beta recovery requirement; summary interchange is not its replacement. |
| S8. Names for summaries | Range/layer/version labels exist; no user-assigned title field. | **Early beta improvement:** human-only optional labels, initially edited manually; range remains visible as fallback. Avoid adding paid model title generation. Keep labels out of model input unless separately requested. |
| S9. Scalable chat text | Fixed styling; no independent user text-scale setting. | **Beta:** saved reading-size preference independent of surrounding controls, with usable composer/editing behavior and no changes to saved prose or model input. Verify scroll anchoring and phone layout at extremes. |
| S10. Character colors | Quoted/direct speech is already styled using a constant color. No per-character color selector. | **Early beta improvement:** expose named speaker/speech/accent settings with readable defaults and reset. Keep visual choices independent of prompt revisions and memory. |
| S11. Duplicate saved API key | Duplication deliberately omits the key and tells the user to add one again. | **Beta:** a server-side duplicate command copies the Connection and its credential atomically. Never fetch the secret into the browser. Verify independence, no-key copies, revision conflicts, exact retry and secret exclusion. |
| S12. View request on each turn | Central saved-attempt inspector exists; no turn shortcut. An earlier decision removed the old shortcut. | **Beta:** the latest task supersedes that removal. Open the selected response variant's exact saved attempt; allow inspection of failed/pending attempts where a request exists. Imported turns/greetings must say no saved model request, without inventing one from today's settings. |
| S13. Defaults for prompts, Connections, context prompts | New chats use hard-coded selections: built-in prompt, first Connection or None, no context preset. | **Beta:** owner-level new-chat defaults for Connection, Prompt preset and Context preset. The chosen context preset continues to own its summary Connection/prompts. Apply only at creation, retain older chats, and define deletion/missing-default behavior. |
| S14. Long-chat loading and feedback | Whole snapshots and transcript rendering; limited loading feedback. | **Beta blocker:** profile and bound work, preserve reading position, show honest progress/status and offer retry. Include returning from Settings/Memory and streaming while another chat runs. |
| U1. Remove Edit setup / Inspect memory | “Edit setup” is absent; “Inspect memory” is present in Story's sidebar in current code and docs. | **Reconcile, not blindly close:** determine whether this meant removing old duplicate controls. Current navigation intentionally exposes Chat settings, Memory and Request inspector. Any removal must retain discoverable access, including stale-memory recovery. |
| U2. Prompt peek folders | Individual messages collapse and expanded Character fields group. Summary is still one combined message; active turns are not a collapsible group. | **Beta:** group for inspection in request order, with summary subranges and individual turn parts. This is display structure only: preserve byte-for-byte outgoing message text/roles/order. Historical views must use historical metadata, never today's summary contents. |
| U3. Last update in Chats | Not exposed; chats have no persisted creation/update timestamps. | **Beta:** add durable timestamps with a defined activity policy and honest unknown values for old records. A migration date is not the original creation date. |
| U4. Library sorting | Search/filtering exists; no sort selector or general creation/update timestamps. | **Beta:** compact dropdown beside each library search bar, stable Name/Created/Updated ordering and sensible defaults. Implement with U3's timestamp migration; preserve filtering and selection. |

OpenRouter's current official instructions use `HTTP-Referer` plus `X-OpenRouter-Title`; the title alone does not create an app page. See [App Attribution](https://openrouter.ai/docs/app-attribution). The plan does not choose a public URL or create a public listing.

## Delivery sequence

The packages below have independent acceptance gates. They are ordered by risk and dependency, not by cosmetic visibility. No calendar estimate is warranted until the performance profile and delivery scope are settled. Relative sizes: S = focused change; M = several coordinated paths; L = cross-cutting work with substantial regression coverage.

### 1A. In-app backup, inspection, append import and wipe — L

The user selected an application UI, rather than a command-line-only recovery utility: Save backup, inspect all saved content through a tree, import into the existing database, and wipe content before a fresh import if desired. Overlapping record IDs are listed for confirmation and overwritten after acceptance. Equal names are not matches; automatic duplication/version merging is not the chosen policy.

The [backup implementation assignment](BACKUP_IMPLEMENTATION_BRIEF.md) defines aggregate replacement, shared-reference handling, staged validation, atomic commits, stale-client protection, exact retries and test cases. Its wipe default retains local owner authentication and required factory state while clearing user content; this is called out explicitly rather than silently treating wipe as account reset. Login recovery is a separate follow-up, not added to these two tasks.

**Gate:** populated save → inspect → wipe → import → restart and overlapping-backup tests preserve the intended data; failures do not produce partial replacement. No automatic provider calls, leaked credentials or stale writes after restoring older revisions. This is larger than the earlier simple backup utility estimate because it includes inspection and database merging.

### 1B. Release procedure and contained delivery — L, platform-dependent

A release is an exact commit on `main`; a version tag is a recommended stable label. Deliver Windows `ORE.exe` with supporting files, plus macOS/Linux Bash build/start procedures. Keep runtimes, dependencies and caches in ORE-owned locations, preserve user data on update, and avoid global installation or shell changes.

The [release assignment](RELEASE_IMPLEMENTATION_BRIEF.md) owns shared layout, path resolution, reproducible inputs, startup/update behavior and documentation. The [Windows handoff](WINDOWS_RELEASE_HANDOFF.md) is its platform subtask for a supplied Windows machine; it must validate the packaged native dependencies and worker processes. Preparing scripts/artifacts does not authorize remote publication.

**Gate:** clean installation and packaged-runtime checks on every advertised platform, populated upgrade/recovery, offline repeat startup and dependency-containment evidence. Unavailable Windows/Linux tests remain explicitly pending, even if the Mac source suite passes.

### 2. Make long chats responsive and observable — L

**Outcome:** opening a long chat and returning from tools feels immediate enough to use, while generation and memory remain authoritative on the server.

- Record time to visible transcript, time to interactive composer, API bytes, parse/render time, memory use and streaming refresh cost at 1,000 and 10,000 turns, including variants, summaries and saved requests. Use synthetic fixtures near the supported text-size limits.
- Split routine browser state from historical request bodies, full variants, summary versions and preparation details. Fetch inspection content on demand with revision-aware identities and pagination. Do not merely remove fields after loading/parsing their entire contents from SQLite.
- Coalesce overlapping refreshes and avoid rebuilding unchanged panes. Load/render a bounded transcript window while retaining server-side full-history algorithms. Keep older turns reachable; preserve an anchor when adding earlier pages and when returning from Settings/Memory. Do not truncate model history as a performance shortcut.
- Preserve server-owned generation on disconnect, reconciliation on reconnect, stale-response rejection, draft recovery and exact historical request inspection.
- Show “Loading chat/history” immediately, then failure/retry if needed. Use percentages only where total work is measurable. Keep current useful content visible during refresh where safe.

**Owners:** public contracts, targeted persistence reads, server snapshot/SSE flow, App, transcript scrolling and inspection components. Core budgeting/coverage policy stays unchanged.

**Proposed measured targets:** visible loading feedback within 100 ms; warm return to a 10,000-turn chat usable within 500 ms; cold open usable within 2 seconds on the nominated reference Mac. Record hardware and p50/p95 across repeated runs. These are proposed acceptance targets, not current performance claims. Test another chat's stream without repeatedly transferring this chat's whole history.

**Gate:** bounded API/DOM work plus browser tests for pagination, reading position, edits, regeneration, request selection, reconnect and draft survival. Verify the same final requests and saved coverage as before the refactor.

### 3. Add the settings/localization foundation and daily-use controls — L

**Outcome:** users have reliable defaults, reading preferences, discoverable history and useful library ordering.

- Establish a runtime message catalog before adding more UI copy: stable keys, typed parameters, EN fallback, language manifest, pack validation and cache invalidation. Serve data-only JSON packs from a documented local directory outside bundled JS. New packs become discoverable on reload or documented restart without a rebuild. No executable translations or arbitrary HTML.
- Use existing `Intl` support for number/date/plural formatting, including Russian forms. Introduce stable error/warning codes and structured safe parameters where server/core prose currently crosses the UI boundary; retain a readable fallback for unknown errors and older saved records.
- Keep UI language separate from chat language, card text and editable model prompts. Switching UI language must not rewrite stored stories, summary text, prompt presets or historical requests. Translation of default model instructions would be a separate product decision.
- Define preference ownership once: propose browser-local UI language/text size and owner-wide new-chat defaults. Decide whether any preferences must sync across the owner's devices before committing their storage design.
- Implement S11–S13, U2–U4 and text scaling. Add real timestamps transactionally at the owning mutations; distinguish creation, record edit and chat activity. Avoid reordering chats on every token checkpoint or a background estimate. Represent unknowable legacy dates honestly.
- For Prompt peek, add server-derived source spans for summary display without changing the combined provider message. Keep old requests inspectable when this new attribution is unavailable.

**Owners:** shared settings/catalog contracts, server error mapping, persistence migrations/defaults/duplicate command, Libraries, TurnControls and PromptPeek. Reuse existing inspection and image controls.

**Gate:** timestamp upgrade preserves populated data; defaults do not alter existing chats; credential duplication never exposes secrets; stale/missing selections fail intelligibly; grouped peek agrees exactly with request text. Test language fallback, malformed packs, a new pack without a build and UI language changes with a populated chat.

### 4. Complete the bounded MVP card/picture work — M–L

**Outcome:** the common character/persona library workflow is complete enough for testers to bring their existing materials.

- Extend portrait ownership to personas through a versioned migration without weakening character-kind constraints. Reuse processing/crop/rendition logic; preserve independent duplicate associations, clean up only unreferenced assets, and keep visual edits out of prompt revisions.
- Expose creator name, version and notes in character import/editor views; show preserved multilingual notes, provenance and timestamps where present without inventing missing values. Keep author metadata human-facing. Broader multilingual-metadata authoring can follow if not needed by the initial corpus.
- Build one authoritative exported card document for JSON and PNG. Export the current saved card and linked lorebook with current full artwork, rather than downloading an original PNG containing obsolete metadata. Keep library crop as a presentation setting. Report unsupported artwork/animation conversion clearly.
- Define tolerant import and explicit export/version policy. The current adapter forces V3 `spec_version` to `3.0`, does not fill absent `group_only_greetings`, and preserves some malformed human metadata without validation. Resolve these cases with fixtures and compatibility reporting; do not silently relabel future versions or discard unknown JSON fields during unrelated edits.
- Reuse the existing lore/card-instruction diagnostics. Report supported, retained-but-inactive and unsupported data honestly. Normalize metadata-size limits between JSON and PNG instead of increasing all limits indiscriminately.
- Keep CHARX, other legacy schema adapters, remote assets and full SillyTavern behavioral emulation outside this package.

**Owners:** core card normalization/export, shared metadata schemas, server PNG/image processing, persistence picture ownership, CharacterEditor/CharacterImport and persona editing.

**Gate:** JSON/PNG export → reimport preserves supported edits, current lore and intended artwork; test malformed/future metadata, stale commands, rollback, duplicate retries, image cleanup and upgrade. View persona/character editing on desktop and narrow layouts. No original user files are altered.

### 5. Finish English/Russian coverage and onboarding — M–L

**Outcome:** testers can complete the supported workflow in either language.

- Finish catalog extraction across all screens, empty/loading states, errors, validation, warnings, confirmations, accessible names and tooltips. Stable saved event/error codes should support localized presentation where available; preserve old historical diagnostic text rather than rewriting history.
- Review translations for actual roleplay vocabulary: Connection, Prompt preset, Context preset, active/archived turns, selected/retained/stale summaries, Prepare and Repair. Check Russian plurals and longer labels. Do not translate imported/model-authored prose automatically.
- Add a short first-run path that makes the separate roleplay and summarization Connections understandable. Explain why a pending response or stale memory blocks continuation and provide the relevant recovery action.
- Finish navigation reconciliation, collapse icons, documentation and optional OpenRouter attribution. Preserve useful tool access while removing only truly redundant controls.

**Owners:** web/shared/server catalog consumers, onboarding copy and README/subsystem docs.

**Gate:** complete import → setup → prepare → generate → inspect → edit/repair → restart in both languages; missing-key/fallback checks; desktop and phone-sized layout review. New language installation must work against the already-built app. Existing data/model input must remain unchanged by UI-language selection.

### 6. Qualify and freeze Private Beta 1 — M, dependent on real-world results

**Outcome:** a fixed, identifiable build with documented supported workflows and a tested recovery path.

- Run `npm run check` on the release candidate, then clean-install and populated-upgrade smoke tests using the documented runtime. Fix release-blocking regressions before invitations.
- Conduct explicitly authorized real-provider checks with synthetic EN/RU stories and a small named model set: normal response, first-layer extraction, at least one promotion, archived edit/repair and continued roleplay. Record model/endpoint/settings, source facts, outputs, cost/latency and failures. No broad compatibility claim is needed.
- Include durable outcomes, ownership, unresolved commitments, chronology, knowledge attribution and a manual correction in the story rubric. For example, change “Mira gave Leon the key” to “Mira kept it”; inspect both the direct memory and later consumers. Automated structural coverage is not evidence that these facts survived semantically.
- Require every designated critical fact in the chosen smoke corpus to survive the inspected selected memory/continuation, with no invented critical event. Report smaller losses and repeat across several scenarios; this limited gate is not a guarantee of perfect recall. If the model/prompt fails, tune and retest or narrow the advertised configuration before inviting testers.
- If phone access is included, select a reproducible trusted-HTTPS procedure and test a real phone: keyboard, long draft, lock/unlock, background generation, reconnect and repair review. Do not weaken TLS/origin/auth restrictions. Emulation does not satisfy this gate.
- Freeze features, assign a release identifier, publish known limitations and invite the small cohort. Feedback during beta should focus on reliability, memory usefulness and usability before widening formats/providers.

**Gate:** no unresolved data loss, stale-write, secret-exposure, duplicate-command or inaccessible-recovery defect; all mandatory packages above accepted; complete automated results; successful independent installation/restore; real-provider smoke evidence. Remaining cosmetic issues are listed, not hidden.

## Summary interchange follow-up

Keep S7 as an explicit work package after the initial beta gate unless portable memory is essential to the invited testers. JSON and JSONL should be two encodings of one versioned schema, not two independent import rules.

Proposed first scope: export approved summary versions, coverage/dependency graph, manual-correction provenance, selection, configuration and the complete source baseline needed to validate or repair them. Exclude secrets and unapproved review drafts. Define whether this is same-transcript restoration or a full chat bundle before implementation; bare turn numbers cannot identify sources after replacement, deletion or another import.

Import should preview its target and conflicts, verify transcript identities/content/revisions, reject missing or inconsistent dependencies, and commit atomically after revision/idle checks. It must not silently overwrite manual corrections, declare foreign memory fresh, replace a cutoff from labels alone or fabricate old provider requests. Repeated commands must be safe. Unsupported cross-chat mapping should fail clearly rather than guess. Full-backup restoration and transcript/summary interchange remain distinct operations.

Readable export can arrive sooner: one UTF-8 text file per layer, stable chronological order, range/title/version/selected-retained-stale labels and a manifest explaining selection. Decide “selected only” versus “all approved memory” explicitly; do not intermingle old versions as if all were active. Titles can share this work, as human-only metadata. Text export is for reading, not authoritative memory reimport.

## Decisions needed before their implementation packages

1. Confirm the exact Windows/macOS/Linux versions, CPU architectures and browsers to qualify under the accepted delivery direction. Decide whether actual phone support is required for Beta 1 or a separately labelled follow-up.
2. Confirm library-only persona portraits versus avatars also in Story/selectors, and whether current-artwork PNG export belongs to the minimum card profile as proposed.
3. Confirm browser-local language/text-size preferences versus cross-device settings, new-chat default semantics, and which edits count as chat/library “Updated.”
4. Decide whether summary interchange must precede invitations; the recommendation is verified full backup first, readable export early, provenance-safe JSON/JSONL import later.
5. Choose the stable ORE app URL if OpenRouter attribution is included, and explicitly authorize the named real-provider test configuration before paid checks.

These decisions need not block the baseline, profiling, backup design or catalog inventory. They should be settled before their dependent behavior is implemented.

Packages **1A and 1B now have separate agent implementation briefs**, with a Windows subtask for 1B. Shared packaging work can begin independently of backup UI work; full cross-platform backup/upgrade qualification needs both. The profiling portion of package 2 remains an early priority. Localization foundation follows early; EN/RU completion is a release gate, not an optional translation phase after invitations.
