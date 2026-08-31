import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("figlet", () => ({ default: { textSync: vi.fn(() => "TRELLIS LITE") } }));
vi.mock("inquirer", () => ({ default: { prompt: vi.fn().mockResolvedValue({ proceed: true }) } }));
vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    const py = process.platform === "win32" ? "python" : "python3";
    return cmd === `${py} --version` ? "Python 3.11.12" : "";
  }),
}));

import { init } from "../../src/commands/init.js";
import { uninstall } from "../../src/commands/uninstall.js";

describe("Trellis Lite uninstall", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-lite-uninstall-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is a no-op when Trellis is not installed", async () => {
    await uninstall({ yes: true });
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("removes the Codex/OMP install produced by default init", async () => {
    await init({ yes: true, force: true });
    expect(fs.existsSync(path.join(tmpDir, ".codex"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".omp"))).toBe(true);

    await uninstall({ yes: true });

    expect(fs.existsSync(path.join(tmpDir, ".trellis"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".codex", "agents"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, ".codex", "hooks"))).toBe(false);
    const codexConfig = path.join(tmpDir, ".codex", "config.toml");
    if (fs.existsSync(codexConfig)) {
      expect(fs.readFileSync(codexConfig, "utf8").toLowerCase()).not.toContain(
        "trellis",
      );
    }
    expect(fs.existsSync(path.join(tmpDir, ".omp"))).toBe(false);
  });

  it("preserves user files that were never recorded in the manifest", async () => {
    await init({ yes: true, force: true });
    const userFile = path.join(tmpDir, ".omp", "user-note.md");
    fs.writeFileSync(userFile, "keep me\n");

    await uninstall({ yes: true });

    expect(fs.readFileSync(userFile, "utf8")).toBe("keep me\n");
  });
});
