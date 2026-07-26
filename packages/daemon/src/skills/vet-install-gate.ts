// SPDX-License-Identifier: Apache-2.0
// @allow-throw: invoked from RPC handler bodies whose @allow-throw header
// already covers throw → JSON-RPC error conversion via rpc-dispatch.ts.
/**
 * Pre-write install vetting: the daemon half of the gate.
 *
 * `vetSkillBundle` (in `@comis/skills`) is pure. This module is the thin,
 * impure edge around it: derive the trust tier from the call, run the gate,
 * throw a structured rejection when it blocks, and emit the audit + log lines.
 *
 * Called from all four skill-install RPC handlers (`skills.create`,
 * `skills.update`, `skills.upload`, `skills.import`) BETWEEN scope resolution
 * and the first `writeRegularFile`. That placement is the invariant: a blocked
 * bundle leaves ZERO files on disk, mirroring `applyBundleInstall`'s
 * Phase-A-reject-⇒-zero-side-effects.
 *
 * Two properties are deliberate and load-bearing:
 *
 *   - **Not operator-disableable.** `skills.contentScanning.enabled` may relax
 *     LOAD-time scanning (a shipped operator choice), but it must never open the
 *     INSTALL door. A deployment cannot configure its way into unvetted writes.
 *     Only the *bounds* are configurable (`skills.installVetting.*`).
 *   - **Content-free audit.** The audit record carries rule ids, categories,
 *     severities, counts, member paths, and the content hash — never skill text.
 *
 * Extracted from `skill-handlers.ts` (781 lines against the 800-line cap) for
 * the same reason `bundle-install-helper.ts` was: one line per call site there,
 * the wiring here.
 *
 * @module
 */

import {
  deriveSkillTrustTier,
  emitSkillAudit,
  vetSkillBundle,
  type SkillBundleFile,
  type SkillBundleFinding,
  type SkillInstallSource,
  type VetSkillBundleResult,
} from "@comis/skills";
import { systemNowMs } from "@comis/core";
import type { WorkspaceApiDeps } from "../api/types.js";

/** Maximum findings named in a rejection message; the rest are counted. */
const MAX_REPORTED_FINDINGS = 8;

/** Arguments for {@link runInstallVettingGate}. */
export interface RunInstallVettingGateArgs {
  /** Handler deps slice (logger + eventBus + container config). */
  readonly deps: WorkspaceApiDeps;
  /** Which install path is running — drives the trust tier. */
  readonly source: SkillInstallSource;
  /** Skill name, for the error message and audit record. */
  readonly skillName: string;
  /** The bundle. `SKILL.md` must be present at the root. */
  readonly files: readonly SkillBundleFile[];
  /** Identity performing the install. */
  readonly callingAgentId: string;
  /** Optional `_context` bag from rawParams (userId for the audit record). */
  readonly ctx?: { userId?: string; traceId?: string } | undefined;
  /**
   * When set, a block also emits `skill:failed` with this `phase` before
   * throwing. `skills.create` / `skills.update` pass `"scan"` to preserve the
   * event their former inline scan emitted; `upload` / `import` never emitted
   * one, so they omit it rather than gain a new event as a side effect.
   */
  readonly failurePhase?: "scan" | "create" | "update" | "load";
}

/** Bounds block under `agents.<id>.skills.installVetting`, when present. */
interface InstallVettingConfig {
  readonly maxEntries?: number;
  readonly maxEntryBytes?: number;
  readonly maxBundleBytes?: number;
  readonly maxPathDepth?: number;
}

/**
 * Read the install-vetting bounds for the calling agent.
 *
 * `skills` config is **per-agent** (`agents.<id>.skills`, via
 * `SkillsConfigSchema` in `schema-agent-runtime.ts`) — there is no top-level
 * `skills` block, so reading `config.skills` would silently always yield
 * `undefined` and pin the gate to its defaults regardless of operator intent.
 * Falls back to the default agent's block the way `setup-tools.ts` does for
 * `skills.toolPolicy` / `skills.terminal`, then to the schema defaults.
 */
function readVettingLimits(
  deps: WorkspaceApiDeps,
  callingAgentId: string,
): InstallVettingConfig | undefined {
  const agents = deps.agents as
    | Record<string, { skills?: { installVetting?: InstallVettingConfig } } | undefined>
    | undefined;
  if (!agents) return undefined;
  const own = agents[callingAgentId]?.skills?.installVetting;
  if (own !== undefined) return own;
  const fallbackId = deps.defaultAgentId;
  return fallbackId !== undefined ? agents[fallbackId]?.skills?.installVetting : undefined;
}

/**
 * Format the blocked-bundle message. Names each CRITICAL finding's member,
 * line, rule, and category so the operator can act without reading logs — and
 * carries no matched text, so the message is safe to surface anywhere.
 */
