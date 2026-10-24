# macOS Safari download finalization

## Observed on 2026-10-24

Native Safari 26.5 on macOS 26.5 (25F71) retains completed files in `.download` packages while showing “Finishing download.” The user also observes this through the Safari Dock app, typically for about 90 seconds, but reports immediate downloads through the iPhone Home Screen app. Changing ORE exports from Blob URLs to native HTTP attachment downloads did **not** eliminate this macOS delay. Playwright WebKit download completion does not qualify Safari's separate native download manager.

An isolated loopback HTTP server, without ORE, authentication, SQLite or provider calls, reproduced the issue in native Safari:

- A 267-byte encrypted synthetic Connection and a 52-byte plain-text file both stalled after receiving all bytes.
- Attachment and inline Content-Disposition, explicit Content-Length, and `Connection: close` all reproduced the delay.
- Saving a plain-text file to `/private/tmp` through Save As also reproduced it; the Downloads folder is not required.
- The server completed the encrypted response in approximately 1.3 ms. Safari logged `didWriteTotalBytes 267/267` and `wkDownloadDidFinish` at 14:30:44.814 local time, then moved that file out of its package at 14:32:10.356: approximately 85.5 seconds later.
- Immediately after transfer completion, Safari logged `Could not remove QTN_HARD attribute from WebKit-downloaded file` with `NSPOSIXErrorDomain Code=22` (`Invalid argument`). This identifies an associated quarantine/finalization error, not a proven underlying cause.

macOS's security-policy process also logged network timeouts on a VPN interface during the investigation. Those events were not conclusively correlated with the test downloads; a VPN or Apple-service connectivity problem remains a hypothesis. No security, quarantine, VPN, browser privacy or network settings were changed.

## Practical limits

The retained HTTP export path gives the browser a completed encrypted artifact with explicit length/name and avoids Blob lifetime dependence, but it cannot guarantee when Safari's native download manager finishes its local work. The observed delay does not justify changing encryption, weakening authentication, removing quarantine attributes or disabling security checks. The user-reported iPhone export is a working alternative. A macOS/Safari update or a controlled network comparison may help diagnose the native issue, but neither has been verified as a fix.

Reproduction used only synthetic files. Existing user profiles and exports were inspected read-only. Future verification should distinguish HTTP transfer completion, Playwright download completion, and native Safari's final file/package transition.
