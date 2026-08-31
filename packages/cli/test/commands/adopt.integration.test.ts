import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "TRELLIS LITE") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn().mockResolvedValue({ proceed: true }) },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation((cmd: string) => {
    const python = process.platform === "win32" ? "python" : "python3";
    return cmd === `${python} --version` ? "Python 3.11.12" : "";
  }),
}));

import { adopt } from "../../src/commands/adopt.js";
import { init } from "../../src/commands/init.js";
import {
  computeHash,
  loadHashes,
  saveHashes,
} from "../../src/utils/template-hash.js";

const noop = () => undefined;

function writeFixtureFile(
  root: string,
  relativePath: string,
  content: string,
): void {
  const fullPath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function setSourceVersion(root: string, version = "0.6.16"): void {
  fs.writeFileSync(path.join(root, ".trellis", ".version"), version);
}

describe("trellis-lite adopt", () => {
  let sandbox: string;
  let project: string;
  let backup: string;

  beforeEach(async () => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-adopt-test-"));
    project = path.join(sandbox, "project");
    backup = path.join(sandbox, "backup");
    fs.mkdirSync(project);
    vi.spyOn(process, "cwd").mockReturnValue(project);
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "warn").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);

    await init({ yes: true, force: true, codex: true, omp: true });
    setSourceVersion(project);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it("adopts an existing project, archives old framework files, and preserves user data byte-for-byte", async () => {
    const protectedFiles: Record<string, string> = {
      ".trellis/tasks/08-31-existing/prd.md": "existing task\n",
      ".trellis/spec/backend/index.md": "team spec\n",
      ".trellis/workspace/idah/journal-1.md": "journal\n",
      ".trellis/.runtime/sessions/context.json": '{"task":"08-31-existing"}\n',
      ".trellis/backlog/idea.md": "future idea\n",
      ".trellis/agent-traces/trace.jsonl": '{"event":"keep"}\n',
      ".trellis/.developer": "name=idah\n",
      ".trellis/.current-task": "08-31-existing\n",
    };
    for (const [relativePath, content] of Object.entries(protectedFiles)) {
      writeFixtureFile(project, relativePath, content);
    }

    const staleFiles: Record<string, string> = {
      ".agents/skills/trellis-meta/SKILL.md": "old agents meta\n",
      ".omp/skills/trellis-meta/SKILL.md": "old omp meta\n",
      ".trellis/scripts/common/cli_adapter.py": "# old adapter\n",
    };
    const hashes = loadHashes(project);
    for (const [relativePath, content] of Object.entries(staleFiles)) {
      writeFixtureFile(project, relativePath, content);
      hashes[relativePath] = computeHash(content);
    }
    for (const [relativePath, content] of Object.entries(protectedFiles)) {
      hashes[relativePath] = computeHash(content);
    }
    saveHashes(project, hashes);
    writeFixtureFile(
      project,
      ".trellis/.overlays/trellis-lite.json",
      '{"overlay_id":"trellis-lite","overlay_version":"1.0.12"}\n',
    );

    await adopt({ codex: true, omp: true, yes: true, backupDir: backup });

    expect(
      fs.readFileSync(path.join(project, ".trellis", ".version"), "utf-8"),
    ).toBe("1.0.1");
    for (const [relativePath, content] of Object.entries(protectedFiles)) {
      expect(fs.readFileSync(path.join(project, relativePath), "utf-8")).toBe(
        content,
      );
      expect(loadHashes(project)).not.toHaveProperty(relativePath);
    }
    for (const relativePath of Object.keys(staleFiles)) {
      expect(fs.existsSync(path.join(project, relativePath))).toBe(false);
      expect(
        fs.existsSync(path.join(backup, "removed-old-framework", relativePath)),
      ).toBe(true);
      expect(loadHashes(project)).not.toHaveProperty(relativePath);
    }
    expect(fs.existsSync(path.join(project, ".trellis", ".overlays"))).toBe(
      false,
    );
    expect(
      fs
        .readdirSync(path.join(project, ".trellis"))
        .some((name) => name.startsWith(".backup-")),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(
          backup,
          "removed-old-framework",
          ".trellis",
          ".overlays",
          "trellis-lite.json",
        ),
      ),
    ).toBe(true);

    const report = JSON.parse(
      fs.readFileSync(path.join(backup, "adopt-report.json"), "utf-8"),
    ) as { status: string; protectedByteIdentity: boolean };
    expect(report).toMatchObject({
      status: "complete",
      protectedByteIdentity: true,
    });
    expect(fs.readFileSync(path.join(project, "AGENTS.md"), "utf-8")).toContain(
      "managed by Trellis Lite",
    );
  });

  it("fails closed before backup or writes when a legacy framework file is unknown", async () => {
    const versionBefore = fs.readFileSync(
      path.join(project, ".trellis", ".version"),
      "utf-8",
    );
    writeFixtureFile(
      project,
      ".agents/skills/trellis-meta/custom-user-note.md",
      "do not archive me\n",
    );

    await expect(
      adopt({ codex: true, omp: true, yes: true, backupDir: backup }),
    ).rejects.toThrow(/not recognized as pristine or audited overlay output/);

    expect(fs.existsSync(backup)).toBe(false);
    expect(
      fs.readFileSync(path.join(project, ".trellis", ".version"), "utf-8"),
    ).toBe(versionBefore);
    expect(
      fs.readFileSync(
        path.join(project, ".agents/skills/trellis-meta/custom-user-note.md"),
        "utf-8",
      ),
    ).toBe("do not archive me\n");
  });

  it("fails closed before backup when a managed template has an unknown local edit", async () => {
    const workflow = path.join(project, ".trellis", "workflow.md");
    fs.appendFileSync(workflow, "\nuser customization\n");

    await expect(
      adopt({ codex: true, omp: true, yes: true, backupDir: backup }),
    ).rejects.toThrow(/stopped before writing/);

    expect(fs.existsSync(backup)).toBe(false);
    expect(fs.readFileSync(workflow, "utf-8")).toContain("user customization");
    expect(
      fs.readFileSync(path.join(project, ".trellis", ".version"), "utf-8"),
    ).toBe("0.6.16");
  });

  it("keeps version, manifest, and files unchanged during a successful dry-run", async () => {
    const versionBefore = fs.readFileSync(
      path.join(project, ".trellis", ".version"),
      "utf-8",
    );
    const hashesBefore = loadHashes(project);
    const agentsBefore = fs.readFileSync(
      path.join(project, "AGENTS.md"),
      "utf-8",
    );

    await adopt({
      codex: true,
      omp: true,
      dryRun: true,
      backupDir: backup,
    });

    expect(fs.existsSync(backup)).toBe(false);
    expect(
      fs.readFileSync(path.join(project, ".trellis", ".version"), "utf-8"),
    ).toBe(versionBefore);
    expect(loadHashes(project)).toEqual(hashesBefore);
    expect(fs.readFileSync(path.join(project, "AGENTS.md"), "utf-8")).toBe(
      agentsBefore,
    );
  });

  it("restores the exact managed snapshot when an apply-time write fails", async () => {
    const stalePath = ".trellis/scripts/common/cli_adapter.py";
    const staleContent = "# recognized old adapter\n";
    writeFixtureFile(project, stalePath, staleContent);
    const hashes = loadHashes(project);
    hashes[stalePath] = computeHash(staleContent);
    saveHashes(project, hashes);
    const agentsBefore = fs.readFileSync(
      path.join(project, "AGENTS.md"),
      "utf-8",
    );

    const originalWrite = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, "writeFileSync").mockImplementation(((
      target: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: unknown,
    ) => {
      if (
        typeof target === "string" &&
        target === path.join(project, ".trellis", ".version") &&
        data === "1.0.1"
      ) {
        throw new Error("injected version write failure");
      }
      return originalWrite(target, data, options as never);
    }) as typeof fs.writeFileSync);

    await expect(
      adopt({ codex: true, omp: true, yes: true, backupDir: backup }),
    ).rejects.toThrow(/injected version write failure/);

    expect(
      fs.readFileSync(path.join(project, ".trellis", ".version"), "utf-8"),
    ).toBe("0.6.16");
    expect(fs.readFileSync(path.join(project, stalePath), "utf-8")).toBe(
      staleContent,
    );
    expect(fs.readFileSync(path.join(project, "AGENTS.md"), "utf-8")).toBe(
      agentsBefore,
    );
    const report = JSON.parse(
      fs.readFileSync(path.join(backup, "adopt-report.json"), "utf-8"),
    ) as { status: string };
    expect(report.status).toBe("rolled-back");
  });

  it("keeps the manifest unchanged when init is repeated for configured platforms", async () => {
    const runtimeFile = ".trellis/.runtime/sessions/private.json";
    writeFixtureFile(
      project,
      ".trellis/tasks/existing/task.json",
      '{"name":"existing","status":"planning"}\n',
    );
    writeFixtureFile(project, runtimeFile, '{"private":true}\n');
    const before = loadHashes(project);

    await init({ yes: true, codex: true, omp: true });

    expect(loadHashes(project)).toEqual(before);
    expect(loadHashes(project)).not.toHaveProperty(runtimeFile);
    expect(fs.readFileSync(path.join(project, runtimeFile), "utf-8")).toBe(
      '{"private":true}\n',
    );
  });

  it.each(["0.6.7", "0.6.14", "0.6.15", "0.7.0-beta.3"])(
    "rejects unsupported Trellis source %s without writing",
    async (version) => {
      setSourceVersion(project, version);

      await expect(
        adopt({ codex: true, omp: true, yes: true, backupDir: backup }),
      ).rejects.toThrow(/adopts only the final stable Trellis baseline, 0\.6\.16/);

      expect(fs.existsSync(backup)).toBe(false);
      expect(
        fs.readFileSync(path.join(project, ".trellis", ".version"), "utf-8"),
      ).toBe(version);
    },
  );

  it("routes existing Lite projects to update without writing", async () => {
    setSourceVersion(project, "1.0.0");

    await expect(
      adopt({ codex: true, omp: true, yes: true, backupDir: backup }),
    ).rejects.toThrow(/Use `trellis-lite update` instead/);

    expect(fs.existsSync(backup)).toBe(false);
    expect(
      fs.readFileSync(path.join(project, ".trellis", ".version"), "utf-8"),
    ).toBe("1.0.0");
  });
});
