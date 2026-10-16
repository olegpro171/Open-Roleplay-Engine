# Roleplay Engine

A personal roleplay application hosted on your Mac. Persistent chat and the second milestone—roleplay libraries and imports—are implemented for local testing: reusable Connections, characters, personas and prompts; multiple chats; streaming; turn editing; cancellation/retry; and saved request inspection.

Durable layered compaction is now the **third milestone** and is not implemented. Full history must fit the input target and Connection window; overflow fails explicitly. The separate Python visualizer remains unchanged; see [VISUALIZER.md](docs/VISUALIZER.md).

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
- **Characters:** create/edit name, description, personality, scenario, greeting and example dialogue. Import legacy/V1 or V2 JSON, or PNG cards with embedded `chara` text metadata. Export V2 JSON. Imported lorebooks, extensions, alternate greetings and prompt overrides are preserved for export but remain inactive. This is basic field compatibility, not full V2 behavior. Card imports are limited to 2 MB.
- **Prompts:** add text blocks or markers, collapse each block, set message roles, enable/disable, drag to an indicated insertion line or use the up/down buttons. Markers include whole character, persona, description, personality, scenario, examples, Messages and Summary. Exactly one enabled Messages marker preserves full history with its original roles. Summary is empty and reported as such in the inspector until compaction is implemented. Duplicate, export/import, edit the built-in default, or use **Restore original**. The initial default is instructions → character → persona → messages.
- **Names:** case-insensitive `{{user}}` and `{{char}}` resolve once in prompt text and card/persona fields using selected names (fallbacks: You / Character). Other macros stay literal. Stored conversation text is not reprocessed. New chats copy and resolve the character's greeting into a completed opening turn; later card edits do not change it. Its empty user bubble is hidden.
- **Chats:** each keeps its own selections and target. Shared library edits affect future requests in all selecting chats; saved generation requests and copied greetings keep their historical text. Shared edits are blocked while any response runs. Referenced library items cannot be deleted until chats stop selecting them. Switch chats through **Libraries → Chats**. Any idle chat can be deleted, including the original or final chat; deleting the current chat keeps the library open. Generation and pending-turn blocking are per chat.
- **Replace history:** under **Setup**, choose a SillyTavern-style `.jsonl` file, review the message/turn counts, then click **Replace all messages**. Only active `mes` text and `is_user` roles are imported. Foreign summaries, memory snapshots, alternate swipes, sender metadata and `hiddenFromAI` flags are excluded. The complete active transcript is imported, including messages previously hidden by another application's compaction. Chat selections remain unchanged; old turns and their request records are replaced together. No greeting is prepended.

Chat imports stream-read files up to 128 MB, with at most 50,000 messages, 100,000 characters per message, 8 million characters per JSONL line, and 20 million active text characters total. Invalid/unsupported input, stale chat revisions and active generation leave saved history unchanged. System messages are rejected rather than silently reclassified. Ordinary user/assistant entries form turns; consecutive same-speaker entries retain separate turns with an empty opposite part. Historical turns are complete; only a final unpaired user entry awaits a response. An optional leading SillyTavern metadata record is ignored. This is a text transcript importer, not restoration of another application's memory or group-chat state.

The version-2 database migration retains the existing chat, turn/part identities, revisions, credentials and saved request records. Existing inline character/persona/instructions become reusable records. Stop the previous server before launching the updated application; the launcher does not modify the original export files.

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

Verified behavior includes card/JSONL normalization, prompt arrangement and name resolution, greeting copying, boundary-newline trimming, model discovery with credential exclusion, deletion of the original/final chat, transactional history replacement, version-1 migration, concurrent chat isolation, shared-edit revision checks, concurrent submission blocking, idempotent command retries, blank edits, exact request-body inspection, credential exclusion, disconnected observers, cancellation, explicit retry, persistence across restart, hard-crash recovery, and rejection of a second server on the same database. On 2026-10-16, the user confirmed a successful first response through the OpenRouter API. Broader provider compatibility and actual phone keyboard/suspension behavior still need hands-on checks.

## Model protocol and budgets

The initial adapter implements text-only **OpenAI-compatible Chat Completions**, posting to `<API base URL>/chat/completions` with `model`, `messages`, `stream: true`, and `max_tokens`. It expects `text/event-stream` events with `choices[0].delta.content`, a `stop` or `length` finish reason, and `[DONE]`. Optional **Fetch model list** discovery reads `<API base URL>/models` using an entered or saved key and offers filtered suggestions in Model identifier. Manual model entry remains available when discovery is unsupported. Responses API, tools, images, alternate output-limit fields, and Anthropic are not implemented. Endpoints that require a different dialect need a later adapter change.

Supported custom JSON parameters are `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, `stop`, and `reasoning_effort`. Unknown fields are rejected; custom parameters cannot replace messages, model, streaming, or the reserved output limit. A provider may reject a parameter it does not support. URLs cannot embed credentials, query parameters, or fragments. Credentials are sent only through the Authorization header; redirects are refused.

Prompt order follows the selected preset. Nonempty text/field markers become messages with their configured roles; the Messages marker inserts saved conversation parts in order. Blank parts are omitted from outgoing messages while their turns remain in saved coverage. All resolution happens before input estimation and saved request inspection.

As approved for this milestone, input measurement uses UTF-8 bytes of serialized messages plus 128 framing units and 16 per message. This conservative **estimate is not a verified model token count**. Both preview and saved requests label it. Estimated input must fit the chat target; estimated input plus reserved output must separately fit the Connection's combined context window. The target is input-only, so output is not subtracted from it again. Overflow fails explicitly; history is never silently dropped. Model-specific counting remains future work.

## Storage and recovery

SQLite uses WAL, foreign keys, versioned SQL migrations, and short transactions. Turns and their parts have stable identities and separate part revisions. Every mutation checks the chat revision; edits and setup changes are blocked while a response runs. Only one turn per chat can be pending, and only one generation per chat can be active. Different chats may generate concurrently. The database records process ownership so a second local server cannot mark a live operation interrupted.

Each generation saves its resolved body and source coverage before calling the model. Saved records describe historical requests even after later edits. Deleting a whole turn also deletes its associated generation records. The browser subscribes to change notifications and retrieves current saved state on connection/reconnection; SSE events are not treated as a durable token log.

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
