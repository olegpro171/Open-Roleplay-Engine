# Character pictures: implementation assignment

2026-10-19 UI update: the Import without picture control and its metadata-only escape are superseded. Character import retains artwork automatically; invalid artwork blocks import and requires selecting a valid PNG or JSON card. The explicit API mode remains for compatibility. See [PICTURES.md](PICTURES.md) for the current workflow.

2026-10-19 editor update: the original-picture download disclosure and separate Edit imported character / Adjust crop shortcut are removed from the interface. Retained originals still support recropping. Save and Cancel use shared library editor actions; the 2026-10-23 refinement stacks them in the wide sidebar and floats compact icons at the upper right on narrow screens.

Prepared: 2026-10-18.

Status: proposed handoff instructions, not implemented behavior. The current request authorizes writing this guide only. Existing accepted requirements and the proposed defaults below are distinct; accept or amend those defaults with the coordinator/user when assigning implementation.

## 1. Outcome and scope

Make character pictures useful throughout the Characters library and editor without weakening the existing tag, lorebook, import or save workflows. This is primarily a user-facing task: a technically correct upload with an awkward crop tool or unstable library layout is incomplete.

The user's original requirements are:

- Character library entries display pictures cropped to a 1:1 square.
- Users manually set the crop in the character editor.
- Imported pictures receive a default crop.
- Character containers have a consistent bounded height and description previews fade.
- Pay particular attention to UX/UI.

Necessary supporting work includes retaining imported PNG artwork, attaching/replacing/removing pictures, draft/save semantics, durable storage, predictable thumbnails, duplication/deletion, recovery and meaningful visual verification.

Read AGENTS.md, CONCEPTS.md, IMPLEMENTATION.md, README.md, package.json, docs/TAGS.md and docs/LOREBOOKS.md. Current source and accepted documents supersede old briefs: tags are implemented; Character expands checked fields; lore injects relative to included fields/Messages without lore markers. Preserve those behaviors.

This milestone is character-library pictures. Chat bubbles/headers, character-selector thumbnails, persona portraits, background images, galleries, animated presentation, remote image fetching, general V3 asset resolution, CHARX and updated PNG character-card export remain separate scope. Do not add a title/comment field or a broad library redesign here.

## 2. Current integration points

The current PNG reader extracts embedded JSON and discards image bytes. Existing imported characters therefore do not have recoverable artwork in saved data. No migration can reconstruct those bytes from text metadata.

| Area | Current responsibility / implication |
| --- | --- |
| src/server/card-import.ts | Reads character JSON/PNG. Return explicit card metadata and optional artwork bytes separately; strict decoding occurs after replay lookup for fresh commands. Preserve metadata-only/persona callers. |
| src/web/CharacterImport.tsx | Holds original file data, reviewed tag policy and command identity through uncertain acknowledgements. Add a picture preview without replacing this workflow. |
| src/web/CharacterEditor.tsx | Owns combined character/tag drafts, tag-manager reconciliation and dirty/open-book/extraction guards. Picture drafts must join these semantics. |
| src/web/Libraries.tsx | Owns Characters toolbar, AND filters, import notices, list/actions and duplication. Add character-specific layout rather than changing all library entries. |
| src/persistence/store.ts | Owns import transactions/command replay, character saves, duplication, deletion, library revisions and prompt-affecting revisions. |
| src/persistence/tag-store.ts | Owns organization-only writes. Picture-only changes need comparable isolation, without coupling image storage to tag policy. |
| src/core/cards.ts | JSON export overlays current card fields/book. Keep local picture IDs/crops out of these exported fields. |
| src/server/app.ts | Owns authenticated API/static delivery, body limits and CSP. New image responses and preview sources must preserve that security model. |

The current package has no image-processing dependency. A browser-only file preview is insufficient evidence that the server can safely validate, orient, crop and generate durable renditions.

## 3. Proposed defaults requiring review

