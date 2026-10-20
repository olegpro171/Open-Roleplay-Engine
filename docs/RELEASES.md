# Portable ORE builds and releases

The shared portable tooling targets macOS arm64/x64 and glibc Linux arm64/x64. Actual qualification is recorded in [RELEASE_VERIFICATION.md](RELEASE_VERIFICATION.md). A successful Mac build does not establish Linux or Windows support. Windows executable work remains in [WINDOWS_RELEASE_HANDOFF.md](WINDOWS_RELEASE_HANDOFF.md). No binaries, commits, tags or releases are published by these commands.

The first workflow prerelease is described in [TEST_RELEASE.md](TEST_RELEASE.md).

## Daily startup and automatic updates

From a source checkout, using Bash (including macOS Bash 3.2), curl, tar, Git and shasum/sha256sum:

```sh
./start-app.command
```

Use this script without arguments for the first and later launches; Linux source users use `./start.sh`. The source installation is fixed to `ore-portable/` inside that repository, independently of the current working directory. Destination arguments and a symlink at that path are rejected before updating anything. It checks the latest remote `main`, builds only when the complete installed release commit differs, then launches. Git authentication must already be configured for this private repository; no credential is stored in the bundle. The source launcher uses its checkout's `origin`, recorded as a credential-free URL in `ore-portable/update-source.txt`; portable downloads default to the project's GitHub repository. A managed checkout under `cache/update-source` is used instead of modifying the user's source checkout. Update logs are under `logs/`.

The build downloads official Node **24.19.0** into ORE, verifies the committed SHA-256 pin, installs the lockfile with the private npm, builds, reinstalls production packages from that same lockfile and tests production native loading. Before activation, it starts the actual launcher/server on loopback with a separate temporary database, checks the session API and UI, and verifies graceful shutdown. Failed startup leaves the previous selection untouched. It uses no globally installed Node/npm, compiler, Python, SQLite or libvips. Package lifecycle scripts are disabled; these locked SQLite/sharp versions supply prebuilt native binaries. Unsupported native loading fails explicitly. Nothing installs system packages or modifies profiles, persistent PATH, startup entries or global npm settings. Existing source `npm run dev`, `dev:ui`, `build`, `start` and verification commands remain available with supported Node 24 or 22.12+. `build-portable.sh --development DIRECTORY` remains an explicit developer snapshot command; daily startup consumes committed remote main, preserving local source edits.

If a check/download/build fails, startup explains the failure and runs the previously selected app. First installation fails clearly when no app exists. An unchanged commit does not reinstall/rebuild. `ORE_SKIP_UPDATE=1 ./start.command` explicitly starts an installed version without checking; use this for deliberate offline operation, a development snapshot, or a deliberately selected recovery version. Skipping checks does not change the selected version; use the recovery commands below to select one. Git checks disable interactive password prompts, use existing credential helpers/keys, and reject URLs with embedded HTTP credentials. Slow HTTP transfers and SSH connections have conservative failure settings; unavailable credentials must be configured outside the launcher.

The launcher starts the real Fastify server/UI and opens the browser only after listen succeeds. Keep its terminal open; **Ctrl+C** stops gracefully. Logs are private files in `logs/`. `ORE_OPEN_BROWSER=0` suppresses browser opening. If a browser opener is unavailable, use the printed URL. A busy port or database reports an error without killing another process. Repeat launch does not take over an existing server. Terminal close signals stop its child; losing the launcher IPC also closes the server. Hard power loss cannot guarantee graceful checkpointing.

The existing `ROLEPLAY_PORT`, `ROLEPLAY_HOST`, `ROLEPLAY_DATABASE`, `ROLEPLAY_TLS_CERT` and `ROLEPLAY_TLS_KEY` settings remain supported. Port defaults to 3000 and must be 1–65535. HTTP remains loopback-only; LAN requires certificates and prior local owner setup. Paths with spaces/Unicode are supported. An explicit relative database override is resolved against the invoking terminal directory before launch; use an absolute path for repeatability. A separate installation defaults to its own `data/roleplay.sqlite`. Source startup defaults to `<repository>/data/roleplay.sqlite`. The private `database-location.json` records that default as a relative identity, so moving the whole repository (including `data/` and `ore-portable/`) preserves it. Both launch entries share this choice. An explicit `ROLEPLAY_DATABASE` wins for that launch; known external locations are tracked separately. A new installation or previously unused explicit path may create its first database. Once established, a missing database stops startup instead of creating an empty replacement, including at SQLite's file-opening boundary. Non-writable installations fail without an alternate database.

Legacy `database-path.txt` is migrated only when it exactly matches the current repository default. A legacy absolute path that could mean either a moved repository or an external database stops for explicit selection. After moving an older installation, use `./recover-app.command --database repository` to select the existing `<repository>/data/roleplay.sqlite`, then `./start-app.command`. For an external database, use `./recover-app.command --database external "/absolute/path/existing.sqlite"`. These commands require an existing file and never create or alter its contents.

The immutable `v0.1.0-test.1` archive has the earlier launch-only behavior. Existing external installations are not moved or deleted by the fixed-path source launcher. Use an explicit absolute `ROLEPLAY_DATABASE` or backup/import to retain their saved content when starting the repository installation. Advanced exact-commit builds can still target a chosen directory with `build-portable.sh --release FULL_COMMIT DIRECTORY`. Never move/rewrite the published tag.

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

A release is an exact clean commit reachable on local `main`. The checkout must be that full commit; tracked changes and untracked inputs reject release mode. Ignored build/data directories are never included. Release source is exported with Git from that commit, rather than from mutable working files. Developer artifacts are visibly labelled **Development build** in Settings → About ORE and in their manifests.

1. Review, commit and place the intended changes on `main` through the user's normal workflow. Run `npm run check` against that commit with supported Node. Startup does not commit/publish user changes; it fast-forwards only its private managed checkout.
2. Obtain the full commit with `git rev-parse HEAD`, then run:

   ```sh
   ./build-portable.sh --release FULL_40_CHARACTER_COMMIT "$HOME/ORE-release"
   ```

3. Inspect Settings → About ORE (version, full commit, schema, Node, OS/CPU), then complete the platform acceptance matrix below.
4. Recommend an immutable version tag, for example `v0.1.0`, on that exact main commit. Choose a new version/tag for changed releases; never move a published tag. Creating/pushing tags or publishing artifacts requires explicit user instruction.
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

On each actual target: build without global Node/npm, run `npm run check`, extract and launch from a different directory with spaces/Unicode, create owner and synthetic Connection, import/crop pictured cards, generate with the local mock, run lore regex, prepare and repair memory, inspect historical requests, back up/import, stop/restart and verify saved state. Exercise port collision, second launch/database owner, interruption and child cleanup. Test populated upgrade, snapshot restoration to a new database, failed download, bad checksum, failed build, non-writable paths and offline repeat startup. Record exact OS/CPU/Node/native versions and output checksums. Windows additionally requires Explorer-launched ORE.exe and actual native packaging checks.

To remove caches, stop builds and remove only `cache/` (it is recreated). To remove old apps/runtimes, stop ORE first and preserve the selected versions unless intentionally uninstalling. Keep the apps/runtimes referenced by `previous`, `working` and `recovery/current` if their recovery path is still needed. Preserve `data/`, `languages/`, external database overrides and private upgrade snapshots. Deleting the entire ORE directory deletes its default user data and language packs; export/retain backups first. No global runtime or package-manager changes need removal.
