# ORE — Product contract

ORE (Open Roleplay Engine; repository: Roleplay Engine) is a personal roleplay application for a single owner per local installation. Predictable context handling, inspectable model input, and control over summaries take priority over feature breadth. This file records current accepted behavior and open decisions, not a roadmap or implementation diary.

Read [IMPLEMENTATION.md](IMPLEMENTATION.md) for module ownership and development, and the focused contracts linked below before changing those subsystems. The user's latest explicit decision takes precedence. Code demonstrates current behavior; it does not independently authorize a product-policy change.

## Product vocabulary

| Concept | Owns |
| --- | --- |
| Connection | Endpoint/protocol, credentials, model, physical limits, supported custom parameters |
| Prompt preset | Ordered enabled text blocks and source markers, their roles and configuration |
| Context preset | Reusable memory settings and extraction, compression and repair prompts; optional summarization Connection |
| Chat | Shared title, Connection, Character/Persona, prompt and context selections, lorebook selection and working input target |
| Branch | Transcript, response variants, turn pins, Author’s note, memory and cutoff, lore activation, requests and operation state |
| Character / Persona | Separate reusable records for the model's identity / user's identity |
| Generation | Server-owned request assembly, transport, streaming and response persistence |
| Product agent | A possible future auxiliary task with instructions, a Connection, conversation access, triggers and marker output; not a coding subagent |

The accepted stack is strict TypeScript, React/Vite, Node/Fastify, SQLite with better-sqlite3/Drizzle, Zod, HTTP/SSE, Vitest and Playwright. One computer hosts server and data; other browsers access that installation. Independent testers run independent installations. No hosted service or multiplayer system is implied.

## Turns and responses

- A turn has user and assistant parts, stable identity and completion independent of text length. Only the latest turn may be pending. Resolve it before submitting another turn. Either part of a completed turn can be deliberately empty; omit blank outgoing parts without losing membership or coverage. Delete whole turns only.
- Failed, cancelled, interrupted, blank or unusable first-response output leaves its turn pending. Partial text remains inspectable but cannot be explicitly accepted as complete. Retry uses the existing pending turn; it does not add a duplicate input.
- Trim boundary blank lines from new submissions, successful responses, copied greetings and part edits, preserving internal formatting. Do not rewrite imported/existing history.
- New chats copy all nonblank resolved primary/alternate greetings into response variants of one completed opening turn with an empty user part. Select the first nonblank greeting in card order; preserve duplicates. All blank means no opening turn. Later card edits never rewrite copied greetings.
- Regenerate only the latest completed response. Keep its selected response committed until a new valid variant succeeds; failure/cancellation restores it. Selecting existing variants on historical turns changes future input, not later transcript text. Source-content provenance is distinct from monotonic concurrency revisions: A → B → unchanged A can restore memory freshness only where every dependency still matches.
- Generation belongs to the server. Losing an SSE observer does not cancel work. Reconnect reconciles saved/current state. Server interruption exposes explicit recovery; it never silently repeats paid requests or claims to resume a provider stream.

## Prompt authority

Enabled preset blocks and markers compose the base request. Missing/disabled markers contribute nothing. Empty/missing-marker presets may be saved; warnings are advisory. Messages, Summary, Pinned messages and the two card instruction markers each allow at most one enabled instance. An empty resolved request fails before a provider call.

Character expands checked, nonempty Name, Description, Personality, Scenario and Example dialogue fields as separate messages in that fixed order, inheriting the marker's role. Separate field markers behave equivalently. Missing field configuration means all fields; explicit empty selection contributes nothing. Greeting is transcript content, not a Character field expansion. Selected names resolve macros even if their own field is unchecked.

Resolve case-insensitive `{{user}}` and `{{char}}` once in prompt/card/persona text, with You / Character fallback names. Insert names literally, without recursive interpretation. Stored conversation text remains literal. `{{original}}` is scoped to the two card-instruction fields and inserts only the respective marker fallback. Other macros remain literal.

