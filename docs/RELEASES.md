# ORE — Startup, packaging and recovery

Current operational reference for agents and portable installations. Release identity is a full commit on `main`; existing published tags/archives remain immutable. These commands build/package locally and do not publish or change repository visibility.

## Normal Windows package startup

`ORE-launcher.bat` is the single-file Windows x64 installer/updater. Download it from the latest completed Release, put it in any chosen writable directory, including a nonempty Desktop folder, then run it or double-click in Explorer. Managed files stay under constant adjacent `ORE-internal/`. It embeds first-install code and the shared EN/RU catalog; no adjacent helper, Git, global Node/npm, PowerShell 7, WSL or compiler toolkit is required. It uses Windows-supplied 64-bit PowerShell 5.1/.NET and process-scoped RemoteSigned without changing global policy, unblocking files or elevating automatically. Windows UI language selects Russian variants or English fallback. Keep the foreground console open; Ctrl+C stops ORE.

The launcher resolves the latest published Windows release once and downloads its `ORE-windows-x64.json`, `ORE-windows-x64.zip` and `ORE-windows-x64.zip.sha256` from that same release. The descriptor binds the full commit, archive byte count and SHA-256, Windows x64 and package protocol 2. The ZIP already contains the application, production dependencies and private official Node runtime. User machines do not download source, install npm dependencies or compile ORE. Unchanged releases reuse the verified installed package. The ZIP checksum establishes transport integrity against the published metadata, not an independent publisher signature.

Validate every ZIP entry before extraction, rejecting Windows devices, alternate streams, reparse entries, short-name aliases, case/normalization collisions and conflicting file/directory paths. Owned-folder recognition precedes private ACL changes; the parent folder’s permissions are untouched. Stage the package separately before selection. Installation preserves `.env`, saved data and sidecars, database identity, pictures, language packs and retained versions. Failed checks/downloads/installation before live startup may visibly start a verified installed version; cancellation and contention do not permit fallback. Once saved-data startup begins, failure stops without automatically trying older code. The installer never inspects or restores SQLite data.

An exclusive OS file lease covers update and foreground server lifetime. Named kill-on-close Job Objects attach controllers before creating descendants and terminate only owned workers after owner loss. Ownership metadata records the job identity; a new owner waits for that job to become quiescent before changing installation state, including when a prior process has released its lease but its workers are still stopping. Package updates do not create persistent directory locks. The next launch can retry interrupted package work. Old source-based installations may contain directory locks with insufficient ownership information; the installer retires those only when a prior system boot proves their workers cannot survive. If that proof is unavailable, stop old launchers/builds and restart Windows before running the new installer again. Never remove active ownership or kill unrelated processes to make installation proceed.

### One-time launcher replacement

To update an installation whose older updater rejects large GitHub comparisons, stop ORE, replace the external `ORE-launcher.bat` beside the existing `ORE-internal/` folder, and double-click it. Keep the existing folder and the replacement batch for routine updates. This also replaces the original batch from ORE · f553710121c8, which reapplied the directory ACL before each handoff.

For a selected protocol-2 installation whose helper predates bounded release comparisons, the replacement batch can perform the update in its bootstrap worker under the installation lease. It respects paused updates, verifies the installed version, and applies the usual forward-ancestry and package checks. The ancestry request uses page two so GitHub omits the changed-file list while returning the comparison status and base identities. If the attempt fails before selection changes, the installed helper resumes normal startup and fallback. Cancellation, ownership errors and unexpected selection changes stop startup.

The historical Windows protocol-1 launcher from `v0.9.0-beta` built from source. Its separate one-time replacement moves that adjacent home to package delivery. First package activation requires an online compatible release and updates enabled. The bridge checks the recognized Windows source-built selection and forward release identity under the package lease. It does not run the old source updater. If earlier work was interrupted, reboot first as described above. Use the retained offline startup and recovery instructions below if the bridge cannot proceed.

### External Windows launcher contract

