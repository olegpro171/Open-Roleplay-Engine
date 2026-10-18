# Character pictures

Implemented for local testing following the [assignment](PICTURES_IMPLEMENTATION_BRIEF.md). On 2026-10-18 the user approved sharp and all proposed defaults. Pictures belong to the Characters library/editor; they do not enter model requests, chat headers/selectors, personas or backgrounds.

## Workflow

The Picture section follows Name. Choose/replace a PNG, JPEG or WebP, then Adjust crop. Drag inside the square or use keyboard-operable Zoom, Horizontal position and Vertical position sliders. Axes with no travel are disabled and explained. Reset centers the largest square. Use crop changes the editor draft; Cancel/Escape restores its previous crop. Save character commits text, tags and picture together. Close follows the existing editor discard behavior. Files/crops are not saved across reloads.

A replacement does not replace the current draft until validation succeeds. Invalid files and failed saves preserve recoverable drafts. Selecting the same file again works. Editing a saved crop holds its original bytes once in the open editor so a concurrent replacement/removal cannot destroy the local source; the crop surface uses the bounded oriented preview. No repeated original downloads occur while moving the crop.

An uncertain acknowledgement freezes the submitted command and offers Retry same save. Text, tags, original bytes and crop cannot change during that recovery. Closing does not undo a save that reached the server. A definite rejection permits another reviewed command identity. When the library changes, the editor shows current saved text, tags and picture. Use current text and tags; keep my picture draft replaces local text/tag drafts with those saved values while retaining a changed local picture/crop. Review before saving. A deleted character cannot be resurrected by a retry. Tag-manager and Apply embedded tags revision advancement also check the saved picture dependency.

PNG character import reads embedded metadata before decoding artwork. The existing book/tag review includes a centered picture preview. Valid art saves automatically with that reviewed import. If artwork alone fails, metadata review remains and Import without picture must be explicitly selected. No automatic fallback discards art. After import, Edit imported character / Adjust crop opens the editor even when filters hide the row. Older characters have no recoverable artwork: Choose picture can attach the old PNG without importing its text, book or tags again. A plain image cannot be imported as a card without embedded card metadata.

Character rows reserve a 144px desktop or 88px narrow-screen square. Names occupy at most two lines; full names label actions. Descriptions retain their full text and show a bounded visual preview, fading only on overflow. Up to two tag chips plus a remaining count keep tags bounded; Edit exposes the full list. Filters continue matching all assignments. Images load lazily with a stable placeholder on absence/failure. Other libraries retain their existing layout.

Export JSON remains current card/book data with preserved external metadata and embedded tags. Local pictures/crops never enter Character JSON. Download original picture returns exact retained source bytes; an original card PNG still contains its original embedded metadata, without current edits. Updated PNG-card export, remote asset resolution and animation UI remain deferred.

## Geometry and processing

`src/shared/pictures.ts` owns geometry v1 and public contracts. Crop rectangles are normalized against correctly oriented source dimensions. The width/height ratios differ on rectangular sources. Pixel side and offsets round to nearest integer; the side remains square and bounded between the largest centered square and 4× zoom (rounded to a minimum one pixel). Shared geometry drives SVG preview framing and server extraction. All renditions come from original pixels, never a previous thumbnail.

