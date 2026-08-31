---
name: trellis-start
description: "Starts or resumes the bounded Trellis Lite workflow, loading the active task and its P/V/U/checker execution profile."
---

# Start Trellis Lite

1. Run `python3 ./.trellis/scripts/get_context.py`.
2. If there is no durable implementation task, either work directly for a tiny request or create one when the user wants Trellis.
3. For a planning task, inspect the repository and prepare the minimum useful PRD.
4. Ask only for missing P/V/U/checker choices. One V level covers frontend and backend; U is independent.
5. Record the choices with `task.py set-lite-profile` before `task.py start`.
6. For an in-progress task, read `task.json.lite` and continue within those limits.

Full policy: `.trellis/workflow.md`.
