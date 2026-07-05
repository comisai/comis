// SPDX-License-Identifier: Apache-2.0
/**
 * The staged skill-import pipeline — the fail-closed pre-write gate every
 * install source flows through.
 *
 * `stageImport` runs, ENTIRELY IN MEMORY:
 *   acquire -> unpack (in-memory) -> text-only filter -> foreign-frontmatter map
 *   -> manifest validate + body-length pre-check -> UNCONDITIONAL scan-all
 *   -> injected bundle-check seam
 * and ONLY when every gate passes does it create `staged/` and write the kept
 * text files. A dropped executable therefore never touches disk, and any reject
 * at any earlier stage leaves ZERO staged output (a partial write is unwound).
 *
 * The scan is a SEPARATE, UNCONDITIONAL call site: it never consults the
 * load-time content-scanning enable / block-on-critical configuration. It
 * sanitizes + scans the SKILL.md body AND every kept reference/template file;
 * any CRITICAL finding rejects atomically.
 *
 * The bundle check is an INJECTED seam so this layer never imports the
 * daemon-side resolver (which would create a package-reference cycle). The
 * daemon wires the real resolver as the seam at commit time; unit tests + the
 * source resolvers pass a stub (or omit it to skip the Phase-A step).
 *
 * The installed SKILL.md is written in its MAPPED spec-pure form (the original
 * body preserved) so the file that lands is the one load-time discovery can
 * parse; the returned `contentHash` is over exactly the bytes written to
 * `staged/`, so it re-verifies against disk.
 *
 * @module
 */
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import { safePath, type ErrorKind, type TypedEventBus } from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";
import { parseFrontmatter, parseSkillManifest } from "../manifest/parser.js";
import type { SkillManifestParsed } from "../manifest/schema.js";
import { sanitizeSkillBody } from "../prompt/sanitizer.js";
import { scanSkillContent, type ContentScanFinding } from "../prompt/content-scanner.js";
import { emitSkillAudit } from "../audit/skill-audit.js";
import { unpackArchive, type UnpackCaps } from "./archive-unpack.js";
import { applyTextFilter, type KeptTextFile } from "./text-filter.js";
import { mapForeignFrontmatter } from "./frontmatter-map.js";
import { computeInstalledSetHash } from "./provenance-store.js";
import { acquire, type AcquireDeps, type AcquireInput } from "./acquire.js";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** Skill scope (mirrors the RPC scope enum). */
export type SkillScope = "local" | "shared";

/**
 * The stages the pipeline (and the downstream serialized commit) can reject at,
 * for the typed reject + obs. `collision` and `commit` are the commit-side
 * stages: a name-collision routing refusal and a mid-commit (move / provenance /
 * install) failure respectively.
 */
export type ImportStage =
  | "acquire"
  | "unpack"
  | "text-filter"
  | "map"
  | "body-length"
  | "scan"
  | "bundle-check"
  | "write"
  | "collision"
  | "commit";

/** A rejecting bundle-check outcome from the injected seam. */
export interface BundleCheckReject {
  /** The reject class (e.g. name_collision | plaintext_secret | osv_malware | schema_invalid). */
  readonly kind: string;
  readonly message: string;
}

/** Context handed to the injected bundle-check seam. */
export interface BundleCheckContext {
  readonly skillName: string;
  readonly scope: SkillScope;
  readonly agentId: string;
}

/**
 * The injected Phase-A bundle-check seam. Runs at stage time against the mapped
 * manifest; a reject yields an atomic import reject with zero staged output. The
 * daemon wires the real resolver here (kept out of this layer to avoid a
 * skills -> daemon package-reference cycle).
 */
export type BundleCheckSeam = (
  manifest: SkillManifestParsed,
  ctx: BundleCheckContext,
) => Promise<Result<void, BundleCheckReject>>;

/** Object-first structural logger (a Pino child in production, a spy in tests). */
export interface ImportLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Actor context for the content-free audit tuple. */
export interface StageAuditContext {
  readonly agentId: string;
  readonly tenantId: string;
  readonly userId: string;
}

/** The pipeline input: one source + the target scope/agent. */
export interface StageImportInput {
  readonly source: AcquireInput;
  readonly scope: SkillScope;
  readonly agentId: string;
}

/** Content-free scan verdict recorded on the staged result + the provenance pin. */
export interface ScanVerdict {
  readonly clean: boolean;
  readonly findingCount: number;
}

/** One installed file: relative path + the exact bytes written to staged/. */
export interface KeptFileBytes {
  readonly relPath: string;
  readonly bytes: Buffer;
}

