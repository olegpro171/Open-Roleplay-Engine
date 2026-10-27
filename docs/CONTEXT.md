# Memory, budgeting and repair contract

This is the current agent reference for managed coverage, preparation, corrections, repair and reference counting. [CONCEPTS.md](../CONCEPTS.md) owns turn/prompt semantics and [IMPLEMENTATION.md](../IMPLEMENTATION.md) owns module/operation boundaries. These rules apply with Summary enabled; Summary-off uses request-local recent whole turns and makes no memory calls.

## Measurement and limits

`src/core/tokens.ts` uses local `cl100k_base` for every model, with no model mappings, service, byte fallback, character divisor or provider-derived calibration. Encode each resolved message's actual text (special-looking strings as ordinary text), not its JSON escapes. Framing is 3 units plus 3 per message plus encoded role strings. This is a shared approximation, not an endpoint template guarantee. The bounded cache holds 512 entries and at most two million UTF-16 units, excluding individual texts over 100,000 units.

Use this counter for full input, allocations, summary labels/separators, promotion pressure, complete-request savings and summarizer source/prior-context windows. Model-text filtering precedes counting. Summary output size is a soft prompt target; measure actual output. Reserve summarizer output using its Connection limits.

Separate the input-only working target from physical context/input capacity and reserved output. Do not subtract output twice. Sending fits at target equality; the optional overshoot allowance permits only an excess strictly less than its threshold (default enabled, 100 tokens). Equality at the threshold prepares. Preparation and post-response checks aim for the target, not target plus allowance. Physical overflow fails independently and does not trigger preparation by itself. Required content cannot be silently truncated or guarantees reduced.

New saved request metadata records counting method/version, reference encoding, approximate framing, limits and `verified: false`. Keep old bodies, estimates and usage immutable, including historical model/fallback metadata. Endpoint usage stays attached to its exact attempt and may be unavailable. A changed estimate cannot automatically restore archived detail. Normal UI retains estimate wording; detailed technical metadata belongs in inspection, not repeated labels.

Previews/plans use authoritative full server assembly. Estimate-only projections contain no prose; full inspection loads on demand. Pending input, fixed blocks, eligible lore, notes, summaries and framing all count. Read-only inspection may show overflow/staleness without bypassing generation checks.

## Stable coverage and preparation

Persist the committed selection/cutoff separately from saved summary existence. Emit selected coverage in original conversation order, without overlapping parent/child/original representations or unexplained gaps. Restart loads that state; never rebuild it from transcript length or current token totals.

Protect the newest `L` completed turns, all pending input, and the fixed-batch residual. Intentionally blank completed turns count. Summarize exactly the oldest `B` eligible completed verbatim turns, only when a full batch remains outside the minimum tail. Smaller boundary batches are forbidden. Stop as soon as full input fits. For `L=100`, `B=3`, 102 verbatim completed turns provide no new first-layer batch; the actual 102-turn tail must fit, not an imagined 100-turn tail.

When no first-layer batch is eligible and input still overflows, promote only full contiguous oldest groups of selected summaries. Preserve the configured newest retained count per source level (zero allows no floor). Older selected spans must be at least as compact as newer spans; a promotion cannot make its range deeper than an older selected span.

For positive summary pool `S` after required non-summary input and actual tail, level `k` has soft allowance `A_k=S/2^k`. Rank eligible levels by selected token occupancy `U_k/A_k`, breaking ties toward the deeper level. `U_k` excludes inactive saved children. Take that level's oldest eligible group. Soft shares neither reserve/pad space nor trigger work on their own. Nonpositive capacity or no eligible candidate fails when required history cannot fit. Actual tokens, not summary count, determine pressure.

For each replacement, capture source/dependency/configuration/selection/operation revisions, assemble interpretive context, request outside the transaction, validate output and useful complete-request savings, then recheck and atomically save+select. Retain originals/lower summaries. A failed step retains the previous selection; later failure/cancellation retains completed steps. A non-shrinking output stops rather than silently excluding a batch.

Extraction and compression have separate editable conservative continuity prompts. Each batch is standalone; promotion rewrites the whole group rather than concatenating deltas. Supply at most three fitting preceding selected summaries as interpretive reference, tracking their revisions as dependencies but not extra coverage. Never include live lore/notes in narrative summarization. Facts, chronology, uncertainty and knowledge attribution are semantic goals, not validated guarantees.

Automatic preparation starts only on Send outside the sending allowance, or after a successful response/regeneration leaves complete saved input above target. Unsent next drafts are excluded from post-response checks. No chat-open/source/settings/variant/draft trigger exists. A successful response is committed independently of its follow-up job. Automatic and single-step work reuse exact fresh replacements but never restore detail to fill spare capacity.

