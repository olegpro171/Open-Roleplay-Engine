# Editable history and layered context

Date: 2026-10-16

Status: context-engine design discussion; the first chat milestone exists, but layered compaction and repair are not implemented. A [standalone synthetic visualizer](VISUALIZER.md) explores budgeting and the candidate promotion policy; it does not implement editing or repair. This document extends [CONCEPTS.md](../CONCEPTS.md). Accepted turn rules and user-defined context constraints are identified separately from proposed mechanisms and unresolved policies. Numerical values are worked examples, not defaults.

## Accepted turn editing and deletion rules

A turn contains a user-input part and an assistant-response part. Historical turns must be complete; only the latest turn may await a completed response. A pending turn blocks submission of another turn while it remains unresolved. Only a whole turn can be deleted; either part can be edited independently. No deletion merges surviving content into neighboring turns.

An intentional edit to an empty string is valid. Clearing either or both parts preserves the turn's identity, membership, and completed status. A completed turn with blank content still counts as one completed turn. A missing or unfinished response is a separate state: empty text alone neither completes a pending turn nor reopens a completed one.

These rules preserve exchange boundaries, not semantic action–reaction balance. A blank part supplies no story content, and clearing it may leave later story events without their original explanation.

## Current user-defined direction

A **turn** follows the accepted rules above. The user selects a **target input context size**, a minimum verbatim tail length `L`, and a fixed first-layer batch size `B`. The target, such as approximately 32K tokens, is distinct from the model's **maximum available context**. It is a strict working limit even if the model could accept more input. The user's motivation is response quality; no universal quality claim or optimal target is established here. Account for prompt text, character, persona, scenario, pending input, and other non-history content before allocating the remaining target capacity to history. Recent turns remain verbatim and editable without affecting existing summaries, provided summaries do not read them as additional dependencies.

Keep the entire conversation verbatim while it fits the target. When the next request would exceed it, summarize the oldest eligible complete batch, retaining more than `L` turns whenever possible. A batch must contain exactly `B` completed turns and leave at least `L` verbatim. Smaller boundary batches are explicitly rejected. If the minimum tail, or the longer residual tail imposed by fixed batching, cannot fit together with required non-summary input, generation fails. Do not silently change `L`, change `B`, or use the model's spare capacity beyond the working target.

When no complete first-layer batch is eligible and the request still does not fit, promotion of existing summaries may free space, provided the required non-summary input and remaining verbatim tail can fit. A decision function must choose which summary level to promote so recent summaries retain finer detail instead of all level-1 summaries eventually being consumed. The function remains under discussion. Fixed summary-age thresholds are rejected. The former automatic `L + B` compaction trigger and its turn countdown are superseded: `L + B` is now an eligibility boundary, while exceeding the working target triggers compaction.

Successfully summarized messages are marked **archived**. They remain stored, readable, and editable, but are represented through summaries rather than sent verbatim to the roleplay model. An edit to archived material marks summaries derived from it as out of date, then propagates to higher summaries derived from those summaries. The user can regenerate the affected memory.

For repair, the proposed alternative to starting over is to give the model the existing summary and a diff of its changed sources, asking for a targeted revision. At the first layer those sources are turns; at higher layers they are lower-layer summaries. The intended benefit is to preserve useful wording and manual work while incorporating a rewritten history. Whether this sufficiently preserves manual intent remains an open question.

## Budget allocation and cutoff: proposed mechanism

The limits, fixed first-layer batching, and failure conditions above are user-defined constraints. The preparation mechanism below is recommended for discussion, not a finalized implementation specification.

Count completed turns in the currently selected continuation. Protect the newest `L` completed turns, or all completed turns if fewer exist. The pending turn's user input is additional required input, not another completed turn. Intentionally blank completed turns still count toward `L`.

