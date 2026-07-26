---
name: spec-injection
description: Path-scoped on-demand spec injection — frontmatter contract, glob matching, hook flow, budgets, ticket-refresh state machine, identity ladder, platform matrix
paths:
  - packages/cli/src/templates/shared-hooks/inject-spec-context.py
  - packages/cli/src/templates/trellis/scripts/common/spec_match.py
  - packages/cli/src/templates/trellis/scripts/common/spec_inject.py
  - .claude/hooks/inject-spec-context.py
  - .trellis/scripts/common/spec_match.py
  - .trellis/scripts/common/spec_inject.py
---

# Path-Scoped Spec Injection

> Contract for on-demand spec injection: spec `.md` files under
> `.trellis/spec/` declare which code paths they govern via `paths:`
> frontmatter; when the agent touches a governed file, the matching specs are
> injected right then — small, relevant, budgeted — instead of everything up
> front (impossible: this repo's spec tree alone exceeds every injection
> ceiling) or nothing at all (index-only "read on demand" is unreliable). A
> spec stays present as the session runs: injected in full the first time, then
> kept alive by a compact ticket on a fixed refresh window so it never decays
> out of context. This file's own frontmatter block is a live example of the
> contract.

---

## Code map

| Surface | File |
|---|---|
| Matching engine | `packages/cli/src/templates/trellis/scripts/common/spec_match.py` (live twin `.trellis/scripts/common/spec_match.py`) |
| Decision engine (pure logic) | `packages/cli/src/templates/trellis/scripts/common/spec_inject.py` (live twin `.trellis/scripts/common/spec_inject.py`) |
| Injection hook (IO shell) | `packages/cli/src/templates/shared-hooks/inject-spec-context.py` (live twin `.claude/hooks/inject-spec-context.py`) |
| Registration | `packages/cli/src/templates/claude/settings.json` `PostToolUse` (live twin `.claude/settings.json`) |
| Distribution | `packages/cli/src/templates/shared-hooks/index.ts` `SHARED_HOOKS_BY_PLATFORM` (claude only this iteration) |
| Config | `spec_injection:` section of `.trellis/config.yaml` — shipped commented-out (defaults apply) in both the template (`templates/trellis/config.yaml`) and this repo's live config |
| Pull mode | `get_context.py --mode spec --file <path>` (dispatch in `common/git_context.py`) |
| Refresh state | `${TRELLIS_SPEC_STATE_DIR:-~/.trellis/spec-inject}/<project16>/<identity>.jsonl` (user-global, outside the repo) |

---

## 1. Frontmatter contract

Frontmatter is **optional and additive**: a spec file without it (all
pre-existing specs, everywhere) behaves exactly as today and is invisible to
this feature. Frontmatter is inert prose to every other consumer (SessionStart
spec-path listing, index.md readers, byte-based spec-refresh hash tracking).

### Grammar

- Only files whose **first line is exactly `---`** (a UTF-8 BOM before it is
  tolerated) enter frontmatter parsing.
- The scan is a bounded head-read: first **16 KiB / 200 lines**, whichever
  ends first; parsing stops at the closing `---`. A frontmatter block still
  open when the bound is reached is an error (warn + skip, below) — the
  pipeline never routes on a half-read block. Keep frontmatter short and at
  the very top.
- Key lines match `^([A-Za-z_][A-Za-z0-9_-]*):(.*)$` (after stripping
  surrounding whitespace). Values are unquoted (matching `"` / `'` pairs
  removed) and inline ` # …` comments are stripped (a `#` inside a quoted
  value is preserved).
- Recognized keys — parsing is hand-rolled in `parse_spec_frontmatter()`
  (house pattern, modeled on `trellis_config.parse_simple_yaml`; **no YAML
  dependency**):
  - `paths:` — either an empty inline value followed by `- <glob>` list items
    (flat block list), or a flow sequence on the key line — `paths: [a, b]`
    (split on commas, each item unquoted; `[]` declares no paths, so the spec
    stays inert).
  - `description:` — single-line scalar; reused in `<spec-index>` degradation
    lines and pull-mode output.
  - `name:` — single-line scalar; tolerated, currently unused by matching.
- The parser is **tolerant by default** — real spec files carry SKILL.md-style
  frontmatter and must not be killed by shapes we do not consume:
  - Unknown keys are ignored, whether scalar or list-valued.
  - Block scalars (`key: >` / `key: |` and their `-`/`+` chomping variants)
    consume their indented continuation lines and are ignored — a
    `description: >` no longer disables the spec (its value is simply not
    captured).
  - Stray `- item` lines outside a pending `paths:` are ignored.
  - Any other unrecognized line shape is ignored.
  - Blank lines and `#` comment lines are skipped.
  - An opening `---` with **no recognized key** (`paths` / `name` /
    `description`) before the closing marker is not frontmatter at all — a
    Markdown horizontal rule opening a prose file — and is skipped silently,
    no warning.

### Malformed frontmatter (whole spec skipped, stderr warning)

`parse_spec_frontmatter()` raises `ValueError` — and `match_specs_for_file()`
skips that spec with a `[WARN] spec_match:` line on stderr — **only** for:

- `paths: <scalar>` that is not a flow sequence (a scalar where a list of
  globs belongs)
- `paths: >` / `paths: |` (a block scalar where a list of globs belongs)
- a frontmatter block still open when the head bound (16 KiB / 200 lines) is
  reached — never silently partial

