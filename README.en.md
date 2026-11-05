# ORE — Open Roleplay Engine

[Русский](README.md) | **English**

**Download for Windows x64.** Get `ORE-launcher.bat` from [Releases](https://github.com/olegpro171/Open-Roleplay-Engine/releases).

ORE is an application for AI roleplay on your computer. It focuses on simplicity, detailed prompt customization, and long-term memory. It opens in a browser, with optional phone access on the same local network.

## A word from the author

Why another application for chatting with AI? I wanted an app that was simple to use and offered built-in memory and detailed prompt customization. I couldn't find a project that met these needs without compromises, so I created my own. Above all, this is a passion project.

I won't pretend I didn't rely on AI-assisted development. To be clear, I haven't even read most of the application's code.

I have high standards for interface quality and usability. I tested a range of workflows repeatedly and kept refining the interface.

The app is still in active development, and there may be rough edges. My goal is to smooth them out, and I welcome feedback.

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

## Layered Narrative Memory

Long conversations eventually outgrow a model's input window. ORE keeps recent turns verbatim, summarizes older turns in batches, and compresses groups of summaries as the conversation progresses.

You control the input size at which compaction kicks in, the minimum amount of recent history kept verbatim, batch sizes, and summarization prompts. You can inspect the layers and original conversation text, and correct inaccuracies in summaries.

Of course, this system's memory is only as good as the AI model's ability to extract facts from text and compress earlier summaries while preserving those facts.

## Installation

You need a computer, a browser, and access to a model provider.

### Windows launcher

The installation script is `ORE-launcher.bat`. Download it from [Releases](https://github.com/olegpro171/Open-Roleplay-Engine/releases).

Place this file in the folder where you want to install ORE and double-click it.

The script downloads the latest published Windows package, verifies it, installs it into `ORE-internal/`, and starts ORE. Use the same launcher for future starts and updates. If an update fails to download, ORE can still start using the installed version.

Windows x64 uses the built-in 64-bit Windows PowerShell 5.1 and .NET. See [recovery and legacy installations](docs/RELEASES.md#legacy-installations) for the retired launchers.

### Running from source on macOS

Run `./start-dev.command` from the repository folder. It builds the current working tree into `ore-development/`. See [working-tree development](docs/RELEASES.md#working-tree-development).

## First chat

1. After the server starts, open the displayed address.
2. Create the owner password.
3. To change the language, open **Settings → Interface language**.
4. Under **Libraries → Connections**, import or create a Connection.
5. Create or import a Character and Persona.
6. Under **Libraries → Chats**, choose **New chat** or import an existing solo chat in SillyTavern JSONL format.
7. Review the selected settings, then save.

## Phone access

Enable **Settings → Phone / LAN access** on the server computer. Open the recommended hostname address on a phone on the same local network. If it fails, try the local IPv4 address shown in Settings. This address is available even if ORE cannot find the hostname. Switching addresses may require signing in again. The IPv4 address can change, so check Settings for the current address. The computer must remain on and awake.

## Data and backups

The application stores chat content, character data, API keys, and other data locally on the server computer.

Windows package installations use `ORE-internal/data/roleplay.sqlite` and `ORE-internal/.env`. When running from source, ORE uses `data/roleplay.sqlite` and `.env` in the repository folder.

Request content is sent to your configured model endpoint and is subject to that service's privacy policies.

## Moving ORE on Windows

You can move ORE to another folder. Your chats, settings, and other data move with `ORE-internal/`.

1. Save a backup from **Settings → Data backup** outside the installation folder. Press **Ctrl+C** in the launcher window and wait for ORE to stop.
2. Move `ORE-launcher.bat` and the `ORE-internal/` folder into a writable local folder with no existing ORE installation. Keep the launcher next to the folder and keep the `ORE-internal` name.
3. Run `ORE-launcher.bat` from its new location and check that your existing chats open.

## Uninstalling ORE

1. To keep your chats, memory, libraries, and Connections, create a backup in **Settings → Data backup**. Save it outside the folder you plan to delete (`ORE-internal/` on Windows). Copy any custom language packs you want to keep separately. See [what a backup contains](docs/DATA.md#content-backups).
2. Press **Ctrl+C** in the terminal or launcher window running ORE and wait for it to stop. Closing the browser tab leaves the server running.
3. On **Windows**, delete `ORE-launcher.bat` and the `ORE-internal/` folder. This deletes the app and its saved data. On **macOS**, if you ran ORE from source, delete the repository folder. To remove only the build created by `./start-dev.command`, delete `ore-development/`.

**Temporary files.** If the Windows launcher is interrupted, it can leave `ore-types-*` folders in `%TEMP%`. You can delete these folders manually once ORE has stopped.

Your browser stores drafts, some preferences, and cookies on the device you used to access ORE. To remove them, clear site data for the ORE address on each device.

## Development

Before changing the application, read [AGENTS.md](AGENTS.md), the [product contract](CONCEPTS.md), and the [architecture and development guide](IMPLEMENTATION.md). These documents link to detailed subsystem contracts. No separate contribution or issue-reporting process is required at this stage.

For source development, use Node 24 or Node 22.14+ within major 22.

```sh
npm run build     # Typecheck and build
npm test          # Core/server/persistence tests
npm run test:e2e  # Browser workflows; build first
npm run check    # Build and both test suites
```

Browser tests require `npx playwright install chromium webkit` and permission to run local servers. The WebKit test checks that selecting lorebook entries preserves the scroll position in Safari's browser engine. Tests use temporary data and mock providers.

## License

Original ORE code is available under the [MIT License](LICENSE). Third-party dependencies and adapted assets retain their own licenses and notices, including the MPL-2.0 Yandex icons. Keep these notices when redistributing; portable builds include the relevant material.
