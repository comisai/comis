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

    // Build the source trajectories for the synthesis SELECT step, which resolves
    // each one's `trajectoryId` against the outcome signal. Outcomes are keyed by
    // the PER-TURN `traceId` (setup-learning.ts), NOT the sessionKey — so we
    // ENUMERATE the real per-turn ids from the outcome ledger (listTrajectoryIds)
    // and emit THOSE, attaching each turn's session transcript (buildReviewSessionSource
    // — LCD-merged, NOT raw listDetailed which is empty in DAG mode) as the text to
    // generalize from. Pre-fix this emitted the sessionKey, which resolve() never
    // matched → `selected:0` forever on the single-agent path (live VPS 2026-06-18).
    buildSourceTrajectories: async (agentId: string, tenantId: string): Promise<SynthesisSourceTrajectory[]> => {
      // Fail-closed: without an enumerable, resolvable id source there is nothing to
      // synthesize (never fall back to a non-resolvable identity like the sessionKey).
      if (!outcomeStore.listTrajectoryIds) return [];
      const idsRes = await outcomeStore.listTrajectoryIds({ tenantId, agentId });
      if (!idsRes.ok || idsRes.value.length === 0) return [];

      const source = buildReviewSessionSource({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the review-source sessionStore view
        sessionStore: deps.sessionStore as any,
        lcdStore: deps.lcdStore,
        contextBrowse: deps.contextBrowse,
        agentId,
        tenantId,
      });
      // sessionKey → sender (userId), from the session view.
      const senderBySession = new Map<string, string>();
      for (const e of source.listDetailed(tenantId)) senderBySession.set(e.sessionKey, e.userId);
      // sessionKey → flattened transcript, loaded at most once per session.
      const textCache = new Map<string, string | undefined>();
      const sessionText = (sessionKey: string): string | undefined => {
        if (textCache.has(sessionKey)) return textCache.get(sessionKey);
        const loaded = source.loadByFormattedKey(sessionKey);
        const text =
          loaded === undefined
            ? ""
            : loaded.messages
                .map((m) => {
                  const content = (m as { content?: unknown }).content;
                  return typeof content === "string" ? content : "";
                })
                .filter((t) => t.length > 0)
                .join("\n");
        const val = text.length > 0 ? text : undefined;
        textCache.set(sessionKey, val);
        return val;
      };

      const out: SynthesisSourceTrajectory[] = [];
      for (const { trajectoryId, sessionId } of idsRes.value) {
        const text = sessionText(sessionId);
        if (text === undefined) continue; // no transcript for this turn's session → skip
        out.push({ trajectoryId, sessionId, sender: senderBySession.get(sessionId) ?? "", text });
      }
      return out;
    },
  };
}