## Explicit Prepare and saved reuse

Manual Prepare first reconsiders fresh approved saved representations, even when input fits. Restore recent detail backward, preserving chronological levels, protected tails and correction authority. A blocked recent range cannot be bypassed to expand older middle history. Use exact oldest batches and geometric-pressure eligible saved parents; do not generate solely to rebalance an already fitting committed selection.

A fitting saved plan ends with no provider call. If no alternate saved fit exists but the committed selection fits, retain it. Otherwise restore a valid completed-tail boundary before ordinary compression and reuse each valid exact saved replacement before generating a missing one. A pending turn never counts toward the tail floor. A direct correction preventing that floor fails with its range and the conflicting minimum, without mutation or redirecting to the same failed Prepare action. Never fall back to an incompatible old cutoff.

Reuse needs exact coverage/child revisions, fresh prior/editorial dependencies and useful complete-input savings. It creates no duplicate summary. Resolve a summarization Connection only when a model call is needed; null means the current chat Connection. Manually edited parents cannot expand into uncorrected children/originals; generated parents can expand while retaining their corrected children. Prior-context links control freshness, not coverage authority.

Save reselection plus before/after state and job atomically. Reused steps retain a result reference and no request body, never shadowing the summary's original request needed for provenance. Record reused/generated counts and final measured input/tail. After compaction steps, run a final saved-only pass and save changed selection/history with completion. Repeating unchanged Prepare stays stable. Historical Refresh records remain inspectable without a separate action; historical frames keep original turn membership and are inspection, not restoration.

## Manual correction authority

Protect the latest approved manual revision of each identity with surviving coverage, including retained alternatives outside the selected tree. Historical versions are inspection, not extra obligations. Empty tombstones/identities without surviving coverage have no inclusion obligation. Do not infer old manual flags away from text equality.

Every selected replacement touching a correction must carry its exact current revision through coverage children or explicitly reviewed `corrections` references. `prior` does not carry authority. Alternative identities or original sources do not implicitly contain an editorial addition. Ordinary planning/reuse, manual reselection, final passes, request assembly and commit validation share this rule.

Stale retained corrections and required current dependencies enter repair. Reconcile against a selected covering summary when possible, otherwise a compatible saved container whose activation waits for manual Prepare. Supply all overlapping corrected identities/text with source changes. New editorial membership is structural change: even identical model text needs review. No identity wins by creation time/layer/selection. Automatic/single-step work stop rather than bypass a correction; promotion may represent it via a parent with exact provenance, without guaranteeing verbatim preservation.

Direct saves compare trimmed storage text after revision/idle/latest-approved checks. Identical saves do not write a version, set manual flags, invalidate dependents, change selection or advance revisions. Changed saves preserve old versions and source links; editing stale memory leaves it stale and supplies the edited baseline for repair. Editing a retained summary does not claim activation in model input.

## Freshness and response variants

Track actual consumed turn parts, child summaries, original earlier-context and editorial revisions. A source edit invalidates every direct consumer and its dependents, including higher layers and summaries outside nominal coverage. Clearing an archived part retains turn membership but removes its prior content; deleting a whole turn changes structure. Never use displayed turn numbers as identities or silently restore edited originals alongside stale summaries.

Concurrency revisions advance monotonically; source-content provenance can return to an unchanged saved response A after A→B→A. That restores freshness only if all other sources/dependencies still match. A repair against B establishes a new baseline; selecting A cannot clear unrelated changes. Regeneration uses the temporary selection described in IMPLEMENTATION; it never rewrites later transcript turns.

## Reviewed repair

Repair explicitly visits current required child/prior/editorial dependencies and retained corrections bottom-up, not every stale historical version. Selected stale memory blocks roleplay; unused stale alternatives do not by themselves. Use a separate editable minimal-repair prompt with the existing summary and complete before/after pairs for all changed consumed inputs. Retain original earlier-context membership; do not select additional prior memory. Changed input must fit together or fail before transport. Persist complete local original first-layer baselines outside provider bodies for subsequent repairs; unknown historical baselines remain unknown.

Changed text, changed coverage/membership, missing baselines and new correction inputs require review. Candidates are editable. Approve & Next saves before generating the next dependent; Approve & Finish completes. Regenerate retains a still-valid candidate if the replacement request fails, but never makes an obsolete candidate approvable. Close cancels work and discards unapproved candidate/local edits, keeping approved progress. Reopen generates fresh remaining work; no draft persistence or automatic paid repair retries.

