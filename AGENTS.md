# AGENTS.md

## Purpose and working agreement

**ORE** (repository: Roleplay Engine) is a personal roleplay application for model Connections, prompt composition, persistent chats, and dependable context management. Predictable behavior, inspectable model input, and control over summaries take priority over feature breadth.

The user directs product decisions and manually tests features; they do not routinely review the code. **The implementing agent owns code quality, regression prevention, data safety, and technical verification.** Manual acceptance testing complements those responsibilities; it does not replace them. Deliver maintainable, complete changes and report verification honestly.

The accepted stack is TypeScript, React + Vite, Node.js + Fastify, SQLite with better-sqlite3 + Drizzle, Zod, HTTP + SSE, Vitest, and Playwright. The Mac hosts the server and data. Persistent chat, roleplay libraries, and durable layered compaction are implemented for local testing. HTTP LAN access is configured in Application Settings; HTTPS is deferred. Actual phone behavior and real-model summary quality remain unverified.

## Sources of truth and scope

- Read [CONCEPTS.md](CONCEPTS.md) before architecture discussion, feature proposals, documentation changes, or implementation. It distinguishes accepted requirements from recommendations and open questions.
- Read [IMPLEMENTATION.md](IMPLEMENTATION.md) before planning or implementing application changes. Follow its module boundaries, persistence rules, deployment model, and accepted behavior.
- Use [README.md](README.md) and [package.json](package.json) for actual commands, supported runtime, provider subset, and verification limits. Check the implementation when claiming what currently works.
- Read [docs/CONTEXT_EDITING.md](docs/CONTEXT_EDITING.md) for preparation, revisions, selection, or repair work; [docs/TOKEN_COUNTING.md](docs/TOKEN_COUNTING.md) for budgeting; [docs/DIAGNOSTICS.md](docs/DIAGNOSTICS.md) for Connection diagnostics.
- The Python visualizer is an isolated synthetic reference. Its workflow lives in [docs/VISUALIZER.md](docs/VISUALIZER.md); application commands and assumptions must not be substituted for it.

Follow the user's latest explicit decisions. If documents disagree in a way that affects the task, resolve the discrepancy from those decisions or ask a focused question; do not silently invent policy. Existing code demonstrates behavior, not necessarily intended behavior. An earlier assistant suggestion is not an accepted requirement.

Discussion, feasibility, comparison, and feedback requests stay design conversations until implementation is requested. During implementation, resolve routine technical details autonomously within the accepted design. Ask when a missing product decision materially changes behavior, data loss, compatibility, or scope. Explain tradeoffs using concrete roleplay examples. Do not introduce a new stack, framework, dependency, service, or larger feature scope without user agreement; existing authorization need not be requested again.

This repository is independent of Marinara Engine. Do not modify that project or import its code, data, or credentials without a request; inspect the relevant license before proposing code reuse. Branching, product agents, broad provider adaptation, retrieval, scene detection, character-specific memory permissions, multimedia, multiplayer, and plugins remain future/open decisions as described in CONCEPTS.md, not implied implementation tasks or permanent prohibitions.

## Before editing

1. Inspect the working tree and applicable instructions. Preserve pre-existing changes, including uncommitted work in files you need to edit. Never reset, clean, or overwrite unrelated work to obtain a convenient baseline.
2. Trace the affected workflow through its callers, shared contracts, persistence, and tests. Read surrounding code; do not patch only the first matching line or assume a similar function has identical semantics.
3. For a nontrivial change, state a short plan covering the expected user-visible outcome, owning modules, risks, and how success will be checked. Include failure/recovery behavior for saved state or asynchronous work. Keep planning proportional to the task.
4. For a bug, establish the failing scenario and identify the broken invariant before fixing it. Prefer a regression test that reproduces the failure; if reproduction is blocked, distinguish confirmed evidence from hypotheses.
5. Identify existing helpers and tests to extend. Make the smallest coherent change that solves the underlying problem across affected paths, even if that requires more than a one-line patch.

## Module ownership

| Location | Responsibility | Boundary to preserve |
| --- | --- | --- |
| `src/core/` | Turn rules, prompt resolution, budgeting, context selection, coverage, repair decisions | Explicit inputs and outputs; no React, Fastify, database, or provider I/O dependencies. |
| `src/shared/` | Browser-safe contracts, runtime schemas, shared definitions | No credentials, server-only imports, or accidental exposure of persistence records. |
| `src/persistence/` and `migrations/` | Durable state, revisions, schema upgrades, atomic mutations | Enforce commit-time invariants; callers must not bypass transaction/revision safeguards. |
| `src/server/` | Authentication, HTTP/SSE, generation and preparation coordination | Handlers validate and delegate; coordinators own operation lifecycles, not duplicated context algorithms. |
| `src/provider/` | Request encoding, stream decoding, transport errors and cancellation | Does not select history, advance cutoffs, or decide summary coverage. |
| `src/web/` | Editing, inspection, progress and recovery controls | Displays authoritative server state; UI disabling is not a concurrency or integrity guarantee. |
| `tests/` | Core, database, server, crash and browser verification | Synthetic/copy fixtures, temporary databases, controlled provider behavior. |
| `experiments/compaction/` | Standalone Python model and visualizer | Preserve accepted state-transition parity without importing simulation assumptions into production. |

