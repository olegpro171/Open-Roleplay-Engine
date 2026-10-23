# Transcript loading

Story opens the latest 15 whole turns. Near the top, it loads up to 40 older turns; near the bottom of an older window, it loads up to 40 newer turns. Explicit Load older turns / Load newer turns controls provide the same actions. The current window contains at most 120 turns; farther turns are unmounted and reloaded if the reader returns. Whole turns, blank parts, selected response variants and archived-turn labels retain their existing meaning.

Prepending or trimming restores the visible turn by stable identity and within-turn progress. Resizing retains the same anchor. The bottom of an older window is a reading position, not permission to jump to the latest turn. Latest turn explicitly returns to the current end. Page movement is disabled while editing, and automatic movement also pauses while a turn control has focus. Loading failures retain the window and composer draft; the explicit page control retries. If an edited turn is remotely removed/replaced, its unsaved text remains available to copy and close.

Opening either turn editor scrolls its beginning into the transcript viewport. While an editor is open, automatic reading-anchor restoration pauses so expanding text and manual scrolling can reach the editor’s end and save controls. Closing restores the pre-edit reading anchor (or the latest position when previously following) and resumes ordinary transcript anchoring; cancelling retains the saved turn unchanged.

Browser Find searches only mounted turns. Whole-chat search, jump-to-turn controls and persistent reading-position storage remain deferred. Reopening/reloading the chat starts at the latest turns. Returning from a chat tool retains the current in-memory window and scroll anchor when its sources still exist.

## Read contracts and consistency

`src/shared/transcript.ts` defines a `StorySnapshot`, deliberately distinct from the full `ChatSnapshot`. `/api/chats/:chatId/story` validates `anchor`, `shift`, `limit` and `revision` with one shared schema. A page is a complete replacement window, never an unchecked merge of old and new pages. Movement requires the captured chat revision; stale revisions or removed/foreign cursors fail with 409. The reader may then refresh authoritative state and explicitly retry. If the current window's first turn was removed or all history was replaced, refresh shows a notice and loads the latest window.

`StoryReader` performs its coupled reads in one short read transaction. The existing `(chat_id, position)` index supplies the page bounds. `Store.readTurns` shares the selected-variant integrity checks with full engine snapshots and restricts text/variant queries to those bounds. Ordinals count surviving preceding turns, so deletion does not make stored position gaps become incorrect visible turn numbers. No migration, transcript rewrite or new dependency is required.

Story includes global total/pending/generation/preparation state independently of the page. A response outside the visible window still blocks another submission. Page-scoped generation descriptors retain usage, bounded reasoning previews and attempt identities, while historical request bodies remain in their existing storage and inspection endpoints. Live partial output still comes from the owning server coordinator. Shared provenance-based freshness checks use all relevant source revisions, not the page's incomplete turn set; summary prose and job history are not sent to Story.

The browser serializes page movement, ignores superseded replies and aborts page fetches on leaving Story or switching chat. Notifications during a delayed page read trigger a recheck of the same revision before presenting that page; stream-only updates can reconcile without authorizing a stale history result. An SSE disconnect does not stop generation. Reconnect refreshes current authoritative state for the window. Sending a turn explicitly moves to the latest window after acknowledgement, preserving the browser's existing draft-recovery rules.

Memory, Setup/history replacement and Request inspector fetch full snapshots only while open, with cancellation and chat-identity guards. Their committed state continues to refresh with notifications. The server's generation, preview, lore, preparation and repair paths continue to use full engine snapshots and the existing request-assembly algorithms. Display pagination does not modify cutoffs, memory selections, coverage, historical requests or model input.

## Verification and limits

`tests/transcript.test.ts` covers bounded backward/forward reads, complete turn reachability, unchanged saved state, cursor validation, authentication, stale revisions, deletion ordinals, archived/stale memory outside a page, credential/request-body exclusion and exact complete provider input after paging. It also makes full engine snapshot loading fail during paged reads, so slicing a full snapshot cannot accidentally satisfy the bounded-read test.

`tests/browser/transcript-paging.spec.ts` exercises the 438-turn fixture at desktop and phone-sized widths: 15 initial turns, the 120-turn cap, reading-anchor preservation, older/newer movement, editing guards, failures/retry and retained drafts. Another workflow covers delayed stale pages, a response outside the window, reload during generation, cancellation and chat switching with an old page pending. The existing resize workflow reads backward to its historical test turn before checking desktop/phone resizing and Latest turn.

These tests use temporary/synthetic data and controlled providers. Actual phone suspension/keyboard behavior and the user's real-chat timing remain manual checks. The earlier `content-visibility: auto` trial did not improve measured startup and has been removed from Story. Pagination reduces transcript text transfer and Markdown/DOM work; the initial library bundle, complete server-side request previews and memory freshness processing still have their existing costs. Full chat tools can still be expensive on very long histories; this change does not paginate their detailed inspection data.

## Synthetic loading measurement

This measurement used the earlier 40-turn initial window. The additional effect of the 15-turn initial window has not been timed separately.

An unthrottled local Chromium comparison used the same 438-turn Markdown fixture, fresh browser contexts, three alternating loads per mode at each width, and no selected Connection/request preview. The baseline served the full engine snapshot through the current renderer's display contract to reproduce complete-history loading; the paged mode used the real Story API. Time runs from navigation until the latest turn is loaded, scrolled into view and two animation frames have completed.

| Viewport | Complete transcript median | Paged Story median |
| --- | ---: | ---: |
| 1380 × 900 | 1.01 s | 0.33 s |
| 390 × 900 | 0.98 s | 0.31 s |

The full snapshot was 1,140,475 bytes; the initial Story response was 108,183 bytes. This establishes a substantial improvement on this synthetic fixture, not a guaranteed latency for the user's chat, a real phone or a chat with expensive request preview/memory processing.
