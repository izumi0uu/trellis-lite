import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync, readSync } from "node:fs";
import { join, dirname, basename, isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Project root detection
// ---------------------------------------------------------------------------

function findProjectRoot(startDir: string): string | null {
   let current = startDir;
   while (true) {
      if (existsSync(join(current, ".trellis"))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
   }
   return null;
}

// ---------------------------------------------------------------------------
// Session identity helpers (mirrors Python _sanitize_key / _hash_value / _context_key)
// ---------------------------------------------------------------------------

function sanitizeKey(raw: string): string {
   const safe = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+|[._-]+$/g, "");
   return safe ? safe.slice(0, 160) : "";
}

function hashValue(raw: string): string {
   return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

function buildContextKey(platformName: string, kind: string, value: string): string {
   if (kind === "transcript") {
      return `${platformName}_transcript_${hashValue(value)}`;
   }
   const safeValue = sanitizeKey(value);
   return safeValue ? `${platformName}_${safeValue}` : `${platformName}_${hashValue(value)}`;
}

function deriveContextKey(ctx?: { sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined } }): string | null {
   const sessionId = ctx?.sessionManager?.getSessionId?.();
   if (sessionId) {
      return buildContextKey("omp", "session", sessionId);
   }
   const sessionFile = ctx?.sessionManager?.getSessionFile?.();
   if (sessionFile) {
      return buildContextKey("omp", "transcript", sessionFile);
   }
   const override = process.env.TRELLIS_CONTEXT_ID?.trim();
   return override ? sanitizeKey(override) || hashValue(override) : null;
}

function isInsideRoot(root: string, candidate: string): boolean {
   const rel = relative(root, candidate);
   return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Trusted context roots (mirrors packages/cli/src/commands/channel/context-trust.ts;
// standalone copy since templates don't import from the CLI package).
// ---------------------------------------------------------------------------

const AUTO_TRUST_ENTRIES = ["tasks", "workspace"];

function stripTrustValue(s: string): string {
   return s.trim().replace(/\s*#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
}

function parseChannelTrustSection(content: string): { trustedDirs: string[]; autoTrustSymlinks?: boolean } {
   const lines = content.split("\n");
   const trustedDirs: string[] = [];
   let autoTrustSymlinks: boolean | undefined;
   let inChannel = false;
   let inList = false;

   for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      const trimmed = line.trimEnd();
      if (trimmed.trim().startsWith("#")) continue;

      if (/^channel:\s*$/.test(trimmed)) {
         inChannel = true;
         inList = false;
         continue;
      }
      if (!inChannel) continue;

      if (trimmed.trim() !== "" && /^\S/.test(line)) {
         inChannel = false;
         inList = false;
         continue;
      }
      if (trimmed.trim() === "") continue;

      if (inList) {
         const item = trimmed.match(/^ {4}-\s*(.+)$/);
         if (item) {
            const val = stripTrustValue(item[1]!);
            if (val) trustedDirs.push(val);
            continue;
         }
         inList = false;
      }

      if (/^ {2}trusted_context_dirs:\s*$/.test(trimmed)) {
         inList = true;
         continue;
      }

      const boolMatch = trimmed.match(/^ {2}auto_trust_trellis_symlinks:\s*(.+)$/);
      if (boolMatch) {
         const val = stripTrustValue(boolMatch[1]!).toLowerCase();
         if (val === "false") autoTrustSymlinks = false;
         else if (val === "true") autoTrustSymlinks = true;
         else process.stderr.write(`[channel] channel.auto_trust_trellis_symlinks: invalid value '${val}', ignoring\n`);
         continue;
      }
   }

   return { trustedDirs, autoTrustSymlinks };
}

function resolveTrustedRoots(projectRoot: string): string[] {
   const configPath = join(projectRoot, ".trellis", "config.yaml");
   let config: { trustedDirs: string[]; autoTrustSymlinks?: boolean } = { trustedDirs: [] };
   if (existsSync(configPath)) {
      try {
         config = parseChannelTrustSection(readFileSync(configPath, "utf-8"));
      } catch {
         // ignore
      }
   }

   const roots: string[] = [];
   for (const entry of config.trustedDirs) {
      try {
         roots.push(realpathSync(resolve(projectRoot, entry)));
      } catch {
         // entry not found or invalid — skip
      }
   }

   if (config.autoTrustSymlinks !== false) {
      for (const entryName of AUTO_TRUST_ENTRIES) {
         const entryPath = join(projectRoot, ".trellis", entryName);
         try {
            if (lstatSync(entryPath).isSymbolicLink()) {
               roots.push(realpathSync(entryPath));
            }
         } catch {
            // missing / broken symlink — nothing to trust
         }
      }
   }

   return [...new Set(roots)];
}

function resolveProjectFile(
   projectRoot: string,
   file: string,
   trustedRoots: string[],
): string | null {
   try {
      const rootReal = realpathSync(projectRoot);
      const targetReal = realpathSync(resolve(projectRoot, file));
      if (isInsideRoot(rootReal, targetReal)) return targetReal;
      if (trustedRoots.some((root) => isInsideRoot(root, targetReal))) return targetReal;
      return null;
   } catch {
      return null;
   }
}

function displayProjectPath(projectRoot: string, filePath: string, taskDir?: string): string {
   const direct = relative(projectRoot, filePath).split("\\").join("/");
   if (direct && !direct.startsWith("../") && !isAbsolute(direct)) return direct;
   if (taskDir) {
      const taskRelative = relative(projectRoot, taskDir).split("\\").join("/");
      const taskLabel = taskRelative && !taskRelative.startsWith("../") && !isAbsolute(taskRelative)
         ? taskRelative
         : `.trellis/tasks/${basename(taskDir)}`;
      const withinTask = relative(taskDir, filePath).split("\\").join("/");
      if (withinTask && !withinTask.startsWith("../") && !isAbsolute(withinTask)) {
         return `${taskLabel}/${withinTask}`;
      }
   }
   try {
      return relative(realpathSync(projectRoot), realpathSync(filePath)).split("\\").join("/");
   } catch {
      return relative(projectRoot, filePath).split("\\").join("/");
   }
}

// ---------------------------------------------------------------------------
// Active task resolution
// ---------------------------------------------------------------------------

function resolveActiveTaskStatus(
   projectRoot: string,
   contextKey: string | null,
): { status: string; taskDir: string | null; taskTitle: string | null } {
   const sessionsDir = join(projectRoot, ".trellis", ".runtime", "sessions");
   if (!existsSync(sessionsDir)) return { status: "no_task", taskDir: null, taskTitle: null };

   // --- 通过 context key 解析 session 文件 ---
   let sessionFilePath: string | null = null;

   if (contextKey) {
      const candidate = join(sessionsDir, `${contextKey}.json`);
      if (existsSync(candidate)) {
         sessionFilePath = candidate;
      } else {
         return { status: "no_task", taskDir: null, taskTitle: null };
      }
   } else {
      // No identity: use single-session fallback only when there is exactly one session file.
      let sessionFiles: string[];
      try {
         sessionFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
      } catch {
         return { status: "no_task", taskDir: null, taskTitle: null };
      }
      if (sessionFiles.length === 1) {
         sessionFilePath = join(sessionsDir, sessionFiles[0]);
      } else {
         return { status: "no_task", taskDir: null, taskTitle: null };
      }
   }

   // --- 读取 session 数据 ---
   let sessionData: Record<string, unknown>;
   try {
      sessionData = JSON.parse(readFileSync(sessionFilePath, "utf-8"));
   } catch {
      return { status: "no_task", taskDir: null, taskTitle: null };
   }

   const currentTask = sessionData.current_task;
   if (typeof currentTask !== "string" || !currentTask)
      return { status: "no_task", taskDir: null, taskTitle: null };

   // Same jail the jsonl-referenced files already go through below. `task.py`
   // now refuses to store a ref that leaves the project, but a session file
   // written before that fix can still hold one, and `trellis update` does not
   // rewrite session files — so a poisoned pointer outlives the upgrade that
   // closed the writer.
   const taskDir = resolveProjectFile(projectRoot, currentTask, resolveTrustedRoots(projectRoot));
   if (!taskDir) return { status: "no_task", taskDir: null, taskTitle: null };
   const taskJsonPath = join(taskDir, "task.json");
   if (!existsSync(taskJsonPath)) return { status: "no_task", taskDir: null, taskTitle: null };

   let taskData: Record<string, unknown>;
   try {
      taskData = JSON.parse(readFileSync(taskJsonPath, "utf-8"));
   } catch {
      return { status: "no_task", taskDir: null, taskTitle: null };
   }

   return {
      status: typeof taskData.status === "string" ? taskData.status : "planning",
      taskDir,
      taskTitle: typeof taskData.title === "string" ? taskData.title : null,
   };
}

// ---------------------------------------------------------------------------
// Session context — spawns get_context.py default mode (same as Claude hook)
// ---------------------------------------------------------------------------

const SESSION_CONTEXT_TIMEOUT_MS = 5000;

function buildSessionContext(projectRoot: string, contextKey: string | null): string {
   const script = join(projectRoot, ".trellis", "scripts", "get_context.py");
   if (!existsSync(script)) return "";

   try {
      const result = spawnSync("python3", [script], {
         cwd: projectRoot,
         encoding: "utf-8",
         env: contextKey
            ? { ...process.env, TRELLIS_CONTEXT_ID: contextKey }
            : process.env,
         timeout: SESSION_CONTEXT_TIMEOUT_MS,
         windowsHide: true,
      });
      if (result.status !== 0 || !result.stdout?.trim()) {
         return "";
      }
      return `<session-context>\n${result.stdout.trim()}\n</session-context>`;
   } catch {
      return "";
   }
}

// ---------------------------------------------------------------------------
// Task context — prd.md, info.md, and jsonl-referenced spec/research files
// ---------------------------------------------------------------------------

type AgentType = "trellis-implement" | "trellis-check" | "trellis-research" | null;

function taskContextJsonlNames(agentType?: AgentType): string[] {
   if (agentType === "trellis-implement") return ["implement.jsonl"];
   if (agentType === "trellis-check") return ["check.jsonl"];
   if (agentType === "trellis-research") return [];
   return ["implement.jsonl", "check.jsonl"];
}

function taskContextInputPaths(projectRoot: string, taskDir: string, agentType?: AgentType): string[] {
   const trustedRoots = resolveTrustedRoots(projectRoot);
   const paths = new Set<string>([join(taskDir, "prd.md"), join(taskDir, "info.md")]);
   for (const jsonlName of taskContextJsonlNames(agentType)) {
      const jsonlPath = join(taskDir, jsonlName);
      paths.add(jsonlPath);
      if (!existsSync(jsonlPath)) continue;
      let lines: string[];
      try { lines = readFileSync(jsonlPath, "utf-8").split(/\r?\n/); } catch { continue; }
      for (const line of lines) {
         try {
            const row = JSON.parse(line.trim()) as Record<string, unknown>;
            const file = typeof row.file === "string" ? row.file.trim() : "";
            const candidatePath = file ? resolve(projectRoot, file) : "";
            if (candidatePath && isInsideRoot(resolve(projectRoot), candidatePath)) paths.add(candidatePath);
            const targetPath = file ? resolveProjectFile(projectRoot, file, trustedRoots) : null;
            if (targetPath) paths.add(targetPath);
         } catch {
            // Seed rows and malformed lines do not contribute referenced files.
         }
      }
   }
   return [...paths];
}

function taskContextSignature(projectRoot: string, taskDir: string, agentType?: AgentType): string {
   return taskContextInputPaths(projectRoot, taskDir, agentType).map((filePath) => {
      try {
         const stat = statSync(filePath);
         return `${filePath}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
      } catch {
         return `${filePath}:missing`;
      }
   }).join("\n");
}

interface ContextInjectionLimits {
   max_file_bytes: number;
   max_artifact_bytes: number;
   max_total_bytes: number;
}

const DEFAULT_CONTEXT_INJECTION_LIMITS: ContextInjectionLimits = {
   max_file_bytes: 32768,
   max_artifact_bytes: 65536,
   max_total_bytes: 131072,
};
const MAX_JSONL_BYTES = 1024 * 1024;

function stripInlineComment(value: string): string {
   let quote: string | null = null;
   for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (quote) {
         if (char === quote) quote = null;
         continue;
      }
      if (char === "'" || char === '"') {
         quote = char;
         continue;
      }
      if (char === "#" && (i === 0 || /\s/.test(value[i - 1]!))) {
         return value.slice(0, i);
      }
   }
   return value;
}

function unquoteYaml(value: string): string {
   return value.length >= 2 && value[0] === value[value.length - 1] &&
      (value[0] === "'" || value[0] === '"')
      ? value.slice(1, -1)
      : value;
}

function readContextInjectionLimits(projectRoot: string): ContextInjectionLimits {
   const limits = { ...DEFAULT_CONTEXT_INJECTION_LIMITS };
   let config = "";
   try { config = readFileSync(join(projectRoot, ".trellis", "config.yaml"), "utf-8"); } catch { return limits; }

   let inSection = false;
   let sectionIndent = -1;
   for (const rawLine of config.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!inSection) {
         if (/^context_injection\s*:\s*(#.*)?$/.test(trimmed)) {
            inSection = true;
            sectionIndent = rawLine.length - rawLine.trimStart().length;
         }
         continue;
      }
      if (!trimmed || trimmed.startsWith("#")) continue;
      const indent = rawLine.length - rawLine.trimStart().length;
      if (indent <= sectionIndent) break;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (!match || !(match[1] in limits)) continue;
      const rawValue = unquoteYaml(stripInlineComment(match[2]!).trim()).trim();
      if (!/^\d+$/.test(rawValue)) continue;
      (limits as unknown as Record<string, number>)[match[1]!] = Number.parseInt(rawValue, 10);
   }
   return limits;
}

class ContextBudget {
   used = 0;
   constructor(private readonly maxTotalBytes: number) {}

   hasRoom(bytes: number): boolean {
      return this.maxTotalBytes <= 0 || this.used + bytes <= this.maxTotalBytes;
   }

   add(bytes: number): void {
      this.used += bytes;
   }
}

function truncateUtf8(data: Buffer, cap: number): Buffer {
   if (cap <= 0 || data.length <= cap) return data;
   let end = cap;
   while (end > 0 && (data[end - 1]! & 0xc0) === 0x80) end--;
   if (end === 0) return Buffer.alloc(0);
   const lead = data[end - 1]!;
   if (lead & 0x80) {
      let sequenceLength = 1;
      if ((lead & 0xe0) === 0xc0) sequenceLength = 2;
      else if ((lead & 0xf0) === 0xe0) sequenceLength = 3;
      else if ((lead & 0xf8) === 0xf0) sequenceLength = 4;
      if (end - 1 + sequenceLength > cap) end--;
   }
   return data.subarray(0, end);
}

function isUtf8(data: Buffer): boolean {
   try {
      const decoded = data.toString("utf-8");
      return Buffer.from(decoded, "utf-8").equals(data);
   } catch {
      return false;
   }
}

function readFilePrefix(filePath: string, maxBytes: number): { data: Buffer; size: number } | null {
   let fd: number | null = null;
   try {
      const size = statSync(filePath).size;
      if (maxBytes <= 0 || size <= maxBytes) {
         return { data: readFileSync(filePath), size };
      }
      fd = openSync(filePath, "r");
      // Read a few extra bytes so a UTF-8 sequence crossing the cap can be
      // validated before truncateUtf8 removes its incomplete suffix.
      const data = Buffer.allocUnsafe(maxBytes + 4);
      const bytesRead = readSync(fd, data, 0, data.length, 0);
      return { data: data.subarray(0, bytesRead), size };
   } catch {
      return null;
   } finally {
      if (fd !== null) closeSync(fd);
   }
}

function omittedNotice(file: string, size: number | null, reason: string): string {
   const sizeText = size === null ? "unknown bytes" : `${size} bytes`;
   return `### ${file} [omitted]\n\n[Trellis: omitted (${reason}) — ${file} (${sizeText}); required_read: ${file}]`;
}

function budgetedBlock(
   budget: ContextBudget,
   file: string,
   content: string,
   status: "inline" | "truncated",
   size: number,
   reason: string,
): string {
   const block = `### ${file} [${status}]\n\n${content}`;
   if (budget.hasRoom(Buffer.byteLength(block, "utf-8"))) {
      budget.add(Buffer.byteLength(block, "utf-8"));
      return block;
   }
   const notice = omittedNotice(file, size, `total context limit reached: ${reason}`);
   budget.add(Buffer.byteLength(notice, "utf-8"));
   return notice;
}

function materializeFile(
   targetPath: string,
   displayPath: string,
   reason: string,
   limits: ContextInjectionLimits,
   budget: ContextBudget,
): string {
   const file = readFilePrefix(targetPath, limits.max_file_bytes);
   if (!file) {
      return omittedNotice(displayPath, null, "file is missing or unreadable");
   }
   const { data, size } = file;
   const truncated = truncateUtf8(data, limits.max_file_bytes);
   if (truncated.includes(0) || !isUtf8(truncated)) {
      const notice = omittedNotice(displayPath, size, `binary or non-UTF-8 file: ${reason}`);
      budget.add(Buffer.byteLength(notice, "utf-8"));
      return notice;
   }
   let content = truncated.toString("utf-8");
   let status: "inline" | "truncated" = "inline";
   if (truncated.length < size) {
      status = "truncated";
      content += `\n[Trellis: truncated at ${limits.max_file_bytes} bytes — read ${displayPath} for the full content]`;
   }
   return budgetedBlock(budget, displayPath, content, status, size, reason);
}

function materializeArtifact(
   targetPath: string,
   displayPath: string,
   reason: string,
   limits: ContextInjectionLimits,
   budget: ContextBudget,
): string {
   const file = readFilePrefix(targetPath, limits.max_artifact_bytes);
   if (!file) {
      return omittedNotice(displayPath, null, "artifact is missing or unreadable");
   }
   const { data, size } = file;
   const truncated = truncateUtf8(data, limits.max_artifact_bytes);
   if (truncated.includes(0) || !isUtf8(truncated)) {
      const notice = omittedNotice(displayPath, size, `binary or non-UTF-8 artifact: ${reason}`);
      budget.add(Buffer.byteLength(notice, "utf-8"));
      return notice;
   }
   let content = truncated.toString("utf-8");
   let status: "inline" | "truncated" = "inline";
   if (truncated.length < size) {
      status = "truncated";
      content += `\n[Trellis: truncated at ${limits.max_artifact_bytes} bytes — read ${displayPath} for the full content]`;
   }
   return budgetedBlock(budget, displayPath, content, status, size, reason);
}

function readJsonlLines(jsonlPath: string, displayPath: string): { lines: string[]; omitted: string | null } {
   let size: number;
   try {
      size = statSync(jsonlPath).size;
   } catch {
      return { lines: [], omitted: null };
   }
   if (size > MAX_JSONL_BYTES) {
      return {
         lines: [],
         omitted: omittedNotice(displayPath, size, `manifest exceeds ${MAX_JSONL_BYTES} byte parse limit`),
      };
   }
   try {
      return { lines: readFileSync(jsonlPath, "utf-8").split(/\r?\n/), omitted: null };
   } catch {
      return { lines: [], omitted: omittedNotice(displayPath, size, "manifest is missing or unreadable") };
   }
}

function buildTaskContext(projectRoot: string, taskDir: string, agentType?: AgentType): string {
   const parts: string[] = [];
   // Resolved once per call (not per referenced file) — avoids re-parsing
   // config.yaml for every jsonl row.
   const trustedRoots = resolveTrustedRoots(projectRoot);
   const limits = readContextInjectionLimits(projectRoot);
   const budget = new ContextBudget(limits.max_total_bytes);

   // prd.md and info.md — always included
   const prdPath = join(taskDir, "prd.md");
   const relativePrdPath = displayProjectPath(projectRoot, prdPath, taskDir);
   if (existsSync(prdPath)) parts.push(materializeArtifact(prdPath, relativePrdPath, "Requirements document", limits, budget));
   const infoPath = join(taskDir, "info.md");
   const relativeInfoPath = displayProjectPath(projectRoot, infoPath, taskDir);
   if (existsSync(infoPath)) parts.push(materializeArtifact(infoPath, relativeInfoPath, "Task information", limits, budget));

   // Determine which jsonl files to read based on agent type
   const jsonlNames = taskContextJsonlNames(agentType);

   // A file may be referenced by both manifests. Use the resolved real path so
   // relative aliases and symlinked paths cannot consume the context budget twice.
   const includedPaths = new Set<string>();

   for (const jsonlName of jsonlNames) {
      const jsonlPath = join(taskDir, jsonlName);
      if (!existsSync(jsonlPath)) continue;

      const relativeJsonlPath = displayProjectPath(projectRoot, jsonlPath, taskDir);
      const manifest = readJsonlLines(jsonlPath, relativeJsonlPath);
      if (manifest.omitted) {
         parts.push(`## ${jsonlName}\n\n${manifest.omitted}`);
         continue;
      }

      const fileChunks: string[] = [];
      for (const line of manifest.lines) {
         const trimmed = line.trim();
         if (!trimmed) continue;
         try {
            const row = JSON.parse(trimmed) as Record<string, unknown>;
            const file = typeof row.file === "string" ? row.file.trim() : "";
            if (!file) continue;
            const targetPath = resolveProjectFile(projectRoot, file, trustedRoots);
            if (!targetPath) continue;
            if (includedPaths.has(targetPath)) continue;
            includedPaths.add(targetPath);
            fileChunks.push(materializeFile(targetPath, file, typeof row.reason === "string" ? row.reason : "-", limits, budget));
         } catch {
            // seed rows and malformed lines are non-fatal
         }
      }

      if (fileChunks.length > 0) {
         parts.push(`## ${jsonlName}\n\n${fileChunks.join("\n\n---\n\n")}`);
      }
   }

   return parts.length > 0
      ? `<task-context>\nContext is bounded by .trellis/config.yaml. Files marked [truncated] or [omitted] remain authoritative on disk; use their required_read path before relying on missing detail.\n\n${parts.join("\n\n")}\n</task-context>`
      : "";
}

// ---------------------------------------------------------------------------
// Per-turn cache — prevents redundant workflow-state resolution within a
// single event cascade (input, before_agent_start, and context fire closely)
// ---------------------------------------------------------------------------

const SESSION_OVERVIEW_TEXT =
   "Trellis workflow system active. Use skills and agents as directed by the workflow state.";

class TurnContextCache {
   private key: string | null = null;
   private timestamp = 0;
   private workflowMsg = "";
   private static readonly TTL_MS = 1500;

   get(projectRoot: string, contextKey: string | null): { workflowMsg: string } {
      const now = Date.now();
      const cacheKey = `${projectRoot}:${contextKey ?? ""}`;
      if (
         this.key === cacheKey &&
         now - this.timestamp < TurnContextCache.TTL_MS
      ) {
         return { workflowMsg: this.workflowMsg };
      }

      const { status } = resolveActiveTaskStatus(projectRoot, contextKey);

      const workflowPath = join(projectRoot, ".trellis", "workflow.md");
      let workflowMd = "";
      try { workflowMd = readFileSync(workflowPath, "utf-8"); } catch { }

      let workflowBody = "";
      if (workflowMd) {
         const blocks = parseWorkflowStateBlocks(workflowMd);
         const activeBlock = blocks.find((b) => b.status === status);
         if (activeBlock) {
            workflowBody = `[workflow-state:${activeBlock.status}]\n${activeBlock.content}\n[/workflow-state:${activeBlock.status}]`;
         }
      }
      if (!workflowBody) {
         workflowBody = "Refer to workflow.md for current step.";
      }

      this.workflowMsg = `<workflow-state>\n${workflowBody}\n</workflow-state>\n\n<session-overview>\n${SESSION_OVERVIEW_TEXT}\n</session-overview>`;

      this.key = cacheKey;
      this.timestamp = now;
      return { workflowMsg: this.workflowMsg };
   }
}

// ---------------------------------------------------------------------------
// Workflow-state tag parsing
// ---------------------------------------------------------------------------

const WORKFLOW_STATE_RE =
   /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n([\s\S]*?)\n\s*\[\/workflow-state:\1\]/g;

interface WorkflowStateBlock {
   status: string;
   content: string;
}

function parseWorkflowStateBlocks(markdown: string): WorkflowStateBlock[] {
   const blocks: WorkflowStateBlock[] = [];
   for (const match of markdown.matchAll(WORKFLOW_STATE_RE)) {
      blocks.push({
         status: match[1],
         content: match[2].trim(),
      });
   }
   return blocks;
}

// ---------------------------------------------------------------------------
// Sub-agent detection
// ---------------------------------------------------------------------------

const TRELLIS_AGENTS = new Set(["trellis-implement", "trellis-check", "trellis-research"]);

function detectAgentType(): AgentType {
   const blocked = process.env.PI_BLOCKED_AGENT;
   if (blocked && TRELLIS_AGENTS.has(blocked)) {
      return blocked as AgentType;
   }
   return null;
}

interface TaskContextCache {
   projectRoot: string;
   taskDir: string;
   agentType: AgentType;
   signature: string;
   content: string;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function(pi: ExtensionAPI): void {
   let projectRoot: string | null = null;
   const turnCache = new TurnContextCache();
   const agentType = detectAgentType();
   const isSubAgent = agentType !== null;
   let taskContextCache: TaskContextCache | null = null;

   // Tracks compaction boundaries — context handler skips scanning when no
   // compaction has occurred since last injection.
   let lastCompactionTs = 0;
   let lastInjectionTs = 0;

   const rememberContextKey = (ctx?: { sessionManager?: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined } }): string | null => {
      const key = deriveContextKey(ctx);
      if (!key) return null;
      return key;
   };

   const getTaskContext = (taskDir: string, root: string): string => {
      const signature = taskContextSignature(root, taskDir, agentType);
      if (taskContextCache?.projectRoot === root && taskContextCache.taskDir === taskDir && taskContextCache.agentType === agentType && taskContextCache.signature === signature) {
         return taskContextCache.content;
      }
      const content = buildTaskContext(root, taskDir, agentType);
      taskContextCache = { projectRoot: root, taskDir, agentType, signature, content };
      return content;
   };

   pi.on("session_start", async (_event, ctx) => {
      projectRoot = findProjectRoot(ctx.cwd);
      const contextKey = rememberContextKey(ctx);

      if (!projectRoot) return;

      if (isSubAgent) {
         // Sub-agent: inject precise task context once
         const { taskDir } = resolveActiveTaskStatus(projectRoot, contextKey);
         if (taskDir) {
            const taskContext = getTaskContext(taskDir, projectRoot);
            if (taskContext) {
               await pi.sendMessage({
                  customType: "trellis-task-context",
                  content: taskContext,
                  display: false,
               });
            }
         }
      } else {
         // Main session: inject session context (global map) + task context
         const sessionContext = buildSessionContext(projectRoot, contextKey);
         if (sessionContext) {
            await pi.sendMessage({
               customType: "trellis-session-context",
               content: sessionContext,
               display: false,
            });
         }

         const { taskDir } = resolveActiveTaskStatus(projectRoot, contextKey);
         if (taskDir) {
            const taskContext = getTaskContext(taskDir, projectRoot);
            if (taskContext) {
               await pi.sendMessage({
                  customType: "trellis-task-context",
                  content: taskContext,
                  display: false,
               });
            }
         }

         ctx.ui.notify("Trellis workflow system available", "info");
      }
   });

   pi.on("session_before_compact", async () => {
      lastCompactionTs = Date.now();
   });

   pi.on("before_agent_start", async (_event, ctx) => {
      if (!projectRoot) {
         projectRoot = findProjectRoot(ctx.cwd);
      }
      if (!projectRoot) return;
      const contextKey = rememberContextKey(ctx);

      // Persistent injection: workflow state for this turn
      const cached = turnCache.get(projectRoot, contextKey);
      lastInjectionTs = Date.now();

      return {
         message: {
            customType: "trellis-workflow-state",
            content: cached.workflowMsg,
            display: false,
         },
      };
   });

   // context fires before EVERY LLM API call (including tool-use continuations
   // and post-compaction agent.continue() paths). Acts as a safety net when
   // before_agent_start's persisted message was removed by compaction.
   pi.on("context", async (event, ctx) => {
      if (!projectRoot) return;
      const contextKey = rememberContextKey(ctx);

      const messages = event.messages as { role?: string; customType?: string; content?: string }[];
      const { taskDir } = resolveActiveTaskStatus(projectRoot, contextKey);
      const currentTaskContext = taskDir ? getTaskContext(taskDir, projectRoot) : "";
      const taskContextIndexes = messages
         .map((message, index) => message.customType === "trellis-task-context" ? index : -1)
         .filter((index) => index >= 0);
      const existingTaskContext = taskContextIndexes.length > 0
         ? messages[taskContextIndexes[0]]?.content ?? ""
         : "";
      const taskContextChanged = existingTaskContext !== currentTaskContext || taskContextIndexes.length > 1;
      let projectedMessages = messages;
      if (taskContextChanged) {
         const replacement = currentTaskContext
            ? { role: "custom" as const, customType: "trellis-task-context", content: currentTaskContext, display: false, timestamp: Date.now() }
            : null;
         let replaced = false;
         projectedMessages = messages.flatMap((message) => {
            if (message.customType !== "trellis-task-context") return [message];
            if (replaced || !replacement) return [];
            replaced = true;
            return [replacement];
         });
         if (replacement && !replaced) projectedMessages.push(replacement);
      }

      // Fast path: no task change and no compaction — all persisted context is current.
      if (!taskContextChanged && lastInjectionTs > lastCompactionTs) return;

      const cached = turnCache.get(projectRoot, contextKey);
      if (!cached.workflowMsg) return taskContextChanged ? { messages: projectedMessages } : undefined;

      // Post-compaction: reverse-scan to confirm absence before injecting
      for (let i = projectedMessages.length - 1; i >= 0; i--) {
         if (projectedMessages[i].role === "custom" && projectedMessages[i].customType === "trellis-workflow-state") {
            lastInjectionTs = Date.now();
            return taskContextChanged ? { messages: projectedMessages } : undefined;
         }
      }

      lastInjectionTs = Date.now();
      return {
         messages: [
            ...projectedMessages,
            {
               role: "custom" as const,
               customType: "trellis-workflow-state",
               content: cached.workflowMsg,
               display: false,
               timestamp: Date.now(),
            },
         ],
      };
   });

   // OMP passes Bash event.input through to the tool execution parameters, so
   // inject the session key through the shell-agnostic env field. An explicit
   // per-call value wins over the derived key.
   pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== "bash") return;
      const contextKey = rememberContextKey(ctx);
      if (!contextKey) return;
      const input = event.input as { env?: Record<string, string> };
      input.env = {
         TRELLIS_CONTEXT_ID: contextKey,
         ...input.env,
      };
   });

   pi.on("input", async (_event, ctx) => {
      if (!projectRoot) {
         projectRoot = findProjectRoot(ctx.cwd);
      }
      // Resolve projectRoot on first input if session_start missed it
      if (!projectRoot) return;
      const contextKey = rememberContextKey(ctx);
      // Pre-warm the cache so before_agent_start and context can use it
      turnCache.get(projectRoot, contextKey);
   });
}