- **Home and ownership.** The batch resolves its own absolute path and uses only adjacent `ORE-internal/`. It checks the `ORE-installation:1` marker, bounded selection pointers, managed path types and reparse ancestry before helper invocation. Its ACL check uses the current Windows user's protected full-control rule with child inheritance. It repairs mismatched permissions and skips ACL writes when permissions already match.
- **Discovery and invocation.** Package protocol 2 looks first in `app/<id>/scripts/release/` from `current`, then `recovery/<id>/` from `recovery/current`. Both pointers contain an app ID and runtime ID on two lines, with a 512-byte bound. The directories retain `windows-package-protocol` with value `2`, a readable, parseable `windows-package-launcher.ps1` up to 1 MiB, and the startup, verification, database, selection and message files named by `Get-OrePackageHelper`. Call the helper once with `-Installed -Installation <absolute-home> -Invoking <original-working-directory> -Language <en|ru>` and return its exit status. The cutover batch invokes it in the same PowerShell process. The helper takes the package lease and attaches the worker job before running app or update workers.
- **First activation and recovery.** A fresh or unfinished install without a selection, or the recognized Windows protocol-1 bridge, can use the bounded package installer embedded in the batch. An owned worker takes the same lease, verifies the package and activates code before exiting. The batch rechecks discovery before invoking the helper. A missing or damaged selected helper can use a complete retained toolkit. Unsafe paths, unknown protocols and selected installs with neither a compatible helper nor a recognized bridge fail explicitly. Use `ORE-internal/recover-app.bat` to inspect or select retained code.
- **Published bytes.** Descriptor format 1 and `launcherProtocol: 2` keep the public asset names, release tag, platform, commit, size and checksum contract stable. Use `node scripts/release/generate-windows-launcher.mjs --check` to check generated assets. Historical byte fixtures and the current launcher digest pin compatibility baselines. The replacement recognizes the installed helper's bounded-comparison capability in its generated header. Keep that marker for compatible future helpers. Routine policy, diagnostics and startup changes belong in the installed helper. For an incompatible bootstrap, trust, platform or protocol change, version the boundary, document which older assets can still update, and qualify explicit replacement against populated homes. The external launcher never replaces itself.

### Automated Windows releases

Work on `develop` and run local checks appropriate to the change; no automatic workflow runs there. Freeze a release candidate by merging it to `staging`. `windows-qualify.yml` runs on staging pushes (or explicit dispatch on staging), checks out the exact triggering SHA, runs `npm run check`, then builds with `scripts/release/build-portable.ps1 -Mode Release -ReleaseBranch staging -Commit FULL_COMMIT -Destination DIRECTORY`. The explicit staging mode requires the clean exact checkout to belong to fetched `origin/staging`; the default builder mode retains its main ancestry guard. Candidate metadata uses the real staging SHA, without synthetic commits or rewritten main references.

Qualification invokes `ci-package-windows.mjs`, verifies the extracted inventory, native dependencies and temporary-database startup/UI probes, then exercises the actual server and SQLite through package-installer acceptance. The acceptance harness exercises the shipped batch against a populated synthetic installation, in-place replacement, a later helper update with the same cutover bytes, and clean bootstrap of that later package with controlled transport. It compares external handoff time and checks competing launches, interruption, offline and corrupt fallback, pause, recovery and retained data. Packaging excludes saved data, credentials, user configuration and local language packs. Only after all checks pass are the four release files retained as an immutable `windows-x64-FULL_COMMIT` workflow artifact for 30 days. Staging never publishes a public release.

After staging is green, promote the exact tested commit to main using a fast-forward, without squashing, creating a merge commit or adding edits. For example, from a clean checkout with current remote refs:

```sh
git fetch origin
git switch main
git merge --ff-only origin/main
git merge --ff-only FULL_QUALIFIED_STAGING_COMMIT
git push origin main
```

`windows-release.yml` then publishes without rebuilding, installing npm dependencies or rerunning the suites. It requires a successful staging workflow run for that exact SHA in the same repository; the newest run for that SHA must be successful. It selects the unexpired artifact by immutable ID/run ID, fails on download digest mismatch, rechecks qualification before publication, validates archive identity/checksums and requires the launcher bytes to match main's source. Fast-forward ancestry is verified for push events. A different squash/merge SHA, failed/pending qualification, missing/deleted/expired artifact or digest mismatch stops publication; it never silently builds or publishes unqualified files. Requalify an expired candidate by rerunning its staging workflow run, or explicitly dispatching qualification when that commit is still the staging tip. Requalification replaces only the temporary workflow artifact with a new immutable artifact ID, never published release assets. Manual dispatch on main retries publication only and enforces the same qualification requirements.