| Topic | Proposed baseline |
| --- | --- |
| Layout | Retain horizontal character rows; add a character-only visual layout. No gallery/list toggle. |
| Desktop | Square portrait on the left, flexible text in the middle, existing actions on the right. |
| Narrow screens | Portrait beside name/description; bounded tag preview and actions beneath. Preserve toolbar/filter behavior. |
| Crop | Largest centered square by default. Manual pan plus zoom from cover scale to 4×; no rotation, filters, face detection or alternate aspect ratio. |
| Save | Choosing/removing/reframing an image edits a draft. Only Save character commits it, atomically with text and tags. |
| Imported PNG | Retain its original bytes and apply the centered crop during the existing reviewed import. Do not require a crop step to finish importing. |
| JSON / existing no-image character | Show a neutral placeholder and offer Choose picture. Do not infer an image from remote metadata. |
| Manual upload | PNG, JPEG and WebP raster pictures. GIF/SVG/HTML/PDF and other formats are outside this milestone. |
| Animated containers | Retain an accepted PNG/APNG or WebP original, but display one explicitly documented first-frame rendition. No animation UI. Reject safely if that frame cannot be decoded. |
| Original storage | Immutable original bytes, metadata and bounded generated renditions in SQLite BLOB storage, separate from prompt-bearing character JSON. |
| Duplication | Copy picture association/crop along with existing tag/book semantics. Immutable originals may be shared; crop/replacement/removal on one character cannot affect another. |
| Removal | Remove the association on Save. Keep shared originals needed by other characters; clean unreferenced assets transactionally. |
| Import failure | Invalid artwork blocks importing with that picture, with a clear error and no partial records. Preserve successful card/tag/book analysis. Do not silently discard artwork and claim full success. |
| Metadata-only escape | If image decoding fails but card JSON is valid, the review offers an explicit Import without picture choice; this is part of the command payload, never an automatic fallback. |
| Export | Keep JSON card export. Offer separately labelled Download original picture; updated PNG card export is deferred. |
| Older characters | Attach a picture explicitly in the editor; selecting the old PNG there attaches artwork only, without reimporting its character/book/tags. |
| Picture-only mutations | Advance picture/library revisions and cache identity, preserving character prompt/chat revisions, lore state, summaries and requests. Retain existing global shared-edit idle restrictions. |

Proposed resource defaults: 10,000,000 source bytes for a manual picture or image-bearing PNG card, 40 million decoded pixels, and maximum oriented edge 16,384 pixels. Keep embedded JSON/decompression bounds separate from whole-file artwork size; retain the current 2,000,000-byte JSON-card/embedded-data bound unless explicitly changed. These are proposed limits to verify with synthetic fixtures, not claims about universally sufficient card sizes.

Define those metadata ceilings precisely: JSON files and decoded embedded UTF-8 JSON are at most 2,000,000 bytes; text-chunk payload/expanded metadata text before base64 decoding is also bounded to 2,000,000 bytes. Base64 overhead can therefore make the effective PNG JSON allowance smaller. Apply bounded expansion and decoded-size checks independently. Coordinate the current CharacterImport 2 MB guard, preview/import route bodyLimit, base64 schema maximum and reader file limit for larger PNG artwork; calculate HTTP/base64 envelope allowances rather than treating encoded length as raw size. Keep persona/standalone JSON limits unchanged. Document any approved departure from these proposed numbers.

Proposed renditions: a 320-pixel square library thumbnail and an orientation-corrected editor preview bounded to a 1,600-pixel edge. Preserve transparency, use a consistent sRGB display pipeline, and avoid repeatedly recompressing originals. Exact output encoding/quality and size limits must be documented and tested. Small sources remain usable; show a low-resolution hint instead of pretending the thumbnail contains more detail.

Recommended decoder/renderer: **sharp**, subject to explicit approval before adding it. Accepting this guide's dependency proposal would authorize adding one pinned compatible runtime package and updating the lockfile. Otherwise bring a concrete existing-tool alternative to the coordinator; do not silently install a different library or external service. Review supported Node/native installation on this Mac. Primary references: [constructor/input limits](https://sharp.pixelplumbing.com/api-constructor/) and [orientation/operations](https://sharp.pixelplumbing.com/api-operation/).

## 4. Visual design contract

### Preserve the existing product language

Use the established dark surfaces, warm accent, borders, typography, controls and spacing. Pictures should make characters easier to recognize without turning the library into a different product. Preserve the compact New character / Import character / Tags toolbar, active filter pills/count, import review and empty/no-results messages. Tag management remains in its existing dialog.