export function formatVetRejection(skillName: string, findings: readonly SkillBundleFinding[]): string {
  const critical = findings.filter((f) => f.severity === "CRITICAL");
  const shown = critical.slice(0, MAX_REPORTED_FINDINGS);
  const lines = shown.map((f) => {
    const where = f.file === "" ? "(bundle)" : f.lineNumber !== undefined ? `${f.file}:${f.lineNumber}` : f.file;
    return `  ${where} ${f.ruleId} (${f.category}) — ${f.description}`;
  });
  const omitted = critical.length - shown.length;
  if (omitted > 0) lines.push(`  …and ${omitted} more CRITICAL finding${omitted === 1 ? "" : "s"}`);
  const plural = critical.length === 1 ? "" : "s";
  return `skill "${skillName}" blocked by ${critical.length} CRITICAL finding${plural}:\n${lines.join("\n")}`;
}

/**
 * Vet a bundle and throw when it must not be written.
 *
 * @returns The gate result on allow/confirm, so the caller can surface
 *   `verdict` / `warnings` / `contentHash` on its RPC response.
 * @throws `Error[skill_vet_rejected:<verdict>]` when the decision is `block`.
 *   The caller's outer try/catch (rpc-dispatch.ts) converts it to an RPC error.
 */
export function runInstallVettingGate(args: RunInstallVettingGateArgs): VetSkillBundleResult {
  const { deps, source, skillName, files, callingAgentId, ctx } = args;

  const trust = deriveSkillTrustTier({
    source,
    callingAgentId,
    defaultAgentId: deps.defaultAgentId,
  });

  const limits = readVettingLimits(deps, callingAgentId);
  const started = systemNowMs();
  const result = vetSkillBundle({
    files,
    trust,
    ...(limits !== undefined && { limits }),
  });
  const durationMs = systemNowMs() - started;

  const criticalCount = result.findings.filter((f) => f.severity === "CRITICAL").length;
  const warnCount = result.findings.length - criticalCount;
  const ruleIds = [...new Set(result.findings.map((f) => f.ruleId))];

  // Content-free audit metadata: ids, categories, severities, counts, paths.
  const auditMetadata = {
    source,
    trust,
    verdict: result.verdict,
    decision: result.decision,
    fileCount: files.length,
    contentHash: result.contentHash,
    findingCounts: { critical: criticalCount, warn: warnCount },
    ruleIds,
    findings: result.findings.map((f) => ({
      file: f.file,
      ruleId: f.ruleId,
      category: f.category,
      severity: f.severity,
      ...(f.lineNumber !== undefined && { lineNumber: f.lineNumber }),
    })),
    droppedKeys: result.warnings.map((w) => ({ key: w.key, action: w.action })),
  };

  if (deps.eventBus) {
    emitSkillAudit(deps.eventBus, {
      agentId: callingAgentId,
      tenantId: deps.tenantId,
      userId: ctx?.userId ?? "system",
      skillName,
      action: result.decision === "block" ? "skill.vet.reject" : "skill.vet",
      outcome: result.decision === "block" ? "denied" : "success",
      metadata: auditMetadata,
      duration: durationMs,
    });
  }

  if (result.decision === "block") {
    const detail = formatVetRejection(skillName, result.findings);
    if (args.failurePhase !== undefined) {
      deps.eventBus?.emit("skill:failed", {
        skillName,
        error: `Install vetting blocked: ${result.verdict} (${criticalCount} CRITICAL)`,
        phase: args.failurePhase,
        agentId: callingAgentId,
        timestamp: systemNowMs(),
      });
    }
    deps.logger.warn(
      {
        method: "skills.vet",
        skillName,
        agentId: callingAgentId,
        source,
        trust,
        verdict: result.verdict,
        fileCount: files.length,
        findingCounts: { critical: criticalCount, warn: warnCount },
        ruleIds,
        durationMs,
        hint:
          "Skill install refused before any file was written. Remove the flagged patterns from the named members, " +
          "or adjust the bounds under skills.installVetting when a cap fired. Load-time scanning config " +
          "(skills.contentScanning) does NOT relax the install gate.",
        errorKind: "validation" as const,
      },
      "Skill install blocked by pre-write vetting gate",
    );
    throw new Error(`[skill_vet_rejected:${result.verdict}] ${detail}`);
  }

  deps.logger.info(
    {
      method: "skills.vet",
      skillName,
      agentId: callingAgentId,
      source,
      trust,
      verdict: result.verdict,
      decision: result.decision,
      fileCount: files.length,
      findingCounts: { critical: criticalCount, warn: warnCount },
      contentHash: result.contentHash,
      droppedKeyCount: result.warnings.length,
      durationMs,
    },
    "Skill install vetted",
  );

  if (result.warnings.length > 0) {
    deps.logger.warn(
      {
        method: "skills.vet",
        skillName,
        agentId: callingAgentId,
        droppedKeys: result.warnings.map((w) => `${w.key}:${w.action}`),
        hint:
          "Frontmatter keys were remapped or dropped. A dropped_executable key means the skill's runnable half " +
          "was discarded — Comis skills are prompt-only — so the imported skill may be degraded.",
        errorKind: "validation" as const,
      },
      "Skill frontmatter keys remapped or dropped",
    );
  }

  return result;
}