Fresh installations and **Restore original** use the supplied GLM Dark Edition Refined preset as **Default prompt**, preserving its ordered blocks and model-bound text. It includes Card system prompt → Instructions → NSFW Policy → Banned Concepts → Character → Persona → Summary → Pinned messages → Messages (card depth injection permitted) → Card post-history instructions → NPC Continuity and Behavior → Response Structure. Both card markers have empty fallbacks. **New prompt** starts with an empty **Pre-history instructions** text block, the same source markers in their factory order, and an empty **Post-history instructions** text block. Existing saved presets and imports retain their blocks and permissions. Omitted depth permission means off. Card fields, lore and chat Author's notes follow [compatibility and prompt rules](docs/COMPATIBILITY.md).

### Pinned turns

Pin completed turns in Story. Membership follows the original turn and currently selected reply within that branch. Chat details opens the searchable Pinned turns manager. Open a turn from its card, or use its separate pin control. An unpinned row stays available for re-pinning until the manager closes. The input allocation keeps the last confirmed estimate while recalculating.

An enabled Pinned messages marker includes one grouped reference message in branch order, including archived turns and any pinned turns also sent through Messages. Both copies count. Missing or disabled Pinned messages produces an advisory warning for branches with pins, including while choosing a preset in Chat Settings. The marker has no effect on ordinary Messages placement, summary coverage or lore matching. See the [prompt contract](docs/COMPATIBILITY.md#pinned-messages) and [budget rules](docs/CONTEXT.md#measurement-and-limits).

### Managed and recent-history modes

With Summary enabled, Summary and Messages share one managed coverage selection: selected summaries plus the saved verbatim tail, in source order. Neither marker is inserted implicitly. Compaction saves a replacement before excluding its sources and preserves all original turns.

Without Summary, Messages uses a request-local newest contiguous suffix of whole original turns that fits complete input, including required fixed content/pending input. Archived originals are eligible. Stop at the first older turn that cannot fit; do not split parts, skip a larger recent turn, or pad slack. The saved cutoff does not restrict this mode. Required fixed content/pending input that cannot fit fails explicitly. Missing Messages inserts no turns, including pending input.

Summary-off mode performs no preparation, promotion or repair, and unused stale memory does not block roleplay. Saved summaries, selections, versions, corrections and preparation history remain intact. Re-enable Summary and use Prepare; stale required memory still needs reviewed repair. The sending tolerance does not expand recent-history suffix selection.

## Memory and budgets

[The memory contract](docs/CONTEXT.md) owns detailed batching, selection, corrections, repair, refusal recovery and counting rules.

- Use one local `o200k_base` reference counter for complete resolved input, allocations, summary savings and summarization-window checks. Endpoint usage is an observation on its exact request, not calibration or an exact-limit guarantee.
- Separate working input target from physical capacity/output reservation. Preparation aims for the target. Sending may exceed it by strictly less than the configured allowance (default enabled, 100 tokens); target equality fits and allowance equality prepares. Physical overflow fails without independently triggering preparation.
- Manual Prepare measures the current saved request without sending a turn. Send and Regenerate prepare outside the sending allowance. A successful reply can trigger a separate preparation job when complete saved input exceeds the target. Opening chats, changing settings or sources, selecting variants and typing drafts make no memory calls.
- Generate only fixed oldest batches and eligible promotions. Protect the minimum completed tail, residual turns and retained summary floors when generating. Promote under geometric pressure only when no new first-layer batch is eligible. Fail when required content cannot fit; never silently reduce guarantees or discard sources.
- Manual Prepare and triggered preparation replay original turns with an empty working cutoff. Summary-only prompts start with their saved coverage. Advance through the oldest eligible original batches before promoting and reuse compatible saved results. Activate completed steps as soon as they form a valid selection, even above target. Stop at the first valid fit. Replay may restore archived turns to verbatim or select finer summaries for older turns. Regenerate excludes the previous reply and keeps its replay selection specific to that request.
- When preparation requires summary deletion, pause for the existing dependency-cascade preview. Confirm to delete the reviewed memory and replan, or decline to stop preparation and keep the memory at the pause.
- Changing Turn batch or Promotion group keeps committed summaries and their provenance. New steps use the new sizes. Preview obsolete inactive summaries and any manual corrections that would be removed before saving across affected branches. Deleting the latest turn keeps the longest valid whole-summary prefix that leaves the protected tail and removes obsolete coverage with the turn.
- Manual corrections retain versions and authority even outside the selected tree. Archived edits invalidate all actual consumers, including prior-context consumers and higher layers. Repair scopes required current dependencies, saves approved children before dependents, and reviews changed or structurally uncertain results. Close discards unapproved work and retains approved progress; there is no repair-draft persistence.
- Clear memory explicitly removes summaries/versions/candidates/preparation history while retaining original turns, context-preset selection and roleplay requests. Summary deletion previews its all-version dependency cascade and restores affected history to verbatim without model calls.

Structural coverage, freshness, text equality and refusal heuristics do not establish semantic recall or summary quality. Numerical defaults and model prompts remain tunable; requesting an output size is a soft instruction.

## Libraries and imports

Supported formats are a bounded compatibility profile, not full SillyTavern behavior: V1/V2/V3 JSON or embedded PNG character data, supported lorebook formats, persona-backup/basic JSON, ORE prompt/context JSON and SillyTavern-style solo JSONL transcript interchange. Unsupported metadata remains inactive. [COMPATIBILITY.md](docs/COMPATIBILITY.md) owns exact mappings and limits.

Shared reusable edits affect future requests in selecting chats and retain existing request bodies/greetings. Shared-record edits are blocked during response/preparation work. Referenced reusable records cannot be deleted until references are removed. Built-in Prompt and Default context preset remain editable. Confirmed Restore/Reset uses current factory values and applies the same layout impact review if the batch or group size changes. Default context cannot be deleted.

New chat initially asks for Character and Persona, saves the character name as its title within the 100-character limit (or A new story), copies greetings/default lore, and opens Chat settings. Owner-level bookmarks choose new-chat Connection, Prompt and Context preset defaults. Installations without saved bookmarks start with the built-in Default prompt and Default context preset bookmarked; saved choices, including cleared bookmarks, are preserved. Clearing/deleting a choice restores the original fallback (first Connection/None, built-in Prompt, no Context preset). Defaults never alter existing chats. Existing chats keep their lorebook when Character changes. Any idle chat, including the final chat, may be deleted; do not recreate it on restart.

JSONL import previews a transcript and creates a new chat from Libraries → Chats or an independent branch from Chat branches. Confirm an editable title or branch name. New chats use the normal defaults, optional Character and Persona selections and the selected Character's default lorebook, then open Chat Settings. Imported branches use their chat's shared settings and open in Story. Both start with the file's turns and fresh branch state. Transcript imports skip greetings. JSONL export downloads the selected branch’s full saved transcript, including archived original messages and selected responses. See [COMPATIBILITY.md](docs/COMPATIBILITY.md#cards-personas-and-transcript-interchange) for turn mapping, format limits and information loss.

Character/Persona Title / comment and Speech color are local metadata, excluded from model text and compatible exports. Local tag assignments are independent of preserved embedded card tags. Pictures are Character-only; they do not enter model input. Organization/presentation-only saves must not invalidate narrative memory or reset lore. Duplication copies local metadata and independent picture associations, sharing reusable lorebook/tag identities as specified.

## Chat branches

Every chat has at least one branch. Chat branches opens after Inspect memory and supports name search, selection, rename, duplicate, transcript import/export and deletion. The Chats library lists each chat once, shows the turn count of the last branch opened in the current browser, and opens that same branch. If the remembered branch is unavailable, the card shows and opens an available branch. Branch selection changes the current view and uses that branch's composer draft. Deleting a branch requires confirmation and leaves the other branches usable. Delete chat removes all branches and checks every branch's saved revision.

Duplicate copies the committed story, pins, memory, requests, current saved Author’s note and lore activation state. A fork inherits pins on the copied turns only. Membership is independent after either copy. Branch from here copies the story through the chosen completed turn and the current saved note, then opens the new branch. An earlier fork copies only memory versions whose source turns and complete dependency chain remain in the fork. Omit crossing versions, including manual corrections, without review or changes to the source branch. Start fresh lore activation for an earlier fork. Reselect compatible saved memory using the current full input budget and prefer recent original turns within the existing coverage and correction rules. If saved memory is insufficient, leave ordinary preparation available. Neither copy operation starts a model request.

## Interface and recovery behavior

The Story turn footer keeps response versions, regeneration or cancellation, editing and pinning directly accessible when applicable. More contains reasoning, branching and whole-turn deletion. It opens with focus on the menu panel, and its dialogs return focus to the page on close. At narrow widths the footer wraps to keep actions accessible without horizontal scrolling.

Memory and Chat Details update Estimated input as valid steps become active. Story also shows the working preparation estimate, target, step and Stop. Stop, failure and interruption keep the latest committed selection. Completed results that could not yet become active remain available for reuse. A pending Send turn and the previous selected reply during Regenerate remain saved. Interrupted work requires an explicit retry after restart.

Story, Libraries and Settings are top-level navigation. Chat settings, Inspect memory and Request inspector are chat tools. Prompt peek can copy the assembled model messages as plain text, with role headings in model order and selectable text when automatic copying fails. Desktop uses shared sidebars; widths up to 800px use the header's Chat details overlay and floating Save/Close controls. A click or tap on the workspace behind Chat details dismisses the overlay and consumes that interaction. Saving editors returns only after server confirmation; failures retain drafts. Library editors use Save/Cancel, with floating Save/Close at narrow widths. Clicking a reusable card opens its editor; More opens secondary actions, dismissing when outside scrolling begins. Character and Persona choices, along with Connection, Prompt preset, Context preset and Lorebook choices in Chat settings, follow the sorting saved for their respective Library categories in the current browser. Optional selections keep None selected first. Shared selection dropdowns also dismiss on outside scrolling; scrolling inside options preserves them. Connection model selection uses a compact modal with automatic discovery, local filtering and manual identifier submission; discovery failure never blocks manual entry. Selection changes the editor draft until the Connection is saved. The Tags filter keeps its separate outside-scroll policy.

Application settings autosave valid changes, serialize rapid edits and reconcile only locally changed fields on conflicts. Preserve failed choices with Retry. Routine saves are silent; after one second show the pending-delay alert, and failures show immediately. App-default color pickers save immediately; library color pickers keep Apply/Cancel. Backups, deletion and reusable editors retain explicit actions/confirmations. Action-error banners offer Dismiss, while loading failures offer Retry loading. A server outage is reported separately and recovery preserves unresolved action errors. Delete confirmations for individual records and entries accept Enter from the heading or Delete button. Enter on the focused Cancel button dismisses the dialog.

A click or tap on a modal backdrop uses the top dialog's Escape behavior, including cancellation of a confirmation and any operation guards. Pressing inside a dialog and dragging onto the backdrop keeps it open.

Composer drafts are browser/device-local and survive navigation/reload subject to storage availability. Retain submitted text and exact command identity until server acknowledgement; never automatically resend. Acknowledgement cannot clear newer text or another chat's draft. Typing remains available during generation/preparation while Send is blocked. The composer grows/shrinks to its height cap and keeps Send at its bottom-right. Turn editors retain manual resizing. Physical-keyboard modes are Ctrl/⌘+Enter (default), Enter, or button-only. The same setting sends from the composer and saves from either turn editor. Phone/tablet plain Return remains a newline even with an attached keyboard. Ignore composition/repeat events and never queue blocked submissions.

In the composer and turn editors, typing `--` inserts an em dash (`—`). Typing a third hyphen immediately after that substitution restores `---` for Markdown separators. Pasted and loaded text stays literal.

Chat text scale is 90/100/110/120 percent, including composer text. Themes are server-wide Dark, Light and Midnight Black. Theme defaults yield to explicit application speech colors, then Character/Persona overrides. Legacy colors remain explicit until cleared. Themes, text scale, portrait visibility and optional live reasoning preview change presentation only. Live reasoning preview defaults off; saved/on-demand reasoning inspection remains available. Show a centered title below a visible Character portrait; otherwise left-align it. Library pictures remain independent.

Markdown/direct-speech highlighting is heuristic presentation; raw HTML stays inert. Remote Markdown images render in the browser but are filtered from future model input and budgeting. Story uses a bounded transcript window without truncating engine history. iOS keeps native keyboard/selection behavior and permits contained native vertical boundary gestures in transcript/Chat details, retaining guards elsewhere. Preserve device-specific behavior without claiming emulation proves real-device support.

English and Russian ship together; language changes update mounted interface text without translating user content or changing model input. See [localization](docs/LOCALIZATION.md) and the [locked palette](docs/PALETTE.md) before changing UI text/colors.

## Data, access and delivery

The installation has one local owner login. Credentials stay on the server, excluded from ordinary responses/inspection/logs. Local SQLite keys are not application-encrypted. Backups include credentials; optional nonempty passwords protect portable files, while blank-password protection only deters generic scanners. Import/wipe preserve the accepted content/auth/preferences boundaries in [DATA.md](docs/DATA.md).

Phone access uses optional trusted-LAN HTTP, disabled initially and configured locally after owner setup. Automatic network selection/port 3000 recovers without a browser; manual mode retains its binding. Settings shows the recommended hostname and the active listener’s local IPv4 fallback together; hostname discovery failure alone leaves IPv4 access available. Local access remains independent. Keep authentication, origin/host/subnet admission and trusted-network restrictions. HTTPS provisioning is deferred; do not expose the server through public forwarding.

A release is an exact commit on `main`. Development takes place on `develop` with local checks. GitHub Actions builds, tests and packages Windows x64 candidates on `staging`. Fast-forwarding the exact qualified commit to `main` publishes the retained files. Missing, expired or incompatible qualification blocks publication. Published releases stay unchanged.

Windows x64 is the supported public download. `ORE-launcher.bat` installs a verified package into adjacent `ORE-internal/` using built-in Windows PowerShell 5.1. The external launcher stays in place for routine updates. The installed helper owns recurring updates and startup. Replacing the external launcher is an exceptional compatibility change. Persistent configuration, data and language packs stay outside replaceable app snapshots. The Windows launcher uses an embedded English/Russian catalog selected by Windows UI language. The Mac host continues to start from the working tree with `start-dev.command`. The earlier Mac standalone and checkout-based updaters are retired.

Failed checks/builds before live startup may visibly use a verified installed app. Application startup owns database identity, compatibility, pre-upgrade snapshots and migrations; the launcher never inspects SQLite. Recovery selects compatible retained code explicitly and pauses updates. Once live startup begins, failures stop without automatically launching older code. Established missing databases must not silently become empty replacements. The owner's working-tree development installation is independent. [RELEASES.md](docs/RELEASES.md) defines startup, packaging and recovery.

## Open decisions and scope

These remain open/future decisions, not tasks or permanent prohibitions: earlier-turn regeneration, product agents/triggers, retrieval and scene detection, character-specific memory permissions, broad provider adaptation, multimedia/multiplayer/plugins, additional formats/bounded CHARX extraction, persona portraits/current-artwork PNG export, semantic authority for conflicting manual additions, handwritten memory with new coverage, accepting partial/empty generated responses, automatic restoration, future summary schemas/strategies, pruning/backup schedules, HTTPS provisioning, stronger local credential protection, signing/platform qualification, and optional startup at login.

Do not infer acceptance from an old proposal or implement an unresolved policy merely because related code exists. Ask only when the missing decision materially affects behavior, compatibility, preservation or scope. Current platform checks and real-model/device limits are summarized in README; synthetic fixtures do not establish semantic quality, pristine-machine installation or actual phone support.