The publisher uses the workflow's scoped `GITHUB_TOKEN` with `contents: write`; qualification has read-only permissions. It creates a draft tagged `build-FULL_COMMIT`, attaches exactly `ORE-launcher.bat`, `ORE-windows-x64.zip`, `ORE-windows-x64.zip.sha256` and `ORE-windows-x64.json`, then publishes the complete release as Latest. Release notes contain installation instructions, full commit identity and the Windows x64 scope. Previously published tags/assets stay unchanged; retries verify and reuse an existing published release. Publication is serialized and ancestry-ordered so an older run cannot demote Latest. Failed qualification/publication leaves the existing release available. Users need no GitHub account or token to download public release assets.

The CI/developer builder still supports clean Git Release and explicit Development modes. It installs locked dependencies once, collects notices before removing development packages, then prunes offline with lifecycle scripts and metadata writes disabled. Production, shared and optional dependencies remain; source manifests/lockfiles stay unchanged. Only disposable work inside the installation cache may move its dependency tree into staging. Native/startup checks and atomic activation still apply. Full typechecking and automated suites run before distribution; the internal Windows emitter can use TypeScript `--noCheck` without weakening that release checkpoint.

The shared temporary-database startup probe allows 60 seconds for cold startup and requires owned readiness IPC plus successful session/interface responses. Reports record elapsed database-resolution, server-loading, service-initialization and listener-binding milestones; failures include the last milestone and HTTP probe result. Cleanup disconnects the owned controller before forced termination. These checks never open the installation’s saved database. Application startup retains SQLite identity, ownership, schema, snapshot and migration decisions.

