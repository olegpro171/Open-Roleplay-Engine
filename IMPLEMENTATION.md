# ORE — Development and architecture

Read [CONCEPTS.md](CONCEPTS.md) for accepted product behavior and [AGENTS.md](AGENTS.md) for the working agreement. Maintain current contracts when behavior changes; use Git history for old proposals and completed verification. This is not a feature diary.

## Development commands

Direct npm commands require Node 24 or Node 22.12+ within major 22 (see `package.json`); the contained launcher pins its own Node. Do not reuse native `node_modules` across Node majors. Install locked dependencies with `npm ci` when needed.

| Command | Purpose |
| --- | --- |
| `./ORE-launcher.command` | Standalone macOS candidate; builds exact public-main archives in adjacent `ORE-internal/` |
| `ORE-launcher.bat` | Standalone Windows x64 candidate; built-in PowerShell 5.1 and private Node, adjacent `ORE-internal/` |
| `start-app.bat` / `./start.sh` | Existing Windows/Linux source startup; see [delivery](docs/RELEASES.md) |
| `./start-dev.command` | Mac/Bash working-tree rebuild into `ore-development/`, no update check |
| `npm run dev` and `npm run dev:ui` | Two-terminal server/UI watch mode (ports 3000/5173) |
| `npm run typecheck` | Strict client/server TypeScript checks |
| `npm run build` | Typecheck and build client/server |
| `npm start` | Serve built interface and API through Fastify |
| `npm test -- tests/context-core.test.ts` | Example focused Vitest invocation |
| `npx playwright install chromium webkit` | Provision browsers, including WebKit for the Safari lorebook-scroll regression |
| `npm run test:e2e -- tests/browser/chat.spec.ts` | Example focused browser invocation; build first |
| `npm run check` | Build, Vitest and browser suites |

No lint script exists. Tests need loopback servers and temporary-file access. Use synthetic fixtures/keys and real temporary SQLite databases, mocking external provider transport. Never use active user data for destructive testing. `start-dev.command` and watch mode use repository data by default: stop the normal app before sharing that database, or explicitly set `ROLEPLAY_DATABASE` to a development path. The standalone Python lab has [its own instructions](experiments/compaction/README.md).

## Module map

| Location | Owns | Preserve |
| --- | --- | --- |
| `src/core/` | Turns, prompt resolution, model-text filtering, budgets, context/coverage/repair policy | Explicit inputs/outputs, no UI/server/database/provider I/O |
| `src/shared/` | Browser-safe contracts, Zod schemas, localization descriptors | No secrets or server-only imports |
| `src/persistence/`, `migrations/` | Durable records, revisions, migrations, transactional commands | Commit-time invariants and exact-command recovery |
| `src/server/` | Auth, HTTP/SSE, generation/preparation coordination, files/settings/LAN | Handlers validate/delegate; coordinators own lifecycles |
| `src/provider/` | Request encoding, stream decoding, transport/cancellation | No history selection, cutoff or coverage policy |
| `src/web/` | Editors, inspection, progress, recovery, browser drafts | Authoritative server state separate from unsaved drafts |
| `tests/` | Core, SQLite, API, crash and browser verification | Isolated deterministic fixtures, meaningful state assertions |
| `experiments/compaction/` | Synthetic Python reference and Tkinter visualizer | Forward-state parity without importing simulation assumptions |

Focused contracts: [memory/counting/repair](docs/CONTEXT.md), [data/portable files](docs/DATA.md), [cards/lore/prompt compatibility](docs/COMPATIBILITY.md), [localization](docs/LOCALIZATION.md), [palette](docs/PALETTE.md), [delivery/recovery](docs/RELEASES.md). Numeric bounds and wire constants are owned by the corresponding shared schemas; update producers, validators, readers and tests together when explicitly changing a contract.

## Persistence and migration boundaries

SQLite lives on the server's local disk with WAL, foreign keys and short transactions. One process owns a database. Phones access HTTP APIs, never a shared database file. Store migrations resolve from module URLs, not the terminal directory. Check schema compatibility before WAL/ownership mutation for future schemas; acquire ownership and create a consistent private pre-upgrade snapshot before upgrading an existing older schema. Failed snapshot aborts the upgrade. Each migration is atomic; earlier completed migrations may remain if a later one fails. Never edit applied migrations or reset data to make an upgrade pass.

Preserve identities, source/concurrency revisions, selections, manual corrections and historical requests. SQL files plus registered data upgrades form the schema history; a missing numbered SQL file does not imply an omitted migration. `schema.ts`, Store registration, frozen legacy definitions and backup validation/reconstruction must agree. The current schema constant is in `src/shared/build-info.ts`; do not duplicate a second version authority in documentation.

