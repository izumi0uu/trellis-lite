import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const { fakeHome } = vi.hoisted(() => {
  const tempRoot = process.env.TMPDIR ?? process.env.TEMP ?? "/tmp";
  return {
    fakeHome: `${tempRoot}/trellis-lite-mem-${process.pid}-${Date.now()}`,
  };
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => fakeHome };
});

const { codexExtractDialogue, codexListSessions } =
  await import("../../src/mem/adapters/codex.js");
const { ompExtractDialogue, ompListSessions } =
  await import("../../src/mem/adapters/omp.js");
const { listMemSessions } = await import("../../src/mem/sessions.js");

function writeJsonl(file: string, rows: readonly unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function filter(cwd?: string) {
  return { platform: "all" as const, cwd, limit: 50 };
}

afterEach(() => {
  fs.rmSync(path.join(fakeHome, ".codex"), { recursive: true, force: true });
  fs.rmSync(path.join(fakeHome, ".pi"), { recursive: true, force: true });
});

afterAll(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

describe("Codex memory adapter", () => {
  it("lists and extracts user/assistant dialogue", () => {
    const cwd = "/tmp/codex-lite";
    const id = "codex-lite-session";
    const file = path.join(
      fakeHome,
      ".codex/sessions/2026/08/31",
      `rollout-2026-08-31T10-00-00-${id}.jsonl`,
    );
    writeJsonl(file, [
      { timestamp: "2026-08-31T10:00:00Z", type: "session_meta", payload: { id, cwd } },
      { timestamp: "2026-08-31T10:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello codex" }] } },
      { timestamp: "2026-08-31T10:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello back" }] } },
    ]);

    const session = codexListSessions(filter(cwd))[0];
    expect(session).toMatchObject({ id, cwd, platform: "codex" });
    expect(session && codexExtractDialogue(session)).toEqual([
      { role: "user", text: "hello codex" },
      { role: "assistant", text: "hello back" },
    ]);
  });
});

describe("OMP memory adapter", () => {
  it("reads the Pi-compatible store but exposes platform=omp", () => {
    const cwd = "/tmp/omp-lite";
    const id = "omp-lite-session";
    const projectDir = `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const file = path.join(
      fakeHome,
      ".pi/agent/sessions",
      projectDir,
      `2026-08-31_${id}.jsonl`,
    );
    writeJsonl(file, [
      { type: "session", version: 3, id, timestamp: "2026-08-31T11:00:00Z", cwd },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-08-31T11:00:01Z", message: { role: "user", content: "hello omp" } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-31T11:00:02Z", message: { role: "assistant", content: "hello back" } },
    ]);

    const session = ompListSessions(filter(cwd))[0];
    expect(session).toMatchObject({ id, cwd, platform: "omp" });
    expect(session && ompExtractDialogue(session)).toEqual([
      { role: "user", text: "hello omp" },
      { role: "assistant", text: "hello back" },
    ]);
    expect(
      listMemSessions({ filter: { platform: "omp", cwd, limit: 50 } }),
    ).toHaveLength(1);
  });
});