Apply new CSS/components only to Characters. Lorebooks, personas, Connections and presets retain their current layouts. Keep the list stable when images load or fail, and retain reading position when returning from an editor wherever practical.

Conceptual layout, not pixel-exact artwork:

```text
Desktop character row
+---------------+--------------------------------+----------------+
|               | Name (at most two lines)       | Edit           |
| Square        | Bounded tag chips + more count | Duplicate      |
| portrait      | Description preview            | Export JSON    |
|               | ...fade at overflowing edge    | Delete         |
+---------------+--------------------------------+----------------+

Narrow character row
+-----------+-----------------------------------+
| Square    | Name (at most two lines)          |
| portrait  | Short description with fade       |
+-----------+-----------------------------------+
| Bounded tag chips + more count                |
| Edit       Duplicate       Export       Delete|
+-----------------------------------------------+
```

Proposed starting dimensions: 144px desktop portrait in an approximately 216px row; 88px narrow-screen portrait in an approximately 224px row. Tune against actual controls/font metrics and screenshots. Heights must be consistent within a breakpoint at normal text size, not driven by description/tag length. Under increased text size/zoom, allow controlled row growth/reflow to preserve readable names and operable actions. Literal fixed heights are not permission to clip controls or create horizontal page scrolling.

Names get a reserved maximum of two visual lines; full names remain available in the editor and accessible control names. Descriptions use a bounded line preview with a subtle bottom fade only when overflowing. Remove the current arbitrary 140-character cut for this view: crop the presentation, not the underlying text. Do not fade names, tags, actions, focus outlines or the whole content column. Decorative fades must not intercept pointer events. Supply a readable forced-colors/reduced-effects fallback.

Bound tags independently: reserve one row, show a small number that fit, and a labelled remaining-count affordance or a clear path to the editor's full list. Do not let 128 assignments expand the card indefinitely. Hidden tags retain their assignments/filter behavior. Any count popover must support keyboard, dismissal and focus restoration; it must not obscure other rows' primary actions permanently.

Reserve the square's geometry before loading. Use a stable neutral placeholder for absent images and a non-disruptive unavailable-image state for load failure; never show a browser broken-image icon or collapse the square. A placeholder is UI decoration, not an asset saved into every character. Do not fabricate a generated portrait.

Transparent artwork uses a consistent neutral surface in the library; the crop tool can show a subtle transparency checkerboard. Keep alpha in retained/generated image data rather than baking the current dark theme into the original.

Keep existing actions visible and distinctly operable. A portrait or whole row must not unexpectedly select a character for a chat. Avoid nested clickable cards/buttons. Thumbnail alternatives should avoid redundant screen-reader announcements when the adjacent name already labels the row.

## 5. Character editor and crop interaction

Add a compact Picture section near Name, before the long text fields. It shows the exact square result and Choose picture / Replace picture, Adjust crop and Remove picture as appropriate. Explain once: the original is kept, and this crop controls the library picture. Do not bury image controls below the greeting, lorebook and tags.

Selecting a replacement must leave the current draft intact until validation/decoding succeeds. Then show the replacement with its default crop. Re-selecting the same file must work. Removing a picture is reversible by cancelling editor changes; do not send an immediate destructive request.

### Crop dialog

Reuse the established native-dialog interaction pattern: accessible title, initial focus, contained keyboard focus, Escape/Cancel, inert background and focus restored to Adjust crop when closed. Use a square viewport with the image moving behind it. Keep a thin border/grid that aids framing without obscuring the portrait. Do not permit empty borders around the selected region.

Offer pointer/touch drag and a labelled Zoom slider. Also provide labelled horizontal/vertical position controls or equivalent accessible numeric/step controls, so the complete operation is possible without dragging. Keyboard arrows/step controls must produce predictable bounded movement. Position controls along an axis with no available travel should communicate that state rather than appear broken.

Reset crop returns to the centered largest square for the current draft image. **Use crop** applies the crop to the character draft and returns to the editor; it does not save to the server. **Cancel** restores the crop that existed when the dialog opened, preserving other character drafts. These labels must make the two save levels unambiguous.