Capture source/configuration/selection/operation revisions before asynchronous work. Do provider/image work outside transactions. Recheck all captured preconditions and ownership inside the committing transaction. Save summary+selection, response+variant+lore state, or compound import+receipt as coupled commits. Write failure preserves the previous valid state; later failures preserve completed progress. UI disabling is never the concurrency safeguard.

Shared library commands enforce idle/revision restrictions across affected chats. Per-chat operations preserve unrelated chats' independence. Durable command fingerprints exclude concurrency revisions where established receipts require replay; keep legacy fingerprints readable without rewriting command history. A retry must replay a committed outcome or reject altered payloads, not silently recreate a deleted record.

Content imports/wipes use an exclusive gate, full-state digest and dataset epoch to prevent stale-client revision ABA. Auth/runtime authority and machine preferences remain distinct from portable content. See DATA before changing them.

## Generation and transport

The coordinator owns one operation per chat. Validate/save pending input, capture settings/revisions, resolve fixed input/lore, measure full input, and prepare only under the accepted trigger. Assemble through the authoritative core path, validate limits, save a credential-free historical request, then stream the provider result. Commit only the still-owned operation. After successful response/regeneration, a separate job may prepare over-target saved input; delayed preflight cannot start after supersession, and failure cannot undo the response.

Cancellation aborts transport and rejects late results. SSE disconnection merely removes an observer. Restart marks unfinished work interrupted and offers explicit retry without model calls. Reply/reasoning checkpoints occur on incoming chunks at most once per 250 ms and on terminal outcomes/graceful shutdown; hard crash can lose later chunks. Reasoning is stored separately from turn parts and never enters narrative input, lore scanning or summary sources. Each stream has a four-million-character bound. Snapshots expose at most the final 2,000 reasoning characters; authenticated per-generation reads return full reasoning on demand.

Regeneration retains the completed response while it owns a request-local pending view and context selection/cutoff. Exclude the old target response from all sources/dependencies; expand crossing parents through eligible children without slicing. Direct corrections containing the target block regeneration for explicit resolution. Summary records/history can save, but the live selection/cutoff is unchanged by the regeneration operation. Success selects a new variant and resets/commits its lore epoch atomically. Source-content provenance remains distinct from monotonic chat/part concurrency revisions.

`provider/openai.ts` implements only text Chat Completions with `model`, `messages`, `stream`, `max_tokens`, and optional usage streaming. The supported custom parameters and endpoint validation live in shared contracts. No messages/model/stream/output override is allowed. Refuse redirects; use Authorization only, never embedded endpoint credentials/query/fragment. An edited endpoint cannot receive another endpoint's saved key. Read `choices[0].delta.content`; require a coherent terminal outcome and `[DONE]`. Roleplay accepts supported `length` outcomes; summaries require a normal stop. Explicit refusal/filter, malformed/incomplete streams and blank responses fail safely. Usage is optional and remains attached to the original attempt.

Readable reasoning uses the first nonempty plain `reasoning` / `reasoning_content`, otherwise readable `reasoning_details` text/summary entries; ignore encrypted data/signatures and avoid duplicated representations. No parameters are injected to enable reasoning. `/models` discovery and the explicit `Hi` diagnostic use the Connection editor settings, the configured output reservation, and a 30-second test timeout; no independent 64-token cap, saved chat turn, automatic retry or tokenizer calibration exists.

## Reads, notifications and bounded work

`EngineSnapshot` / `Store.engineSnapshot` provide full sources/context without historical generation bodies to generation, preview, lore and memory operations. `ChatToolsSnapshot` provides full transcript/context without generation history to Memory/Setup. `StorySnapshot` and `StoryReader` provide bounded display pages; never use a display window as engine history. The full legacy snapshot remains explicit inspection only.

Story initially mounts 15 whole turns, moves in batches up to 40, and caps a window at 120. Use indexed `(chat_id, position)` queries and a short coupled read transaction, not a sliced full snapshot. Validate anchor/shift/limit/revision through the shared parser; return replacement windows and reject stale/foreign/removed cursors. Visible ordinals count surviving preceding turns. Keep global pending/generation/context status independent of the window. Pause paging during editing/focused controls, retain drafts on deletion/failure, and restore stable-identity reading anchors when prepending/trimming/resizing or leaving a tool. Latest turn is explicit; the bottom of an old page cannot authorize jumping ahead. Browser Find sees only mounted turns; whole-chat search is deferred.

Request lists use exclusive generation-identity cursors (20 descriptors by default, at most 50), plus at most one selected descriptor to retain inspection while new requests arrive. Bodies load on selection and stay immutable. Descriptors omit request prose, reasoning and partial output. Current web mutations request minimal acknowledgements and then reconcile; preserve legacy full responses.

