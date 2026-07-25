/**
 * Integration tests for path-scoped on-demand spec injection (v2 ticket-refresh,
 * post-review contract R1–R7).
 *
 * Covers four surfaces:
 *   - `src/templates/trellis/scripts/common/spec_match.py` — glob→regex
 *     translation, deny-list glob validation (R6), tolerant frontmatter parsing
 *     (R6), `match_specs_for_file`
 *   - `src/templates/trellis/scripts/common/spec_inject.py` — the pure decision
 *     engine (R7): `decide` truth table, `within_window`, `truncate_chars`,
 *     `assemble_payload`'s hard character ceiling
 *   - `src/templates/shared-hooks/inject-spec-context.py` — PostToolUse hook
 *     E2E: character budgets (R1), the real-turn / compact-boundary transcript
 *     clock (R2), the subagent clock (R3), the pid-less locked state file (R4),
 *     the unwritable-state circuit breaker and scoped GC (R5), stateless ticket
 *     wording and the `tools` config gate (R6)
 *   - `get_context.py --mode spec --file <path>` — pull mode
 *
 * Scripts are stamped into a fresh temp dir and exercised through the real
 * `python3` interpreter (no mocking of file I/O or config parsing). Every hook
 * run pins `LC_ALL=C`/`LANG=C` (sibling-hook convention) and
 * `TRELLIS_SPEC_STATE_DIR` under the per-test temp dir, so the user-global
 * (`~/.trellis/spec-inject`) state store is never touched.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/trellis/scripts",
);
const HOOK_PATH = path.resolve(
  __dirname,
  "../../src/templates/shared-hooks/inject-spec-context.py",
);

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function setupRepo(tmp: string): void {
  fs.mkdirSync(path.join(tmp, ".trellis", "scripts"), { recursive: true });
  fs.cpSync(TEMPLATE_SCRIPTS, path.join(tmp, ".trellis", "scripts"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmp, ".trellis", "spec"), { recursive: true });
}

function writeConfig(tmp: string, lines: string[]): void {
  fs.writeFileSync(
    path.join(tmp, ".trellis", "config.yaml"),
    lines.join("\n") + "\n",
    "utf-8",
  );
}

/** Write a spec file under .trellis/spec/ and return its absolute path. */
function writeSpec(tmp: string, rel: string, content: string): string {
  const abs = path.join(tmp, ".trellis", "spec", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

/** The out-of-repo, user-global state base for a given fixture repo. Pinned
 * under the temp dir via TRELLIS_SPEC_STATE_DIR so tests never touch
 * ~/.trellis/spec-inject. */
function stateBase(tmp: string): string {
  return path.join(tmp, "spec-inject-state");
}

/** Every *.jsonl state shard under `dir`, recursively (R4: state files live at
 * <base>/<project16>/<identity>.jsonl — one per identity, no pid shards). */
function listJsonl(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listJsonl(full));
    } else if (entry.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

interface StateRecord {
  v: number;
  spec: string;
  sha256: string;
  mode: string;
  ts: number;
  turns: number | null;
  boundaries: number | null;
}

function readShardRecords(shard: string): StateRecord[] {
  return fs
    .readFileSync(shard, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as StateRecord);
}

/** The single state shard the hook wrote; fails loudly when there is not
 * exactly one (R4 pins one file per identity). */
function soleShard(tmp: string): string {
  const shards = listJsonl(stateBase(tmp));
  expect(shards.length, `expected exactly one shard, got ${shards.join(", ")}`).toBe(1);
  return shards[0];
}

/** Run a Python snippet with spec_match helpers preloaded and the repo root
 * available as `REPO_ROOT`. Returns the raw spawn result so callers can
 * assert on stderr warnings too. */
function runSpecProbe(
  tmp: string,
  code: string,
): { status: number | null; stdout: string; stderr: string } {
  const probePath = path.join(tmp, "spec_probe.py");
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(tmp, ".trellis", "scripts"))})
from pathlib import Path
from common.spec_match import glob_to_regex, validate_glob, match_specs_for_file
REPO_ROOT = Path(${JSON.stringify(tmp)})
${code}
`;
  fs.writeFileSync(probePath, script, "utf-8");
  const r = spawnSync("python3", [probePath], { cwd: tmp, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** R7: import the pure decision module directly (sibling of runSpecProbe).
 * `Cand` is a structural stand-in for spec_match.SpecMatch. */
function runInjectProbe(
  tmp: string,
  code: string,
): { status: number | null; stdout: string; stderr: string } {
  const probePath = path.join(tmp, "inject_probe.py");
  const script = `
import sys
sys.path.insert(0, ${JSON.stringify(path.join(tmp, ".trellis", "scripts"))})
from pathlib import Path
from common.spec_inject import (
    STATE_VERSION,
    assemble_payload,
    decide,
    make_record,
    render_full,
    render_ticket,
    scan_transcript,
    truncate_chars,
    truncation_notice,
    within_window,
)

class Cand:
    """Structural view of spec_match.SpecMatch (assemble_payload only reads
    spec_path/rel_path/description)."""

    def __init__(self, spec_path, rel_path, description):
        self.spec_path = spec_path
        self.rel_path = rel_path
        self.description = description

REPO_ROOT = Path(${JSON.stringify(tmp)})
${code}
`;
  fs.writeFileSync(probePath, script, "utf-8");
  const r = spawnSync("python3", [probePath], { cwd: tmp, encoding: "utf-8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Evaluate glob→path pairs through glob_to_regex; returns "1"/"0" per pair. */
function globMatches(tmp: string, cases: [string, string][]): string[] {
  const r = runSpecProbe(
    tmp,
    `
cases = ${JSON.stringify(cases)}
for g, p in cases:
    print("1" if glob_to_regex(g).match(p) else "0")
`,
  );
  expect(r.status, `glob probe failed: ${r.stderr}`).toBe(0);
  return r.stdout.trim().split("\n");
}

/** Print `rel_path|description` lines for match_specs_for_file. */
function runMatch(
  tmp: string,
  filePath: string,
): { status: number | null; stdout: string; stderr: string } {
  return runSpecProbe(
    tmp,
    `
for m in match_specs_for_file(REPO_ROOT, ${JSON.stringify(filePath)}):
    print(f"{m.rel_path}|{m.description}")
