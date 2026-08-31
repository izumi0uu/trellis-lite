# Trellis Lite v1.0.0

This is the first independent Trellis Lite release, based on Trellis 0.6.16.
It is not an official Mindfold Trellis release and does not promise ongoing
upstream synchronization.

## Highlights

- Supports only Codex and Oh My Pi (OMP). Active integrations, registries,
  templates, adapters, and tests for other coding platforms were removed.
- Adds an explicit task profile before implementation:
  - `P0–P3` change-scope and code-style boundary;
  - one shared frontend/backend `V0–V3` code-verification level;
  - independent `U0–U3` browser/UI verification;
  - path boundaries and an optional read-only checker report.
- Makes `U0` an absolute no-browser/no-UI-verification choice.
- Uses Ego Lite by default for `U1–U3`; if it is unavailable, the agent reports
  that instead of installing or silently substituting another tool.
- Requires explicit selection before running Playwright, Cypress, Selenium, or
  a project E2E suite.
- Keeps the checker off by default. Report mode is read-only, runs once, and
  cannot modify code or start a repair/recheck loop.
- Adds native OMP runtime gates for profile-sensitive actions.
- Preserves project tasks, specs, workspace journals, and session history during
  managed updates.

## Distinct CLI identity

- npm packages: `trellis-lite` and `trellis-lite-core`.
- commands: `trellis-lite` and `tll`.
- the official `trellis` and `tl` commands are neither claimed nor modified.
- CLI banners, help, update prompts, diagnostics, templates, and bundled skills
  now point back to `trellis-lite ...` commands.

The v1.0.0 source release can be installed with `./scripts/install-cli.sh`.
Public npm publication is separate from this GitHub release and requires npm
owner credentials.

## Compatibility boundary

Historical migration manifests and narrow uninstall scrubbers remain so an
upstream-created project can safely remove obsolete managed files. They are
compatibility data, not active support for removed platforms.

Trellis Lite remains AGPL-3.0 licensed. Original attribution and Git history
are preserved.