1. Read the target input size and separately validate the Connection's physical input/context and output limits. For a combined input/output window, reserve output space against that physical window. Do not subtract output again from the input-only working target or silently increase the target to use spare physical capacity.
2. Account for all non-history request content, including resolved prompt blocks and markers, pending user input, and message-format overhead. Content described as constant can still change between requests, so recalculate when its inputs change. The remainder is the shared history budget; the proposed soft layer allowances below guide selection without reserving otherwise unused space.
3. Load the last committed selection of summaries and verbatim cutoff, append new input, and measure that representation. Do not rebuild a summary tree from the current transcript length. If it fits, keep the exact existing selection even if capacity remains unused; on a fresh chat this means all history remains verbatim.
4. If it does not fit and at least `B` completed verbatim turns lie outside the minimum tail, summarize exactly the oldest `B`. Save and validate its replacement, then remeasure. Repeat only as needed, stopping as soon as the request fits.
5. If no complete first-layer batch remains, include all residual verbatim turns when calculating the space available to summaries. If this verbatim tail plus required non-summary input already exceeds the target, fail generation. Otherwise select a summary-promotion candidate using the still-proposed decision function below. Retain its children, select only one representation of their coverage, and remeasure. Repeat only as needed.
6. Validate the fully assembled request against both the working target and physical limits before generation. If available compaction cannot reduce the request sufficiently, fail with an explanation; do not silently change batching, violate the minimum tail, exceed the target, or drop history.

For illustration, a planned request of 32,800 tokens exceeds a 32,000-token input ceiling. Replacing an eligible oldest batch occupying 2,000 tokens with a summary occupying 350 tokens reduces the request to approximately 31,150 tokens. Stop there even if far more than `L` turns remain verbatim. These figures illustrate net savings, not fixed batch or summary sizes; final request measurement includes formatting overhead.

Summary size consumes the same history budget as verbatim turns. A proposed replacement must provide useful net token savings before it can solve an overflow; requesting a short summary does not guarantee that it will be short enough. Output targets, minimum useful summary detail, and behavior when a batch cannot be usefully reduced remain open.

`B` is fixed. With `L = 100`, `B = 3`, and 102 completed verbatim turns, none can be summarized in a new first-layer batch. If these 102 turns plus required non-summary input exceed the target, generation fails. If that input fits but the addition of summaries causes overflow, summary promotion can still help. The summary budget must be calculated after the actual 102-turn tail, not an imagined 100-turn tail. With 103 verbatim turns, the oldest three are eligible when token pressure requires compaction.

Any preview should identify candidate source turns by stable identity. A reliable fixed countdown in future turns is no longer implied: their token lengths are unknown. Headroom or proactive processing could reduce waiting, but their policies are undecided and must not silently replace the user's working target with a substantially smaller one.

## Stable selection across requests: accepted direction and executable contract

The user requires successive requests to retain a similar historical representation,
without summaries moving back and forth between levels as the verbatim tail grows
and is compacted. Unused target capacity is preferable to that oscillation. This is
an accepted direction; it does not settle promotion weights, retained counts, or
an additional headroom threshold.

The cause demonstrated in the original simulator was independent preparation of each
transcript prefix. A slightly different tail left a different summary budget, so the
optimizer picked a different tree, sometimes returning older coverage to a lower
level. Those were alternative histories of decisions, not valid consecutive states
of one continuing chat. The scalar pool `S` alone does not change relative ranking
between fixed eligible levels: it divides every candidate score equally. The problem
was discarding the previous selection, not that denominator.

The strategy must retain state, independently of any UI:

1. Keep the committed verbatim cutoff, saved summary records and their dependencies,
   and the selected summary identities/revisions for the current continuation. The
   existence of a saved summary does not mean it is selected for input.
2. Start the next preparation from that committed state. Append new conversation
   content and remeasure all required input; do not optimize the tree from scratch.
3. If the input fits, leave every selected historical summary unchanged. Do not
   reactivate children, restore archived turns, or rebalance levels to consume slack.
