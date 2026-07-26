// SPDX-License-Identifier: Apache-2.0
/** Content-free completion telemetry for a successful skill import. */

import {
  systemNowMs,
  type ComisLogger,
  type ErrorKind,
  type TypedEventBus,
} from "@comis/core";
import type { VetSkillBundleResult } from "@comis/skills";
import type {
  SkillImportFailureStage,
  SkillImportPolicyKey,
} from "./resolve-skill-import-source.js";

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

/** Content-free failure facts for one import boundary. */
export interface SkillImportFailure {
  readonly eventBus?: TypedEventBus;
  readonly logger: ComisLogger;
  readonly skillName?: string;
  readonly source: "github" | "archive" | "wellknown" | "registry";
  readonly stage: SkillImportFailureStage;
  readonly code: string;
  readonly policyKey?: SkillImportPolicyKey;
  readonly errorKind: ErrorKind;
  readonly hint: string;
  readonly agentId: string;
  readonly startedMs: number;
}

/** Content-free rejection facts recorded in a skill import trajectory. */
export type SkillImportRejection = Pick<
  SkillImportFailure,
  "eventBus" | "skillName" | "source" | "stage" | "code" | "policyKey"
>;

/** Emit one content-free rejection trajectory event. */
export function recordSkillImportRejection(
  input: SkillImportRejection,
  timestamp = systemNowMs(),
): void {
  const skillName = input.skillName ?? "unresolved";
  input.eventBus?.emit("skill:rejected", {
    skillName,
    reason: "Skill import failed",
    violations: [input.code],
    source: input.source,
    stage: input.stage,
    ...(input.policyKey !== undefined && { policyKey: input.policyKey }),
    timestamp,
  });
}

/** Emit one content-free rejection trajectory event and actionable WARN. */
export function recordSkillImportFailure(input: SkillImportFailure): void {
  const timestamp = systemNowMs();
  const skillName = input.skillName ?? "unresolved";
  recordSkillImportRejection(input, timestamp);
  input.logger.warn(
    {
      method: "skills.import",
      skillName,
      source: input.source,
      step: input.stage,
      failureCode: input.code,
      ...(input.policyKey !== undefined && { policyKey: input.policyKey }),
      durationMs: timestamp - input.startedMs,
      hint: input.hint,
      errorKind: input.errorKind,
    },
    "Skill import failed",
  );
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