### Invalid globs (that glob skipped, the rest of the file still applies)

`validate_glob()` is a **deny-list, not an allow-list**: only what is unsafe
or meaningless is rejected — with a stderr warning, without discarding the
spec's other globs:

| Rejection | Rule |
|---|---|
| empty glob | must be non-empty |
| absolute | no leading `/`; globs are repo-relative |
| traversal | no `..` segments |
| backslash | no `\` — write POSIX separators even on Windows |
| control chars | no `\x00`–`\x1f` / `\x7f` |

Everything else is valid: `@scope`, `[slug]`, `(marketing)`, non-ASCII
directory names are all legal paths in real repositories and translate fine
(the glob→regex translation escapes literal characters one by one).

---

## 2. Glob semantics

Globs are matched against the edited file's **repo-relative POSIX path** with
an anchored full match (`^…$`). Translation is deterministic, segment-based
(`glob_to_regex()`):

| Token | Meaning | Regex |
|---|---|---|
| `*` | any run (incl. empty) **within one segment** — never crosses `/` | `[^/]*` |
| `?` | exactly one character within a segment | `[^/]` |
| `**` (whole segment, not last) | zero or more whole segments | `(?:[^/]+/)*` |
| `**` (whole segment, last) | the rest of the path | `.*` |
| `**` embedded with other characters | degrades to `*` per star | — |
| trailing `/` | sugar for `/**` (expanded before translation) | — |
| anything else | literal (regex-escaped) | — |

Examples (mirrored from the `spec_match.py` module docstring; keep in sync):

| Glob | Matches | Does not match |
|---|---|---|
| `packages/cli/src/commands/update.ts` | only that exact file | anything else |
| `packages/cli/src/commands/*.ts` | `…/commands/update.ts` | `…/commands/channel/spawn.ts` |
| `packages/cli/src/templates/**` | `…/templates/trellis/index.ts` (any depth) | `packages/cli/src/templates` (the directory path itself) |
| `packages/**/index.ts` | `packages/index.ts`, `packages/cli/src/index.ts` | — |
| `src/util?.py` | `src/utils.py` | `src/util.py`, `src/utilXY.py` |
| `packages/cli/` | same as `packages/cli/**` | — |

On case-insensitive filesystems (macOS, Windows) the compiled regexes carry
`re.IGNORECASE`: the very same file can be handed to the hook in a case the
glob author never wrote, and over-injecting is the safe side of the misfire
asymmetry (§4).

---

## 3. Matching scan (`common/spec_match.py`)

```python
match_specs_for_file(repo_root, file_path) -> list[SpecMatch]
# SpecMatch(spec_path: Path absolute, rel_path: str repo-relative POSIX,
#           description: str | None)
```

Contract:

1. `file_path` may be absolute or repo-relative. Normalization is the exported
   canonical `normalize_repo_relative()` — the **one** normalization in the
   pipeline, used for matching and display alike (`rel_path` shown and `rel`
   matched are the same string by construction): root and file are fully
   resolved (`strict=False`, so symlinks and macOS `/tmp` → `/private/tmp`
   cannot make one file look like two), the result is NFC-normalized;
   backslashes → `/`, leading `./` stripped. A file resolving outside the
   repo yields **no matches** (return `[]`), never an error.
2. Bail-out before any I/O when `.trellis/spec/` does not exist → `[]`.
3. Scans `.trellis/spec/**/*.md` via `rglob` — `index.md` files included if
   they declare `paths:`. Each file gets a **bounded head-read only**
   (16 KiB); spec bodies are never read during matching.
4. Unreadable file → stderr warn, skip. Malformed frontmatter (bad `paths:`
   or an unterminated block) → stderr warn, skip. No frontmatter or no/empty
   `paths` → skip silently.
5. **First matching glob per spec wins** (`break`): each spec appears at most
   once per event regardless of how many of its globs match.
6. Results are sorted by `rel_path` — deterministic injection order.
7. Never raises: the whole scan is wrapped; any unexpected exception → stderr
   warn + `[]`. Callers are hooks and context tools.

---

## 4. Injection hook (`shared-hooks/inject-spec-context.py`)

Registered on **Claude Code only** this iteration: **one** `PostToolUse` entry
with matcher `"Read|Edit|Write|MultiEdit"` (official pipe-separated
list-of-exact-strings semantics — the docs' own PostToolUse example uses
`"Edit|Write"`; re-verified 2026-07-25) running
`{{PYTHON_CMD}} .claude/hooks/inject-spec-context.py`, timeout 15. Touching a
governed file — even a `Read` — counts; the miss path stays a fast exit. Which
tool events trigger is filtered **in-hook** by `spec_injection.tools` (default
those four), so users can e.g. drop `Read` without editing settings. The
script keeps the shared-hooks platform-neutral shape so later registrations
are wiring-only.

### Structure: pure logic vs IO shell

Decision logic lives in **`common/spec_inject.py`** (`scan_transcript`,
`select_beats`, `within_window`, `decide`, `truncate_chars`, `render_full` /
`render_ticket`, `assemble_payload`, `make_record`) — importing it has no side
effects, and unit tests import it directly. The hook is the IO shell: stdin,
config, identity, state files, locking, GC, one print. One accepted trade-off
is recorded here deliberately: the hook reads and hashes every matched spec
*before* deciding — sha-change-beats-window requires knowing the current
content, and a stat/mtime shortcut would weaken that contract. The read is
bounded: a spec source over **10 MiB** (`MAX_SPEC_SOURCE_BYTES`) is never
read+hashed — it degrades straight to an index line with a stderr warn.

### Flow (in order; every early exit is `exit 0`, no stdout)

1. Env kill switches: `TRELLIS_HOOKS=0` or `TRELLIS_DISABLE_HOOKS=1`.
2. stdin JSON parse; non-dict or parse failure → silent exit.
3. `tool_name` (fallback `toolName`) must be a non-empty string.
4. `tool_input.file_path` must be a non-empty string.
5. Repo root: walk up from `cwd` (fallback `os.getcwd()`) to find `.trellis/`.
6. Bail **before any spec scan** when `.trellis/spec/` is absent — a spec-less
   project pays only the subprocess spawn.
7. Config gate: `spec_injection.enabled: false` → silent exit; `tool_name` not
   in `spec_injection.tools` → silent exit (`tools: []` disables every
   trigger — early exit).
8. Import `common.spec_match` + `common.spec_inject` from `.trellis/scripts`
   (sys.path extension); import failure → degrade to nothing.
9. Match; no matches → silent exit.
10. Resolve identity; unless stateless: run GC (hourly gate), open the
    identity's state shard for read+append (**the open doubles as the
    writability probe** — failure trips the circuit breaker and the event runs
    stateless ticket-only), take a best-effort `fcntl` lock, load the shard's
    state, and read the clock from the transcript (the subagent's own when the
    event carries an `agent_id`). Then run the per-spec decision engine and
    assemble the budgeted payload; state lines are appended **under the same
    lock**, only for specs that actually emitted (FULL or TICKET) — silent and
    budget-dropped specs record nothing and stay eligible.
11. Empty payload → silent exit; otherwise print exactly one JSON object:

```json
{"hookSpecificOutput": {"hookEventName": "PostToolUse",
                        "additionalContext": "<payload>"}}
