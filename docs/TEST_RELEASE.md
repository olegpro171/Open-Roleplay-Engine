# ORE v0.1.0-test.1 — portable workflow test

These instructions describe the immutable first prerelease. Current main adds automatic check/build/start launchers with a fixed repository-local `ore-portable/` installation; see [the current startup workflow](RELEASES.md). Run the current source `start-app.command` without arguments. Existing external installations are left intact.

This is an early prerelease for checking installation, offline startup and the app-owned data layout. The built download is for **Mac arm64 (Apple Silicon)**. macOS x64, Linux and Windows executable delivery remain unqualified. It is unsigned and not notarized. This is not the completed private beta or a claim of real-model memory quality.

## Test the built archive

1. Download the Mac arm64 `.tar.gz` and adjacent `.sha256` from the GitHub prerelease. Verify with `shasum -a 256 -c ARCHIVE_NAME.tar.gz.sha256` in the download directory.
2. Extract the archive into a new user-writable directory, such as `~/Applications/ORE-test`. Keep the full supporting folder together. The archive contains no existing database, saved key or chat.
3. Run the extracted `start.command` from Terminal. It displays the local URL, opens the browser after startup and keeps a foreground server. If port 3000 is already occupied, use `ROLEPLAY_PORT=3001 ./start.command`; no existing process is stopped.
4. Create the owner account, then inspect **Settings → About ORE**. It must show version `0.1.0-test.1`, **Release**, and the exact tag commit, Node 24.19.0, schema 13 and `darwin / arm64`.
5. Configure a test Connection and create/import a test character/chat. Stop with Ctrl+C. Start again from a different working directory, with internet disconnected if desired. Startup does not install or rebuild; model requests still require their configured endpoint.
6. Confirm saved content persists under this installation's `data/roleplay.sqlite`. Try Settings → Save backup. Keep private backups separate from the downloadable archive; saved keys are included in backups.

If macOS blocks the downloaded launcher/runtime, use its supported per-item privacy/security review and record the exact message. Do not disable Gatekeeper or other system security globally. Gatekeeper/download-quarantine behavior has not been qualified on another Mac.

## Test building from source

Check out the immutable `v0.1.0-test.1` tag in a clean source checkout. The tagged commit is reachable on main; detached tag checkout is supported. Bash, Git, curl, tar and SHA-256 tools must already exist. No global Node/npm/compiler installation is required:

```sh
git checkout v0.1.0-test.1
./build-portable.sh --release "$(git rev-parse HEAD)" "$HOME/ORE-source-test"
"$HOME/ORE-source-test/start.command"
```

The bootstrap downloads and verifies the pinned private runtime, installs the lockfile in an ORE-owned staging area and activates only after a successful build/native smoke. Repeating the build against the same installation preserves `data/` and `languages/`. Failed builds leave the selected application usable. A clean release build rejects tracked changes and untracked inputs; do not remove your changes merely to satisfy that check. Use a separate clean checkout.

The source archive offered automatically by GitHub may lack Git history/refs required by release mode; clone the repository and check out the tag for this exact-commit workflow.

Report the OS/CPU, About version/commit, whether you used the binary or source workflow, and the failing step/log message. Logs are in `logs/`. Do not attach your database, backups, keys or private transcripts to a public issue.

See [full release/update/recovery instructions](RELEASES.md), [development verification](RELEASE_VERIFICATION.md) and [Windows handoff](WINDOWS_RELEASE_HANDOFF.md). Native notices, source URLs and applicable license texts are included under the selected application's `notices/` directory.
