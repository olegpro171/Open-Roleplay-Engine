# Protected portable files

ORE protects downloaded backups with standard password-derived encryption. The optional password may be empty. A nonempty password must be supplied exactly on import; it is neither embedded in the file nor recoverable by ORE. Password strength still matters against offline guessing. An empty password only deters scanners that look for directly readable API keys. An ORE-aware tool can open empty-password files automatically; targeted extraction need not remain manual.

Protection applies to the entire portable snapshot, including credentials, story text and metadata. It does not change the live database, local schema-upgrade recovery snapshots, HTTP LAN transport, or ordinary credential-free exports. Explicit Connection export with API keys remains future work; the wrapper has an authenticated content-kind identifier for reuse by that feature.

## Workflow and transport

Settings → Data backup asks for an optional password and, when nonempty, confirmation. Keep it separately from the downloaded `ORE-backup-<UTC timestamp>.orebackup` file. Under Import backup, enter the same password before selecting the file. Failed attempts preserve the entered fields; successful creation/inspection clears the relevant fields. Closing Settings discards these transient values. No password is stored in localStorage, command receipts, request history or the artifact.

Authenticated, same-origin POST `/api/data/backup` accepts `{ "password": "…" }` and streams a completed protected file. This replaces the former GET download route so a password never enters a URL. Binary POST `/api/data/stages` carries an optional `X-ORE-File-Password` header containing canonical base64 of the exact UTF-8 password. An absent/empty header means an empty password. Base64 only transports the header; it provides no additional secrecy. Existing application authentication, origin checks and transport policy still apply. Application request logging remains disabled.

Passwords are limited to 256 UTF-16 code units, matching the input and shared validator. There is no trimming, normalization or minimum length. The receiving installation does not need the sender's owner password or other local settings. After successful opening, the existing shipped-schema/content validation, paginated inspection, explicit import confirmation and transactional recovery apply. Existing plaintext SQLite backups remain accepted. Older ORE builds cannot read the new wrapper.

## Version 1 wire format

All lengths are bytes. No JSON, compression or executable metadata is outside the ciphertext.

| Offset | Length | Value |
| --- | --- | --- |
| 0 | 8 | ASCII `OREENC\r\n` |
| 8 | 1 | Wrapper version: 1 |
| 9 | 1 | Content kind: 1 for a backup |
| 10 | 16 | Cryptographically random scrypt salt |
| 26 | 12 | Cryptographically random AES-GCM nonce |
| 38 | Payload length | AES-256-GCM ciphertext |
| End − 16 | 16 | GCM authentication tag |

Derive a 32-byte key using Node's scrypt implementation with the exact UTF-8 password, the stored salt, `N = 32768`, `r = 8`, `p = 1` and a 64 MiB working-memory ceiling. These are fixed version-1 parameters; uploaded files cannot request different work factors. Use AES-256-GCM with the 38-byte header as additional authenticated data and an explicit 16-byte tag. Each export generates fresh salt and nonce, even with a blank or repeated password. Future incompatible parameters require a new wrapper version; preserve version-1 reading.

The wrapper adds exactly 54 bytes. Backup plaintext remains bounded to 128 MiB; the HTTP/browser file bound allows those additional bytes. The wrapper version is independent of the inner portable format and SQLite schema version. Unsupported versions/kinds, malformed structure and oversized payloads fail before key derivation; incorrect passwords and failed authentication fail before any bytes reach SQLite. The authentication tag detects damage but does not establish a file's publisher. Imported content remains untrusted and must pass the ordinary validation.

## Ownership and recovery

`src/shared/protected-files.ts` defines browser-safe bounds and format constants. `src/server/protected-files.ts` owns password transport validation, asynchronous scrypt, encryption/decryption and a process-wide bound of two simultaneous operations. Derived key buffers are cleared on every exit. No new dependency is required. Busy operations return an actionable error and require explicit retry.

Backup export first creates and sanitizes the existing private consistent snapshot, then streams it into a separate private encrypted file. Downloads receive only completed ciphertext. Successful encryption removes the temporary plaintext snapshot; stream close or failure cleans the download directory. Encryption failures remove partial output and never fall back to a plaintext download. These are private temporary files, not a claim of physical secure erasure.

Import buffers at most the allowed file size, authenticates/decrypts it, then invokes the existing trusted SQLite reconstruction. The transient decrypted buffer is cleared afterward. Wrong passwords, invalid authentication and shutdown produce no new stage or saved changes. The original uploaded artifact's SHA-256 digest remains the command identity; review/commit/replay do not require keeping a password. The existing staged plaintext database is private, session-bound and removed on cancellation, completion, expiry or shutdown.

Tests cover a fixed version-1 artifact, fresh randomness, exact bytes and passwords, authentication failures and bounds, cleanup, older SQLite input, cross-installation credential/history restoration, restart/replay and desktop/phone-sized password workflows. All fixtures use synthetic keys and temporary databases. These checks do not establish immunity to offline guessing, future scanner adaptation, actual phone behavior or native Windows/Linux qualification.
