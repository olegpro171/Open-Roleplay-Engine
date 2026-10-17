# Roleplay Engine — Concepts and Initial Scope

Date: 2026-10-16

Status: product concept reference; persistent chats, roleplay libraries and durable layered compaction are implemented for local testing. A standalone synthetic compaction visualizer is also available. The in-app name is “ORE”; the repository remains “Roleplay Engine”.

This document records the product intent and concepts discussed so far. User-defined requirements are distinguished from proposed refinements, which remain open for revision. The user approved the technology and architecture baseline on 2026-10-16: TypeScript, React + Vite, Node.js + Fastify, and SQLite with better-sqlite3 + Drizzle, using Zod, HTTP + SSE, Vitest, and Playwright. Follow [IMPLEMENTATION.md](IMPLEMENTATION.md) for the accepted implementation guide and [README.md](README.md) for the working application. Persistent chats, reusable libraries, prompt editing, reviewed history replacement, imported-session preparation, layered memory inspection and targeted repair review are implemented. HTTPS setup, actual phone verification and real-model compaction quality remain unverified. There is no delivery schedule.

The stack approval also establishes an independent core engine, transactional persistence, server-owned generation, revision checks, credential-free request inspection, and recovery from interruption. Earlier proposals below remain proposals unless accepted explicitly here or in the implementation guide; approval does not settle experimental promotion rules, repair policies, or agent scope.

## 1. Purpose

Build a focused application for roleplay conversations with explicit control over model connections, prompt composition, and long-running conversation context.

The motivation is dependable context handling: predictable compaction, editable summaries, a clear verbatim-message cutoff, and visibility into exactly what is sent to the model. The initial aim is a useful personal tool rather than a broad replacement for every feature in existing roleplay applications.

Reported problems motivating the project include unreliable automatic scene boundaries, missing character access to memories, and apparent duplication between summary and advanced-memory paths. These are user-reported observations, not reproduced diagnoses.

## 2. User-defined core concepts

### Connection

A reusable data structure holding the information needed to call a model:

- Protocol: OpenAI-compatible initially; Anthropic-compatible support may come later.
- API endpoint.
- API key.
- Model identifier, with a model-fetching function where supported.
- Input/context and output token limits.
- Custom JSON request parameters, such as temperature, top-p, and reasoning effort.

The intended interface is a simple list of connections. Provider-specific editors and automatic tuning for individual providers are not an initial goal.

Proposed refinements:

- Always allow manual model entry when model discovery is unavailable.
- Distinguish the Connection's maximum available context and output limits from the context system's target working input size. Validate input plus reserved output against a combined context-window limit without subtracting output twice from an input-only target.
- Keep model/request settings in the Connection rather than duplicating them inside prompt presets or agents.
- Define which fields custom JSON may override. Protect the assembled conversation from accidental replacement.
- Exclude credentials from request previews, logs, and ordinary exports.

### Prompt preset

A reusable data structure defining what is sent to the model and in what order. It consists of an ordered array of:

- **Text blocks:** constant, user-authored text.
- **Markers:** placeholders for content obtained elsewhere, such as a character card, persona, managed context, or agent output.

Proposed refinements:

- Blocks and markers can be enabled or disabled.
- The preset defines message roles, such as system, user, and assistant, as well as order.
- Markers have stable identifiers and optional configuration. For example, a character marker can select specific card fields, and an agent marker can identify a particular agent.
- Resolved marker content is not recursively interpreted as another template. The accepted second-milestone name preprocessing replaces `{{user}}` and `{{char}}` once in prompt text and card/persona fields; stored conversation text remains literal. Other macros are not implemented.
- A preview shows the fully resolved outgoing messages.

### Context management system

A system that compacts older messages during long-running conversations and supplies the resulting historical context at a prompt marker. It also manages which messages remain verbatim in the outgoing request.