/** A fully-staged skill, ready for the serialized commit. */
export interface StagedImport {
  /** The `staged/` directory whose contents the commit moves live. */
  readonly stagingDir: string;
  /** The `skill-import-<id>/` parent the commit cleans up. */
  readonly importRoot: string;
  /** The validated skill name (from the mapped manifest). */
  readonly skillName: string;
  /** The archive's single top-level directory, or `""` (root / file set). */
  readonly skillRootRel: string;
  /** The validated, mapped manifest. */
  readonly manifest: SkillManifestParsed;
  /** The exact set written to staged/ (contentHash is over these bytes). */
  readonly keptFiles: readonly KeptFileBytes[];
  /** sha256 over the canonicalized installed set (== hash over staged/ on disk). */
  readonly contentHash: string;
  /** The unconditional scan verdict. */
  readonly scanVerdict: ScanVerdict;
  /** Non-fatal advisories (dropped entries + mapper drops), each naming its subject. */
  readonly warnings: readonly string[];
}

/** A typed pipeline reject; every branch carries an operator hint + errorKind. */
export interface ImportReject {
  readonly stage: ImportStage;
  readonly message: string;
  readonly hint: string;
  readonly errorKind: ErrorKind;
  /** Scan-stage: total finding count. */
  readonly findingCount?: number;
  /** Scan-stage: the CRITICAL rule ids. */
  readonly ruleIds?: readonly string[];
  /** Bundle-check stage: the seam's reject class. */
  readonly bundleKind?: string;
  /**
   * Commit stage: a provenance-matched re-import diverged from the pinned hash
   * and requires an explicit `confirm` to swap + re-pin. Distinct from a flat
   * refuse (unprovenanced / foreign source-identifier), which is NEVER
   * confirm-able and leaves this unset.
   */
  readonly needsConfirm?: boolean;
}

