# Token and character-card diagnostics

Checked 2026-10-17. The user's database and three supplied card files were read-only. No real provider requests or transcript changes were made.

## Gemma through OpenRouter

The successful `google/gemma-3-4b-it` response in **Test import** reporting **5,912 input / 326 output** belongs to a saved request estimated at **29,446 input**, rather than the current preview's 31,118. The current preview includes the newly completed response; the saved attempt ends with its pending user input.

That saved request contains:

- 256 stored turn identities.
- 20 selected summaries covering exactly 252 distinct archived turns, with no duplicate or missing source membership. Every selected summary's complete text is present in the outgoing messages.
- Four remaining verbatim turns, represented by seven protocol messages: three complete input/response pairs and the pending user input. Every expected non-empty part is present.
- Two additional system entries for resolved instructions and memory, giving nine outgoing messages in total.

The saved input estimate is 29,174 serialized-message UTF-8 bytes + 128 framing units + 9 × 16 message units = **29,446**. The estimator counts each byte as one token; it does not tokenize Gemma text. Its result is **4.98×** the provider-reported input count. Two preceding successful attempts show similar ratios: 31,733 / 6,476 and 30,589 / 6,230.

The evidence explains the discrepancy as an excessively conservative estimate for this text/model, with a smaller difference from comparing current input against a historical attempt. It does not indicate omitted selected context. Structural coverage does not verify summary fidelity or the provider's internal handling of the request.

An intermediate model-aware implementation counted 5,867 text tokens plus 272 fallback framing units, for 6,139 estimated input. The user subsequently accepted one shared reference tokenizer to avoid per-model support and maintenance. The final `cl100k_base` counter counts **5,727 text tokens** plus **39 shared framing units**, for **5,766 estimated input**, 146 (2.47%) below the original endpoint report of 5,912. This was recalculated against the same saved request read-only, without another provider call. The saved 29,446 estimate and endpoint usage remain untouched.

The working target is enforced against the reference estimate; modest differences in actual provider tokens are accepted. Physical capacity and reserved output remain separate constraints. The same counter drives planning, summary savings and allocations for every model. Committed selections remain unchanged. No character divisor or observed ratio is used. This comparison does not establish accuracy for every language, text or future provider route, or verify the endpoint’s internal formatting. See [token counting](TOKEN_COUNTING.md) for details.

## Character-card imports

`eiria__your_sunshine_twin.png` and `airi.png` contain `chara_card_v3` / `3.0` objects in both `chara` and `ccv3` PNG metadata. The previous importer decoded `chara` and then rejected the V3 schema. Both files are below the 2 MB limit. The working `main_fuka-shikuzaki-f2cea3d2_spec_v2.png` contains V2 metadata.

The importer now reads the six existing editable text fields from V3 cards, prefers `ccv3` metadata when available, and preserves V3 metadata and format through export. The metadata preference follows the [Character Card V3 specification](https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md). V3 assets, lorebooks and additional runtime behavior are outside this basic-field subset.

All three supplied files were decoded, imported and exported successfully, preserving the six fields. Synthetic regression checks cover V3 JSON and PNG metadata, both chunk orders, compressed/uncompressed text chunks, edits and preservation of inactive V3 fields. Browser checks use temporary synthetic data rather than the user's database.
