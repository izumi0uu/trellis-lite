# Trellis Lite

Trellis Lite is an independent, smaller fork of
[Trellis](https://github.com/mindfold-ai/Trellis). It keeps Trellis's durable
task, spec, workspace-memory, and update model, but supports only **Codex** and
**Oh My Pi (OMP)** and gives coding agents a lightweight agreement about change
scope, evidence depth, and the user's time investment.

This is not the official Mindfold Trellis package. The package and executable
names are intentionally different, so both projects can be installed on the
same machine without replacing each other.

[简体中文](./README_CN.md) ·
[Releases](https://github.com/izumi0uu/trellis-lite/releases) ·
[Upstream Trellis](https://github.com/mindfold-ai/Trellis)

## What changed

| Area | Trellis Lite behavior |
| --- | --- |
| Platforms | Codex and OMP only; all other active platform integrations were removed. |
| Change scope | Every durable task selects `P0–P3`, from exact requested edits to broad refactoring. |
| Code verification | One shared frontend/backend evidence level, `V0–V3`; focused evidence is recommended and verification may be deferred. |
| Browser/UI verification | Independent `U0–U3`; `U0` means no browser or UI validation at all. |
| UI driver | Ego Lite is the default for `U1–U3`. If it is unavailable, the agent reports that instead of installing or silently substituting a tool. |
| E2E tools | Playwright, Cypress, Selenium, and project E2E suites run only when explicitly selected as the UI driver. |
| Checker | Off by default. Report mode is read-only, runs once, and cannot enter a fix/recheck loop. |
| OMP enforcement | Native runtime gates protect explicit `V0`, `U0`, path, and UI-driver choices; checker selection remains an Agent contract, and higher evidence levels remain guidance rather than command quotas. |
| Codex enforcement | Project instructions, hooks, and the Codex sandbox/approval boundary carry the profile into the task. |
| Upstream policy | Independent release line based on Trellis 0.6.16; no promise of continued upstream synchronization. |

The selected profile is stored in the `lite` field of
`.trellis/tasks/<task>/task.json`. Planning tasks fail closed until a valid
profile has been recorded.

## Profiles and verification evidence

For every durable task, choose P, V, U, and checker. A preset is an input
shortcut whose resolved values are always shown and may be overridden:

- `quick`: `P0 / V0 / U0 / checker off`.
- `focused` (recommended): `P1 / V1 / U0 / checker off`.
- `release`: `P2 / V3 / U0 / checker off`.
- `custom`: select the individual fields.

Presets are not stored or carried between tasks. Trellis records only the
resolved P/V/U/checker/driver and path fields, and every field remains available
for selection on the next task.

`P` controls what may be changed:

- `P0`: only the requested behavior and the smallest necessary files.
- `P1`: small local cleanup or defensive handling directly required by the
  change.
- `P2`: normal cross-layer implementation inside the declared task boundary.
- `P3`: broad refactoring or architectural change explicitly authorized by
  the user.

`V` selects frontend and backend code evidence together. It does not authorize
browser/UI automation:

- `V0`: defer code verification.
- `V1`: prefer one focused evidence batch for the changed behavior or file.
- `V2`: run the related checks selected in advance and consolidate compatible checks.
- `V3`: run the selected release-readiness checklist without inventing extra gates.

`U` is an independent browser/UI decision:

- `U0`: defer browser, component-behavior, screenshot, and E2E evidence.
- `U1`: prefer one focused Ego Lite interaction on the changed path.
- `U2`: the selected user flow and its relevant boundary or error state.
- `U3`: the broader UI checklist selected in advance, without adding flows.

`V3 + U0` still defers UI verification. `U1–U3` do not silently authorize
Playwright, Cypress, or Selenium.

The authoritative Agent policy is the
[Verification contract](./.trellis/workflow.md#verification-contract). It
separates delivered implementation, verification evidence, deferred evidence,
and release readiness. The Agent completes related edits before checking,
consolidates useful evidence, and may autonomously repair directly related
failures within the original scope. It should not ask after each failure or
repeat checks that provide no new information.

The Agent pauses only for a product decision, meaningful scope expansion, risky
side effect, profile change, or when repeated attempts no longer make substantive
progress. OMP does not impose numeric ceilings on V1–V3 or U1–U3. It still blocks
code verification at `V0`, browser/UI verification at `U0`, an unselected UI
driver, and writes outside a locked path boundary. Checker `off` remains an
explicit Agent boundary; a dispatched report checker is mechanically restricted
to read-only tools.

## Install the CLI

Requirements: Node.js 18.17+, Python 3.9+, and pnpm 10.

The current canonical install is from the tagged GitHub source. It creates only
the `trellis-lite` and `tll` commands; an existing `trellis` command is left
untouched.

```bash
git clone --branch v1.1.1 --depth 1 https://github.com/izumi0uu/trellis-lite.git
cd trellis-lite
./scripts/install-cli.sh

trellis-lite --version
tll --version
```

For development, clone `main` instead of a release tag and run the same
installer. The script installs dependencies, builds both workspaces, and uses
a global npm link to this checkout. It does not use `sudo`, publish anything,
or claim the `trellis`/`tl` executable names.

Remove only the linked Lite CLI with:

```bash
npm unlink --global trellis-lite
```

The npm package names are reserved as `trellis-lite` and
`trellis-lite-core`, but v1.1.1 should be installed from GitHub until those
packages are visible on the public npm registry.

## Initialize a project

Choose one or both supported integrations:

```bash
# Codex
trellis-lite init --codex -u your-name

# OMP
trellis-lite init --omp -u your-name

# Both
trellis-lite init --codex --omp -u your-name
```

Use `trellis-lite update` to refresh managed files in an existing project.
Project tasks, specs, workspace journals, and session history are user data;
update and migration operations preserve them. The update command also
migrates active tasks that use the known older Lite profile shape; it leaves
unknown profiles untouched with a warning and changes legacy `checker: "on"`
to `off` so an already-used checker is not dispatched again.

## Adopt an existing Trellis project

Do not delete the project's `.trellis/` directory and do not run official
`trellis uninstall` first. Lite adopts the existing documents in place:

```bash
cd /path/to/project

# No-write compatibility and conflict audit
trellis-lite adopt --dry-run --codex --omp

# Verified external backup, migration, and byte-identity check
trellis-lite adopt --codex --omp --yes
```

If only one integration is wanted, pass only `--codex` or `--omp`. With no
platform flags, `adopt` uses the supported integrations already recorded in
the project's template receipt.

The public adoption boundary is intentionally narrow: the source version must
be the final stable Trellis release, `0.6.16`. Earlier Trellis releases must be
upgraded through an explicit one-time migration step before adoption;
`0.7.0-beta.*`, unknown forks, and other versions are not accepted. Existing
Trellis Lite projects use `trellis-lite update`, not `adopt`.

By default the backup is written beside the project under
`.trellis-lite-backups/<project>-<timestamp>/`. Use `--backup-dir` to choose a
different location outside the project. Unsupported versions or local differences
stop before any project write; a failure after mutation begins restores all
managed roots from the verified snapshot.

After every project has been adopted and checked, the global official Trellis
CLI may be uninstalled independently. Removing the global CLI does not remove
project documents; removing `.trellis/` does.

## Coexistence with official Trellis

| Product | npm package | Commands |
| --- | --- | --- |
| Trellis Lite | `trellis-lite` | `trellis-lite`, `tll` |
| Official Trellis | `@mindfoldhq/trellis` | `trellis`, `tl` |

Do not use `trellis update` when you mean to update a Lite project. The Lite
CLI always prints its full product name and recommends `trellis-lite ...`
commands in follow-up instructions.

## Supported surfaces

| Capability | Codex | OMP |
| --- | --- | --- |
| Project integration | `.codex/` | `.omp/` |
| Shared skills | `.agents/skills/` | `.agents/skills/` |
| Context injection | Python hooks | Native TypeScript extension |
| Session memory | `~/.codex/sessions/` | OMP's Pi-compatible storage under `~/.pi/agent/sessions/` |
| Channel worker process | Codex | Not provided |

The `.pi` path is OMP's underlying session-storage format. It does not mean
that standalone Pi Agent is a supported Trellis Lite platform.

Historical migration manifests and narrowly scoped uninstall scrubbers remain
so projects created by upstream Trellis can safely remove obsolete managed
files. They are compatibility data, not active platform support.

## Development and release checks

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm build
pnpm test
node packages/cli/scripts/release-preflight.js verify-packed-cli
```

## License and attribution

Trellis Lite is derived from
[mindfold-ai/Trellis](https://github.com/mindfold-ai/Trellis), preserves the
original Git history and copyright notices, and remains licensed under
[AGPL-3.0](./LICENSE).