4. On overflow, use the existing fixed-batch, minimum-tail, and promotion eligibility
   rules. Save and validate a replacement first, then atomically replace exactly its
   selected sources with the parent and advance the cutoff if turns were summarized.
   Preserve all unaffected identities and revisions. Emit selected coverage in source
   order, not summary-creation order. Remeasure and stop as soon as input fits.
5. Carry that committed selection forward. A source range may stay at its current
   level or move to a saved ancestor; ordinary forward continuation never demotes it.
   A summary that becomes inactive stays inactive until a separate explicit restoration
   or repair operation. A smaller prompt or more available budget alone is not restoration.
6. If preparation cannot fit, keep the coherent saved state and block that request.
   Do not advance to a later turn to reach a convenient batch boundary. Retry from the
   saved state; successful prior replacements need not be regenerated or rolled back.

Thus selection depends on prior committed state plus current input, not just turn count
and configuration. The target is a ceiling, not a utilization objective. No additional
lower threshold or speculative compaction is introduced by this fix. A necessary parent
replacement can still change one range abruptly, and several replacements may be needed
for a large overflow; stability means no reversal or unrelated reshuffling, not identical
requests or a guarantee of one replacement per request.

For the simulator's illustrative defaults, the corrected sequence is:

| Completed turns | Verbatim turns | Total input tokens | Representation covering turn 244 |
| --- | --- | --- | --- |
| 300 | 9 | 31,250 | L1, turns 244–246 |
| 301 | 10 | 30,750 | L2, turns 244–252; newly saved |
| 302 | 11 | 31,750 | The same L2 summary |
| 303 | 9 | 30,500 | The same L2 summary |
| 304 | 10 | 31,500 | The same L2 summary |
| 305 | 8 | 30,250 | The same L2 summary |

For an actual engine, persist the selection with the chat/branch revision, cutoff source
identity, source revisions, summary dependencies and effective strategy configuration.
At commit, verify the source and selection revisions still match the preparation job;
save the result and switch selected coverage in one recoverable transaction. A restart
loads this selection rather than rebuilding it from token totals. Physical limit checks,
actual token measurement, and source validation remain required. The simulator provides
immutable in-memory checkpoints and deterministic transitions; it does not implement
production persistence, concurrent jobs, actual text generation, or revision repair.

`experiments/compaction/compaction_model.py` contains the UI-independent reference model. `advance(state,
settings)` appends one synthetic completed turn and prepares from the supplied checkpoint;
`prepare(state, settings)` retries/recalculates the existing representation without
appending. Its final state may be blocked, so callers must check the budget before
generation or another append. `Replay` merely stores those transitions for inspection.
`simulate(n, settings)` follows the same sequential path from an empty chat. Preparing
an imported `State(n)` directly is still available explicitly, but is not equivalent to
having generated every preceding request successfully.

Edits, deletion, branches, and explicit restoration can require different selections;
their detailed policies remain open. Moving backward in the visualizer inspects a saved
earlier snapshot. It does not demote the current state of a live chat. Changing visualizer
settings restarts the experiment; this is not a live-chat settings migration policy.

## Choosing a summary level: recommended candidate policy

The user has requested a decision function, not accepted a specific ranking formula. The following is a candidate to discuss and validate, applied only to the committed selection described above. Its token shares and retained counts are recommendations, not existing requirements.

Separate the **trigger** from **selection**: exceeding the total working target triggers compaction; the relative token occupancy of summary levels chooses which eligible batch to promote. A level exceeding its suggested share does not trigger work while the complete request fits.

Let `S` be the tokens available to all active summaries after required non-summary input and the actual remaining verbatim tail. Let `U_k` be the tokens currently occupied by active level-`k` summaries, excluding saved inactive children. If `S <= 0` and older history still requires input space, report insufficient capacity instead of evaluating allocation ratios. For positive `S`, one possible preference assigns half the pool to level 1, one quarter to level 2, one eighth to level 3, and so on: `A_k = S / 2^k`. These are soft allowances: unused capacity is shared, and no layer is padded or compacted merely to match its allowance. The geometric weighting is illustrative, not an accepted default.

