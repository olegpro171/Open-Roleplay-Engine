# ORE — Open Roleplay Engine

[Русский](README.md) | **English**

**Download for Windows x64.** Get `ORE-launcher.bat` from [Releases](https://github.com/olegpro171/Open-Roleplay-Engine/releases).

ORE is an application for AI roleplay on your computer. It focuses on simplicity, prompt customization, and long-term memory. It opens in a browser, with optional phone access on the same local network.

**Status:** the project is ready for its first beta test. Memory quality with real models and behavior across platforms and devices are still being evaluated.

## A word from the author

Why another application for chatting with AI? I wanted a simple app that combines built-in memory, easy setup, and detailed prompt customization. I couldn't find a project that met these needs without compromises, so I created my own. Above all, this is a passion project.

I won't pretend I didn't rely on AI-assisted development. To be clear, I haven't even read most of the application's code.

However, I have high standards for interface quality and usability. I repeatedly tested different scenarios and refined the interface into its current form. I can't guarantee there are no rough edges left, so I welcome any feedback.

The guiding principle of this project is simplicity: if a feature isn't necessary for usability or the quality of AI responses, I'd rather leave it out.

The current plans don't include voice calls, text-to-speech, music players, background managers, or visual-novel-style animated sprites. My priority is to make the core features comfortable and dependable.

## What you will find here

- V1/V2/V3 character imports from JSON/PNG.
- Lorebooks.
- A prompt editor.
- Layered Narrative Memory: the feature this project was built around.
- Connections to Chat Completions endpoints (currently OpenAI-compatible only).
- Desktop and phone interfaces.
- Dark and light themes.
- Russian and English interface languages.
- Data backups and recovery tools.
- (Obviously) no analytics or telemetry collection.

Character card support is limited to a defined set of features.

## Layered Narrative Memory

Long conversations eventually outgrow a model's input window. ORE keeps recent turns verbatim, summarizes older turns in batches, and compresses groups of summaries as the conversation progresses.

You control the working input target, the minimum amount of recent history kept verbatim, batch sizes, and summarization prompts. You can inspect the layers and original conversation text, and edit inaccuracies in summaries.

Of course, this system's memory is only as good as the AI model's ability to extract facts from text and compress earlier summaries while preserving those facts.

## Installation

You need a computer, a browser, and access to a model provider.

### Windows launcher

The installation script is `ORE-launcher.bat`. Download it from [Releases](https://github.com/olegpro171/Open-Roleplay-Engine/releases).

Place this file in the folder where you want to install ORE and double-click it.

The script downloads the latest published Windows package, verifies it, installs it into `ORE-internal/`, and starts ORE. The package includes its own Node runtime; no development tools or local build are needed. Keep using the same launcher for later starts and updates. Saved data, settings, and language packs are preserved. If an update cannot be downloaded, an existing verified installation can still start.

**One-time replacement for existing Windows users.** Stop ORE, replace only the external `ORE-launcher.bat` beside your existing `ORE-internal/` folder, and start ORE again. The launcher shipped with ORE · f553710121c8 reapplies permissions before handing off to the installed app. The replacement skips that work when permissions already match. Keep using the replacement for routine updates. The earlier Windows launcher that built from source also requires a one-time replacement to move to package delivery.

Windows x64 uses the built-in 64-bit Windows PowerShell 5.1 and .NET. See [recovery and legacy installations](docs/RELEASES.md#legacy-installations) for the retired launchers.

### macOS working-tree startup

From the source checkout, run `./start-dev.command` to build and start the current working tree. It builds into `ore-development/` and uses the repository database by default. See [working-tree development](docs/RELEASES.md#working-tree-development).

## First chat

1. After the server starts, open the displayed address.
2. Create the owner password.
3. Under **Libraries → Connections**, import or create a Connection.
4. Create or import a Character and Persona, then open **Libraries → Chats → New chat**.
5. Review the selected settings, then save.

To continue a story from a solo `.jsonl` transcript, use **Import chat from JSONL** next to **New chat** in **Libraries → Chats**, or **Import branch from JSONL** in **Chat branches**. Review the counts and confirm the name. The import creates a new chat or branch with the file’s messages. Use a full ORE backup to restore settings, memory and request history.

## Phone access

Enable **Settings → Phone / LAN access** on the server computer. Open the recommended hostname address on a phone on the same local network. If it does not work, try the local IPv4 address shown alongside it; IPv4 is also available when hostname discovery fails. Both addresses reach the same installation. Switching addresses may require signing in again; browser drafts and language preferences are separate for each address. IPv4 can change, so check Settings for the current address. The computer must remain on and awake.

Closing the phone's browser tab or losing the connection does not cancel generation.

## Data and backups

The application stores chat content, character data, API keys, and other data locally on the server computer.

Windows downloads use `ORE-internal/data/roleplay.sqlite` and `ORE-internal/.env` by default. Working-tree startup uses the checkout’s `data/roleplay.sqlite` and `.env`.

Request content is sent to your configured model endpoint and is subject to that service's privacy policies.

## Development

Before changing the application, read [AGENTS.md](AGENTS.md), the [product contract](CONCEPTS.md), and the [architecture and development guide](IMPLEMENTATION.md). These documents link to detailed subsystem contracts. No separate contribution or issue-reporting process is required at this stage.

For source development, use Node 24 or Node 22.14+ within major 22.

```sh
npm run build     # Typecheck and build
npm test          # Core/server/persistence tests
npm run test:e2e  # Browser workflows; build first
npm run check    # Build and both test suites
```

Browser tests require `npx playwright install chromium` and permission to run local servers. Tests use temporary data and mock providers.

## License

Original ORE code is available under the [MIT License](LICENSE). Third-party dependencies and adapted assets retain their own licenses and notices, including the MPL-2.0 Yandex icons. Keep these notices when redistributing; portable builds include the relevant material.
