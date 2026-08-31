# Trellis Lite v1.0.1

This release adds the supported migration path from existing Trellis projects
to the independent Lite line. Do not delete `.trellis/` or run official
Trellis uninstall first: `trellis-lite adopt` takes ownership while preserving
the existing documents and runtime state.

## Safe project adoption

```bash
cd /path/to/existing-project
trellis-lite adopt --dry-run --codex --omp
trellis-lite adopt --codex --omp --yes
```

The command:

- accepts only the final stable Trellis `0.6.16` baseline, including the final
  audited task-reuse and legacy Lite overlay outputs;
- rejects earlier Trellis releases, `0.7.0-beta.*`, unknown forks, and Lite
  projects; Lite `1.0.x` projects continue with `trellis-lite update`;
- performs a no-write conflict preflight before creating or changing files;
- recognizes only the final reviewed `0.6.16` `trellis-lite` and
  `trellis-task-reuse` overlay bytes;
- creates a verified backup outside the project by default;
- preserves and byte-compares tasks, specs, workspace journals, developer
  identity, active-task pointers, session runtime data, backlog, and traces;
- archives old `trellis-meta`, `cli_adapter.py`, and overlay receipts inside the
  external backup;
- rolls the managed roots back to their original snapshot if any write or
  post-adoption verification fails;
- refuses symlinked managed roots, unsupported versions, deleted required
  templates, and unknown local modifications.

Use `--backup-dir /absolute/path` to select another backup location. It must be
outside the project.

## Fixed

- Re-running `trellis-lite init --codex --omp` on an existing project no longer
  scans all of `.trellis/` into the template receipt.
- Runtime state, old overlay receipts, backlog, traces, worktrees, and caches are
  explicitly excluded from template hashing.
- The managed `AGENTS.md` block identifies Trellis Lite by its independent
  product name.

## v1.0.0 baseline

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

The source release can be installed with `./scripts/install-cli.sh`.
Public npm publication is separate from this GitHub release and requires npm
owner credentials.

## Compatibility boundary

Historical migration manifests and narrow uninstall scrubbers remain so an
upstream-created project can safely remove obsolete managed files. They are
compatibility data, not active support for removed platforms.

Trellis Lite remains AGPL-3.0 licensed. Original attribution and Git history
are preserved.
