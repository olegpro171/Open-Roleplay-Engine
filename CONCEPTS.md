# ORE — Product contract

ORE (Open Roleplay Engine; repository: Roleplay Engine) is a personal roleplay application for a single owner per local installation. Predictable context handling, inspectable model input, and control over summaries take priority over feature breadth. This file records current accepted behavior and open decisions, not a roadmap or implementation diary.

Read [IMPLEMENTATION.md](IMPLEMENTATION.md) for module ownership and development, and the focused contracts linked below before changing those subsystems. The user's latest explicit decision takes precedence. Code demonstrates current behavior; it does not independently authorize a product-policy change.

## Product vocabulary

| Concept | Owns |
| --- | --- |
| Connection | Endpoint/protocol, credentials, model, physical limits, supported custom parameters |
| Prompt preset | Ordered enabled text blocks and source markers, their roles and configuration |
| Context preset | Reusable memory settings and extraction, compression and repair prompts; optional summarization Connection |
| Chat | Character/Persona and preset selections, working input target, transcript, memory and operation state |
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

Enabled preset blocks and markers compose the base request. Missing/disabled markers contribute nothing. Empty/missing-marker presets may be saved; warnings are advisory. At most one enabled Messages, Summary, Card system prompt and Card post-history instructions marker is allowed. An empty resolved request fails before a provider call.

Character expands checked, nonempty Name, Description, Personality, Scenario and Example dialogue fields as separate messages in that fixed order, inheriting the marker's role. Separate field markers behave equivalently. Missing field configuration means all fields; explicit empty selection contributes nothing. Greeting is transcript content, not a Character field expansion. Selected names resolve macros even if their own field is unchecked.

Resolve case-insensitive `{{user}}` and `{{char}}` once in prompt/card/persona text, with You / Character fallback names. Insert names literally, without recursive interpretation. Stored conversation text remains literal. `{{original}}` is scoped to the two card-instruction fields and inserts only the respective marker fallback. Other macros remain literal.

The factory/new/Restore original template ships the supplied GLM Dark Edition Refined preset as **Default prompt**, preserving its ordered blocks and model-bound text. It includes Card system prompt → Instructions → NSFW Policy → Banned Concepts → Character → Persona → Summary → Messages (card depth injection permitted) → Card post-history instructions → NPC Continuity and Behavior → Response Structure. Both card markers have empty fallbacks. Existing saved presets/imports retain their blocks and permissions; omitted depth permission means off. New presets are independent copies. Card fields, lore and chat Author's notes follow [compatibility and prompt rules](docs/COMPATIBILITY.md).

### Managed and recent-history modes

With Summary enabled, Summary and Messages share one managed coverage selection: selected summaries plus the saved verbatim tail, in source order. Neither marker is inserted implicitly. Compaction saves a replacement before excluding its sources and preserves all original turns.

Without Summary, Messages uses a request-local newest contiguous suffix of whole original turns that fits complete input, including required fixed content/pending input. Archived originals are eligible. Stop at the first older turn that cannot fit; do not split parts, skip a larger recent turn, or pad slack. The saved cutoff does not restrict this mode. Required fixed content/pending input that cannot fit fails explicitly. Missing Messages inserts no turns, including pending input.

Summary-off mode performs no preparation, promotion or repair, and unused stale memory does not block roleplay. Saved summaries, selections, versions, corrections and preparation history remain intact. Re-enable Summary and use Prepare; stale required memory still needs reviewed repair. The sending tolerance does not expand recent-history suffix selection.

## Memory and budgets

[The memory contract](docs/CONTEXT.md) owns detailed batching, selection, corrections, repair, refusal recovery and counting rules.

- Use one local `cl100k_base` reference counter for complete resolved input, allocations, summary savings and summarization-window checks. Endpoint usage is an observation on its exact request, not calibration or an exact-limit guarantee.
- Separate working input target from physical capacity/output reservation. Preparation aims for the target. Sending may exceed it by strictly less than the configured allowance (default enabled, 100 tokens); target equality fits and allowance equality prepares. Physical overflow fails without independently triggering preparation.
- Automatic preparation runs only on Send outside that allowance, or after a successful response/regeneration leaves complete saved input above target. Opening chats, changing settings/sources, selecting variants and typing drafts do not trigger model calls.
- Preserve fixed oldest batches, minimum completed tail, residual turns and retained summary floors. Promote eligible groups under geometric pressure only when no first-layer batch is eligible. Fail when required content cannot fit; never silently reduce guarantees or discard sources.
- Ordinary continuation preserves selections despite spare capacity. Explicit Prepare may restore recent detail from fresh saved representations under the accepted pressure/correction policy. Reuse exact fresh replacements before making model calls. A fitting saved selection makes no model calls; automatic/single-step preparation reuse without restoring detail.
- Manual corrections retain versions and authority even outside the selected tree. Archived edits invalidate all actual consumers, including prior-context consumers and higher layers. Repair scopes required current dependencies, saves approved children before dependents, and reviews changed or structurally uncertain results. Close discards unapproved work and retains approved progress; there is no repair-draft persistence.
- Clear memory explicitly removes summaries/versions/candidates/preparation history while retaining original turns, context-preset selection and roleplay requests. Summary deletion previews its all-version dependency cascade and restores affected history to verbatim without model calls.

