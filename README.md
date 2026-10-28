# ORE — Open Roleplay Engine

ORE is a self-hosted AI roleplay frontend focused on simple everyday use, precise prompt customization, and inspectable long-term memory. It runs on your computer and opens in a browser, with optional phone access on the same local network.

**Status:** being prepared for a small beta. These instructions describe current `main`; older portable archives have their own instructions. Real-model memory quality and broader platform/device behavior are still being evaluated.

## A word from the author

Why another AI roleplay frontend? I wanted something simple, lightweight, and minimalistic: easy to get started with, but flexible enough to control exactly what the model receives.

Everything I found fell short of what I wanted in one way or another, so I made my own. For the most part, this is a passion project.

I won't pretend I didn't rely heavily on agentic coding. To be clear, I haven't personally read most of the application's code. My focus has been the product, its interface, and how it feels to use. I've repeatedly tested and refined the everyday workflows myself, alongside the project's automated tests. There are still rough edges and things that need broader testing.

Simplicity is the guiding rule: if a feature isn't necessary for a good roleplay experience, I'd rather leave it out. The current scope doesn't include voice calls, text-to-speech, music players, background managers, or visual-novel-style animated sprites. I'd rather make the essentials comfortable and dependable.

## What you will find here

- Character JSON/PNG imports with supported V1/V2/V3 fields, alternate greetings, portraits and local tags; simple reusable Personas.
- Lorebooks and a block-based prompt editor with inspection of resolved model input.
- Layered Narrative Memory: inspect, correct and repair summaries of older conversation.
- Reusable Connections for text-only OpenAI-compatible Chat Completions endpoints.
- Persistent chats with streaming, cancellation/retry, latest-response alternatives, local composer drafts and saved request inspection.
- Desktop/mobile layouts, highlighted direct speech, speech colors, text scaling, Dark/Light/Midnight Black themes, and English/Russian interfaces.
- Content backups and explicit recovery controls. No built-in analytics or usage telemetry.

Card/provider support is a defined compatibility subset, not complete external-app equivalence. JSON card export is available; updated PNG card export is not. The client aims to stay lightweight; battery savings have not been measured.

## Layered Narrative Memory

Long conversations eventually outgrow a model's input window. ORE keeps recent turns verbatim, summarizes older turns in batches, and can compress groups of summaries into higher layers. This changes model input without deleting the original conversation.

You control the working input target, recent-history minimum, batch sizes and summarization prompts. Memory can use the chat Connection or a separate one. Inspect the layers and source turns, edit incorrect summaries, and review repairs after changing earlier events. Completed preparation steps remain saved if later work fails or you stop it.

Summarization is lossy. Structural checks and refusal detection cannot guarantee retention of every important fact across thousands of messages. Preparation/repair can incur provider charges. The [memory contract](docs/CONTEXT.md) explains the detailed rules.

## Setup

You need a computer, a browser and access to a supported model endpoint. ORE includes neither a model nor an API subscription; a local server can work if it implements the supported Chat Completions protocol.

### macOS standalone launcher candidate

