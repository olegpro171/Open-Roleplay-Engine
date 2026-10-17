# Roleplay Engine

A personal roleplay application with the in-app name **ORE**, currently hosted locally on this Mac. Persistent chat and the second milestone—roleplay libraries and imports—are implemented for local testing: reusable Connections, characters, personas and prompts; multiple chats; streaming; turn editing; cancellation/retry; and saved request inspection.

The **third milestone**, durable layered compaction, is implemented for local testing: prepare imported sessions, inspect a layered timeline, edit summaries, and review targeted repairs. Context presets select a separate summarization Connection and editable extraction/compression prompts. Normal generation prepares context when needed. The standalone Python visualizer remains available; see [VISUALIZER.md](docs/VISUALIZER.md).

Generated summaries are checked for obvious refusals, placeholders, empty output, repetition loops and incomplete/truncated responses before they can replace source context. These are basic heuristics, not verification of summary facts. Real-model narrative quality and actual phone use remain unverified.

## Start on this Mac

Dependencies are installed in this workspace. Double-click **start-app.command**, or run:

```sh
./start-app.command
```

The launcher selects a working Node.js LTS runtime, builds the interface and server, and prints the local address (normally `http://localhost:3000`). Leave its terminal open. Stop it with Control-C.

On first launch, create the owner password on the Mac. Open **Libraries → Connections**, create a Connection with your API base URL, model identifier and optional API key. Create/import characters and personas in their libraries, then select them under **Setup**, or use **Libraries → Chats → New chat**. Write a turn on **Story**; use **Request inspector** to examine a saved attempt or preview the next request.

Saved data lives in `data/roleplay.sqlite`. Failed, cancelled and interrupted responses leave their existing turn pending. Retry that response or delete the entire turn before sending another. Partial output is visible for inspection, but cannot yet be accepted as a completed response. Clearing either part of a completed turn preserves its completion and membership. Submissions, successful AI responses, copied greetings and part edits remove blank lines at the beginning and end while retaining internal paragraph breaks and indentation. Existing history and imported transcripts are not rewritten; a blank submission is rejected and whitespace-only model output leaves the turn pending.

## Libraries, prompts and chat import

- **Personas:** create/edit name and description; import SillyTavern persona-backup JSON or a basic `{ "name": "…", "description": "…" }` object. Export uses SillyTavern's persona-backup shape. Avatars and SillyTavern positioning/locks are not imported.
- **Characters:** create/edit name, description, personality, scenario, greeting and example dialogue. Import legacy/V1, V2 or V3 JSON, or PNG cards with embedded `chara`/`ccv3` text metadata (prefer `ccv3` when both exist). Export V2 JSON for legacy/V2 cards and preserve V3 format for imported V3 cards. Imported lorebooks, extensions, alternate greetings and prompt overrides are preserved for export but remain inactive. This is basic field compatibility, not full V2/V3 behavior; V3 assets, lorebooks, nicknames and extra greeting behavior remain inactive. Card imports are limited to 2 MB.
- **Prompts:** add text blocks or markers, collapse each block, set message roles, enable/disable, drag to an indicated insertion line or use the up/down buttons. Markers include whole character, persona, description, personality, scenario, examples, Messages and Summary. Exactly one enabled Messages marker inserts the selected verbatim tail with its original roles. Summary inserts selected historical memory; when no enabled Summary marker exists, memory appears immediately before Messages. Both share one saved coverage selection, so history is not injected twice. Duplicate, export/import, edit the built-in default, or use **Restore original**. The initial default is instructions → character → persona → messages.
- **Names:** case-insensitive `{{user}}` and `{{char}}` resolve once in prompt text and card/persona fields using selected names (fallbacks: You / Character). Other macros stay literal. Stored conversation text is not reprocessed. New chats copy and resolve the character's greeting into a completed opening turn; later card edits do not change it. Its empty user bubble is hidden.
- **Chats:** each keeps its own selections and target. Shared library edits affect future requests in all selecting chats; saved requests and copied greetings keep their historical text. Shared edits are blocked while any response or preparation runs. Referenced library items cannot be deleted until chats/presets stop selecting them. Switch chats through **Libraries → Chats**. Any idle chat can be deleted, including the original or final chat; deleting the current chat keeps the library open. Generation and pending-turn blocking are per chat.
- **Replace history:** under **Setup**, choose a SillyTavern-style `.jsonl` file, review the message/turn counts, then click **Replace all messages**. Only active `mes` text and `is_user` roles are imported. Foreign summaries, memory snapshots, alternate swipes, sender metadata and `hiddenFromAI` flags are excluded. The complete active transcript is imported, including messages previously hidden by another application's compaction. Chat selections remain unchanged; old turns and their request records are replaced together. No greeting is prepended.

