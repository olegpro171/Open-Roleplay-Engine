# ORE — Startup, packaging and recovery

Current operational reference for agents and portable installations. Release identity is a full commit on `main`; existing published tags/archives remain immutable. These commands build/package locally and do not publish or change repository visibility.

## Normal startup

From a cloned source repository, run without arguments:

| Platform | Entry |
| --- | --- |
| macOS | `./start-app.command` |
| Windows x64 | `start-app.bat` |
| Linux | `./start.sh` |

Source installation is the real `ore-portable/` directory inside that repository, independent of the terminal directory. Destination arguments and symlinks/junctions at that path fail. Do not delete data or reset source changes to satisfy a build. Extracted portable bundles use their included `start.command` (Mac/Linux) or `start-app.bat` (Windows).

Git and internet are required for first source installation and update checks. Use the public HTTPS repository URL for account-free cloning/updating. Bash platforms also need curl, tar and shasum/sha256sum. Windows targets x64 and Windows PowerShell 5.1; no Bash/admin elevation/global Node/compiler is required. The batch entry uses process-scoped RemoteSigned; organization policy still applies. Do not disable system security globally to run unsigned downloads.

The updater fetches `main` in an ORE-owned `cache/update-source` checkout, advances only by fast-forward, and rebuilds only when the complete installed release commit changes. It does not pull/reset the user's source checkout. Dirty/incomplete/linked managed checkouts, local commits and replaced remote history fail without discarding work. Source startup later delegates to installed updater fixes. Git must already be installed/configured; embedded HTTP credentials are rejected. For private origins, configure authentication outside the launcher.

A pinned official private Node runtime is checksum-verified; locked dependencies install in app-local cache/config/temp with lifecycle scripts disabled and no compiler fallback. Native smoke and actual server/UI startup on a temporary database must pass before activation. Failures preserve the selected app and saved data. Failed update checks/builds visibly fall back to an installed usable version; first install cannot fall back. Lock contention/cancellation abort startup rather than launching another app. An unchanged commit does not reinstall.

Keep the terminal open and stop with Ctrl+C. Launch opens/prints the URL only after listen succeeds. Port/database ownership conflicts do not kill other processes. The foreground launcher owns its server and forwards shutdown; lost IPC closes the child. Windows Job Objects own tools/children before tool spawning. Hard termination/power loss is not graceful shutdown. Installed commit/schema/runtime details appear in Settings → About ORE.

## Configuration and data identity

Private `.env` files beside source or installed launchers support blank lines, whole-line comments and literal `KEY=value` assignments with optional matching quotes. No execution, expansion, multiline values or inline comments. Explicit environment variables take precedence; Windows source-file values precede installation-file values. Invalid assignments stop with file/line diagnostics. Direct npm commands do not read this file.

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

Source entries default to `<repository>/data/roleplay.sqlite`; separate installations default to their own `data/roleplay.sqlite`. Private `database-location.json` tracks relative default and established external identities. Explicit overrides win and relative overrides resolve against the invoking directory. Moving a whole source folder preserves its relative data identity. Once a database location is established, a missing file fails at metadata and SQLite-open boundaries; it must never become an empty replacement. A genuinely new identity may create a database. Nonwritable installations fail without an alternate path.

Ambiguous legacy `database-path.txt` does not guess moved versus external data. Stop ORE, then select an existing file explicitly using source recovery:

```sh
./recover-app.command --database repository
./recover-app.command --database external "/absolute/path/existing.sqlite"
```

Use `recover.command` in separate Bash installations and `recover-app.bat` on Windows. Selection changes location metadata, never creates/restores/overwrites the database. Moving only a database does not move its machine-preference sidecars.

## Installation layout

| Location | Content |
| --- | --- |
| `current`, `working`, `previous` | Selected, actually-ready and retained prior app/runtime pairs |
| `app/<build-id>/` | Versioned dist, migrations, production packages, license/notices, instructions and manifest |
| `runtime/<runtime-id>/` | Private official Node/npm and upstream LICENSE |
| `recovery/<build-id>/`, `recovery/current` | Independently retained recovery toolkit |
| `data/` | Default saved SQLite data/credentials/pictures |
| `languages/` | Preserved runtime JSON language packs |
| `cache/`, `logs/` | Managed updater/build work and private logs |
| `updates-paused` | Explicit recovery pauses automatic main updates |

Updates stage before atomic selection. Existing servers run their original files until stopped. Keep referenced runtimes/apps/toolkits while needed; no automatic pruning occurs. Stop ORE/builds before removing caches or old versions. Deleting the installation can delete data/languages: preserve backups first. After interruption, verify no owner process remains before removing only stale lock directories; never remove locks merely because startup is slow.

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

Separate Bash installations use `recover.command`/`start.command`; Windows uses `recover-app.bat`/`start-app.bat`. `--select APP_ID` chooses an explicitly listed retained app. Recovery checks live-owner/schema compatibility read-only, startup-probes the target on a temporary database, and preserves current launcher/database guards when selecting older payloads. It changes selection only after success and pauses updates. Resume explicitly with `--resume-updates`.

If an older app cannot read the saved schema, preserve the upgraded database and its WAL/SHM companions together while stopped. Copy a consistent compatible snapshot to a **new filename** with no stale WAL companions, select that existing external copy via recovery, then select older code. Keep any `ROLEPLAY_DATABASE` override consistent across recovery/start, or unset it. Recovery never restores/overwrites data itself. Verify login, expected chats/memory/pictures/requests; changes after the snapshot are absent. Content-backup import and pre-upgrade snapshot restore are distinct operations.

## Qualification limits

macOS arm64 has local contained-build/packaged-workflow evidence. Windows x64 has earlier native automated evidence; integrated changes still need native reruns and manual Explorer/console/download-trust and fresh-machine checks. macOS x64, Linux and Windows ARM64 are not qualified by Mac checks. Candidate POSIX targets are macOS 13.5+ and Ubuntu 22.04/24.04 glibc x64/arm64, with glibc >=2.28, kernel >=4.18 and x64 SSE4.2 requirements; Alpine/musl is not targeted. Consult pinned runtime/native requirements before claiming another platform.

Before advertising a platform, check clean-account installation, paths with spaces/Unicode, real native picture/regex/tokenizer work, mock generation/preparation/reviewed repair, saved request/credential exclusion, populated upgrade and restore, backup/import/restart, duplicate-owner/port rejection, cancellation/controller loss, failed update/checksum/build, offline repeat launch and nonwritable paths. Use temporary synthetic data and the existing packaged acceptance harness (`tests/support/portable-acceptance.ts`) where applicable. Cross-platform backup round trips and actual phone behavior need separate observation. Record results in the task/release handoff, not an accumulating repository test diary. No mock test establishes real-model memory quality.
