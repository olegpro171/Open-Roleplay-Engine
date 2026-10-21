# Portable ORE builds and releases

The shared portable tooling targets macOS arm64/x64, glibc Linux arm64/x64 and Windows x64. Actual qualification is recorded in [RELEASE_VERIFICATION.md](RELEASE_VERIFICATION.md). A successful Mac build does not establish Linux or Windows support. Windows uses `start-app.bat` and Windows PowerShell 5.1 with ordinary bundled Node and supporting files. See [Windows evidence and remaining gates](WINDOWS_RELEASE_VERIFICATION.md). No binaries, commits, tags or releases are published by these commands.

The first workflow prerelease is described in [TEST_RELEASE.md](TEST_RELEASE.md).

## Windows x64

From a source checkout, double-click `start-app.bat` or invoke it from any terminal directory, without arguments. The fixed installation is `<repository>/ore-portable/`; reparse points/junctions at that location are refused. Existing configured Git and its authentication are needed to check private remote `main`. No Bash, global Node/npm, compiler, Python or administrator elevation is required. Windows PowerShell 5.1 and x64 Windows are targeted; ARM64 is unqualified. The pinned native binaries must load successfully before a build proceeds. Actual system-library evidence and remaining manual checks are in [Windows verification](WINDOWS_RELEASE_VERIFICATION.md).

Windows startup and recovery also read literal `.env` assignments from the source root (when applicable) and installation root. Existing process variables take precedence, followed by source settings and then installation settings. Values are never executed as PowerShell; invalid assignments report a line number without printing their contents. Empty database paths fail explicitly. Windows/.NET treats other empty environment values as unset. `.env` remains private and is excluded from packages.

