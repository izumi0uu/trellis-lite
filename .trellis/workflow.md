# Trellis Lite Workflow

Trellis Lite is a bounded task loop for Codex and Oh My Pi. The user chooses the change scope and verification evidence before product-code execution. Those choices are durable task state, not suggestions.

## Triage

- Explanation, inspection, or a tiny one-file change may stay outside Trellis when the user does not want a task.
- A durable implementation task starts in `planning`.
- Repository facts are discovered from code. Ask the user only for scope, behavior, and risk choices.

## Required execution profile

Before `task.py start`, ask for the applicable choices and record them with:

```bash
python3 .trellis/scripts/task.py set-lite-profile <task> --preset focused \
  --allow 'frontend/**' \
  --forbid 'backend/**'
```

Offer one preset:

- `quick` — `P0 / V0 / U0 / checker off`.
- `focused` — `P1 / V1 / U0 / checker off`; recommended for normal work.
- `release` — `P2 / V3 / U0 / checker off`.
- `custom` — individual profile flags.

Presets are input shortcuts; only resolved profile fields persist. U and its driver
may be overridden independently. Reuse choices already supplied by the user and do
not raise a level from task complexity.

### Change mode

- `P0` — exact requested edit only. No new guards, abstractions, refactors, migrations, compatibility layers, or unrelated cleanup.
- `P1` — local defensive handling needed by the requested path; no architectural expansion.
- `P2` — normal production change across the necessary layers.
- `P3` — broad hardening or refactoring explicitly authorized by the user.

`allowed_paths` and `forbidden_paths` are hard boundaries when `scope_locked` is true. Ask before widening them.

### Verification contract

Verification is evidence, not implementation completion. Report implementation,
evidence, deferrals, and release readiness separately. Deferral does not block an
implementation goal; evidence disproving an acceptance criterion does.

One V level covers frontend and backend code evidence:

- `V0` — defer code verification.
- `V1` — run one focused evidence batch for the changed behavior or file.
- `V2` — run only the related checks selected in advance; run each once.
- `V3` — run only the release-readiness checklist selected in advance; run each once.

Name V2/V3 checks in the PRD or user-approved plan. Only that evidence set runs;
the level itself adds no checks.

Browser/UI evidence is independent of V. `V3` never overrides `U0`:

- `U0` — defer browser/UI verification and driver availability checks.
- `U1` — run one focused interaction on the changed path.
- `U2` — run the selected user flow and its relevant boundary/error state once.
- `U3` — run only the broader UI checklist selected in advance; run each flow once.

For `U1–U3`, default to Ego Lite (`ego-browser`). If unavailable, report it.
Other UI tools require an explicit `ui_driver` selection.

Run approved checks once. On failure, report and wait. Repair or re-verification
requires new natural-language user authorization and the original P/path boundary.
OMP cannot infer outcomes, so this is an agent contract.

OMP's numeric ceilings are internal circuit breakers, never plans or completion
criteria. Unused capacity remains unused. When tripped, the user may release the
next matching action with `/trellis-authorize-verification code|ui`. Only one release
may be outstanding; another may be granted after consumption. It never overrides
`V0`, `U0`, the UI driver, or the approved evidence set.

Use this completion report:

```text
Delivered: <implemented behavior, or incomplete + reason>
Verified: <evidence run once and its result, or none>
Deferred: <evidence intentionally left for later, or none>
Blocks current goal: <yes/no + reason>
```

Deferred release evidence may block a release goal while leaving implementation
complete.

### Checker

- `off` — do not dispatch a checker.
- `report` — dispatch one read-only checker after implementation. It reports findings and does not edit files, run shell commands, or create a repair loop.

## Execution rules

1. Read the active task's Lite profile and implement the smallest allowed change.
2. Apply the Verification contract; a failure stops the round.
3. Keep checker findings report-only.
4. Stop at the requested outcome and use the contract report.

## State routing

[workflow-state:no_task]
Classify the request. For a durable implementation, create a task in planning. For a tiny or conversational request, work directly unless the user asks for Trellis.
[/workflow-state:no_task]

[workflow-state:planning]
Confirm requirements, write the minimum useful PRD, offer quick/focused/release/custom, record the resolved Lite profile and any selected V2/V3 checks, then run `task.py start`. Starting fails closed if the profile is missing or invalid.
[/workflow-state:planning]

[workflow-state:in_progress]
Read the `lite` field in the active task's `task.json`, implement within its P/path scope, and apply the Verification contract before checking or reporting completion. Do not enlarge the task because a defensive idea or additional test seems useful.
[/workflow-state:in_progress]

[workflow-state:completed]
Report Delivered/Verified/Deferred/Blocks current goal as separate facts, then archive when requested. Task completion does not add verification.
[/workflow-state:completed]