`,
  );
}

function runHook(
  tmp: string,
  input: string,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Sibling-hook convention: pin locale so character-oriented assertions are
    // stable across machines.
    LC_ALL: "C",
    LANG: "C",
    // Hermetic state: keep every shard under the per-test temp dir.
    TRELLIS_SPEC_STATE_DIR: stateBase(tmp),
  };
  delete env.TRELLIS_HOOKS;
  delete env.TRELLIS_DISABLE_HOOKS;
  // Identity delegates to common.active_task.resolve_context_key, which also
  // consults env fallbacks (TRELLIS_CONTEXT_ID override plus per-platform
  // *_SESSION_ID / *_CONVERSATION_ID / *_TRANSCRIPT_PATH keys). The dev shell
  // running vitest may carry those (e.g. CLAUDE_CODE_SESSION_ID inside a
  // Claude Code session), so strip every identity-bearing key for hermetic
  // no-identity cases; tests opt back in via extraEnv.
  delete env.TRELLIS_CONTEXT_ID;
  const identityBearing =
    /(_SESSION_?ID|_CONVERSATION_?ID|_TRANSCRIPT_PATH|_THREAD_ID|_RUN_ID)$/i;
  const cleanEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => !identityBearing.test(key)),
  );
  Object.assign(cleanEnv, extraEnv);
  const r = spawnSync("python3", [HOOK_PATH], {
    cwd: tmp,
    encoding: "utf-8",
    input,
    env: cleanEnv,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

interface PayloadOpts {
  filePath: string;
  /** session_id; defaults to "sess-1". Pass `null` to omit all identity keys. */
  session?: string | null;
  toolName?: string;
  agentId?: string;
  transcriptPath?: string;
}

function buildPayload(tmp: string, opts: PayloadOpts): string {
  const payload: Record<string, unknown> = {
    hook_event_name: "PostToolUse",
    cwd: tmp,
    tool_name: opts.toolName ?? "Edit",
    tool_input: { file_path: opts.filePath },
  };
  if (opts.session !== null) {
    payload.session_id = opts.session ?? "sess-1";
  }
  if (opts.agentId !== undefined) {
    payload.agent_id = opts.agentId;
  }
  if (opts.transcriptPath !== undefined) {
    payload.transcript_path = opts.transcriptPath;
  }
  return JSON.stringify(payload);
}

function additionalContext(stdout: string): string {
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
  return parsed.hookSpecificOutput.additionalContext;
}

/** Extract the 12-hex sha256 attr the FULL/TICKET tags carry; fail loudly if
 * the frozen `sha256="<12hex>"` attribute is missing. */
function requireSha(ctx: string): string {
  const m = /sha256="([0-9a-f]{12})"/.exec(ctx);
  if (!m) {
    throw new Error(`expected sha256 attr in: ${ctx.slice(0, 200)}`);
  }
  return m[1];
}

/** The single <spec-context> block's body (everything between the open tag
 * line and the closing tag). */
function fullBlockBody(ctx: string): string {
  const m = /^<spec-context [^\n>]*>\n([\s\S]*)\n<\/spec-context>$/.exec(ctx);
  if (!m) {
    throw new Error(`expected exactly one <spec-context> block: ${ctx.slice(0, 200)}`);
  }
  return m[1];
}

// ---------------------------------------------------------------------------
// Transcript fixtures (R2/R3): the four line shapes the turn clock must
// discriminate, written exactly as Claude Code's JSON.stringify emits them
// (no space after the `"type":` colon — the hook's byte prefilter).
// ---------------------------------------------------------------------------

const LINE = {
  /** A real user turn: type=user, string message.content, no isMeta. */
  userTurn: (text: string): string =>
    JSON.stringify({ type: "user", message: { role: "user", content: text } }),
  /** A tool_result carrier: type=user but structured content → not a turn. */
  toolResult: (): string =>
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: "ok" },
        ],
      },
    }),
  /** A meta line: type=user, string content, but isMeta → not a turn. */
  meta: (): string =>
    JSON.stringify({
      type: "user",
      isMeta: true,
      message: {
        role: "user",
        content: "<system-reminder>injected noise</system-reminder>",
      },
    }),
  /** Assistant output: never a turn. */
  assistant: (): string =>
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "sure" }] },
    }),
  /** The append-only marker /compact leaves behind. */
  compactBoundary: (): string =>
    JSON.stringify({ type: "system", subtype: "compact_boundary" }),
};

function userTurns(count: number, tag = "t"): string[] {
  return Array.from({ length: count }, (_, i) => LINE.userTurn(`${tag}-${i}`));
}

function writeTranscript(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => l + "\n").join(""), "utf-8");
}

function appendTranscript(file: string, lines: string[]): void {
  fs.appendFileSync(file, lines.map((l) => l + "\n").join(""), "utf-8");
}

function runGetContext(
  tmp: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    "python3",
    [path.join(tmp, ".trellis", "scripts", "get_context.py"), ...args],
    { cwd: tmp, encoding: "utf-8" },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe.skipIf(!hasPython())("spec injection (path-scoped on-demand)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-spec-injection-"));
    setupRepo(tmp);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("common/spec_match.py: glob semantics", () => {
    it("* matches within a segment and never crosses /", () => {
      expect(
        globMatches(tmp, [
          ["src/commands/*.ts", "src/commands/update.ts"],
          ["src/commands/*.ts", "src/commands/channel/spawn.ts"],
          ["src/*", "src/app.ts"],
          ["src/*", "src/nested/app.ts"],
        ]),
      ).toEqual(["1", "0", "1", "0"]);
    });

    it("** as a whole segment crosses segments, but only strictly under the prefix", () => {
      expect(
        globMatches(tmp, [
          ["packages/**", "packages/cli/src/index.ts"],
          ["packages/**", "packages/index.ts"],
          // gitignore-like: `a/**` does not match `a` itself
          ["packages/**", "packages"],
        ]),
      ).toEqual(["1", "1", "0"]);
    });

    it("** in the middle spans zero or more segments", () => {
      expect(
        globMatches(tmp, [
          ["packages/**/index.ts", "packages/index.ts"],
          ["packages/**/index.ts", "packages/cli/src/index.ts"],
          ["packages/**/index.ts", "packages/cli/src/other.ts"],
        ]),
      ).toEqual(["1", "1", "0"]);
    });

    it("? matches exactly one character within a segment", () => {
      expect(
        globMatches(tmp, [
          ["src/util?.py", "src/utils.py"],
          ["src/util?.py", "src/util.py"],
          ["src/util?.py", "src/utilXY.py"],
          ["a?b", "a/b"],
        ]),
      ).toEqual(["1", "0", "0", "0"]);
    });

    it("trailing / is sugar for /** (matches strictly under the directory)", () => {
      expect(
        globMatches(tmp, [
          ["packages/cli/", "packages/cli/src/index.ts"],
          ["packages/cli/", "packages/cli"],
        ]),
      ).toEqual(["1", "0"]);
    });

    it("** embedded in a segment with other characters degrades to *", () => {
      expect(
        globMatches(tmp, [
          ["src/foo**.ts", "src/foobar.ts"],
          ["src/foo**.ts", "src/foo/bar.ts"],
        ]),
      ).toEqual(["1", "0"]);
    });

    it("literal characters are escaped (dot is not a wildcard)", () => {
      expect(
        globMatches(tmp, [
          ["src/app.ts", "src/app.ts"],
          ["src/app.ts", "src/appxts"],
        ]),
      ).toEqual(["1", "0"]);
    });

    // R6: validation is a deny-list, not a charset whitelist — real repos carry
    // @scope packages, [slug]/(group) route dirs and non-ASCII directories.
    it("accepts real-world path shapes (@scope, [slug], (marketing), non-ASCII dirs)", () => {
      const globs = [
        "packages/@scope/**",
        "app/[slug]/page.tsx",
        "app/(marketing)/**",
        "文档/**",
        "src/{a,b}.ts",
      ];
      const valid = runSpecProbe(
        tmp,
        `
for g in ${JSON.stringify(globs)}:
    print("ok" if validate_glob(g) is None else validate_glob(g))
`,
      );
      expect(valid.status, valid.stderr).toBe(0);
      expect(valid.stdout.trim().split("\n")).toEqual([
        "ok",
        "ok",
        "ok",
        "ok",
        "ok",
      ]);

      // …and they translate to regexes that match the literal path (the
      // special characters are escaped, not interpreted as regex syntax).
      expect(
        globMatches(tmp, [
          ["packages/@scope/**", "packages/@scope/ui/src/index.ts"],
          ["packages/@scope/**", "packages/other/ui/src/index.ts"],
          ["app/[slug]/page.tsx", "app/[slug]/page.tsx"],
          ["app/[slug]/page.tsx", "app/s/page.tsx"],
          ["app/(marketing)/**", "app/(marketing)/about/page.tsx"],
          ["app/(marketing)/**", "app/marketing/about/page.tsx"],
          ["文档/**", "文档/readme.md"],
          ["文档/**", "docs/readme.md"],
          ["src/{a,b}.ts", "src/{a,b}.ts"],
        ]),
      ).toEqual(["1", "0", "1", "0", "1", "0", "1", "0", "1"]);
    });

    it("still rejects absolute paths, .. segments, backslashes and empty globs", () => {
      const r = runSpecProbe(
        tmp,
        `
for g in ["/abs/path.ts", "a/../b.ts", "src\\\\win.ts", "", "src/app.ts"]:
    print("ok" if validate_glob(g) is None else "err")
`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "err",
        "err",
        "err",
        "err",
        "ok",
      ]);
    });
  });

  describe("common/spec_match.py: frontmatter tolerance (R6)", () => {
    it("a `description: >` block scalar does not disqualify the spec", () => {
      writeSpec(
        tmp,
        "skillish.md",
        [
          "---",
          "name: skillish",
          "description: >",
          "  A long paragraph describing what this spec is for,",
          "  written the way SKILL.md files do it.",
          "paths:",
          "  - src/**",
          "---",
          "Body",
          "",
        ].join("\n"),
      );

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      // The block scalar is consumed, the `paths:` key after it still parses.
      expect(r.stdout.trim()).toBe(".trellis/spec/skillish.md|None");
      expect(r.stderr).toBe("");
    });

    it("ignores unknown keys, unrecognized line shapes and stray list items", () => {
      writeSpec(
        tmp,
        "noisy.md",
        [
          "---",
          "title: not a key this parser knows",
          "- a stray list item outside any key",
          "prose without a colon at all",
          "paths:",
          "  - src/**",
          "allowed-tools: Read, Edit",
          "---",
          "Body",
          "",
        ].join("\n"),
      );

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(".trellis/spec/noisy.md|None");
      expect(r.stderr).toBe("");
    });

    it("tolerates an unclosed frontmatter block: body prose is ignored, declared paths still apply", () => {
      writeSpec(
        tmp,
        "unclosed.md",
        "---\npaths:\n  - src/**\n\nSome body prose here.\n",
      );

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(".trellis/spec/unclosed.md|None");
      expect(r.stderr).toBe("");
    });

    it("still treats an inline-scalar `paths:` as malformed (warn + skip); siblings match", () => {
      writeSpec(tmp, "bad.md", "---\npaths: src/**\n---\nBody\n");
      writeSpec(tmp, "good.md", "---\npaths:\n  - src/**\n---\nBody\n");

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(".trellis/spec/good.md|None");
      expect(r.stderr).toContain(
        "malformed frontmatter in .trellis/spec/bad.md",
      );
    });
  });

  describe("common/spec_match.py: match_specs_for_file", () => {
    it("returns matching specs in stable rel_path order; specs without frontmatter are ignored", () => {
      writeSpec(
        tmp,
        "cli/commands.md",
        "---\ndescription: command conventions\npaths:\n  - src/commands/**\n---\nBody\n",
      );
      writeSpec(tmp, "guides/style.md", "# Plain spec without frontmatter\n");
      writeSpec(tmp, "zz.md", "---\npaths:\n  - src/**\n---\nBody\n");

      const r = runMatch(tmp, "src/commands/update.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        ".trellis/spec/cli/commands.md|command conventions",
        ".trellis/spec/zz.md|None",
      ]);

      const miss = runMatch(tmp, "docs/readme.md");
      expect(miss.status).toBe(0);
      expect(miss.stdout.trim()).toBe("");
    });

    it("skips an invalid glob with a stderr warning; the file's remaining globs still apply", () => {
      writeSpec(
        tmp,
        "mixed.md",
        "---\npaths:\n  - /absolute/path.ts\n  - src/**\n---\nBody\n",
      );

      const r = runMatch(tmp, "src/app.ts");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(".trellis/spec/mixed.md|None");
      expect(r.stderr).toContain("invalid glob");
      expect(r.stderr).toContain("/absolute/path.ts");
    });
  });

  // ===========================================================================
  // R7: pure decision logic, imported directly from common/spec_inject.py
  // ===========================================================================

  describe("common/spec_inject.py: pure decision logic (R7)", () => {
    it("decide() follows the frozen order: stateless → first → sha → boundary → window", () => {
      const r = runInjectProbe(
        tmp,
        `
CLOCK = {"turns": 10, "boundaries": 2, "ts": 1000.0}
SAME = "a" * 64
OTHER = "b" * 64

def last(**kw):
    base = {"v": 2, "spec": "s.md", "sha256": SAME, "mode": "full",
            "ts": 1000.0, "turns": 10, "boundaries": 2}
    base.update(kw)
    return base

rows = [
    # stateless wins over everything, even a matching record
    ("stateless-no-record", decide(True, None, SAME, CLOCK, 30, 2700)),
    ("stateless-with-record", decide(True, last(), SAME, CLOCK, 30, 2700)),
    # first sight of this spec in this identity
    ("first-sight", decide(False, None, SAME, CLOCK, 30, 2700)),
    # content changed → re-teach, even deep inside the window
    ("sha-change", decide(False, last(sha256=OTHER), SAME, CLOCK, 30, 2700)),
    # compaction since the emission → the text is gone, re-teach
    ("boundary-jump", decide(False, last(boundaries=1), SAME, CLOCK, 30, 2700)),
    # a boundary count that did NOT grow is not a compaction
    ("boundary-equal", decide(False, last(boundaries=2), SAME, CLOCK, 30, 2700)),
    # inside the turn window → stay silent
    ("within-window", decide(False, last(turns=8), SAME, CLOCK, 30, 2700)),
    # past the turn window → cheap refresh
    ("past-window", decide(False, last(turns=0), SAME, CLOCK, 5, 2700)),
    # sha change beats the boundary rule and the window alike
    ("sha-change-past-window", decide(False, last(turns=0, sha256=OTHER), SAME, CLOCK, 5, 2700)),
]
for name, value in rows:
    print(f"{name}={value}")
`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "stateless-no-record=ticket",
        "stateless-with-record=ticket",
        "first-sight=full",
        "sha-change=full",
        "boundary-jump=full",
        "boundary-equal=silent",
        "within-window=silent",
        "past-window=ticket",
        "sha-change-past-window=full",
      ]);
    });

    it("within_window: turns beat seconds, 0 means infinite, negative deltas are past-window", () => {
      const r = runInjectProbe(
        tmp,
        `
rows = [
    # turn clock present on both sides → seconds are not consulted
    ("turns-inside", within_window({"turns": 5, "ts": 9e9}, {"turns": 3, "ts": 0.0}, 30, 1)),
    ("turns-at-edge", within_window({"turns": 33, "ts": 0.0}, {"turns": 3, "ts": 0.0}, 30, 2700)),
    ("turns-past", within_window({"turns": 34, "ts": 0.0}, {"turns": 3, "ts": 0.0}, 30, 2700)),
    # a shrunken/replaced transcript is a clock anomaly, not a /compact signal:
    # negative delta → past-window (the over-inject side of the asymmetry)
    ("turns-negative", within_window({"turns": 1, "ts": 0.0}, {"turns": 40, "ts": 0.0}, 30, 2700)),
    ("seconds-negative", within_window({"turns": None, "ts": 10.0}, {"turns": None, "ts": 5000.0}, 30, 2700)),
    # 0 = never refresh in that clock mode → infinite window
    ("turns-window-zero", within_window({"turns": 9999, "ts": 0.0}, {"turns": 1, "ts": 0.0}, 0, 2700)),
    ("seconds-window-zero", within_window({"turns": None, "ts": 9e9}, {"turns": None, "ts": 1.0}, 30, 0)),
    # no turn clock → seconds fallback
    ("seconds-inside", within_window({"turns": None, "ts": 100.0}, {"turns": None, "ts": 1.0}, 30, 2700)),
    ("seconds-past", within_window({"turns": None, "ts": 5000.0}, {"turns": None, "ts": 1.0}, 30, 2700)),
    # neither clock comparable → past-window
    ("incomparable", within_window({"turns": None, "ts": None}, {"turns": None, "ts": None}, 30, 2700)),
]
for name, value in rows:
    print(f"{name}={int(value)}")
`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "turns-inside=1",
        "turns-at-edge=0",
        "turns-past=0",
        "turns-negative=0",
        "seconds-negative=0",
        "turns-window-zero=1",
        "seconds-window-zero=1",
        "seconds-inside=1",
        "seconds-past=0",
        "incomparable=0",
      ]);
    });

    it("truncate_chars slices code points, never bytes; 0 or an oversized cap is a no-op", () => {
      const r = runInjectProbe(
        tmp,
        `
cjk = "宇" * 50
print("exact=%d" % len(truncate_chars(cjk, 10)))
print("bytes=%d" % len(truncate_chars(cjk, 10).encode("utf-8")))
print("replacement=%d" % truncate_chars(cjk, 10).count("\\ufffd"))
print("unlimited=%d" % len(truncate_chars(cjk, 0)))
print("negative=%d" % len(truncate_chars(cjk, -5)))
print("bigger-cap=%d" % len(truncate_chars(cjk, 500)))
print("at-len=%d" % len(truncate_chars(cjk, 50)))
print("notice=%s" % truncation_notice("a/b.md", 10).strip())
`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "exact=10",
        // 10 code points of CJK = 30 bytes: a byte cap would have cut at 10.
        "bytes=30",
        "replacement=0",
        "unlimited=50",
        "negative=50",
        "bigger-cap=50",
        "at-len=50",
        "notice=[Trellis: truncated at 10 characters — read a/b.md for the full content]",
      ]);
    });

    it("assemble_payload never exceeds max_total_chars, at any budget (hard ceiling)", () => {
      const r = runInjectProbe(
        tmp,
        `
specs = []
spec_dir = REPO_ROOT / ".trellis" / "spec"
spec_dir.mkdir(parents=True, exist_ok=True)
for i in range(6):
    rel = f".trellis/spec/s{i}.md"
    p = REPO_ROOT / rel
    p.write_text(
        f"---\\ndescription: spec number {i}\\npaths:\\n  - src/app.ts\\n---\\n" + "Z" * 400,
        encoding="utf-8",
    )
    specs.append(Cand(p, rel, f"spec number {i}"))

CLOCK = {"turns": 1, "boundaries": 0, "ts": 1.0}
for budget in (0, 50, 120, 200, 300, 500, 800, 1200, 2000, 5000):
    for stateless in (False, True):
        payload, records = assemble_payload(
            "src/app.ts", specs, stateless, {}, CLOCK, 0, budget, 30, 2700
        )
        over = budget > 0 and len(payload) > budget
        print(f"{budget}/{int(stateless)}={'OVER:' + str(len(payload)) if over else 'ok'}")
`,
      );
      expect(r.status, r.stderr).toBe(0);
      const lines = r.stdout.trim().split("\n");
      expect(lines.length).toBe(20);
      expect(lines.filter((l) => l.includes("OVER"))).toEqual([]);
    });

    it("scan_transcript counts real turns and compact boundaries only", () => {
      const transcript = path.join(tmp, "scan.jsonl");
      writeTranscript(transcript, [
        ...userTurns(2),
        LINE.toolResult(),
        LINE.meta(),
        LINE.assistant(),
        LINE.compactBoundary(),
        "not json at all",
        ...userTurns(1, "x"),
      ]);

      const r = runInjectProbe(
        tmp,
        `
counts = scan_transcript(${JSON.stringify(transcript)})
print(f"turns={counts['turns']} boundaries={counts['boundaries']}")
print("missing=%s" % scan_transcript("${path.join(tmp, "nope.jsonl").replace(/\\/g, "/")}"))
print("empty-path=%s" % scan_transcript(""))
print("none-path=%s" % scan_transcript(None))
print("over-cap=%s" % scan_transcript(${JSON.stringify(transcript)}, max_bytes=10))
`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "turns=3 boundaries=1",
        "missing=None",
        "empty-path=None",
        "none-path=None",
        "over-cap=None",
      ]);
    });

    it("amendment 4: the prefilter tolerates a space after the colon", () => {
      // A producer emitting '"type": "user"' must not silently count zero
      // turns forever (the turn clock would then never refresh).
      const transcript = path.join(tmp, "spaced.jsonl");
      fs.writeFileSync(
        transcript,
        [
          '{"type": "user", "message": {"content": "hello"}}',
          '{"type": "user", "message": {"content": ["tool_result"]}}',
          '{"type": "user", "isMeta": true, "message": {"content": "m"}}',
          '{"type":"user","message":{"content":"compact style"}}',
        ].join("\n") + "\n",
        "utf-8",
      );

      const r = runInjectProbe(
        tmp,
        `
counts = scan_transcript(${JSON.stringify(transcript)})
print(f"turns={counts['turns']} boundaries={counts['boundaries']}")
`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe("turns=2 boundaries=0");
    });

    it("make_record emits the v2 schema (turns + boundaries, no pid)", () => {
      const r = runInjectProbe(
        tmp,
        `
rec = make_record(".trellis/spec/a.md", "f" * 64, "full", {"turns": 4, "boundaries": 1, "ts": 12.5})
print(",".join(sorted(rec.keys())))
print(f"v={rec['v']} version={STATE_VERSION} turns={rec['turns']} boundaries={rec['boundaries']}")
`,
      );
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        "boundaries,mode,sha256,spec,ts,turns,v",
        "v=2 version=2 turns=4 boundaries=1",
      ]);
    });
  });

  // ===========================================================================
  // Hook E2E
  // ===========================================================================

  describe("inject-spec-context.py: hook E2E (v2 ticket-refresh)", () => {
    const SPEC_REL = ".trellis/spec/cli/commands.md";
    const EDITED = "src/commands/update.ts";
    const STATEFUL_TICKET_BODY = [
      "You were shown this spec earlier in this session and its content is unchanged.",
      "It still governs edits to matching files. If you no longer remember it, Read",
      `${SPEC_REL} before continuing.`,
    ].join("\n");
    const STATELESS_TICKET_BODY = [
      "This spec governs the file you just touched. If you have not read it in",
      `this session, Read ${SPEC_REL} before continuing.`,
    ].join("\n");

    function writeGoverningSpec(body = "Command spec body.\n"): string {
      return writeSpec(
        tmp,
        "cli/commands.md",
        `---\ndescription: command conventions\npaths:\n  - src/commands/**\n---\n${body}`,
      );
    }

    it("emits a full <spec-context sha256> block on the first touch", () => {
      writeGoverningSpec();

      const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
      expect(r.status).toBe(0);
      const ctx = additionalContext(r.stdout);
      expect(ctx).toContain(
        `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );
      expect(requireSha(ctx)).toMatch(/^[0-9a-f]{12}$/);
      expect(ctx).toContain("Command spec body.");
      expect(ctx).toContain("</spec-context>");
    });

    it("goes silent on a second touch of the same session within the refresh window", () => {
      writeGoverningSpec();
      const payload = buildPayload(tmp, { filePath: EDITED });

      const first = runHook(tmp, payload);
      expect(first.status).toBe(0);
      expect(additionalContext(first.stdout)).toContain("<spec-context");

      // No transcript → wall-clock window (default 2700s); a second touch this
      // soon is well inside it → nothing emitted.
      const second = runHook(tmp, payload);
      expect(second.status).toBe(0);
      expect(second.stdout.trim()).toBe("");

      // State landed under TRELLIS_SPEC_STATE_DIR, not in the repo's .runtime.
      expect(listJsonl(stateBase(tmp)).length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(tmp, ".trellis", ".runtime"))).toBe(false);
    });

    it("re-teaches the full spec when its content changes (sha change beats the window)", () => {
      writeGoverningSpec("Original body.\n");
      const payload = buildPayload(tmp, { filePath: EDITED });

      const first = runHook(tmp, payload);
      expect(first.status).toBe(0);
      const firstCtx = additionalContext(first.stdout);
      const firstSha = requireSha(firstCtx);
      expect(firstCtx).toContain("Original body.");

      // Rewrite the spec (new sha). Without the change, a second touch this soon
      // would be silent (within window) — a FULL emission proves sha wins.
      writeGoverningSpec("Rewritten body.\n");

      const second = runHook(tmp, payload);
      expect(second.status).toBe(0);
      const secondCtx = additionalContext(second.stdout);
      expect(secondCtx).toContain(
        `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );
      expect(secondCtx).toContain("Rewritten body.");
      expect(requireSha(secondCtx)).not.toBe(firstSha);
    });

    it("emits ticket-only with no-prior-exposure wording when the payload has no identity (R6)", () => {
      writeGoverningSpec();
      // No session_id/conversation_id/sessionID and no transcript_path → stateless.
      const payload = buildPayload(tmp, { filePath: EDITED, session: null });

      const first = runHook(tmp, payload);
      expect(first.status).toBe(0);
      const ctx1 = additionalContext(first.stdout);
      expect(ctx1).toContain(
        `<spec-ticket file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );
      expect(ctx1).toContain(STATELESS_TICKET_BODY);
      // Never claim prior exposure when there is no state to back the claim.
      expect(ctx1).not.toContain("shown this spec earlier");
      expect(ctx1).not.toContain("Command spec body.");

      const second = runHook(tmp, payload);
      expect(second.status).toBe(0);
      const ctx2 = additionalContext(second.stdout);
      expect(ctx2).toContain("<spec-ticket");
      expect(ctx2).toContain(STATELESS_TICKET_BODY);

      // Stateless tier does no state IO: no shards written.
      expect(listJsonl(stateBase(tmp))).toEqual([]);
    });

    it("honors TRELLIS_CONTEXT_ID as identity when the payload carries none (shared-resolver env tier)", () => {
      writeGoverningSpec();
      const payload = buildPayload(tmp, { filePath: EDITED, session: null });
      const env = { TRELLIS_CONTEXT_ID: "explicit-ctx" };

      // With an explicit context override the hook is NOT stateless: first
      // touch teaches in full and records state.
      const first = runHook(tmp, payload, env);
      expect(first.status).toBe(0);
      expect(additionalContext(first.stdout)).toContain(
        `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );
      expect(listJsonl(stateBase(tmp)).length).toBe(1);

      // Second touch within the window: silent, like any stateful identity.
      const second = runHook(tmp, payload, env);
      expect(second.status).toBe(0);
      expect(second.stdout.trim()).toBe("");

      // Payload identity beats the env override: a session_id in the payload
      // resolves to a DIFFERENT identity, so its first touch is full again.
      const other = runHook(
        tmp,
        buildPayload(tmp, { filePath: EDITED, session: "payload-sess" }),
        env,
      );
      expect(other.status).toBe(0);
      expect(additionalContext(other.stdout)).toContain("<spec-context");
    });

    it("keeps agent_id state separate from the same session_id without it (both first touches are full)", () => {
      writeGoverningSpec();

      const parent = runHook(
        tmp,
        buildPayload(tmp, { filePath: EDITED, session: "shared-sess" }),
      );
      expect(parent.status).toBe(0);
      expect(additionalContext(parent.stdout)).toContain(
        `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );

      // Same session_id, now carrying agent_id → independent identity → still
      // first → full (parent and subagent must NOT share dedup state).
      const sub = runHook(
        tmp,
        buildPayload(tmp, {
          filePath: EDITED,
          session: "shared-sess",
          agentId: "sub-7",
        }),
      );
      expect(sub.status).toBe(0);
      expect(additionalContext(sub.stdout)).toContain(
        `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );

      // Two distinct identity shards were written.
      expect(listJsonl(stateBase(tmp)).length).toBe(2);
    });

    it("fires on a Read tool event exactly like Edit (touching a file counts)", () => {
      writeGoverningSpec();

      const r = runHook(
        tmp,
        buildPayload(tmp, { filePath: EDITED, toolName: "Read" }),
      );
      expect(r.status).toBe(0);
      const ctx = additionalContext(r.stdout);
      expect(ctx).toContain(
        `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="`,
      );
      expect(ctx).toContain("Command spec body.");
    });

    it("ignores tools outside Read/Edit/Write/MultiEdit (miss path is a fast exit)", () => {
      writeSpec(tmp, "cli/commands.md", "---\npaths:\n  - src/**\n---\nBody\n");

      const r = runHook(
        tmp,
        buildPayload(tmp, { filePath: "src/app.ts", toolName: "Bash" }),
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });

    it("spec_injection.tools narrows the trigger set: [Edit] silences Read (R6)", () => {
      writeGoverningSpec();
      writeConfig(tmp, ["spec_injection:", "  tools:", "    - Edit"]);

      const read = runHook(
        tmp,
        buildPayload(tmp, { filePath: EDITED, toolName: "Read" }),
      );
      expect(read.status).toBe(0);
      expect(read.stdout.trim()).toBe("");
      expect(listJsonl(stateBase(tmp))).toEqual([]);

      const edit = runHook(
        tmp,
        buildPayload(tmp, { filePath: EDITED, toolName: "Edit" }),
      );
      expect(edit.status).toBe(0);
      expect(additionalContext(edit.stdout)).toContain("<spec-context");
    });

    it("exits 0 with empty stdout when no spec matches the edited file", () => {
      writeSpec(
        tmp,
        "cli/commands.md",
        "---\npaths:\n  - src/commands/**\n---\nBody\n",
      );

      const r = runHook(tmp, buildPayload(tmp, { filePath: "README.md" }));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });

    it("spec_injection.enabled: false disables injection entirely", () => {
      writeSpec(tmp, "cli/commands.md", "---\npaths:\n  - src/**\n---\nBody\n");
      writeConfig(tmp, ["spec_injection:", "  enabled: false"]);

      const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });

    it("exits 0 with empty stdout on broken stdin", () => {
      const r = runHook(tmp, "not json{{");
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe("");
    });

    // -----------------------------------------------------------------------
    // R1: budgets are measured in CHARACTERS, on the assembled payload string
    // -----------------------------------------------------------------------

    describe("R1: character budgets", () => {
      it("injects a 9,353-character CJK spec whole (a byte budget would have cut it)", () => {
        // taosu's review example, to the character. Defaults apply
        // (max_spec_chars 9400 / max_total_chars 9500).
        const header = "---\npaths:\n  - src/app.ts\n---\n";
        const content = header + "宇".repeat(9353 - header.length);
        expect([...content].length).toBe(9353);
        // …and it is ~3x that in bytes, which is exactly what broke before.
        expect(Buffer.byteLength(content, "utf-8")).toBeGreaterThan(27000);
        writeSpec(tmp, "cjk.md", content);

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        expect(fullBlockBody(ctx)).toBe(content);
        expect(ctx).not.toContain("[Trellis: truncated at");
        expect(ctx).not.toContain("�");
        // The wrapper still leaves the payload inside the per-event ceiling.
        expect([...ctx].length).toBeLessThanOrEqual(9500);
      });

      it("truncates at exactly max_spec_chars code points and appends the notice", () => {
        const header = "---\npaths:\n  - src/app.ts\n---\n";
        const content = header + "宇".repeat(500);
        writeSpec(tmp, "big.md", content);
        writeConfig(tmp, ["spec_injection:", "  max_spec_chars: 100"]);

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        const notice =
          "\n[Trellis: truncated at 100 characters — read .trellis/spec/big.md for the full content]";
        const body = fullBlockBody(ctx);
        expect(body.endsWith(notice)).toBe(true);

        const kept = body.slice(0, body.length - notice.length);
        expect([...kept].length).toBe(100);
        expect(kept).toBe([...content].slice(0, 100).join(""));
        // Character slicing can never split a multi-byte sequence.
        expect(ctx).not.toContain("�");
      });

      it("degrades overflow matches to <spec-index> lines once max_total_chars is exhausted", () => {
        writeSpec(
          tmp,
          "aa.md",
          "---\ndescription: first spec\npaths:\n  - src/app.ts\n---\n" +
            "A".repeat(200) +
            "\n",
        );
        writeSpec(
          tmp,
          "bb.md",
          "---\ndescription: second spec\npaths:\n  - src/app.ts\n---\n" +
            "B".repeat(200) +
            "\n",
        );
        writeConfig(tmp, [
          "spec_injection:",
          "  max_spec_chars: 0",
          // Fits aa.md fully plus bb.md's NAMED index line (the index block is
          // budget-counted too; the collapse-to-summary path has its own test).
          "  max_total_chars: 500",
        ]);

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        expect([...ctx].length).toBeLessThanOrEqual(500);
        expect(ctx).toContain(
          '<spec-context file="src/app.ts" spec=".trellis/spec/aa.md"',
        );
        expect(ctx).not.toContain('spec=".trellis/spec/bb.md"');
        expect(ctx).toContain("<spec-index>");
        expect(ctx).toContain("- .trellis/spec/bb.md — second spec");
        expect(ctx).toContain("</spec-index>");
      });

      it("holds the hard ceiling under pathological fan-out and collapses the rest into (+N more)", () => {
        // Many specs matching one file must not push additionalContext past the
        // configured ceiling — separators, the index block and the summary line
        // are all counted against it.
        for (let i = 0; i < 20; i++) {
          const id = String(i).padStart(2, "0");
          const description = "governing rule detail ".repeat(18).slice(0, 400) + id;
          writeSpec(
            tmp,
            `many-${id}.md`,
            `---\ndescription: ${description}\npaths:\n  - src/app.ts\n---\n` +
              "X".repeat(300) +
              "\n",
          );
        }
        writeConfig(tmp, [
          "spec_injection:",
          "  max_spec_chars: 0",
          "  max_total_chars: 2000",
        ]);

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        // EXACT ceiling on the emitted string, not an approximation.
        expect([...ctx].length).toBeLessThanOrEqual(2000);
        expect(ctx).toContain("<spec-index>");
        expect(ctx).toMatch(
          /- \(\+\d+ more governing specs over budget — run get_context\.py --mode spec --file src\/app\.ts to list them\)/,
        );
        expect(ctx).toContain("</spec-index>");
      });

      it("amendment 1: a long spec still injects a truncated BODY under the defaults, never index-only", () => {
        // Frozen 9400/9500 made truncation unreachable (body + notice +
        // wrapper > total): specs past ~9,240 chars fell straight to an index
        // line — the rejected index-only mode by another route. The derived
        // cap binary-searches the largest fitting prefix instead.
        writeSpec(
          tmp,
          "big.md",
          "---\ndescription: big spec\npaths:\n  - src/app.ts\n---\n" +
            "R".repeat(30000) +
            "\n",
        );

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        expect([...ctx].length).toBeLessThanOrEqual(9500);
        expect(ctx).toContain('<spec-context file="src/app.ts"');
        expect(ctx).toContain("truncated at");
        expect(ctx.trim().startsWith("<spec-index>")).toBe(false);
        // The derived body is maximal: the payload sits within one truncation-
        // notice length of the ceiling, not thousands of chars below it.
        expect([...ctx].length).toBeGreaterThan(9000);
      });

      it("amendment 3: FULL packing reserves room so the (+N more) summary survives realistic short paths", () => {
        // Greedy derived-cap packing used to eat the whole budget: one
        // 3000-char FULL, nine specs silently gone. The reserve keeps the
        // summary reachable with realistic (short-path) index lines.
        for (let i = 0; i < 10; i++) {
          writeSpec(
            tmp,
            `short-${i}.md`,
            `---\ndescription: rules ${i}\npaths:\n  - src/app.ts\n---\n` +
              "Y".repeat(2000) +
              "\n",
          );
        }
        writeConfig(tmp, ["spec_injection:", "  max_total_chars: 3000"]);

        const r = runHook(tmp, buildPayload(tmp, { filePath: "src/app.ts" }));
        expect(r.status).toBe(0);
        const ctx = additionalContext(r.stdout);
        expect([...ctx].length).toBeLessThanOrEqual(3000);
        expect(ctx).toContain("<spec-context");
        expect(ctx).toMatch(
          /- \(\+\d+ more governing specs over budget — run get_context\.py --mode spec --file src\/app\.ts to list them\)/,
        );
      });
    });

    // -----------------------------------------------------------------------
    // R2: the clock counts real user turns and compact boundaries
    // -----------------------------------------------------------------------

    describe("R2: real-turn transcript clock", () => {
      it("tool results, isMeta lines and assistant output do not advance the window; real turns do", () => {
        writeGoverningSpec();
        writeConfig(tmp, ["spec_injection:", "  refresh_window_turns: 3"]);

        const transcript = path.join(tmp, "transcript.jsonl");
        writeTranscript(transcript, userTurns(1, "a"));
        const payload = buildPayload(tmp, {
          filePath: EDITED,
          transcriptPath: transcript,
        });

        const first = runHook(tmp, payload);
        expect(first.status).toBe(0);
        expect(additionalContext(first.stdout)).toContain(
          `<spec-context file="${EDITED}"`,
        );
        expect(readShardRecords(soleShard(tmp))[0].turns).toBe(1);

        // 12 lines of pure noise: none of them is a real user turn, so the
        // window has not moved and the hook must stay silent.
        appendTranscript(transcript, [
          ...Array.from({ length: 4 }, () => LINE.toolResult()),
          ...Array.from({ length: 4 }, () => LINE.meta()),
          ...Array.from({ length: 4 }, () => LINE.assistant()),
        ]);

        const second = runHook(tmp, payload);
        expect(second.status).toBe(0);
        expect(second.stdout.trim()).toBe("");
        expect(readShardRecords(soleShard(tmp)).length).toBe(1);

        // Three REAL turns cross the window → cheap refresh, stateful wording.
        appendTranscript(transcript, userTurns(3, "b"));

        const third = runHook(tmp, payload);
        expect(third.status).toBe(0);
        const ctx = additionalContext(third.stdout);
        expect(ctx).toContain(
          `<spec-ticket file="${EDITED}" spec="${SPEC_REL}" sha256="`,
        );
        expect(ctx).toContain(STATEFUL_TICKET_BODY);
        expect(ctx).toContain("</spec-ticket>");
        // A ticket is a small pointer, not the full spec body.
        expect(ctx).not.toContain("Command spec body.");

        const records = readShardRecords(soleShard(tmp));
        expect(records.length).toBe(2);
        expect(records[1].mode).toBe("ticket");
        expect(records[1].turns).toBe(4);
      });

      it("a compact_boundary appended after a FULL forces another FULL with the same sha", () => {
        writeGoverningSpec();
        // A window wide enough that only the boundary rule can trigger a
        // re-emission (2 turns of drift stays far inside 100).
        writeConfig(tmp, ["spec_injection:", "  refresh_window_turns: 100"]);

        const transcript = path.join(tmp, "transcript.jsonl");
        writeTranscript(transcript, userTurns(1, "a"));
        const payload = buildPayload(tmp, {
          filePath: EDITED,
          transcriptPath: transcript,
        });

        const first = runHook(tmp, payload);
        expect(first.status).toBe(0);
        const firstCtx = additionalContext(first.stdout);
        expect(firstCtx).toContain(`<spec-context file="${EDITED}"`);
        const sha = requireSha(firstCtx);
        expect(readShardRecords(soleShard(tmp))[0].boundaries).toBe(0);

        // /compact APPENDS a boundary marker (transcripts never shrink): the
        // injected text is genuinely gone, so a ticket would be wrong here.
        appendTranscript(transcript, [
          LINE.compactBoundary(),
          ...userTurns(1, "post"),
        ]);

        const second = runHook(tmp, payload);
        expect(second.status).toBe(0);
        const ctx = additionalContext(second.stdout);
        expect(ctx).toContain(
          `<spec-context file="${EDITED}" spec="${SPEC_REL}" sha256="${sha}">`,
        );
        expect(ctx).toContain("Command spec body.");
        expect(ctx).not.toContain("<spec-ticket");

        const records = readShardRecords(soleShard(tmp));
        expect(records.map((r) => r.mode)).toEqual(["full", "full"]);
        expect(records[1].boundaries).toBe(1);
      });
    });

    // -----------------------------------------------------------------------
    // R3: with an agent_id the clock is the SUBAGENT's own transcript
    // -----------------------------------------------------------------------

    describe("R3: subagent clock", () => {
      /** Claude Code's derived layout: <dir>/<parent stem>/subagents/agent-<id>.jsonl */
      function subagentTranscript(parent: string, agentId: string): string {
        return path.join(
          path.dirname(parent),
          path.basename(parent, ".jsonl"),
          "subagents",
          `agent-${agentId}.jsonl`,
        );
      }

      it("follows the subagent's own transcript, never the idle parent's", () => {
        writeGoverningSpec();
        writeConfig(tmp, ["spec_injection:", "  refresh_window_turns: 3"]);

        const parent = path.join(tmp, "sess.jsonl");
        const sub = subagentTranscript(parent, "sub7");
        writeTranscript(parent, userTurns(1, "p"));
        writeTranscript(sub, userTurns(1, "s"));

        const payload = buildPayload(tmp, {
          filePath: EDITED,
          transcriptPath: parent,
          agentId: "sub7",
        });

        const first = runHook(tmp, payload);
        expect(first.status).toBe(0);
        expect(additionalContext(first.stdout)).toContain(
          `<spec-context file="${EDITED}"`,
        );
        expect(readShardRecords(soleShard(tmp))[0].turns).toBe(1);

        // The parent races ahead (50 real turns) while the subagent's own
        // context barely moved: reading the parent here would fire a spurious
        // refresh. The subagent clock keeps it silent.
        appendTranscript(parent, userTurns(50, "p2"));

        const second = runHook(tmp, payload);
        expect(second.status).toBe(0);
        expect(second.stdout.trim()).toBe("");

        // Now the SUBAGENT crosses its own window → ticket.
        appendTranscript(sub, userTurns(5, "s2"));

        const third = runHook(tmp, payload);
        expect(third.status).toBe(0);
        const ctx = additionalContext(third.stdout);
        expect(ctx).toContain(`<spec-ticket file="${EDITED}"`);
        expect(readShardRecords(soleShard(tmp))[1].turns).toBe(6);
      });

      it("falls back to the wall clock when the derived subagent transcript is absent", () => {
        writeGoverningSpec();
        // A tight turn window plus an infinite seconds window: if the parent's
        // turns leaked into the clock the second run would emit a ticket.
        writeConfig(tmp, [
          "spec_injection:",
          "  refresh_window_turns: 1",
          "  refresh_window_seconds: 0",
        ]);

        const parent = path.join(tmp, "sess.jsonl");
        writeTranscript(parent, userTurns(1, "p"));
        expect(fs.existsSync(subagentTranscript(parent, "ghost"))).toBe(false);

        const payload = buildPayload(tmp, {
          filePath: EDITED,
          transcriptPath: parent,
          agentId: "ghost",
        });

        const first = runHook(tmp, payload);
        expect(first.status).toBe(0);
        expect(additionalContext(first.stdout)).toContain(
          `<spec-context file="${EDITED}"`,
        );
        // No turn clock at all — not the parent's count.
        const record = readShardRecords(soleShard(tmp))[0];
        expect(record.turns).toBeNull();
        expect(record.boundaries).toBeNull();

        appendTranscript(parent, userTurns(50, "p2"));

        const second = runHook(tmp, payload);
        expect(second.status).toBe(0);
        expect(second.stdout.trim()).toBe("");
        expect(readShardRecords(soleShard(tmp)).length).toBe(1);
      });
    });

    // -----------------------------------------------------------------------
    // R4: one append-only JSONL file per identity, v2 records, no pid shards
    // -----------------------------------------------------------------------

    describe("R4: state file layout and schema", () => {
      it("writes <base>/<project16>/<identity>.jsonl — one file, no pid suffix", () => {
        writeGoverningSpec();

        const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
        expect(r.status).toBe(0);
        additionalContext(r.stdout);

        const shard = soleShard(tmp);
        // Identity comes from common.active_task.resolve_context_key
        // ("session_" + sanitized session_id) — and nothing else.
        expect(path.basename(shard)).toBe("session_sess-1.jsonl");
        expect(path.basename(path.dirname(shard))).toMatch(/^[0-9a-f]{16}$/);
        expect(path.dirname(path.dirname(shard))).toBe(stateBase(tmp));
      });

      it("records carry the frozen v2 schema (turns + boundaries, no pid, no lines)", () => {
        writeGoverningSpec();

        const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
        expect(r.status).toBe(0);
        additionalContext(r.stdout);

        const records = readShardRecords(soleShard(tmp));
        expect(records.length).toBe(1);
        const record = records[0];
        expect(Object.keys(record).sort()).toEqual([
          "boundaries",
          "mode",
          "sha256",
          "spec",
          "ts",
          "turns",
          "v",
        ]);
        expect(record.v).toBe(2);
        expect(record.spec).toBe(SPEC_REL);
        expect(record.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(record.mode).toBe("full");
        expect(typeof record.ts).toBe("number");
        // No transcript_path → no turn clock.
        expect(record.turns).toBeNull();
        expect(record.boundaries).toBeNull();
      });

      it("two sequential events share one file and append only for emissions", () => {
        writeGoverningSpec();
        const payload = buildPayload(tmp, { filePath: EDITED });

        expect(runHook(tmp, payload).status).toBe(0);
        const second = runHook(tmp, payload);
        expect(second.status).toBe(0);
        expect(second.stdout.trim()).toBe("");

        // One shard, one record: the silent hit records nothing (fixed window).
        expect(readShardRecords(soleShard(tmp)).length).toBe(1);
      });

      it("ignores foreign schema versions and re-injects (safe direction)", () => {
        writeGoverningSpec();
        const payload = buildPayload(tmp, { filePath: EDITED });

        expect(runHook(tmp, payload).status).toBe(0);
        const shard = soleShard(tmp);
        const record = readShardRecords(shard)[0];
        // Rewrite the shard as a v1 record for the same spec/sha.
        fs.writeFileSync(
          shard,
          JSON.stringify({ ...record, v: 1 }) + "\n",
          "utf-8",
        );

        const second = runHook(tmp, payload);
        expect(second.status).toBe(0);
        expect(additionalContext(second.stdout)).toContain("<spec-context");
      });
    });

    // -----------------------------------------------------------------------
    // R5: fail-closed gaps — circuit breaker + scoped GC
    // -----------------------------------------------------------------------

    describe("R5: circuit breaker and GC scope", () => {
      it("an unwritable state dir degrades to ticket-only forever, never a FULL loop", () => {
        writeGoverningSpec();
        // A regular file where the state base's parent should be: every mkdir
        // under it fails with NotADirectoryError.
        const blocker = path.join(tmp, "blocker");
        fs.writeFileSync(blocker, "not a directory\n", "utf-8");
        const env = { TRELLIS_SPEC_STATE_DIR: path.join(blocker, "state") };
        const payload = buildPayload(tmp, { filePath: EDITED });

        for (let run = 0; run < 3; run++) {
          const r = runHook(tmp, payload, env);
          expect(r.status).toBe(0);
          const ctx = additionalContext(r.stdout);
          expect(ctx).toContain(`<spec-ticket file="${EDITED}"`);
          // Circuit-breaker tickets use the no-prior-exposure wording too.
          expect(ctx).toContain(STATELESS_TICKET_BODY);
          expect(ctx).not.toContain("<spec-context");
          expect(ctx).not.toContain("Command spec body.");
          expect(r.stderr).toContain("running stateless");
        }

        // Nothing was written anywhere, including the default base.
        expect(listJsonl(stateBase(tmp))).toEqual([]);
        expect(fs.statSync(blocker).isFile()).toBe(true);
      });

      it("GC prunes only conforming shards at the exact <base>/<project16>/ depth", () => {
        writeGoverningSpec();

        const base = stateBase(tmp);
        const projectDir = path.join(base, "0123456789abcdef");
        const nestedDir = path.join(projectDir, "nested");
        fs.mkdirSync(nestedDir, { recursive: true });

        const aged = new Date(Date.now() - 72 * 3600 * 1000);
        const write = (file: string): string => {
          fs.writeFileSync(file, '{"v":2,"spec":"x"}\n', "utf-8");
          fs.utimesSync(file, aged, aged);
          return file;
        };
        // Conforming: current layout, our own legacy pid shard, and a
        // subagent shard (identity carries the `+a-<agent_id>` suffix —
        // contract amendment 2 added `+` to the name class so these prune).
        const pruned = write(path.join(projectDir, "session_old.jsonl"));
        const prunedLegacy = write(path.join(projectDir, "session_old.111.jsonl"));
        const prunedSubagent = write(
          path.join(projectDir, "session_old+a-abc123.jsonl"),
        );
        // Same depth, foreign name → never touched.
        const foreign = write(path.join(projectDir, "victim.data.jsonl"));
        // Conforming name at the WRONG depth (one too deep, and one too shallow).
        const tooDeep = write(path.join(nestedDir, "session_deep.jsonl"));
        const tooShallow = write(path.join(base, "session_top.jsonl"));

        // Age the GC marker past 1h so the pass actually fires this run.
        const lastGc = path.join(base, ".last-gc");
        fs.writeFileSync(lastGc, "", "utf-8");
        const hoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
        fs.utimesSync(lastGc, hoursAgo, hoursAgo);

        const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
        expect(r.status).toBe(0);

        expect(fs.existsSync(pruned)).toBe(false);
        expect(fs.existsSync(prunedLegacy)).toBe(false);
        expect(fs.existsSync(prunedSubagent)).toBe(false);
        expect(fs.existsSync(foreign)).toBe(true);
        expect(fs.existsSync(tooDeep)).toBe(true);
        expect(fs.existsSync(tooShallow)).toBe(true);
        expect(fs.existsSync(lastGc)).toBe(true);
      });

      it("leaves recent shards alone and skips the pass inside the 1h GC interval", () => {
        writeGoverningSpec();

        const base = stateBase(tmp);
        const projectDir = path.join(base, "fedcba9876543210");
        fs.mkdirSync(projectDir, { recursive: true });
        const agedShard = path.join(projectDir, "session_old.jsonl");
        fs.writeFileSync(agedShard, '{"v":2,"spec":"x"}\n', "utf-8");
        const aged = new Date(Date.now() - 72 * 3600 * 1000);
        fs.utimesSync(agedShard, aged, aged);

        // A FRESH marker means the hourly gate has not elapsed → no GC pass.
        fs.writeFileSync(path.join(base, ".last-gc"), "", "utf-8");

        const r = runHook(tmp, buildPayload(tmp, { filePath: EDITED }));
        expect(r.status).toBe(0);
        expect(fs.existsSync(agedShard)).toBe(true);
      });
    });
  });

  describe("get_context.py --mode spec: pull mode", () => {
    it("lists matching specs as `<rel path> — <description>` lines", () => {
      writeSpec(
        tmp,
        "cli/commands.md",
        "---\ndescription: command conventions\npaths:\n  - src/commands/**\n---\nBody\n",
      );
      writeSpec(tmp, "zz.md", "---\npaths:\n  - src/**\n---\nBody\n");

      const r = runGetContext(tmp, [
        "--mode",
        "spec",
        "--file",
        "src/commands/update.ts",
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split("\n")).toEqual([
        ".trellis/spec/cli/commands.md — command conventions",
        ".trellis/spec/zz.md — (no description)",
      ]);
    });

    it("prints the no-match sentence when nothing matches", () => {
      writeSpec(
        tmp,
        "cli/commands.md",
        "---\npaths:\n  - src/commands/**\n---\nBody\n",
      );

      const r = runGetContext(tmp, [
        "--mode",
        "spec",
        "--file",
        "src/nomatch.ts",
      ]);
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe(
        "No spec files declare paths matching src/nomatch.ts.",
      );
    });
  });
});