/** Dependencies for {@link stageImport}. */
export interface StageImportDeps {
  /** Bounded-unpack caps (from `config.skills.import`). */
  readonly caps: UnpackCaps;
  /** Body-length ceiling (from `config.promptSkills.maxBodyLength`). */
  readonly maxBodyLength: number;
  /** The private staging root (e.g. `<dataDir>/tmp`). */
  readonly tmpRoot: string;
  /** Object-first logger. */
  readonly logger: ImportLogger;
  /** Optional bus for the audit tuple + failure event. */
  readonly eventBus?: TypedEventBus;
  /** Optional actor context for the audit tuple. */
  readonly audit?: StageAuditContext;
  /** Optional Phase-A seam; absent => the Phase-A step is skipped. */
  readonly bundleCheck?: BundleCheckSeam;
  /** Optional acquire seams (for off-network tests). */
  readonly acquire?: Partial<Pick<AcquireDeps, "validate" | "fetchImpl">>;
  /** Optional deterministic staging id (tests); a UUID otherwise. */
  readonly stagingId?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** One normalized entry the text-filter consumes. */
interface RootRelativeEntry {
  readonly relPath: string;
  readonly execBit: boolean;
  readonly bytes: Buffer;
}

// A synthetic, non-existent base used purely to validate file-set path
// containment (`..`, null bytes, encoded traversal); never used for I/O.
const NOTIONAL_BASE = "/skill-import-notional-root";

/** Validate + normalize a pass-through file set into root-relative entries. */
function buildFileSetEntries(
  files: readonly { path: string; content: string }[],
): Result<RootRelativeEntry[], { message: string; hint: string; errorKind: ErrorKind }> {
  const entries: RootRelativeEntry[] = [];
  for (const file of files) {
    const segs = file.path.split("/").filter((s) => s.length > 0 && s !== ".");
    const unsafe =
      file.path.startsWith("/") ||
      /^[A-Za-z]:/.test(file.path) ||
      file.path.includes("\\") ||
      segs.length === 0 ||
      segs.some((s) => s === "..");
    if (unsafe) {
      return err({
        message: `file set entry "${file.path}" is not a safe skill-root-relative path`,
        hint: "file set paths must be relative to the skill root with no absolute, backslash, or parent-directory segments",
        errorKind: "validation",
      });
    }
    try {
      safePath(NOTIONAL_BASE, ...segs);
    } catch {
      return err({
        message: `file set entry "${file.path}" failed path-containment validation`,
        hint: "remove traversal, null-byte, or encoded segments from file set paths",
        errorKind: "validation",
      });
    }
    entries.push({ relPath: segs.join("/"), execBit: false, bytes: Buffer.from(file.content, "utf-8") });
  }
  return ok(entries);
}

/** The result of writing the kept set to a fresh staging tree. */
interface WrittenStaging {
  readonly stagingDir: string;
  readonly importRoot: string;
}

/**
 * Create `<tmpRoot>/skill-import-<id>/staged/` and write ONLY the kept text
 * files into it. On any failure the partial tree is removed so a reject leaves
 * zero staged output.
 */
function writeStaged(
  tmpRoot: string,
  stagingId: string,
  kept: readonly KeptTextFile[],
  logger: ImportLogger,
): Result<WrittenStaging, { message: string; hint: string; errorKind: ErrorKind }> {
  let importRoot: string;
  let stagingDir: string;
  try {
    importRoot = safePath(tmpRoot, `skill-import-${stagingId}`);
    stagingDir = safePath(importRoot, "staged");
  } catch {
    return err({
      message: "the staging path could not be constructed safely",
      hint: "ensure the import tmp root is an absolute, contained path",
      errorKind: "internal",
    });
  }

  const rootDir = ensureContainedDir({ dir: importRoot, mode: 0o700 });
  if (!rootDir.ok) {
    return err({
      message: `failed to create the staging root: ${rootDir.error.message}`,
      hint: "ensure the import tmp root exists and is writable (0o700)",
      errorKind: "resource",
    });
  }
  const stagedDir = ensureContainedDir({ dir: stagingDir, mode: 0o700 });
  if (!stagedDir.ok) {
    rmSync(importRoot, { recursive: true, force: true });
    return err({
      message: `failed to create the staged directory: ${stagedDir.error.message}`,
      hint: "ensure the import tmp root is writable (0o700)",
      errorKind: "resource",
    });
  }

  for (const file of kept) {
    const segs = file.relPath.split("/").filter((s) => s.length > 0);
    let filePath: string;
    let parentDir: string;
    try {
      filePath = safePath(stagingDir, ...segs);
      parentDir = segs.length > 1 ? safePath(stagingDir, ...segs.slice(0, -1)) : stagingDir;
    } catch {
      rmSync(importRoot, { recursive: true, force: true });
      return err({
        message: `kept file "${file.relPath}" resolved outside the staging directory`,
        hint: "the kept set must contain only contained, skill-root-relative paths",
        errorKind: "validation",
      });
    }
    if (parentDir !== stagingDir) {
      const dirRes = ensureContainedDir({ dir: parentDir, mode: 0o700, confinedBaseDir: stagingDir });
      if (!dirRes.ok) {
        rmSync(importRoot, { recursive: true, force: true });
        return err({
          message: `failed to create a staged sub-directory: ${dirRes.error.message}`,
          hint: "ensure the staging directory is writable and not a symlink",
          errorKind: "resource",
        });
      }
    }
    const wr = writeRegularFile({ path: filePath, content: file.content, confinedBaseDir: stagingDir });
    if (!wr.ok) {
      rmSync(importRoot, { recursive: true, force: true });
      return err({
        message: `failed to write staged file "${file.relPath}": ${wr.error.message}`,
        hint: "ensure the staging directory is writable and not a symlink",
        errorKind: "resource",
      });
    }
  }

  logger.debug({ step: "write", fileCount: kept.length }, "import: wrote kept text to staging");
  return ok({ stagingDir, importRoot });
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Run the staged import pipeline for one source. Every gate runs in memory; only
 * a full pass writes the kept text files to `staged/`. Returns a
 * {@link StagedImport} for the serialized commit, or a typed {@link ImportReject}
 * that leaves zero staged output. Never throws.
 */
export async function stageImport(
  input: StageImportInput,
  deps: StageImportDeps,
): Promise<Result<StagedImport, ImportReject>> {
  const startedAt = Date.now();
  const { logger } = deps;

  /** Emit the failure obs (log + audit + skill:failed) and return the reject. */
  const rejectWith = (reject: ImportReject, skillName = "(unresolved)"): Result<never, ImportReject> => {
    logger.warn(
      { step: reject.stage, errorKind: reject.errorKind, hint: reject.hint },
      `import rejected at ${reject.stage}: ${reject.message}`,
    );
    if (deps.eventBus && deps.audit) {
      emitSkillAudit(deps.eventBus, {
        ...deps.audit,
        skillName,
        action: "skill.import",
        outcome: "failure",
        metadata: { stage: reject.stage, errorKind: reject.errorKind },
      });
      deps.eventBus.emit("skill:failed", {
        skillName,
        error: reject.message,
        phase: "import",
        agentId: input.agentId,
        timestamp: Date.now(),
      });
    }
    return err(reject);
  };

  // 1. Acquire the raw bytes / file set.
  logger.debug({ step: "acquire" }, "import: acquiring source");
  const acquired = await acquire(input.source, {
    caps: { maxArchiveBytes: deps.caps.maxArchiveBytes },
    ...deps.acquire,
  });
  if (!acquired.ok) return rejectWith({ stage: "acquire", ...acquired.error });

  // 2. Normalize to root-relative entries (unpack an archive; validate a file set).
  let entries: RootRelativeEntry[];
  let skillRootRel: string;
  if (acquired.value.kind === "archive") {
    logger.debug({ step: "unpack" }, "import: unpacking archive");
    const unpacked = unpackArchive(acquired.value.bytes, { caps: deps.caps });
    if (!unpacked.ok) return rejectWith({ stage: "unpack", ...unpacked.error });
    entries = unpacked.value.files.map((f) => ({ relPath: f.relPath, execBit: f.execBit, bytes: f.bytes }));
    skillRootRel = unpacked.value.skillRootRel;
  } else {
    const built = buildFileSetEntries(acquired.value.files);
    if (!built.ok) return rejectWith({ stage: "unpack", ...built.error });
    entries = built.value;
    skillRootRel = "";
  }

  // 3. Text-only filter (drop executables/binaries/non-UTF-8; WARN each).
  const filtered = applyTextFilter(entries);
  const warnings: string[] = [];
  for (const drop of filtered.drops) {
    warnings.push(`${drop.relPath}: ${drop.reason}`);
    logger.warn(
      { step: "text-filter", relPath: drop.relPath, errorKind: "validation", hint: "import keeps text only; this entry was dropped and will not be staged" },
      `import: dropped ${drop.relPath} (${drop.reason})`,
    );
  }
  logger.debug(
    { step: "text-filter", keptCount: filtered.kept.length, dropCount: filtered.drops.length },
    "import: text-only filter applied",
  );

  // 4. Locate the manifest among the kept text.
  const manifestFile = filtered.kept.find((k) => k.relPath === "SKILL.md");
  if (!manifestFile) {
    return rejectWith({
      stage: "map",
      message: "no SKILL.md remained after the text-only filter",
      hint: "the archive or file set must contain a UTF-8 SKILL.md manifest at the skill root",
      errorKind: "validation",
    });
  }

  // 5. Map foreign frontmatter -> spec-pure, then validate the manifest.
  logger.debug({ step: "map" }, "import: mapping foreign frontmatter");
  const parsedFm = parseFrontmatter(manifestFile.content);
  if (!parsedFm.ok) {
    return rejectWith({
      stage: "map",
      message: `SKILL.md frontmatter could not be parsed: ${parsedFm.error.message}`,
      hint: "author SKILL.md with a valid '---' YAML frontmatter block",
      errorKind: "validation",
    });
  }
  const { frontmatter, body } = parsedFm.value;
  const mapped = mapForeignFrontmatter(frontmatter);
  for (const w of mapped.warnings) {
    warnings.push(`${w.key}: ${w.message}`);
    logger.warn({ step: "map", key: w.key, errorKind: w.errorKind, hint: w.hint }, `import: ${w.message}`);
  }
  const specPureMd = `---\n${stringifyYaml(mapped.specPure)}---\n\n${body}\n`;
  const manifestResult = parseSkillManifest(specPureMd);
  if (!manifestResult.ok) {
    return rejectWith({
      stage: "map",
      message: `mapped manifest failed validation: ${manifestResult.error.message}`,
      hint: "the imported SKILL.md, after mapping, does not satisfy the skill manifest schema",
      errorKind: "validation",
    });
  }
  const manifest = manifestResult.value;
  const skillName = manifest.name;

  // 6. Sanitize the body + pre-validate its length (reject, never silently truncate).
  const sanitized = sanitizeSkillBody(body, deps.maxBodyLength);
  if (sanitized.truncated) {
    return rejectWith(
      {
        stage: "body-length",
        message: `the SKILL.md body exceeds the promptSkills.maxBodyLength limit (${deps.maxBodyLength})`,
        hint: "shorten the SKILL.md body or raise promptSkills.maxBodyLength; an over-length body would be silently truncated at load",
        errorKind: "validation",
      },
      skillName,
    );
  }
  if (!sanitized.body.trim()) {
    return rejectWith(
      {
        stage: "body-length",
        message: "the SKILL.md body is empty after sanitization",
        hint: "author a non-empty SKILL.md instruction body",
        errorKind: "validation",
      },
      skillName,
    );
  }

  // 7. UNCONDITIONAL scan-all: the SKILL.md body AND every kept text file.
  logger.debug({ step: "scan" }, "import: scanning all kept text");
  const findings: ContentScanFinding[] = [...scanSkillContent(sanitized.body).findings];
  for (const kept of filtered.kept) {
    if (kept.relPath === "SKILL.md") continue; // the body was scanned above
    // Sanitize without truncation so a large reference file cannot hide content past the scan.
    const cleaned = sanitizeSkillBody(kept.content, Number.MAX_SAFE_INTEGER).body;
    findings.push(...scanSkillContent(cleaned).findings);
  }
  const hasCritical = findings.some((f) => f.severity === "CRITICAL");
  const scanVerdict: ScanVerdict = { clean: findings.length === 0, findingCount: findings.length };
  if (hasCritical) {
    const ruleIds = findings.filter((f) => f.severity === "CRITICAL").map((f) => f.ruleId);
    logger.error(
      { step: "scan", errorKind: "validation", findingCount: findings.length, hint: "remove the flagged content; the import scan rejects any CRITICAL finding unconditionally" },
      `import: rejected — ${ruleIds.length} CRITICAL content-scan finding(s)`,
    );
    if (deps.eventBus && deps.audit) {
      emitSkillAudit(deps.eventBus, {
        ...deps.audit,
        skillName,
        action: "skill.scan.reject",
        outcome: "denied",
        metadata: {
          findingCount: findings.length,
          hasCritical: true,
          findings: findings.map((f) => ({ ruleId: f.ruleId, category: f.category, severity: f.severity })),
        },
      });
    }
    return err({
      stage: "scan",
      message: "CRITICAL content-scan finding in the SKILL.md body or a reference file",
      hint: "remove the flagged content; the import scan rejects any CRITICAL finding unconditionally",
      errorKind: "validation",
      findingCount: findings.length,
      ruleIds,
    });
  }
  for (const f of findings) {
    logger.warn(
      { step: "scan", ruleId: f.ruleId, category: f.category, severity: f.severity, errorKind: "validation", hint: "review the flagged skill content" },
      `import: non-blocking scan finding ${f.ruleId}`,
    );
  }

  // 8. Injected Phase-A bundle-check seam (against the mapped manifest).
  if (deps.bundleCheck) {
    logger.debug({ step: "bundle-check" }, "import: running the bundle-check seam");
    const checked = await deps.bundleCheck(manifest, { skillName, scope: input.scope, agentId: input.agentId });
    if (!checked.ok) {
      return rejectWith(
        {
          stage: "bundle-check",
          message: `bundled MCP declaration rejected: ${checked.error.message}`,
          hint: "the staged skill's bundled MCP declaration failed the pre-write bundle check",
          errorKind: "validation",
          bundleKind: checked.error.kind,
        },
        skillName,
      );
    }
  }

  // 9. All gates passed — write ONLY the kept text (mapped SKILL.md + references).
  const finalKept: KeptTextFile[] = filtered.kept.map((k) =>
    k.relPath === "SKILL.md" ? { relPath: "SKILL.md", content: specPureMd } : k,
  );
  const written = writeStaged(deps.tmpRoot, deps.stagingId ?? randomUUID(), finalKept, logger);
  if (!written.ok) return rejectWith({ stage: "write", ...written.error }, skillName);

  const keptFiles: KeptFileBytes[] = finalKept.map((k) => ({
    relPath: k.relPath,
    bytes: Buffer.from(k.content, "utf-8"),
  }));
  const contentHash = computeInstalledSetHash(keptFiles);
  const durationMs = Date.now() - startedAt;

  logger.info(
    { step: "complete", durationMs, fileCount: keptFiles.length, contentHash: contentHash.slice(0, 12), skillName },
    "import: staged skill ready for commit",
  );
  if (deps.eventBus && deps.audit) {
    emitSkillAudit(deps.eventBus, {
      ...deps.audit,
      skillName,
      action: "skill.import",
      outcome: "success",
      duration: durationMs,
      metadata: { fileCount: keptFiles.length, contentHash: contentHash.slice(0, 12), warningCount: warnings.length },
    });
  }

  return ok({
    stagingDir: written.value.stagingDir,
    importRoot: written.value.importRoot,
    skillName,
    skillRootRel,
    manifest,
    keptFiles,
    contentHash,
    scanVerdict,
    warnings,
  });
}
