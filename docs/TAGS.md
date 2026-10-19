# Character tags

Tags organize the Characters library locally. One owner-wide catalog is shared by character assignments; tags do not enter prompt sources, model requests, lore activation, context budgets or saved request history. The defaults in section 3 of the [implementation brief](TAGS_IMPLEMENTATION_BRIEF.md) were accepted on 2026-10-18.

## Use

Open **Libraries → Characters → Tags** for the searchable filter dropdown. **Manage tags** in that dropdown opens a scrollable dialog to create, search, rename or delete tags and see their character usage. New character, Import character and Tags share one compact toolbar; no filter panel or Clear filters control appears until needed. Escape or clicking outside closes the dropdown. The manager supports Escape and its close button, restores focus to its opener, and keeps the underlying editor inactive while open. Closing is blocked during a catalog save. Unused tags remain visible. Names are plain text and may contain commas. A deletion confirmation states how many characters lose the assignment. Deleting a character removes its assignments but retains the catalog.

The character editor offers a searchable, paginated chooser and individual removal controls. Chooser rows show only tag names; usage counts remain in Manage tags. During search, both the assignment chooser and filter picker reserve the current results area’s height, including pagination and empty notices, so filtering does not shrink the page and clamp its scroll position. Assignment changes remain a draft until **Save character**; closing discards them along with other character edits. Text and assignments save atomically. Manage tags opens the same dialog over the editor without losing its draft. Close the dialog to continue editing the character. A successful catalog operation advances that editor's captured library revision only if it was based on the editor's revision and its character/assignment dependencies are unchanged. Other concurrent changes retain the draft and require reconciliation; the character editor can adopt current saved text/tags while retaining a local picture/crop. Failed saves preserve the draft.

**Review embedded tags** opens preserved card metadata without writes or reimporting the character or its book. Choose a policy and use **Apply reviewed tags** to commit. All creates missing eligible tags and adds assignments; Existing adds only catalog matches; None changes nothing. Existing assignments are retained. Applying the review saves organization immediately and preserves unsaved character text. Closing the editor afterward discards its unsaved draft, while those explicitly applied assignments remain committed.

Character duplication copies current assignments using shared catalog identities and retains existing embedded metadata and lorebook-link behavior. Renaming a tag keeps its identity and assignments. Local changes never rewrite the original card's embedded tags. Export continues to preserve those embedded fields; assigning a new local tag does not add it to an exported card.

## Import review and recovery

Choose a character JSON/PNG file to analyze it without writes or provider calls. Review its character name, embedded-book information, lorebook compatibility diagnostics, existing/new tag candidates and notices, then choose **Import**. **Import all** is selected initially. **Review tags** contains the styled All / Existing / None radio selector and paginated tag/status table, with full-text tooltips for truncated names. The policy summary shows matching and new counts for All, matching counts for Existing, or “Tags are not imported.” for None. **Cancel** before commit changes nothing.

V2/V3 nested card data is authoritative; legacy cards read root tags. Arrays contain string candidates, deduplicated by canonical identity. Source indexes remain in the analysis contract but are omitted from the displayed table. Blank strings and non-string members receive compatibility notices. Wrong-shaped containers, including a legacy comma-separated string, stay preserved but cannot become assignments. Commas in valid strings remain part of one tag. Unsupported metadata never executes macros or HTML.

All must be able to import every eligible candidate atomically. Overlong local names block All; Existing may still match the safely analyzed catalog candidates. Reviews retain complete candidate names within the metadata analysis budget so tooltips can show even ineligible names in full; only their table presentation truncates. Catalog capacity counts genuinely new tags, and assignment capacity counts the final unique set including any existing assignments. Exceeding parser budgets fails the entire analysis with an actionable error; an incomplete list is never presented as complete.

The reviewed library revision is checked inside the commit transaction. A catalog change requires cancelling and selecting the card again for a fresh review; Existing is never silently reinterpreted against a different catalog. Character, optional independent lorebook, link, new tags, assignments and durable command result commit together. Failure rolls everything back.