```

Top-level `try/except → sys.exit(0)`: the hook **never** blocks the tool
result, never crashes the session, never exits non-zero. stdout carries hook
JSON or nothing; all warnings go to stderr.

### Payload shape

One block per emitting spec, joined by a blank line. A **FULL** block inlines
the (budgeted) spec body and carries the `sha256` attribute — the first 12 hex
of `sha256(spec bytes)` — that the decision engine keys refresh on:

```
<spec-context file="<edited rel path>" spec="<spec rel path>" sha256="<first 12 hex>">
<spec body, sliced to max_spec_chars code points>
[Trellis: truncated at 9400 characters — read <spec rel path> for the full content]
</spec-context>
```

A **TICKET** block is the few-hundred-character reminder emitted in place of
the full text once a spec's refresh window elapses with unchanged content
(decision engine below). It carries the same `sha256` attr and omits the body.
There are **two wordings**, both frozen contracts — implementation and tests
code to them verbatim. Stateful (a recorded prior emission exists):

```
<spec-ticket file="<edited rel path>" spec="<spec rel path>" sha256="<first 12 hex>">
You were shown this spec earlier in this session and its content is unchanged.
It still governs edits to matching files. If you no longer remember it, Read
<spec rel path> before continuing.
</spec-ticket>
```

Stateless (no-identity tier or circuit breaker — there is no record of a prior
emission, so the wording must not claim one):

```
<spec-ticket file="<edited rel path>" spec="<spec rel path>" sha256="<first 12 hex>">
This spec governs the file you just touched. If you have not read it in
this session, Read <spec rel path> before continuing.
</spec-ticket>
```

The truncation notice appears only when a FULL body was capped. FULL bodies
that did not fit the per-event budget degrade to one trailing block — never
silently dropped:

```
<spec-index>
- <spec rel path> — <description or "no description">
</spec-index>
```

The index block is itself budget-bounded: index lines that would push the
payload past `max_total_chars` collapse into one summary line, dynamically
pluralized (`+1 more governing spec` / `+N more governing specs`) and carrying
the pull-mode command runnable as printed —
`- (+N more governing spec(s) over budget — run
python3 ./.trellis/scripts/get_context.py --mode spec --file <edited rel>
to list them)`. The summary is budget-checked like everything else; if even
the summary cannot fit, it is dropped with a stderr warning — the ceiling
always wins.

### Decision engine (ticket-refresh)

v1 injected a spec once per session and then stayed silent forever — which
**recreates** the recency-decay problem the feature exists to solve (by round
100+ the agent no longer follows a rule it was shown once at round 3). v2 keeps
a spec present by re-emitting it, cheaply, on a **fixed** refresh window.

Per matched spec, per event (stable `rel_path` order):

```
h    = sha256(spec bytes)
last = newest emission recorded for (identity, spec)   # stateless → None
if stateless:              emit TICKET   # bounded cost, always (stateless wording)
elif last is None:         emit FULL     # first time this identity
elif last.sha256 != h:     emit FULL     # spec changed → re-teach in full
elif boundaries_now > last.boundaries    # both known
                           emit FULL     # compacted since last → text is gone
