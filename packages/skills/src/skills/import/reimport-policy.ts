// SPDX-License-Identifier: Apache-2.0
/** Pure trust and content-hash policy for an existing skill import target. */
import type { SkillTrustTier } from "./trust-tier.js";

/** Outcomes for a re-import whose destination already exists. */
export type SkillReimportDecision = "no_op" | "refuse" | "confirm" | "install";

export interface DecideSkillReimportInput {
  readonly incumbentHash: string;
  readonly incumbentTrust: SkillTrustTier;
  readonly candidateHash: string;
  readonly candidateTrust: SkillTrustTier;
  readonly confirmed: boolean;
}

const TRUST_RANK: Readonly<Record<SkillTrustTier, number>> = {
  "first-party": 3,
  operator: 2,
  community: 1,
  "agent-authored": 0,
};

/** Decide whether a candidate may replace a recorded incumbent. */
export function decideSkillReimport(input: DecideSkillReimportInput): SkillReimportDecision {
  if (input.incumbentHash === input.candidateHash) return "no_op";
  if (TRUST_RANK[input.incumbentTrust] > TRUST_RANK[input.candidateTrust]) return "refuse";
  return input.confirmed ? "install" : "confirm";
}
