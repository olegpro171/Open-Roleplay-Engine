# Task 2 — Reproducible releases and contained local delivery

Status: shared portable implementation completed for local Mac validation on 2026-10-20; see [instructions](RELEASES.md) and [evidence/remaining gates](RELEASE_VERIFICATION.md). Linux and Windows native qualification remain pending. Windows execution is handed off through [WINDOWS_RELEASE_HANDOFF.md](WINDOWS_RELEASE_HANDOFF.md).

## Assignment and user decisions

Latest startup refinement (2026-10-20): normal use starts a platform-specific launcher which checks latest `main`, builds when the installed commit changes, and launches. The daily source installation is fixed to `ore-portable/` inside the repository, with no destination argument. This supersedes the separate manual build/start workflow described in the initial assignment. Preserve staged activation, contained dependencies, data and explicit offline/failure recovery. The original immutable first prerelease remains a historical workflow snapshot.

Implement a repeatable release procedure for the existing React/Fastify application. A release is an exact commit on `main`. Windows delivery must launch through `ORE.exe`; a supporting folder is explicitly acceptable. macOS/Linux delivery uses a Bash script to build the app. Contain dependencies within ORE-owned locations instead of installing them throughout the user's OS.

Read AGENTS.md, CONCEPTS.md, IMPLEMENTATION.md, README.md, package.json and the current launch/server/worker code. Keep the accepted stack and browser interface. No Electron/Tauri rewrite, hosted service, mandatory container runtime or automatic OS package-manager installation is authorized. Implement the shared release/runtime work and validate the locally available platforms; leave a concrete handoff for actual Windows execution. Do not claim Windows/Linux support from a Mac build.

## Release identity and output

- Build from an exact clean release commit reachable on `main`. Record full commit, application version, schema version, pinned Node runtime and target OS/CPU in artifact metadata and a visible read-only About/version view.
- Recommend an immutable version tag on that commit so artifacts remain identifiable after `main` advances. Tags are labels, not an alternate release branch policy. Preparing scripts is authorized; pushing commits/tags, creating remote releases and publishing binaries require explicit user instruction.
- Release automation must check the real branch/commit and fail on a dirty source tree or missing required inputs. Developer builds may remain possible but must not masquerade as releases.
- Produce deterministic inputs through the lockfile and pinned/checksummed runtime downloads. Record artifact checksums and third-party notices. Do not promise byte-identical output unless independently tested.
- Include built server/UI, migration files, tokenizer/runtime assets, image-worker entry point, production dependencies/native binaries, language-pack location, launcher and concise instructions. Package from an allowlist so databases, keys, backups, environment files, certificates, caches, test fixtures and developer paths cannot leak.

## Filesystem/runtime contract

Choose one explicit app-owned layout and document it for all launchers. Recommended portable layout: launcher plus `runtime/`, `app/`, `data/`, `cache/`, `logs/` and external `languages/` within a user-writable ORE directory. Keep application/runtime versions replaceable independently of data/language packs. Honor an explicit database override. Installation under a non-writable location must give an actionable error or use a documented user-owned data location; never silently run against a different empty database.

- Use a private pinned supported Node LTS runtime; current project support is Node 24 or 22.12+. Do not change the Node major simply because a packaging tutorial targets a newer version.
- On macOS/Linux, the Bash bootstrap downloads the OS/CPU-matching official runtime to ORE's directory, verifies its pinned checksum, installs locked dependencies locally, builds, and creates/uses a separate start command. Keep npm cache, temporary downloads and configuration in app-owned locations. No persistent PATH/shell-profile edits, `sudo`, global npm packages, Homebrew/apt changes or reliance on Codex's cache.
- Use prebuilt native dependencies where the locked versions support the target. Fail with a precise unsupported-platform explanation when unavailable; do not silently install compilers, Python or global libvips. Document supported Linux libc/distribution baselines and CPU architectures rather than claiming every Linux system.
- Build/update must stage the new application before switching it into use. A failed download/build leaves the installed version and data usable. Preserve user data and runtime language packs. Starting an installed version does not reinstall or rebuild and works offline apart from requested model calls.
- Resolve assets/migrations/worker paths relative to the application installation, independently of current working directory. Handle spaces, Unicode paths and different shells. Never resolve production resources through the development checkout.
- Separate app-file rollback from database rollback: an older executable may be incompatible after a schema upgrade. Reject unsupported future schemas, preserve a consistent pre-upgrade database backup, and document tested recovery. Do not silently open or downgrade a newer database.
- Deleting ORE's installation should not leave global runtime/package-manager changes. Clearly distinguish deleting caches/application files from deleting the user's data. No background service, startup entry or telemetry is needed.