Structural coverage, freshness, text equality and refusal heuristics do not establish semantic recall or summary quality. Numerical defaults and model prompts remain tunable; requesting an output size is a soft instruction.

## Libraries and imports

Supported formats are a bounded compatibility profile, not full SillyTavern behavior: V1/V2/V3 JSON or embedded PNG character data, supported lorebook formats, persona-backup/basic JSON, ORE prompt/context JSON and SillyTavern-style JSONL transcript replacement. Unsupported metadata remains inactive. [COMPATIBILITY.md](docs/COMPATIBILITY.md) owns exact mappings and limits.

Shared reusable edits affect future requests in selecting chats and retain existing request bodies/greetings. Shared-record edits are blocked during response/preparation work. Referenced reusable records cannot be deleted until references are removed. Built-in Prompt and Default context preset remain editable; confirmed Restore/Reset uses current factory values without deleting saved memory or requests. Default context cannot be deleted.

New chat initially asks for Character and Persona, saves the character name as its title within the 100-character limit (or A new story), copies greetings/default lore, and opens Chat settings. Owner-level bookmarks choose new-chat Connection, Prompt and Context preset defaults. Installations without saved bookmarks start with the built-in Default prompt and Default context preset bookmarked; saved choices, including cleared bookmarks, are preserved. Clearing/deleting a choice restores the original fallback (first Connection/None, built-in Prompt, no Context preset). Defaults never alter existing chats. Existing chats keep their lorebook when Character changes. Any idle chat, including the final chat, may be deleted; do not recreate it on restart.

JSONL replacement previews counts and atomically replaces only the selected chat's history and dependent variants/memory/request records, retaining its settings. Import active original messages even if foreign compaction flags hide them. Pair ordinary user/assistant messages; retain consecutive same-speaker messages as separate turns with empty opposite parts. Assistant-only openings and historical user-only turns are complete; only the final unmatched user input is pending. Reject unsupported system/group formats; never modify the source file.

Character/Persona Title / comment and Speech color are local metadata, excluded from model text and compatible exports. Local tag assignments are independent of preserved embedded card tags. Pictures are Character-only; they do not enter model input. Organization/presentation-only saves must not invalidate narrative memory or reset lore. Duplication copies local metadata and independent picture associations, sharing reusable lorebook/tag identities as specified.

## Interface and recovery behavior

Story, Libraries and Settings are top-level navigation. Chat settings, Inspect memory and Request inspector are chat tools. Desktop uses shared sidebars; widths up to 800px use the header's Chat details overlay and floating Save/Close controls. Saving editors returns only after server confirmation; failures retain drafts. Library editors use Save/Cancel, with floating Save/Close at narrow widths. Clicking a reusable card opens its editor; More opens secondary actions, dismissing when outside scrolling begins. Shared selection dropdowns also dismiss on outside scrolling; scrolling inside options preserves them. Connection model selection uses a compact modal with automatic discovery, local filtering and manual identifier submission; discovery failure never blocks manual entry. Selection changes the editor draft until the Connection is saved. The Tags filter keeps its separate outside-scroll policy.

Application settings autosave valid changes, serialize rapid edits and reconcile only locally changed fields on conflicts. Preserve failed choices with Retry. Routine saves are silent; after one second show the pending-delay alert, and failures show immediately. App-default color pickers save immediately; library color pickers keep Apply/Cancel. Backups, deletion and reusable editors retain explicit actions/confirmations. Action-error banners offer Dismiss, while loading failures offer Retry loading; background refresh/reconnect cannot replace or dismiss unresolved action errors.

