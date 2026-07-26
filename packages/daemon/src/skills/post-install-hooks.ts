// SPDX-License-Identifier: Apache-2.0
// @allow-throw: invoked from RPC handler bodies whose @allow-throw header
// already covers throw → JSON-RPC error conversion via rpc-dispatch.ts.
/**
 * The post-write skill-install lifecycle.
 *
 * One seam for everything that must happen AFTER a skill's files are on disk
 * and the registry has re-discovered them:
 *
 *   1. `runBundleInstallHook` — resolve + persist + connect any bundled MCP
 *      servers (OSV-checked, two-phase atomic). Unchanged; delegated verbatim.
 *   2. `recordSkillProvenance` — durably record where the skill came from, at
 *      what hash, at what trust.
 *
 * Provenance is recorded here rather than in the pre-write vetting gate on
 * purpose: the gate runs BEFORE the first write, so a record written there would
 * claim an install that a subsequent disk error could still have prevented.
 * Recording after the write means the store only ever describes skills that
 * actually exist.
 *
 * Failure asymmetry is deliberate:
 *   - a Phase-A bundle reject THROWS (the shipped atomicity invariant), and
 *   - a provenance write failure is logged and swallowed, because the skill is
 *     already installed and correct. Failing the RPC there would report a
 *     successful install as an error; the worst real consequence is that
 *     provenance reads as unknown until the next install of that skill.
 *
 * @module
 */

import { systemDateFrom, systemNowMs } from "@comis/core";
import type { SkillInstallSource, VetSkillBundleResult } from "@comis/skills";
import type { WorkspaceApiDeps } from "../api/types.js";
import { runBundleInstallHook, type ApplyBundleInstallResult } from "./bundle-install-helper.js";
import {
  forgetSkillProvenance,
  recordSkillProvenance,
  type SkillProvenanceRecord,
  type SkillProvenanceScope,
} from "./skill-provenance-store.js";

/**
 * The provenance inputs a handler supplies alongside the bundle-hook args.
 *
 * Handlers pass FACTS (which scope, which source, which locator, what the gate
 * decided) and this module assembles the record. That keeps each of the four
 * call sites in `skill-handlers.ts` to a single line — the file sits close to
 * the 800-line cap — and keeps the record's shape in one place rather than
 * duplicated four ways.
 */
export interface PostInstallProvenanceArgs {
  /** Which scope the skill was written into. */
  readonly scope: SkillProvenanceScope;
  /** Which install path produced the skill. */
  readonly source: SkillInstallSource;
  /** Public locator, when the source has one. Never a credential-bearing URL. */
  readonly ref?: string;
  /** The pre-write gate's result — supplies hash, trust, verdict, and counts. */
  readonly vetted: VetSkillBundleResult;
  /** Identity that performed the install. */
  readonly callingAgentId: string;
}

/** Assemble the durable record from what the gate already computed. */
function buildRecord(
  args: PostInstallProvenanceArgs,
  userId: string | undefined,
  bundleResult: ApplyBundleInstallResult,
): SkillProvenanceRecord {
  const critical = args.vetted.findings.filter((f) => f.severity === "CRITICAL").length;
  return {
    source: args.source,
    ...(args.ref !== undefined && { ref: args.ref }),
    contentHash: args.vetted.contentHash,
    importedAt: systemDateFrom(systemNowMs()).toISOString(),
    importedBy: { agentId: args.callingAgentId, ...(userId !== undefined && { userId }) },
    trust: args.vetted.trust,
    verdict: args.vetted.verdict,
    findingCounts: { critical, warn: args.vetted.findings.length - critical },
    ...(bundleResult.pendingMcpServers !== undefined && {
      pendingMcpServers: bundleResult.pendingMcpServers,
    }),
  };
}

/**
 * Run the post-write hooks for a freshly-installed skill.
 *
 * @param deps Handler deps slice.
 * @param skillId The installed skill's name.
 * @param skillDir Absolute path to the installed skill directory.
 * @param rawParams The dispatcher-raw params (carries `force` + `_context`).
 * @param provenance Provenance inputs. Every install path must provide them so
 *   trust is available to the bundled-MCP gate and the durable store.
 * @returns The bundle-install result, forwarded unchanged.
 * @throws Whatever `runBundleInstallHook` throws (Phase-A bundle reject).
 */
export async function runPostInstallHooks(
  deps: WorkspaceApiDeps,
  skillId: string,
  skillDir: string,
  rawParams: Record<string, unknown>,
  provenance: PostInstallProvenanceArgs,
): Promise<ApplyBundleInstallResult> {
  // Bundle install first: its Phase-A reject throws, and a rejected install
  // must not leave a provenance record behind.
  const autoConnectBundledMcp =
    deps.agents[provenance.callingAgentId]?.skills?.import?.autoConnectBundledMcp ?? false;
  const bundleResult = await runBundleInstallHook(
    deps,
    skillId,
    skillDir,
    rawParams,
    provenance.vetted.trust,
    autoConnectBundledMcp,
  );

  const dataDir = (deps.container?.config?.dataDir as string | undefined) ?? "";
  if (dataDir.length > 0) {
    const userId = (rawParams as { _context?: { userId?: string } })._context?.userId;
    const record = buildRecord(provenance, userId, bundleResult);
    const written = recordSkillProvenance(dataDir, provenance.scope, skillId, record);
    if (!written.ok) {
      deps.logger.warn(
        {
          method: "skills.provenance.record",
          skillName: skillId,
          scope: provenance.scope,
          err: written.error.message,
          hint:
            "Provenance write failed; the skill IS installed. Its origin and content hash will read as " +
            "unknown until the next install of this skill, which weakens tamper detection on re-import.",
          errorKind: "resource" as const,
        },
        "Skill provenance record write failed",
      );
    }
  }

  return bundleResult;
}

/** Project the operator-visible pending fields onto an install RPC response. */
export function bundleInstallResponseFields(result: ApplyBundleInstallResult): {
  pendingMcpServers?: ApplyBundleInstallResult["pendingMcpServers"];
  hint?: string;
} {
  return {
    ...(result.pendingMcpServers !== undefined && {
      pendingMcpServers: result.pendingMcpServers,
    }),
    ...(result.hint !== undefined && { hint: result.hint }),
  };
}

/**
 * Drop a deleted skill's provenance record.
 *
 * Not merely tidiness: a stale record outlives the skill it describes, and the
 * next install of that name would be compared against a hash and tier that no
 * longer correspond to anything on disk. For a higher-tier stale record that
 * means a legitimate re-import gets refused as tampering.
 *
 * Best-effort by the same reasoning as the record write — the skill directory is
 * already gone, so a failure here must not turn a successful delete into an RPC
 * error.
 */
export function forgetSkillProvenanceOnDelete(
  deps: WorkspaceApiDeps,
  scope: SkillProvenanceScope,
  skillId: string,
): void {
  const dataDir = (deps.container?.config?.dataDir as string | undefined) ?? "";
  if (dataDir.length === 0) return;
  const dropped = forgetSkillProvenance(dataDir, scope, skillId);
  if (!dropped.ok) {
    deps.logger.warn(
      {
        method: "skills.provenance.forget",
        skillName: skillId,
        scope,
        err: dropped.error.message,
        hint:
          "Stale provenance record left behind for a deleted skill. A later re-import of this name may be " +
          "refused as a hash mismatch against the removed skill; delete the entry from installed-skills.json to clear it.",
        errorKind: "resource" as const,
      },
      "Skill provenance record removal failed",
    );
  }
}
