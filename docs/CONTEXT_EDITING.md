# Editable history and layered context

Date: 2026-10-16

Status: context-engine rules and editing discussion; durable compaction and targeted repair with review are implemented for local testing. A [standalone synthetic visualizer](VISUALIZER.md) remains the budgeting reference and does not itself implement editing or repair. This document extends [CONCEPTS.md](../CONCEPTS.md). Accepted rules and implemented policies are distinguished from future proposals. Worked examples do not establish optimal numerical defaults.

The later accepted prompt-control decision on 2026-10-17 scopes the managed-history rules below: they apply when an enabled Summary marker is present. Summaries are never injected implicitly. Without Summary, Messages uses recent whole original turns within the complete input limit, independently of the saved summary cutoff; old turns can be omitted without summarization. No summary work runs, saved memory remains intact, and unused stale memory does not block roleplay. Missing Messages sends no turns. See [the current prompt rules](../CONCEPTS.md#prompt-preset).

## Accepted turn editing and deletion rules

A turn contains a user-input part and an assistant-response part. Historical turns must be complete; only the latest turn may await a completed response. A pending turn blocks submission of another turn while it remains unresolved. Only a whole turn can be deleted; either part can be edited independently. No deletion merges surviving content into neighboring turns.

An intentional edit to an empty string is valid. Clearing either or both parts preserves the turn's identity, membership, and completed status. A completed turn with blank content still counts as one completed turn. A missing or unfinished response is a separate state: empty text alone neither completes a pending turn nor reopens a completed one.

These rules preserve exchange boundaries, not semantic action–reaction balance. A blank part supplies no story content, and clearing it may leave later story events without their original explanation.

## Response variants and freshness

Latest-turn regeneration creates a saved response alternative using the current setup and that turn's saved input, excluding its existing response. The selected response stays committed until success. Other variants can be previewed without changing the transcript and explicitly selected even after their turn becomes archived. Later turns are never rewritten. Variant storage also holds copied greetings as ordinary single responses; alternate card greetings remain inactive.

Selection/edit revisions advance monotonically for concurrency, while summary sources identify saved response content independently. A summary built from A becomes stale when a different B is selected. Selecting unchanged A again restores freshness without a model request or modifying the summary, provided its other sources and dependencies still match. Viewing B alone has no effect. A repair approved against B establishes a new incorporated baseline; selecting A afterwards does not make that repaired summary current. Editing A changes its content provenance. Returning to A cannot clear unrelated stale sources, prior context, corrections or higher-layer revisions.

Regeneration owns a temporary selection and cutoff, reusing the existing engine for budget planning and saving useful earlier replacements. Its pending view excludes the target response from summary sources, children, prior inputs and correction dependencies. A parent crossing that endpoint is expanded through eligible saved sources rather than sliced. A direct manual correction containing the response requires explicit resolution before regeneration. The live selection/cutoff remains unchanged, including after cancellation/failure. Saved preparation history remains inspectable. If the latest response was already archived, accepting its new variant can stale live memory; selecting its unchanged original restores the original baseline as above.

## Current user-defined direction

A **turn** follows the accepted rules above. The user selects a **target input context size**, a minimum verbatim tail length `L`, and a fixed first-layer batch size `B`. The target, such as approximately 32K tokens, is distinct from the model's **maximum available context**. It is a strict working limit even if the model could accept more input. The user's motivation is response quality; no universal quality claim or optimal target is established here. Account for prompt text, character, persona, scenario, pending input, and other non-history content before allocating the remaining target capacity to history. Recent turns remain verbatim and editable without affecting existing summaries, provided summaries do not read them as additional dependencies.

Keep the entire conversation verbatim while it fits the target. When the next request would exceed it, summarize the oldest eligible complete batch, retaining more than `L` turns whenever possible. A batch must contain exactly `B` completed turns and leave at least `L` verbatim. Smaller boundary batches are explicitly rejected. If the minimum tail, or the longer residual tail imposed by fixed batching, cannot fit together with required non-summary input, generation fails. Do not silently change `L`, change `B`, or use the model's spare capacity beyond the working target.

When no complete first-layer batch is eligible and the request still does not fit, promotion of existing summaries may free space, provided the required non-summary input and remaining verbatim tail can fit. The accepted initial decision function below chooses which summary level to promote so recent summaries retain finer detail instead of all level-1 summaries eventually being consumed. Its real-world quality remains to be validated. Fixed summary-age thresholds are rejected. The former automatic `L + B` compaction trigger and its turn countdown are superseded: `L + B` is now an eligibility boundary, while exceeding the working target triggers compaction.

Successfully summarized messages are marked **archived**. They remain stored, readable, and editable, but are represented through summaries rather than sent verbatim to the roleplay model. An edit to archived material marks summaries derived from it as out of date, then propagates to higher summaries derived from those summaries. The user can regenerate the affected memory.

On 2026-10-17 the user selected targeted repair with review. The first implementation gives the model the existing summary and previous/current source text, asking for a targeted revision. At the first layer sources are turns; at higher layers they are lower-layer summaries. It repairs one affected dependency at a time from the bottom upward and waits for approval before its replacement becomes authoritative. Review can correct the candidate's text. Preservation of manual intent remains a semantic question; a smaller diff-only request remains a possible refinement.

The subsequent accepted workflow uses **Repair summaries** to open a continuous review dialog. **Approve & Next** saves the edited candidate before generating the next required dependency; the last button is **Approve & Finish**. **Regenerate** requests a replacement without losing a valid existing candidate if the request fails. **Close** cancels in-flight work and discards the unapproved candidate and edits, retaining all approved repairs. Reopening generates a fresh candidate from remaining work. No draft saving or automatic retries are introduced. The later exact-unchanged policy below supersedes mandatory review for every result. The queue includes current child/prior/editorial dependencies needed by selected memory and retained corrections, rather than all stale saved versions, and displays approved/remaining counts.

The subsequent minimal-repair decision on 2026-10-17 adds a separate editable repair prompt. Supply the existing summary and before/after revisions of every changed consumed item, including original earlier-memory dependencies, rather than asking extraction/compression to rewrite a full batch. Preserve unaffected text exactly. Changed inputs must fit together; fail clearly rather than omitting one. Exactly unchanged model output saves automatically only with a known original baseline and unchanged ordered coverage/dependency membership. A missing old turn-text baseline or structural change retains review. Save the current full first-layer source baseline locally for future repairs without putting unchanged source text into the provider body.

Within explicit repair, revalidate a summary without a model only when every consumed input's text and structure is unchanged. This updates provenance in a saved new version, preserves old versions/manual corrections and records **unchanged inputs · no model request** separately from **model checked · unchanged**. Every direct consumer of changed A must still be checked: an unchanged B only stops propagation along paths that consume B and no other changed content. Conservative staleness is not cleared globally, and roleplay remains blocked until required memory is current. Exact equality is not semantic validation of the model's decision to omit a changed detail. Real-model minimality and recall remain unverified.

Matching prose panes align unchanged text and highlight textual removals/additions, with the previous version read-only and the candidate editable. They share scrolling and offer difference navigation and optional unchanged-line collapsing. Expandable comparisons show the previous/current sources and earlier memory actually captured in saved requests; missing historical source text is identified explicitly. Phone layouts use a unified comparison. Matching concerns text, not narrative meaning. Structural freshness still does not establish semantic consistency or preserve every author correction.

## Budget allocation and cutoff: proposed mechanism

The limits, fixed first-layer batching, and failure conditions above are user-defined constraints. The preparation mechanism below is recommended for discussion, not a finalized implementation specification.

Count completed turns in the currently selected continuation. Protect the newest `L` completed turns, or all completed turns if fewer exist. The pending turn's user input is additional required input, not another completed turn. Intentionally blank completed turns still count toward `L`.

1. Read the target input size and separately validate the Connection's physical input/context and output limits. For a combined input/output window, reserve output space against that physical window. Do not subtract output again from the input-only working target or silently increase the target to use spare physical capacity.
2. Account for all non-history request content, including resolved prompt blocks and markers, pending user input, and message-format overhead. Content described as constant can still change between requests, so recalculate when its inputs change. The remainder is the shared history budget; the proposed soft layer allowances below guide selection without reserving otherwise unused space.
3. Load the last committed selection of summaries and verbatim cutoff, append new input, and measure that representation. Do not rebuild a summary tree from the current transcript length. If it fits, keep the exact existing selection even if capacity remains unused; on a fresh chat this means all history remains verbatim.
4. If it does not fit and at least `B` completed verbatim turns lie outside the minimum tail, summarize exactly the oldest `B`. Save and validate its replacement, then remeasure. Repeat only as needed, stopping as soon as the request fits.
5. If no complete first-layer batch remains, include all residual verbatim turns when calculating the space available to summaries. If this verbatim tail plus required non-summary input already exceeds the target, fail generation. Otherwise select a summary-promotion candidate using the accepted initial decision function below. Retain its children, select only one representation of their coverage, and remeasure. Repeat only as needed.
6. Validate the fully assembled request against both the working target and physical limits before generation. If available compaction cannot reduce the request sufficiently, fail with an explanation; do not silently change batching, violate the minimum tail, exceed the target, or drop history.

For illustration, a planned request of 32,800 tokens exceeds a 32,000-token input ceiling. Replacing an eligible oldest batch occupying 2,000 tokens with a summary occupying 350 tokens reduces the request to approximately 31,150 tokens. Stop there even if far more than `L` turns remain verbatim. These figures illustrate net savings, not fixed batch or summary sizes; final request measurement includes formatting overhead.

Summary size consumes the same history budget as verbatim turns. A proposed replacement must provide useful net token savings before it can solve an overflow; requesting a short summary does not guarantee that it will be short enough. On 2026-10-17 the user requested retaining the visualizer's summary-size control as a real output target. Its enforcement, minimum useful summary detail, and behavior when a batch cannot be usefully reduced remain open.

`B` is fixed. With `L = 100`, `B = 3`, and 102 completed verbatim turns, none can be summarized in a new first-layer batch. If these 102 turns plus required non-summary input exceed the target, generation fails. If that input fits but the addition of summaries causes overflow, summary promotion can still help. The summary budget must be calculated after the actual 102-turn tail, not an imagined 100-turn tail. With 103 verbatim turns, the oldest three are eligible when token pressure requires compaction.

Any preview should identify candidate source turns by stable identity. A reliable fixed countdown in future turns is no longer implied: their token lengths are unknown. Headroom or proactive processing could reduce waiting, but their policies are undecided and must not silently replace the user's working target with a substantially smaller one.

## Stable selection across requests: accepted direction and executable contract

The user requires successive requests to retain a similar historical representation,
without summaries moving back and forth between levels as the verbatim tail grows
and is compacted. Unused target capacity is preferable to that oscillation. This is
an accepted direction. Promotion weights were subsequently accepted on 2026-10-17;
numerical retained-count defaults and an additional headroom threshold remain open.

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

## Choosing a summary level: accepted initial policy

On 2026-10-17 the user accepted the visualizer's geometric-pressure ranking as the initial application policy, alongside its configurable promotion group and retained-summary floor. Apply it only to the committed selection described above, using actual active-summary token totals. Numerical defaults remain open and real-world summarization quality remains unverified.

Separate the **trigger** from **selection**: exceeding the total working target triggers compaction; the relative token occupancy of summary levels chooses which eligible batch to promote. A level exceeding its suggested share does not trigger work while the complete request fits.

Let `S` be the tokens available to all active summaries after required non-summary input and the actual remaining verbatim tail. Let `U_k` be the tokens currently occupied by active level-`k` summaries, excluding saved inactive children. If `S <= 0` and older history still requires input space, report insufficient capacity instead of evaluating allocation ratios. For positive `S`, assign half the pool to level 1, one quarter to level 2, one eighth to level 3, and so on: `A_k = S / 2^k`. These are soft allowances: unused capacity is shared, and no layer is padded or compacted merely to match its allowance. This geometric weighting is the accepted initial heuristic.

At each promotion step:

1. For each level, consider its oldest complete contiguous batch of active summaries, using the configured promotion group size carried over from the visualizer. Numerical defaults and any future per-level overrides remain open; do not silently vary a configured size.
2. Apply the configured retained-detail floor before ranking candidates: keep the newest active summaries at each source level, so a candidate needs at least its full group plus that retained count. The visualizer uses one configurable count across levels, including zero for no floor. Numerical application defaults remain open. Soft shares alone do not guarantee that a recent layer remains populated.
3. Among eligible levels, choose the greatest `U_k / A_k`; on a tie, prefer the higher level, which represents older history under the chronological ordering. Always select that level's oldest batch, never its newest summaries.
4. Reuse a valid saved parent if available; otherwise generate a replacement. Activate it only after verifying current dependencies and useful net token savings. Retain the children. Recompute occupancy and total request size after replacement, stopping as soon as the request fits. A non-shrinking result does not solve overflow; bounded retry or alternative-candidate behavior remains to be defined.

For `S = 6,000`, the illustrative soft allowances are 3,000 tokens for level 1, 1,500 for level 2, and 750 for level 3. The remaining allowance is for deeper levels, but may be used by existing levels while the total request fits. Assuming complete eligible batches and sufficient retained detail:

| Active level-1 tokens | Level-2 tokens | Level-3 tokens | Total summary tokens | Highest pressure | Proposed next promotion |
| --- | --- | --- | --- | --- | --- |
| 4,200 | 1,600 | 500 | 6,300 | Level 1: `1.40` | Oldest level-1 batch to level 2 |
| 2,800 | 3,000 | 500 | 6,300 | Level 2: `2.00` | Oldest level-2 batch to level 3 |

This rule lets level 2 be promoted while level 1 still exists, instead of exhausting each lower layer first. Counts determine whether a full batch is eligible; actual tokens determine its layer's pressure. A deeper candidate can be ineligible despite high pressure if it lacks a full batch or would consume protected recent summaries.

Unequal summary lengths are supported by summing actual selected output sizes for `U_k`. A large recent summary can raise its level's pressure while remaining protected; ranking still promotes only the oldest eligible group. For a given step `S` is common to every level, so ranking is equivalent to comparing `U_k * 2^k`; changing the pool alone does not change the relative ordering. A chosen group's eventual savings are unknown until its replacement is generated and measured. Reject unusable output before selection, validate net savings, then recompute the complete input after every commit. Real model tests must evaluate factual/detail retention separately from arithmetic correctness.

The tradeoff is explicit: protecting recent summary detail can make a request impossible under the chosen target even when further compression would technically fit. No eligible candidate means generation must fail rather than silently break the configured floor; zero permits no hard floor. Occupancy is a predictable allocation heuristic, not a measurement or guarantee of semantic summary quality. Changing summary lengths can change which level is selected; each successful replacement must be remeasured.

## Failure and budget behavior: recommendations

Only a successfully saved, current summary can replace its source turns. If summarization fails, retain the existing representation; do not mark turns archived merely because the request exceeds its budget.

If the next request cannot fit without compaction, preparation must finish or an explicit recovery choice must be made before sending that request. Proactive background work may be possible while the current representation still fits. Pending work must not create duplicate batches, and edits or deletions must prevent obsolete results from becoming active.

A turn count is not a token budget. The protected minimum tail, pending input, and fixed prompt content may exceed the working target even without older memory; fixed batching can require retaining additional verbatim turns. Failure in these cases is an accepted rule. The error should show the required input and target so the user can explicitly adjust settings or content. The precise recovery controls remain open.

## Deletion and restoring detail: under discussion

The user refined the initial restore action into **Clear memory** on 2026-10-17: delete every layer, summary version, review candidate and preparation record for this chat, returning all original turns to verbatim. Original turns, the context preset selection and saved roleplay requests remain unchanged. This supersedes the initial restore-only behavior that retained saved summaries. Deleting archived sources instead uses targeted repair with review. These implemented controls do not settle automatic partial restoration or selection reuse after broader strategy changes.

The user proposed restoring archived turns after deletion and retaining lower summaries after promotion so recent context can regain detail. The subsequent budget-driven direction supersedes both an automatic restoration target of `L + B - 1` and fixed age thresholds for each summary level. The later manual preparation decision below defines saved-tree reuse; automatic restoration remains open.

Recommended distinction: deleting a source invalidates dependent summaries for the current history; merely returning surviving source turns to verbatim representation need not invalidate their saved summaries. Valid inactive summaries may be reusable if their source identities, revisions, and relevant summarization settings still match. Never inject a saved parent alongside children or original turns covering the same history. Manual-summary retention and reuse require the authority decisions discussed below.

Deleting the last `N` turns returns to an earlier transcript prefix, but reproducing exactly the former context representation is not guaranteed under adaptive budgeting, changed prompt content, or changed settings. Deleting turns from the middle produces an altered history and requires affected coverage to be repaired. Any summary that read deleted turns as auxiliary input is also affected, even if its nominal coverage survives.

## Unified manual preparation: accepted and implemented 2026-10-17

The user initially selected a manual Refresh action, then requested merging it into Prepare chat. An explicit Prepare click reselects locally using saved settings, original turns and approved fresh summaries, even when current input fits. Restore detail from the newest history backward, reuse exact oldest first-layer batches under pressure, then apply ordinary geometric-pressure ranking, chronological groups and retained floors among saved eligible parents. Older selected spans must be at least as compact as newer spans; a blocked recent range cannot be bypassed to expand an older middle range. Direct manual edits remain represented at their coverage, including retained identities outside the selected tree as refined below. Generated parents may expand into children retaining the corrected summary. A directly edited parent stays represented instead of reverting to uncorrected children or original turns. Prior-context dependencies still participate in freshness and repair, but do not pin later history during reselection. This supersedes the initial protection of all transitive correction consumers. Coverage before the latest direct correction remains an archived prefix; its newer history can return to original turns. The interface distinguishes manually edited boxes with an amber accent, legend, tooltip and accessible label, alongside selection and freshness status. Stale selected memory and unresolved repair candidates block preparation. Retained editorial work cannot be bypassed; stale or incompatible corrections require reconciliation as described below.

If the saved-only pass fits, commit its selection without model requests. If it cannot produce a different fit but the committed selection already fits, retain that selection without generating summaries merely to rebalance. If no saved-only plan fits, continue from committed state only when its completed-tail boundary is valid. Otherwise retain a restored valid boundary and let ordinary preparation create missing compression. Restore the configured minimum completed tail before optimizing detail; pending input is additional required content and never counts as a completed turn. If the latest direct correction itself prevents that minimum, fail without changing memory and name the correction range and conflicting minimum. Do not redirect the user to the same Prepare action as recovery from that conflict. Report restoration limits caused by manual corrections or unavailable saved groups. At each ordinary compaction step, reuse an exact fresh approved saved batch/parent when it provides complete-request savings; generate a replacement only when that step has no usable saved replacement. Reuse requires exact coverage and child revisions plus fresh prior dependencies, and never adds a duplicate summary record. Resolve the summarization Connection only when an actual request is necessary. Failures retain committed progress; they do not silently change batching, limits or source membership.

Manual reselection and its before/after report are saved atomically with the preparation job. Reused steps have a saved result reference and no model request; their historical input/output selections and token counts remain inspectable. They must not shadow the summary's original model request, which repair needs for previous source text. Jobs record reused/new summary counts and final input/verbatim totals. After compaction steps, manual preparation performs a final saved-only pass to incorporate newly available groups before completion. A changed final pass is saved with the completed job in the same transaction as its selection. History navigation includes initial/final selection passes and intervening summary steps, using original job turn membership. Retries are idempotent and repeated preparation against unchanged inputs preserves the selection without regenerating cached summaries. Existing Refresh history remains readable; there is no separate Refresh button.

Automatic preparation before a response and single-step preparation use the same exact saved-replacement checks, but do not restore detail or rebuild the selection. They advance only under pressure from the committed state. Automatic restoration triggers, branching and bulk deletion remain deferred.

## Saved correction authority and reconciliation

Accepted and implemented 2026-10-17, including gaps left after `2ceee82`:

- **History:** all approved versions remain inspectable. Only the latest approved revision per identity carries current authority. A surviving `manual` identity stays protected even when retained; identical historical text is not evidence that its manual flag should be removed. Empty tombstones and identities with no surviving coverage do not impose an inclusion obligation.
- **Freshness:** source-part revisions, children, prior context and reviewed editorial inputs determine staleness. Saving a correction preserves these links. Editing stale memory therefore leaves it stale and uses the edited text as its next repair baseline.
- **Representation:** selection is independent of editing and freshness. To replace any of a correction's surviving covered turns, selected summaries must reach its exact current approved revision through coverage children or reviewed `corrections` references. Prior-context references do not count. Original turns and an alternative identity derived from them do not implicitly contain an editorial addition.
- **Manual Prepare:** fresh compatible corrections can enter the saved selection without a model request. Tile the protected archived prefix from recent coverage backward with chronological levels, then apply ordinary fixed batches, pressure ranking, tails and limits. Preserve a compatible covering representation when finer saved boundaries are unavailable. A fallback or final selection pass must also represent every correction. A budget or minimum-tail conflict fails explicitly without bypassing protection.
- **Review:** repair visits stale current retained corrections and the dependencies required by them or selected memory, rather than every stale historical identity. A selected covering summary is the preferred reconciliation baseline. If correction boundaries cross selected children, use a compatible saved container and leave activation to explicit Prepare. Supply each overlapping corrected text and its identity/revision alongside the existing summary and source changes. New editorial membership is structural change: even identical output requires approval. Conflicting parent/child or alternate corrections are presented together; no identity wins by creation time, layer or selection alone.
- **Continuation:** automatic and single-step preparation do not restore retained coverage. They stop before an ordinary replacement could bypass a correction. Promotion can consume corrected summaries normally, with their text in the outgoing sources and exact provenance retained. Restoring detail later cannot expand past those corrections into uncorrected sources. A correction represented through a reviewed or generated parent need not remain verbatim in model input.

The existing narrowly defined repair shortcuts still apply when membership is unchanged: known, identical consumed inputs permit local revalidation; a known baseline and unchanged structure permit exact unchanged model output. Added reconciliation inputs always require review. Approval saves before dependent generation. Close/rejection discards unapproved work; cancellation, restart, stale revision and write failures preserve committed selections, retained text and approved progress. Restart never retries a model call automatically.

Direct summary saves use trimmed storage text for equality after ordinary chat revision, operation and latest-approved-version validation. An identical save writes nothing: no version, manual flag, dependent invalidation, selection change or revision bump. A changed save preserves the previous version and does not make source links current. This policy does not retroactively reinterpret existing flags.

Timeline overlaps occupy separate lanes, with selected/retained, fresh/stale and manual states stated independently. **Inspect saved summary** selects an identity by range/status; **Summary version** shows its approved versions. Old versions are read-only. Inspection identifies direct input representation, representation through a parent, disabled summaries, retained history or a correction awaiting reconciliation. Saving a retained correction never claims it has already entered model input. Saved preparation frames continue to describe historical selections, not a restore action.

These rules preserve editorial provenance structurally. They cannot establish whether a model retained a correction's meaning, reconciled contradictory canon correctly or preserved every narrative detail.

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

The implemented initial policy pauses new roleplay generation when selected memory is out of date and offers repair with review. There is no stale-memory continuation override. Edits are blocked while a model operation runs; edits while a candidate awaits review invalidate approval through the captured chat revision.

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

The initial policy required review for every repair candidate. The later accepted policy automatically saves exactly unchanged results with a known baseline and unchanged coverage/dependency membership; all changed text and structural changes still require review. Direct manual summary edits preserve old versions and invalidate dependents; they retain their source revisions rather than silently declaring changed sources current. Creating entirely handwritten summaries with new coverage remains outside this implementation.

An entirely handwritten replacement summary still needs a declared source range or set of child summaries. Otherwise the system cannot know which message edits affect it or which history it replaces. A freestanding author note without source coverage is additional prompt material, not automatically a replacement for conversation history.

The hardest unresolved decision is **authority when sources and manual content conflict**. Suppose a summary manually says “Mira secretly kept a duplicate key,” but no source turn establishes it. The system cannot infer whether this is intended canon, a correction, or an accidental claim. Recommended behavior is to preserve unrelated manual additions and flag direct conflicts for review. Explicitly protected author facts could help later, but would add another concept and are not part of the accepted scope.

## Limits of rewriting history

Repairing summaries makes memory reflect the edited sources; it does not rewrite later transcript messages. If a later unchanged turn says Leon opens the vault with the key, changing the earlier handoff can leave a contradiction in the transcript itself. That later summary may remain structurally current because its own sources did not change.

Distinguish two promises: tracking source coverage and freshness is a structural property; reconciling the meaning of an altered story is a semantic task. The user may need to edit later turns or choose a different continuation. Automatic continuity checking or rewriting is not implied by this proposal.

Likewise, a higher-layer repair can only use details retained in its sources. Diff-based revision does not make recursive summaries lossless.

## Remaining decisions and suggested checks

Open decisions include additional imported-history formats, accepting partial/empty generated responses, a more specific representation for entirely blank but present batches, budget warnings/headroom, quality tuning of numerical values and prompts, automatic partial detail restoration, proactive background preparation, any future stale-memory override, semantic authority for conflicting manual additions, and revision pruning. The initial implementation retains blank source membership, blocks unusable/non-shrinking results, uses a soft summary target, tracks bounded prior-context dependencies, requires repair review, retains versions and preserves selections when settings change. Fixed first-layer batches, promotion grouping/floors and geometric-pressure ranking are accepted. Target/physical limit separation and failure when required input cannot fit are settled. Archived deletion is repaired through changed membership; insertions and branches still require future rules.

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

The application now tests fixed batching/tails, unequal sizes, Python-reference parity,
selection stability, save-and-select rollback, interruption, stale-result rejection,
and targeted repair with review on synthetic sources. The standalone simulator still
tests only synthetic arithmetic and forward selection. Neither suite establishes
real-model semantic quality or preservation of every narrative detail.