The pinned [Node 24 platform contract](https://github.com/nodejs/node/blob/v24.19.0/BUILDING.md#platform-list) lists Windows x64 starting at Windows 10/Server 2016, subject to vendor support. [sharp’s prebuilt platform requirements](https://sharp.pixelplumbing.com/install/#prebuilt-binaries) include Windows x64. These upstream limits do not qualify every Windows version for ORE. CI verifies the packaged application on its selected Windows runner; pristine accounts, actual Explorer download/trust or organization-policy prompts, older Windows versions and ARM64/emulation need separate observation. A Windows run does not qualify macOS/Linux support.

## Configuration and data identity

The Windows package launcher creates a private empty `ORE-internal/.env` only when absent and read it before update decisions, independently of the terminal directory. It reads only the adjacent installation configuration. Other source/internal entries retain their existing adjacent-file semantics. Files support blank lines, whole-line comments and literal `KEY=value` assignments with optional matching quotes. No execution, expansion, multiline values or inline comments. Explicit environment variables take precedence; Windows source-file values precede installation-file values. Invalid assignments stop with file/line diagnostics. Standalone configuration cannot redefine shell controls or internal `ore_*`, `ORE_HOME`, `ORE_LAUNCH_*` and `ORE_DATABASE_*` coordination settings; such lines fail explicitly. External Node/npm injection and cross-compilation settings are sanitized. Direct npm commands do not read this file.

| Setting | Meaning |
| --- | --- |
| `ORE_SKIP_UPDATE=1` | Run an already-installed build without checking updates |
| `ORE_OPEN_BROWSER=0` | Print ready URL without browser opening |
| `ROLEPLAY_PORT` | Local port, default 3000, integer 1–65535 |
| `ROLEPLAY_DATABASE` | Explicit database override; use absolute paths for repeatability |
| `ROLEPLAY_HOST` | Local loopback host by default; HTTP LAN uses Settings instead |
| `ROLEPLAY_TLS_CERT`, `ROLEPLAY_TLS_KEY` | Paired legacy TLS files; provisioning is deferred |
| `ORE_NO_PAUSE=1` | Suppress Windows pause-on-failure for automation |

An empty explicit database path fails. Other empty Windows environment values follow .NET unset behavior. To skip Windows package updates for one run, set `$env:ORE_SKIP_UPDATE='1'` before running `./ORE-launcher.bat` from PowerShell. Put it in installation `.env` to persist it. Working-tree and separate portable builds start from local code.

Standalone installations default to `ORE-internal/data/roleplay.sqlite`. Source/development entries retain `<repository>/data/roleplay.sqlite`; separate portable installations default to their own data directory. Private `database-location.json` tracks relative default and established external identities. Explicit overrides win and relative overrides resolve against the invoking directory. Moving a whole source folder preserves its relative data identity. Once a database location is established, a missing file fails at metadata and SQLite-open boundaries; it must never become an empty replacement. A genuinely new identity may create a database. Nonwritable installations fail without an alternate path.

Ambiguous legacy `database-path.txt` does not guess moved versus external data. Stop ORE, then select an existing file explicitly using the installed recovery command:

```sh
./recover.command --database repository
./recover.command --database external "/absolute/path/existing.sqlite"
```

Run these from the installation directory. On Windows use `recover-app.bat` with the same arguments. Selection changes location metadata, never creates/restores/overwrites the database. Moving only a database does not move its machine-preference sidecars.

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

`scripts/release/start-dev.bat` on Windows x64 and the root `./start-dev.command` on Mac/Bash rebuild current local edits with private Node into `ore-development/`. They start the new build only after successful activation and use the existing repository configuration and database resolution. Downloads can still be required. Their database default is the same repository data: stop normal ORE or use an explicit development database. This is a built snapshot, without live reload; use npm watch commands in the source development guide for that. The separate installation has its own recovery entry.

Windows source builds use an exclusive `cache/source-build.lease` file handle under their package lease. Closing the console releases the handle; the next source build waits for the recorded Windows job to stop before rebuilding. The lease file itself may remain and must not be deleted to unlock a running build. Interrupted staging directories remain disposable cache; the last committed selection and saved data are retained. Older `cache/build.lock` directories still require the legacy ownership checks described above; do not remove them without proving their owners and workers have stopped.

Windows startup verifies the installation directory's protected owner-only ACL and child inheritance policy. Already matching permissions are preserved; differing permissions are repaired. This avoids recursively reapplying the same ACL to every retained build and dependency on each launch.

`scripts/release/start-dev.bat` enables `-ReuseDevelopmentDependencies`: a local-only Windows build path that retains locked dependencies under `cache/development-dependencies/`. Its key includes both package files, the private runtime identity/checksum and the cache policy. Builds and installed snapshots reference those read-only dependency files through directory junctions instead of reinstalling/copying them; local source edits still rebuild the application. New package/runtime inputs require a fresh locked install, published to the cache only after native verification. An interrupted unpublished cache is never reused. Vite loads its config through the private Node runtime without writing bundled config temporaries into shared dependencies. Every build rechecks native packages and hashes the staged dependency files against the cache's original inventory before activation. Failed native/integrity verification retains the previous selection and retires only the cache index; the next explicit build installs a fresh dependency generation. Never remove dependency generations still referenced by retained development snapshots.

These local development snapshots retain build tools and cannot be packaged for distribution. Default `build-portable.ps1 -Mode Development` and Release builds retain fresh locked installs, production pruning and the normal portable layout. To make a distributable development build, omit `-ReuseDevelopmentDependencies`. Rebuild after moving a development installation so its junctions reference the new location.

## Exact release and archive procedure

1. Complete review and required checks (`npm run check`) on the intended final sources. Commit the intended changes on `main` through the user's normal workflow; startup never commits or publishes them. Release mode requires clean exact checked-out HEAD reachable on local main, including no untracked source inputs. Use a separate clean checkout if necessary rather than discarding work.
2. Obtain `git rev-parse HEAD`, then build an explicit installation:

   ```sh
   ./scripts/release/build-portable.sh --release FULL_40_CHARACTER_COMMIT "/absolute/path/ORE-release"
   ```

   Windows:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\release\build-portable.ps1 -Mode Release -Commit FULL_40_CHARACTER_COMMIT -Destination C:\ORE-release
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

Stop ORE. Run the installed `recover-app.bat --list` or `recover-app.bat --previous` on Windows, or `./recover.command --list` or `./recover.command --previous` from a Bash installation. Restart using the external Windows batch for a package home, `start-app.bat` for a separate Windows build, or `./start.command` for a Bash build. `--select APP_ID` chooses an explicitly listed retained app. Recovery checks live-owner/schema compatibility read-only, startup-probes the target on a temporary database, and preserves current launcher/database guards when selecting older payloads. It changes selection only after success and pauses updates. Resume explicitly with `--resume-updates`.

If an older app cannot read the saved schema, preserve the upgraded database and its WAL/SHM companions together while stopped. Copy a consistent compatible snapshot to a **new filename** with no stale WAL companions, select that existing external copy via recovery, then select older code. Keep any `ROLEPLAY_DATABASE` override consistent across recovery/start, or unset it. Recovery never restores/overwrites data itself. Verify login, expected chats/memory/pictures/requests; changes after the snapshot are absent. Content-backup import and pre-upgrade snapshot restore are distinct operations.

## Legacy installations

Keep the original installation, its `.env`, database-location files, data, language packs and retained application/runtime/recovery folders together. Deleting a source wrapper does not migrate its installation. Stop any old launcher before recovery. Use a content backup or a consistent SQLite backup before relocating data. For offline recovery retain the database and any WAL/SHM companions together while stopped.

- **Published Mac standalone from `v0.9.0-beta`.** Its source-update path is retired. From the folder containing the historical file, run `ORE_SKIP_UPDATE=1 /bin/bash ./ORE-launcher.command` against its existing `ORE-internal/`. Use that home's `recover.command` for retained versions and explicit database selection. The historical Release remains available. [Historical Mac launcher](https://github.com/olegpro171/Open-Roleplay-Engine/releases/tag/v0.9.0-beta)
- **Checkout Git updater.** Keep the existing `ore-portable/` under its original repository. Use its retained `recover.command` and `ORE_SKIP_UPDATE=1 ./start.command` on Bash, or its `recover-app.bat` and `start-app.bat` on Windows with `$env:ORE_SKIP_UPDATE='1'`. Run from inside the retained installation. Carry over the original repository configuration settings explicitly, especially any `ROLEPLAY_DATABASE` override. If the home predates recorded identity, explicitly select the existing database or use the original repository default with `ORE_DATABASE_DEFAULT=repository` in the process environment. A very old home may need its original version's recovery tools. Use the corresponding historical source with the original home and settings.
- **Earlier portable macOS archive.** Use the archive's retained internal start and recovery commands. Those archived tools and files remain available. [Historical portable prerelease](https://github.com/olegpro171/Open-Roleplay-Engine/releases/tag/v0.1.0-test.1)
- **Historical Windows source-built standalone.** For offline recovery use the original external batch with `$env:ORE_SKIP_UPDATE='1'` and its adjacent retained recovery tools. To move that home to package delivery, follow the separate protocol-1 replacement procedure above.

## Qualification limits

The Windows staging gate uses native Windows PowerShell 5.1 and the official private runtime. `tests/support/windows-package-acceptance.ts` exercises Windows package delivery using controlled transport and copies of the generated application/runtime. The old external batch is a byte-for-byte copy of the shipped asset. The harness instruments installed helpers and the fresh bootstrap's transport to offer simulated later releases. This does not qualify Explorer trust prompts, clean accounts or older Windows versions. macOS arm64 has local contained working-tree build evidence. Other POSIX environments and Windows ARM64 are outside this qualification.

Before advertising a platform, download the distributed asset through its public Release URL and repeat extraction/startup and populated update checks against that final download. Also check clean-account installation, paths with spaces/Unicode, real native picture/regex/tokenizer work, mock generation/preparation/reviewed repair, saved request/credential exclusion, populated upgrade and restore, backup/import/restart, duplicate-owner/port rejection, cancellation/controller loss, failed update/checksum/build, offline repeat launch and nonwritable paths. Use temporary synthetic data and the existing packaged acceptance harness (`tests/support/portable-acceptance.ts`) where applicable. Cross-platform backup round trips and actual phone behavior need separate observation. Record results in the task/release handoff, not an accumulating repository test diary. No mock test establishes real-model memory quality.
