#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Path-Scoped Spec Context Injection Hook (ticket-refresh model)

When the agent touches a file, the specs that govern that file are surfaced
right then — small, relevant, budgeted — instead of everything up front or
nothing at all. Spec .md files under .trellis/spec/ declare which code paths
they govern via YAML frontmatter (`paths:` glob list); the matching engine
lives in .trellis/scripts/common/spec_match.py and the decision engine in
.trellis/scripts/common/spec_inject.py. This file is the IO shell: stdin,
config, identity, state files, locking, GC, one print.

Trigger: PostToolUse (matcher "Read|Edit|Write|MultiEdit") — registered on
Claude Code only this iteration. The script keeps the shared-hooks
platform-neutral shape so later platform registrations are wiring-only.

Behavior — per matched spec, per event (recency-decay aware):

    h    = sha256(spec bytes)
    last = newest emission recorded for (identity, spec)   # stateless → None
    if stateless:               emit TICKET  # bounded cost, always
    elif last is None:          emit FULL    # first time this session
    elif last.sha256 != h:      emit FULL    # spec changed → re-teach
    elif compacted since last:  emit FULL    # the text is gone, re-teach
    elif within window:         silent       # fixed window; no state append
    else:                       emit TICKET  # refresh attention cheaply

A FULL block inlines the (budgeted) spec body with a sha256 attr; a TICKET is
a short reminder pointing back at the spec. Both append a state record; silent
hits do not (fixed window, not sliding — continuous editing is exactly when
drift is worst).

Identity ladder (misfire asymmetry: a collision that MISSES an injection is
unacceptable; drift that OVER-injects is fine):
  T1  session_id | conversation_id | sessionID (+ agent_id when present, so a
      subagent never shares state with its parent).
  T2  transcript_path (hashed).
  T4  none of the above, or an unwritable state dir → stateless: no state IO
      at all, every hit is a TICKET (circuit breaker — never a FULL re-emission
      loop).

State: user-global, out of the repo, one append-only JSONL file per identity
under ${TRELLIS_SPEC_STATE_DIR:-~/.trellis/spec-inject}/<project16>/<identity>.jsonl.
A best-effort fcntl lock is held across read→decide→append; where fcntl is
unavailable (Windows) the short O_APPEND writes stay atomic enough and the
worst case is a duplicate injection. All state IO degrades toward emitting.
A once-per-hour GC prunes conforming shards older than 48 h.

Clock: real user turns (and /compact boundaries) counted from the transcript —
the subagent's own transcript when the event carries an agent_id, never the
parent's. No readable transcript → wall clock.

Budget (config.yaml `spec_injection:`): per-spec cap `max_spec_chars`
(default 9400) with code-point truncation + in-body notice; per-event cap
`max_total_chars` (default 9500 — Claude Code's documented additionalContext
ceiling is 10,000 characters, stay under with margin). Once the total budget
is exhausted, remaining FULL bodies degrade to one <spec-index> block; tickets
are counted last and dropped (with a stderr warning) only if even they do not
fit.

Refresh windows (config.yaml `spec_injection:`): `refresh_window_turns`
(default 30; real user turns) and `refresh_window_seconds` (default 2700;
wall-clock fallback). Either `0` = never refresh in that clock mode (both `0`
reproduces the legacy inject-once behavior).