Chat imports stream-read files up to 128 MB, with at most 50,000 messages, 100,000 characters per message, 8 million characters per JSONL line, and 20 million active text characters total. Invalid/unsupported input, stale chat revisions and active generation leave saved history unchanged. System messages are rejected rather than silently reclassified. Ordinary user/assistant entries form turns; consecutive same-speaker entries retain separate turns with an empty opposite part. Historical turns are complete; only a final unpaired user entry awaits a response. An optional leading SillyTavern metadata record is ignored. This is a text transcript importer, not restoration of another application's memory or group-chat state.

The version-2 database migration retains the existing chat, turn/part identities, revisions, credentials and saved request records. Existing inline character/persona/instructions become reusable records. Version 3 adds context state, summary versions, preparation jobs and saved steps without rewriting transcripts or enabling model calls for existing chats. Version 4 adds nullable provider token usage to generation records; old requests retain their original bodies and have no retroactive usage counts. Replacing history clears that chat's old memory and preparation records atomically. Stop the previous server before launching the updated application; the launcher does not modify original export files.

## Prepare an imported roleplay session

1. Create a summarization Connection in **Libraries → Connections**. It may use a different model or the same reusable Connection as roleplay.
2. Open **Libraries → Context presets**, edit the supplied preset or create one, select its summarization Connection, and save its settings/prompts.
3. Import the transcript through **Setup**, then select the context preset in Setup or **Memory**. Set the chat's input target.
4. Open **Memory**. **Save next summary** performs one budget-driven step; **Prepare chat** continues until the current assembled input fits. Preparation makes real model calls. **Stop preparation** retains completed replacements. Resume explicitly after cancellation, failure or server interruption; interrupted calls are never automatically repeated.
5. Inspect summary spans, source coverage, saved preparation steps and summary request bodies. Historical timeline navigation only changes the view. Later turns are not added to earlier job snapshots. New response requests remeasure the complete input, including pending user text, and prepare further if necessary.

The editable starting values match the lab: minimum tail 8 completed turns, fixed batch 3 turns, requested summary size 750 tokens, promotion group 3 summaries and retained floor 3 per source level. They are starting values, not validated quality defaults. Keep all history verbatim while it fits; under pressure summarize complete oldest batches without dropping below the minimum tail. Residual turns stay verbatim. Promote only when no first-layer batch is eligible, using actual active-layer sizes and the accepted geometric-pressure rule. Stop as soon as input fits and preserve the committed selection across requests and restarts; spare capacity does not reactivate children.

The summary-size setting is a soft prompt target. The summarization Connection's reserved output controls the actual `max_tokens` and physical input/output check; it is not subtracted from the roleplay input target. Aim below that output reservation to avoid truncation. Instructions and the entire fixed source batch must fit the summarizer's window; sources are not silently split or truncated. Up to three preceding selected summaries are included for reference when they fit, with explicit revision dependencies. Repair can also use current approved versions of its original earlier dependencies, including retained children. Later events are never supplied as prior context. Generated output must reduce the complete roleplay input before a normal compaction replacement is committed.

Archived turns remain readable and editable. Edits/deletions invalidate dependent memory, including higher layers and summaries that read changed earlier context. Roleplay pauses while selected memory is stale. **Repair next affected summary** works from affected children upward, supplying the old summary and previous/current sources. Each candidate awaits review; edit its proposed text if needed, then **Approve replacement** or **Discard candidate**. Continue repairing until selected memory is current. A longer approved correction may require further preparation. Reviews reject results after intervening chat/settings edits.

Select a current summary span and use **Edit summary** for a manual correction. Earlier versions remain saved, and dependent summaries require repair. Text edits preserve source-revision links; editing a stale summary's wording does not mark its old sources current. If every covered source turn was deleted, repair proposes removal of that coverage without a model call and still requires review. Entirely blank but still-present batches are not silently removed; unusable/non-shrinking results stop preparation.

**Clear memory** explicitly deletes every summary layer, old version, review candidate and preparation record for this chat. Original turns return to verbatim; the selected preset and saved roleplay requests remain unchanged. Clear memory before disabling context management. Changing a preset or raising a budget preserves existing selections; new settings govern future steps. Increasing the protected tail, or deleting recent turns, can require clearing memory if the old cutoff no longer satisfies the tail floor. There is no automatic partial detail-restoration policy, branch support or proactive processing after responses.

The Story sidebar shows **Total turns**, **Active turns** (saved turns kept verbatim), the input target and the current assembled input estimate. Expand **Context** for a color-coded allocation and **Prompt peek**, showing resolved messages in model order. Estimates include unsent composer text; partial assistant output is excluded. Overflow bars turn red, and near-limit bars turn blue. **Request inspector** defaults to current input and immediately reflects saved setup changes. Choose a saved attempt to inspect its exact historical request and ceiling. Endpoint and request JSON are collapsed under **Endpoint and request body**.

