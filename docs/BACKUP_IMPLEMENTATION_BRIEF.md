# Task 1 — In-app backup, inspection, append import and wipe

Status: implementation assignment prepared 2026-10-19. Not yet implemented.

## Assignment

Implement application data management inside ORE: download a database backup, inspect a selected backup in a navigable tree, append its contents to the current installation, and wipe application data. Follow AGENTS.md, CONCEPTS.md, IMPLEMENTATION.md and the context/picture/lore subsystem contracts. Complete implementation and verification; do not stop at a design proposal.

The user explicitly selected this collision policy: **identify overlaps by record identity, warn before import, and overwrite overlapping records only after confirmation**. Do not automatically duplicate, match by name, choose the newer version, merge conversation branches, or skip collisions. Users can cancel and preserve copies before returning to import. Windows/macOS/Linux must exchange the same backup format.

This task owns the application feature. Release packaging is a separate assignment in [RELEASE_IMPLEMENTATION_BRIEF.md](RELEASE_IMPLEMENTATION_BRIEF.md).

## User-visible workflow

Add a discoverable application-level Data management page using existing controls and responsive styling. It is independent of the selected chat.

1. **Save backup:** create a consistent snapshot and download one SQLite file with a recognizable ORE filename, creation time and schema/build metadata. Show actual completion and useful progress where measurable. Include saved API keys; state this beside the action. No key appears in ordinary UI/JSON/log output.
2. **Inspect backup:** select/upload a file, validate it in isolated staging, then browse its contents. Inspection performs no mutation of current stories, libraries or authentication. The original file is never modified.
3. **Import backup:** show additions, overlaps, dependent-record effects and blockers against the current database. If overlaps exist, list affected records and explicitly require approval to overwrite them. Cancel changes nothing. A completed import retains current non-overlapping content and adds/replaces the reviewed content atomically.
4. **Wipe application data:** explain the exact scope, offer Save backup, and use the established destructive confirmation dialog. Clear content atomically without deleting the live SQLite file beneath open connections. The resulting application must remain usable for import and creating new content.

Recommended implementation default for wipe: retain the local owner login, revoke other sessions, and retain/recreate only mandatory factory records needed by the app; clear user chats, memory, libraries, credentials, pictures, tags, request history and content-related command receipts. List the retained owner/factory data explicitly. This is not an account reset or a release uninstall. Do not introduce a separate Replace import mode or password-reset feature in this task.

The inspection tree must expose all supported saved application content: chats with selections/turns/variants/memory versions/requests/preparation history; characters/personas/pictures; Connections; prompts/context presets; lorebooks; tags and persisted preferences. Administrative tables are not user content. Show credential presence only. Load large branches and leaf text/images on demand, with bounded pages, keyboard access, errors/retry, and no remote image loads. Viewing a file does not authorize import. Entire-backup import is sufficient; selective import is out of scope.

Browser-local drafts are outside a server database backup. Explain this limitation. After replacing/wiping a chat, stale drafts/staged sends in another tab must never submit against the replacement automatically; reconcile them visibly, retaining recoverable text where appropriate.

## Identity and overwrite semantics

Define public import units explicitly; SQL rows alone are not a safe overwrite unit:

- A chat is an aggregate: its turns/parts, response variants, generations, immutable request records, all approved memory versions, selection/cutoff, preparation history and lore provenance/state. An overlapping chat is replaced by the complete saved chat aggregate. Current-only children of that overlapping chat are removed, so an older backup does not produce a hybrid story. The preview must disclose this consequence and include affected child counts. Other chats remain intact.
- Library records and Connections overwrite by ID, including saved credential presence/absence, linked books, local tags and picture associations. An incoming record with no key/picture clears the overlapping record's corresponding value; do not silently retain newer local extras. Names are labels, not identities. Built-in IDs can overlap too and must be accounted for.
- Preserve imported identities, text, source/content revisions, variants, corrections, immutable request bodies and provenance. Use distinct live concurrency tokens where needed; restoring old numeric revisions must not make old client commands valid again.
- Imported references point to imported or retained records with the correct identities/types. Reject cross-kind ID collisions, cross-chat ownership conflicts, dangling references, inconsistent selected variants, broken memory coverage or dependency graphs. A collision must not silently reassign a child from a different unaffected chat.
- Shared incoming libraries may also be referenced by current chats absent from the backup. Include these effects in preview. Preserve those chats and historical requests; use the existing rules for future-input changes, chat revision advancement and lore invalidation. In particular, overwriting a lorebook cannot leave unrelated chats using activation state from its previous contents. Do not blanket-mark narrative summaries stale for visual/metadata-only changes.
- Picture assets are immutable. Resolve storage-level collisions without changing image bytes referenced by unaffected characters/personas; an internal asset mapping is acceptable, a silent overwrite of shared bytes is not. Clean up only unreferenced assets.
- The existing tag catalog has unique normalized names. Distinct IDs with the same canonical name are not an ID-overwrite match. Report such unresolved uniqueness conflicts during preflight and block the import with actionable rename guidance; do not silently merge identities or rename user records. Apply the same approach to other genuinely incompatible unique constraints.

Do not promise that every existing item has a Duplicate action. In the current application, library duplication does not constitute a complete independent chat copy; duplicating a character may still share its lorebook. Provide links to existing copy/edit actions and Save backup as a fallback. Report missing independent-copy workflows as follow-up work rather than introducing branching or broad duplication features here.

## Backup boundary and format

