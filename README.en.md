# ORE — Open Roleplay Engine

[Русский](README.md) | **English**

**Download for Windows x64.** Get `ORE-launcher.bat` from [Releases](https://github.com/olegpro171/Open-Roleplay-Engine/releases).

ORE is an app for chatting with AI, built for long-running roleplay or writing stories. It focuses on long-term memory and easy setup while giving you detailed control over prompts. The app opens in a browser. You can also access it from your phone on the same local network.

## Quick start

To get started, you’ll need a computer and access to an OpenAI-compatible Chat Completions API.

### API options

- [Z.ai API](https://docs.z.ai/guides/overview/quick-start) gives you pay-as-you-go access to GLM models.
- [GLM Coding Plan](https://z.ai/subscribe) worked with ORE in testing. Z.ai lists SillyTavern, an app similar to ORE, among its supported apps. [Supported tools](https://docs.z.ai/devpack/tool/others#supported-tools), [subscription terms](https://docs.z.ai/legal-agreement/subscription-terms#4-usage-rules).
- [NanoGPT](https://nano-gpt.com/models/text?scope=subscription) offers a subscription covering many open-weight AI models, including GLM and DeepSeek.
- [OpenRouter](https://openrouter.ai/pricing) offers access to a wide range of models, including proprietary models such as GPT, Claude, and Gemini. Paid models are billed by usage.
- **Local models.** If you have a powerful PC and want to avoid API costs, you can run some AI models locally. For example, [LM Studio](https://lmstudio.ai/docs/developer/openai-compat) can run a local API server.

Find your provider’s API base URL and get an API key if required.

Next, install **Open Roleplay Engine**.

- **Windows x64.** Download `ORE-launcher.bat` from [Releases](https://github.com/olegpro171/Open-Roleplay-Engine/releases) and run it. Press **Enter** on **Start ORE**.
- **Linux/macOS.** Build from source manually or use the `./start-dev.sh` script. See the [guide to running from source](docs/RELEASES.md#working-tree-development).

After ORE starts, open the displayed address and create the owner password. You’ll need this password to access the app from other devices on your local network.

If the app starts in a different language than you want, go to **Settings → Language → Interface language**.

On the **New chat** page, click **Create** in the **Connection** panel.

1. Enter your provider’s **API base URL**, for example `https://openrouter.ai/api/v1` or `https://api.z.ai/api/paas/v4`, and enter the **API key** if required.
2. Open **Model identifier** and select a model for this Connection or enter its identifier manually.
3. **Send test message** checks whether the selected model responds. If the test succeeds, save the Connection.

That completes the technical setup.

Next, create or import a character. In the **Character** panel, click **Create**, fill in the name and description, and save the character. Add a greeting if you want the character to start the conversation. If you already have a card, choose **Characters → Import character**. ORE reads V1/V2/V3 cards from JSON and PNG files.

Select a character and, optionally, a persona, which describes who you’re playing. Click **Start chat**.

To create another chat, choose **Libraries → Chats → New chat**. You can also import a one-on-one chat from another app in SillyTavern-compatible JSONL format under **Libraries → Chats**.

## A word from the author

Why another app for chatting with AI? I wanted a simple app with built-in long-term memory that was easy to set up. I couldn’t find a project that met those needs without compromises, so I created my own. Above all, this is a passion project.

I used AI to help develop the project and tested the workflows by hand. I have high standards for interface quality and usability, so I test different workflows repeatedly and keep refining the interface.

The app is still in active development, and there may be rough edges. My goal is to polish the features already there and keep the app simple. I’d be grateful for bug reports through [GitHub Issues](https://github.com/olegpro171/Open-Roleplay-Engine/issues).

The guiding principle of this project is simplicity. I prefer to add only features that make the app easier to use or improve the quality of AI responses.

## What you will find here

- A library for characters, personas, and lorebooks.
- A prompt editor and a preview of the assembled messages.
- English and Russian interface languages and several themes.
- Phone access over the local network and data backups.
- No analytics or telemetry collection.

## Layered Narrative Memory

To keep a long story within the input budget, ORE summarizes older turns and sends recent turns to the model verbatim. As the story grows, ORE combines groups of summaries into more compact summaries at the next level.

The input target is set per chat. In the context preset, you can set the minimum number of verbatim turns, group sizes, and summarization prompts. Under **Inspect memory**, you can read a summary, check it against the original turns, and make corrections.

How well the system works depends on the AI model’s ability to extract facts from text and compress earlier summaries while keeping important facts and dropping unnecessary details.

## Installation

You need a computer, a browser, and access to a model provider.

### Windows launcher

The installation script is `ORE-launcher.bat`. Download it from [Releases](https://github.com/olegpro171/Open-Roleplay-Engine/releases).

Place the file in the folder where you want to install ORE and double-click it.

Press **Enter** on **Start ORE**. On first use the launcher downloads and verifies the latest Windows package, installs it in `ORE-internal/`, and starts ORE. On later launches, ORE prepares updates in the background. When the console says an update is ready, restart ORE.

To stay on a particular version, use the arrow keys to choose **Manage versions**. Select an installed build or choose **Browse GitHub releases**, then confirm **Use this version**. The launcher checks the build against your database before switching. A fixed version starts offline and pauses automatic updates. Choose **Latest release · Automatic updates** to resume them. Press **Esc** to go back.

If an older launcher can’t update ORE, download the new launcher from [Releases](https://github.com/olegpro171/Open-Roleplay-Engine/releases), stop the app, replace `ORE-launcher.bat` beside the existing `ORE-internal/` folder, and double-click it.

The `ORE-internal/` folder contains the app’s data. Deleting it will remove your saved data.

On Windows x64, the launcher uses the built-in 64-bit Windows PowerShell 5.1 and .NET.

### Running from a source checkout

Clone the repository and run the script for your platform from its top-level folder.

| Platform | Command |
| --- | --- |
| Windows x64 | `.\start-dev.bat` (or double-click the file) |
| macOS or Linux with glibc | `./start-dev.sh` |

Both scripts build your current checkout, including local edits, into `ore-development/` using a private Node.js runtime, then start the app. Stop the running development session with **Ctrl+C** before rebuilding. [Source build requirements](docs/RELEASES.md#working-tree-development)

If you built a separate portable installation on macOS or Linux, run `./start.command` from that installation folder to start the selected build.

## Troubleshooting

**ORE won’t start after a Windows update.** Read the error in the launcher and open **Manage versions**. Choose the build marked **Last started successfully** or **Previous working version**. If the database has moved, choose **Locate an existing database…** and select its new location. Then choose **Start ORE**. If the build cannot read the saved database, consult the [recovery guide](docs/RELEASES.md#database-upgrades-and-explicit-recovery).

If the launcher menu itself is unavailable, stop ORE and run this command in PowerShell from the folder containing `ORE-launcher.bat`.

```powershell
.\ORE-internal\recover-app.bat --list
```

If the list shows a previous working build, run `.\ORE-internal\recover-app.bat --previous`. Recovery checks that the build can read your saved database. If it succeeds, start `ORE-launcher.bat` again. To resume updates, choose **Latest release · Automatic updates** in the launcher, or stop ORE and run `.\ORE-internal\recover-app.bat --resume-updates`.

On macOS or Linux, run `./recover.command --list` from the portable installation folder. [Recovery options](docs/RELEASES.md#database-upgrades-and-explicit-recovery) · [Older installations](docs/RELEASES.md#legacy-installations)

## Phone access

Enable access under **Settings → Phone / LAN access** on the server computer. On a phone connected to the same local network, open the recommended hostname address. If it fails, try the local IPv4 address shown alongside it. This address is available even if ORE can’t find the hostname. Switching addresses may require signing in again. The IPv4 address can change, so check Settings for the current address. The computer must stay on and awake.

## Data and backups

The app stores chat content, character data, API keys, and other data locally on the computer where it is installed.

By default, Windows launcher installations use `ORE-internal/data/roleplay.sqlite` and `ORE-internal/.env`. When running from source, ORE uses `data/roleplay.sqlite` and `.env` in the repository folder.

ORE sends request content to the model endpoint you configure. That service’s privacy policies apply.

## Moving ORE to another folder on Windows

You can move ORE to another folder. Your chats, settings, and other data move with the `ORE-internal/` folder.

1. Save a backup from **Settings → Data backup** outside the installation folder. Press **Ctrl+C** in the launcher window and wait for ORE to stop.
2. Move `ORE-launcher.bat` and the `ORE-internal/` folder to a writable local folder with no existing ORE installation. Keep the launcher next to the folder and keep the `ORE-internal` name.
3. Run `ORE-launcher.bat` from the new folder and check that your saved chats open.

## Uninstalling ORE

1. To keep your chats, memory, libraries, and Connections, create a backup in **Settings → Data backup** and save it outside the folder you plan to delete. Copy any custom language packs you want to keep separately. See [what a backup contains](docs/DATA.md#content-backups).
2. Press **Ctrl+C** in the terminal or launcher window where ORE is running and wait for it to stop. Closing the browser tab leaves the server running.
3. **Windows.** Delete `ORE-launcher.bat` and the `ORE-internal/` folder. This deletes the app and its saved data. **If you ran ORE from source**, delete the repository folder. To remove only the build created by `start-dev.bat` or `start-dev.sh`, delete `ore-development/`.

**Temporary files.** If the Windows launcher is interrupted, it can leave `ore-types-*` folders in `%TEMP%`. You can delete these folders manually once ORE has stopped.

Drafts, some preferences, and cookies are stored in the browser on the device you used to access ORE. To remove them, clear site data for the ORE address on each device.

## How to report a bug

- **Report a bug.** Check [GitHub Issues](https://github.com/olegpro171/Open-Roleplay-Engine/issues) for similar reports. If there are none, click **New issue**. Describe the problem and how you encountered it. Include your ORE version, browser, and operating system. If it helps reproduce the problem, attach a screenshot or screen recording. Keep your API keys and ORE backups private.
- **Open a pull request.** You can submit a pull request directly for typo fixes, translation corrections, and small fixes where the expected behavior is clear. For new features or changes to prompts, memory, or saved data, discuss the proposal with the maintainer in [GitHub Issues](https://github.com/olegpro171/Open-Roleplay-Engine/issues) first. Fork the repository, create a branch from the latest `develop`, and target `develop` in the upstream repository. Explain why the change is needed, how to test it, and which checks you ran. Link any related issue. Include screenshots for interface changes and regression test results for changes to memory or data storage.

The maintainer merges accepted changes into `develop`, checks the release candidate on `staging`, and promotes the verified commit to `main`. See the [release guide](docs/RELEASES.md#automated-windows-releases) for details.

## Development

Before changing the application, read [AGENTS.md](AGENTS.md), the [product contract](CONCEPTS.md), and the [architecture and development guide](IMPLEMENTATION.md). These documents link to detailed subsystem contracts.

For source development, use Node 24 or Node 22.14+ within major 22.

```sh
npm run build     # Typecheck and build
npm test          # Core, server, and persistence tests
npm run test:e2e  # Browser workflows. Build first
npm run check     # Build and both test suites
```

Browser tests require `npx playwright install chromium webkit` and permission to run local servers. The WebKit test checks that selecting lorebook entries preserves the scroll position in Safari’s browser engine. Tests use temporary data and mock providers.

## License

ORE’s source code is available under the [GNU Affero General Public License, version 3](LICENSE) (`AGPL-3.0-only`). Copyright © 2026 Oleg (olegpro171) and ORE contributors.

The license allows you to use, modify, and distribute ORE. When distributing a build, you must make the corresponding source code available to recipients. If users interact with your modified version over a network, you must offer them its source code at no charge. See the English license text for the full terms.

Third-party dependencies and adapted assets retain their licenses and notices.
