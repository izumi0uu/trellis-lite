# Trellis Lite Workflow

Trellis Lite is a bounded task loop for Codex and Oh My Pi. The user chooses the scope and verification cost before product-code execution. Those choices are durable task state, not suggestions.

## Triage

- Explanation, inspection, or a tiny one-file change may stay outside Trellis when the user does not want a task.
- A durable implementation task starts in `planning`.
- Repository facts are discovered from code. Ask the user only for scope, behavior, and risk choices.

## Required execution profile

Before `task.py start`, ask for the applicable choices and record them with:

```bash
python3 .trellis/scripts/task.py set-lite-profile <task> \
  --change-mode P0 \
  --verification-level V1 \
  --ui-verification-level U0 \
  --checker off \
  --allow 'frontend/**' \
  --forbid 'backend/**'
```

Do not infer a higher level from task complexity. If the user already supplied a choice in the current conversation, reuse it without asking again.

### Change mode

- `P0` — exact requested edit only. No new guards, abstractions, refactors, migrations, compatibility layers, or unrelated cleanup.
- `P1` — local defensive handling needed by the requested path; no architectural expansion.
- `P2` — normal production change across the necessary layers.
- `P3` — broad hardening or refactoring explicitly authorized by the user.

`allowed_paths` and `forbidden_paths` are hard boundaries when `scope_locked` is true. Ask before widening them.

### Code verification level

One V level covers both frontend and backend code checks. There are no separate frontend/backend levels.

- `V0` — no tests, lint, typecheck, or build.
- `V1` — one focused verification pass for the changed unit or file.
- `V2` — focused tests plus relevant lint/typecheck, up to three passes total.
- `V3` — broad project verification, up to eight passes total.

One Bash tool call consumes at most one code-verification pass, even when it
runs several related checks. Searches and file inspection do not consume a
pass merely because their arguments contain words such as `test` or `build`.
OMP persists the counter for the active task inside the current session, so an
extension reload does not reset it and switching tasks does not share it.

Do not repeat a failing check after a fix unless the remaining budget permits
it. When the budget is exhausted, report the evidence. The user may grant
exactly one additional pass with `/trellis-authorize-verification code`. The
normal agent tool loop cannot invoke this OMP slash command directly. This is
a workflow/runtime guard, not an OS-level security sandbox. `V0` can be changed
only by selecting a new profile, never by one-shot authorization.

### Browser/UI verification level

Browser/UI verification is independent of V. `V3` never overrides `U0`.

- `U0` — no browser/UI verification and no driver availability check.
- `U1` — one focused happy-path interaction.
- `U2` — one focused flow including the relevant boundary/error state.
- `U3` — up to three broader browser flows explicitly authorized by the user.

For `U1–U3`, use Ego Lite (`ego-browser`) by default. If Ego Lite is unavailable, tell the user immediately; do not install it and do not silently fall back. Playwright, Cypress, Selenium, or a project E2E suite may run only when the user explicitly selects that driver, recorded as `ui_driver`.

UI passes use a separate task-and-session counter. A Bash call containing both
code checks and UI automation consumes one pass from each applicable budget,
or none if either boundary blocks it. After exhaustion, only the user may grant
one additional UI pass with `/trellis-authorize-verification ui`; this cannot
override `U0` or the selected UI driver.

### Checker

- `off` — do not dispatch a checker.
- `report` — dispatch one read-only checker after implementation. It reports findings and does not edit files, run shell commands, or create a repair loop.

## Execution rules

1. Read the active task and its Lite profile before editing.
2. Implement the smallest change allowed by P and the path boundaries.
3. Run at most the selected V and U verification.
4. If verification finds a defect, fix it only when the fix stays inside the original scope and remaining budget. Otherwise report and ask.
5. Never turn a checker finding into automatic implementation.
6. Stop when the requested outcome is met; do not add speculative gates or tests.

## State routing

[workflow-state:no_task]
Classify the request. For a durable implementation, create a task in planning. For a tiny or conversational request, work directly unless the user asks for Trellis.
[/workflow-state:no_task]

[workflow-state:planning]
Confirm requirements, write the minimum useful PRD, ask for any unresolved P/V/U/checker choice, record the Lite profile, then run `task.py start`. Starting fails closed if the profile is missing or invalid.
[/workflow-state:planning]

[workflow-state:in_progress]
Read `task.json.lite`, implement within its scope, and obey its V/U/checker budgets. Do not enlarge the task because a defensive idea or additional test seems useful.
[/workflow-state:in_progress]

[workflow-state:completed]
Summarize the delivered behavior and selected verification evidence, then archive when requested. Do not run extra checks merely because the task is complete.
[/workflow-state:completed]