Use the existing SQLite backup facility to create a consistent snapshot; never copy only an active WAL main file. Current artwork lives in SQLite BLOBs, so it belongs in the same snapshot. Add explicit format/build metadata without changing the user's source file or executing SQL supplied by it. Avoid introducing an archive dependency when a single SQLite artifact suffices.

The portable content boundary includes all saved application records needed to continue and inspect stories, plus saved Connection credentials. Exclude active login sessions, process locks/runtime-owner records, ephemeral upload state and executable retry authority from the portable artifact. If these exist in a legacy/full database input, never activate them on import. Retain destination owner authentication; imported credentials mean model API keys, not someone else's login sessions.

Unfinished operation state must reopen as interrupted/non-running and require explicit user action. Preserve committed progress and available partial response/reasoning. Respect the existing rule against persisting/reviving unapproved repair drafts: discard unapproved candidates from portable content while retaining approved versions and truthful history/status. Do not create a response variant from incomplete output or silently complete a pending turn.

Support backups produced by this implementation and explicitly documented older ORE schemas covered by migration tests. Reject future/unknown schemas without changing anything. For an older input, validate and upgrade a private copy; preserve the original. Do not claim generic compatibility with arbitrary SQLite files. Model requests, saved budgets and endpoint usage remain historical observations through conversion.

## Validation, staging and commit

Separate server upload/inspection orchestration, persistence import planning/commit, and browser-safe preview contracts. Do not turn Store or App into a monolithic backup implementation. Extend existing helpers where they own policy.

Uploaded databases are untrusted. Use bounded binary transfer, an app-owned private temporary directory, explicit file/record/text/image limits, disk-space/error handling and bounded inspection pages. Inspect a read-only copy with trusted queries and reject unexpected executable schema features. Do not open uploaded files through the normal Store constructor: it claims process ownership and performs migrations/writes. Never execute a backup's triggers, views or arbitrary schema SQL against the live database. Construct/validate trusted staging data with the known application schema. No new dependency is preapproved.

Give uploads a server-owned identity and content digest bound to the owner/session; expire and remove staging artifacts on cancellation, timeout, restart and completed use. A client-supplied filesystem path is never accepted. Preview responses deliberately map allowed fields; secret exclusion applies at every tree node and error boundary.

Preview approval is bound to the exact staged bytes and a current database-state token that covers all affected chats, shared libraries and other relevant records. If anything relevant changes before commit, refuse the stale plan and require refreshed review. A library revision alone does not cover all chat mutations.

Import/wipe require globally idle generation/preparation and exclusive mutation coordination, enforced on the server. Reads may remain available where coherent. The gate must cover operations starting between validation and commit, plus asynchronous picture/lore/library work already in flight. Do expensive validation, hashing, migrations and staging outside the final transaction. Commit the reviewed changes and receipt together; rollback leaves the old state intact. If scale makes one bounded transaction impractical, propose and verify an atomic staged replacement design before using it—never expose a half-imported database.

Use durable command IDs/digests for uncertain acknowledgements. Replaying the same successful command returns its outcome without applying it again, even after restart; different data with the same command ID conflicts. Do not install imported historical command receipts as fresh local execution authority. A deliberately new import may overwrite again after a new preview/confirmation.

Prevent revision ABA across restore and wipe: a pre-import request from another tab must not succeed because an old chat/library revision number happens to match restored data. Introduce a durable dataset epoch or another proven equivalent, without changing source provenance to fake concurrency protection. Apply it across affected mutation paths and stale async completions, and test it explicitly. Invalidate caches/subscriptions and reconcile clients only after committed success. Wipe has the same retry and stale-command requirements as import.

## Verification and completion

Use temporary real SQLite databases, synthetic secrets/images/stories and existing mock providers. Establish tests of observable results, not merely counts returned by the new endpoint.

Required scenarios:

- Save → inspect → wipe → import → restart preserves story text, variants, selected memory, corrections, pictures, links and historical requests; only documented administrative/concurrency state differs.
- Merge disjoint databases; merge overlapping identities after approval; cancel before approval; same name/different ID remains independent; an older chat replaces its entire aggregate, including removal of newer children.
- Imported shared Connection/character/lorebook changes affect only intended future behavior in retained chats, preserving saved requests and correct lore freshness. Test absent incoming keys/pictures and shared immutable assets.
- Repeated command/lost acknowledgement/restart; intentional second import; stale preview after another tab edits a chat or library; delayed save started before import; restored revision equals an old client revision; wipe then reimport the same IDs.
- Database constraint failure, corrupt/future/oversized files, missing dependencies, conflicting tag names, wrong ownership/kind, malicious schema, disk-full/write failures and interruption before/during commit preserve the last valid state and release resources.
- In-progress operations cannot race import/wipe; exported interrupted work never makes an automatic provider request. Unapproved repair text is not reactivated.
- Secrets remain absent from inspection/API errors/logs. A backup downloads only through the authenticated protected route, and its inclusion of API keys is explained.
- Playwright covers inspection expansion, additions/overlap review, cancellation, overwrite, retry, wipe, restored content and a second tab's stale editor. Inspect desktop and phone-sized layouts using large synthetic fixtures; demonstrate bounded inspection behavior.
- Run `npm run check` against the final change. Document exact limits, format/schema support, wipe scope, collision semantics, recovery and browser-draft limitations. Report blocked verification honestly.

Do a final cross-module review of imported references, aggregate replacement, secret boundaries and stale-write protection. Update CONCEPTS.md only for newly settled product details; put actual contracts in IMPLEMENTATION.md and `docs/BACKUPS.md`, and user steps in README.md. This feature is complete only when import continues and inspects restored stories correctly, not merely when it inserts rows.