The initial desired approach is inspired by [Summaryception](https://github.com/Lodactio/Extension-Summaryception): retain recent conversation verbatim, summarize older batches, and progressively compact older summaries into deeper layers.

The project may eventually support other context management methods. Whether multiple methods will be implemented, and how users switch between them, remains undecided.

Proposed refinements:

- Separate the reusable **strategy and configuration** from each chat's **saved context state**: summaries, dependencies, source coverage, and processing progress.
- Use one active strategy per chat initially.
- Use one managed context marker to emit both historical summaries and recent verbatim messages. One component owns the cutoff and prevents overlapping history injection.
- Keep all original messages stored and readable. Compaction affects model input, not transcript retention.
- Treat summaries as lossy, inspectable, and correctable. Recursive compaction is not a guarantee of perfect recall.

Latest user-defined operating direction; numerical defaults and detailed output policies remain under discussion:

- Distinguish the model's **maximum available context** from a user-selected **target input context size**, such as approximately 32K tokens. The target controls normal context preparation and is enforced against the declared planning estimate even when the model supports a larger window. The user's later decision on 2026-10-17 accepts modest differences between that estimate and the selected model's actual count; the target is a working size, separate from physical capacity. The user's motivation is maintaining response quality rather than filling all technically available capacity; no particular target is established as universally optimal.
- Account for prompt text, character, persona, scenario, pending user input, and other request content within that target before allocating the remaining capacity to conversation history. The Connection's physical limits still apply separately; do not silently exceed the target to use spare model capacity.
- Configure a minimum verbatim tail of `L` completed **turns**, as defined below. `L` is a floor, not the normal target tail size. Keep all available conversation verbatim while the next request fits the input budget.
- When the request would exceed that budget, progressively summarize the oldest eligible turns, retaining as much recent verbatim history as possible. Do not immediately reduce the tail to `L`.
- First-layer batch size `B` is fixed at the user's setting. Summarize only a complete oldest batch that leaves at least `L` completed turns verbatim; do not create smaller boundary batches. With `L = 100`, `B = 3`, and 102 verbatim turns, all 102 must remain verbatim. If those turns plus required non-summary input alone exceed the target, generation fails.
- If the minimum tail and required non-summary input cannot fit the target, generation fails. Do not automatically shorten the tail, change batch size, or exceed the target.
- When no complete first-layer batch can be formed without violating `L`, and the request still does not fit, consider summary promotion. Any remaining fewer-than-`B` eligible turns remain verbatim and consume budget. Promotion cannot rescue a request whose required verbatim and non-summary input already exceeds the target.
- A decision function must choose between promoting newer level-1 batches and older level-2 or deeper batches, preserving finer detail in recent summarized history. Global token pressure triggers compaction; fixed summary-age thresholds are rejected. On 2026-10-17 the user accepted the visualizer's ranking as the initial application policy: among eligible levels, maximize `U_k / (S / 2^k)`, break ties toward the deeper level, and promote the oldest complete contiguous group while respecting the retained-summary floor. Use measured active-summary sizes for `U_k`, rather than count times an assumed size. This is an accepted starting heuristic, not evidence of real summary quality.
- Retain lower-level summaries after promotion so less compact representations remain available. Deletion can require restoring greater detail; exact selection and reuse rules remain open.
- Preserve the selected representation across successive requests. During ordinary forward continuation, an active summary stays selected until a saved parent replaces it; inactive children do not return merely because another turn batch frees capacity. Stability takes priority over filling the target. Spare capacity is allowed, and the verbatim cutoff and represented level of existing history can only advance toward greater compaction. Explicit manual preparation with saved-memory reselection is accepted below; automatic restoration after edits, deletions, branches, or setting changes remains unresolved.
- The former automatic `L + B` trigger and fixed turn countdown are superseded by budget-driven compaction. `L + B` now determines whether a full first-layer batch is eligible, not whether compaction is necessary. Any advance warning must reflect token pressure as well as eligibility.
- Keep unsummarized turns freely editable. Mark summarized messages as **archived** while retaining their readability and editability; their content reaches the model through summaries rather than verbatim messages.
- Editing archived messages marks their dependent summaries as out of date and propagates through higher summary layers, enabling targeted memory repair.
- Use targeted repair with review for changed summarized sources, working from affected children upward. Preserve earlier versions and allow manual correction of candidates. Semantic authority for conflicting manual additions remains open.

See [Editable history and layered context](docs/CONTEXT_EDITING.md) for worked examples, the stateful stability contract, proposed safeguards, and unresolved choices. The user-defined context constraints above, the initial promotion ranking, and turn rules below are accepted product directions; automatic partial restoration remains unresolved. The [standalone compaction visualizer](docs/VISUALIZER.md) is a synthetic reference, while the application now implements durable compaction with real text and model requests.

#### Imported-session preparation: direction on 2026-10-17

The user requested design and settings discussion before implementation. The next context-management milestone should prioritize preparing an already ongoing, imported roleplay session for continuation, rather than requiring a conversation to start inside this application.

New user-defined requirements:

- Provide a separately selected summarization Connection. Keep endpoint, model, credentials, physical limits and custom request parameters in reusable Connection records. Whether the user selects the same record for both jobs is separate from having independent selections.
- Use Summaryception-style prompts to progressively compress roleplay prose while attempting to preserve as much narrative detail as possible. Recursive summarization remains lossy. The user subsequently accepted separate editable first-layer extraction and higher-layer compression templates, with prior context used to clarify references while outputs are requested to remain understandable on their own. Initial editable prompts and a bounded prior-context policy are implemented; their semantic quality remains unverified.
- Carry over the visualizer's real compaction controls: input target, minimum verbatim tail, fixed turn batch, summary size, promotion group and retained summaries per level. The retained count protects the newest active summaries at each source level from promotion; zero permits no such floor. The visualizer's promotion ranking is accepted as the initial policy. Editable starting values match the lab; quality-oriented tuning remains open.
- Replace simulation assumptions with real measurements: derive other input from the resolved request, measure actual source and summary sizes, and treat the summary-size control as a requested output target rather than an assumed exact length. The implementation uses a soft prompt target and the summarization Connection's output reservation as the physical limit; results are measured and normal replacements must save input space.
- Include an application visualization similar to the lab's layered timeline. The accepted design displays source turns with aligned summaries stacked by level, active/retained/preparing/stale states, a budget bar and next-operation explanation. Selecting a span shows its text, sources and size. Earlier snapshots are inspection views rather than an implicit restoration action; detailed presentation remains to be designed.

The user accepted the recommended workflow on 2026-10-17: explicitly prepare the imported chat from its current saved transcript, preview its budget/protected tail/next batch, commit each successful replacement, and stop when the current assembled input fits. This differs from replaying imagined earlier generations. Later response requests must recheck their complete input, including newly submitted text. Preparation preserves any pending user turn unsummarized and supports stopping/resuming from committed progress. Single-step execution, reusable context presets and separate first-layer/promotion prompt editors are accepted design directions; detailed schemas and controls remain to be designed.

The user additionally requested a basic automatic guard against summarization refusals and anomalous output such as `placeholder`. The implemented summary request gate rejects obvious refusal text or provider refusal/filter metadata, placeholder-only output, empty/non-text output, complete repetition loops, truncated or incomplete streams and late results after cancellation. These checks are heuristics, not semantic validation. The compaction coordinator separately validates source revisions and useful net savings before saving a replacement and switching coverage together. Failures retain the previously committed selection. No automatic paid retry is implemented.

Implementation was requested on 2026-10-17. The user selected **targeted repair with review** for archived edits: pause continuation with stale selected memory, work from affected children upward, and approve each proposed replacement before repairing its dependents. The initial repair request includes the old summary and previous/current source text rather than only a text patch. Candidates can be corrected before approval; approved summary text can also be edited directly, preserving old versions and invalidating dependents. These controls do not guarantee preservation of manual intent or semantic consistency.

The first implementation exposes reusable context presets and the Memory page for single-step/full preparation, stop/resume, timeline/source inspection and saved request snapshots. The snapshot retains its original turn membership, so later turns do not appear in earlier preparation views. Numerical starting values match the lab and remain editable; summary size is a soft prompt target, with the Connection's output reservation governing the physical request. At most three earlier selected summaries are supplied when they fit, with their revisions tracked as dependencies. Entirely deleted coverage can be removed through reviewed repair without a model request. Entirely blank but present turns are never silently dropped; unusable or non-shrinking model results stop preparation. The user subsequently replaced the restore-only action with **Clear memory**: explicitly delete all summary layers, versions, review candidates and preparation records, while preserving original turns, the selected context preset and immutable roleplay request records. All turns return to verbatim input. Automatic partial restoration remains open. Setting changes preserve the committed selection and govern subsequent steps. A tail-floor conflict requires explicit Prepare chat when a fitting saved representation is available, adjustment, or clearing memory.

On 2026-10-17 the user initially accepted manual Refresh, then requested merging it into **Prepare chat**. An explicit Prepare click now reconsiders saved representations under the current complete-input estimate and effective limit, even when the existing input fits. Reuse exact fresh approved first-layer batches and eligible saved parents using the geometric-pressure rule, promotion groups and retained floors. Selected memories carrying manual corrections through themselves or dependencies stay protected during this local reselection. If saved memory produces a fitting selection, finish without model requests. If the current selection already fits but cannot be usefully rearranged using saved groups, retain it without generating summaries merely to rebalance. Otherwise continue from committed memory, reusing each exact valid saved replacement before generating a missing one. Automatic preparation before a response and single-step preparation also reuse saved replacements, but never restore detail merely because capacity is available. A summarization Connection is required only when a model request is actually needed. Repair with review remains separate; stale selected memory and unresolved candidates block preparation.

Preserve all original turns, summary versions and roleplay request records. Save manual reselection and its before/after record transactionally with the preparation job; record reused steps without model requests and track saved reuse versus newly generated summaries. After any compaction steps, manual preparation runs a final saved-only pass so newly available groups are reflected before completion. Historical views include initial/final reselections and intervening steps with original turn membership. Repeated manual preparation against unchanged inputs keeps the same selection without regenerating cached memory. Existing Refresh history remains inspectable, but there is no separate Refresh button. Automatic restoration triggers, branches and bulk deletion remain deferred.

The user also requested current input inspection in the Story sidebar: total and active verbatim turns, the complete input estimate, a color-coded allocation and a detailed resolved prompt peek. Current request inspection follows saved settings and unsent input; historical attempts retain their original limits. Completed responses show endpoint-reported input/output tokens when supplied, independently of planning estimates. Missing counts are unavailable rather than inferred. The final user decision on 2026-10-17 is to use one shared `cl100k_base` reference tokenizer for all models, accepting modest differences from actual endpoint counts around the working input target. This replaces the earlier model-specific approach and avoids model mappings, tokenizer discovery and per-model assets. Apply the same measurement to request planning, allocations, summary sizes and savings. Keep endpoint usage attached to its exact historical request, and preserve saved estimates. Existing ‘Estimated input’ wording is sufficient; do not add tokenizer names, reference labels or repeated technical caveats to the normal interface. Method/version and limitations remain available in saved request metadata and developer documentation. Connection checks and the optional immediate ‘Hi’ test remain separate diagnostics, without calibration or chat changes.

### Turn

The primary stored conversation unit is a **turn**, containing a user-input part and an assistant-response part. Accepted decisions:

- Historical turns are complete. Only the newest turn may be incomplete while its response is pending, including after a generation error or cancellation. Another turn cannot be submitted while that incomplete turn remains unresolved.
- Only a whole turn can be deleted. Either part can be edited independently, including in archived history. Deleting a turn does not merge or move content between neighboring turns.
- Editing either part to an empty string is allowed and does not make a completed turn incomplete. This also permits both parts to be blank; the turn remains present until explicitly deleted.
- User decision on 2026-10-17: trim extra boundary newlines from new user input, successful AI responses and subsequent part edits, retaining internal paragraph breaks and indentation. Apply the same cleanup when copying a greeting. Preserve existing/imported transcript text until explicitly edited. Whitespace-only generated output remains a failed response rather than a completed blank turn.
- Completion is distinct from text length. An existing response deliberately cleared by the user is different from a response that has not been completed. Clearing text must not automatically complete a pending turn or reopen a completed one.
- A completed turn still counts as one turn after either or both parts are cleared. Summary boundaries preserve turn membership, but do not guarantee nonempty actions and reactions or narrative coherence after edits.
- User decision on 2026-10-16: omit deliberately blank parts from outgoing requests while retaining their completed turns and source coverage in the saved chat. This does not authorize accepting a blank generated response or partial output as complete.

Accepted implementation direction: give turns stable identities and track revisions of their independently identifiable parts so summaries can detect source changes. The detailed storage representation, regeneration and branching behavior remain open. “Message” may still describe role-bearing entries in outgoing model requests; it is not the primary stored conversation unit.

#### Character greeting as an opening turn

Accepted user decision on 2026-10-16; greeting initialization is implemented in the roleplay-library milestone:

- Represent a chosen character greeting as a completed opening turn with an empty user-input part and the greeting in its assistant-response part. It is ordinary chat history, not a separate prologue outside the turn model.
- Copy the chosen greeting into the chat when it starts. The character's reusable greeting supplies the initial text; later edits to that reusable greeting do not rewrite the saved chat.
- The first user action starts the next turn, paired with its own assistant response. It is not inserted into the greeting's empty user part.
- Display the greeting without an empty user bubble. While represented verbatim, send it as an assistant message and omit its blank user part under the existing outgoing-request rule.
- Apply ordinary turn identity, revision, editing, whole-turn deletion, and summary-coverage rules. The greeting can eventually be summarized; editing it afterward marks dependent summaries and their higher-layer dependents out of date.
- Count the opening turn as one completed turn for both first-layer batch size `B` and minimum verbatim tail `L`. Clearing its text preserves its completion and turn membership, just as for any other completed turn.

For example, the opening turn contains only “The innkeeper looks up. ‘You're late.’” in its assistant part. The next turn pairs the user's “I put the sealed letter on the counter” with the assistant's response. No pending generation is needed to make the copied greeting complete. This does not change the unresolved policy for accepting empty or partial generated responses.

### Chat

A persistent conversation that accepts user input and obtains model responses. Many chats can exist, with different characters, personas, and settings.

User interface decision on 2026-10-17: select chats through Libraries. Any idle chat, including the original or final chat, may be deleted; deleting the current chat keeps the Chats library open for further cleanup. Story and Setup sit together in the shared header.

Each chat selects:

- A Connection.
- A Prompt preset.
- A context management system and its configuration.
- A character card and persona.
- Any enabled agents.

Accepted implementation direction: separate the stored Chat from the server-owned generation process that coordinates context preparation, prompt assembly, provider requests, and response persistence. Browser disconnection does not cancel that process; server interruption exposes recovery rather than promising resumable provider streams.

### Agent

A task configured for a specific job, with its own instructions and selected Connection. It has read access to chat history, runs manually or automatically, and produces output available through a prompt marker.

Example: a date-and-time tracker that reads conversation events and maintains the current fictional date and time.

Proposed refinements:

- Reference a reusable Connection instead of copying its configuration.
- Define the trigger: manual, before a response, or after a response.
- Define the input scope: full history, recent messages, managed context, or selected fields.
- Define whether output replaces a current state or appends historical records.
- Define whether failure blocks generation or permits continuation with an explicitly identified previous result.
- Associate outputs with the originating chat and conversation revision so stale background work cannot overwrite newer state.

Agents are part of the concept model. Their inclusion in the first usable release has not been decided.

## 3. Additional foundational concepts

### Character and Persona

Separate reusable records:

- **Character:** describes the identity played by the model.
- **Persona:** describes the identity played by the user.

Separate reusable Character and Persona records and their libraries are accepted in the second milestone. Their data can be inserted through prompt markers. Initial compatibility covers basic SillyTavern character text fields and persona names/descriptions; on 2026-10-17 the importer was extended to read the same basic fields from V3 JSON/PNG cards while preserving inactive metadata and the V3 export format; full Character Card V2 behavior, including lorebooks, is deferred. One character and one persona are selected per chat; multiple active characters remain open.

### Generation record

A record of the resolved outgoing messages, effective request parameters, and history coverage used for a response, with credentials excluded.

Its purpose is to answer: “What exactly did the model receive?” This record is part of the accepted implementation baseline; retention and detailed storage representation remain open.

## 4. Proposed responsibility boundaries

| Component | Owns |
| --- | --- |
| Connection | Model selection, transport configuration, token limits, and request parameters |
| Prompt preset | Arrangement, roles, constant instructions, and marker placement |
| Context strategy | Representation and budgeting of conversation history |
| Chat | Conversation data, selections, and chat-specific runtime state |
| Agent | A specific auxiliary task and its generated output |
| Generation process | Coordination of these components for one model response |

The intention is to avoid multiple components independently changing the same history cutoff or injecting competing representations of the same messages.

The accepted core, persistence, generation, provider, and interface module boundaries are specified in [IMPLEMENTATION.md](IMPLEMENTATION.md). The table above remains the product-level separation of responsibilities; it does not require shipping agents in the initial release.

## 5. Proposed generation flow

1. Save the user-input part of a new pending turn, provided no incomplete turn already exists.
2. Run agents configured to execute before the response.
3. Prepare historical summaries and the recent verbatim window within the available budget.
4. Resolve the selected prompt preset's text blocks and markers.
5. Validate the assembled request against the target input context size and the Connection's limits, then save the generation record.
6. Send the request, stream the response, and support cancellation.
7. Save the completed response in that same turn and run agents or context processing configured for afterward. Failed or cancelled generation leaves the turn pending; any explicit acceptance of partial output remains an open decision.

The latest user-defined trigger is whether the assembled next request fits its target working input size, including the pending user input. Compaction should preserve more than `L` completed turns whenever capacity allows. First-layer batches have exactly `B` turns; residual turns outside `L` that cannot form a full batch remain verbatim. If this required input alone exceeds the target, generation fails. Otherwise, when no first-layer batch is eligible, the accepted initial promotion rule chooses which summary level to promote under continuing token pressure. Explicit imported-session preparation is accepted; any additional proactive background processing remains open. Any background work must be tied to the conversation revision it read. Budget pressure alone never authorizes excluding source messages before their replacement summary is saved.

## 6. Proposed context reliability requirements

The transactional coverage, revision tracking, recovery, and request-inspection obligations specified in [IMPLEMENTATION.md](IMPLEMENTATION.md) are now accepted implementation requirements. The list below also includes refinements whose detailed product policies remain open, such as branching and manual correction. None is a claim about an existing application implementation:

- **Preserve the transcript:** original messages remain available regardless of compaction.
- **Commit before exclusion:** messages leave verbatim context only after their replacement summary is successfully saved.
- **Prevent duplicate coverage:** inject either a compacted summary or its constituent summaries/messages for a covered range, rather than both.
- **Expose gaps:** no unexplained omissions in the intended historical coverage.
- **Retry safely:** retrying a batch cannot create duplicate summaries or advance progress twice.
- **Invalidate dependencies:** edits invalidate affected summaries and their dependents. Later incremental summaries may also depend on earlier summary content.
- **Isolate branches:** memories from an abandoned continuation must not leak into the selected continuation.
- **Recover interrupted work:** processing can resume from saved progress without losing valid completed batches.
- **Respect both limits:** keep all assembled input within the target working input size, and respect the Connection's maximum available context and output limits. Account for fixed content, dynamic markers, historical context, recent messages, and request overhead.
- **Explain failures:** if preparation fails and the request cannot fit, surface an actionable state rather than silently dropping history.
- **Allow correction:** summaries can be inspected, corrected, and rebuilt with clear consequences for dependent records.

These rules prevent structural duplication and omission. They do not guarantee that a summarizing model preserves every fact or never repeats information in prose.

## 7. Initial scope and open decisions

### Initial priorities established by the user

The user revised the implementation order on 2026-10-16: establish a usable roleplay workflow before implementing context management. The second milestone consists of:

1. A library of SillyTavern-compatible personas, with import, creation and editing.
2. A library of SillyTavern-compatible characters, with import, creation and editing of basic text fields. Full V2 support, including lorebooks, may follow later.
3. Name preprocessing for tags such as `{{user}}` and `{{char}}`, using the selected persona and character names.
4. A Prompt preset library and editor with ordered text blocks and markers, rearrangement, saving, and an editable built-in default that can be restored to its original state. Its initial wording is deliberately simple; the eventual default remains undecided.
5. A chat library, with each chat selecting its own Connection, prompt, persona, character and input target.
6. Importing a file by replacing all messages in the selected chat, without requiring branching. The supplied example is a large SillyTavern-style JSONL export.

Accepted import conversion decision: preserve consecutive same-speaker messages as separate turns with the opposite part empty, without merging their text. Ordinary user/assistant pairs remain paired. An assistant-only opening is a completed turn; a final unpaired user message remains pending. Historical user-only turns are complete with an empty assistant part. This import rule does not authorize treating empty model output as a successful generation.

Durable layered compaction is implemented as the third milestone for local testing. Context presets prepare imported transcripts and subsequent response requests within the input target and Connection limits; the Summary and Messages markers share one saved selection. Unresolvable budget conflicts fail explicitly. Product agents and branching remain deferred decisions.

### Proposed scope limits

Defer broad provider-specific adaptation, semantic retrieval, automatic scene-boundary inference, character-specific memory permissions, multimedia systems, multiplayer, and a plugin ecosystem. These are scope recommendations, not permanent exclusions.

### Token-count decisions

The user initially approved a conservative byte-based estimate, then requested model-aware counting after a saved Gemma/OpenRouter request was estimated at 29,446 against 5,912 reported input tokens. All selected memory and expected verbatim messages were present.

The final decision on 2026-10-17 is implemented: use `cl100k_base` as a single reference tokenizer for every model, with a small shared framing allowance. Enforce the working input target against that estimate and accept modest differences in actual provider tokens. The Connection’s physical capacity and reserved output remain separate constraints, checked with the same estimate; exact remote-limit guarantees are not claimed. No model support list, character divisor or provider-derived calibration is used. A lower estimate preserves committed summaries and the verbatim cutoff; it does not restore archived turns automatically.

The normal interface keeps existing estimate wording without additional tokenizer labels or repeated technical notes. Preserve method/version and verification limits in request metadata, and keep endpoint-reported usage separate. Recalculation of the same historical request gives 5,766 with the shared counter versus 5,912 reported. Saved bodies, old estimates and usage remain unchanged. That one comparison does not establish accuracy for other texts, languages or models. See [counting details](docs/TOKEN_COUNTING.md), [README.md](README.md) and [diagnostics](docs/DIAGNOSTICS.md).

### Decisions still open

- Distribution identity beyond the accepted in-app name “ORE”; repository renaming is deferred.
- Later database schemas and distribution packaging. Exact package versions, the initial chat/turn/generation schema, owner sessions, and a local launcher now exist; see [README.md](README.md). HTTPS certificate provisioning/trust and stronger credential storage protection remain open. These implementation choices do not settle future context schemas or product policies.
- Additional card and chat import/export formats. The implemented subset is character V1/V2/V3 JSON or embedded-card PNG, persona-backup JSON (plus name/description JSON), application prompt/context-preset JSON, and SillyTavern-style JSONL chat replacement; see [README.md](README.md).
- Future turn/summary revision retention, regeneration and branching behavior. Stable turn/part revisions, whole-turn deletion, independent part editing and intentionally blank parts are implemented; archived turns remain editable.
- Quality-oriented tuning of initial numerical values, any future hard summary-size enforcement, and operational headroom. The initial output-size setting is a soft prompt target. Fixed batches, configurable promotion grouping/floors and geometric-pressure ranking are accepted; real-model detail retention still requires validation.
- Additional recovery options beyond the implemented errors, explicit retries, reviewed repairs, manual preparation and Clear memory. Failure when required input cannot fit is settled. Imported consecutive same-speaker messages use the accepted separate-turn rule above; system-message and group-chat conversion remain outside the subset.
- Whether partial or empty generated output can be explicitly accepted as completing a pending turn. Blank saved parts are now omitted from outgoing requests by user decision; this does not settle generated-output acceptance.
- Any future option to continue with stale memory. The initial implementation prepares context before roleplay and pauses while selected memory needs reviewed repair; failures require explicit recovery.
- Semantic authority when manual additions conflict with edited source facts, and creating entirely handwritten summaries with new coverage. Existing summary corrections and targeted repair review are implemented; see [the editing discussion](docs/CONTEXT_EDITING.md).
- Prompt-quality tuning and future prior-context policies. Extraction/promotion uses at most three preceding selected summaries as explicit dependencies. Repair also reuses current approved versions of its earlier dependencies when appropriate; this does not guarantee independently complete outputs.
- Future strategy migration and automatic partial detail restoration. Current setting changes preserve selections and apply to subsequent work; an incompatible protected tail requires manual preparation when saved representations permit, explicit adjustment, or clearing memory.
- Future shared-record version pinning or per-chat copies. In the implemented library milestone, saved edits apply to subsequent requests in chats selecting that record; copied greetings and saved generation requests retain their historical text. Shared edits are blocked while any response is running.
- Whether agents ship in the first version and which triggers they support.
- Missing-marker and missing-agent-output behavior.
- Backup policy and generation-record retention.

## 8. Suggested first proof

The accepted implementation sequence is persistent chat, then the roleplay libraries/editors and history replacement, then durable layered compaction. See [IMPLEMENTATION.md](IMPLEMENTATION.md) for milestone acceptance checks. The experiment below remains the context-quality and reliability proof; it does not imply that every unresolved editing or branching policy is already selected.

After establishing the roleplay workflow, validate the context system against a copied long-running chat before claiming dependable long-context behavior:

- Inspect summary quality against known story facts.
- Check that outgoing source coverage has no unintended overlaps or gaps.
- Interrupt processing and resume it.
- Simulate a failed summarization request and retry it.
- Edit an early message and verify dependency rebuilding.
- When branching is implemented, branch midway through the conversation and verify that later events do not leak backward.
- Inspect the final outgoing request and its token budget.

Passing this experiment would support the project's main promise: understandable, dependable context handling for long-running roleplay.
