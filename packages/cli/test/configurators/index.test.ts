import { describe, expect, it } from "vitest";
import {
  ALL_MANAGED_DIRS,
  CONFIG_DIRS,
  PLATFORM_IDS,
  collectPlatformTemplates,
  getInitToolChoices,
  isManagedPath,
  resolveCliFlag,
} from "../../src/configurators/index.js";

describe("Codex/OMP platform registry", () => {
  it("contains exactly the two supported platforms", () => {
    expect(PLATFORM_IDS).toEqual(["codex", "omp"]);
    expect(CONFIG_DIRS).toEqual([".codex", ".omp"]);
    expect(getInitToolChoices().map((choice) => choice.key)).toEqual([
      "codex",
      "omp",
    ]);
  });

  it("resolves only supported CLI flags", () => {
    expect(resolveCliFlag("codex")).toBe("codex");
    expect(resolveCliFlag("omp")).toBe("omp");
    expect(resolveCliFlag("claude")).toBeUndefined();
    expect(resolveCliFlag("cursor")).toBeUndefined();
  });

  it("limits active managed roots to Trellis, Codex, OMP, and shared skills", () => {
    expect(ALL_MANAGED_DIRS).toEqual([
      ".trellis",
      ".codex",
      ".agents/skills",
      ".omp",
    ]);
    expect(isManagedPath(".codex/agents/check.toml")).toBe(true);
    expect(isManagedPath(".agents/skills/trellis-check/SKILL.md")).toBe(true);
    expect(isManagedPath(".omp/extensions/trellis/index.ts")).toBe(true);
    expect(isManagedPath(".claude/settings.json")).toBe(false);
  });

  it("collects templates for both supported platforms", () => {
    expect(collectPlatformTemplates("codex").size).toBeGreaterThan(0);
    expect(collectPlatformTemplates("omp").size).toBeGreaterThan(0);
  });
});
