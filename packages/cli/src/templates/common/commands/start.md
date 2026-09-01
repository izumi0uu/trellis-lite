# Start Trellis Lite

1. Run `{{PYTHON_CMD}} ./.trellis/scripts/get_context.py`.
2. If there is no durable implementation task, either work directly for a tiny request or create one when the user wants Trellis.
3. For a planning task, inspect the repository and prepare the minimum useful PRD.
4. Offer the quick/focused/release/custom shortcuts from `.trellis/workflow.md`; recommend focused and ask only for unresolved choices or overrides.
5. For V2/V3, record the selected checks in the PRD. Persist only the resolved profile fields with `task.py set-lite-profile`, then run `task.py start`.
6. For an in-progress task, read the `lite` field in its `task.json` and apply the Verification contract.

Single source of truth: `.trellis/workflow.md`, especially **Verification contract**.