Keep Connection settings, prompt arrangement, context configuration, per-chat state, and generation coordination separate. Reuse the authoritative request assembly and token measurement paths for generation, previews, and Memory planning; do not create parallel approximations in the UI.

## Maintainable implementation

- Prefer explicit, readable control flow and names that describe domain meaning. Break apart dense functions when distinct responsibilities obscure validation, state transitions, or failure handling. Avoid packing several mutations or branches onto one line; existing compressed code is not a style requirement.
- Extract a helper/module when it isolates a meaningful responsibility or removes duplicated policy. Avoid speculative frameworks, generic repositories, plugin scaffolding, and arbitrary file-size targets. A large file is a reason to inspect cohesion, not permission for an unrelated rewrite.
- Fix defects where the rule is owned. Do not hide a server bug with UI-only filtering, special-case a fixture, or copy a workaround into several callers. Check sibling paths such as automatic, manual, single-step, and repair workflows when they share the affected rule.
- Keep TypeScript strict. Use explicit states and narrowed unions where states differ; avoid bundles of booleans that permit impossible combinations. Validate external input with Zod or the established boundary parser. Do not use `any`, unchecked casts, non-null assertions, or compiler suppressions to conceal uncertainty; narrow or validate it. Any necessary exception must be local and explained.
- Preserve one authoritative definition of contracts and domain rules. Reuse shared schemas/types where appropriate; update consumers together when a contract changes. Browser code must not import database or secret-bearing server types for convenience.
- Handle expected failure states explicitly. Do not swallow exceptions, report success after a failed write, return empty data for an unexpected error, or silently apply an undocumented fallback. Preserve useful diagnostic causes while showing safe, actionable errors to the user.
- Comments should explain a non-obvious invariant, compatibility constraint, or reason for an ordering decision. Remove misleading comments and obsolete paths made unnecessary by the change. Do not leave placeholder implementations, test-only branches, or unresolved TODOs in a required feature path.
- Keep refactoring and behavior changes distinguishable. Preserve existing behavior unless the task changes it, and avoid unrelated formatting churn or opportunistic dependency upgrades. Use existing dependencies first; update the lockfile with any authorized dependency change.
- Keep work bounded for long conversations: avoid repeated full-history scans, unbounded caches, and large synchronous transformations in request or render loops when a bounded approach is available. Validate performance-sensitive changes with representative synthetic data before claiming improvement; do not optimize by dropping history or skipping integrity checks.

## Persistence, asynchronous work, and recovery

- Treat saved chats, summary corrections, and request history as user data. Never make a migration or test pass by deleting the database, resetting memory, rewriting history, or silently discarding records.
- Add versioned migrations for schema/data upgrades; do not rewrite already-applied migrations. Keep schema definitions, migration registration, and reads/writes consistent. Exercise both fresh creation and upgrade from an affected older populated database. Preserve identities, revisions, text, selections, and historical requests unless an explicitly accepted migration changes them.
- Keep SQLite writes transactional and short. Perform provider/network calls outside transactions; recheck captured operation, source, configuration, and selection revisions inside the committing transaction. A successful earlier check does not authorize a later stale write.
- Commit coupled changes together: for example, save a summary and switch its selection/cutoff atomically. A failed write must retain the last valid committed state. Preserve completed steps when a later step fails.
- Enforce per-chat operation ownership, pending-turn limits, shared-record edit restrictions, and revision checks on the server. Account for simultaneous tabs/devices, repeated commands, and delayed responses. Preserve independence between unrelated chats.
- Treat cancellation, browser disconnection, provider failure, and server interruption as different events. Generation belongs to the server; disconnecting an SSE observer does not cancel it. Reject late results after cancellation or supersession, reconcile current saved state on reconnect, and release listeners/timers/resources on every exit path.
- Retries must be explicit and safe against duplicate commands, duplicate coverage, and repeated progress. Restart loads committed state and exposes interrupted work; it must not silently repeat paid requests or claim a provider stream can resume.
- Keep historical request bodies, estimates, source revisions, and endpoint usage immutable while retained. New edits affect future work and create the required versions; they do not rewrite what an earlier request received. Respect documented whole-turn deletion, history replacement, and Clear memory semantics.
- Never use the user's active database or original transcript for destructive testing. Use temporary databases and synthetic/copied fixtures. A live SQLite WAL database requires a consistent backup method; copying only its main file is not a dependable backup. Do not claim restore safety without testing it.

