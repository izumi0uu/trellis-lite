# Trellis Lite Planning

Use this skill for a durable implementation task. Inspect the repository first; ask the user only for decisions the code cannot answer.

## Minimal planning loop

1. Create or reuse one task and keep its PRD concise.
2. Record the requested outcome, exact in-scope paths or layers, and explicit exclusions.
3. Read `.trellis/workflow.md` and offer its quick/focused/release/custom shortcuts. Recommend focused; ask only for unresolved choices or overrides.
4. For V2/V3, name the user-approved checks in the PRD. Treat every other check as deferred rather than manufacturing a broader validation plan.
5. Resolve any independent U override and driver choice under the workflow's UI boundary.
6. Write only the resolved profile fields with `task.py set-lite-profile`.
7. Present the compact plan and start only after the user authorizes implementation.

The Verification contract in `.trellis/workflow.md` is authoritative. Keep a small change small: the selected evidence set is a boundary, and internal ceiling capacity never expands it.