elif within window:        silent        # no state append
elif not last.complete:    emit FULL     # recorded FULL was truncated → re-teach whole
else:                      emit TICKET   # refresh attention cheaply
```

- **Fixed window, not sliding**: a silent hit does *not* extend the window — the
  window measures from the last **emission**, not the last touch, because
  continuous editing is exactly when drift is worst. Silent hits append no
  state.
- The content-hash check **beats the window**: a spec edited between touches is
  re-taught in full immediately, regardless of how recently it was shown.
- The compaction check sits **before** the window check: after a
  `compact_boundary` the injected text is genuinely gone — a ticket would
  point at a memory that no longer exists, so the spec is re-taught in full.
- The completeness check sits **after** the window check: a record whose FULL
  body was emitted truncated below the whole spec carries `"complete": false`
  (absent == whole), and once past the window it is re-taught as another FULL
  instead of a ticket — the stateful ticket wording ("you were shown this
  spec") must never be a lie. Consequence: a spec larger than its effective
  budget re-teaches in full every window and never tickets.
- FULL and TICKET emissions both append a state record; silent and
  budget-dropped specs record nothing and stay eligible for a later event.
  Overflow degradation applies to FULL bodies only — tickets are small and
  always emitted when decided, counted against the total budget last (§5).

### Identity ladder

State is keyed by a session identity. **Misfire asymmetry** governs the
design: a collision that *misses* an injection is unacceptable; drift that
*over*-injects is merely wasteful — so when in doubt, inject.

The session/window key is **delegated to
`common.active_task.resolve_context_key`** — the same battle-tested resolver
every other hook uses. That buys, for free: payload keys in every casing
(`session_id` / `sessionId` / `sessionID`, conversation and transcript
variants), nested payload shapes, the explicit `TRELLIS_CONTEXT_ID` override,
per-platform env fallbacks (`*_SESSION_ID` et al.), Cursor shell tickets, and
every platform fix accumulated behind them. The hook calls it **payload-first**
(`allow_environment_context=False`, then a second env-inclusive pass only when
the payload yields nothing) so two live sessions can never collapse onto one
exported env value — the collision direction is the unacceptable one.

On top of that key:

| Layer | Rule |
|---|---|
| subagent split | `+a-<sanitized agent_id>` appended when the payload carries a non-empty `agent_id`, so a **subagent never shares state with its parent** (their contexts are not shared) |
| fallback ladder | when `resolve_context_key` is unavailable (older installed scripts tree), a minimal payload-only ladder (session keys, then transcript hash) keeps the hook working |
| stateless tier | no key from any source → **stateless**: no state I/O at all; every hit emits a TICKET (stateless wording). An unwritable state store trips the same tier for the event — the circuit breaker in §4 Refresh state store |

ppid-based identity is **deliberately unwired**: Claude — the only registered
platform — always yields a payload key, and unreliable CLI-vs-IDE process
detection would risk a cross-session collision, violating the asymmetry
principle. It is documented for a future CLI-only platform.

Sanitization keeps a readable filesystem-safe head — the first 80 characters,
every character outside `[A-Za-z0-9_-]` replaced one-for-one by `-` — and,
whenever any character was replaced OR the raw key exceeded 80 characters,
appends `-` + the first 8 hex of `sha256(raw)`. The suffix makes the mapping
injective over the keys the hook is handed: `a/b` vs `a:b`, or two keys
sharing an 80-character head, can no longer fold onto one state file. (The
shared resolver applies its own coarser collapsing before this hook ever sees
the key, so two raw session ids that *it* folds together still share state —
a documented upstream limit, not closable from this hook.) The output stays
in `[A-Za-z0-9_-]`: `.` maps to `-`, so an identity can never mimic the
`.<pid>` legacy shard suffix the GC name pattern recognizes, and `+` maps to
`-`, so the `+a-<agent_id>` subagent suffix — appended AFTER each part is
sanitized — is unforgeable.

### Clock (refresh-window units)

The window is measured in **beats** of the agent's own transcript when it is
readable, else in **epoch seconds**. A state record stores both when
available (the beat count lands in the record's `turns` field). What a beat
is depends on which transcript it is:

- **Main session**: a beat is a **real user turn** — a transcript line with
  `type=="user"` AND `message.content` is a string AND no `isMeta`. Tool
  results and meta lines carry structured content and do not count. (Raw line
  counts run tens of lines per real turn on measured transcripts — which is
  why the v1 line clock measured the wrong thing and was replaced by turns.)
- **Subagent** (the event carries an `agent_id`): a beat is an
  **assistant-message line** (`type=="assistant"`, decided on the parsed
  record, never on a substring guess) — the agent-loop iteration is the
  conversation beat there. A subagent transcript is structurally frozen at
  exactly one real user turn (its prompt) forever — verified 58/58 real
  subagent transcripts, 2026-07-25 — so user turns cannot measure anything in
  one. `scan_transcript` returns `{"turns", "assistant_turns", "boundaries"}`
  and `select_beats` picks by `agent_id` presence. One window key
  (`refresh_window_turns`) covers both — its unit is beats of that
  transcript.
- A **compact boundary** = a line with `type=="system"`,
  `subtype=="compact_boundary"`. Transcripts are **append-only**: `/compact`
  appends a boundary record and the file never shrinks (verified on real
  transcripts, 2026-07-25). Compaction is therefore detected by comparing
  boundary counts — `boundaries_now > boundaries_at_last_emission` → FULL
  (decision engine above) — never by watching the transcript get shorter.
- The scan is a single pass, one line at a time, with byte substring
  prefilters (`"type":"user"` / `"type":"assistant"` — each with and without
  a space after the colon — / `"compact_boundary"`) applied before any
  `json.loads`; the prefilter is only a necessary condition — every count is
  decided on the parsed record. A transcript larger than **64 MiB**, or one
  that is unreadable or hostile in any way (`scan_transcript` catches
  `Exception`, not just `OSError`), falls back to the wall clock — a
  transcript line must never be able to abort an injection event.
- **Subagent events** (`agent_id` present) read the **subagent's own
  transcript**, derived from the parent's path:
  `<transcript dir>/<parent stem>/subagents/agent-<agent_id>.jsonl`
  (convention verified locally, 2026-07-25). If that file is absent → wall
  clock — **never** the parent's counts: the parent idles while the subagent
  runs, so its clock would under-count and under-inject, the unacceptable
  direction.
- Comparison is beats-to-beats when both the current clock and the recorded
  record carry a beat count, else seconds-to-seconds; truly incomparable units
  are treated as **past-window** (the over-inject side). A **negative delta**
  is a plain clock anomaly (wall-clock skew, a replaced transcript file) and
  is also treated as past-window — the safe direction. It does **not** detect
  `/compact` (transcripts never shrink; compaction detection is the boundary
  rule above).
- **Known bounded gap** (accepted, 2026-07-25): a record written under the
  wall clock carries no boundary count, so a later transcript-based event
  cannot anchor the compaction comparison against it — one `/compact` inside
  that gap goes undetected and a ticket may point at compacted-away text. The
  gap self-heals on the next transcript-based emission: that record stores
  the current boundary count, re-arming compaction detection.
- `refresh_window_turns: 0` or `refresh_window_seconds: 0` means "never
  refresh" in that clock mode — both `0` reproduces the legacy inject-once
  behavior.

### Refresh state store

- **Path**: `${TRELLIS_SPEC_STATE_DIR:-~/.trellis/spec-inject}/<project16>/<identity>.jsonl`,
  where `project16 = sha256(realpath(repo_root))[:16]`. **One append-only
  JSONL file per identity — no pid shards**: with a fresh process per hook
  event, pid shards meant one file per emission and an O(session) glob+merge
  on every event, while short `O_APPEND` line appends are concurrency-safe
  (measured: 12 concurrent writers × 38 KB, zero corruption). State is
  **user-global and outside the repo**: nothing lands in `.trellis/`, and
  sibling worktrees sharing a realpath share state. `TRELLIS_SPEC_STATE_DIR`
  overrides the base dir (tests / hermeticity). The layout intentionally
  diverges from the channel hooks' per-project runtime buckets — user-global
  is by design here (review-agreed, 2026-07-25), not an oversight to converge
  later.
- Each emission appends one line:

  ```json
  {"v":2,"spec":"<rel>","sha256":"<64hex>","mode":"full"|"ticket","ts":<float>,"turns":<int|null>,"boundaries":<int|null>}
  ```

  A FULL whose emitted body was truncated below the whole spec additionally
  carries `"complete": false` (absent == whole; §4 Decision engine). `turns`
  stores the beat count (§4 Clock). Records with `v != 2` are ignored on read
  (safe direction: an ignored record re-injects rather than stays silent).
- **Locking**: a best-effort exclusive `fcntl.flock` is held across
  read→decide→append, closing the duplicate-injection race between concurrent
  hook processes on POSIX. No `fcntl` (Windows) or an unsupported filesystem →
  no lock, fail-open: the worst case is a duplicate injection, never a lost
  one.
- **Circuit breaker**: opening the shard for read+append doubles as the
  writability probe. Failure → the event runs **stateless ticket-only** (no
  reads, no writes) — bounded cost, instead of the fail-open-toward-FULL
  posture that re-emitted ~9 KB of spec on every event forever when the store
  was unwritable.
- **Read**: newest record per spec wins (`ts` tiebreaker); malformed lines are
  skipped silently. An unreadable-but-writable store reads as empty → FULL
  (still the inject direction).
- **Write**: `O_APPEND` single lines through the same locked fd; any failure
  warns to stderr and proceeds (the emission already went out).
- **GC**: at most once per hour (gated by a `.last-gc` mtime marker in the
  base dir), shards with mtime older than **48 h** are unlinked. Scope is
  **exact-depth and name-gated — no recursive walk**: only
  `<base>/<project16>/<name>.jsonl` where the project dir matches
  `^[0-9a-f]{16}$` and the shard name matches
  `^[A-Za-z0-9_+-]+(\.[0-9]+)?\.jsonl$` (`+` admits the `+a-<agent_id>`
  subagent suffix; the digit alternative covers our own
  legacy pid shards). A symlinked project dir or shard is skipped outright,
  and every unlink candidate must still resolve (`realpath`) under the
  resolved base — a planted link cannot walk the GC out of its own tree.
  Foreign files and directories are never touched, even via a hostile
  `TRELLIS_SPEC_STATE_DIR`. Best-effort, errors ignored.

---

## 5. Budget rules

| Cap | Default | Applies to |
|---|---|---|
| `max_spec_chars` | 9400 | one spec's body, sliced to that many **code points** + in-body truncation notice |
| `max_total_chars` | 9500 | the **assembled payload string** — wrappers, `\n\n` separators, the `<spec-index>` block and its `(+N more)` summary, tickets: everything is counted, nothing is appended unchecked |

- `0` = unlimited for either cap (`channel.worker_guard` convention).
  `max_spec_chars: 0` lifts the per-spec cap only — a finite
  `max_total_chars` still bounds the emitted block (the derive step below
  then searches up to the whole body, not up to a dead cap of 1).
- A spec source larger than **10 MiB** (`MAX_SPEC_SOURCE_BYTES`) is never
  read+hashed: it degrades straight to an index line with a stderr warn — an
  inlined body that big could never fit the budget anyway.
- Units are **characters** because the platform's ceiling is characters:
  Claude Code documents a 10,000-**character** cap on all hook output strings
  including `additionalContext` (re-verified 2026-07-25,
  code.claude.com/docs/en/hooks.md). v1 counted UTF-8 bytes, which made CJK
  specs pay 3× — a ~9,300-character CJK spec that fits the platform ceiling
  whole was truncated at a third of its length. 9,500 leaves headroom under
  the ceiling. The `<spec-context>` wrapper costs 69 fixed characters plus
  the two rel paths (~152 in a typical case), so under the default caps a
  spec lands whole only up to **~9,348 characters**; a body between ~9,348
  and the 9,400 per-spec cap is derived-truncated further (below) — a spec
  at the per-spec cap does **not** land whole.
- Truncation slices code points (`body[:max_spec_chars]`), which can never
  split a multi-byte sequence — byte-level `truncate_utf8` is not needed in
  this hook.
- The per-event cap is enforced on the exact string that is emitted: every
  candidate block is measured as `len("\n\n".join(blocks + [candidate]))`.
- A FULL block that would push the total over `max_total_chars` is first
  **re-truncated to the largest body prefix that still fits** the remaining
  budget (wrapper + notice counted; binary search over the cap — contract
  amendment 1: without this, body-cap + notice + wrapper exceeded the total
  cap and every long spec fell straight to an index line, the rejected
  index-only mode by another route). Only when no usable prefix fits does the
  spec degrade to an index line (path + description); assembly continues so a
  smaller later match may still fit.
- While candidates remain behind the current one, FULL packing **reserves the
  actual index lines those candidates would need** — the true per-candidate
  strings, not estimates — plus the summary line, capped at
  `INDEX_RESERVE_MAX_CHARS` (900); when the cap binds, the reserve falls back
  to the summary line alone. Named index lines are therefore guaranteed only
  within the cap; beyond it only the `(+N more)` summary is guaranteed
  reachable — and when even the summary does not fit, already-chosen index
  lines are popped (re-counted as dropped) until it does.
- Ticket blocks are counted **last** — after every FULL block and the
  `<spec-index>` degradation block — and dropped with a stderr warning if even a
  ticket does not fit, so the JSON envelope is never malformed.
- Spec-index degradation is the floor, not an error: the agent always at least
  learns *which* spec governs the file and where to read it.

---

## 6. Config keys (`.trellis/config.yaml`)

```yaml
spec_injection:
  enabled: true                 # false disables push injection entirely
  max_spec_chars: 9400          # per matched spec file; 0 = unlimited
  max_total_chars: 9500         # whole per-event payload; 0 = unlimited
  refresh_window_turns: 30      # beats of the agent's own transcript (§4 Clock); 0 = never refresh
  refresh_window_seconds: 2700  # wall-clock fallback; 0 = never refresh
  tools:                        # tool events that trigger injection
    - Read
    - Edit
    - Write
    - MultiEdit