An uncertain transport acknowledgement keeps the source, chosen policy and command ID in the open review. **Retry reviewed character import** resends that exact command safely. The review locks its policy after an uncertain response. No automatic resend occurs. Leaving the page does not undo a committed import, and this review state is not persisted across reloads. Recorded success remains replayable after restart or later deletion without recreating data. The interface explains if its original character no longer exists. An intentional new import starts a new command ID and reuses matching catalog tags.

Current fingerprints include card data, effective tag policy and picture digest/mode; pre-picture receipts remain replayable. Omitted policy means None and matches explicit None. A pre-tags fingerprint may replay only for effective None; its absent tag report means unavailable. Command history is never rewritten. The reviewed revision is a concurrency precondition and is excluded from the fingerprint, allowing historical replay after later library changes.

## Filters and bounds

The searchable Characters filter matches **all** selected local tags. No selection includes untagged characters. When filters are active, removable pills and the result count remain below the toolbar after the dropdown closes, with Clear filters and separate empty-library/no-results messages. Edits, imports and refreshes retain the filter; leaving Characters clears it. Renames preserve selected identities. Confirmed deletions or an authoritative refresh prune missing identities. A successfully created/imported character may be hidden by the active filter; the success notice explains this and Clear filters remains available. Setup selectors and other libraries are unaffected.

| Bound | Value |
| --- | --- |
| Preserved character file | JSON 2 MB; PNG 10 MB, with independent 2 MB metadata bounds; see [pictures](PICTURES.md) |
| Local tag name | 100 UTF-16 code units after trim and NFC normalization |
| Catalog | 2,000 tags |
| Assignments per character | 128 unique tags |
| Raw embedded tag array | 4,096 members |
| Embedded string analysis | 500,000 UTF-16 code units total |
| Unique embedded candidates | 1,024 |
| Detailed tag compatibility notices | First 50, plus omitted count |
| Catalog, chooser and candidate pages | 50 items |

Identity is trimmed NFC followed by locale-independent Unicode lowercase, not full linguistic case folding, transliteration or compatibility normalization. Display spelling is separate; existing catalog spelling wins on import, otherwise the first source occurrence wins. Internal spaces, punctuation, accents and width differences remain significant. A case-only rename is permitted; a collision with another identity fails without merging.

The library builds a memoized character-to-tag set index, and list chips share a catalog index. Catalog lookups use a canonical-key unique index; assignment access uses a composite primary key plus a reverse tag/character index. Synthetic fixtures exercise a full 2,000-tag catalog and a 1,000-character × 128-assignment index. These bounds describe the tested workload, not a benchmark or guarantee for arbitrary library sizes.

## Storage and verification

Migration 9 adds `tags` and `character_tags` without rewriting character rows or importing preserved source tags. Foreign keys cascade link deletion; SQL uniqueness and kind triggers prevent duplicate links and assignments to other library kinds. Upgrades, rollback and restart use isolated populated SQLite fixtures. Existing identities, revisions, text, memory, lore state, credentials and historical commands/requests remain intact. The library revision advances once for migration cache invalidation.

Catalog/assignment mutations enforce existing global shared-edit idle restrictions and library revisions on the server. True no-ops do not advance revisions. Organization-only writes never call the prompt-bearing character update. Combined editor saves use the ordinary character revision/lore-reset path only when character data actually changes. Every committed organization change invalidates the library cache and publishes the established change notification.

Tests cover normalization, metadata/limits, JSON/PNG formats and ccv3 preference, SQL constraints, CRUD/atomic rollback, policy-aware durable retries including legacy upgrade/restart, AND filtering, exact request/budget/chat/lore isolation, global running-work restrictions, exports and browser recovery/drafts/refresh at desktop and phone-sized viewports. Routine checks use synthetic cards, temporary databases and controlled model providers. Actual phone browser behavior remains unverified. See [README](../README.md#verification) for commands.
