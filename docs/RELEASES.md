# ORE — Startup, packaging and recovery

Current operational reference for agents and portable installations. Release identity is a full commit on `main`; existing published tags/archives remain immutable. These commands build/package locally and do not publish or change repository visibility.

## Normal macOS startup

The candidate public entry is a single `ORE-launcher.command`, placed in the user's chosen writable folder. It manages only the constant adjacent `ORE-internal/`. A versioned `.ore-installation` marker distinguishes a recognized partial installation from an unrelated directory/file/link. Collisions fail without modifying that content; recognized incomplete installations retry explicitly. Managed directories, markers and pointers cannot be symlinks. Installation is unprivileged; no automatic sudo, global tools/configuration, Gatekeeper changes or quarantine removal.

The fixed public repository is `olegpro171/Open-Roleplay-Engine`. Bounded HTTPS requests resolve main's complete commit and, for changed releases, require an ahead comparison whose base and merge base match the installed commit. Unknown, behind, diverged, malformed or unavailable metadata cannot authorize an update. Archives use the resolved immutable SHA, never a subsequent moving-main download. Before extraction/execution, validate every path/type/root, reject links/traversal/absolute paths, and extract only the shared build-input allowlist. Do not import root `.env`, saved databases or local outputs. A computed source-archive digest is provenance, not an independent authenticity signature; GitHub can regenerate compressed bytes.

A pinned official private Node runtime is checksum-verified before execution and published only after complete extraction. Locked optional/native packages install with private npm configuration/cache/temp, lifecycle scripts disabled and no compiler fallback. Native smoke, temporary SQLite startup and actual UI/session probes must pass before atomic activation. Runtime/npm caches are reused; unchanged main skips source/dependency/build work. The selected app, previous working pair, recovery toolkit, data, sidecars, pictures, `.env` and installation language packs are retained across updates.

Only approved English/Russian messages reach the ordinary console; system language is selected once from macOS preferences, independently of application language. Unique private plain-text `.txt` reports in `logs/` retain phases, requested download URLs, full commit/runtime/manifest identities and tool/server diagnostics. Build status uses a dedicated bounded descriptor; raw child output cannot determine progress. Do not add environment dumps, credentials, model requests or story text to diagnostics. Logging failure stops startup and never promises a nonexistent report.

A foreground installation lock covers setup and the server lifetime. Contention/cancellation never triggers fallback. Failed update checks/downloads/builds/activation may visibly start a verified usable installed selection. First install has no fallback. Once live application startup begins, any failure stops without automatically trying old code. Application startup owns database identity/compatibility, SQLite opening, snapshots and migrations; the updater never inspects saved SQLite data.

Keep the Terminal window open and stop with Ctrl+C. Ready output/browser opening follows authoritative server IPC; browser spawn errors and nonzero exits show the ready address. `ORE_OPEN_BROWSER=0` omits opening messages. Port/database conflicts never kill foreign processes. Signals and controller loss stop owned processes; interruption does not resume a provider stream or repeat a paid request. Hard termination/power loss can leave locks: confirm no owner remains before removing a stale lock, never remove it because a build is slow.

`generate-macos-launcher.mjs` reproduces the executable root asset and installed helper. Run it with the supported Node, then `--check` and `bash -n ORE-launcher.command` before distribution. Protocol 1 bounds standalone helper compatibility; legacy source/recovery protocol 2 remains separate. Delegation is one-way, never recursive. Both macOS entry points require a readable, nonempty regular helper script and compatible protocol before delegation. An incomplete selected helper may use intact retained recovery tooling; unsafe symlinks and unsupported protocols fail closed. If neither helper is usable, show the approved localized setup failure without claiming a report was created. Selected app tooling updates through app updates; independently retained recovery tooling preserves compatibility after interrupted activation or an explicit older-code selection. A future bootstrap protocol may require replacing the external file.

### Download execution and qualification

