# Compaction lab

A standalone Python/Tkinter experiment for the strategy in [product contract](../../CONCEPTS.md)
and [memory contract](../../docs/CONTEXT.md). This does not select the application stack.

## Run

Use Python 3.9 or newer with Tkinter:

```sh
python3 experiments/compaction/compaction_visualizer.py
```

Use a Python installation with working Tk support; ordinary application Node/npm commands do not run this lab.

No third-party packages, model calls, API keys, or conversation files are needed.

Run these commands from the project root. The experiment's launcher is `experiments/compaction/start.sh`; it resolves its own directory and uses this Mac's Tk-enabled Python when available.

## Explore

- Drag **Completed turns** from 1 to 1,000. Every turn occupies exactly 1,000 tokens.
- The initial view shows completed preparation or its explicit blocked state.
- Moving forward replays successive requests from saved state. Moving backward inspects
  earlier snapshots. Changing settings and applying them restarts the experiment.
- Use **Start**, **Save next**, **Back**, **Finish**, or the second slider to inspect
  each compaction step. Amber sources remain in input until their replacement is saved.
  The dashed amber outline is a proposed summary, not a saved one.
- Green turns are verbatim; gray turns are archived. Summary spans align with their
  source turns. Level 2 appears above the level-1 summaries it covers, and so on.
- Green summaries are in input. Gray dashed summaries are retained children, excluded
  when their parent covers the same range.
- Hover to inspect coverage. Enable **Zoom** and scroll horizontally to separate ticks
  in long histories. Higher levels have a vertical scrollbar.
- Change settings and press **Apply** or Enter. Settings remain unapplied until then.

**Other input** combines prompt, character/persona, pending user input, and protocol
overhead. It is included in the input target. Separate Connection physical limits and
output reservations are not simulated.

## Assumptions

Each slider value selects a snapshot from one sequential simulation. Committed summaries
and the cutoff carry forward between requests. Summaries only move toward greater
compaction; inactive children do not return when a new turn batch frees space. Spare
capacity remains unused. Backward scrubbing does not modify the later snapshots, and
this is not an implementation of deletion/restoration in a live chat.

The strategy lives in `experiments/compaction/compaction_model.py`, independent of Tkinter. An engine-like caller
uses `advance(previous_state, settings)` and keeps the returned final state for the next
request. `prepare(state, settings)` recalculates from an existing state without appending;
`simulate(n, settings)` sequentially replays from an empty chat. A failed request blocks
further turns rather than skipping to a batch boundary. The UI's `Replay` only caches
these core transitions. See the [stability contract](../../docs/CONTEXT.md#stable-coverage-and-preparation)
for persistence and commit requirements in an actual engine.

Budget pressure triggers compaction. First-layer batches are fixed and oldest first;
the minimum tail is protected, residual turns stay verbatim, and processing stops once
input fits. Promotion begins only when no full turn batch is eligible. Failure to fit
is explicitly reported.

The promotion policy was accepted as the initial application rule on 2026-10-17.
This lab remains a synthetic experiment: rank eligible levels by `U_k / (S / 2^k)`, break ties toward the deeper level,
and promote the oldest contiguous group. **Retain / level** is a hard floor for recent
active summaries at every source level; zero explores no hard floor. Soft allowances
share unused capacity and never trigger compaction independently.

All numeric defaults are illustrative. Every summary, at every level, is assumed to
occupy **Tokens / summary**. Summaries always save successfully; a non-shrinking first-layer
result blocks processing. Originals and lower summaries are retained. This models
structural coverage and token arithmetic, not semantic quality, actual tokenization,
summary repair, retries, or persistence. Nothing is written on exit.

## Validate

```sh
python3 -m unittest discover -s experiments/compaction -p "test_*.py" -v
```

Tests cover the full slider range, non-overlapping coverage, child retention, fixed
batching, minimum-tail failures, pressure-based promotion, and no-savings cases. Stability
checks cover 3,000 successive requests across three configurations, the 301→302 regression,
resuming from a checkpoint without replay history, chronological selection order, unchanged
selection when capacity is freed, and blocking rather than skipping failed requests.
