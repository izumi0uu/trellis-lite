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
    expect(result.stderr).toContain("missing task.json.lite execution profile");
    expect(result.stderr).toContain("set-lite-profile");
  });

  it("writes P/V/U/checker choices and default independent budgets", () => {
    const task = createTask("selected-profile");
    const set = runTask(
      repo, "set-lite-profile", task,
      "--change-mode", "P0",
      "--verification-level", "V1",
      "--ui-verification-level", "U0",
      "--checker", "report",
      "--allow", "frontend/**",
      "--forbid", "backend/**",
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
      max_verification_passes: 1,
      max_ui_verification_passes: 0,
    });

    const start = runTask(repo, "start", task, "--allow-empty-context");
    expect(start.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(repo, task, "task.json"), "utf-8")).status).toBe("in_progress");
  });

  it("rejects a non-zero UI budget for U0", () => {
    const task = createTask("invalid-u0-budget");
    const result = runTask(
      repo, "set-lite-profile", task,
      "--change-mode", "P1",
      "--verification-level", "V2",
      "--ui-verification-level", "U0",
      "--max-ui-verification-passes", "1",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot exceed 0 for U0");
  });
});
