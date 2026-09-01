import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(__dirname, "../../src/templates/trellis/scripts");

function hasPython(): boolean {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function runTask(repo: string, ...args: string[]) {
  return spawnSync("python3", [".trellis/scripts/task.py", ...args], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, TRELLIS_CONTEXT_ID: "lite-profile-test" },
  });
}

describe.skipIf(!hasPython())("task.py Lite execution profile", () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-lite-profile-"));
    fs.mkdirSync(path.join(repo, ".trellis", "scripts"), { recursive: true });
    fs.cpSync(TEMPLATE_SCRIPTS, path.join(repo, ".trellis", "scripts"), { recursive: true });
    const init = spawnSync("python3", [".trellis/scripts/init_developer.py", "tester"], { cwd: repo, encoding: "utf-8" });
    if (init.status !== 0) throw new Error(init.stderr);
  });

  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  function createTask(slug: string): string {
    const result = runTask(repo, "create", slug, "--description", "profile fixture", "--slug", slug, "--no-start");
    expect(result.status).toBe(0);
    return result.stdout.trim();
  }

  it("refuses to start a planning task until the user-selected profile exists", () => {
    const task = createTask("missing-profile");
    const result = runTask(repo, "start", task, "--allow-empty-context");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("missing lite execution profile in task.json");
    expect(result.stderr).toContain("set-lite-profile");
  });

  it.each([
    ["quick", "P0", "V0", "U0", "off"],
    ["focused", "P1", "V1", "U0", "off"],
    ["release", "P2", "V3", "U0", "off"],
  ])(
    "expands the %s preset without persisting preset or numeric budgets",
    (preset, changeMode, verificationLevel, uiLevel, checker) => {
      const task = createTask(`${preset}-preset`);
      const set = runTask(repo, "set-lite-profile", task, "--preset", preset);
      expect(set.status).toBe(0);

      const data = JSON.parse(fs.readFileSync(path.join(repo, task, "task.json"), "utf-8"));
      expect(data.lite).toEqual({
        change_mode: changeMode,
        verification_level: verificationLevel,
        ui_verification_level: uiLevel,
        checker,
        ui_driver: "ego-lite",
        allowed_paths: [],
        forbidden_paths: [],
        selected_by: "user",
        scope_locked: true,
      });
      expect(data.lite).not.toHaveProperty("preset");
      expect(data.lite).not.toHaveProperty("max_verification_passes");
      expect(data.lite).not.toHaveProperty("max_ui_verification_passes");
    },
  );

  it("keeps the legacy explicit P/V/U invocation compatible", () => {
    const task = createTask("explicit-profile");
    const set = runTask(
      repo, "set-lite-profile", task,
      "--change-mode", "P0",
      "--verification-level", "V1",
      "--ui-verification-level", "U0",
      "--checker", "report",
      "--allow", "frontend/**",
      "--forbid", "backend/**",
      "--max-verification-passes", "99",
      "--max-ui-verification-passes", "99",
    );
    expect(set.status).toBe(0);

    const data = JSON.parse(fs.readFileSync(path.join(repo, task, "task.json"), "utf-8"));
    expect(data.lite).toEqual({
      change_mode: "P0",
      verification_level: "V1",
      ui_verification_level: "U0",
      checker: "report",
      ui_driver: "ego-lite",
      allowed_paths: ["frontend/**"],
      forbidden_paths: ["backend/**"],
      selected_by: "user",
      scope_locked: true,
    });
    expect(data.lite).not.toHaveProperty("max_verification_passes");
    expect(data.lite).not.toHaveProperty("max_ui_verification_passes");

    const start = runTask(repo, "start", task, "--allow-empty-context");
    expect(start.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(repo, task, "task.json"), "utf-8")).status).toBe("in_progress");
  });

  it("lets explicit policy fields override a named preset", () => {
    const task = createTask("overridden-preset");
    const result = runTask(
      repo, "set-lite-profile", task,
      "--preset", "quick",
      "--change-mode", "P3",
      "--verification-level", "V2",
      "--ui-verification-level", "U1",
      "--checker", "report",
      "--ui-driver", "playwright",
    );
    expect(result.status).toBe(0);

    const data = JSON.parse(fs.readFileSync(path.join(repo, task, "task.json"), "utf-8"));
    expect(data.lite).toMatchObject({
      change_mode: "P3",
      verification_level: "V2",
      ui_verification_level: "U1",
      checker: "report",
      ui_driver: "playwright",
    });
  });

  it("requires explicit P/V/U values for the custom preset", () => {
    const task = createTask("incomplete-custom");
    const result = runTask(
      repo, "set-lite-profile", task,
      "--preset", "custom",
      "--change-mode", "P1",
      "--verification-level", "V2",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--preset custom requires explicit --ui-verification-level");
  });
});