At each promotion step:

1. For each level, consider its oldest complete contiguous batch of active summaries, using that level's configured promotion batch size. Exact settings for these group sizes remain open; do not silently vary a configured size.
2. Apply any explicit retained-detail floor before ranking candidates. Recommended for discussion: keep a minimum number `R_k` of the newest active summaries at each level, so a candidate needs at least its full batch plus `R_k` summaries. A possible floor is one complete promotion batch; the value and whether this guarantee applies to every level remain open. Soft shares alone do not guarantee that a recent layer remains populated.
3. Among eligible levels, choose the greatest `U_k / A_k`; on a tie, prefer the higher level, which represents older history under the chronological ordering. Always select that level's oldest batch, never its newest summaries.
4. Reuse a valid saved parent if available; otherwise generate a replacement. Activate it only after verifying current dependencies and useful net token savings. Retain the children. Recompute occupancy and total request size after replacement, stopping as soon as the request fits. A non-shrinking result does not solve overflow; bounded retry or alternative-candidate behavior remains to be defined.

For `S = 6,000`, the illustrative soft allowances are 3,000 tokens for level 1, 1,500 for level 2, and 750 for level 3. The remaining allowance is for deeper levels, but may be used by existing levels while the total request fits. Assuming complete eligible batches and sufficient retained detail:

| Active level-1 tokens | Level-2 tokens | Level-3 tokens | Total summary tokens | Highest pressure | Proposed next promotion |
| --- | --- | --- | --- | --- | --- |
| 4,200 | 1,600 | 500 | 6,300 | Level 1: `1.40` | Oldest level-1 batch to level 2 |
| 2,800 | 3,000 | 500 | 6,300 | Level 2: `2.00` | Oldest level-2 batch to level 3 |

This rule lets level 2 be promoted while level 1 still exists, instead of exhausting each lower layer first. Counts determine whether a full batch is eligible; actual tokens determine its layer's pressure. A deeper candidate can be ineligible despite high pressure if it lacks a full batch or would consume protected recent summaries.

The tradeoff is explicit: protecting recent summary detail can make a request impossible under the chosen target even when further compression would technically fit. If a retained-detail floor is accepted, no eligible candidate means generation must fail rather than silently break that floor. Whether to impose such a hard floor or use soft preference alone is unresolved. Occupancy is a predictable allocation heuristic, not a measurement or guarantee of semantic summary quality. Changing summary lengths can change which level is selected; each successful replacement must be remeasured.

## Failure and budget behavior: recommendations

Only a successfully saved, current summary can replace its source turns. If summarization fails, retain the existing representation; do not mark turns archived merely because the request exceeds its budget.

If the next request cannot fit without compaction, preparation must finish or an explicit recovery choice must be made before sending that request. Proactive background work may be possible while the current representation still fits. Pending work must not create duplicate batches, and edits or deletions must prevent obsolete results from becoming active.

A turn count is not a token budget. The protected minimum tail, pending input, and fixed prompt content may exceed the working target even without older memory; fixed batching can require retaining additional verbatim turns. Failure in these cases is an accepted rule. The error should show the required input and target so the user can explicitly adjust settings or content. The precise recovery controls remain open.

## Deletion and restoring detail: under discussion

The user proposed restoring archived turns after deletion and retaining lower summaries after promotion so recent context can regain detail. The subsequent budget-driven direction supersedes both an automatic restoration target of `L + B - 1` and fixed age thresholds for each summary level. How to spend newly freed capacity on restored representations remains open; it should be reconciled with the preference for recent verbatim history and the minimum tail.

Recommended distinction: deleting a source invalidates dependent summaries for the current history; merely returning surviving source turns to verbatim representation need not invalidate their saved summaries. Valid inactive summaries may be reusable if their source identities, revisions, and relevant summarization settings still match. Never inject a saved parent alongside children or original turns covering the same history. Manual-summary retention and reuse require the authority decisions discussed below.

