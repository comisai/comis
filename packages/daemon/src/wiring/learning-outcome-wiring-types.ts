// SPDX-License-Identifier: Apache-2.0
import type {
  ClockPort,
  ComisLogger,
  MemoryUsefulnessStore,
  MentalModelStorePort,
  OutcomeSignalPort,
  TypedEventBus,
} from "@comis/core";
import type { JudgeScope, OutcomeJudge } from "./setup-learning-judge.js";

/** Dependencies for the deterministic learning-outcome subscriber. */
export interface LearningOutcomeWiringDeps {
  tenantId: string;
  eventBus: TypedEventBus;
  outcomeStore: OutcomeSignalPort;
  usefulnessStore: MemoryUsefulnessStore;
  clock: ClockPort;
  logger: ComisLogger;
  learningOutcomeEnabled: (agentId: string) => boolean;
  learningTuningEnabled: (agentId: string) => boolean;
  learningForgettingEnabled: (agentId: string) => boolean;
  learnedSkillStore?: MentalModelStorePort;
  learningSkillsEnabled?: (agentId: string) => boolean;
  learningSkillsPromoteAt?: (agentId: string) => number;
  refreshLearnedSkillSurface?: (agentId: string) => void;
  outcomeJudge?: OutcomeJudge;
  learningOutcomeJudgeEnabled?: (agentId: string) => boolean;
  readTurnTranscript?: (scope: JudgeScope) => string | undefined;
}