Never blocks, never crashes: non-matching events, missing file_path, no
matches, any internal error → exit 0 with no stdout (stderr warnings allowed).
"""
from __future__ import annotations

# IMPORTANT: Suppress all warnings FIRST
import warnings
warnings.filterwarnings("ignore")

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

# IMPORTANT: Force UTF-8 on Windows for the streams this hook uses.
# stdin carries the payload (non-ASCII file paths), stdout carries the spec
# bodies; without this the default ANSI codepage raises UnicodeDecodeError /
# UnicodeEncodeError.
if sys.platform.startswith("win"):
    import io as _io
    for _stream_name in ("stdin", "stdout"):
        _stream = getattr(sys, _stream_name, None)
        if _stream is None:
            continue
        if hasattr(_stream, "reconfigure"):
            try:
                _stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
            except Exception:
                pass  # Optional Windows stream setup; keep hook startup non-fatal.
        elif hasattr(_stream, "detach"):
            try:
                setattr(sys, _stream_name, _io.TextIOWrapper(_stream.detach(), encoding="utf-8", errors="replace"))
            except Exception:
                pass  # Optional Windows stream setup; keep hook startup non-fatal.


# =============================================================================
# Constants
# =============================================================================

DIR_WORKFLOW = ".trellis"
DIR_SPEC = "spec"

# Tools whose events trigger spec matching (Claude Code tool names). Touching a
# file — even a Read — counts; the miss path stays a fast exit. Overridable via
# config `spec_injection.tools` (e.g. to drop "Read").
DEFAULT_EDIT_TOOLS = ("Read", "Edit", "Write", "MultiEdit")

# Budget defaults sized against Claude Code's documented 10,000-CHARACTER
# additionalContext ceiling — stay under with margin, and leave the per-spec
# cap enough wrapper room that a spec at the cap still lands whole.
# `0` = unlimited.
DEFAULT_MAX_SPEC_CHARS = 9400
DEFAULT_MAX_TOTAL_CHARS = 9500

# Refresh-window defaults. `0` (either key) = never refresh in that clock mode.
DEFAULT_REFRESH_WINDOW_TURNS = 30
DEFAULT_REFRESH_WINDOW_SECONDS = 2700

# State-file base dir (overridable for tests / hermeticity) and GC policy.
STATE_ENV_DIR = "TRELLIS_SPEC_STATE_DIR"
STATE_DEFAULT_DIR = "~/.trellis/spec-inject"
GC_MARKER = ".last-gc"
GC_INTERVAL_SECONDS = 60 * 60          # GC runs at most once per hour
STATE_MAX_AGE_SECONDS = 48 * 60 * 60   # shards older than this are pruned

# GC scope: exactly `<base>/<project16>/<identity>[.<pid>].jsonl`, never a
# recursive walk — a hostile or mistyped TRELLIS_SPEC_STATE_DIR must not turn
# this hook into an unlink loop over someone's files. The optional `.<pid>`
# alternative covers shards written by the pre-lock layout.
GC_PROJECT_DIR_RE = re.compile(r"^[0-9a-f]{16}$")
# `+` is part of the identity charset: subagent shards use the `+a-<agent_id>`
# suffix (contract amendment 2 — without it those shards were never pruned).
GC_SHARD_NAME_RE = re.compile(r"^[A-Za-z0-9_+-]+(\.[0-9]+)?\.jsonl$")

# Subagent ids are uuid-shaped; anything else is not used to build a path.
AGENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _warn(message: str) -> None:
    print(f"[inject-spec-context] WARN: {message}", file=sys.stderr)


def find_trellis_root(start: Path) -> Path | None:
    """Walk up from start to find the directory containing .trellis/.

    Handles CWD drift: subdirectory launches, monorepo packages, etc.
    Returns None if no .trellis/ found (silent no-op).
    """
    cur = start.resolve()
    while cur != cur.parent:
        if (cur / DIR_WORKFLOW).is_dir():
            return cur
        cur = cur.parent
    return None


def _scripts_dir_on_path(root: Path) -> None:
    scripts_dir = root / DIR_WORKFLOW / "scripts"
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))


# =============================================================================
# Config (.trellis/config.yaml `spec_injection:` section)
# =============================================================================


def _read_trellis_config(root: Path) -> dict:
    """Load .trellis/config.yaml via the bundled trellis_config helper.

    The helper lives in .trellis/scripts/common; the hook lives outside the
    scripts tree, so we extend sys.path before importing.
    """
    _scripts_dir_on_path(root)
    try:
        from common.trellis_config import read_trellis_config  # type: ignore[import-not-found]
    except Exception:
        return {}
    try:
        return read_trellis_config(root)
    except Exception:
        return {}


def get_spec_injection_settings(
    root: Path,
) -> tuple[bool, int, int, int, int, tuple[str, ...]]:
    """Return (enabled, max_spec_chars, max_total_chars,
    refresh_window_turns, refresh_window_seconds, tools).

    Reads the ``spec_injection:`` section of ``.trellis/config.yaml``:

        spec_injection:
          enabled: true
          max_spec_chars: 9400
          max_total_chars: 9500
          refresh_window_turns: 30
          refresh_window_seconds: 2700
          tools:
            - Read
            - Edit
            - Write
            - MultiEdit

    Missing keys use their defaults; ``0`` disables the corresponding limit
    (character caps) or refresh (window keys). Invalid values fall back to the
    default for that key with a stderr warning.
    """
    enabled = True
    tools = DEFAULT_EDIT_TOOLS
    numbers = {
        "max_spec_chars": DEFAULT_MAX_SPEC_CHARS,
        "max_total_chars": DEFAULT_MAX_TOTAL_CHARS,
        "refresh_window_turns": DEFAULT_REFRESH_WINDOW_TURNS,
        "refresh_window_seconds": DEFAULT_REFRESH_WINDOW_SECONDS,
    }

    config = _read_trellis_config(root)
    section = config.get("spec_injection") if isinstance(config, dict) else None
    if isinstance(section, dict):
        raw_enabled = section.get("enabled", True)
        if isinstance(raw_enabled, bool):
            enabled = raw_enabled
        else:
            s = str(raw_enabled).strip().lower()
            if s in ("false", "no", "0", "off"):
                enabled = False
            elif s not in ("true", "yes", "1", "on"):
                _warn(
                    f"invalid spec_injection.enabled value: {raw_enabled!r}; "
                    f"using true (default)"
                )

        for key, default_value in list(numbers.items()):
            if key not in section:
                continue
            raw = section[key]
            try:
                value = int(raw)
            except (TypeError, ValueError):
                value = -1
            if value < 0:
                _warn(
                    f"invalid spec_injection.{key} value: {raw!r}; "
                    f"using default {default_value}"
                )
                continue
            numbers[key] = value

        if "tools" in section:
            raw_tools = section["tools"]
            if isinstance(raw_tools, list):
                # An empty list is a deliberate "never trigger" — respected.
                tools = tuple(
                    t.strip() for t in raw_tools if isinstance(t, str) and t.strip()
                )
            else:
                _warn(
                    f"invalid spec_injection.tools value: {raw_tools!r}; "
                    f"using default {list(DEFAULT_EDIT_TOOLS)}"
                )

    return (
        enabled,
        numbers["max_spec_chars"],
        numbers["max_total_chars"],
        numbers["refresh_window_turns"],
        numbers["refresh_window_seconds"],
        tools,
    )


# =============================================================================
# Identity ladder
# =============================================================================


def _sanitize(raw: str) -> str:
    """Collapse a session/agent id into a filename-safe token.

    Restricts to ``[A-Za-z0-9_-]``. Degenerate inputs (all-special) fall back
    to a hash so distinct sessions never share an identity (collision → missed
    injection is the unacceptable failure).
    """
    raw = raw.strip()
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", raw).strip("_-")
    if not safe:
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]
    return safe[:120]


def _shared_context_key(root: Path, payload: dict) -> str | None:
    """Session/window key from the shared resolver every other hook uses.

    ``common.active_task.resolve_context_key`` is the single source of truth
    for session identity: payload keys in all casings (``session_id`` /
    ``sessionId`` / ``sessionID``, conversation and transcript variants),
    nested payload shapes, the explicit ``TRELLIS_CONTEXT_ID`` override,
    per-platform env fallbacks, and Cursor shell tickets — plus the platform
    fixes accumulated behind them. Payload identity is preferred over
    environment context so two live sessions can never collapse onto one
    exported env value (collision → missed injection is the unacceptable
    direction); the environment pass still runs when the payload carries
    nothing.
    """
    try:
        _scripts_dir_on_path(root)
        from common.active_task import resolve_context_key  # type: ignore[import-not-found]

        key = resolve_context_key(payload, allow_environment_context=False)
        if key:
            return key
        return resolve_context_key(payload)
    except Exception:
        return None


def resolve_identity(root: Path, payload: dict) -> tuple[str, bool]:
    """Return (identity, stateless) for the refresh-state store.

    The session/window key is delegated to the shared resolver (see
    ``_shared_context_key``); a subagent suffix keeps parent and subagent
    state separate (their contexts are not shared — a spec shown to one was
    never seen by the other). When the shared resolver is unavailable (older
    installed scripts tree), a minimal payload-only ladder keeps the hook
    working. stateless=True means no state IO at all (every hit is a TICKET).
    """
    key = _shared_context_key(root, payload)

    if not key:
        # Minimal payload-only fallback for scripts trees that predate
        # resolve_context_key. Mirrors its payload lookup order.
        for k in ("session_id", "sessionId", "sessionID"):
            value = payload.get(k)
            if isinstance(value, str) and value.strip():
                key = "s-" + value.strip()
                break
        if not key:
            transcript = payload.get("transcript_path")
            if isinstance(transcript, str) and transcript.strip():
                digest = hashlib.sha256(
                    transcript.strip().encode("utf-8")
                ).hexdigest()
                key = "t-" + digest[:16]

    if not key:
        return "", True

    identity = _sanitize(key)
    agent = payload.get("agent_id")
    if isinstance(agent, str) and agent.strip():
        # Parent and subagent do NOT share context — keep state separate.
        # _sanitize strips "+", so this suffix cannot be forged by an id value.
        identity += "+a-" + _sanitize(agent)
    return identity, False


# =============================================================================
# Clock source (subagent-aware)
# =============================================================================


def clock_transcript_path(payload: dict) -> str | None:
    """Transcript whose turns/boundaries measure THIS agent's context.

    With an ``agent_id``, that is the subagent's own transcript, which Claude
    Code writes next to the parent's as
    ``<dir>/<parent stem>/subagents/agent-<agent_id>.jsonl``. If that file is
    absent we return None (→ wall clock) and never fall back to the parent's
    counts: the parent idles while the subagent works, so its clock would
    under-count and under-inject — the unacceptable direction.
    """
    raw = payload.get("transcript_path")
    transcript = raw.strip() if isinstance(raw, str) else ""

    raw_agent = payload.get("agent_id")
    agent = raw_agent.strip() if isinstance(raw_agent, str) else ""
    if not agent:
        return transcript or None

    if not transcript or not AGENT_ID_RE.match(agent):
        return None
    try:
        parent = Path(transcript)
        candidate = parent.parent / parent.stem / "subagents" / f"agent-{agent}.jsonl"
        return str(candidate) if candidate.is_file() else None
    except OSError:
        return None


# =============================================================================
# State (one append-only JSONL file per identity, locked, user-global)
# =============================================================================


def _state_base_dir() -> Path:
    override = os.environ.get(STATE_ENV_DIR)
    if override and override.strip():
        return Path(override.strip())
    return Path(os.path.expanduser(STATE_DEFAULT_DIR))


def _project_id(root: Path) -> str:
    return hashlib.sha256(os.path.realpath(str(root)).encode("utf-8")).hexdigest()[:16]


def _maybe_gc(base_dir: Path) -> None:
    """Prune conforming shards older than 48 h, at most once per hour.

    Scope is exact-depth (``<base>/<project16>/<shard>.jsonl``) and name-gated;
    foreign files and directories are never touched. Best-effort, errors
    ignored.
    """
    try:
        marker = base_dir / GC_MARKER
        now = time.time()
        try:
            age = now - marker.stat().st_mtime
        except OSError:
            age = None
        if age is not None and age < GC_INTERVAL_SECONDS:
            return
        try:
            base_dir.mkdir(parents=True, exist_ok=True)
            marker.touch()
        except OSError:
            return
        try:
            project_dirs = list(base_dir.iterdir())
        except OSError:
            return
        for project_dir in project_dirs:
            if not GC_PROJECT_DIR_RE.match(project_dir.name):
                continue
            try:
                if not project_dir.is_dir():
                    continue
                shards = list(project_dir.iterdir())
            except OSError:
                continue
            for shard in shards:
                if not GC_SHARD_NAME_RE.match(shard.name):
                    continue
                try:
                    if not shard.is_file():
                        continue
                    if now - shard.stat().st_mtime > STATE_MAX_AGE_SECONDS:
                        shard.unlink()
                except OSError:
                    continue
    except Exception:
        pass


def open_shard(shard_path: Path) -> int | None:
    """Open (creating) the identity's shard for read+append.

    Doubles as the writability probe: a failure here trips the circuit breaker
    and the event runs stateless (ticket-only), which is bounded, instead of
    re-emitting full specs on every event forever.
    """
    try:
        shard_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        _warn(f"state dir {shard_path.parent} unusable — running stateless")
        return None
    try:
        return os.open(
            str(shard_path),
            os.O_RDWR | os.O_CREAT | os.O_APPEND,
            0o644,
        )
    except OSError:
        _warn(f"state shard {shard_path} unusable — running stateless")
        return None


def lock_shard(fd: int) -> None:
    """Best-effort exclusive lock held across read→decide→append.

    Closes the duplicate-injection race between concurrent hook processes on
    POSIX. No fcntl (Windows) or an unsupported filesystem → no lock; the
    worst case is a duplicate injection, never a lost one.
    """
    try:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_EX)
    except Exception:
        pass


def unlock_shard(fd: int) -> None:
    try:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_UN)
    except Exception:
        pass


def load_state(fd: int, state_version: int) -> dict[str, dict]:
    """Read the shard through the already-open fd; newest record per spec wins
    (``ts`` tiebreaker). Malformed lines and foreign schema versions are
    skipped silently. Fail-open to {} (which drives injection, not silence)."""
    result: dict[str, dict] = {}
    try:
        os.lseek(fd, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            chunks.append(chunk)
    except OSError:
        return result

    text = b"".join(chunks).decode("utf-8", errors="replace")
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            record = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if not isinstance(record, dict):
            continue
        if record.get("v") != state_version:
            continue
        spec = record.get("spec")
        ts = record.get("ts")
        if not isinstance(spec, str) or not isinstance(ts, (int, float)):
            continue
        previous = result.get(spec)
        if previous is None or ts > previous.get("ts", float("-inf")):
            result[spec] = record
    return result


def append_records(fd: int, records: list[dict]) -> None:
    """Append records as JSONL (O_APPEND). Best-effort — a failure warns and
    proceeds (the emission already went out)."""
    if not records:
        return
    try:
        blob = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)
        os.write(fd, blob.encode("utf-8"))
    except OSError:
        _warn("could not write state shard — state may be incomplete")


# =============================================================================
# Entry
# =============================================================================


def _repo_rel(root: Path, file_path: str) -> str:
    """Repo-relative POSIX display path; falls back to the raw path."""
    try:
        p = Path(file_path)
        if not p.is_absolute():
            p = root / p
        return p.resolve().relative_to(root.resolve()).as_posix()
    except Exception:
        return str(file_path).replace("\\", "/")


def main() -> int:
    if os.environ.get("TRELLIS_HOOKS") == "0" or os.environ.get("TRELLIS_DISABLE_HOOKS") == "1":
        return 0

    try:
        input_data = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError, UnicodeDecodeError):
        return 0
    if not isinstance(input_data, dict):
        return 0

    tool_name = input_data.get("tool_name", "") or input_data.get("toolName", "")
    if not isinstance(tool_name, str) or not tool_name:
        return 0

    tool_input = input_data.get("tool_input", {})
    if not isinstance(tool_input, dict):
        return 0
    file_path = tool_input.get("file_path")
    if not isinstance(file_path, str) or not file_path.strip():
        return 0
    file_path = file_path.strip()

    cwd = input_data.get("cwd") or os.getcwd()
    root = find_trellis_root(Path(cwd))
    if root is None:
        return 0
    # Bail out before any spec scan when the project has no spec directory.
    if not (root / DIR_WORKFLOW / DIR_SPEC).is_dir():
        return 0

    (
        enabled,
        max_spec_chars,
        max_total_chars,
        win_turns,
        win_seconds,
        tools,
    ) = get_spec_injection_settings(root)
    if not enabled or tool_name not in tools:
        return 0

    _scripts_dir_on_path(root)
    try:
        from common.spec_match import match_specs_for_file  # type: ignore[import-not-found]
        from common.spec_inject import (  # type: ignore[import-not-found]
            STATE_VERSION,
            assemble_payload,
            scan_transcript,
        )
    except Exception:
        return 0  # matching/decision engine unavailable — degrade to nothing

    matches = match_specs_for_file(root, file_path)
    if not matches:
        return 0

    identity, stateless = resolve_identity(root, input_data)

    state_records: dict[str, dict] = {}
    clock = {"turns": None, "boundaries": None, "ts": time.time()}
    fd: int | None = None

    if not stateless:
        base_dir = _state_base_dir()
        _maybe_gc(base_dir)
        shard_path = base_dir / _project_id(root) / f"{identity}.jsonl"
        fd = open_shard(shard_path)
        if fd is None:
            # Circuit breaker: unwritable state → ticket-only for this event.
            stateless = True
        else:
            lock_shard(fd)
            state_records = load_state(fd, STATE_VERSION)
            counts = scan_transcript(clock_transcript_path(input_data))
            clock = {
                "turns": counts["turns"] if counts else None,
                "boundaries": counts["boundaries"] if counts else None,
                "ts": time.time(),
            }

    edited_rel = _repo_rel(root, file_path)
    try:
        payload, records = assemble_payload(
            edited_rel,
            matches,
            stateless,
            state_records,
            clock,
            max_spec_chars,
            max_total_chars,
            win_turns,
            win_seconds,
        )
        if fd is not None and records:
            append_records(fd, records)
    finally:
        if fd is not None:
            unlock_shard(fd)
            try:
                os.close(fd)
            except OSError:
                pass

    if not payload:
        return 0

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": payload,
        }
    }
    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # A context hook must never break the tool result or the session.
        sys.exit(0)