Pinned sharp 0.35.5 performs strict signature/decoder validation, EXIF orientation, sRGB conversion and alpha-preserving PNG output. Its bundled native libvips runtime was installed and exercised using Node 24.19.0 on this Mac. Processing requires that native package; no system shell imaging tool or remote service is used. Constructor/operation behavior follows the [sharp documentation](https://sharp.pixelplumbing.com/api-constructor/) and [orientation documentation](https://sharp.pixelplumbing.com/api-operation/).

WebP animation uses frame zero. APNG uses its IDAT first frame; containers whose default image is outside the animation are rejected with an actionable message rather than showing the wrong frame. Originals remain animated bytes. At most 256 frames are accepted; only the first display frame is decoded. Small pictures remain usable and receive a low-resolution hint. Renditions strip metadata; originals retain it privately.

| Bound | Value |
| --- | --- |
| Manual source / image-bearing PNG card | 10,000,000 bytes |
| JSON card / decoded embedded UTF-8 JSON | 2,000,000 bytes |
| PNG card metadata scan | At most 20,000 chunks; keywords inspected within their 79-byte PNG bound |
| Relevant PNG text payload / expanded metadata before base64 decoding | 2,000,000 bytes independently; base64 overhead reduces effective JSON allowance |
| Decoded first-frame pixels | 40,000,000 |
| Maximum oriented edge | 16,384 pixels |
| Zoom | 1×–4×, with integer source-pixel rounding |
| Library thumbnail | 320×320 PNG, compression level 6, at most 600,000 bytes |
| Editor preview | PNG, compression level 6, at most 1,600px edge without enlargement, at most 12,000,000 bytes |
| Native processing | Two processes, eight queued tasks; 15 seconds including queue wait |
| Upload base64 | At most 13,333,336 characters; preview/import HTTP envelopes add 1,000/2,000 bytes |
| Combined library-save HTTP envelope | 30,000,000 bytes; individual text/book/picture schema limits still apply |

Each task has a separate child process, one libvips thread, no sharp cache and a 256 MiB V8 heap limit. That heap limit does not cap native memory. A 40 MP oriented RGBA buffer alone occupies about 160 MB before decoder/rendition overhead. Cancellation/timeout sends SIGKILL and an occupied slot is released only on child exit. Queues and listeners are cleaned on cancellation/shutdown. Preview disconnection cancels processing; a submitted save may finish after disconnection, requiring explicit receipt reconciliation. Processing/rendition generation occurs outside write transactions.

A synthetic measurement on this Mac processed six 3,000×4,000 RGBA PNGs in pairs in 891 ms, with approximately 324 MiB sampled aggregate child RSS. A temporary library of 500 pictured characters sharing one original produced a 682,703-byte snapshot in 4.38 ms. Metadata uses one joined image query, without original/rendition BLOBs or per-row image queries. The fixture was a compressible synthetic image; these numbers are a measured workload, not a general throughput or worst-case memory guarantee.

## Storage, revisions and replay

Migration 10 adds immutable `picture_assets` original/preview BLOBs and independent `character_pictures` associations containing crop, thumbnail, revision and a fresh resource key. Character-kind triggers, foreign keys, byte/dimension constraints and an asset-reference index protect ownership. Existing records start without pictures. The upgrade advances only the library cache revision; prior identities, text, tags, links, credentials, requests, summaries, lore state and command receipts are preserved. Rollback and restart are tested with populated temporary SQLite.

Combined saves/imports atomically commit character data, tags, optional independent book/link, pictures and durable command receipts. Commit rechecks library/global-idle and captured picture preconditions. Picture-only writes advance image identity/library revision without changing prompt-bearing character/chat revisions, lore epochs/state, memory or historical input. Exact no-ops preserve revisions. Duplication shares immutable originals but copies independent crop/thumbnail relations. Remove/replacement/deletion cleans only proven unreferenced assets in the same transaction.

Receipts use the existing durable library command ledger and contain small results plus fingerprints, never raw files. New import fingerprints include server-computed original digest and effective retain/none intent. Derived encoding versions are excluded. Bounded metadata extraction/hash and receipt lookup precede strict decoding. Pre-picture tag-aware imports and pre-tags None receipts replay their exact original result, even after deletion or under stricter decode rules; absent old picture reports remain unavailable. A legacy replay never attaches newly supplied art. New same-ID altered image/policy/mode/save payloads conflict.

Authenticated routes serve versioned thumbnails/previews with explicit raster MIME, nosniff, private no-cache revalidation and ETags. Resource existence/authorization precede 304. Removed/replaced keys return 404, and SSE-driven library refresh updates other tabs. Originals use no-store and a fixed safe attachment filename. There is no public upload directory, filesystem URL or blob CSP expansion; data previews use the existing img-src policy. Image BLOBs now fall within the SQLite backup boundary; no backup/restore product feature is claimed.

## Verification and acceptance

Focused suites cover independent crop coordinates, PNG/JPEG/WebP pixel regions and transparency, EXIF orientation, first-frame WebP, malformed/oversized images, queue/cancellation/timeout cleanup, exact downloads/auth/cache/removal, combined rollback, stale/global-idle checks, no-op/isolation, duplicate ownership and import/save receipt compatibility. Browser workflows cover Use crop versus Cancel, draft discard/replacement, keyboard crop/focus, exact uncertain-save retry, two-tab refresh, explicit metadata-only import, tag operations and stale-state reconciliation. Visual fixtures include long names/descriptions, eight tags, tall/wide/transparent/no-picture rows, desktop/390px/320px, short landscape, forced colors and reduced motion. All use synthetic fixtures and temporary data; no real model calls are needed.

Manual acceptance: import a PNG card, adjust and save its crop, cancel a replacement, then save another picture with text/tags. Duplicate it and remove only the copy's picture. Attach an old card PNG to an existing character, download its exact original, and check that Export JSON retains current card/book text. Try a failed save and inspect replacement refresh in another tab. Actual phone touch/keyboard/suspension behavior remains unverified by desktop emulation.