```

- Section absent (default install — the template ships it commented out) ⇒
  defaults above.
- `enabled` accepts booleans and the strings `true/yes/1/on` /
  `false/no/0/off`; anything else → stderr warn, default `true`.
- Non-integer or negative character/window values → stderr warn, default for
  that key.
- `refresh_window_turns` / `refresh_window_seconds` size the fixed refresh
  window (§4 Clock): the turns key applies when a transcript is readable, the
  seconds key is the wall-clock fallback. `0` in a key = never refresh in that
  clock mode; both `0` = legacy inject-once behavior.
- `tools` filters which tool events trigger the hook (names as the platform
  reports them). Both grammars are accepted: a block list (`- Edit` items)
  and a flow sequence (`tools: [Edit, Write]`). An **empty list (`[]`, either
  grammar) is a deliberate "never trigger"** and is respected — early exit;
  unknown tool names warn once to stderr (they can never match); any other
  value shape warns and falls back to the default four.
- `enabled: false` disables the hook only; pull mode is unaffected.
- There is deliberately **no path mapping in config.yaml** — frontmatter is
  the single source of truth (two sources would drift).
- Numeric coercion for these keys is implemented locally in the hook, not in
  the shared config helpers — accepted decision (2026-07-25): widening the
  shared `common/config.py` has more blast radius than the small duplication
  costs.

---

## 7. Pull mode (`get_context.py --mode spec`)

```bash
python3 .trellis/scripts/get_context.py --mode spec --file packages/cli/src/commands/workflow.ts
```

- Output: one line per match, `<rel spec path> — <description>` (literal
  `(no description)` when the spec declares none), or
  `No spec files declare paths matching <path>.`
- Exit 0 in both cases; omitting `--file` is an argparse usage error (exit 2).
- Lists **paths + descriptions only, never bodies** — so it needs no budget
  and no dedup. Same matching engine as the hook (`match_specs_for_file`).
- Consumers: class-2 platforms, skills, tests, humans.

---

## 8. Platform matrix

| Platform | Push injection | Notes |
|---|---|---|
| Claude Code | ✅ wired | PostToolUse fires for **sub-agent tool calls too** — injection lands in the editing agent's own context (desired; complements, never duplicates, JSONL curation — different channel, refresh state is per session identity, and a subagent keeps state separate from its parent). Windows: cosmetic "hook error" display bug on record (claude-code#45065); if PostToolUse ever fails to fire, the feature degrades to nothing — no breakage. |
| cursor, codex, gemini, qoder, copilot, codebuddy, droid, kiro, trae, zcode, opencode, pi, omp, snow | follow-up | The hook script is platform-neutral; registering one of these is wiring-only (settings template + `SHARED_HOOKS_BY_PLATFORM` row) **after** verifying the platform has a tool-event hook that consumes `additionalContext`. |
| kilo, antigravity, devin | ❌ impossible | No hook surface at all. |
| grok | ❌ impossible | Hook stdout `additionalContext` is not consumed (verified 0.2.x). |
| kimi | ❌ impossible | Hooks are user-level only (`~/.kimi-code/config.toml`); Trellis writes no project-level hook files. |
| reasonix | ❌ impossible | No prompt/tool hook surface. |

Pull mode (`--mode spec`) works on **every** platform; "impossible" above
refers to push injection only.

Distribution invariant (hard-learned): every shared-hook template file MUST be
registered in `SHARED_HOOKS_BY_PLATFORM` for at least one platform and in the
`shared-hooks.test.ts` `ALL_HOOK_FILES` enumeration — an unregistered file is
either dead weight or breaks every init fixture.

---

## 9. Design decision: globs, not symlinks

Symlinking specs into governed code directories was considered and rejected:

1. Nothing reads directory-local spec files today — the links would have no
   consumer.
2. Symlinks require privileges on Windows and break without them.
3. They complicate `trellis update` hash tracking.
4. A glob mapping is strictly more expressive: one spec ↔ many directories.

Related non-goals: no frontmatter cache/index (bounded head-reads are cheap;
caches invalidate), no auto-generation of frontmatter from index.md
checklists, no change to sub-agent JSONL curation or its budgets.

---

## 10. Failure modes

| Failure | Behavior |
|---|---|
| No frontmatter anywhere (all pre-existing projects) | zero matches, no output — byte-identical to no hook |
| Malformed frontmatter in one spec (bad `paths:` or an unterminated block) | stderr warn, that spec skipped |
| One invalid glob in a spec | stderr warn, that glob skipped, the spec's other globs still apply |
| Spec file unreadable | stderr warn, skipped |
| Spec file over 10 MiB | stderr warn, degraded to an index line (never read+hashed) |
| Refresh state unwritable (open/create fails) | circuit breaker: the event runs stateless ticket-only — bounded cost, never a FULL re-emission loop |
| Refresh state unreadable but writable | reads as empty → FULL (the inject direction) |
| State append fails after emission | stderr warn, emission stands |
| No resolvable identity (stateless tier) | ticket-only every hit, zero state I/O |
| Transcript unreadable / oversized (> 64 MiB) | fall back to the wall-clock (seconds) window |
| Subagent transcript absent for an `agent_id` event | wall clock — never the parent's counts |
| Matching/decision engine unimportable | hook degrades to nothing, exit 0 |
| Hook internal bug | top-level try/except → exit 0, no output |
| Payload near ceiling | budget enforced on the assembled payload string — ≤ 9,500 characters with separators, index block, summary and tickets all counted; overflow index lines collapse into a `(+N more …)` summary, itself budget-checked |
| Invalid config values | stderr warn, per-key defaults |
| Windows PostToolUse quirk | cosmetic error display only (#45065); worst case: no injection |

---

## 11. Good/Base/Bad cases

- Good: the agent edits `packages/cli/src/commands/workflow.ts`; the hook
  injects `commands-workflow.md` (per its `paths:` frontmatter) as one FULL
  `<spec-context>` block. A second touch of the same or another matching file
  within the refresh window emits nothing; once the window elapses the next
  touch emits a compact `<spec-ticket>` reminder instead of the body; editing
  the spec itself re-emits it in full (hash beats window); a `/compact`
  between touches re-emits it in full too (boundary beats window — the text
  is gone).
- Base: a project with zero frontmatter specs — every touch produces exit 0
  with empty stdout; the only observable delta is one fast subprocess per
  Read/Edit/Write.
- Bad: adding a mapping for a spec in `config.yaml` instead of the spec's own
  frontmatter — two sources of truth; the hook reads only frontmatter, so the
  config mapping silently does nothing.
- Bad: a new shared-hook file registered in `settings.json` templates but not
  in `SHARED_HOOKS_BY_PLATFORM` — the file is never distributed and every
  init fixture breaks.

---

## 12. Tests Required

Unit (python-harness style, driven from vitest like `regression.test.ts`;
decision-engine cases import `common/spec_inject.py` directly):

- Glob translation: `*` vs `**` (segment vs cross-segment), `?`, trailing `/`
  sugar, embedded-`**` degradation, anchored full match.
- `validate_glob` deny-list: rejects empty, leading `/`, `..` segment, `\`,
  control chars; **accepts** `@scope`, `[slug]`, `(marketing)`, non-ASCII.
- Frontmatter parsing: no-frontmatter file, BOM tolerance, quotes and inline
  comments, unknown keys ignored, block-scalar `description: >` tolerated,
  stray list items ignored, `paths:` scalar / block scalar raising.
- Clock: beat counting for BOTH transcript kinds — real user turns in a main
  transcript (tool-result and `isMeta` lines excluded), assistant messages in
  a subagent transcript (its user turns are frozen at 1) — plus boundary
  counting, prefilter behavior, oversized transcript → None.
- Frontmatter robustness: flow-sequence `paths: [a, b]`; an unterminated
  block at the head bound warns + skips; an hr-opening prose file is silently
  not-frontmatter; case-insensitive glob match on darwin/win32 (IGNORECASE).

Hook E2E matrix (fabricated PostToolUse stdin; every case asserts exit 0 and
valid-JSON-or-empty stdout; set `TRELLIS_SPEC_STATE_DIR` per run for
hermeticity):

- first touch → FULL `<spec-context>` with a `sha256` attr; second touch within
  the beats window → empty; touch past the fixture-controlled window →
  `<spec-ticket>` carrying the same sha; spec content edited between touches →
  FULL again (hash beats window); a `compact_boundary` appended between
  touches → FULL again (boundary beats window).
- no-identity payload → ticket-only every hit with the **stateless wording**,
  zero state files; `agent_id` present keeps state separate from the same
  `session_id` without it and reads the subagent's derived transcript for the
  clock; `Read` triggers exactly like `Edit`; `spec_injection.tools` filter
  respected (incl. empty list = never trigger).
- state lands under `TRELLIS_SPEC_STATE_DIR` as one `<identity>.jsonl` per
  identity with `v:2` records; stale conforming shards pruned by GC,
  non-conforming names and foreign dirs untouched.
- oversized spec → character truncation notice at cap; total-budget overflow →
  `<spec-index>` degradation; index overflow → `(+N more)` summary; a
  truncated FULL records `complete: false` and re-teaches as FULL past the
  window (the stateful ticket wording is never a lie).
- malformed `paths:` skipped with stderr warn; `spec_injection.enabled:
  false` → empty; non-trigger tool / missing `file_path` / no `.trellis` → empty.

Pull mode:

- `get_context.py --mode spec --file packages/cli/src/commands/workflow.ts`
  lists `commands-workflow.md` (dogfood frontmatter); non-matching path prints
  the "No spec files declare paths" line, exit 0.

Template shape:

- `shared-hooks.test.ts`: capability-table integrity + `ALL_HOOK_FILES`
  enumeration includes `inject-spec-context.py`.
- Claude settings template asserts the single `PostToolUse` entry with matcher
  `"Read|Edit|Write|MultiEdit"`.

---

## DO

- Declare `paths:` in the governed spec's own frontmatter — the single source
  of truth. When adding a Pre-Development Checklist mapping to `index.md`,
  add the matching frontmatter globs in the same commit (and vice versa).
- Keep frontmatter at the very top and short — the head-read bound
  (16 KiB / 200 lines) is a hard parsing horizon, and a block still open at
  the bound skips the whole spec (warned).
- Keep stdout reserved for the hook JSON envelope; warnings go to stderr.
- Re-verify Claude's documented additionalContext ceiling before changing
  budget defaults, and record the verification date here (last verified
  2026-07-25: 10,000 characters, all hook output strings).
- Register any new shared-hook file in `SHARED_HOOKS_BY_PLATFORM` and
  `ALL_HOOK_FILES` in the same commit that creates it.

## DON'T

- Don't add a YAML dependency — the parser is hand-rolled by design.
- Don't add a central path mapping to `config.yaml` or cache frontmatter
  scans.
- Don't make the hook exit non-zero, print errors to stdout, or block the
  tool result — degrade to nothing instead.
- Don't rely on the refresh state for correctness: it is best-effort by
  design, so duplicate injection must always be safe — and its unwritable
  failure mode is the bounded ticket-only circuit breaker, never silence.
- Don't count budgets in bytes — the platform ceiling is characters, and byte
  caps make CJK specs pay 3×.
- Don't measure the refresh window in raw transcript lines — tool results
  inflate line counts by an order of magnitude; count beats (§4 Clock: real
  user turns in a main session, assistant messages in a subagent).
- Don't symlink specs into code directories (rationale in §9).
- Don't register the hook on a new platform without verifying its tool-event
  hook consumes `additionalContext` (see grok: hook exists, output ignored).

---

## Mandatory triggers (must update this spec when changing)

- Frontmatter grammar, tolerance rules, recognized keys, or validation rules
- Glob token semantics, the glob→regex translation, or the deny-list
- Budget defaults, character accounting, or the assumed platform ceiling
  (re-verify the documented limit)
- The decision engine (FULL / TICKET / silent state machine), the compaction
  rule, or the refresh-window clock semantics (both beat definitions included)
- Identity ladder tiers, sanitization, or the subagent `agent_id` split
- Refresh state schema, location, locking, the circuit breaker, or the GC
  scope/window
- Payload envelope shape (`<spec-context>` / `<spec-ticket>` — either
  wording — / `<spec-index>` / the `sha256` attr / truncation notice text)
- New config key under `spec_injection:` (the `tools` filter included)
- Hook registration on any additional platform (update the matrix in §8)

Cross-reference: `cli/backend/script-conventions.md` (hook script standards),
`cli/backend/error-handling.md` (never-crash hook posture),
`cli/backend/configurator-shared.md` (distribution table conventions),
`guides/cross-platform-thinking-guide.md` (degradation posture).
