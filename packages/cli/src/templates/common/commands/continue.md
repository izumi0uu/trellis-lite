# Continue Trellis Lite

Run:

```bash
{{PYTHON_CMD}} ./.trellis/scripts/get_context.py
```

Then route by task status:

- `planning`: finish the concise PRD, present the workflow presets with their resolved P/V/U/checker values, let the user accept or override each value, record the profile plus any selected V2/V3 checks, and start only with user authorization.
- `in_progress`: read the `lite` field in the active task's `task.json`, implement within the selected scope, and apply the Verification contract without turning its preferences into command quotas.
- `completed`: report Delivered/Verified/Deferred/Blocks current goal; task completion does not add verification.
- no task: work directly for a tiny request or create a task when the user wants a durable loop.

Single source of truth: `.trellis/workflow.md`, especially **Verification contract** and its independent UI-driver boundary.
