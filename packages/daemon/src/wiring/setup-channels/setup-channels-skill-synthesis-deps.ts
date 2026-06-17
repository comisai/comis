// SPDX-License-Identifier: Apache-2.0
/**
 * Assemble the closed-graph skill-synthesis injectables (SKILL-08/09, v2.26
 * Verified Learning WS2) for the __SKILL_SYNTHESIS__ cron sentinel.
 *
 * Split out of setup-channels-credentials.ts (the 600L setup-channels dir cap) so
 * the daemon's SOLE composition-root join of @comis/memory (the learned-skill +
 * outcome stores) + @comis/skills (the sandbox validation adapter) + @comis/agent
 * (the synthesis job, PORT TYPES only) lives in its own leaf. The agent job NEVER
 * imports @comis/memory / @comis/skills — the daemon injects the real adapters
 * (the architecture-graph.test.ts agent↛memory/skills cut).
 *
 * Returns `undefined` when the stores are not wired (then the sentinel reports a
 * clean "surface not wired" error) — but with the per-agent learningSkills flag
 * OFF by default the sentinel short-circuits ok BEFORE it ever reads this bundle,
 * so a default install never exercises this path.
 *
 * @module
 */

import type { OutcomeSignalPort, LearnedSkillStorePort, ContextStorePort, ContextBrowsePort, AppContainer } from "@comis/core";
import type { SynthesisSourceTrajectory, SkillApprovalGate } from "@comis/agent";
import { createSandboxSkillValidationAdapter } from "@comis/skills";
import { buildReviewSessionSource } from "./review-session-source.js";
import type { SkillSynthesisCronDeps } from "./setup-channels-memory-crons-types.js";

/** The structural deps subset this helper reads (a slice of CronEventListenerDeps — avoids a cycle). */
export interface SkillSynthesisDepsInput {
  container: AppContainer;
  tenantId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the assembleToolsForAgent AgentTool<any>[] signature
  assembleToolsForAgent?: (agentId: string, options?: { sessionKey?: any }) => Promise<any[]>;
  sessionStore: { listDetailed(tenantId?: string): unknown[]; loadByFormattedKey(sessionKey: string): unknown };
  lcdStore?: Pick<ContextStorePort, "getMessages">;
  contextBrowse?: ContextBrowsePort;
  outcomeStore?: OutcomeSignalPort;
  learnedSkillStore?: LearnedSkillStorePort;
  approvalGate?: SkillApprovalGate;
}

/** A no-op approval gate (deny-all) when none is wired — a mutating candidate is then never admitted. */
const DENY_ALL_GATE: SkillApprovalGate = { requestApproval: async () => ({ approved: false }) };

/**
 * Build the SKILL-08/09 cron bundle, or `undefined` when the @comis/memory stores
 * are absent. The synthesis ADAPTER is built per-run inside the sentinel handler
 * (it needs the resolved model/key); THIS bundle carries the store + outcome gate +
 * the per-agent validation-adapter / LCD-source builders + the approval gate.
 */
export function buildSkillSynthesisCronDeps(deps: SkillSynthesisDepsInput): SkillSynthesisCronDeps | undefined {
  const { learnedSkillStore, outcomeStore } = deps;
  if (!learnedSkillStore || !outcomeStore) return undefined;

  return {
    learnedSkillStore,
    outcomeSignal: outcomeStore,
    approvalGate: deps.approvalGate ?? DENY_ALL_GATE,

    // Build the @comis/skills sandbox validation adapter for an agent: inject its full tool list
    // + effective tool policy so the adapter resolves the effective set (applyToolPolicy) and
    // rejects an out-of-policy required tool. The dynamic-replay defaults (detectSandboxProvider +
    // node spawn + system clock) activate automatically; off Linux it fails-closed to static-only.
    buildValidationAdapter: async (agentId: string) => {
      const allTools = deps.assembleToolsForAgent ? await deps.assembleToolsForAgent(agentId) : [];
      const agentConfig = deps.container.config.agents?.[agentId];
      const policy =
        agentConfig?.skills?.toolPolicy ??
        { profile: "full" as const, allow: [] as string[], deny: [] as string[] };
      return createSandboxSkillValidationAdapter({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool<any>[] erased at the cron boundary
        allTools: allTools as any,
        policy,
      });
    },

    // Build the LCD-merged source trajectories (buildReviewSessionSource — NOT sessionStore.listDetailed,
    // which is empty in DAG mode, the LIVEMEM bug). Flatten each session's transcript into one block the
    // synthesis adapter wraps; the sessionKey is the trajectory identity the outcome signal resolves on.
    buildSourceTrajectories: async (agentId: string, tenantId: string): Promise<SynthesisSourceTrajectory[]> => {
      const source = buildReviewSessionSource({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the review-source sessionStore view
        sessionStore: deps.sessionStore as any,
        lcdStore: deps.lcdStore,
        contextBrowse: deps.contextBrowse,
        agentId,
        tenantId,
      });
      const entries = source.listDetailed(tenantId);
      const out: SynthesisSourceTrajectory[] = [];
      for (const e of entries) {
        const loaded = source.loadByFormattedKey(e.sessionKey);
        if (loaded === undefined) continue;
        const text = loaded.messages
          .map((m) => {
            const content = (m as { content?: unknown }).content;
            return typeof content === "string" ? content : "";
          })
          .filter((t) => t.length > 0)
          .join("\n");
        if (text.length === 0) continue;
        out.push({ trajectoryId: e.sessionKey, sessionId: e.sessionKey, sender: e.userId, text });
      }
      return out;
    },
  };
}
