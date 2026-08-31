# Trellis Lite Check

Perform one bounded, report-only review when `task.json.lite.checker` is `report`. If it is `off`, do not run a checker.

## Rules

- Read the task PRD, Lite profile, relevant diff, and applicable specs.
- Inspect only. Do not edit files, run shell commands, invoke tests, or dispatch another agent.
- Check the requested behavior, P/path scope, and whether executed verification exceeded V or U.
- Prefer concrete file and line evidence. Do not propose unrelated hardening.
- Return findings grouped by severity, followed by a short verification-evidence summary.
- If there are no findings, say so. Never create a fix/check loop.