Within explicit repair only, complete identical consumed text/structure permits transactional local revalidation as a new approved version, preserving flags/old versions/provenance. Exactly identical model output may auto-save only with known baseline and unchanged ordered coverage/dependencies. Record `inputs_unchanged` separately from `model_unchanged`. Every direct consumer of changed A must still be checked even when B returned unchanged. Propagation stops through B only where a dependent's other consumed inputs are also unchanged. Never clear downstream staleness indiscriminately.

Reviews expose old/new prose and the actual incorporated before/after source/prior inputs. Matching/highlighting is textual, not semantic. Rejected heuristic output can be inspected read-only but cannot be approved. Stream phases reflect observed Connecting/Reasoning/Generating activity, not inferred encrypted provider state. Saved failed output is distinct from discardable candidates.

Repair does not rewrite later transcript contradictions. A higher-layer repair cannot recover facts already lost from its sources. Conflicting manual canon and source edits remain a review problem; no semantic authority or automatic continuity rewrite is implied.

## Refusal checks and retries

The summary-output gate rejects obvious refusals/filter metadata, empty/non-text/placeholder output, repetition loops and incomplete/truncated streams. It is heuristic, not factual validation. Late cancelled results cannot commit.

Saved checks use `summaryRefusalFilterVersion`, independent of release identity. Increment it when saved-text detection changes. Locally cache each saved revision/filter result, including historical versions used for future comparisons. Checks change quality metadata only, not source/text revisions or selections, and make no model calls. Current approved identities form findings. Unresolved refused inputs in selected dependencies block use/preparation on the server; unrelated retained alternatives are excluded from reuse. Summary-off ignores them.

- Keep as is records acceptance for the exact text revision/filter only; it clears neither source staleness nor later findings after edits/filter changes.
- Regenerate & repair retains versions, invalidates consumers and explicitly includes requested inactive roots. Reconstruct unusable roots from all clean current turns/children with extraction/compression prompts, original prior dependencies and current clean editorial inputs. Always review these candidates; no unchanged-input shortcut applies.
- Consumer minimal repair supplies corrected sources while withholding refused baselines with neutral `beforeOmitted: unusable_summary` provenance. Withheld inputs cannot qualify for known-unchanged shortcuts. Exclude refused summary text from previous/current summary fields, earlier context and corrections; unresolved current inputs fail. Original transcript/model instructions are not censored.
- Delete from here onward previews all identities with any version crossing the earliest covered finding plus dependency cascade, including crossing parents. Confirm atomically deletes those versions and keeps only a surviving selected prefix; original turns/requests remain. Cancel changes nothing. Subsequent Prepare is ordinary rebuilding.

Quality/reconstruction metadata uses optional summary JSON preserved by backup validation. Resolution commands recheck current approved revisions, filter version, chat and ownership transactionally. Stale previews must reopen. Restart retains decisions/reconstruction reasons without model calls.

Preparation retries apply to manual Prepare, Save next and automatic preparation, not reviewed repair. Preferences default enabled with 10 retries after the initial attempt per individual request; zero means no retry limit until Stop. Capture policy per job. Only transport/output failures retry after one cancellable second. Planning, stale state, persistence and non-shrinking failures stop. Each attempt keeps its own credential-free request/outcome and cannot advance coverage before commit. Disconnect does not stop jobs; explicit Stop/server interruption does. Restart never resumes paid work automatically. Absent retry fields preserve old no-retry command semantics.

## Deletion and verification boundaries

Delete summary previews a reverse dependency cascade across every version, including child/prior/correction/based-on consumers; remove all versions of affected identities. Keep selected prefix before the earliest deleted active span and return its archived suffix to verbatim. Retain unrelated later summaries for explicit reuse. Save deletions, historical deleted-result markers, selection/cutoff and revisions atomically. Preserve original turns and immutable request bodies. Reject conflicting active/review work.

Clear memory explicitly deletes all summary versions, candidates and preparation records while preserving original turns, selected context preset and roleplay requests. It is distinct from deleting transcript turns or application data.

Focused suites include context-core/application/reuse/refresh/delete, automatic-memory, summary-validation, response-variants, inline-images and their browser workflows. Check sequences, saved state and provider-call counts, not just final arithmetic. Important cases include fixed residual tails, 301→302 stability, restart, stale/cancelled results, correction overlap, every direct consumer after unchanged repair, no-call reuse and source deletion. Synthetic coverage/equality tests do not prove real-model recall, optimal defaults or actual phone behavior.