The local candidate is [ORE-launcher.command](ORE-launcher.command). Once published, the intended download is that single file from [Releases](https://github.com/olegpro171/Roleplay-Engine/releases), placed in your chosen writable folder. All managed files go into its adjacent `ORE-internal/`; unrelated files in the chosen folder are preserved. Git, Node/npm, Homebrew and developer tools are unnecessary. macOS 13.5+ on native arm64/x64 is targeted; Intel and clean-machine qualification remain pending.

The first launch downloads the exact current-main source snapshot and a verified private toolkit, installs locked dependencies, builds and checks the app, then starts it. Later launches check main and skip installation/building when unchanged. Initial setup may take several minutes. Keep the terminal open while using ORE; stop with **Ctrl+C**. The ready URL appears only after the server confirms startup. Approved English/Russian console messages follow the macOS system language; detailed diagnostics stay in `ORE-internal/logs/`.

Safari may save the downloaded script without executable permission. Before the first run, open Terminal and grant permission to that one file:

```sh
chmod u+x "/absolute/path/ORE-launcher.command"
```

Replace the example with the file's actual absolute path. Keep the double quotes, especially when folder names contain spaces; they make the path one command argument. Afterward, double-click the launcher normally. This one-time step grants your account execute permission; it does not approve macOS trust prompts or remove quarantine. If macOS blocks the trusted download, use its separate per-file **System Settings → Privacy & Security → Open Anyway** approval when offered. No global security changes, ZIP, app bundle, installer package or signing solution is required for this delivery stage.

The candidate has not been published. The accepted permission workaround does not establish clean-machine, Intel or published-download qualification. See [delivery and recovery](docs/RELEASES.md).

### Windows standalone launcher candidate

The local candidate is [ORE-launcher.bat](ORE-launcher.bat). Put this single file in a chosen writable folder and double-click it in Explorer. All installation files, persistent `.env`, data and private logs go into adjacent `ORE-internal/`; unrelated parent files stay in place. First setup downloads exact public-main sources and a checksum-verified private Node/npm toolkit, builds and checks ORE, then starts it. Later runs reuse unchanged builds and caches. Keep the console open while using ORE; stop with **Ctrl+C**. Console messages follow Windows UI language (Russian or English fallback); app language is separate. Set `ORE_OPEN_BROWSER=0` in `ORE-internal/.env` to disable browser opening.

This targets native Windows x64 with built-in 64-bit Windows PowerShell 5.1/.NET. Git, global Node/npm, PowerShell 7 and developer tools are unnecessary. Normal setup in a user-owned directory does not request elevation. The unsigned asset respects Windows trust prompts and organization execution policy; do not weaken global policy. ARM64/emulation, fresh accounts and downloaded-asset trust prompts require separate qualification. The candidate is unpublished: public `main` must contain this implementation before an ordinary external first install can work. See [delivery, configuration and recovery](docs/RELEASES.md).

### Existing Windows/Linux source startup

Install [Git](https://git-scm.com/), clone the public repository, then run `start-app.bat` (Windows x64) or `./start.sh` (Linux). These existing entries retain their Git-based source updater and repository-local `ore-portable/` layout; they download their own Node/npm. Windows uses PowerShell 5.1; Linux needs Bash, curl, tar and SHA-256 tooling. Linux standalone delivery is deferred. The old macOS source entry remains a technical compatibility path; the owner continues using `start-dev.command`.

Windows x64 has native synthetic launcher/build evidence; Explorer/download-trust and fresh-machine qualification remain separate. Linux remains unqualified. Launchers are unsigned. Older portable releases retain their bundled instructions.

### From a portable archive, without updates

If [Releases](https://github.com/olegpro171/Roleplay-Engine/releases) provides an archive for your platform, verify its supplied checksum and extract the entire archive into a writable folder. Keep its supporting files together and follow its bundled instructions.

For a current-format archive, create a plain-text `.env` beside its launcher:

```dotenv
ORE_SKIP_UPDATE=1
```

Run included `start.command` (Mac/Linux) or `start-app.bat` (Windows). This uses the already-built runtime without Git or Node installation. The skip option cannot build a fresh source checkout. Remove it and install/configure Git to enable updates. Older prereleases may use a different startup workflow.

### First chat

1. Create the owner password in the browser on the server computer.
2. Under **Libraries → Connections**, create a Connection with your provider's API base URL, key if required, model identifier, context window and reserved output limit. Enter a base URL such as `https://api.openai.com/v1`, not the full `/chat/completions` URL. **Select model** opens an automatically fetched, searchable list; you can also enter an identifier and press **Submit**, even if discovery fails.
3. Create/import a Character and Persona, then use **Libraries → Chats → New chat**.
4. Check the selections and input target in **Chat settings**, then save. Select a Context preset and keep Summary enabled in the Prompt preset to use layered memory.

To continue an existing story, import supported SillyTavern-style `.jsonl` under Chat settings, review counts and confirm **Replace all messages**. This replaces that chat's history/memory: use a new chat or save a backup first. Open **Inspect memory → Prepare chat** before continuing. **Request inspector** shows saved attempts and the next resolved input. **Settings → Language** changes interface language without translating your story or prompts.

## Phone access

After owner setup, enable **Settings → Phone / LAN access** from the server computer. Open the displayed address on a phone on the same trusted network. Keep the computer awake and ORE running; no phone installation is required.

Access defaults off and currently uses unencrypted HTTP on the LAN. HTTPS setup is deferred; do not forward the server port to the internet. Closing a tab/disconnecting does not cancel generation. Reconnect retrieves current state; server interruption may require an explicit retry. Selected iPhone interactions have been checked, but wider device, keyboard, suspension and Home Screen behavior remain unverified.

## Data and backups

Content and saved Connection keys live on the server computer. Standalone candidates default to `ORE-internal/data/roleplay.sqlite`; their configuration is `ORE-internal/.env`, never a parent `.env`. Source/development launchers retain repository `data/roleplay.sqlite`; separate portable installations use their own data directory. Composer drafts are browser/device-local. Content included in requests goes to your configured model endpoint; its privacy policies apply. Remote Markdown images load directly in the browser. Installation/update downloads also use the network.

Local saved keys are not application-encrypted. **Settings → Data backup → Save...** exports chats, memory, pictures, libraries and saved keys. Protect sensitive backups with a nonempty password kept separately; ORE cannot recover it. Anyone with ORE can open a blank-password backup. Backups exclude owner login, browser drafts and machine/application preferences.

Save a backup before replacing content or trying new builds with valuable stories. Use the application backup function rather than copying a running WAL database's main file. See [data boundaries](docs/DATA.md) and [version/database recovery](docs/RELEASES.md#database-upgrades-and-explicit-recovery).

## Development

Read [AGENTS.md](AGENTS.md), the [product contract](CONCEPTS.md) and [architecture/development guide](IMPLEMENTATION.md) before changing the app. They link the focused subsystem contracts. No contributor or issue-reporting process is required for the current small testing group; tell the author the build commit from About ORE and the steps that failed. Keep keys/backups/private conversations out of public reports.

Direct npm commands need Node 24 or Node 22.12+ within major 22. Run `npm ci` when dependencies need installation. Live reload uses `npm run dev` and `npm run dev:ui` in two terminals (ports 3000/5173). Use a separate development database or stop the normal app before sharing it.

```sh
npm run build     # Typecheck and build
npm test          # Core/server/persistence tests
npm run test:e2e  # Browser workflows; build first
npm run check    # Build and both suites
```

Browser tests need `npx playwright install chromium` and permission to run local servers. Tests use temporary data and mock providers; they do not establish real-model summary quality or actual phone support. There is no separate lint command.

## License

Original ORE code is available under the [MIT License](LICENSE). Third-party dependencies and adapted assets retain their own licenses/notices, including the MPL-2.0 Yandex icons. Keep those notices with redistributions; portable builds include the relevant material.
