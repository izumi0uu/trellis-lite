import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import inquirer from "inquirer";

vi.mock("figlet", () => ({
  default: { textSync: vi.fn(() => "TRELLIS LITE") },
}));

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn() },
}));

vi.mock("node:child_process", () => ({
  execSync: vi.fn().mockImplementation((command: string) => {
    const python = process.platform === "win32" ? "python" : "python3";
    return command === `${python} --version` ? "Python 3.11.12" : "";
  }),
}));

import { init } from "../../src/commands/init.js";
import { update } from "../../src/commands/update.js";

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};

function writeTask(
  root: string,
  relativeDir: string,
  data: Record<string, unknown>,
): string {
  const taskPath = path.join(root, ".trellis", "tasks", relativeDir, "task.json");
  fs.mkdirSync(path.dirname(taskPath), { recursive: true });
  fs.writeFileSync(taskPath, JSON.stringify(data, null, 2));
  return taskPath;
}

describe("trellis-lite update active Lite profile migration", () => {
  let root: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-lite-profile-update-"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    vi.spyOn(console, "log").mockImplementation(noop);
    vi.spyOn(console, "warn").mockImplementation(noop);
    vi.spyOn(console, "error").mockImplementation(noop);
    vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: true });
    await init({ yes: true, codex: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("migrates only active legacy Lite profiles and is idempotent at the same version", async () => {
    const legacyPath = writeTask(root, "09-01-legacy", {
      name: "legacy",
      status: "in_progress",
      lite: {
        change_mode: "P3",
        verification_level: "V3",
        checker: "on",
        allowed_paths: ["backend/**"],
        forbidden_paths: ["frontend/**"],
        selected_by: "user",
        max_verification_passes: 4,
      },
    });
    const legacyBefore = fs.readFileSync(legacyPath, "utf-8");

    const nonLitePath = writeTask(root, "09-01-non-lite", {
      name: "non-lite",
      status: "in_progress",
    });
    const nonLiteBefore = fs.readFileSync(nonLitePath, "utf-8");

    const currentPath = writeTask(root, "09-01-current", {
      name: "current",
      status: "in_progress",
      lite: {
        change_mode: "P1",
        verification_level: "V2",
        ui_verification_level: "U1",
        checker: "report",
        ui_driver: "ego-lite",
        allowed_paths: ["src/**"],
        forbidden_paths: [],
        selected_by: "user",
        scope_locked: true,
        max_verification_passes: 2,
        max_ui_verification_passes: 1,
      },
    });
    const currentBefore = fs.readFileSync(currentPath, "utf-8");

    const unknownPath = writeTask(root, "09-01-unknown-profile", {
      name: "unknown-profile",
      status: "in_progress",
      lite: {
        change_mode: "P2",
        verification_level: "V3",
        checker: "on",
        ui_verification_level: null,
        allowed_paths: [],
        forbidden_paths: [],
        selected_by: "user",
      },
    });
    const unknownBefore = fs.readFileSync(unknownPath, "utf-8");

    const archivedPath = writeTask(root, "archive/2026-09/09-01-archived", {
      name: "archived",
      status: "completed",
      lite: {
        change_mode: "P2",
        verification_level: "V2",
        checker: "on",
        allowed_paths: [],
        forbidden_paths: [],
        selected_by: "user",
      },
    });
    const archivedBefore = fs.readFileSync(archivedPath, "utf-8");

    await update({ force: true, skipRegistryCheck: true });

    const migrated = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
    expect(migrated.lite).toEqual({
      change_mode: "P3",
      verification_level: "V3",
      checker: "off",
      allowed_paths: ["backend/**"],
      forbidden_paths: ["frontend/**"],
      selected_by: "user",
      ui_verification_level: "U0",
      ui_driver: "ego-lite",
      scope_locked: true,
      max_verification_passes: 4,
      max_ui_verification_passes: 0,
    });
    expect(fs.readFileSync(nonLitePath, "utf-8")).toBe(nonLiteBefore);
    expect(fs.readFileSync(currentPath, "utf-8")).toBe(currentBefore);
    expect(fs.readFileSync(unknownPath, "utf-8")).toBe(unknownBefore);
    expect(fs.readFileSync(archivedPath, "utf-8")).toBe(archivedBefore);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        ".trellis/tasks/09-01-unknown-profile/task.json",
      ),
    );

    const backups = fs
      .readdirSync(path.join(root, ".trellis"))
      .filter((name) => name.startsWith(".backup-"));
    expect(backups).toHaveLength(1);
    expect(
      fs.readFileSync(
        path.join(
          root,
          ".trellis",
          backups[0],
          ".trellis",
          "tasks",
          "09-01-legacy",
          "task.json",
        ),
        "utf-8",
      ),
    ).toBe(legacyBefore);

    const migratedBytes = fs.readFileSync(legacyPath, "utf-8");
    await update({ force: true, skipRegistryCheck: true });
    expect(fs.readFileSync(legacyPath, "utf-8")).toBe(migratedBytes);
    expect(
      fs
        .readdirSync(path.join(root, ".trellis"))
        .filter((name) => name.startsWith(".backup-")),
    ).toEqual(backups);
  });

  it("reports a dry-run without writing the legacy profile or a backup", async () => {
    const legacyPath = writeTask(root, "09-01-dry-run", {
      name: "dry-run",
      status: "in_progress",
      lite: {
        change_mode: "P0",
        verification_level: "V1",
        checker: "off",
        allowed_paths: [],
        forbidden_paths: [],
        selected_by: "user",
      },
    });
    const before = fs.readFileSync(legacyPath, "utf-8");

    await update({ dryRun: true, skipRegistryCheck: true });

    expect(fs.readFileSync(legacyPath, "utf-8")).toBe(before);
    expect(
      fs
        .readdirSync(path.join(root, ".trellis"))
        .filter((name) => name.startsWith(".backup-")),
    ).toEqual([]);
  });
});