Before distributing the standalone asset, its configured source repository must be publicly readable without authentication and `main` must contain the compatible launcher/build implementation. A private repository returns 404 to the unauthenticated bootstrap; publishing a script asset alone does not provide its source inputs.

The local asset is a review candidate; publishing releases/tags/assets is a separate action. The tested Safari raw-download route produced mode `0644` and quarantine. The accepted execution workaround is a one-time permission command for the downloaded file:

```sh
chmod u+x "/absolute/path/ORE-launcher.command"
```

Use the actual absolute path and keep it quoted so spaces remain within one argument. `u+x` grants the owning user execute permission. After this step, run the launcher normally, including by double-clicking it in Finder. Execute permission and macOS trust approval are separate: **Open Anyway** in **System Settings → Privacy & Security** is Apple's per-file trust approval and does not grant the Unix execute bit; `chmod` does not remove quarantine or approve trust. Use per-file approval if macOS offers it for a trusted download. Do not change global security settings or strip quarantine recursively. A ZIP, app bundle, installer package or signing solution is not required for this delivery stage.

The accepted workaround does not qualify the GitHub release download/trust route, pristine accounts, Intel hardware or other macOS versions. A loopback Safari download is narrower evidence. See [Apple's per-file approval guidance](https://support.apple.com/en-us/102445).

### Existing source/portable compatibility

Windows `start-app.bat`, Linux `start.sh`, and the legacy macOS source entry keep their Git-managed `ore-portable/` updater. They fetch/fast-forward only the owned `cache/update-source` checkout, preserving dirty/user source trees and refusing replacement history. Git remains required for those workflows; they are not the macOS standalone path. Existing portable bundles use their included internal startup entry. Windows targets PowerShell 5.1/x64 and retains process-scoped RemoteSigned; organization policy still applies. Do not remove these entries during macOS qualification or repoint the owner's development/portable data.

## Normal Windows package startup

`ORE-launcher.bat` is the single-file Windows x64 installer/updater. Download it from the latest completed Release, put it in any chosen writable directory, including a nonempty Desktop folder, then run it or double-click in Explorer. Managed files stay under constant adjacent `ORE-internal/`. It embeds first-install code and the shared EN/RU catalog; no adjacent helper, Git, global Node/npm, PowerShell 7, WSL or compiler toolkit is required. It uses Windows-supplied 64-bit PowerShell 5.1/.NET and process-scoped RemoteSigned without changing global policy, unblocking files or elevating automatically. Windows UI language selects Russian variants or English fallback. Keep the foreground console open; Ctrl+C stops ORE.

The launcher resolves the latest published Windows release once and downloads its `ORE-windows-x64.json`, `ORE-windows-x64.zip` and `ORE-windows-x64.zip.sha256` from that same release. The descriptor binds the full commit, archive byte count and SHA-256, Windows x64 and package protocol 2. The ZIP already contains the application, production dependencies and private official Node runtime. User machines do not download source, install npm dependencies or compile ORE. Unchanged releases reuse the verified installed package. The ZIP checksum establishes transport integrity against the published metadata, not an independent publisher signature.

Validate every ZIP entry before extraction, rejecting Windows devices, alternate streams, reparse entries, short-name aliases, case/normalization collisions and conflicting file/directory paths. Owned-folder recognition precedes private ACL changes; the parent folder’s permissions are untouched. Stage the package separately before selection. Installation preserves `.env`, saved data and sidecars, database identity, pictures, language packs and retained versions. Failed checks/downloads/installation before live startup may visibly start a verified installed version; cancellation and contention do not permit fallback. Once saved-data startup begins, failure stops without automatically trying older code. The installer never inspects or restores SQLite data.

An exclusive OS file lease covers update and foreground server lifetime. Named kill-on-close Job Objects attach controllers before creating descendants and terminate only owned workers after owner loss. Ownership metadata records the job identity; a new owner waits for that job to become quiescent before changing installation state, including when a prior process has released its lease but its workers are still stopping. Package updates do not create persistent directory locks. The next launch can retry interrupted package work. Old source-based installations may contain directory locks with insufficient ownership information; the installer retires those only when a prior system boot proves their workers cannot survive. If that proof is unavailable, stop old launchers/builds and restart Windows before running the new installer again. Never remove active ownership or kill unrelated processes to make installation proceed.

Run `node scripts/release/generate-windows-launcher.mjs` and its `--check` mode with the supported development runtime after editing embedded sources. The batch asset and installed `windows-package-launcher.ps1` are generated; `windows-package-protocol` records package protocol 2. The generator also retains legacy `windows-launcher.ps1` / `windows-launcher-protocol` 1 for source-build compatibility. Delegation selects only a complete compatible package helper, never the superseded source-builder helper. Existing source-built standalone users download the new external `ORE-launcher.bat` once and place it beside their existing `ORE-internal/`; their data path stays the same. Later starts can keep using that script, with application updates supplying the compatible installed package helper. Source-repository `start-app.bat` remains Git-based; the installed internal entry detects the package helper and uses package updates for a recognized standalone home. Prefer external `ORE-launcher.bat` for ordinary published package startup. Explicit standalone recovery uses `ORE-internal/recover-app.bat --list` / `--previous`; run the external launcher again afterward. Recovery pauses updates and preserves data; it is never automatic database restoration.

### Automated Windows releases

The workflow builds Windows x64 on pushes to `main`; no other platform packages are published by it. It checks out the exact triggering commit, runs `npm run check`, builds with `build-portable.ps1 -Mode Release -Commit FULL_COMMIT -Destination DIRECTORY`, then runs `node scripts/release/ci-package-windows.mjs INSTALL_DIRECTORY OUTPUT_DIRECTORY FULL_COMMIT`. Packaging includes project/dependency notices and excludes saved data, credentials, user configuration and local language packs. Verification checks the complete extracted inventory, native dependencies and a temporary-database startup/UI probe. Package-installer acceptance checks use controlled release transport and copied real package payloads with the actual server and SQLite, including forced-stop relaunch without test cleanup, offline/corrupt-download fallback and populated updates.

The separate publishing job uses the workflow’s scoped `GITHUB_TOKEN` with `contents: write`; users need no GitHub account or token to download public release assets. It creates a draft tagged `build-FULL_COMMIT`, attaches exactly `ORE-launcher.bat`, `ORE-windows-x64.zip`, `ORE-windows-x64.zip.sha256` and `ORE-windows-x64.json`, then publishes the complete release as Latest. Failed builds/verification never replace the current public release. Previously published tags/assets stay unchanged; repeated publication checks the existing release rather than overwriting it. Publishing is ordered so an older workflow cannot demote users to an older release. Running local build/package checks alone does not publish anything.

Manual workflow dispatch on an unmerged branch runs full source verification and `node tests/support/windows-release-acceptance.mjs` without publication. The acceptance harness creates a disposable Git repository whose tree must equal the clean candidate tree, then runs the production Release builder, package verification and package-installer acceptance against that fixture’s synthetic main commit. It never changes the candidate repository’s main or relaxes the production ancestry/clean-source guards. Failed fixtures are retained for diagnosis; their packages are test artifacts, not public releases.

The CI/developer builder still supports clean-Git Release, explicit Development and provenance-checked Snapshot modes. It installs locked dependencies once, collects notices before removing development packages, then prunes offline with lifecycle scripts and metadata writes disabled. Production, shared and optional dependencies remain; source manifests/lockfiles stay unchanged. Only disposable work inside the installation cache may move its dependency tree into staging. Native/startup checks and atomic activation still apply. Full typechecking and automated suites run before distribution; the internal Windows emitter can use TypeScript `--noCheck` without weakening that release checkpoint.

The shared temporary-database startup probe allows 60 seconds for cold startup and requires owned readiness IPC plus successful session/interface responses. Reports record elapsed database-resolution, server-loading, service-initialization and listener-binding milestones; failures include the last milestone and HTTP probe result. Cleanup disconnects the owned controller before forced termination. These checks never open the installation’s saved database. Application startup retains SQLite identity, ownership, schema, snapshot and migration decisions.

The pinned [Node 24 platform contract](https://github.com/nodejs/node/blob/v24.19.0/BUILDING.md#platform-list) lists Windows x64 starting at Windows 10/Server 2016, subject to vendor support. [sharp’s prebuilt platform requirements](https://sharp.pixelplumbing.com/install/#prebuilt-binaries) include Windows x64. These upstream limits do not qualify every Windows version for ORE. CI verifies the packaged application on its selected Windows runner; pristine accounts, actual Explorer download/trust or organization-policy prompts, older Windows versions and ARM64/emulation need separate observation. A Windows run does not qualify macOS/Linux support.

## Configuration and data identity

Standalone entries create a private empty `ORE-internal/.env` only when absent and read it before update decisions, independently of the terminal directory. They never read a parent/source `.env`. Other source/internal entries retain their existing adjacent-file semantics. Files support blank lines, whole-line comments and literal `KEY=value` assignments with optional matching quotes. No execution, expansion, multiline values or inline comments. Explicit environment variables take precedence; Windows source-file values precede installation-file values. Invalid assignments stop with file/line diagnostics. Standalone configuration cannot redefine shell controls or internal `ore_*`, `ORE_HOME`, `ORE_LAUNCH_*`, `ORE_SNAPSHOT_*` and `ORE_DATABASE_*` coordination settings; such lines fail explicitly. External Node/npm injection and cross-compilation settings are sanitized. Direct npm commands do not read this file.

| Setting | Meaning |
| --- | --- |
| `ORE_SKIP_UPDATE=1` | Run an already-installed build without checking updates |
| `ORE_OPEN_BROWSER=0` | Print ready URL without browser opening |
| `ROLEPLAY_PORT` | Local port, default 3000, integer 1–65535 |
| `ROLEPLAY_DATABASE` | Explicit database override; use absolute paths for repeatability |
| `ROLEPLAY_HOST` | Local loopback host by default; HTTP LAN uses Settings instead |
| `ROLEPLAY_TLS_CERT`, `ROLEPLAY_TLS_KEY` | Paired legacy TLS files; provisioning is deferred |
| `ORE_NO_PAUSE=1` | Suppress Windows pause-on-failure for automation |

An empty explicit database path fails rather than selecting another database. Other empty Windows environment values follow .NET unset behavior. Skip-update cannot build a new source checkout. On Bash use `ORE_SKIP_UPDATE=1 ./start.command`; on PowerShell set `$env:ORE_SKIP_UPDATE='1'` before `./start-app.bat`. For persistent skip, put it in installation `.env`.

Standalone installations default to `ORE-internal/data/roleplay.sqlite`. Source/development entries retain `<repository>/data/roleplay.sqlite`; separate portable installations default to their own data directory. Private `database-location.json` tracks relative default and established external identities. Explicit overrides win and relative overrides resolve against the invoking directory. Moving a whole source folder preserves its relative data identity. Once a database location is established, a missing file fails at metadata and SQLite-open boundaries; it must never become an empty replacement. A genuinely new identity may create a database. Nonwritable installations fail without an alternate path.

Ambiguous legacy `database-path.txt` does not guess moved versus external data. Stop ORE, then select an existing file explicitly using source recovery:

```sh
./recover-app.command --database repository
./recover-app.command --database external "/absolute/path/existing.sqlite"
```

Use `recover.command` in separate Bash installations and `recover-app.bat` on Windows. Selection changes location metadata, never creates/restores/overwrites the database. Moving only a database does not move its machine-preference sidecars.

## Installation layout

| Location | Content |
| --- | --- |
| `.ore-installation`, `.env` | Standalone ownership protocol and persistent literal configuration |
| `current`, `working`, `previous` | Selected, actually-ready and retained prior app/runtime pairs |
| `app/<build-id>/` | Versioned dist, migrations, production packages, license/notices, instructions and manifest |
| `runtime/<runtime-id>/` | Private official Node/npm and upstream LICENSE |
| `recovery/<build-id>/`, `recovery/current` | Independently retained recovery toolkit |
| `data/` | Default saved SQLite data/credentials/pictures |
| `languages/` | Preserved runtime JSON language packs |
| `cache/`, `logs/` | Managed updater/build work and private logs |
| `updates-paused` | Explicit recovery pauses automatic main updates |

Updates stage before atomic selection. Existing servers run their original files until stopped. Keep referenced runtimes/apps/toolkits while needed; no automatic pruning occurs. Stop ORE/builds before removing caches or old versions. Deleting the installation can delete data/languages: preserve backups first. The Windows package launcher reconciles interrupted package work on the next launch under its OS lease. Legacy source/macOS directory locks retain explicit recovery: verify no owner process remains before removing only stale lock directories; never remove locks merely because startup is slow.

The Bash builder makes a bounded retry of temporary-file cleanup and reports removal errors without blocking a successfully activated app. It releases its build lock independently of temporary-file cleanup. Failure to release the lock still stops startup; a genuine build failure retains its original exit status.

## Working-tree development

`./start-dev.command` rebuilds current local edits with private Node into `ore-development/` and skips main updates. It does not fetch/commit or select that build in `ore-portable/`; build failure does not launch stale code. Downloads can still be required. Its database default is the same repository data: stop normal ORE or use an explicit development database. It is a built snapshot, without live reload; use npm watch commands in the source development guide for that. Its separate installation has its own recovery entry.

## Exact release and archive procedure

1. Complete review and required checks (`npm run check`) on the intended final sources. Commit the intended changes on `main` through the user's normal workflow; startup never commits or publishes them. Release mode requires clean exact checked-out HEAD reachable on local main, including no untracked source inputs. Use a separate clean checkout if necessary rather than discarding work.
2. Obtain `git rev-parse HEAD`, then build an explicit installation:

   ```sh
   ./build-portable.sh --release FULL_40_CHARACTER_COMMIT "/absolute/path/ORE-release"
   ```

   Windows:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\build-portable.ps1 -Mode Release -Commit FULL_40_CHARACTER_COMMIT -Destination C:\ORE-release
   ```

   Explicit developer snapshots use `--development DIRECTORY` or `-Mode Development -Destination DIRECTORY`. Their commit identifies the base checkout and does not claim clean sources. Git-less direct source runs report unavailable identity.
3. Check About, actual native startup and the affected workflow/recovery checks on the advertised target. The builder's temporary-database probe does not qualify a clean tester machine or downloaded trust prompts.
4. Run the selected application's packager using the private runtime. Read app/runtime IDs from the two lines of `current`:

   ```sh
   /absolute/path/ORE-release/runtime/RUNTIME_ID/bin/node \
     /absolute/path/ORE-release/app/APP_ID/scripts/release/package-portable.mjs \
     /absolute/path/ORE-release /absolute/path/artifacts
   ```

   Windows runtime executable is `runtime/RUNTIME_ID/node.exe`.
5. Independently inspect/extract the `.tar.gz` or Windows `.zip`. Verify the adjacent `.sha256`, internal `checksums.json`, manifest, startup/recovery instructions, project LICENSE, third-party notices and empty mutable directories. Test the extracted payload with synthetic data. Never distribute an installation directory wholesale.

Builds export allowlisted Git source inputs in release mode. Packaging verifies the installed manifest and exports only selected app/runtime, active recovery toolkit, launchers/instructions/license and empty data/cache/log/languages. It excludes databases, credentials, `.env`, remembered database/repository paths and user packs. Archive identity uses the first 12 commit characters plus kind/platform/CPU; full hashes remain in metadata. Checksums identify output bytes, not a signature or byte-identical-build guarantee. MIT covers original ORE code; dependencies/adapted assets retain their own notices and source obligations. Preserve native source URLs/build recipes and adapted MPL icon source. No signing/notarization is performed.

## Database upgrades and explicit recovery

Before an existing older schema upgrade, Store owns the database and creates a private consistent `VACUUM INTO` snapshot beside it named `DATABASE.pre-schema-N-TIME-ID.sqlite`. Remove only transient process authority from that copy; rename only completed snapshots. Snapshot failure aborts before migration. Each migration is transactional, but earlier successful migrations can remain after a later failure. Snapshots contain credentials: keep them private. Do not copy only a running WAL main file.

Future schemas fail before ownership/WAL mutation. Never downgrade schema pragmas or delete tables. Actual startup failure after activation never automatically launches old code against potentially upgraded data.

Stop ORE, then from source use:

```sh
./recover-app.command --list
./recover-app.command --previous
./start-app.command
```

Standalone macOS uses `ORE-internal/recover.command` followed by the external `ORE-launcher.command`; other separate Bash installations use `recover.command`/`start.command`. Windows uses `recover-app.bat`/`start-app.bat`. `--select APP_ID` chooses an explicitly listed retained app. Recovery checks live-owner/schema compatibility read-only, startup-probes the target on a temporary database, and preserves current launcher/database guards when selecting older payloads. It changes selection only after success and pauses updates. Resume explicitly with `--resume-updates`.

If an older app cannot read the saved schema, preserve the upgraded database and its WAL/SHM companions together while stopped. Copy a consistent compatible snapshot to a **new filename** with no stale WAL companions, select that existing external copy via recovery, then select older code. Keep any `ROLEPLAY_DATABASE` override consistent across recovery/start, or unset it. Recovery never restores/overwrites data itself. Verify login, expected chats/memory/pictures/requests; changes after the snapshot are absent. Content-backup import and pre-upgrade snapshot restore are distinct operations.

## Qualification limits

macOS arm64 has local contained-build/packaged-workflow evidence. Standalone candidate native checks use `tests/support/macos-acceptance.ts`: synthetic main archive transport supplies unpublished working-tree sources while the real private toolkit, locked native dependencies, server/UI probes, populated restart and update/recovery execute. `tests/macos-launcher.test.ts` isolates failure cases. The legacy Windows source-build equivalents are `tests/support/windows-acceptance.ts` and `tests/windows-launcher.test.ts`, using native Windows PowerShell 5.1 and the official private Windows toolkit. Windows package delivery additionally exercises `tests/support/windows-package-acceptance.ts` with controlled release transport and copies of the generated real application/runtime payload in CI. These checks do not establish a published downloaded-asset workflow, Explorer trust prompts or clean-account support. macOS x64, Linux and Windows ARM64 are not qualified by these checks. Candidate POSIX targets are macOS 13.5+ and Ubuntu 22.04/24.04 glibc x64/arm64, with glibc >=2.28, kernel >=4.18 and x64 SSE4.2 requirements; Alpine/musl is not targeted. Consult pinned runtime/native requirements before claiming another platform.

Before advertising a platform, download the distributed asset through its public Release URL and repeat extraction/startup and populated update checks against that final download. Also check clean-account installation, paths with spaces/Unicode, real native picture/regex/tokenizer work, mock generation/preparation/reviewed repair, saved request/credential exclusion, populated upgrade and restore, backup/import/restart, duplicate-owner/port rejection, cancellation/controller loss, failed update/checksum/build, offline repeat launch and nonwritable paths. Use temporary synthetic data and the existing packaged acceptance harness (`tests/support/portable-acceptance.ts`) where applicable. Cross-platform backup round trips and actual phone behavior need separate observation. Record results in the task/release handoff, not an accumulating repository test diary. No mock test establishes real-model memory quality.
