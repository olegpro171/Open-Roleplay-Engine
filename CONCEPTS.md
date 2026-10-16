# Roleplay Engine — Concepts and Initial Scope

Date: 2026-10-16

Status: product concept reference; the first application milestone is implemented for local testing, and a standalone synthetic compaction visualizer is available. “Roleplay Engine” is a working name.

This document records the product intent and concepts discussed so far. User-defined requirements are distinguished from proposed refinements, which remain open for revision. The user approved the technology and architecture baseline on 2026-10-16: TypeScript, React + Vite, Node.js + Fastify, and SQLite with better-sqlite3 + Drizzle, using Zod, HTTP + SSE, Vitest, and Playwright. Follow [IMPLEMENTATION.md](IMPLEMENTATION.md) for the accepted implementation guide and [README.md](README.md) for the working application. One persistent chat with streaming and request inspection is implemented. HTTPS certificate setup, actual phone verification, layered context management, and the broader editors remain unfinished. There is no delivery schedule.

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
- Resolved marker content is inserted as literal content rather than automatically interpreted as another template.
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

Latest user-defined operating direction; summary-level selection and detailed settings remain under discussion:

- Distinguish the model's **maximum available context** from a user-selected **target input context size**, such as approximately 32K tokens. The target controls normal context preparation and is a strict generation limit even when the model supports a larger window. The user's motivation is maintaining response quality rather than filling all technically available capacity; no particular target is established as universally optimal.
- Account for prompt text, character, persona, scenario, pending user input, and other request content within that target before allocating the remaining capacity to conversation history. The Connection's physical limits still apply separately; do not silently exceed the target to use spare model capacity.
- Configure a minimum verbatim tail of `L` completed **turns**, as defined below. `L` is a floor, not the normal target tail size. Keep all available conversation verbatim while the next request fits the input budget.
- When the request would exceed that budget, progressively summarize the oldest eligible turns, retaining as much recent verbatim history as possible. Do not immediately reduce the tail to `L`.
- First-layer batch size `B` is fixed at the user's setting. Summarize only a complete oldest batch that leaves at least `L` completed turns verbatim; do not create smaller boundary batches. With `L = 100`, `B = 3`, and 102 verbatim turns, all 102 must remain verbatim. If those turns plus required non-summary input alone exceed the target, generation fails.
- If the minimum tail and required non-summary input cannot fit the target, generation fails. Do not automatically shorten the tail, change batch size, or exceed the target.
- When no complete first-layer batch can be formed without violating `L`, and the request still does not fit, consider summary promotion. Any remaining fewer-than-`B` eligible turns remain verbatim and consume budget. Promotion cannot rescue a request whose required verbatim and non-summary input already exceeds the target.
- A decision function must choose between promoting newer level-1 batches and older level-2 or deeper batches, preserving finer detail in recent summarized history. Global token pressure triggers compaction; fixed summary-age thresholds are rejected. Adaptive layer allowances and protected summary counts are recommendations under discussion, not accepted settings.
- Retain lower-level summaries after promotion so less compact representations remain available. Deletion can require restoring greater detail; exact selection and reuse rules remain open.
- Preserve the selected representation across successive requests. During ordinary forward continuation, an active summary stays selected until a saved parent replaces it; inactive children do not return merely because another turn batch frees capacity. Stability takes priority over filling the target. Spare capacity is allowed, and the verbatim cutoff and represented level of existing history can only advance toward greater compaction. Explicit restoration after edits, deletions, branches, or setting changes remains a separate unresolved policy.
- The former automatic `L + B` trigger and fixed turn countdown are superseded by budget-driven compaction. `L + B` now determines whether a full first-layer batch is eligible, not whether compaction is necessary. Any advance warning must reflect token pressure as well as eligibility.
- Keep unsummarized turns freely editable. Mark summarized messages as **archived** while retaining their readability and editability; their content reaches the model through summaries rather than verbatim messages.
- Editing archived messages marks their dependent summaries as out of date and propagates through higher summary layers, enabling targeted memory repair.
- Explore repairing an existing summary from source changes rather than replacing it from scratch, especially to preserve manual summary work. Handling manually authored summaries and conflicting manual corrections remains open.

See [Editable history and layered context](docs/CONTEXT_EDITING.md) for worked examples, the stateful stability contract, proposed safeguards, and unresolved choices. The user-defined context constraints above and turn rules below are accepted product directions; promotion ranking and restoration details remain proposals. The [standalone compaction visualizer](docs/VISUALIZER.md) uses a UI-independent stateful model for synthetic token budgets and the proposed promotion policy; the application context system is not implemented.

### Turn

The primary stored conversation unit is a **turn**, containing a user-input part and an assistant-response part. Accepted decisions:

- Historical turns are complete. Only the newest turn may be incomplete while its response is pending, including after a generation error or cancellation. Another turn cannot be submitted while that incomplete turn remains unresolved.
- Only a whole turn can be deleted. Either part can be edited independently, including in archived history. Deleting a turn does not merge or move content between neighboring turns.
- Editing either part to an empty string is allowed and does not make a completed turn incomplete. This also permits both parts to be blank; the turn remains present until explicitly deleted.
- Completion is distinct from text length. An existing response deliberately cleared by the user is different from a response that has not been completed. Clearing text must not automatically complete a pending turn or reopen a completed one.
- A completed turn still counts as one turn after either or both parts are cleared. Summary boundaries preserve turn membership, but do not guarantee nonempty actions and reactions or narrative coherence after edits.
- User decision on 2026-10-16: omit deliberately blank parts from outgoing requests while retaining their completed turns and source coverage in the saved chat. This does not authorize accepting a blank generated response or partial output as complete.