At phone widths, the viewport scales to available width and the dialog fits dynamic viewport height/safe areas. Controls/footer remain reachable in portrait and landscape. Limit touch gesture capture to the crop surface; the surrounding controls/page must still scroll normally. Pinch zoom may complement the slider but is not required. Honor reduced motion and visible focus; do not rely on hover instructions.

### Crop geometry

Store a non-destructive normalized source rectangle relative to the decoded, correctly oriented image, with versioned geometry semantics. Enforce a square in pixel space, finite values, bounds and zoom limits on the server. Normalized width and height are generally different for a non-square source; do not assume equal ratios mean a square.

Use a shared pure geometry helper for conversion/clamping/defaults, with independent expected-coordinate tests. Rendering operates from immutable original pixels, never from a previously cropped thumbnail. Browser preview and saved rendition must use the same orientation, rectangle and rounding convention. EXIF orientation, tiny images, extreme aspect ratios, zoom limits and boundary drags are required cases.

Show the crop using an orientation-corrected working preview whose coordinates map to server-decoded source dimensions. A fast local preview may be provisional; do not accept a crop whose geometry the server will interpret differently. Do not strip retained original bytes merely to normalize the preview.

## 6. Drafts, saving and failure states

Extend the editor's draft to include keep/replace/remove artwork and crop state. Omitted picture mutation in older commands means preserve; explicit remove means remove; invalid or unknown mutation modes are errors. Distinguish a selected local file from an existing saved asset reference. Validate ownership of all referenced assets.

Save character atomically commits text, tags, picture association and crop, using the captured library/picture preconditions. Image decoding/rendition generation occurs outside the short transaction; recheck revisions, record existence and operation identity at commit. Keep the previous committed image visible in other views until success.

During analysis/decode/render/save, expose understandable progress and prevent duplicate commits. Failed saves/conflicts retain all recoverable text/tag/image/crop drafts and explain the next action. Older decoding results cannot overwrite a later file, changed character, cancelled crop or closed editor. Dispose listeners, bitmaps, object URLs and processing work on replacement/unmount. Do not revoke a preview URL while it is still in use.

All dirty-state guards must include picture/crop changes: opening a linked book, extracting a book, closing/discarding the editor and navigation that already discards drafts. Do not claim there are no edits simply because text/tags are unchanged. Follow existing editor discard semantics; do not introduce automatic picture draft persistence across browser restarts.

TagManager and Apply embedded tags must continue preserving the editor draft. Their self-originated revision advancement must also verify that the saved picture dependency has not changed elsewhere. Do not blindly rebase onto a newer library revision or replace a local picture draft with a refreshed thumbnail.

Define ambiguous-save recovery, not just validation errors. A repeated exact command must not create duplicate assets/characters or overwrite a later independent picture edit. Use a durable command identity or equivalent rigorously tested receipt/CAS mechanism for combined image saves. A replay after later removal/deletion returns recorded success without resurrecting data. No automatic resend is required.

The editor must retain the frozen submitted command, including file bytes, crop, text and tags, show Acknowledgement uncertain, and offer Retry same save. Disable changed-payload resubmission until reconciled, or explicitly maintain a separate next draft with equally rigorous semantics. Explain that closing does not undo a save that reached the server. A definite conflict allows a new reviewed attempt; it does not authorize retrying altered content under the old command ID.

For stale revisions, provide a reconciliation path that retains the local picture/crop while showing current saved state. Reapplying the picture must not silently overwrite newer text/tags. Do not make Close and reopen, which discards all local image data, the only recovery path. This can be a focused review/reapply action rather than a general-purpose text merge feature.

## 7. Character import and existing artwork recovery

Retain source bytes when parsing a PNG card; pass the optional artwork separately from card JSON through analysis/commit. Embedded metadata must be read from original bytes before any image normalization/re-encoding can remove it. Preserve ccv3 preference and existing JSON/ZTXT/ITXT bounds. A valid signature/header alone is not successful image decoding.

The existing import review gains a square centered preview and concise picture status, alongside lorebook/tag diagnostics. Import uses that default crop without an extra mandatory dialog. After success, offer a clear route to Edit character / Adjust crop; if tag filters hide it, preserve the existing explanation and recovery control.