## Product invariants to protect

These are review reminders; consult CONCEPTS.md and IMPLEMENTATION.md for the full policies and later accepted changes.

- **Vocabulary:** a Connection owns endpoint/protocol/credentials/model/limits/custom parameters; a Prompt preset arranges text blocks and source markers; a context preset is reusable configuration, distinct from each chat's saved memory. Character and Persona are separate reusable records. “Agent” in product discussion means an auxiliary application task with instructions, a Connection, conversation access, execution triggers, and marker output; it does not authorize coding subagents.
- **Turns:** only the latest turn may be pending; another submission is blocked until it is resolved. Completion is independent of text length. Either part of a completed turn can be intentionally empty; only whole turns are deleted. Omit blank outgoing parts without losing turn membership or coverage. Blank/failed/cancelled generated output does not become a completed response. A copied character greeting is a completed opening turn, and later reusable edits do not rewrite it.
- **Prompt authority:** enabled blocks/markers compose the base prompt; the selected lorebook inserts eligible entries relative to included character fields or Messages. Unchecked/empty Character fields cannot anchor lore, and missing Messages cannot implicitly redirect history lore. Character expands checked fields as separate messages in fixed order. Empty/missing-marker presets may be saved; warnings are advisory. Default/new templates include Summary. With Summary enabled, Summary and Messages share managed coverage. Without Summary, Messages uses a request-local newest contiguous suffix of whole turns that fits; no summary work or saved-cutoff restriction applies, and saved memory stays intact. Missing Messages inserts no turns. Empty resolved requests fail before a provider call.
- **Coverage and selection:** compaction preserves the transcript, saves a replacement before excluding its sources, and prevents overlaps/unexplained gaps in managed coverage. Ordinary continuation preserves committed selections; spare capacity does not reactivate children. Manual Prepare may reselect fresh saved memory under the accepted pressure policy, protecting manual corrections and recording before/after state. Reuse exact fresh replacements before generating missing ones; a fitting saved selection makes no model calls. Automatic and single-step preparation reuse without expanding history. The old Refresh button is superseded, but its history remains inspectable.
- **Budgets:** use the shared `cl100k_base` reference counter for complete resolved input, allocations, savings, and summarization checks. Separate the input target from physical capacity/output reservation. Preserve fixed batches, protected tails, residual turns, and the accepted geometric-pressure promotion rule. Fail when required input cannot fit; never silently truncate sources, lower guarantees, or exceed the target. Endpoint usage is a separate observation, not a calibration rule or exact-limit guarantee.
- **Repair and provenance:** archived edits invalidate affected summaries and their dependents, including higher layers and earlier-context consumers. Scope repair to current dependencies required by selected memory. Changed repairs require review before becoming active; approval saves before generating dependents. Close cancels work and discards the unapproved candidate/local edits, while retaining approved progress; reopening generates fresh work. Do not add draft persistence. Use the separate repair prompt, complete before/after incorporated inputs, and original prior dependencies. Unknown historical baselines, changed coverage, or changed text require review. Exact unchanged model results may save automatically only with known inputs and unchanged structure; entirely unchanged consumed inputs may be revalidated locally. Distinguish those outcomes, preserve manual corrections/versions, and never clear downstream staleness indiscriminately.
- **Limits of validation:** structural coverage, exact text equality, and refusal heuristics do not establish semantic summary quality or perfect recall. Preserve that distinction in tests, UI, documentation, and completion reports.

## Security and user interface

- Keep saved credentials on the server. Exclude them from ordinary API responses, previews, logs, errors, fixtures, and exports. Deliberately map public response fields instead of serializing database rows. Use synthetic secrets to test exclusion.
- Preserve authentication, origin checks, credential forwarding restrictions, LAN admission policy, and TLS requirements where configured. HTTP LAN access is an accepted mode; do not weaken its restrictions to make development or browser tests easier. Validate IDs, revisions, numeric limits, imported data, custom parameters, and provider responses at their actual trust boundaries.
- Treat imported cards, transcripts, model output, and remote errors as untrusted data. Do not execute embedded instructions/HTML or enable unsupported card features during import. Preserve supported round-trip metadata without making it active.
- Routine automated tests use the local mock provider. Do not substitute saved credentials or send private conversations to a real endpoint merely to verify a change. Real-provider checks must be within the user's authorized scope; report their limited coverage.
- Make loading, empty, failed, cancelled, stale, and completed states understandable for affected flows. Show committed success only after the server confirms it. Preserve recoverable user input on failed saves, except where the accepted workflow explicitly discards drafts.
- Guard UI requests/subscriptions against stale responses after chat or selection changes. Clean up effects and prevent duplicate submissions without relying on that prevention for server integrity. Keep authoritative state distinct from unsaved editing drafts.
- Reuse established controls and styling. Preserve labels, keyboard access, focus behavior, readable errors, and desktop/phone layouts. Keep implementation details out of ordinary product flows unless they help the user make a decision.

