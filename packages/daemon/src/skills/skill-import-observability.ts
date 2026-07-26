// SPDX-License-Identifier: Apache-2.0
/** Content-free completion telemetry for a successful skill import. */

import {
  systemNowMs,
  type ComisLogger,
  type TypedEventBus,
} from "@comis/core";
import type { VetSkillBundleResult } from "@comis/skills";

export interface SkillImportCompletion {
  readonly eventBus?: TypedEventBus;
  readonly logger: ComisLogger;
  readonly skillName: string;
  readonly source: "github" | "archive" | "wellknown" | "registry";
  readonly scope: "local" | "shared";
  readonly vetted: VetSkillBundleResult;
  readonly fileCount: number;
  readonly pendingMcpCount: number;
  readonly agentId: string;
  readonly startedMs: number;
}

/** Emit the trajectory source event and once-per-boundary INFO summary. */
export function recordSkillImportCompletion(input: SkillImportCompletion): void {
  const critical = input.vetted.findings.filter(
    (finding) => finding.severity === "CRITICAL",
  ).length;
  const findingCounts = {
    critical,
    warn: input.vetted.findings.length - critical,
  };
  input.eventBus?.emit("skill:imported", {
    skillName: input.skillName,
    source: input.source,
    scope: input.scope,
    trust: input.vetted.trust,
    verdict: input.vetted.verdict,
    contentHash: input.vetted.contentHash,
    fileCount: input.fileCount,
    findingCounts,
    pendingMcpCount: input.pendingMcpCount,
    agentId: input.agentId,
    timestamp: systemNowMs(),
  });
  input.logger.info(
    {
      method: "skills.import",
      skillName: input.skillName,
      source: input.source,
      trust: input.vetted.trust,
      verdict: input.vetted.verdict,
      fileCount: input.fileCount,
      findingCounts,
      unchanged: false,
      durationMs: systemNowMs() - input.startedMs,
    },
    "Skill import complete",
  );
}