The chat composer places **Send** beside the textbox on wide screens and below it on narrow screens. Resizing keeps the visible turn and the reading position within it stable; **Latest turn** jumps immediately to the end. Generation uses a compact neutral status row. The **Summary layers** timeline keeps layer labels beside the plot, doubles zoom spacing to 40 pixels per turn, hides summary labels that do not fit and shows immediate hover/focus hints. When individual turn cells would be narrower than 5 pixels, contiguous archived and verbatim ranges become proportional grey and green bands.

Completed generated turns show endpoint-reported input/output tokens beside the turn number. Imported turns and greetings have no generation usage; older or unsupported endpoint responses show usage as unavailable. Counts describe the original request/response before later edits and may include reasoning in the endpoint’s output count.

## Installation and development

Use **Node.js 24 LTS**, or Node.js 22.12+, with npm. Exact package versions are recorded in `package.json` and `package-lock.json`. Do not share `node_modules` between different Node major versions: better-sqlite3 is a native dependency. This workspace was built and tested with Node.js 24.19.0.

```sh
npm ci
npm run build
npm start
```

For development, run these in two terminals, then open the Vite address:

```sh
npm run dev
npm run dev:ui
```

The first command watches the server on port 3000; the second serves the interface on port 5173 and forwards API requests. Normal use runs the built interface and API together through Fastify. The Mac must remain awake for generation and phone access.

If the shell selects this Mac's Node 26 installation, use the launcher, or select the working bundled LTS runtime for this terminal:

```sh
export PATH="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH"
```

## Verification

```sh
npm test
npx playwright install chromium
npm run build
npm run test:e2e
```

`npm run check` runs the build, core/server tests, and browser workflow together. Tests use temporary databases and a synthetic local model endpoint, never saved user chats or real provider credentials. Browser tests cover a desktop and a separate phone-sized browser session. Network-enabled execution is needed for the local test servers.

Verified behavior includes the earlier chat/library/import checks plus fixed batches and tails, unequal summary sizes, Python-reference parity across 3,000 synthetic requests, checkpoint continuation and the 301→302 regression, transactional save-and-select rollback, safe retries, stale-source rejection, separate summary credentials, automatic preparation before roleplay, cancellation/interruption, targeted repair review, manual corrections, and desktop/phone-sized memory workflows. Tests use synthetic model responses; they establish structural behavior, not narrative recall. On 2026-10-16, the user confirmed a successful first roleplay response through OpenRouter. Real-model summary quality, broader provider compatibility and actual phone keyboard/suspension behavior still need hands-on checks.

## Model protocol and budgets

The initial adapter implements text-only **OpenAI-compatible Chat Completions**, posting to `<API base URL>/chat/completions` with `model`, `messages`, `stream: true`, `max_tokens`, and (by default) `stream_options: { "include_usage": true }`. Disable **Request token usage from the endpoint** in a Connection if it rejects this streaming option. The adapter reads `prompt_tokens`, `completion_tokens` and `total_tokens` from usage metadata, including a final empty-choice chunk; absent or invalid usage does not fail an otherwise valid response. This follows the [official streaming usage format](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events). It expects `text/event-stream` events with `choices[0].delta.content`, a `stop` or `length` finish reason, and `[DONE]`. Roleplay retains its existing `length` acceptance; summaries require `stop` to avoid accepting truncated memory. Explicit refusal metadata and `content_filter` outcomes fail safely. Optional **Fetch model list** discovery reads `<API base URL>/models` using an entered or saved key and offers filtered suggestions in Model identifier. Manual model entry remains available when discovery is unsupported. Responses API, tools, images, alternate output-limit fields, and Anthropic are not implemented. Endpoints that require a different dialect need a later adapter change.

