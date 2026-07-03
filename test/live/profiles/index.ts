// SPDX-License-Identifier: Apache-2.0
/**
 * Config profile registry for the live-fire test tier.
 *
 * Each profile is a config delta over the shipped default, plus the credentials
 * it requires and its cost tier. The runner uses these to select which profiles
 * to exercise given the available credentials and budget.
 *
 * Mirrors the test/support/test-providers.ts registry pattern — named exports,
 * plain typed objects (no classes), top-level const arrays.
 *
 * @module
 */

import type { CostTier } from "../cost.js";

/**
 * A live-fire config profile — a config delta over the shipped default plus
 * the credentials required to run it and its cost tier.
 */
export interface LiveProfile {
  readonly id: string;
  readonly description: string;
  readonly configDelta: Record<string, unknown>;
  readonly credentialsRequired: string[];
  readonly costTier: CostTier;
}

/**
 * The seeded profile registry. Three canonical profiles cover the golden
 * production profiles without real provider calls.
 *
 * Further profiles are added as new subsystems are certified.
 */
export const PROFILES: readonly LiveProfile[] = [
  {
    id: "default",
    description: "Shipped default config — the config 99% of operators use",
    configDelta: {},
    credentialsRequired: [],
    costTier: "$0",
  },
  {
    id: "lean-cloud",
    description: "Lean cloud: pipeline context engine, OpenAI embeddings, voice (Whisper→TTS)",
    configDelta: {
      "contextEngine.version": "pipeline",
      "embedding.provider": "openai",
    },
    credentialsRequired: ["OPENAI_API_KEY"],
    costTier: "cent",
  },
  {
    id: "privacy-device",
    description:
      "Privacy/on-device: DAG, local embeddings, costFeatures.enabled=false, encrypted storage",
    configDelta: {
      "contextEngine.version": "dag",
      "embedding.provider": "local",
      "memory.costFeatures.enabled": false,
      "security.storage": "encrypted",
    },
    credentialsRequired: [],
    costTier: "$0",
  },
] as const;
