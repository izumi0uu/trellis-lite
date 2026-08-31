---
name: trellis-continue
description: "Resume the current Trellis Lite task at planning, bounded implementation, or completion."
---

# Continue Trellis Lite

Run:

```bash
python3 ./.trellis/scripts/get_context.py
```

Then route by task status:

- `planning`: finish the concise PRD, ask for any missing P/V/U/checker selection, write the Lite profile, and start only with user authorization.
- `in_progress`: read `task.json.lite`, implement only the selected scope, and use at most its V and U budgets.
- `completed`: report the delivered outcome and existing evidence; do not add verification.
- no task: work directly for a tiny request or create a task when the user wants a durable loop.

For U1–U3, Ego Lite is the default. If unavailable, tell the user and stop browser verification; never silently fall back.
