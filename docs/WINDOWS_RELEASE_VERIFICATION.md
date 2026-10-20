# Windows delivery evidence — 2026-10-20

Windows x64 batch/PowerShell delivery is implemented. This records automated native evidence and remaining qualification gates; it does not claim signing, ARM64 support or complete manual platform qualification.

Base: clean current `main`, fetched and verified at `e43069dc9878b4a9dd07e8284dd6a354bab4dba1`. Work is on `codex/windows-portable`. The final local candidate commit, ZIP path, byte size and SHA-256 are recorded in `release-artifacts/WINDOWS_RELEASE_REPORT.json` after committing/building. The candidate remains a **development** package because this branch has not been merged into main. No merge, publication, upload or tag change is authorized/performed. For a release, land the reviewed commit on main and use the exact clean release command in [RELEASES.md](RELEASES.md).

## Environment

- Windows 11 Pro x64, version 10.0.26200, build 26200; Windows PowerShell 5.1.26100.9711.
- Official private Node 24.19.0, npm 11.17.0; Git 2.55.0.windows.5.
- Downloaded Windows x64 ZIP verified against committed SHA-256 `57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73`.
- Locked better-sqlite3 13.0.3 / SQLite 3.53.4; sharp 0.35.5 / libvips 8.18.7; gpt-tokenizer 4.0.3. Schema 13.
- No compiler, global Node/npm, SQLite, image library or new packaging dependency installed. Windows Job Objects, .NET interop and ZIP APIs use existing OS/runtime facilities. The standard Playwright browser installation was needed for developer tests and remains outside the distributable.

Runtime dependency inspection with Playwright's PrintDeps found Windows system DLL/UCRT dependencies and the two libvips DLLs supplied beside sharp. The SQLite prebuild and Node do not report a separate VC runtime DLL dependency. Native smoke and packaged image processing passed. No redistributable was installed. A fresh Windows account/machine without existing developer software was not available, so pristine-machine prerequisites remain a qualification gate rather than a guarantee.

## Verification performed

Commands used the private runtime directory on the command's PATH only, with npm invoked through its private `node_modules/npm/bin/npm-cli.js`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\build-portable.ps1 -Mode Development -Destination .\ore-portable
# With private Node/npm selected for this process:
npm run check
node --import tsx tests/support/portable-acceptance.ts ISOLATED_EXTRACTED_ORE
node APP/scripts/release/package-portable.mjs INSTALL_DIRECTORY OUTPUT_DIRECTORY
```

Builds used `npm ci --include=dev --include=optional --ignore-scripts`, native smoke, build, notice collection, then `npm ci --omit=dev --include=optional --ignore-scripts --prefer-offline`. Production startup probed the real server, session API and UI against a separate temporary database and required clean IPC shutdown before activation.

Native automated checks cover first install from committed synthetic main, unchanged main without rebuilding, fast-forward update, dirty managed checkout preservation, missing Git, unreachable remote, visible installed-version fallback, explicit skip, update contention, failed build without activation, cancelled build with no surviving writer, actionable stale lock, bad cached runtime checksum and inherited worker cleanup on controller death. Controlled builder fixtures isolate orchestration; actual builds/native smoke and packaged acceptance exercise the real payload.

Shared recovery tests now run natively on Windows: repository relocation, disappeared established external file without recreation, ambiguous legacy-path selection, metadata concurrency, read-only future-schema/live-owner rejection, explicit compatible restored copy, previous-version selection and update pause/resume, startup failure without selection changes and current guards around legacy launchers. Existing SQLite migration tests exercise populated upgrade, rollback and pre-upgrade snapshot restoration. Windows crash-test expectations use nonzero forced-termination exit codes rather than POSIX signal names, preserving saved-state assertions.

The extracted ZIP was exercised from `release-artifacts/ORE native space-история-&()/...`, with the application's PATH restricted to Windows system/PowerShell directories. Packaged acceptance covers owner setup/login, libraries, pictured PNG import, JPEG/WebP replacement/crop and thumbnail reads, real image children, lore regex worker, tokenizer-backed preparation, reviewed repair, mock generation, reasoning/response variants, immutable saved requests, credential exclusion, backup/import with overlap replacement, occupied port, duplicate database ownership, repeated restart and abrupt controller termination. Windows harness stops are abrupt controller termination; the staging probe separately establishes graceful IPC shutdown. All fixtures and keys are synthetic.

The unrestricted source suite passed build/typecheck, Vitest and all 82 Playwright desktop/phone-size browser workflows. Exact final counts/results and log locations are in the generated report. The initial restricted-sandbox run failed local mock traffic and temporary-file renames; an unrestricted run exposed and corrected a POSIX-only crash assertion. The first browser attempt lacked Chromium; after the standard pinned install, all 82 passed. Vite reports the existing large-chunk advisory. No lint command exists or was claimed.

ACL inspection showed the installation owner as the current Windows user, protected directory inheritance and one inheritable current-user FullControl rule. Application data and newly created snapshots inherit that private ACL. POSIX mode bits alone are not claimed as Windows privacy evidence. External database ACLs remain the user's existing choice.

## Remaining manual / external gates

- Actual Explorer double-click, interactive Ctrl+C and closing a visible console, browser-opening UI, readable pause-on-failure and downloaded-file trust prompts. Automated PowerShell entry, batch recovery invocation and forced controller death were exercised; these do not substitute for those observations.
- A fresh non-developer Windows account/machine, organization-enforced script policy, unavailable real private-repository credentials, interrupted HTTP runtime transfer, actual offline network disconnection and non-writable-installation UI. Missing Git/unreachable remote/failure/cancellation/checksum cases have controlled automated evidence.
- Mac/Linux-produced backup imported on Windows and Windows backup imported on that second platform. No second-platform artifact/environment was available. Same-platform packaged round trip passed.
- Windows ARM64, other Windows versions, actual phone hardware/HTTPS, real-model summary quality and signing remain unverified. Scripts are unsigned and no SmartScreen/code-signing acceptance is claimed. Persistent execution policy, shell profiles, PATH and registry startup settings were not changed.

For manual acceptance, extract the ZIP, configure Git authentication, double-click `start-app.bat`, create a synthetic owner/story and stop with Ctrl+C. Repeat with `ORE_SKIP_UPDATE=1`, inspect About/build identity, exercise console close/restart, then use `recover-app.bat --list`. Keep data/languages and backups private. A development candidate should use explicit skip until its commit is accepted on remote main; normal startup follows remote main by design.

## Integration into main — 2026-10-20

The user authorized merging Windows commit `1a5272400b5cfd819a912862564c6f4124ef1e3e` with main `35494409532a628345128bdb7a11c9e47681731a` for native/manual testing. The original branch evidence above predates this integration. The recovery toolkit conflict was resolved by retaining both the Bash environment reader and Windows helpers. Windows startup/recovery now load literal private `.env` configuration, reject empty database assignments, and display Windows recovery commands. Bash-only environment tests are scoped to Unix; two Windows environment regression tests were added.

On macOS arm64 with Node 24.19.0, the integrated `npm run check` passed: build/typecheck, **656 Vitest tests**, and **85 Playwright workflows**. **Seven Windows-only tests were skipped**, including the two new configuration tests. These results establish shared/Mac regression coverage, not native validation of the integration fixes. Rerun `npm run check` on Windows against the merged commit, then complete the manual/fresh-machine gates above. No new Windows ZIP was built on the Mac, and the earlier candidate artifact does not contain these integration fixes.