## Launcher and lifecycle

The launcher starts Fastify serving the built UI and opens/displays the local browser URL. It must use the configured port and preserve loopback-by-default, authentication/origin checks and TLS requirements for LAN access. Do not replace the real app with a development server.

Provide a clear stop mechanism and useful startup errors/log location. Handle occupied ports, repeated launch, already-running database ownership and graceful shutdown without spawning duplicate servers or orphaned image children. Do not kill arbitrary processes because a port is busy. Validate paths and missing assets before confusing the user with a blank browser page.

Keep existing source-development commands working. Audit `main.ts`'s working-directory assumptions, `Store`'s migration paths, native SQLite loading, `pictures.ts` child-process launch, `lore-regex.ts` worker threads and tokenizer assets. The Windows launcher must be able to start the image worker using the intended bundled runtime; `process.execPath` cannot accidentally launch the GUI/bootstrap again recursively.

For Windows, a native executable launcher with bundled Node/supporting files is sufficient. Select the smallest maintainable packaging approach compatible with pinned LTS after an end-to-end spike. Do not promise a single-file SEA or compile TypeScript to native machine code. A new packaging dependency/toolchain must be explained and approved before being added; prefer existing/runtime-provided capabilities where practical.

## Implementation stages and handoff contract

1. Establish the shared portable filesystem contract, path resolution and build/version metadata. Add focused regression tests for relevant path/startup behavior.
2. Implement macOS/Linux Bash build/start/update procedure using app-local dependencies. Validate on Mac and define the exact Linux target/test matrix. Keep shell compatibility conservative, including macOS's available Bash.
3. Prepare artifact staging/manifests/checksums/notices and release documentation. Test a clean environment with no globally installed Node, npm, SQLite or sharp dependencies, including offline repeat startup.
4. Supply the Windows agent with an exact commit, dependency/runtime versions, artifact layout, launcher entry contract and build/check commands. Use [WINDOWS_RELEASE_HANDOFF.md](WINDOWS_RELEASE_HANDOFF.md); the Windows agent owns executable packaging and native validation, not product redesign.
5. Integrate platform findings, rerun affected checks, and record supported versus unverified combinations. Coordinate shared-file changes rather than allowing two agents to rewrite launcher/runtime code independently.

## Acceptance evidence

- `npm run check` passes on the final shared application changes using the supported runtime.
- A clean Mac environment builds through the script and starts without global runtime installation or Codex paths. Test downloads failing halfway, checksum mismatch, build failure, non-writable directories, paths containing spaces/Unicode and a second offline launch.
- Validate the same workflow on the declared Linux target; if no Linux environment is available, provide a reproducible handoff and explicitly leave Linux qualification incomplete.
- On each advertised platform: create owner, save synthetic Connection, import a pictured card, generate with local mock provider, run lore regex, prepare/repair memory, restart, inspect historical requests and verify data persistence. Include backup/export/import once Task 1 is available; otherwise mark that cross-feature release gate pending.
- Validate populated upgrades and rollback/recovery on copies, not user data; a build succeeding is insufficient.
- Verify normal stop, interruption, port collision, repeated start and no surviving child processes. Windows requires actual Windows evidence as described in the handoff.
- Inspect packaged contents for secrets/developer data and inspect filesystem changes to confirm dependency containment. Check licenses/notices for shipped runtime/native dependencies.
- Document release commit/tag procedure, artifacts, supported platform matrix, local build/start/update, data paths, recovery and removal. No unsupported platform claims or unrequested publication.

Handoff report: changed files, exact commands and results by platform, artifact locations/checksums, runtime/native dependency versions, known limitations, and a short clean-install/upgrade acceptance path. Keep signing/SmartScreen/Gatekeeper limitations explicit when relevant; do not instruct users to disable system security globally.