## Verification requirements

Choose checks by the behavior at risk. A successful build alone does not establish correctness, and asking the user to click through a feature is not a substitute for automated checks the agent can run.

| Change | Expected evidence |
| --- | --- |
| Core policy or bug fix | Focused Vitest checks of observable behavior, boundaries, and the regression. Check invariants across a sequence when state carries forward. |
| Persistence, migration, or operation lifecycle | Tests using real temporary SQLite databases/coordinators: successful commit plus relevant rollback, stale revision, duplicate command, cancellation, or reopen/restart cases. |
| Provider or request assembly | Controlled mock-provider tests of exact outgoing input/parameters, credential exclusion, and affected malformed/failed/incomplete stream cases. |
| User workflow or interaction | Relevant Playwright workflow with meaningful state assertions; inspect desktop and phone-sized rendering when layout changes. |
| Pure styling/copy or documentation | Proportionate visual or accuracy/consistency review; do not invent tests that merely assert wording, class names, or implementation details. |

- For a reproducible defect, add a regression test and establish that it fails for the original reason before the fix when feasible. Derive expectations from the requirement, not by copying the implementation's calculation into the test.
- Test important failures and boundaries alongside the happy path. For example, editing an archived turn must leave all its direct memory consumers stale even when another repaired consumer returns unchanged. Assert saved state and model-call counts when no-call/reuse behavior is part of the promise.
- Use real core/persistence paths for integration tests and mock external transport at the boundary. Avoid mocking away the invariant under test. Keep fixtures deterministic, isolated, and representative; wait for observable conditions instead of arbitrary sleeps, and clean up test processes/databases.
- Never delete, skip, weaken, or rewrite a failing expectation solely to obtain a green run. An accepted behavior change may require updating a test; explain why its old expectation no longer applies and retain meaningful coverage. Do not loosen types, validation, security, or error handling to satisfy a test.
- Investigate relevant failures and fix those introduced by the change. Distinguish demonstrably pre-existing failures and environment blockers from regressions; a rerun that happens to pass is not evidence that a flaky failure is resolved.

### Commands

Use the supported Node/npm environment from README.md; better-sqlite3 is native, so changing Node major versions can require reinstalling dependencies. Run commands from the repository root.

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked dependencies when needed. |
| `npm run typecheck` | Strict client/server TypeScript checks. |
| `npm test` | All Vitest core/server/persistence tests. |
| `npm test -- tests/context-core.test.ts` | Example of a focused existing Vitest suite; select the suite relevant to the change. |
| `npm run build` | Typecheck and build the interface/server. |
| `npm run test:e2e` | Browser workflows against the built interface and an isolated test server. |
| `npm run check` | Build, Vitest, and browser suites together. |

Use focused checks while iterating. Before handing off application code, run `npm run check`; running its constituent commands successfully against the final changes is equivalent. Build before browser tests because they serve `dist/client`. If an environment restriction prevents a required check, report the exact missing verification and reason rather than claiming completion of validation. Pure documentation changes require consistency/link/command review, not an application test run. Chromium installation and local-server requirements are documented in README.md. There is no separate lint script; do not claim to have run one.

## Final review and handoff

Before declaring completion, read the final diff as a reviewer. Trace the changed behavior through affected callers and error paths, not just new lines. Check for violated product invariants, data loss, stale writes, credential exposure, missing migration/compatibility handling, duplicated policy, dead code, and tests that would pass even if the feature were broken. Fix findings within scope and rerun affected checks. Do not treat passing tests or a review tool's approval as proof that no defects remain.

Update documentation when the change affects accepted behavior, architecture, operation, or verification claims. Put product decisions in CONCEPTS.md, implementation contracts in IMPLEMENTATION.md, commands/current limitations in README.md, and detailed subsystem explanations in `docs/`. Keep this file focused on durable working rules; do not append a feature diary or duplicate full specifications. This guidance does not authorize unrelated cleanup or retroactive application of every style preference.

The final report should state the outcome, relevant checks actually run and their results, and any remaining limitations or unresolved risks. Provide a short manual acceptance path when it helps the user assess the feature. Clearly distinguish implemented, automatically tested, manually observed, and unverified behavior. Do not claim real-provider quality from mock responses, actual phone support from emulation, or a clean test run when required checks were blocked.
