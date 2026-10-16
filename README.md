# Roleplay Engine

A personal roleplay application hosted on your Mac. The first milestone now has one persistent chat, one editable Connection, streamed responses, basic instructions/character/persona text, turn editing, cancellation and retry, and saved request inspection.

Layered context compaction is the second milestone and is not implemented. All history is sent verbatim, except deliberately blank parts. The separate Python visualizer remains unchanged; see [VISUALIZER.md](docs/VISUALIZER.md).

## Start on this Mac

Dependencies are installed in this workspace. Double-click **start-app.command**, or run:

```sh
./start-app.command
```

The launcher selects a working Node.js LTS runtime, builds the interface and server, and prints the local address (normally `http://localhost:3000`). Leave its terminal open. Stop it with Control-C.

On first launch, create the owner password on the Mac. Open **Setup**, enter your API base URL, model identifier and optional API key, then save. Character and persona are plain text for now. Write a turn on **Story**; use **Request inspector** to examine a saved attempt or preview the next request.

Saved data lives in `data/roleplay.sqlite`. Failed, cancelled and interrupted responses leave their existing turn pending. Retry that response or delete the entire turn before sending another. Partial output is visible for inspection, but cannot yet be accepted as a completed response. Clearing either part of a completed turn preserves its completion and membership.

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

Verified behavior includes concurrent submission blocking, idempotent command retries, blank edits, exact request-body inspection, credential exclusion, disconnected observers, cancellation, explicit retry, persistence across restart, hard-crash recovery, and rejection of a second server on the same database. On 2026-10-16, the user confirmed a successful first response through the OpenRouter API. Broader provider compatibility and actual phone keyboard/suspension behavior still need hands-on checks.

## Model protocol and budgets

The initial adapter implements text-only **OpenAI-compatible Chat Completions**, posting to `<API base URL>/chat/completions` with `model`, `messages`, `stream: true`, and `max_tokens`. It expects `text/event-stream` events with `choices[0].delta.content`, a `stop` or `length` finish reason, and `[DONE]`. Responses API, tools, images, model discovery, alternate output-limit fields, and Anthropic are not implemented. Model identifiers are entered manually. Endpoints that require a different dialect need a later adapter change.

Supported custom JSON parameters are `temperature`, `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, `stop`, and `reasoning_effort`. Unknown fields are rejected; custom parameters cannot replace messages, model, streaming, or the reserved output limit. A provider may reject a parameter it does not support. URLs cannot embed credentials, query parameters, or fragments. Credentials are sent only through the Authorization header; redirects are refused.

Prompt order is instructions, character text, persona text (each nonempty field is a system message), then conversation parts in order. Marker-like text is literal. Blank parts are omitted from outgoing messages while their turns remain in saved coverage. This is deliberately minimal prompt support, not the full block-and-marker editor or reusable character/persona manager.

As approved for this milestone, input measurement uses UTF-8 bytes of serialized messages plus 128 framing units and 16 per message. This conservative **estimate is not a verified model token count**. Both preview and saved requests label it. Estimated input must fit the chat target; estimated input plus reserved output must separately fit the Connection's combined context window. The target is input-only, so output is not subtracted from it again. Overflow fails explicitly; history is never silently dropped. Model-specific counting remains future work.

## Storage and recovery

SQLite uses WAL, foreign keys, versioned SQL migrations, and short transactions. Turns and their parts have stable identities and separate part revisions. Every mutation checks the chat revision; edits and setup changes are blocked while a response runs. Only one turn can be pending, and only one generation can be active. The database records process ownership so a second local server cannot mark a live operation interrupted.

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
