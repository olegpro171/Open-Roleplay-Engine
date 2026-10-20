# Portable development verification — 2026-10-20

Historical development evidence. The committed `v0.1.0-test.1` prerelease and current testing instructions are described in [TEST_RELEASE.md](TEST_RELEASE.md).

The later automatic-startup workflow is verified separately in [the startup update record](#automatic-startup-update-validation--2026-10-20) below. Earlier manual build/start commands and counts in this historical record describe the first implementation.

This report was recorded before committing the shared implementation based on main parent `e43b56bdc8439c0e3b432aee2f52aea2aaebd27a`. That parent does **not** contain these changes. Local output is labelled **development**, not release. Before native handoff or publication, commit the reviewed implementation on main, record the new full SHA and run the clean release procedure. No commits, tags, remote releases or binaries had been pushed/published at the time of these development checks.

## Environments and versions

| Target | Evidence |
| --- | --- |
| macOS 26.5 / build 25F71, arm64 | Contained Bash build, packaged workflow and source checks exercised locally |
| macOS x64 / older candidate macOS versions | Not run |
| Ubuntu 22.04/24.04 glibc x64, then arm64 | Reproducible handoff below; no Linux environment available in this session |
| Windows 11 x64 | Executable packaging/native execution pending [Windows handoff](WINDOWS_RELEASE_HANDOFF.md) |

Private runtime: Node 24.19.0, official darwin-arm64 `.tar.gz` SHA-256 `8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d`. Locked better-sqlite3 13.0.3 (SQLite 3.53.4), sharp 0.35.5, @img/sharp-libvips-darwin-arm64 1.3.4 (libvips 8.18.7), gpt-tokenizer 4.0.3. Other target runtime checksums are pinned in `scripts/release/node-SHASUMS256.txt` from the official Node distribution. No dependency/toolchain was added.

## Commands and evidence

Commands run from the repository, with the private supported runtime selected for npm verification:

```sh
env -u NODE_OPTIONS -u NODE_PATH PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /bin/bash ./build-portable.sh --development '/private/tmp/ORE portable-история'
PATH='/private/tmp/ORE portable-история/runtime/node-v24.19.0-darwin-arm64/bin':$PATH npm run check
PATH='/private/tmp/ORE portable-история/runtime/node-v24.19.0-darwin-arm64/bin':$PATH \
  node --import tsx tests/support/portable-acceptance.ts '/private/tmp/ORE portable-история'
```

The bootstrap uses macOS Bash 3.2.57 and no system Node/npm on PATH. It downloaded/checksummed its own official runtime and installed both build and production packages locally with lifecycle scripts disabled. This is a PATH-isolated test on the existing Mac, not a fresh OS/account image. The machine contains developer tools; native libraries loaded from packaged prebuilds without invoking a compiler or global SQLite/libvips. No shell profile, global npm/runtime or OS package-manager configuration was modified. Build outputs/caches/temp/config/logs were under the explicit ORE directory. Failed intermediate builds were corrected and rerun; they never selected incomplete applications.

The installed-output harness launches from `/` with system-only PATH and browser opening suppressed. It verifies real built UI, owner creation/login, a synthetic saved Connection, pictured PNG card import through the native image child, isolated regex lore insertion, compaction, reviewed repair, local mock generation, immutable request inspection, credential exclusion, backup/export/overlap import, restart persistence, duplicate-database rejection, occupied-port rejection with a different database, graceful stop and launcher SIGKILL/IPC shutdown followed by restart. It writes private evidence to `ORE/logs/acceptance.json`. Repeat starts issue no install/build/download command. Model calls are local synthetic streams; semantic summary quality is unverified.

Focused regression checks cover module-relative startup/migrations/backups, empty database-override rejection, missing assets, source-development port validation, unchanged future-schema rejection, populated WAL schema-12 upgrade/snapshot/restore, and failed migration recovery. The path regression was run against the original Store and failed on the expected wrong-working-directory `migrations/0001_initial.sql` lookup; it passes with the fix. Bash fixtures cover incomplete download, corrupt cached checksum, staged build failure, unwritable installation, dirty source rejection and non-main/abbreviated release identities while preserving current app/data/languages. Controlled failure fixtures are distinguished from the real successful download/build.

Final source checks and extracted-artifact evidence are recorded below. Release-mode publication, code signing/notarization, Gatekeeper/SmartScreen acceptance, real phone behavior, real-model quality and cross-platform backup round-trips remain unverified.

## Linux reproduction

Use a clean supported Ubuntu 22.04/24.04 account on x64 first, then arm64 separately. Bash/curl/tar/Git and SHA-256 tools must already exist; the bootstrap never installs them through apt. Do not reuse Mac node_modules. Check out the final shared commit, run the Bash command above with a Linux installation directory and no Node/npm on PATH. Select `ORE/runtime/node-v24.19.0-linux-ARCH/bin` only for source checks, run `npm ci`, `npm run check` (Chromium must already be available or explicitly provisioned for the test machine), then run the packaged-output harness against a disposable ORE installation. Package and extract into another path with spaces/Unicode, rerun the harness, inspect notices/native linkage and exercise the documented populated-upgrade restore on copies. Record libc/kernel/CPU, desktop browser opener behavior, artifact SHA-256 and all missing gates; do not infer arm64 from x64 or musl from glibc.

## Final validation record

- Build and strict typecheck passed with Node 24.19.0. Vite retains its existing large-chunk advisory; no bundling policy was changed.
- All **621 Vitest tests across 40 suites passed**, including explicit OS/libc preflight and packaging boundaries. Focused release reruns also cover private extracted directory permissions and an IPC loss before server startup.
- All **82 Playwright workflows passed** after the final test correction. Desktop/phone About screenshots were visually inspected at 1440px and 390px; automated layout checks also cover 820px and 320px. This is emulation, not a real-phone claim.
- An intervening sandboxed test invocation lacked permission to bind local mock servers and was stopped. The network-enabled suite passed. A browser rerun exposed a viewport-dependent assertion in the unchanged CodeMirror repair component: it searched for Scene 12 while only the end of the document was rendered. The test now navigates to each scene before making both original text assertions. No editor behavior or expectation was removed. Three isolated baseline runs were also inspected; they passed, so they alone do not establish absence of a flake. The corrected focused check and complete browser suite passed.
- Actual clean release mode succeeded in a separate temporary synthetic Git repository on main, commit `0629edce82eed215e67eacd2c8df1c212f80a85a`, with ignored private-file sentinels excluded and a clean source tree retained. **This is a test fixture identity, not a commit in the user's repository and not a distributable ORE release.**
- The real contained build was updated repeatedly while retaining its synthetic database and language directory. Packaged acceptance passed after update. The source path regression was demonstrated failing against the original Store for the expected reason before restoring the fix.
- `otool -L` showed SQLite using only macOS system libraries; sharp refers to the bundled `@rpath` libvips, which in turn uses macOS system libraries/frameworks. No Homebrew/Codex library path was linked. Shell/JavaScript syntax checks and documentation link review passed.

Artifact handoff: `release-artifacts/ORE-0.1.0-development-e43b56bdc843-darwin-arm64.tar.gz`, with its adjacent `.sha256`. The artifact is intentionally a development build based on the current parent SHA and uncommitted work. Its manifest lists all packaged relative paths, checksums and pins; artifact checksums identify the particular bytes and will change on rebuilding. A new final committed main SHA must replace the parent identity for a real release and Windows handoff.

The archive contains the verification record available before packaging; its own final checksum is recorded here and in the adjacent `.sha256`, outside that archive.

### Final artifact inspection

Archive size: **96,415,470 bytes**. SHA-256: `909bea870f4d775c77bd287cc33b354eecdb6d44f6976d6582e1cd0fea4242c5`. Private runtime npm version: **11.17.0**. Every file checksum and symlink target was verified after extraction into a separate path with spaces/Unicode. The initial data/cache/log/languages directories were empty and mode 0700. Root instructions and their local links were present. A scan found no local checkout path, synthetic saved key or ignored-private-file sentinel. The final extracted artifact passed the complete packaged acceptance harness, including ordinary and interrupted restart. Detailed local evidence is in `release-artifacts/verification.json`; that evidence file and the synthetic populated extraction are outside the distributable archive.

## Changed files and quick acceptance

Shared application changes: `src/server/installation.ts`, `src/shared/build-info.ts`, server `main.ts`/`app.ts`/`backups.ts`, persistence `store.ts`/`schema-backup.ts`, and picture process launch/disconnect handling. About presentation lives in `src/web/About.tsx`, `ApplicationSettings.tsx` and the scoped CSS addition. Delivery tooling is `build-portable.sh`, `start-app.command`, `.gitignore`, and `scripts/release/` (pinned runtime configuration/checksums, launcher, staging/notices, native smoke and allowlisted exporter). No package/lockfile or migration was changed.

Verification additions are `tests/release-runtime.test.ts`, `release-bootstrap.test.ts`, `release-packaging.test.ts`, and `tests/support/portable-acceptance.ts`; browser Settings coverage adds About, while repair coverage now reveals virtualized text before its original assertions. README, CONCEPTS, IMPLEMENTATION, release instructions/brief and Windows handoff were updated. Pre-existing concept edits and planning documents were preserved; `BETA_READINESS_PLAN.md` was left unchanged.

The required `npm run check` constituents passed using the private LTS runtime: `npm run build`, all 621 Vitest tests, and all 82 browser workflows. Final focused release checks/typecheck and the compiled extracted artifact were checked after lifecycle changes. The final source changes after artifact creation are this external evidence record and documentation consistency edits; executable/server/UI sources remain the inspected versions.

For manual acceptance, build into a separate user-owned directory with `./build-portable.sh --development "$HOME/ORE"`, start `"$HOME/ORE/start.command"`, create/sign into the owner account, and inspect Settings → About ORE. Create a synthetic Connection/card/chat, stop with Ctrl+C and restart from a different directory to confirm persistence. Update with the same build command/directory; retain data/languages, and inspect the new About identity. For older-schema recovery and the actual-platform acceptance gates, follow RELEASES.md rather than replacing a live database.

## Automatic startup update validation — 2026-10-20

The user selected startup checks against latest `main`. Mac `start-app.command`, Linux `start.sh` and the installed `start.command` now delegate to a shared updater before launching. These commands do not publish, move tags or modify the user's source checkout. The existing `v0.1.0-test.1` download remains immutable. At this stage the source launcher accepted an external destination; the fixed-path refinement below supersedes that instruction. See [current instructions](RELEASES.md).

Build/typecheck, **635 Vitest tests in 41 suites**, and **82 Playwright workflows** passed. The final unit suite includes 14 local-Git updater cases: first install, unchanged/no-build startup, new main, failed-build fallback/retry, offline fallback, explicit skip, no-install failure/retry, dirty managed checkout preservation, incomplete/linked checkout isolation, rewritten history refusal, concurrent startup exclusion, older-payload launcher compatibility, updater self-upgrade, preserved source database choice/explicit override, invalid saved path rejection and terminal interruption. Several assertions share a workflow; test count is distinct from the number of boundaries exercised. Packaging also verifies that persisted repository/database paths are excluded.

Actual Mac native build/start checks used an isolated temporary synthetic Git repository with the final application/launcher sources, a local `origin`, a path containing spaces/Unicode and system-only startup PATH. A single source-launch command fetched main, built the real locked application and launched it from `/`; the next installed launch checked main without rebuilding. Removing only that fixture's remote made startup report the error and launch the selected app. A later real staged update preserved the synthetic owner, transcript and historical generation records exactly. Synthetic fixture commits `2172d5ff68c0948e14619e26f8ed2303bcaf4da4` and `b4c701346a3f5205994ea9eccafe38b4b90de3c7` identify these local checks only; they are not ORE repository release commits.

The automatically built payload also passed `tests/support/portable-acceptance.ts`: native picture/regex workers, local mock generation, memory preparation/reviewed repair, immutable requests, backup/import, duplicate owner/port rejection, ordinary restart and launcher interruption/restart. The harness explicitly selects its synthetic database, loopback host, no TLS and no-update mode; updater network/state behavior is exercised separately with real local Git. No private database, saved user key or real endpoint was used. Runtime/native versions and Mac environment are the same as above. No Linux/Windows native, real-phone, real-model quality, fresh OS/account or downloaded-quarantine qualification is inferred from these checks.


## Fixed repository installation path — 2026-10-20

The daily source entries now accept no destination argument and always use the real `ore-portable/` directory inside their repository. An installation symlink is rejected before any write. Existing remembered database paths and explicit database overrides remain supported; external installations are not moved automatically. Advanced manual build destinations remain available separately.

The full build/typecheck, 637 Vitest tests in 41 suites and 82 browser workflows passed. The 16 updater tests now also exercise repeated no-argument source starts, both shell entries selecting the same installation, rejection of destination arguments without touching another installation, and rejection of a symlink without writing through it. A real first native build/start inside an isolated temporary Git repository also passed from working directory `/`; a second no-argument shell start reused the selected payload without rebuilding. That shell run was on Mac, not Linux qualification. The source database remained at its remembered fixture path. No user installation or active database was used for testing.


## Startup activation and database relocation safety — 2026-10-20

A regression comparison used the same synthetic successful-build payload with a launcher that exits 42. The original stage at `202a7e6` returned success and changed `current`; the fixed stage reported `Application startup check failed (exit 42)` and preserved the pointer. Focused tests cover both server and launcher failure after successful native loading, previous working selection, compatible explicit recovery, future-schema refusal without database/selection changes, a restored compatible copy, live-owner refusal, broken recovery targets, and retaining current guards when selecting legacy code. Location tests cover repository relocation, ambiguous/missing legacy paths, missing established external databases, legitimate first creation, concurrent metadata writes and SQLite's file-must-exist boundary.

The final build/typecheck and **649 Vitest tests in 42 suites passed**. A restricted initial full-suite invocation could not bind local test servers and was stopped; the complete suite was rerun with loopback access. All **82 Playwright browser workflows passed** in the final full run.

On this Mac, a temporary synthetic Git repository built the actual native production payload with the startup probe, recorded `working`/`previous`, and started normally. Moving the whole repository then preserved the exact synthetic transcript, opened the moved repository-relative database and created no directory at the old absolute location. Its offline update failure remained visible. The source recovery entry listed retained selections after relocation. Synthetic commit `d474c6d1ec2250af9172a16908b3ff9736c94d16` identifies that isolated fixture, not a published ORE commit.

The exported archive was extracted to a different path containing spaces/Unicode. All internal file hashes and symlinks were checked, saved-state/database metadata was absent, and the independent recovery command listed the selected payload. The extracted payload passed `tests/support/portable-acceptance.ts`, using only synthetic data and a local mock. Archive SHA-256: `ec6f5ef379952cb66e3357909aa8c3b622186f030e32f29468c17200822c91d2`. Existing native/phone/real-provider qualification limits above still apply; no published prerelease tag or archive was replaced.
