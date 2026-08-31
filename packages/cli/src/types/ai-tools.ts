/**
 * Supported AI platform registry for Trellis Lite.
 *
 * Trellis Lite intentionally supports only Codex and Oh My Pi. Keep platform
 * selection, managed paths, and template routing derived from this registry so
 * unsupported integrations cannot remain reachable through the CLI.
 */

export type AITool = "codex" | "omp";

export type TemplateDir = "common" | "codex" | "omp";

export type CliFlag = "codex" | "omp";

export interface TemplateContext {
  /** Prefix for cross-referencing other commands or skills. */
  cmdRefPrefix: "$" | "/trellis:";
  /** Description of AI executor actions shown in role tables. */
  executorAI: "Bash scripts or tool calls" | "Bash scripts or Task calls";
  /** Label for user-invocable actions. */
  userActionLabel: "Skills" | "Slash commands";
  /** Platform supports isolated sub-agents. */
  agentCapable: boolean;
  /** Platform has a project hook or extension system. */
  hasHooks: boolean;
  /** CLI flag used when rendered templates invoke platform-aware scripts. */
  cliFlag: CliFlag;
}

export interface AIToolConfig {
  name: string;
  templateDirs: TemplateDir[];
  configDir: string;
  /** Also install the shared agentskills.io skill layer. */
  supportsAgentSkills?: boolean;
  extraManagedPaths?: string[];
  cliFlag: CliFlag;
  defaultChecked: boolean;
  hasPythonHooks: boolean;
  templateContext: TemplateContext;
}

export const AI_TOOLS: Record<AITool, AIToolConfig> = {
  codex: {
    name: "Codex",
    templateDirs: ["common", "codex"],
    configDir: ".codex",
    supportsAgentSkills: true,
    cliFlag: "codex",
    defaultChecked: true,
    hasPythonHooks: true,
    templateContext: {
      cmdRefPrefix: "$",
      executorAI: "Bash scripts or tool calls",
      userActionLabel: "Skills",
      agentCapable: true,
      hasHooks: false,
      cliFlag: "codex",
    },
  },
  omp: {
    name: "Oh My Pi",
    templateDirs: ["common", "omp"],
    configDir: ".omp",
    cliFlag: "omp",
    defaultChecked: true,
    hasPythonHooks: false,
    templateContext: {
      cmdRefPrefix: "/trellis:",
      executorAI: "Bash scripts or Task calls",
      userActionLabel: "Slash commands",
      agentCapable: true,
      hasHooks: true,
      cliFlag: "omp",
    },
  },
};

export function getToolConfig(tool: AITool): AIToolConfig {
  return AI_TOOLS[tool];
}

export function getManagedPaths(tool: AITool): string[] {
  const config = AI_TOOLS[tool];
  const paths = [config.configDir];
  if (config.supportsAgentSkills) {
    paths.push(".agents/skills");
  }
  if (config.extraManagedPaths) {
    paths.push(...config.extraManagedPaths);
  }
  return paths;
}

export function getTemplateDirs(tool: AITool): TemplateDir[] {
  return AI_TOOLS[tool].templateDirs;
}