Accepted implementation direction: give turns stable identities and track revisions of their independently identifiable parts so summaries can detect source changes. The detailed storage representation, regeneration and branching behavior remain open. “Message” may still describe role-bearing entries in outgoing model requests; it is not the primary stored conversation unit.

### Chat

A persistent conversation that accepts user input and obtains model responses. Many chats can exist, with different characters, personas, and settings.

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

Their data can be inserted through prompt markers. Supported card formats and whether the initial release supports multiple active characters remain open.

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

The latest user-defined trigger is whether the assembled next request fits its target working input size, including the pending user input. Compaction should preserve more than `L` completed turns whenever capacity allows. First-layer batches have exactly `B` turns; residual turns outside `L` that cannot form a full batch remain verbatim. If this required input alone exceeds the target, generation fails. Otherwise, when no first-layer batch is eligible, an unresolved decision function chooses which summary level to promote under continuing token pressure. Whether preparation is performed on demand or proactively in the background remains open. Any background work must be tied to the conversation revision it read. Budget pressure alone never authorizes excluding source messages before their replacement summary is saved.

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

1. A simple Connection manager.
2. A block-and-marker Prompt preset editor.
3. One Summaryception-style system for summaries and verbatim cutoff.
4. Enough chat, character, and persona functionality to use those systems for roleplay.

### Proposed scope limits

Defer broad provider-specific adaptation, semantic retrieval, automatic scene-boundary inference, character-specific memory permissions, multimedia systems, multiplayer, and a plugin ecosystem. These are scope recommendations, not permanent exclusions.

### First-milestone token-count decision

On 2026-10-16 the user approved allowing generation with a clearly labeled conservative estimate before model-specific tokenizers are available, enforcing the configured budget against that estimate. This is not a claim of exact provider token counting. The current implementation measures serialized-message UTF-8 bytes with additional framing allowances and separately checks the input target and the combined model window with reserved output. See [README.md](README.md) for the method and initial protocol subset. Verified tokenizer coverage remains future work.

### Decisions still open

- Project name and location-independent identity.
- Later database schemas and distribution packaging. Exact package versions, the initial chat/turn/generation schema, owner sessions, and a local launcher now exist; see [README.md](README.md). HTTPS certificate provisioning/trust and stronger credential storage protection remain open. These implementation choices do not settle future context schemas or product policies.
- Initial card and chat import/export formats.
- Detailed representation of turn and part revisions, regeneration, and branching behavior. Whole-turn deletion, independent part editing, and intentionally blank parts are accepted; archived turns remain editable.
- Numeric defaults for user-configured batch sizes, higher-layer grouping, the promotion decision function, summary output targets, and operational headroom within the target input context size. First-layer batches must have the configured fixed size; adaptive layer allowances and minimum retained summary counts remain proposals.
- Failure when required verbatim and non-summary input cannot fit the target is settled; the error presentation and explicit user recovery controls remain open. Changing settings on existing chats also remains open. Imported irregular histories must respect the accepted turn rules; their conversion policy is undecided.
- Whether partial or empty generated output can be explicitly accepted as completing a pending turn. Blank saved parts are now omitted from outgoing requests by user decision; this does not settle generated-output acceptance.
- Whether new generations wait for pending compaction or stale-memory repair, and what explicit continuation options exist when preparation fails.
- Manual-summary authority, repair review, diff-based revision versus full rebuilding, and the coverage of manually written summaries; see [the editing proposal](docs/CONTEXT_EDITING.md).
- Whether summarization uses the chat Connection or a separately selected Connection.
- Behavior when changing a strategy or its settings after summaries exist.
- Whether edits to shared Connections, Prompt presets, Characters, and Personas immediately affect existing chats.
- Whether agents ship in the first version and which triggers they support.
- Missing-marker and missing-agent-output behavior.
- Backup policy and generation-record retention.

## 8. Suggested first proof

The accepted implementation sequence is one persistent chat with one Connection, streaming, and request inspection, followed by durable layered compaction before expanding the full editors. See [IMPLEMENTATION.md](IMPLEMENTATION.md) for milestone acceptance checks. The experiment below remains the context-quality and reliability proof; it does not imply that every unresolved editing or branching policy is already selected.

Before building the full interface, validate the context system against a copied long-running chat, such as the approximately 400-message conversation discussed:

- Inspect summary quality against known story facts.
- Check that outgoing source coverage has no unintended overlaps or gaps.
- Interrupt processing and resume it.
- Simulate a failed summarization request and retry it.
- Edit an early message and verify dependency rebuilding.
- Branch midway through the conversation and verify that later events do not leak backward.
- Inspect the final outgoing request and its token budget.

Passing this experiment would support the project's main promise: understandable, dependable context handling for long-running roleplay.
