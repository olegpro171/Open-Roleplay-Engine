# Shared input planning

Final user decision, implemented 2026-10-17: use one `cl100k_base` reference tokenizer for every model. This replaces model-specific support, identifier mappings and the byte fallback. Estimates guide the working context size; modest differences from actual provider counts are acceptable. Endpoint-reported usage remains a separate observation attached to the exact request.

## Measurement

`src/core/tokens.ts` uses the encoding bundled with `gpt-tokenizer@4.0.3`. Count each resolved outgoing message's actual text, without transport JSON escaping. Special-looking content is encoded as ordinary text. Add a shared framing allowance of 3 units plus 3 per message plus the encoded role strings. This small allowance is an approximation, not a claim about any endpoint's exact template. Nothing depends on the selected model identifier or endpoint.

The counter is local, with a bounded cache (512 text entries, at most two million UTF-16 code units, excluding individual texts over 100,000 units). No tokenizer service receives the transcript and no model-specific data is downloaded. Unknown models use the same reference encoding, without an unsupported-model path or byte-based fallback. No character divisor or observed provider ratio is used.

Use the same counter for complete roleplay input, per-message allocations, summary sizes including labels/separators, promotion ranking, complete-request savings, and the separate summarization Connection's source-window/prior-context checks. Requested summary length remains a soft output instruction, not an assumed measurement. Only a complete assembled request determines budget fit and net savings.

The input target is enforced against the reference estimate. Separately check estimated input plus reserved output against the physical context window, without subtracting output twice from an input-only target. The selected model may count somewhat more or less than the reference. Exact remote-limit guarantees are not claimed. Existing committed summaries and cutoff remain selected when the estimate falls; use Memory → Prepare chat to explicitly reconsider saved representations. No automatic restoration is implied.

## Interface and records

Keep existing estimate wording in the Story sidebar, Prompt peek and Memory/Request inspector. Do not add a tokenizer-name label or repeat technical limitations in the normal interface. Connection test results show endpoint-reported usage, or unavailable; their expanded request JSON retains the separate planning estimate. Technical details remain in developer documentation and the request metadata available through saved records and the expanded test-request JSON.

New request budgets retain the counting method, reference tokenizer, implementation version, approximate framing status, verification limits and `verified: false`. These describe the reference measurement, not the selected model's tokenizer. Old saved bodies, estimates, usage and metadata retain their original meaning and are never recalculated in place. The public metadata contract remains able to read historical model/fallback records.

Browser previews and Memory plans obtain the authoritative server count; composer changes are debounced for one second of typing inactivity and superseded replies are ignored. Budget panels retain the last same-chat result during refreshes; actions that need a fresh preview or plan wait for the matching result. Read-only inspection can display overflow and stale memory without weakening generation checks.

**Check connection** requests `/models` explicitly. **Send test message** explicitly sends `Hi` using the editor settings, with at most 64 output tokens and a 30-second timeout. The result separates its estimate from usage reported for that exact test, or shows usage unavailable. Tests add no chat turns, save no settings, and perform no automatic retry or calibration. Saved keys are used only with their saved endpoint URLs.

## Verification and limits

`tests/fixtures/token-counts.json` contains independent Python `tiktoken` 0.12.0 reference counts for `cl100k_base`, including English, Cyrillic, Japanese, Arabic, emoji, combining accents, escapes, whitespace and special-looking strings. Tests check vocabulary counts and the small framing allowance. Model-independence checks confirm identical budgets/allocations for existing, unknown, custom and future identifiers. A synthetic 256-turn/20-summary fixture preserves 252 archived turns and seven verbatim entries without premature compaction. Existing compaction, promotion, repair, recovery and browser workflows use budgets appropriate to the new reference measurement.

Read-only recalculation of the user's historical Gemma/OpenRouter request gives **5,766 estimated input** (5,727 text + 39 framing) versus **5,912 reported input**, a 2.47% underestimate. No new paid request was made and no saved record changed. See [diagnostics](DIAGNOSTICS.md).

These checks establish consistent local reference counting and structural behavior. They do not establish accuracy for every model/language, exact endpoint framing or limit enforcement, summary fidelity or real-model summary quality. The reference tokenizer is deliberately an approximation for all models; its identity is not a universal accuracy claim.
