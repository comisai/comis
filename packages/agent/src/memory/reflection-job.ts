// SPDX-License-Identifier: Apache-2.0
/**
 * RED stub — replaced by the GREEN implementation in the same plan.
 */
import { ok, type Result } from "@comis/shared";
import type { LearningScope, MentalModelStorePort, OutcomeSignalPort } from "@comis/core";
import type { ReflectionAdapter } from "./llm-reflection-adapter.js";

export interface ReflectionSourceTrajectory {
  trajectoryId: string;
  sessionId: string;
  sender: string;
  text: string;
  signature: string;
  trustedOrigin: boolean;
}

export interface RunReflectionConfig {
  enabled: boolean;
  minConfidence: number;
  maxDocsPerRun: number;
}

export interface RunReflectionJobLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface RunReflectionDeps {
  agentId: string;
  tenantId: string;
  scope: LearningScope;
  config: RunReflectionConfig;
  sourceTrajectories: ReflectionSourceTrajectory[];
  reflectionAdapter: Pick<ReflectionAdapter, "reflect">;
  outcomeSignal: Pick<OutcomeSignalPort, "resolve">;
  mentalModelStore: Pick<MentalModelStorePort, "get" | "admit">;
  clock: { now: () => number };
  eventBus: { emit(event: string, payload: unknown): void };
  logger: RunReflectionJobLogger;
}

export type ReflectAdmissionOutcome =
  | "admitted"
  | "uncorroborated"
  | "rejected_validation"
  | "empty_reflection"
  | "no_successes";

export interface RunReflectionResult {
  admissionOutcome: ReflectAdmissionOutcome;
  selected: number;
  admitted: number;
  maxTopicCardinality: number;
  skipped: number;
}

export function classifyReflectOutcome(_f: {
  selected: number;
  maxTopicCardinality: number;
  admitted: number;
  emptyReflections: number;
}): ReflectAdmissionOutcome {
  return "no_successes";
}

export async function runReflection(_deps: RunReflectionDeps): Promise<Result<RunReflectionResult, Error>> {
  return ok({
    admissionOutcome: "no_successes",
    selected: 0,
    admitted: 0,
    maxTopicCardinality: 0,
    skipped: 0,
  });
}
