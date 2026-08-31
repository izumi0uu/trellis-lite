import { describe, expect, it } from "vitest";
import {
  SHARED_HOOKS_BY_PLATFORM,
  getSharedHookScripts,
  getSharedHookScriptsForPlatform,
} from "../../src/templates/shared-hooks/index.js";

describe("Codex shared hooks", () => {
  it("exposes only the Codex hook capability table", () => {
    expect(Object.keys(SHARED_HOOKS_BY_PLATFORM)).toEqual(["codex"]);
    expect(SHARED_HOOKS_BY_PLATFORM.codex).toEqual([
      "inject-workflow-state.py",
      "inject-subagent-context.py",
    ]);
  });

  it("ships no dead shared hook templates", () => {
    const all = getSharedHookScripts().map((hook) => hook.name).sort();
    const codex = getSharedHookScriptsForPlatform("codex")
      .map((hook) => hook.name)
      .sort();
    expect(all).toEqual(codex);
    expect(all).toEqual([
      "inject-subagent-context.py",
      "inject-workflow-state.py",
    ]);
  });

  it("hard-codes the Python hooks to Codex; OMP uses its extension", () => {
    for (const hook of getSharedHookScripts()) {
      expect(hook.content).toContain('return "codex"');
      expect(hook.content).not.toContain("CURSOR_PROJECT_DIR");
      expect(hook.content).not.toContain("CLAUDE_PROJECT_DIR");
    }
  });
});
