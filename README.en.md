# ORE — Open Roleplay Engine

[Русский](README.md) | **English**

**Download:** go to [Releases](https://github.com/olegpro171/Open-Roleplay-Engine/releases) and download the installer/launcher for your operating system. Follow the instructions for the selected release.

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

If you used the earlier launcher that built ORE on your computer, download the new `ORE-launcher.bat` once and replace the old file in the same folder. Keep the existing `ORE-internal/` folder; it contains your saved data.

The supported platform is Windows x64 with built-in 64-bit Windows PowerShell 5.1/.NET.

### macOS launcher

The installation script is `ORE-launcher.command`. Download it from [Releases](https://github.com/olegpro171/Open-Roleplay-Engine/releases).

Place this file in the folder where you want to install ORE.

The script is usually downloaded without execute permission. Before the first launch, open Terminal and grant the downloaded file permission to run:

```sh
chmod u+x "/path/to/ORE-launcher.command"
```

> To avoid typing the path manually, type `chmod u+x ` in Terminal (with a trailing space), then drag the downloaded script into Terminal. The path will be filled in automatically.

Then double-click the script to run it.

If macOS blocks the downloaded file, approve it individually under **System Settings → Privacy & Security → Open Anyway**.

The script installs ORE into `ORE-internal/`. On the first installation, it downloads the latest source code from the `main` branch and an isolated toolkit, then builds, checks, and starts ORE.

The target platform is macOS 13.5+ on arm64/x64.

## First chat

1. After the server starts, open the displayed address.
2. Create the owner password.
3. Under **Libraries → Connections**, import or create a Connection.
4. Create or import a Character and Persona, then open **Libraries → Chats → New chat**.
5. Review the selected settings, then save.

You can also continue an existing story. Import a SillyTavern-format `.jsonl` file through Chat settings, review the message counts, and confirm **Replace all messages**. This replaces the selected chat's history and memory, so use a new chat or one you no longer need.

## Phone access

Enable **Settings → Phone / LAN access** on the server computer. Open the recommended hostname address on a phone on the same local network. If it does not work, try the local IPv4 address shown alongside it; IPv4 is also available when hostname discovery fails. Both addresses reach the same installation. Switching addresses may require signing in again; browser drafts and language preferences are separate for each address. IPv4 can change, so check Settings for the current address. The computer must remain on and awake.

Closing the phone's browser tab or losing the connection does not cancel generation.

## Data and backups

The application stores chat content, character data, API keys, and other data locally on the server computer.

The database is `ORE-internal/data/roleplay.sqlite`, and configuration is stored in `ORE-internal/.env`.

Request content is sent to your configured model endpoint and is subject to that service's privacy policies.

## Development

Before changing the application, read [AGENTS.md](AGENTS.md), the [product contract](CONCEPTS.md), and the [architecture and development guide](IMPLEMENTATION.md). These documents link to detailed subsystem contracts. No separate contribution or issue-reporting process is required at this stage.

```sh
npm run build     # Typecheck and build
npm test          # Core/server/persistence tests
npm run test:e2e  # Browser workflows; build first
npm run check    # Build and both test suites
```

Browser tests require `npx playwright install chromium` and permission to run local servers. Tests use temporary data and mock providers.

## License

Original ORE code is available under the [MIT License](LICENSE). Third-party dependencies and adapted assets retain their own licenses and notices, including the MPL-2.0 Yandex icons. Keep these notices when redistributing; portable builds include the relevant material.