Typed notifications distinguish chat state/stream, libraries, settings and full reconciliation. SSE comment-only keepalives (15 seconds) recheck auth without dispatching changes. The refresh queue serializes/coalesces scopes, including settlement races. Hidden/other-chat streams cause no reads; other-chat state changes update activity. Memory/Setup refresh on committed state rather than each token. Reconnect/visibility changes reconcile fully. Page reads defer notifications and recheck revisions; preserve simultaneously invalidated settings scopes.

Sidebar previews return authoritative counts/allocations without prose; full Prompt peek loads on demand and releases its body on close. Debounce idle drafts for one second; while pending, key previews to saved input rather than the next draft. Abort/guard superseded reads and never display a previous chat's result. Budget/coverage computation remains shared with actual requests. Full engine/context work still grows with saved conversation length; bounded Story rendering is not a claim of constant-time preparation or measured battery savings.

## Settings, editing and browser state

Private revisioned sidecars beside the database store LAN, appearance, new-chat defaults and chat behavior. Use strict shared schemas, private temporary files, atomic replacement, preserved malformed files and explicit recovery. These preferences survive content import/wipe but are not content backups. Language packs use installation `languages/`, independently of database overrides. Appearance versions retain legacy explicit colors; omitted old-client fields preserve current values. Read upgrade rules in the owning modules before changing schemas.

`settings-autosave.ts` and `useSettingsAutosave.tsx` serialize changes; App owns queues across navigation. Reconcile a conflict once using only submitted fields. Preserve failed/uncertain edits and read authoritative state on Retry before duplicating writes. Routine saving is silent; cancellable one-second delay alerts and immediate failure alerts use localized descriptors. Poll LAN/languages only while Settings is open; older reads cannot overwrite saves.

Composer drafts synchronously store exact text and staged command identity/revision per chat in localStorage. Ack clears only submitted content, preserving later edits. Definite rejections permit a fresh explicit command; uncertain outcomes retain identity across reload for safe retry. Storage failures retain memory text and prompt copy-before-leaving. Dataset changes require explicit recovered-draft reconciliation. Never persist repair candidates under the composer recovery policy.

Author's notes use chat settings JSON with empty/system/depth-2 defaults, per-chat revision/idle guards, and no backfill for old records. Their autosave queue keeps explicit pending field changes (including reverts after uncertain writes) in epoch/chat browser keys. Requests time out after 15 seconds, retain edits, and expose Retry even outside the popup. Send/retry/regenerate wait for note reconciliation. Closing the popup retains accepted saves; chat switches cannot apply stale responses elsewhere. Notes are ordinary backed-up chat content, excluded from summary inputs. See compatibility for placement.

The shared banner retains error origin: command failures offer Dismiss, loading failures Retry loading, and connection recovery has explicit classification. Background failures/reconnect cannot erase an unresolved action failure or retry a write. Failed editors retain user input; only accepted discard workflows delete drafts.

Shared controls preserve labels, keyboard focus, 44px touch targets and existing hover roles. The Connection model picker fetches on opening with current endpoint/key settings; closing or superseding it aborts its browser request and ignores late results. The modal fits the visual viewport, keeping search and actions in flow around a separately scrolling, incrementally rendered model list. Dialogs initially focus headings/containers rather than an action/slider; restore focus on close. Turn actions retain their selector, with disabled pending placeholders and live cancellation. Inline reasoning preview is passive and preference-gated; on-demand reasoning follows the selected attempt and rejects stale fetches. Library metadata timestamps update transactionally at real changes, not stream checkpoints/reads/retries; unknown legacy dates stay unknown. Sorting is browser-local, deterministic and does not mutate snapshots or prompt state.

## LAN admission

Keep local loopback available separately from the optional listener. `lan-policy.ts` admits eligible private RFC1918 IPv4 interfaces with contiguous /8–/30 masks, excludes tunnel/virtual adapters, and validates the actual socket address, exact hostname/IP+port and current-subnet peer. Forwarded headers never confer trust. The LAN listener cannot create the owner or change LAN settings, including from the server computer. Session/origin/content-type/CSP checks remain active; HTTP has no Secure cookies or transport encryption.

Automatic mode persists enabled intent and recovers offline/busy port 3000 without browser interaction, preferring the existing adapter then stable interface order. Manual mode prepares a replacement listener before the atomic settings commit and preserves the old binding on failure. A serialized queue owns save/recovery/shutdown; recheck interface identity/address/netmask per request and on a three-second monitor. Disable revokes authority and closes LAN sockets before acknowledgement but does not cancel accepted work. Shutdown rejects late bind results and releases timers/sockets.