Deleting the last `N` turns returns to an earlier transcript prefix, but reproducing exactly the former context representation is not guaranteed under adaptive budgeting, changed prompt content, or changed settings. Deleting turns from the middle produces an altered history and requires affected coverage to be repaired. Any summary that read deleted turns as auxiliary input is also affected, even if its nominal coverage survives.

## Edits and dependency repair: recommendations

Keep two concepts distinct:

- **Representation:** a turn is verbatim or archived.
- **Freshness:** a summary is current, out of date, being repaired, or awaiting review.

An archived turn remains archived after an edit, but its replacement memory is visibly out of date. It should not silently reappear alongside an old summary in model input.

Track the actual source identities and revisions used by every summary. An edit marks its direct summary and all dependent summaries out of date. Multiple edits can accumulate into one repair against the last incorporated source revisions. A manual summary edit likewise marks its dependents out of date.

Clearing an archived part is a source edit even though the turn remains complete. Its former content must be considered removed during memory repair. Deleting an entire archived turn likewise changes source coverage and invalidates dependent memory. Neighboring turns retain their own contents and identities; displayed turn numbers are not source identities. A completed turn with both parts blank still belongs to its source batch, but a summary should not invent events to fill it. Handling an entirely blank batch requires a defined empty-coverage result; the exact representation remains open.

Repair from lower layers upward. If a first-layer summary changes, use its old and new revisions to repair its parent, continuing through the affected dependencies. Retain lower summaries and prior revisions even when only a higher summary is currently sent to the model; they are useful for inspection, diffs, and repair. Revision retention details remain open.

When repairing, verify both source revisions and the existing summary revision before saving. A background result must not overwrite a user's newer summary edit or incorporate a superseded message edit. Keep the previous usable memory revision until a coherent replacement for the affected active coverage is ready. Unaffected ranges can remain in use. The context preview should identify exactly which revisions were sent.

To keep repair local, prefer a summary derived only from its declared source batch. If it also reads earlier summaries or recent turns for interpretation, those inputs are real dependencies and must be tracked. For example, editing a recent turn would no longer be independent of memory if a summary had already consulted it. This would weaken the proposed freely editable tail and should be an explicit design choice.

Recommended default for discussion: pause new roleplay generation when active memory is out of date, and offer repair first. An explicit option to continue with stale memory is an alternative, with a visible indication in the request preview. Neither policy is accepted yet; stale memory must not silently appear current.

## Manual summaries and diff-based repair

Diff-based revision is a useful starting point, but it cannot guarantee preservation of intent or semantic completeness. A small source edit can require a large narrative correction, while a repair model can accidentally remove unrelated manual details.

Example: the user changes “Mira gave Leon the key” to “Mira kept the key.” Memory repair should update who holds the key and any derived claim that Leon can enter the vault. Merely replacing the sentence about the handoff may leave the summary internally inconsistent.

Recommended repair input:

- The current summary, including manual edits, as the revision baseline.
- The source changes since the revisions that summary last incorporated, including additions and removals.
- The complete current source batch, where it fits, so facts omitted from the old summary can be reconsidered and consequences understood. At higher layers this means the current child summaries.
- Any explicit user instructions about facts or wording that should be retained.

A diff alone can miss relevant context. If a batch is too large for this repair input, the repair method needs an explicit budget policy; it must not silently omit sources while claiming a complete repair.

Recommended user controls are **Revise existing summary** and **Rebuild from current sources**. The former aims to retain editorial work; the latter can recover from a poor or repeatedly patched summary but may discard manual additions. Preserve previous summary versions and make the proposed textual changes inspectable and reversible.

For manually edited or entirely handwritten summaries, recommend reviewing the candidate before replacement. Automatically applying repairs to untouched model-generated summaries could remain a separate policy.