Supported custom JSON parameters are `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, `stop`, and `reasoning_effort`. Unknown fields are rejected; custom parameters cannot replace messages, model, streaming, or the reserved output limit. A provider may reject a parameter it does not support. URLs cannot embed credentials, query parameters, or fragments. Credentials are sent only through the Authorization header; redirects are refused.

Prompt order follows the selected preset. Nonempty text/field markers become messages with their configured roles; Messages inserts selected verbatim parts in order. Historical summary text uses the Summary marker's role, or system when automatically inserted before Messages. Blank parts are omitted while their completed turns remain in saved coverage. All resolution happens before input estimation and saved request inspection.

As approved for this milestone, input measurement uses UTF-8 bytes of serialized messages plus 128 framing units and 16 per message. This conservative **estimate is not a verified model token count**. Both preview and saved requests label it. Estimated input must fit the chat target; estimated input plus reserved output must separately fit the Connection's combined context window. The target is input-only, so output is not subtracted from it again. Overflow fails explicitly; history is never silently dropped. Model-specific counting remains future work. A checked Gemma/OpenRouter request was overestimated by approximately 5× with complete selected coverage; see [diagnostics](docs/DIAGNOSTICS.md).

## Storage and recovery

SQLite uses WAL, foreign keys, versioned SQL migrations, and short transactions. Turns and their parts have stable identities and separate part revisions. Every mutation checks the chat revision; edits and setup changes are blocked while a response or preparation runs. Only one turn per chat can be pending, and only one generation/preparation workflow per chat can be active. Different chats may run independently. Summaries, dependencies, selected revisions and the cutoff are durable; each valid replacement and its selection commit together. The database records process ownership so a second local server cannot mark a live operation interrupted.

Each generation saves its resolved body and source coverage before calling the model. Saved records describe historical requests even after later edits. Deleting a whole turn also deletes its associated generation records. The browser subscribes to change notifications and retrieves current saved state on connection/reconnection; SSE events are not treated as a durable token log.

Preparation separately saves each credential-free summary request and step outcome. Generated repair candidates are retained but unselected until approved; approval checks the captured chat/configuration revision. A process crash preserves committed summaries, marks running preparation and unfinished steps interrupted on restart, and requires an explicit resume. Review candidates survive a restart. No model stream is claimed to be resumable. The initial viewer lists the latest 20 jobs per chat; older records remain stored and available by operation identity until memory is explicitly cleared. Automatic retention/pruning remains future work.

Partial output is checkpointed on incoming chunks at most once per 250 ms, plus explicit cancellation and graceful shutdown. A hard crash may lose output received since the last checkpoint. On restart, running operations become interrupted; no new model request is made until an explicit retry. The provider stream itself does not resume. A transport timeout, malformed/truncated stream, unsupported completion outcome, or empty response leaves the turn pending.

The database file is owner-readable/writable and a newly created data directory is private. The owner password is salted and hashed with scrypt; sessions are random, stored as hashes, and expire after seven days. Saved API keys currently reside in the local database in plaintext, protected by filesystem permissions. They are excluded from public responses, previews and application logs. OS keychain integration/encryption and a password-reset flow are not yet implemented. Do not publish or casually copy the data directory. No backup/restore feature is claimed; copying only an active WAL database's main file is not a dependable backup.

## Phone access

The default server listens on loopback only. Plain HTTP LAN binding is refused. Create the owner account locally first, then provide a certificate and key trusted by your Mac and phone, covering the hostname or LAN address you will use:

```sh
ROLEPLAY_HOST=0.0.0.0 \
ROLEPLAY_TLS_CERT=/absolute/path/to/certificate.pem \
ROLEPLAY_TLS_KEY=/absolute/path/to/private-key.pem \
./start-app.command
```

The server then prints available LAN addresses. Use an address covered by the certificate and allow access through the Mac's firewall if required. Login sessions use Secure cookies with HTTPS. Certificate provisioning and trust installation have not been selected or tested on the actual phone; routine phone use remains pending that setup. No certificate or trust settings are installed by this project.

Optional environment settings: `ROLEPLAY_PORT` (default 3000), `ROLEPLAY_HOST` (default 127.0.0.1), `ROLEPLAY_DATABASE` (default `data/roleplay.sqlite`), and the paired TLS certificate/key paths above. Run commands from this project directory so built files and migrations resolve correctly.

## Source boundaries

- `src/core`: framework-independent prompt assembly and budgeting.
- `src/shared`: safe public contracts and runtime command validation.
- `src/persistence`: SQLite schema, migrations, revisions and transactional commands.
- `src/provider`: explicit HTTP/stream adapter.
- `src/server`: owner sessions, API/SSE and server-owned generation coordination.
- `src/web`: responsive browser interface.
- `tests`: application, persistence, crash-recovery, and browser workflow checks.
- `migrations`: versioned application database schema.
- `docs`: context-editing design and visualizer usage guide.
- `experiments/compaction`: isolated Python visualizer, reference model, tests, and launcher.

`README.md`, `AGENTS.md`, `CONCEPTS.md`, and `IMPLEMENTATION.md` stay at the root as the main entry points, alongside application configuration and `start-app.command`. Generated dependencies, builds, test output, local databases, environment files, and certificate/private-key files are excluded from Git. Your saved chat and Connection credentials remain in the local `data/` directory.

Product rules and remaining decisions live in [CONCEPTS.md](CONCEPTS.md) and [IMPLEMENTATION.md](IMPLEMENTATION.md).
