import { describe, expect, it } from "vitest";
import {
  checkAgentTemplate,
  configYamlTemplate,
  getAllAgents,
  getAllScripts,
  implementAgentTemplate,
  workflowMdTemplate,
} from "../../src/templates/trellis/index.js";

describe("Trellis Lite core templates", () => {
  it("ships the task runtime without the removed multi-platform adapter", () => {
    const scripts = getAllScripts();
    expect(scripts.get("task.py")).toContain("def main");
    expect(scripts.get("common/active_task.py")).toContain(
      '_KNOWN_PLATFORMS = {"codex", "omp"}',
    );
    expect(scripts.has("common/cli_adapter.py")).toBe(false);
  });

  it("routes workflow content only to Codex modes and OMP", () => {
    expect(workflowMdTemplate).toContain("Codex and Oh My Pi");
    expect(workflowMdTemplate).toContain("--preset focused");
    expect(workflowMdTemplate).not.toContain("[Claude Code, Cursor");
    expect(workflowMdTemplate).not.toContain("[Gemini, Qoder");
  });

  it("keeps code and browser verification as independent evidence choices", () => {
    expect(workflowMdTemplate).toContain(
      "One V level covers frontend and backend code evidence",
    );
    expect(workflowMdTemplate).toContain("`V3` never overrides `U0`");
    expect(workflowMdTemplate).toContain(
      "default to Ego Lite (`ego-browser`)",
    );
    expect(workflowMdTemplate).toContain(
      "Other UI tools require an explicit `ui_driver` selection",
    );
    expect(workflowMdTemplate).toContain("Only that evidence set runs");
  });

  it("ships implement/check channel agents and configuration", () => {
    expect(getAllAgents()).toEqual(
      new Map([
        ["implement.md", implementAgentTemplate],
        ["check.md", checkAgentTemplate],
      ]),
    );
    expect(configYamlTemplate).toContain("codex:");
    expect(checkAgentTemplate).toContain("Do not edit files");
    expect(checkAgentTemplate).toContain("Return one report");
  });
});