An entirely handwritten replacement summary still needs a declared source range or set of child summaries. Otherwise the system cannot know which message edits affect it or which history it replaces. A freestanding author note without source coverage is additional prompt material, not automatically a replacement for conversation history.

The hardest unresolved decision is **authority when sources and manual content conflict**. Suppose a summary manually says “Mira secretly kept a duplicate key,” but no source turn establishes it. The system cannot infer whether this is intended canon, a correction, or an accidental claim. Recommended behavior is to preserve unrelated manual additions and flag direct conflicts for review. Explicitly protected author facts could help later, but would add another concept and are not part of the accepted scope.

## Limits of rewriting history

Repairing summaries makes memory reflect the edited sources; it does not rewrite later transcript messages. If a later unchanged turn says Leon opens the vault with the key, changing the earlier handoff can leave a contradiction in the transcript itself. That later summary may remain structurally current because its own sources did not change.

Distinguish two promises: tracking source coverage and freshness is a structural property; reconciling the meaning of an altered story is a semantic task. The user may need to edit later turns or choose a different continuation. Automatic continuity checking or rewriting is not implied by this proposal.

Likewise, a higher-layer repair can only use details retained in its sources. Diff-based revision does not make recursive summaries lossless.

## Remaining decisions and suggested checks

Open decisions include conversion of irregular imported history into the accepted turn model, accepting partial or empty generated responses, outgoing representation of intentionally blank parts, entirely blank summary batches, budget-based warnings, numeric batch defaults, summary output targets, higher-layer grouping and promotion selection, soft layer weights versus hard retained-detail floors, operational headroom, detail restoration after deletion, proactive background preparation, generation with stale memory, manual-summary authority and review, revision retention, and changing settings after summaries exist. First-layer batches are fixed at the user-selected size and smaller boundary batches are rejected. Target/physical limit separation and generation failure when required input cannot fit are settled. Insertions, whole-turn deletions, and branches need detailed rules for changed membership and coverage, beyond ordinary text-edit diffs; deletion granularity itself is settled.

Before implementation is considered dependable, use synthetic or copied chats to check:

- A fresh chat remaining fully verbatim until the planned request exceeds its working target, including pending user input and non-history content, even when the model's physical window is much larger.
- Small successive compactions stopping as soon as the request fits, preserving more than `L` turns when capacity permits.
- Promotion beginning only when no complete first-layer batch remains eligible and the request still exceeds its working target; residual verbatim turns remain included.
- The proposed level-selection rule choosing level 2 over level 1 when its relative token pressure is higher, with a valid full batch, and preserving any explicitly adopted recent-summary floor.
- Free editing of the unsummarized tail and candidate batch without invalidating unrelated memory.
- Clearing either or both parts of a completed turn without reopening it, changing its count, or moving neighboring content; distinguish this from a pending response after failure or cancellation.
- Clearing archived content or deleting a whole archived turn and repairing dependent memory without retaining removed facts solely from the old summary.
- A failed summary under budget pressure, followed by a retry, with no missing or duplicate coverage.
- An archived edit propagating through several layers while unaffected summaries remain current.
- Several edits before repair and an edit during repair, including a simultaneous manual summary correction.
- A manual addition surviving revision, a conflicting manual fact being surfaced, and restoration of a previous summary version.
- A source edit whose narrative consequences are absent from the original summary, plus a contradictory later transcript turn.
- A protected-tail budget conflict, the explicit `L = 100`, `B = 3`, 102-turn failure case, a summary yielding insufficient savings, and a history/settings change that immediately requires compaction.
- Deletion of recent turns exposing valid retained lower layers, plus deletion through a summary's sources invalidating all affected dependencies.

These remain proposed end-to-end experiments for the application. The standalone
simulator's tests validate synthetic budgeting, structural coverage, and forward
selection stability; they do not validate actual model summaries, editing/repair,
durable transactions, or semantic quality.