If only artwork fails, retain the successful metadata review and tag-policy choice, show the picture error, and require an explicit Import without picture selection before enabling that commit. Show No picture will be saved in that mode. Changing the mode after a definite rejection is a new reviewed intent; it cannot reuse a frozen uncertain command with a changed payload.

Character, optional book/link, tags/assignments, original asset, initial crop/renditions and durable command result commit together or not at all. Reject stale reviewed revisions. Cancel before commit creates no saved character or artwork. Staging/cache artifacts, if used, need bounded lifetime, cancellation cleanup and no misleading committed-success state.

New command fingerprints must include the artwork byte digest and effective artwork mode in addition to card metadata/tag policy, so identical card JSON with different pictures is not the same payload. Hashes are computed/verified by the server, not accepted from the client as proof. Fingerprints should describe user intent; derived rendition encoding/version changes must not invalidate a successful replay.

Preserve replay of existing successful pre-picture imports, including the older pre-tags None compatibility. Legacy success returns its original result without attaching newly supplied artwork, duplicating records or pretending the original picture was saved. Make absent historical picture reports unavailable rather than fabricated. Same-ID commands changing artwork intent must conflict except for the explicitly documented legacy replay case. Test this compatibility path independently.

Order the server path explicitly: bounded metadata extraction and byte hashing, recorded-command replay lookup, then strict image decode/render only for a fresh command. Stricter new image rules must not invalidate historical success before its receipt is consulted. Maintain bounded input validation for replay; do not turn it into an unbounded parser bypass. A newly submitted header-only metadata fixture must fail picture decoding even though an old recorded success using it remains replayable.

Older characters show No picture with Choose picture. The editor may accept the user's original card PNG as artwork, but must not reimport its metadata, create a new character/book, apply embedded tags or replace current character text. Choosing a plain PNG for artwork is valid; importing it as a character card still correctly fails if it has no embedded card metadata. These actions need distinct labels and endpoints.

Do not fetch V3 remote asset URLs or use preserved source fields as file paths. General asset support is separate. A JSON card can be imported without artwork and receive a manual picture afterward.

## 8. Storage, ownership and revision isolation

Prefer an image-specific persistence module with immutable original BLOB assets and independent character picture/crop relations. Include MIME/type, verified dimensions/orientation, byte digest, rendition version and relation revision. Keep the model explicit without building a general multimedia asset framework.

SQLite storage keeps bounded original/rendition writes and association changes transactional with existing imports. Do not put base64 originals in character JSON, library snapshots, ordinary chat refreshes or command-result payloads. Snapshots expose only safe image references/versioned URLs and dimensions needed for layout.

Deduplication is optional; correct duplication ownership is required. Sharing immutable bytes is safe only when each character's association/crop is independent. Removing/replacing/deleting one character's picture must not delete another's source or rendition. Clean only proven unreferenced assets in a transaction. Do not keep every abandoned upload forever, and do not retain huge bytes in the durable command ledger as an accidental second asset store.

Picture-only writes advance the library cache revision and picture relation/version, leaving prompt-bearing character revisions, chat revisions, source JSON, tags, lorebooks, lore epochs/state, memory and request history unchanged. True no-ops preserve revisions. Combined saves use the ordinary prompt revision path only for actual prompt-bearing changes. Preserve global shared-edit idle guards and server-side conflict checks.

Extend the existing duplication endpoint to copy picture/crop with current assignments and shared book link. Deleting a character removes its relation atomically under existing in-use restrictions; unused tag records remain. Historical model requests do not gain image references because no picture was sent to the model.

Add a new versioned migration, schema definitions and registration consistent with current storage. Exercise fresh creation, populated current upgrade, rollback and restart idempotency. Existing characters start with no pictures; preserve all identities/revisions/text/tags/links/lore state/credentials/commands/requests. Do not backfill fake images or rewrite historical imports. The backup boundary now includes image BLOBs in the database; this does not establish a new backup/restore product feature.

## 9. Processing, delivery and cache behavior

