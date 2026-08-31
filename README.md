# Trellis Lite

Trellis Lite is an independent, smaller fork of
[Trellis](https://github.com/mindfold-ai/Trellis). It keeps Trellis's durable
task, spec, workspace-memory, and update model, but supports only **Codex** and
**Oh My Pi (OMP)** and puts explicit limits around how coding agents change and
verify a project.

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
| Code verification | One shared frontend/backend level, `V0–V3`, with finite pass budgets. |
| Browser/UI verification | Independent `U0–U3`; `U0` means no browser or UI validation at all. |
| UI driver | Ego Lite is the default for `U1–U3`. If it is unavailable, the agent reports that instead of installing or silently substituting a tool. |
| E2E tools | Playwright, Cypress, Selenium, and project E2E suites run only when explicitly selected as the UI driver. |
| Checker | Off by default. Report mode is read-only, runs once, and cannot enter a fix/recheck loop. |
| OMP enforcement | Native runtime gates block implementation and verification actions that exceed the selected profile. |
| Codex enforcement | Project instructions, hooks, and the Codex sandbox/approval boundary carry the profile into the task. |
| Upstream policy | Independent release line based on Trellis 0.6.16; no promise of continued upstream synchronization. |

The selected profile is stored in `.trellis/tasks/<task>/task.json.lite`.
Planning tasks fail closed until a valid profile has been recorded.

## Profile levels

`P` controls what may be changed:

- `P0`: only the requested behavior and the smallest necessary files.
- `P1`: small local cleanup or defensive handling directly required by the
  change.
- `P2`: normal cross-layer implementation inside the declared task boundary.
- `P3`: broad refactoring or architectural change explicitly authorized by
  the user.

`V` controls frontend and backend code checks together. It does not authorize
browser/UI automation:

- `V0`: no commands; review the edited diff only.
- `V1`: one focused check for the changed unit or file.
- `V2`: focused tests plus the nearest relevant lint/typecheck/build check.
- `V3`: the broader relevant suite, still with a finite retry budget.

`U` is an independent browser/UI decision:

- `U0`: no browser, component-behavior script, screenshot comparison, or E2E
  verification.
- `U1`: one focused Ego Lite interaction on the changed path.
- `U2`: the changed user flow and its primary state transition.
- `U3`: a broader explicitly bounded UI regression pass.

`V3 + U0` still forbids UI verification. `U1–U3` do not silently authorize
Playwright, Cypress, or Selenium.

## Install the CLI

Requirements: Node.js 18.17+, Python 3.9+, and pnpm 10.

The current canonical install is from the tagged GitHub source. It creates only
the `trellis-lite` and `tll` commands; an existing `trellis` command is left
untouched.

```bash
git clone --branch v1.0.0 --depth 1 https://github.com/izumi0uu/trellis-lite.git
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
`trellis-lite-core`, but v1.0.0 should be installed from GitHub until those
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
update and migration operations preserve them.

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
