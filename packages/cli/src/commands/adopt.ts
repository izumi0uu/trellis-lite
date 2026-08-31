import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import chalk from "chalk";
import inquirer from "inquirer";

import { TRELLIS_0616_OVERLAY_HASHES } from "../adoption/trellis-0616-overlay-hashes.js";
import { DIR_NAMES } from "../constants/paths.js";
import { VERSION } from "../constants/version.js";
import { getConfiguredPlatforms } from "../configurators/index.js";
import type { AITool } from "../types/ai-tools.js";
import { computeHash, loadHashes, saveHashes } from "../utils/template-hash.js";
import { toPosix } from "../utils/posix.js";
import { update } from "./update.js";

const SUPPORTED_ADOPT_SOURCE = "0.6.16";

const SNAPSHOT_ROOTS = [
  ".trellis",
  ".codex",
  ".omp",
  ".agents",
  "AGENTS.md",
  ".gitattributes",
] as const;

const PROTECTED_PATHS = [
  ".trellis/tasks",
  ".trellis/spec",
  ".trellis/workspace",
  ".trellis/.runtime",
  ".trellis/backlog",
  ".trellis/agent-traces",
  ".trellis/.developer",
  ".trellis/.current-task",
] as const;

const LEGACY_FRAMEWORK_PATHS = [
  ".agents/skills/trellis-meta",
  ".omp/skills/trellis-meta",
  ".trellis/scripts/common/cli_adapter.py",
] as const;

const MANIFEST_USER_DATA_PREFIXES = [
  ...PROTECTED_PATHS,
  ".trellis/.overlays",
  ".trellis/.backup-",
  ".trellis/.cache",
  ".trellis/worktrees",
] as const;

export interface AdoptOptions {
  codex?: boolean;
  omp?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  backupDir?: string;
}

interface PathFingerprint {
  kind: "file" | "symlink";
  mode: number;
  size: number;
  sha256: string;
}

type FingerprintMap = Record<string, PathFingerprint>;

interface LegacyAudit {
  files: string[];
  roots: string[];
}

