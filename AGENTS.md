# AGENTS.md

## Purpose and working agreement

**ORE** (repository: Roleplay Engine) is a personal roleplay application for model Connections, prompt composition, persistent chats, and dependable context management. Predictable behavior, inspectable model input, and control over summaries take priority over feature breadth.

The user directs product decisions and manually tests features; they do not routinely review the code. **The implementing agent owns code quality, regression prevention, data safety, and technical verification.** Manual acceptance testing complements those responsibilities; it does not replace them. Deliver maintainable, complete changes and report verification honestly.

Before creating a merge commit, discuss its proposed message with the user and wait for agreement on the wording. If the user has already supplied the exact message, use it.

## Scope and sources of truth

Discussion and review stay at the design stage until implementation is requested. Follow the user's latest explicit decisions. Resolve routine technical choices independently. Ask when a missing decision affects product behavior, data preservation, compatibility or scope, using a concrete roleplay example where helpful. A prior suggestion, test or existing implementation alone cannot settle product policy. Obtain agreement before introducing a dependency, framework, service or broader feature. Marinara Engine is independent. Modifying it or importing its code, data or credentials requires a request. Inspect the license before proposing reuse.

Use the sections relevant to the task:

| Question | Primary reference |
| --- | --- |
| What behavior has the user accepted? | [Product contract](CONCEPTS.md), including [open decisions](CONCEPTS.md#open-decisions-and-scope). Consult before design, documentation or implementation. |
| Where does the change belong? | [Architecture and module map](IMPLEMENTATION.md#module-map). Before planning or implementing, read the affected architecture sections, including [generation and provider transport](IMPLEMENTATION.md#generation-and-transport) for Connections. |
| How do memory selection, budgeting and repair work? | [Memory contract](docs/CONTEXT.md) |
| What may enter a prompt or round-trip through an import? | [Compatibility contract](docs/COMPATIBILITY.md) |
| How do backups, credentials and protected files work? | [Data contract](docs/DATA.md) |
| How do I install, develop or qualify a release? | User setup in [Russian](README.md) or [English](README.en.md). [Development commands](IMPLEMENTATION.md#development-commands) and [npm scripts and supported runtime](package.json). For packaging and recovery use the [release guide](docs/RELEASES.md), including the [minimum launcher check before qualification](docs/RELEASES.md#windows-launcher-version-management). |
| How do I run the synthetic Python visualizer? | Follow the isolated [compaction lab workflow](experiments/compaction/README.md). |

## Before editing

1. Inspect the working tree and applicable instructions. Preserve existing changes, including edits in files the task touches.
2. Trace the workflow through callers, shared contracts, persistence and tests. Identify the owning module and sibling paths that enforce the same rule.
3. State the risk and how you will check it. For nontrivial changes, include the user-visible outcome, affected modules and how saved or asynchronous work recovers.
4. For a bug, establish the failing scenario and explain the broken invariant before editing. Reproduce it with a regression test when feasible. Distinguish confirmed evidence from hypotheses when reproduction is blocked.

## Implementation and data safety

- Fix the rule in its owning module across equivalent inputs and workflows. Reuse shared schemas, request assembly and token measurement. Special cases need a domain or compatibility reason. Preserve user input on validation failure.
- Use readable control flow, names and explicit states. Keep TypeScript strict. Narrow or validate uncertain values with Zod or the established boundary parser. Explain any necessary local type exception. Update producers and consumers together.
- Keep refactoring distinguishable from behavior changes. Extract helpers for a distinct responsibility or shared policy. Explain non-obvious invariants, remove obsolete paths, and keep required paths free of placeholders and test-only branches. Update the lockfile for authorized dependency changes.
- Keep long-chat reads and rendering bounded where possible. Measure performance claims with representative synthetic data while preserving history and integrity checks.
- Use versioned migrations and test both fresh creation and upgrade from a populated older database. Preserve identities, revisions, corrections, selections and retained historical requests. Applied migrations stay immutable.
- Enforce branch operation ownership and pending-turn limits on the server. Chat-wide settings and shared library mutations must check all affected branches. Perform provider work outside SQLite transactions. Recheck ownership and captured revisions inside the short transaction that commits coupled changes.
- Distinguish cancellation, observer disconnect, provider failure and restart. Reject late results, reconcile on reconnect and release resources on every exit path. Preserve completed steps. Explicit retries must be safe after an uncertain acknowledgement. Preserve retained request bodies, estimates, source revisions and endpoint usage. Restart must never silently repeat paid work.
- Use temporary databases and synthetic or copied fixtures for destructive tests. Live SQLite backups must include committed WAL data. Verify restoration before claiming restore safety. Use the local mock provider for routine tests and synthetic keys for credential checks. Real-provider use requires authorization.
- Validate imports, provider responses and commands at the trust boundary. Preserve authentication, origin, LAN admission, TLS and credential-forwarding rules. Map public fields explicitly and exclude credentials from ordinary responses, logs, errors and previews. Only documented protected exports may carry saved keys. Keep untrusted HTML, instructions and unsupported metadata inert.

## Interface changes

- Read the [localization contract](docs/LOCALIZATION.md) before changing application text. Maintain English and Russian together, including accessibility text. Carry core and server diagnostics as `LocalizedMessage` descriptors with English fallbacks and translate them at presentation time. Remove unused keys after checking consumers and retained historical diagnostics. Keep model-bound text and user content literal.
- Reuse existing controls, shared styles and semantic palette roles. Read the [palette rules](docs/PALETTE.md) before styling. New colors, changed values or derivations, and expanded exceptions require explicit agreement. Preserve the palette fixtures and guards.
- Preserve keyboard access, focus and desktop/phone layouts. Distinguish loading, empty, failed, stale, cancelled and completed states. Report success after server confirmation, keep recoverable drafts on failure, and guard subscriptions and responses against changes of branch or selection.

### Design conventions for new or revised UI

- **Connection and model dropdowns.** Keep the selected name on one line. Use the shared dropdown’s `fadeLabel` option to fade the trailing edge only when the text overflows. Show the full name in the open menu.
- **Underlined navigation tabs.** Use the underline to identify the selected tab. Omit the pointer-press outline and preserve a visible keyboard focus indicator.
- **Short numeric settings.** Align value fields in a compact column close to their labels, including on wide screens. Use the available panel width to determine when the rows need to reflow.
- **Expandable rows with separators.** Leave space between each clickable heading and the separator lines so its hover fill, pressed outline and keyboard focus indicator stay clear of the lines.
- **Editor help.** Place brief guidance beside the field it explains. Include extra detail when it helps someone make a choice or recover from an error. Omit routine explanations of internal mechanics.

## Verification requirements

Choose checks by the behavior at risk and the reach of the change, not by line count or file extension. Before editing, briefly identify what could break and the checks that will address it; a sentence is enough for a small change. Inspect shared consumers when judging scope: a local margin adjustment differs from changing a global layout rule, just as an icon differs from a one-line transaction change. A successful build alone does not establish behavioral correctness, and asking the user to click through a feature is not a substitute for the agent's required verification.

| Change | Expected evidence |
| --- | --- |
| Documentation only | Accuracy, link, and command consistency review; no application build or test suite required. |
| Isolated styling or copy | Inspect the affected UI; check relevant desktop/phone sizes and both sides of changed breakpoints for layout changes. Use an existing focused browser check when useful. No unrelated Vitest or full browser suite required. |
| Static SVG/icon addition or replacement | Build (includes typechecking) and inspect affected controls for rendering, alignment, sizing and accessible labels. No unrelated suites required when interaction and state behavior are unchanged. |
| Core policy or functional bug fix | Focused Vitest checks of observable behavior, boundaries, and the regression. Check invariants across a sequence when state carries forward. |
| Persistence, migration, or operation lifecycle | Tests using real temporary SQLite databases/coordinators: successful commit plus relevant rollback, stale revision, duplicate command, cancellation, or reopen/restart cases. |
| Provider or request assembly | Controlled mock-provider tests of exact outgoing input/parameters, credential exclusion, and affected malformed/failed/incomplete stream cases. |
| User workflow, interaction or UI state | Build, relevant Playwright workflows with meaningful state assertions, and affected unit tests. Inspect desktop and phone-sized rendering when layout changes. |
| Broad refactoring, dependencies, build/test infrastructure, or uncertain impact | User-run full `npm run check`, plus agent-run focused evidence for changed behavior that existing suites do not cover. |

- Combine the applicable rows for mixed changes and expand verification when shared consumers or failures reveal wider impact. Do not classify a behavior change as cosmetic because its diff is small.
- For new or changed UI, inspect affected controls and states in every shipped theme at relevant desktop and phone sizes. Check readability, surfaces, borders, icons, interaction states and semantic colors. Extend existing theme tests where appropriate; duplicating the entire workflow suite for every theme is unnecessary.
- For a reproducible functional defect, add a regression test and establish that it fails for the original reason before the fix when feasible. Where feasible, also verify an equivalent case that differs from the reported example, choosing the variation to challenge the claimed generality of the fix. Derive expectations from the requirement, not by copying the implementation's calculation into the test. Isolated cosmetic corrections may use focused visual verification; do not invent tests that merely assert wording, class names, SVG paths, or implementation details.
- Test important failures and boundaries alongside the happy path. For example, editing an archived turn must leave all its direct memory consumers stale even when another repaired consumer returns unchanged. Assert saved state and model-call counts when no-call/reuse behavior is part of the promise.
- Use real core/persistence paths for integration tests and mock external transport at the boundary. Avoid mocking away the invariant under test. Keep fixtures deterministic, isolated, and representative; wait for observable conditions instead of arbitrary sleeps, and clean up test processes/databases.
- Never delete, skip, weaken, or rewrite a failing expectation solely to obtain a green run. An accepted behavior change may require updating a test; explain why its old expectation no longer applies and retain meaningful coverage. Do not loosen types, validation, security, or error handling to satisfy a test.
- Investigate relevant failures and fix those introduced by the change. Distinguish demonstrably pre-existing failures and environment blockers from regressions; a rerun that happens to pass is not evidence that a flaky failure is resolved.

### Full-suite checkpoints and efficient execution

- **Full-suite execution belongs to the user.** Agents must not run `npm run check`, unfiltered `npm test`, unfiltered `npm run test:e2e`, or equivalent commands that execute a complete test suite. Do not bypass this restriction through wrappers, background processes, CI dispatches, or splitting the complete suite into batches. Existing automatic release CI qualification remains unchanged; agents must not trigger it to offload a development verification run.
- Agents own investigation, implementation, regression prevention, and targeted verification. Select explicit test files or test names relevant to the affected behavior. Builds and typechecks remain agent-run when required; a build already includes typechecking. Build before browser checks when application sources changed because they serve `dist/client`.
- The checks above are sufficient for an ordinary handoff within their stated scope; a full suite is not required after every application edit or commit. Preserve user-run full-suite checkpoints before distributing an updated version, at the completion of a substantial batch of related application changes, and for broad or uncertain changes listed above. A batch checkpoint means completing a larger feature or a group of changes across workflows, not each small cosmetic task. Request broader verification when focused checks cannot establish affected saved-data, authentication, context-coverage or operation-recovery boundaries, explaining the concrete risk; touching a server or shared file alone does not require it.
- At a full-suite checkpoint, complete targeted verification and final review, then give the user the exact command, working directory, and reason for the broader run. End the turn with full verification explicitly pending. Do not monitor or poll a user-run suite, schedule follow-ups, or remain active waiting for completion. Resume when the user supplies results: the final summary and failure details or a log path. Distinguish failed, interrupted, and not-executed stages; `npm run check` stops at the first failed stage.
- Fix reported failures using focused reproduction and regression checks, then hand back any required full-suite rerun. Do not repeat successful checks against unchanged relevant code, dependencies and test configuration unless new evidence justifies it. Successful constituent commands against the final state may satisfy a checkpoint; account for stages that never ran and rerun only checks whose inputs changed.
- Full-suite execution by the user does not transfer responsibility for code quality or failure investigation. Report agent-run checks separately from user-reported results. Never claim complete verification while a required checkpoint remains pending.

## Final review and handoff

Before declaring completion, read the final diff as a reviewer. Review the chosen behavior as well as its implementation: could all added tests pass while another ordinary instance of the reported failure class remains unresolved? Trace the changed behavior through affected callers and error paths, not just new lines. Check for violated product invariants, data loss, stale writes, credential exposure, missing migration/compatibility handling, duplicated policy, dead code, and tests that would pass even if the feature were broken. Fix findings within scope and rerun affected checks. Do not treat passing tests or a review tool's approval as proof that no defects remain.

Maintain only current product decisions, non-obvious implementation/safety/compatibility contracts, and installation/update/recovery instructions. Put product rules in CONCEPTS.md, architecture/development in IMPLEMENTATION.md, tester setup in README.md, and detailed rules in the existing owning document under `docs/`. Link instead of duplicating policy. Do not create per-feature documents, preserve completed implementation briefs, append test-result diaries, or add community-process files for the current small testing group. Record verification in the task/release handoff; Git history preserves superseded material. Keep this file focused on durable working rules. This guidance does not authorize unrelated cleanup or weakening verification.

The final report should state the outcome, relevant checks actually run and their results, and any remaining limitations or unresolved risks. When using focused verification, state its scope and that the full suite was not run; this is a valid handoff under the policy above. Provide a short manual acceptance path when it helps the user assess the feature. Clearly distinguish implemented, automatically tested, manually observed, and unverified behavior. Do not claim real-provider quality from mock responses, actual phone support from emulation, or a clean test run when required checks were blocked.