The batch entry uses `powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File`, preserves exit codes and pauses on failure so double-click errors stay readable. `ORE_NO_PAUSE=1` suppresses that pause for automation. The execution-policy selection applies to this process and descendants only; no persistent policy, profile, PATH or registry startup setting changes. Organization Group Policy still takes precedence. Scripts are unsigned: downloaded scripts may require a normal trust decision under RemoteSigned. Do not disable machine security to run them. See [Microsoft's execution-policy guidance](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_execution_policies?view=powershell-5.1).

PowerShell orchestration implements the same managed-checkout, unchanged-commit, fast-forward, staged activation and visible failure/offline fallback policy below. A kill-on-close Windows Job Object owns the controller and inherited tools before any Git/npm/server spawn. Closing/killing the controller terminates its owned descendants. Ctrl+C is the normal stop control; abrupt termination may leave actionable stale locks, which must only be removed after verifying all owned work stopped. The actual Node launcher owns its server through IPC and a temporary-database startup probe requires clean shutdown. Browser opening uses the ready URL. Relative explicit database overrides resolve against the invoking directory.

To deliberately launch an installed development/recovery build offline in PowerShell:

```powershell
$env:ORE_SKIP_UPDATE = '1'
.\start-app.bat
```

Recovery uses `recover-app.bat --list`, `recover-app.bat --previous`, `recover-app.bat --select APP_ID`, `recover-app.bat --database repository` (source), `recover-app.bat --database external "C:\path\existing.sqlite"`, and `recover-app.bat --resume-updates`. Installed bundles use the same `recover-app.bat` name. Schema/live-owner checks, independent toolkit, temporary-database probe and paused updates follow the recovery policy below. Restoring data remains a separate explicit operation.

Advanced builds use these native commands from the source root (no daily destination argument):

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\build-portable.ps1 -Mode Release -Commit FULL_40_CHARACTER_COMMIT -Destination C:\ORE-release
# Explicit working-tree snapshot, visibly labelled development:
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\build-portable.ps1 -Mode Development -Destination C:\ORE-development
```

Release mode requires a clean exact commit reachable on local `main`; the source ZIP comes from Git's allowlisted archive. Private Node/npm install the lockfile with scripts disabled, build, collect notices, reinstall production packages and smoke-test before activation. No compiler fallback is performed. The app and two-line pointer share the existing portable layout; Windows runtime IDs use `node-v24.19.0-win32-x64/node.exe`.

Export from the installed private runtime using `node.exe APP\scripts\release\package-portable.mjs INSTALL_DIRECTORY OUTPUT_DIRECTORY`. On Windows this produces a ZIP, adjacent SHA-256 and internal `checksums.json` using the OS .NET ZIP library. The selected app/runtime and recovery toolkit are allowlisted; data, credentials, remembered paths, user languages and caches are excluded. Extract into a user-writable folder and double-click its `start-app.bat`. Keep the entire supporting folder together. Root directory ACL inheritance is restricted to the current user before application startup, so new installation data/snapshots inherit user-owned access; POSIX chmod is not treated as Windows privacy evidence.

## Daily startup and automatic updates

From a source checkout, using Bash (including macOS Bash 3.2), curl, tar, Git and shasum/sha256sum:

```sh
./start-app.command
```

Use this script without arguments for the first and later launches; Linux source users use `./start.sh`. The source installation is fixed to `ore-portable/` inside that repository, independently of the current working directory. Destination arguments and a symlink at that path are rejected before updating anything. It checks the latest remote `main`, builds only when the complete installed release commit differs, then launches. Git authentication must already be configured for this private repository; no credential is stored in the bundle. The source launcher uses its checkout's `origin`, recorded as a credential-free URL in `ore-portable/update-source.txt`; portable downloads default to the project's GitHub repository. A managed checkout under `cache/update-source` is used instead of modifying the user's source checkout. Update logs are under `logs/`.

The build downloads official Node **24.19.0** into ORE, verifies the committed SHA-256 pin, installs the lockfile with the private npm, builds, reinstalls production packages from that same lockfile and tests production native loading. Before activation, it starts the actual launcher/server on loopback with a separate temporary database, checks the session API and UI, and verifies graceful shutdown. Failed startup leaves the previous selection untouched. It uses no globally installed Node/npm, compiler, Python, SQLite or libvips. Package lifecycle scripts are disabled; these locked SQLite/sharp versions supply prebuilt native binaries. Unsupported native loading fails explicitly. Nothing installs system packages or modifies profiles, persistent PATH, startup entries or global npm settings. Existing source `npm run dev`, `dev:ui`, `build`, `start` and verification commands remain available with supported Node 24 or 22.12+. `build-portable.sh --development DIRECTORY` remains an explicit developer snapshot command; daily startup consumes committed remote main, preserving local source edits.

If a check/download/build fails, startup explains the failure and runs the previously selected app. First installation fails clearly when no app exists. An unchanged commit does not reinstall/rebuild. `ORE_SKIP_UPDATE=1 ./start.command` explicitly starts an installed version without checking; use this for deliberate offline operation, a development snapshot, or a deliberately selected recovery version. Skipping checks does not change the selected version; use the recovery commands below to select one. Git checks disable interactive password prompts, use existing credential helpers/keys, and reject URLs with embedded HTTP credentials. Slow HTTP transfers and SSH connections have conservative failure settings; unavailable credentials must be configured outside the launcher.

The launcher starts the real Fastify server/UI and opens the browser only after listen succeeds. Keep its terminal open; **Ctrl+C** stops gracefully. Logs are private files in `logs/`. `ORE_OPEN_BROWSER=0` suppresses browser opening. If a browser opener is unavailable, use the printed URL. A busy port or database reports an error without killing another process. Repeat launch does not take over an existing server. Terminal close signals stop its child; losing the launcher IPC also closes the server. Hard power loss cannot guarantee graceful checkpointing.

Launcher settings can be saved in a private `.env` beside the source launchers, or beside `start.command`/`recover.command` (Windows: `start-app.bat`/`recover-app.bat`) in a separate installation. The source checkout includes `.env.example`; copy it or create `.env` directly. For example, `ORE_OPEN_BROWSER=0` prevents automatic browser opening in daily and development launches. Recovery reads the same settings. Explicit environment variables override file values. Bash preserves empty values; Windows/.NET treats empty values as unset, with an explicit error for an empty database path. Files support blank lines, whole-line `#` comments and `KEY=value` assignments with optional matching single/double quotes; values are literal (no shell execution, variable expansion, multiline values or inline comments). Invalid assignments stop startup with a file/line diagnostic. `.env` is ignored by Git, preserved across builds/updates, and excluded from portable archives. Direct npm commands do not load this launcher file.

The existing `ROLEPLAY_PORT`, `ROLEPLAY_HOST`, `ROLEPLAY_DATABASE`, `ROLEPLAY_TLS_CERT` and `ROLEPLAY_TLS_KEY` settings remain supported. Local port defaults to 3000 and must be 1–65535. HTTP phone access is enabled separately in Application Settings after local owner setup, with automatic network selection and port 3000 by default; manual network/port controls appear when automatic selection is unchecked. The read-only phone URL uses the OS local hostname. No wildcard startup override or certificate is required. The private `<database>.lan.json` sidecar survives updates and import/wipe but is excluded from backup/release payloads. Automatic mode recovers changed/missing networks and retries port 3000 without a browser; manual mode requires local recovery if its chosen binding is unavailable. Local access remains available. Explicit TLS startup remains a legacy option; HTTPS automation is deferred. Paths with spaces/Unicode are supported. An explicit relative database override is resolved against the invoking terminal directory before launch; use an absolute path for repeatability. A separate installation defaults to its own `data/roleplay.sqlite`. Source startup defaults to `<repository>/data/roleplay.sqlite`. The private `database-location.json` records that default as a relative identity, so moving the whole repository (including `data/` and `ore-portable/`) preserves it. Both launch entries share this choice. An explicit `ROLEPLAY_DATABASE` wins for that launch; known external locations are tracked separately. A new installation or previously unused explicit path may create its first database. Once established, a missing database stops startup instead of creating an empty replacement, including at SQLite's file-opening boundary. Non-writable installations fail without an alternate database.

Legacy `database-path.txt` is migrated only when it exactly matches the current repository default. A legacy absolute path that could mean either a moved repository or an external database stops for explicit selection. After moving an older installation, use `./recover-app.command --database repository` to select the existing `<repository>/data/roleplay.sqlite`, then `./start-app.command`. For an external database, use `./recover-app.command --database external "/absolute/path/existing.sqlite"`. These commands require an existing file and never create or alter its contents.

The immutable `v0.1.0-test.1` archive has the earlier launch-only behavior. Existing external installations are not moved or deleted by the fixed-path source launcher. Use an explicit absolute `ROLEPLAY_DATABASE` or backup/import to retain their saved content when starting the repository installation. Advanced exact-commit builds can still target a chosen directory with `build-portable.sh --release FULL_COMMIT DIRECTORY`. Never move/rewrite the published tag.

## Local development launch

Run `./start-dev.command` from the source checkout (or double-click it on Mac) to rebuild and launch current local edits. This uses the same private Node 24 and staged development builder, independent of the terminal's Node. It always rebuilds into ignored `ore-development/` and starts with update checks disabled; it never fetches/pulls main or activates that build in `ore-portable/`. Dependency/runtime downloads may still be required. A failed build stops without launching the prior build. This is a built snapshot, without live reload; see README for the two-terminal watch workflow.

The default database is the same repository-relative `data/roleplay.sqlite` as source daily startup. Stop the normal app first, or set an explicit `ROLEPLAY_DATABASE` to use separate development data. Schema upgrades and recovery safeguards still apply. The development installation has its own `recover.command`; source `recover-app.command` continues to address `ore-portable/`.

## Layout and updates

```text
ORE/
  start.command                stable Bash entry
  recover.command              schema-aware explicit recovery entry
  current                      atomic two-line app/runtime selection
  working                      last selection that reached actual readiness
  previous                     retained working selection before activation
  recovery/<build-id>/         independent recovery/launcher toolkit
  recovery/current             toolkit/runtime pointer
  updates-paused               recovery pauses automatic main updates
  update-source.txt            configured repository URL; no credentials
  database-location.json       typed default and established identities; not exported
  runtime/node-v24.19.0-OS-CPU/  private official Node + npm + LICENSE
  app/<build-id>/               replaceable application
    dist/client/               Vite UI
    dist/server/               server, image worker, core/shared/persistence
    migrations/                versioned SQL
    node_modules/              locked production/native/tokenizer assets
    build-info.json            public build identity
    manifest.json              identity, lockfile/runtime pins, file checksums
    notices/                   UI/server/build license inventory and supplied texts
    scripts/release/            launcher, native smoke, artifact tools
  data/roleplay.sqlite         private user data, keys and pictures
  languages/                   external runtime language-pack location (currently unused)
  cache/                       npm cache, verified runtime archives, temporary build work
  logs/                        startup/error output
```

Normal startup performs updating. Download/build/native-smoke and temporary-database server startup work completes in `cache/` before `current` switches atomically. Failure preserves the selected application and all data/language files. The managed checkout advances by fast-forward only; edits/untracked files, local commits or rewritten main history are preserved and reported instead of reset. Stop the app and preserve/move that cache checkout aside before intentionally switching repositories. A newly downloaded runtime can remain unused and is safe to retain. Existing servers keep running their original app until explicitly stopped. Never remove an application/runtime used by a running server. Concurrent startup updates fail using `cache/update.lock` without launching another server; manual builds use `cache/build.lock`. After a hard interruption, verify no Git/build/startup process remains before removing only the stale lock directories. Interrupted temporary directories may be removed while stopped. A successful normal startup records `working`; activation retains it as `previous`. A legacy selection is startup-probed before recording it as a fallback. An actual startup failure after activation is reported; it never automatically launches older code against a possibly migrated database. Previous app versions remain for explicit recovery; there is no automatic pruning.

## Exact release procedure

A release is an exact clean commit reachable on local `main`. The checkout must be that full commit; tracked changes and untracked inputs reject release mode. Ignored build/data directories are never included. Release source is exported with Git from that commit, rather than from mutable working files. Build identity is the full commit hash, shown by the launcher and Settings → About ORE. Package-version labels are retired. Portable archive names use the first 12 commit characters; manifests retain the full commit and release/development kind. Development artifacts can include uncommitted changes, so their commit identifies the base checkout. Direct source runs without Git metadata report an unavailable commit.

1. Review, commit and place the intended changes on `main` through the user's normal workflow. Run `npm run check` against that commit with supported Node. Startup does not commit/publish user changes; it fast-forwards only its private managed checkout.
2. Obtain the full commit with `git rev-parse HEAD`, then run:

   ```sh
   ./build-portable.sh --release FULL_40_CHARACTER_COMMIT "$HOME/ORE-release"
   ```

3. Inspect Settings → About ORE (full commit, schema, Node, OS/CPU), then complete the platform acceptance matrix below.
4. Record the full commit as the release identity. Existing published tags remain immutable historical references. Creating/pushing tags or publishing artifacts requires explicit user instruction.
5. Package with the installed private runtime, substituting the two lines from `current`:

   ```sh
   "$HOME/ORE-release/runtime/RUNTIME_DIRECTORY/bin/node" \
     "$HOME/ORE-release/app/BUILD_ID/scripts/release/package-portable.mjs" \
     "$HOME/ORE-release" "$HOME/ORE-artifacts"
   ```

Packaging verifies the application manifest, stages only selected app/runtime, launch/recovery entries, active recovery toolkit, pointers and instructions, creates empty data/cache/log/language directories, and writes a `.tar.gz`, adjacent `.sha256` and internal `checksums.json`. It never archives live data or user language packs. Do not distribute an installation directory wholesale. Inspect the archive independently before sharing. Inputs are pinned by the lockfile and [official runtime checksums](https://nodejs.org/dist/v24.19.0/SHASUMS256.txt); byte-identical artifacts are **not** promised. Artifact checksums identify the particular output, not an independent signature of trust.

The runtime includes Node's full LICENSE and component notices. `notices/packages.json` inventories versions/licenses, including libraries bundled into the UI; supplied license/notice/README texts are retained. The libvips package includes its combined third-party notice and native versions. Review corresponding-source obligations for LGPL components before public distribution; exact build recipes are [sharp-libvips v1.3.4](https://github.com/lovell/sharp-libvips/tree/v1.3.4). No code signing/notarization is provided. Gatekeeper/SmartScreen acceptance must be recorded on actual target systems; do not disable OS security globally.

## Database upgrades and recovery

Before opening an existing older schema, Store acquires database ownership and writes a consistent SQLite `VACUUM INTO` snapshot beside the database named `DATABASE.pre-schema-N-TIME-ID.sqlite`, mode 0600. The snapshot removes only transient process ownership, so restoring it cannot inherit a live process lock. A failed backup aborts before migration. Each migration remains transactional. A later migration failure can leave earlier completed migrations committed; use the snapshot for whole-upgrade recovery. The snapshot includes saved keys: keep it private. Never use a main-file copy of a running WAL database as a backup.

A newer schema fails before WAL setup, ownership mutation or migration. App-file rollback alone is safe only if the old app supports the current schema. Do not downgrade the version pragma or delete tables.

Stop ORE before recovery. From the source repository:

```sh
./recover-app.command --list
./recover-app.command --previous
./start-app.command
```

For a separate installation, use `./recover.command --list`, `./recover.command --previous`, then `./start.command` from its directory. `--select APP_ID` selects any retained ID printed by `--list` when no previous marker exists. Recovery checks the saved database read-only using the target runtime/native dependency, refuses a newer schema or live owner, and tests the target on a temporary database before changing `current`. The command itself never opens the saved database with the older application. Recovery retains current launcher/database guards even for legacy payloads. It pauses main updates so the next launch uses the selected version; resume explicitly with `./recover-app.command --resume-updates` (or `./recover.command --resume-updates`).

If recovery refuses an upgraded schema:

1. Stop **all** ORE processes using the database. Preserve the failed/upgraded database and its `-wal`/`-shm` companions together in a private recovery folder while stopped.
2. Restore a consistent compatible pre-upgrade snapshot to a **new filename**, preserving the snapshot. No stale WAL companions may exist at the new filename. Select that existing copy before choosing older code:

   ```sh
   ./recover-app.command --database external "/absolute/path/restored-copy.sqlite"
   ./recover-app.command --previous
   ./start-app.command
   ```

   Substitute `recover.command` and `start.command` for a separate installation. `--database` changes location metadata only; it never restores or overwrites a database. A per-launch `ROLEPLAY_DATABASE` override takes precedence, so unset it or point it at the same restored copy for every recovery/start command.
3. Verify owner login, expected content, pictures, memory and historical requests. Changes saved after the snapshot are absent from it. Restore remains explicit; no live database is overwritten automatically.

In-app Save backup and import remain available for supported backup schemas. They are distinct from a pre-upgrade full snapshot: portable exports exclude login/runtime authority. Cross-platform backup qualification is pending native platform runs.

## Platform qualification and removal

Candidate Linux baseline: Ubuntu 22.04/24.04 glibc x64, then arm64 separately. Require glibc >= 2.28, kernel >= 4.18, and SSE4.2 on x64 for the pinned native stack. Alpine/musl and other architectures are not targeted by this Bash procedure. macOS candidates: macOS 13.5+ arm64 and x64, tested independently. These are candidate baselines, not claims of verification; see the evidence report. Native requirements derive from [Node's platform matrix](https://github.com/nodejs/node/blob/v24.19.0/BUILDING.md) and [sharp's prebuilt requirements](https://sharp.pixelplumbing.com/install/).

On each actual target: build without global Node/npm, run `npm run check`, extract and launch from a different directory with spaces/Unicode, create owner and synthetic Connection, import/crop pictured cards, generate with the local mock, run lore regex, prepare and repair memory, inspect historical requests, back up/import, stop/restart and verify saved state. Exercise port collision, second launch/database owner, interruption and child cleanup. Test populated upgrade, snapshot restoration to a new database, failed download, bad checksum, failed build, non-writable paths and offline repeat startup. Record exact OS/CPU/Node/native versions and output checksums. Windows additionally requires Explorer-launched start-app.bat and actual native packaging checks.

To remove caches, stop builds and remove only `cache/` (it is recreated). To remove old apps/runtimes, stop ORE first and preserve the selected versions unless intentionally uninstalling. Keep the apps/runtimes referenced by `previous`, `working` and `recovery/current` if their recovery path is still needed. Preserve `data/`, `languages/`, external database overrides and private upgrade snapshots. Deleting the entire ORE directory deletes its default user data and language packs; export/retain backups first. No global runtime or package-manager changes need removal.
