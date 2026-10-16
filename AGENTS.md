# AGENTS.md

## Project context

This is a new, independent roleplay application with persistent-chat and roleplay-library milestones implemented for local testing and a standalone synthetic compaction visualizer. “Roleplay Engine” is a working name. The accepted application stack is TypeScript, React + Vite, Node.js + Fastify, SQLite with better-sqlite3 + Drizzle, Zod, HTTP + SSE, Vitest, and Playwright. The Mac hosts the server and data; actual phone use awaits HTTPS certificate setup and verification. Application installation, build, launch, and test commands are documented in `README.md`. Character/persona/Connection libraries, the block-and-marker Prompt editor, chat selections and JSONL history replacement are implemented. Durable layered compaction follows as the third milestone and is not implemented. The Python/Tkinter visualizer is an isolated experiment; its launch and model-test commands remain documented in `docs/VISUALIZER.md`.

Read `CONCEPTS.md` before discussing architecture, proposing features, changing documentation, or implementing anything. It is the current product concept reference and explicitly distinguishes user requirements from proposed refinements and open decisions.

Read and follow `IMPLEMENTATION.md` when planning or implementing the application. It records the user-approved stack, module boundaries, deployment model, persistence and generation rules, and implementation sequence. Stack approval does not settle the open product policies in `CONCEPTS.md` or turn the simulator's experimental promotion policy into a requirement.

The user's goal is a focused personal tool for model connections, prompt composition, and dependable context management in long-running roleplay. Predictable behavior, inspectable model input, and control over summaries matter more than feature breadth.

## Working with ideas and decisions

- Treat requests for discussion, feasibility, comparison, or feedback as design conversations. Do not turn an exploratory idea into implementation unless the user requests implementation.
- Distinguish established requirements, newly accepted decisions, recommendations, and unresolved questions. An assistant's suggestion is not an accepted requirement merely because it appears in an earlier document.
- Follow the user's latest explicit decisions. Update relevant parts of `CONCEPTS.md` when asked to document an idea or when a decision clearly changes the established concept. Preserve unresolved alternatives as open questions rather than silently choosing one.
- Explain tradeoffs using concrete roleplay examples. Keep language clear and avoid unnecessary implementation detail during product discussion.
- Ask for clarification when a missing decision materially changes the requested outcome; otherwise proceed with reasonable, explicitly stated assumptions.
- Do not introduce a stack, framework, dependency, delivery schedule, or larger feature scope as an established choice without user agreement.

## Core vocabulary

- **Connection:** reusable endpoint, protocol, API key, model, token limits, and custom JSON request parameters. OpenAI-compatible is the initial priority; Anthropic-compatible may come later.
- **Prompt preset:** ordered text blocks and markers defining model input. Text blocks contain user-authored constants; markers obtain content from another source.
- **Context management system:** compacts older conversation and controls the verbatim cutoff. The initial desired method is Summaryception-style layered summarization. Additional strategies remain a future possibility.
- **Chat:** persistent conversation with selections for connection, prompt preset, context system, character, persona, and optional agents.
- **Turn:** primary stored conversation unit with user-input and assistant-response parts. Historical turns are complete; only the latest may await a response, blocking another turn while unresolved. Only whole turns can be deleted. Either part may be edited to an empty string without reopening a completed turn or merging content with neighbors. Completion and text length are separate concepts.
- **Character greeting:** accepted as a completed opening turn with an empty user part and a copied greeting in the assistant part; initialization is implemented for newly created chats. The first user action starts the next turn. Later reusable-greeting edits do not rewrite saved chats. Ordinary editing, deletion, summary coverage, and completed-turn counting apply; omit the empty user bubble and outgoing user entry. See `CONCEPTS.md` for the full rule.
- **Agent (product feature):** a task with its own instructions and selected connection, read access to conversation data, manual or automatic execution, and output available through a marker. Example: tracking fictional date and time.

“Agent” in product discussions refers to this application feature unless the user explicitly means coding assistants. Product-agent requirements do not authorize spawning coding subagents.

Stable turn and part identities/revisions and a Generation record showing resolved model input without credentials are accepted implementation directions. Separate reusable Character and Persona records are now implemented. Detailed schemas are not finalized. “Message” may still refer to an outgoing protocol entry, rather than the stored conversation unit.

## Design direction to preserve

The following directions are documented in `CONCEPTS.md`. `IMPLEMENTATION.md` establishes accepted core/persistence boundaries, transactional selection changes, revision checks, server-owned generation, and request inspection. Other refinements and detailed policies remain proposals unless explicitly accepted:

- Keep connection settings, prompt arrangement, history representation, agent output, and generation coordination separate.
- Separate reusable context strategy/configuration from each chat's summaries and processing state.
- Start with one active context strategy per chat and one managed context marker owning summaries plus recent verbatim messages.
- Preserve original messages; compaction changes model input rather than deleting the transcript.
- Save successful summaries before excluding their source messages, prevent duplicate source coverage, and expose unexplained gaps.
- Make retries and interrupted work safe. Account for edits, regenerations, branches, and stale background results.
- Treat recursive summaries as lossy and correctable. Do not promise perfect recall or lossless compression.
- Make outgoing context and effective parameters inspectable, with credentials excluded.

Evaluate new ideas against these goals and explain any proposed change to them. Keep the distinction between structural coverage and semantic summary quality explicit.

## Scope

The user moved roleplay libraries/editors and chat-history replacement ahead of context management. Those form the implemented second milestone; durable layered compaction with a verbatim cutoff follows as the third. See IMPLEMENTATION.md and README.md for current scope and limitations.

Agents are part of the concept model, but their inclusion in the first release is undecided. Broad provider-specific adaptation, semantic retrieval, scene detection, character-specific memory permissions, multimedia, multiplayer, and a plugin ecosystem are proposed deferrals, not permanent prohibitions.

## Repository and implementation boundaries

- This folder is separate from Marinara Engine. Marinara motivated the project; its architecture, dependencies, branch rules, and contributor workflow are not automatically this project's choices.
- Do not modify Marinara Engine or import its code, user data, or credentials unless the user requests that work. Inspect any relevant license before proposing code reuse.
- Preserve existing work and keep changes proportional to the request. Avoid speculative abstractions and scaffolding.
- Do not invent installation, build, or test commands. Once implementation establishes them, document the actual workflow here or in a dedicated contributor guide.
- For implemented behavior, validate the relevant user-facing claim and report what was tested and what remains unverified. Documentation-only changes need an accuracy and consistency review, not a fabricated test run.
- Use copied or synthetic chats for context experiments. Never destructively test against the user's original conversations.

## Current entry points

- `CONCEPTS.md`: purpose, definitions, proposed responsibility boundaries, reliability requirements, scope, open decisions, and a suggested first context-management experiment.
- `IMPLEMENTATION.md`: accepted stack and implementation guide; read before application work.
- `README.md`: actual application commands, first-milestone behavior, protocol subset, storage/security details, and verification limits.
- `start-app.command`: local application launcher, separate from the visualizer's `experiments/compaction/start.sh`.
- `src/`, `migrations/`, `tests/`: application modules, versioned SQLite schema, and synthetic core/server/browser checks.
- `AGENTS.md`: orientation and collaboration guidance for assistants working in this folder.
- `docs/VISUALIZER.md`: standalone simulator instructions, assumptions, and validation commands.
- `experiments/compaction/compaction_visualizer.py`: interactive layered timeline using saved per-request snapshots.
- `experiments/compaction/compaction_model.py`: UI-independent stateful synthetic budget model; preserve committed selections during forward continuation, never expand children merely to fill spare capacity.