function readInstalledVersion(cwd: string): string {
  const versionFile = path.join(cwd, DIR_NAMES.WORKFLOW, ".version");
  if (!fs.existsSync(versionFile)) {
    throw new Error(
      "No .trellis/.version file found. Adoption requires a recognized Trellis installation.",
    );
  }
  return fs.readFileSync(versionFile, "utf-8").trim();
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function defaultBackupDir(cwd: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const project = path.basename(cwd).replace(/[^A-Za-z0-9._-]+/g, "-");
  return path.join(
    path.dirname(cwd),
    ".trellis-lite-backups",
    `${project}-${stamp}`,
  );
}

function resolveBackupDir(cwd: string, requested?: string): string {
  const resolved = requested
    ? path.resolve(cwd, requested)
    : defaultBackupDir(cwd);
  if (isInside(cwd, resolved)) {
    throw new Error(
      `Backup directory must be outside the project: ${resolved}`,
    );
  }
  if (fs.existsSync(resolved)) {
    throw new Error(`Backup directory already exists: ${resolved}`);
  }
  return resolved;
}

function assertSnapshotRootsAreLocal(cwd: string): void {
  for (const relativePath of SNAPSHOT_ROOTS) {
    const fullPath = path.join(cwd, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    if (fs.lstatSync(fullPath).isSymbolicLink()) {
      throw new Error(
        `Adoption does not follow a symlinked managed root: ${relativePath}`,
      );
    }
  }
}

function hashBytes(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fingerprintPath(
  cwd: string,
  relativePath: string,
  output: FingerprintMap,
): void {
  const fullPath = path.join(cwd, ...relativePath.split("/"));
  if (!fs.existsSync(fullPath)) return;
  const stat = fs.lstatSync(fullPath);

  if (stat.isSymbolicLink()) {
    output[relativePath] = {
      kind: "symlink",
      mode: stat.mode,
      size: stat.size,
      sha256: hashBytes(fs.readlinkSync(fullPath)),
    };
    return;
  }
  if (stat.isFile()) {
    output[relativePath] = {
      kind: "file",
      mode: stat.mode,
      size: stat.size,
      sha256: hashBytes(fs.readFileSync(fullPath)),
    };
    return;
  }
  if (!stat.isDirectory()) return;

  for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
    fingerprintPath(cwd, `${relativePath}/${entry.name}`, output);
  }
}

function fingerprintProtectedData(cwd: string): FingerprintMap {
  const output: FingerprintMap = {};
  for (const relativePath of PROTECTED_PATHS) {
    fingerprintPath(cwd, relativePath, output);
  }
  return Object.fromEntries(
    Object.entries(output).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function fingerprintSnapshotRoots(cwd: string): FingerprintMap {
  const output: FingerprintMap = {};
  for (const relativePath of SNAPSHOT_ROOTS) {
    fingerprintPath(cwd, relativePath, output);
  }
  return Object.fromEntries(
    Object.entries(output).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function fingerprintsEqual(
  left: FingerprintMap,
  right: FingerprintMap,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function copySnapshot(cwd: string, backupDir: string): FingerprintMap {
  const snapshotDir = path.join(backupDir, "snapshot");
  fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });

  for (const relativePath of SNAPSHOT_ROOTS) {
    const source = path.join(cwd, relativePath);
    if (!fs.existsSync(source)) continue;
    const target = path.join(snapshotDir, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.cpSync(source, target, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }

  const expected = fingerprintSnapshotRoots(cwd);
  const actual = fingerprintSnapshotRoots(snapshotDir);
  if (!fingerprintsEqual(expected, actual)) {
    throw new Error(
      "External adoption backup failed fingerprint verification.",
    );
  }
  fs.writeFileSync(
    path.join(backupDir, "snapshot-fingerprints.json"),
    JSON.stringify(actual, null, 2) + "\n",
    { mode: 0o600 },
  );
  return actual;
}

function restoreSnapshot(cwd: string, backupDir: string): void {
  const snapshotDir = path.join(backupDir, "snapshot");
  for (const relativePath of SNAPSHOT_ROOTS) {
    const current = path.join(cwd, relativePath);
    const saved = path.join(snapshotDir, relativePath);
    fs.rmSync(current, { recursive: true, force: true });
    if (!fs.existsSync(saved)) continue;
    fs.mkdirSync(path.dirname(current), { recursive: true });
    fs.cpSync(saved, current, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }
}

function collectFiles(cwd: string, relativePath: string): string[] {
  const fullPath = path.join(cwd, ...relativePath.split("/"));
  if (!fs.existsSync(fullPath)) return [];
  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Legacy framework path is a symlink: ${relativePath}`);
  }
  if (stat.isFile()) return [relativePath];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(fullPath, { withFileTypes: true })) {
    files.push(...collectFiles(cwd, `${relativePath}/${entry.name}`));
  }
  return files;
}

function auditLegacyFramework(cwd: string): LegacyAudit {
  const hashes = loadHashes(cwd);
  const files: string[] = [];
  const roots: string[] = [];
  const conflicts: string[] = [];

  for (const relativePath of LEGACY_FRAMEWORK_PATHS) {
    const fullPath = path.join(cwd, ...relativePath.split("/"));
    if (!fs.existsSync(fullPath)) continue;
    roots.push(relativePath);

    for (const file of collectFiles(cwd, relativePath)) {
      files.push(file);
      const filePath = path.join(cwd, ...file.split("/"));
      const actual = computeHash(fs.readFileSync(filePath, "utf-8"));
      const receiptMatches = hashes[toPosix(file)] === actual;
      const auditedMatches =
        TRELLIS_0616_OVERLAY_HASHES[file]?.includes(actual) === true;
      if (!receiptMatches && !auditedMatches) {
        conflicts.push(file);
      }
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      "Legacy framework cleanup stopped because these files are not recognized as pristine or audited overlay output:\n" +
        conflicts
          .sort()
          .map((item) => `  - ${item}`)
          .join("\n"),
    );
  }
  return { files: files.sort(), roots: roots.sort() };
}

function moveRecoverably(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.cpSync(source, target, {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function archiveLegacyFramework(
  cwd: string,
  backupDir: string,
  audit: LegacyAudit,
): string[] {
  const archived: string[] = [];
  const archiveRoot = path.join(backupDir, "removed-old-framework");
  for (const relativePath of audit.roots) {
    const source = path.join(cwd, ...relativePath.split("/"));
    if (!fs.existsSync(source)) continue;
    moveRecoverably(source, path.join(archiveRoot, relativePath));
    archived.push(relativePath);
  }

  const overlays = path.join(cwd, ".trellis", ".overlays");
  if (fs.existsSync(overlays)) {
    moveRecoverably(overlays, path.join(archiveRoot, ".trellis", ".overlays"));
    archived.push(".trellis/.overlays");
  }
  return archived;
}

function isManifestUserData(key: string): boolean {
  return MANIFEST_USER_DATA_PREFIXES.some((prefix) =>
    prefix.endsWith("-")
      ? key.startsWith(prefix)
      : key === prefix || key.startsWith(prefix + "/"),
  );
}

function sanitizeManifest(
  cwd: string,
  archivedFiles: readonly string[],
): number {
  const hashes = loadHashes(cwd);
  const archived = new Set(archivedFiles.map(toPosix));
  const kept: Record<string, string> = {};
  let removed = 0;
  for (const [key, value] of Object.entries(hashes)) {
    if (archived.has(key) || isManifestUserData(key)) {
      removed += 1;
    } else {
      kept[key] = value;
    }
  }
  saveHashes(cwd, kept);
  return removed;
}

function selectedPlatforms(cwd: string, options: AdoptOptions): AITool[] {
  const selected = new Set<AITool>();
  if (options.codex) selected.add("codex");
  if (options.omp) selected.add("omp");
  if (selected.size === 0) {
    for (const platform of getConfiguredPlatforms(cwd)) {
      selected.add(platform);
    }
  }
  if (selected.size === 0) {
    throw new Error(
      "No supported platform could be detected. Select --codex, --omp, or both.",
    );
  }
  return [...selected].sort();
}

function writeAdoptReport(
  backupDir: string,
  report: Record<string, unknown>,
): void {
  fs.writeFileSync(
    path.join(backupDir, "adopt-report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
}

export async function adopt(options: AdoptOptions): Promise<void> {
  const cwd = process.cwd();
  const workflowRoot = path.join(cwd, DIR_NAMES.WORKFLOW);
  if (!fs.existsSync(workflowRoot)) {
    throw new Error(
      "No existing Trellis project found. Use `trellis-lite init` for a new installation.",
    );
  }

  const sourceVersion = readInstalledVersion(cwd);
  if (sourceVersion.startsWith("1.")) {
    throw new Error(
      `This project is already on the Trellis Lite release line (${sourceVersion}). Use \`trellis-lite update\` instead of \`trellis-lite adopt\`. No files were changed.`,
    );
  }
  if (sourceVersion !== SUPPORTED_ADOPT_SOURCE) {
    throw new Error(
      `Cannot adopt Trellis ${sourceVersion}. Trellis Lite ${VERSION} adopts only the final stable Trellis baseline, ${SUPPORTED_ADOPT_SOURCE}. Upgrade this project to ${SUPPORTED_ADOPT_SOURCE} first, then run \`trellis-lite adopt\`. No files were changed.`,
    );
  }
  assertSnapshotRootsAreLocal(cwd);

  const platforms = selectedPlatforms(cwd, options);
  const legacy = auditLegacyFramework(cwd);
  const protectedBefore = fingerprintProtectedData(cwd);

  console.log(chalk.cyan("\nTrellis Lite Adopt"));
  console.log(chalk.cyan("══════════════════"));
  console.log(`Source version: ${sourceVersion}`);
  console.log(`Target version: ${VERSION}`);
  console.log(`Platforms:      ${platforms.join(", ")}`);
  console.log(`Protected files: ${Object.keys(protectedBefore).length}`);
  console.log(`Legacy files to archive: ${legacy.files.length}`);

  // Completely read-only update analysis. Unknown template edits, deleted
  // required files, migration conflicts, and modified deprecated files throw.
  await update({
    dryRun: true,
    migrate: true,
    failOnConflict: true,
    acceptedManagedHashes: TRELLIS_0616_OVERLAY_HASHES,
    platforms,
    skipRegistryCheck: true,
    deferManifestWrites: true,
    allowManagedBlockMerge: true,
    adoptionMode: true,
  });

  if (options.dryRun) {
    console.log(
      chalk.gray("[Dry run] Adoption preflight passed; no files changed."),
    );
    return;
  }

  if (!options.yes) {
    const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
      {
        type: "confirm",
        name: "proceed",
        message:
          "Create an external backup and adopt this project into Trellis Lite?",
        default: false,
      },
    ]);
    if (!proceed) {
      console.log(chalk.yellow("Adoption cancelled."));
      return;
    }
  }

  const backupDir = resolveBackupDir(cwd, options.backupDir);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  let mutationStarted = false;

  try {
    const snapshotFingerprints = copySnapshot(cwd, backupDir);
    writeAdoptReport(backupDir, {
      status: "prepared",
      project: cwd,
      sourceVersion,
      targetVersion: VERSION,
      platforms,
      startedAt,
      protectedFiles: Object.keys(protectedBefore).length,
      snapshotFiles: Object.keys(snapshotFingerprints).length,
    });

    mutationStarted = true;
    const archivedRoots = archiveLegacyFramework(cwd, backupDir, legacy);

    await update({
      force: true,
      migrate: true,
      failOnConflict: true,
      acceptedManagedHashes: TRELLIS_0616_OVERLAY_HASHES,
      platforms,
      skipRegistryCheck: true,
      deferManifestWrites: true,
      allowManagedBlockMerge: true,
      adoptionMode: true,
    });

    const removedManifestEntries = sanitizeManifest(cwd, legacy.files);
    const protectedAfter = fingerprintProtectedData(cwd);
    if (!fingerprintsEqual(protectedBefore, protectedAfter)) {
      throw new Error(
        "Protected tasks/spec/workspace/runtime data changed during adoption.",
      );
    }

    const installedVersion = readInstalledVersion(cwd);
    if (installedVersion !== VERSION) {
      throw new Error(
        `Adoption finished with unexpected project version ${installedVersion}.`,
      );
    }

    writeAdoptReport(backupDir, {
      status: "complete",
      project: cwd,
      sourceVersion,
      targetVersion: VERSION,
      platforms,
      startedAt,
      completedAt: new Date().toISOString(),
      protectedFiles: Object.keys(protectedAfter).length,
      protectedByteIdentity: true,
      archivedRoots,
      archivedFiles: legacy.files,
      removedManifestEntries,
    });

    console.log(chalk.green("\n✅ Trellis Lite adoption complete."));
    console.log(`  Version: ${sourceVersion} → ${VERSION}`);
    console.log(
      `  Protected data: ${Object.keys(protectedAfter).length} files unchanged`,
    );
    console.log(`  External backup: ${backupDir}`);
    if (archivedRoots.length > 0) {
      console.log(`  Archived old framework roots: ${archivedRoots.length}`);
    }
  } catch (error) {
    if (mutationStarted) {
      try {
        restoreSnapshot(cwd, backupDir);
        writeAdoptReport(backupDir, {
          status: "rolled-back",
          project: cwd,
          sourceVersion,
          targetVersion: VERSION,
          platforms,
          startedAt,
          failedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      } catch (rollbackError) {
        throw new Error(
          `Adoption failed and rollback also failed. Backup: ${backupDir}. Adoption error: ${error instanceof Error ? error.message : String(error)}. Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        );
      }
    }
    throw error;
  }
}