Use a server-owned validated decode/orient/crop/rendition pipeline. Match supported raster signatures and decoder results, not filename or declared MIME alone. Enforce compressed bytes, decoded dimensions/pixels, frame/page handling, output bytes, bounded concurrency and processing duration. A timeout must bound/stop actual work; a rejected Promise while unlimited decoding continues is insufficient. Reject truncated/corrupt data actionably; a failed replacement preserves the previous valid picture.

Keep processing outside database transactions and heavy synchronous request/render loops. Document the proposed library's memory/native-runtime implications and measure a representative synthetic workload. Never invoke shell image commands with uploaded filenames or introduce a remote processing service.

Deliver thumbnails/previews/originals only through authenticated server routes with explicit raster Content-Type and nosniff. No static public upload directory or filesystem paths in URLs. Verify authorization before any conditional-cache response. Use private revalidation/versioned resource URLs so crop/replacement/removal refreshes on the initiating view and another tab without stale browser-cache pictures. Originals should use a deliberate download disposition and appropriately restrictive caching.

Reserve geometry, lazy-load offscreen library pictures and decode asynchronously. The crop editor loads a bounded working preview, not the full original repeatedly. Do not download every original when opening Characters. Removing an image clears its association in authoritative refreshes; a failed thumbnail request never clears saved artwork.

Current CSP allows self/data images but not blob URLs. If local previews use object URLs, narrowly add blob only to img-src and test it. Do not weaken script, origin, authentication or TLS policy. Keep private originals and EXIF metadata out of ordinary error logs/responses.

## 10. Export boundaries

Keep **Export JSON** as the current card-data export, including current linked lorebook and preserved embedded tags. Strip all local picture/crop/asset/revision/digest fields. Retain original imported unknown metadata without inventing active remote asset support.

**Download original picture** returns the exact retained source bytes with a safe filename. Explain in that action's context that an original card PNG can contain its original embedded character metadata; this does not update it with current edits. A downloaded original is not an up-to-date PNG card export. Keep the normal library toolbar uncluttered; this secondary action can live in the editor.

Updated PNG card export needs encoding current card/book metadata into image chunks and is not delivered by this milestone. Do not label an unchanged original or a metadata-free thumbnail Export character PNG. If the coordinator chooses to include that separate work, expand the scope/contracts/tests explicitly first.

## 11. Implementation sequence and design checkpoint

1. Trace current code and confirm proposed scope/defaults, dependency, storage, limits and image-save/replay contract. Inspect current screens rather than designing only from these wireframes.
2. Prepare reviewable desktop/narrow-screen library and crop-dialog layouts using synthetic images/data. Include tall/wide/transparent/no-image rows, long names and many tags. Present screenshots to the coordinator for UX review before treating layout as final; independent storage/geometry work can continue. Do not require the user to discover layout defects during final acceptance.
3. Implement pure crop geometry and validated processing, then persistence/migration/ownership with isolated tests.
4. Integrate atomic import/save/duplicate/delete/replay and image-only revision isolation. Preserve tag/lore behavior and old command compatibility.
5. Implement editor/crop/import preview/list layout and private thumbnail delivery. Exercise async failures and responsive/accessibility paths.
6. Review final screens and diff together, fix findings, update documents and run required final checks.

The coordinator owns product clarification and integration. Delegation should have clear module ownership after contracts stabilize; do not let several agents invent different crop representations or concurrently change CharacterEditor/import transactions incompatibly. No unrelated cleanup or library-wide redesign is authorized.

## 12. Required automated and visual evidence

Use real synthetic raster fixtures with known colored quadrants, edge labels and orientation markers. A fake PNG header containing only a metadata chunk is insufficient for image-processing tests. Keep such old parser fixtures where appropriate, but add valid complete images and malformed-image cases instead of weakening decoder validation to satisfy them.