Composer drafts are browser/device-local and survive navigation/reload subject to storage availability. Retain submitted text and exact command identity until server acknowledgement; never automatically resend. Acknowledgement cannot clear newer text or another chat's draft. Typing remains available during generation/preparation while Send is blocked. The composer grows/shrinks to its height cap and keeps Send at its bottom-right. Turn editors retain manual resizing. Physical-keyboard modes are Ctrl/⌘+Enter (default), Enter, or button-only; phone/tablet plain Return remains a newline even with an attached keyboard. Ignore composition/repeat events and never queue blocked submissions.

Chat text scale is 90/100/110/120 percent, including composer text. Themes are server-wide Dark, Light and Midnight Black. Theme defaults yield to explicit application speech colors, then Character/Persona overrides. Legacy colors remain explicit until cleared. Themes, text scale, portrait visibility and optional live reasoning preview change presentation only. Live reasoning preview defaults off; saved/on-demand reasoning inspection remains available. Show a centered title below a visible Character portrait; otherwise left-align it. Library pictures remain independent.

Markdown/direct-speech highlighting is heuristic presentation; raw HTML stays inert. Remote Markdown images render in the browser but are filtered from future model input and budgeting. Story uses a bounded transcript window without truncating engine history. iOS keeps native keyboard/selection behavior and permits contained native vertical boundary gestures in transcript/Chat details, retaining guards elsewhere. Preserve device-specific behavior without claiming emulation proves real-device support.

English and Russian ship together; language changes update mounted interface text without translating user content or changing model input. See [localization](docs/LOCALIZATION.md) and the [locked palette](docs/PALETTE.md) before changing UI text/colors.

## Data, access and delivery

The installation has one local owner login. Credentials stay on the server, excluded from ordinary responses/inspection/logs. Local SQLite keys are not application-encrypted. Backups include credentials; optional nonempty passwords protect portable files, while blank-password protection only deters generic scanners. Import/wipe preserve the accepted content/auth/preferences boundaries in [DATA.md](docs/DATA.md).

Phone access uses optional trusted-LAN HTTP, disabled initially and configured locally after owner setup. Automatic network selection/port 3000 recovers without a browser; manual mode retains its binding. Settings shows the recommended hostname and the active listener’s local IPv4 fallback together; hostname discovery failure alone leaves IPv4 access available. Local access remains independent. Keep authentication, origin/host/subnet admission and trusted-network restrictions. HTTPS provisioning is deferred; do not expose the server through public forwarding.

A release is an exact commit on `main`; build identity is its full commit, not a package-version scheme. The standalone delivery candidates are one `ORE-launcher.command` file for macOS and one `ORE-launcher.bat` for Windows x64, placed in a chosen folder, with all managed content in the adjacent `ORE-internal/`. They resolve public GitHub main over HTTPS, prove forward ancestry, build the exact source archive with a verified private toolkit, and skip downloads/builds when unchanged. Global Git/Node/compiler installation is unnecessary. Persistent configuration is `ORE-internal/.env`; saved data and language packs stay outside replaceable app snapshots. Launcher messages have their own embedded English/Russian catalog selected from macOS system preferences or Windows UI language. macOS delivery accepts a one-time, per-file `chmod u+x` command before normal launcher execution; separate OS trust approval may still be required. Windows uses built-in 64-bit Windows PowerShell 5.1/.NET, preserving organization execution policy. Clean-machine and published-download qualification remain separate. Linux standalone delivery is deferred; existing source entries remain.

Failed checks/builds before live startup may visibly use a verified installed app. Application startup owns database identity, compatibility, pre-upgrade snapshots and migrations; the launcher never inspects SQLite. Recovery selects compatible retained code explicitly and pauses updates. Once live startup begins, failures stop without automatically launching older code. Established missing databases must not silently become empty replacements. The owner's working-tree development installation is independent. [RELEASES.md](docs/RELEASES.md) defines startup, packaging and recovery.

## Open decisions and scope

These remain open/future decisions, not tasks or permanent prohibitions: branching/earlier-turn regeneration, product agents/triggers, retrieval and scene detection, character-specific memory permissions, broad provider adaptation, multimedia/multiplayer/plugins, additional formats/bounded CHARX extraction, persona portraits/current-artwork PNG export, semantic authority for conflicting manual additions, handwritten memory with new coverage, accepting partial/empty generated responses, automatic restoration, future summary schemas/strategies, pruning/backup schedules, HTTPS provisioning, stronger local credential protection, signing/platform qualification, and optional startup at login.

Do not infer acceptance from an old proposal or implement an unresolved policy merely because related code exists. Ask only when the missing decision materially affects behavior, compatibility, preservation or scope. Current platform checks and real-model/device limits are summarized in README; synthetic fixtures do not establish semantic quality, pristine-machine installation or actual phone support.
