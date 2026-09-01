# Trellis Lite v1.0.2

This release makes OMP verification budgets durable and task-aware, removes
keyword-based false positives, and automatically upgrades active tasks that
still use the legacy Lite profile shape.

## Durable, task-scoped OMP budgets

- Stores dynamic counters under
  `.trellis/.runtime/lite-budget/<context-key>.json`, outside task documents
  and template receipts.
- Isolates each budget by OMP session, canonical active task, verification
  level, and UI driver.
- Preserves counters across extension reloads and OMP process restarts while
  keeping different tasks and new sessions independent.
- Counts at most one code pass and one UI pass per Bash tool call. A mixed
  code/UI command consumes both atomically or neither when one boundary blocks
  it.

## Explicit one-shot authorization

After a non-zero budget is exhausted, the user can grant exactly one
additional pass from the OMP prompt:

```text
/trellis-authorize-verification code
/trellis-authorize-verification ui
```

The authorization is task- and session-scoped, survives an extension reload,
cannot stack, and cannot override `V0`, `U0`, or the selected UI driver. It is
an OMP user command rather than a Bash command, so the normal agent tool loop
cannot invoke it directly. Verification budgets are workflow/runtime guards,
not an OS-level security sandbox.

## More accurate command classification

- Recognizes common direct test, lint, typecheck, build, Python `-m`, package
  runner, named verification-script, and shell `-c` invocations.
- Does not charge searches or prose merely because they contain words such as
  `test`, `build`, or `playwright`.
- Treats a bare Vite development server as non-verification while still
  recognizing `vite build`.
- Checks every UI driver in a compound command, preventing a selected
  Playwright profile from silently running Cypress or Selenium in the same
  Bash call.
- Routes `selenium-side-runner`, Pytest paths with an explicit `e2e` directory,
  and Vitest `--browser` runs through the independent UI budget.
- Intentionally remains a bounded common-command classifier, not a complete
  POSIX shell interpreter.

## Legacy Lite profile upgrade

`trellis-lite update` now upgrades known legacy profiles in active task
directories, including same-version updates:

- preserves P/V choices, path boundaries, `selected_by`, and a valid custom V
  pass limit;
- adds `U0`, `ego-lite`, locked scope, and bounded default pass fields when
  they are absent;
- changes legacy `checker: "on"` to `off` so an already-used checker does not
  run again;
- leaves non-Lite tasks, archived tasks, already-current profiles, and unknown
  or malformed profiles unchanged;
- previews the operation during `--dry-run`, backs up the exact task JSON, and
  writes the migrated document atomically.

Declared-but-invalid Lite profiles now block actual code/UI verification Bash
while ordinary inspection and search commands remain available.
An active task whose `task.json` is malformed or not a JSON object likewise
blocks edits and verification without blocking read-only inspection.

## Release safety

- Release commits now use repository-root exclusions, so `.trellis` task and
  runtime data cannot be swept in when the release script runs from the CLI
  package directory.
- A release pushes only its own version tag instead of every unpublished local
  tag.

## Upgrade note

Run `trellis-lite update` after installing v1.0.2. A currently running OMP
extension instance must be reloaded or restarted once to load the new runtime.
Counters that existed only in the old in-memory implementation cannot be
reconstructed; after that one-time transition, the new ledger survives future
reloads.

Public npm publication remains separate from this GitHub source release.

---

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