| Area | Required evidence |
| --- | --- |
| Geometry | Independent expected crops for tall/wide/square images, default center, pan boundaries, max zoom, tiny images, finite/range validation, EXIF-oriented coordinates and no cumulative crop/recompression |
| Processing | PNG/JPEG/WebP; first-frame policy; transparency; corrupt/truncated/spoofed MIME; small compressed oversized-pixel image; byte/edge/frame/output/work bounds; timeout/cancel cleanup; previous valid image retained on failure |
| Import | Valid JSON without art; V1/V2/V3 PNG and ccv3 preference; default preview matches persisted crop; tag/book diagnostics retained; explicit metadata-only choice; atomic rollback after book/tag/image writes |
| Retry | Same payload lost-ack/restart replay; different picture with identical JSON conflicts for same new command ID; same-image different policy/mode conflicts; legacy/pre-tags replay; replay after deletion cannot resurrect records; encoding upgrades don't invalidate receipts |
| Persistence | Fresh/populated migration; rollback/restart; original bytes retained; shared duplication/independent crops; delete/remove/replace ref cleanup; combined text/tags/picture atomicity; stale revision and duplicate save safety |
| Isolation | Picture-only changes preserve exact prompt/budget/chat/character prompt revisions, summaries, lore state/epochs and historical requests; library/versioned image identity changes refresh both tabs; true no-op stability |
| Delivery/export | Unauthorized thumbnail/original denied; cache revalidation/removal; explicit safe MIME/nosniff; no image bytes in snapshots and no local picture fields in exported card JSON; safe versioned snapshot references allowed; exact original-byte download; original download clearly distinct from current card export |
| Editor | Choose/replace/remove/reset/crop/save/reopen; Use crop vs Cancel; editor discard; failed save preserves file/crop/text/tags; tag-manager/apply keeps picture draft; open-book/extract guards include pictures; stale async file completion ignored |
| Keyboard/touch | Complete keyboard-only crop, focus containment/return, Escape and sliders/position labels; touch drag bounds and surrounding scroll; 44px target starting point for touch actions; no hover-only essential control |
| Library | Mixed images/placeholders/failures; identical row geometry at normal settings; name/tag overflow; fade only overflowing description; actions reachable; no image-load layout jump; filters/import-hidden notices unchanged; other libraries unchanged |
| Responsive/visual | Wide desktop, approximately 390px and 320px widths, short landscape viewport, 200% zoom/text enlargement, forced colors and reduced motion; no horizontal page scroll or clipped focused controls |
| Performance | Representative populated library, lazy thumbs and bounded previews; no original-byte snapshot amplification, per-row DB reads or unbounded parallel decodes; report actual measured workload rather than claiming arbitrary-scale support |

Assert observable saved state, pixel-region results and action behavior, not merely class names or screenshot existence. Browser tests should verify that a selected corner becomes the persisted thumbnail corner, cancel does not persist, and another tab sees the authoritative replacement. Inspect actual desktop/mobile screenshots for crop framing, fade, spacing, controls, contrast and long content. Save useful review screenshots as verification artifacts without committing private/user images.

Extend current libraries/tags/lorebook import-persistence/browser tests and add cohesive image/geometry suites. Use temporary SQLite and local mock providers only. Image changes do not authorize real model calls or destructive use of active data.

Before application handoff, run npm run check (or all constituents successfully on final changes) with README's supported Node runtime; build before browser suites. Report exact missing checks/environment blockers. Emulation is not actual phone verification, and a passing build is not visual acceptance.

## 13. Documentation and completion

Update CONCEPTS.md with accepted picture decisions, IMPLEMENTATION.md with storage/geometry/transaction/revision contracts, README.md with real workflows/formats/limits and a focused pictures subsystem document. Keep this handoff distinct from implemented status; do not add a feature diary to AGENTS.md.

Final report: user-visible outcome, selected design/dependency/defaults, automated checks/results, manually inspected screenshots, migration/ownership evidence and remaining limitations. Review the whole diff for raw-byte leakage, lost drafts, stale picture writes, orphan/shared-asset deletion, command-replay incompatibility and tag/lore regressions.

Manual acceptance: import a PNG card and see its default square; edit its crop and verify the library; cancel a replacement and confirm the old image survives; save a new picture alongside text/tags; duplicate then recrop/remove only the copy; attach an old card PNG to an existing no-image character without duplicating its metadata; filter a long-tag library at phone width; download the original and verify JSON export remains metadata-only. Include a failed-save recovery and a two-tab refresh check.

Completion requires a visually coherent library/editor/crop experience and its dependable saved-state lifecycle. Image upload alone, attractive mockups alone or green nonvisual tests alone do not complete this task.