macOS uses bounded Bonjour LocalHostName discovery; other platforms depend on existing OS hostname resolution. No DNS service, router rule or certificate installer is provided. Treat hostname/device/suspension coverage as platform qualification, not a consequence of browser emulation.

## Documentation maintenance

Keep each accepted rule in its owning contract and link to it. Update only changed product decisions, non-obvious contracts/safety boundaries and operational commands. Do not add a document for every feature, append completed-test narratives, or maintain historical task assignments. Tests/source hold executable detail; documents explain intent and compatibility that cannot safely be inferred. Preserve third-party notices independently of this policy.

## Contained delivery boundaries

`generate-macos-launcher.mjs` embeds the launcher catalog, literal environment reader, archive policy, runtime verifier and Bash bootstrap into the external asset and versioned installed helper. Regenerate both after source changes; `--check` verifies reproducibility. The generator also refreshes the marked catalog/validation block in the internal `start.command`; shared helper eligibility is owned by `macos-helper.sh`. macOS protocol 1 is separate from legacy source/recovery launcher protocol 2. The external bootstrap delegates once to a compatible selected helper, with retained recovery tooling as a compatibility path; unknown protocols fail closed.

The bootstrap owns adjacent-folder ownership, a foreground lifetime lock, bounded HTTPS metadata/archive transfers, `plutil` metadata parsing, archive validation before extraction and private runtime preparation. `snapshot-input.sh` owns build-input allowlisting. `build-portable.sh --snapshot` accepts a downloaded archive with its complete commit, fixed-source provenance and captured digest; it rechecks bytes and re-extracts the allowlist rather than treating a local directory as a clean Git checkout. Existing release/development Git protections remain separate. Source archive digests record transport bytes, not an independent publisher signature.

`macos-install.mjs` supervises the builder's process group and interprets only a bounded dedicated phase descriptor. Dependency/tool stdout and stderr go to the private report, with that descriptor closed for npm/native commands. `stage.mjs` retains notices, native loads, temporary-database startup/UI probes and atomic selections. Snapshot provenance belongs in the manifest; `build-info.json` retains its shared strict public contract.

`portable-launch.mjs` verifies assets/runtime, owns the foreground application process, presents approved messages and catches browser spawn/exit failures. `application-start.mjs` is the installed application's startup boundary: it resolves established database identity, checks compatibility, invokes the server and records database readiness. Store retains SQLite ownership, missing-file enforcement, snapshots and migrations. Retained older applications without that boundary keep explicit compatible recovery guards. Server readiness and ownership/port failures use structured IPC; console matching cannot establish readiness. Saved-data startup never participates in update fallback.

`generate-windows-launcher.mjs` embeds the same catalog plus Windows folder, archive, runtime and controller policy into the single batch asset and BOM-marked installed PowerShell helper. `--check` rejects drift. The ASCII batch prefix reads its UTF-8 payload from its own path passed as environment data; no CALL, delayed expansion or large command-line payload is used. Windows standalone protocol 1 is separate from legacy source protocol 2. Delegation is one-way and checks the complete helper/dependency set; missing, empty, malformed or unreadable selected helpers may use retained recovery tooling. Reparse paths and unknown protocols fail closed.

The Windows bootstrap acquires an exclusive OS file lease and conservative directory ownership record for its whole lifetime. Windows Job Objects attach controllers before spawning descendants, including delegation; owner loss terminates only owned workers. Abrupt termination may leave directory locks for explicit recovery. ZIP entries are validated together for roots, Windows name aliases/collisions, types, traversal and bounds before allowlisted extraction. `build-portable.ps1 -Mode Snapshot` requires the archive, full commit, fixed public-source URL and captured SHA-256, then revalidates/re-extracts it. Release/development Git checks stay separate. Private Node calls npm's CLI directly; `build-windows.mjs` invokes the same TypeScript/Vite checks directly because npm's nested Windows batch shims re-expand installation path metacharacters. Native stdout/stderr go to private reports and do not determine success or phases. Only the stage process receives a bounded private phase file; ordered checking/activation events use that channel instead of inherited Unix descriptors. Existing shared native/startup probes, selections, recovery and application-owned database boundaries remain authoritative.

## Third-party assets

Selected Yandex UI Icons paths in `src/web/Icon.tsx` are adapted under MPL-2.0, not MIT. Preserve `public/third-party/yandex-ui-icons/` attribution/license; Vite emits the exact adapted component source beside those notices in every client build. `PersonaIcon.tsx` uses separate user-supplied mask artwork. Imported/user images and application mark generation remain separate from the icon collection. Root MIT licensing does not replace third-party terms. Native package notices, full GPL/LGPL texts, exact source/patch URLs and the reference libvips build recipe in `scripts/release/third-party/` remain required distribution material.
