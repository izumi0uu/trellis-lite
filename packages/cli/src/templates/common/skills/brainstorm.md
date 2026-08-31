# Trellis Lite Planning

Use this skill for a durable implementation task. Inspect the repository first; ask the user only for decisions the code cannot answer.

## Minimal planning loop

1. Create or reuse one task and keep its PRD concise.
2. Record the requested outcome, exact in-scope paths or layers, and explicit exclusions.
3. Ask for any missing Lite execution choices before implementation:
   - change mode: P0–P3
   - code verification: V0–V3 (one shared level for frontend and backend)
   - browser/UI verification: U0–U3
   - checker: off or report
4. If U1–U3 is selected, default to Ego Lite. Select Playwright, Cypress, Selenium, or project-suite only when the user explicitly authorizes it.
5. Write the profile with `task.py set-lite-profile`.
6. Present the compact plan and start only after the user authorizes implementation.

Do not manufacture extra product questions, design documents, guards, migrations, or test plans for a small change. The selected P/V/U levels are hard limits, not minimum quality targets.
