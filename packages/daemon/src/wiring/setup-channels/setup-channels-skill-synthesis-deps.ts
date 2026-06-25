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

import type { OutcomeSignalPort, LearnedSkillStorePort, ContextStorePort, ContextBrowsePort, AppContainer, EmbeddingPort } from "@comis/core";
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
  /**
   * RC-1: the daemon's embedder (the cached + circuit-broken `EmbeddingPort`, threaded
   * from setupMemory's `cachedPort` alongside the other memory stores). Used to attach
   * clustering embeddings to the synthesis source trajectories. Deliberately threaded
   * (NOT read off `container`) because the embedder is kept OFF `AppContainer` (the
   * agent-accessible path — daemon-types.ts isolation boundary). Absent ⇒ no clustering
   * embeddings ⇒ every trajectory is a singleton (the prior behaviour).
   */
  embeddingPort?: EmbeddingPort;
}

/** A no-op approval gate (deny-all) when none is wired — a mutating candidate is then never admitted. */
const DENY_ALL_GATE: SkillApprovalGate = { requestApproval: async () => ({ approved: false }) };

/**
 * The embedding window for clustering (~1536 tokens — mirrors @comis/memory's
 * `truncateForEmbedding` default). A session transcript can exceed an embedder's
 * context; truncating the LEADING chars keeps the signal while staying in-window.
 */
const MAX_CLUSTER_EMBED_CHARS = 6_000;

/**
 * RC-2: recover the RAW user request from a stored inbound message by stripping the
 * executor's injected envelope. The executor wraps every inbound turn as
 * `[System context]\n<preamble incl. a VOLATILE timestamp>\n[End system context]\n\n[<channel>] <id> (<time>):\n<actual message>`
 * (envelope-wrapper.ts). Both the system-context preamble AND the channel header carry a
 * per-turn timestamp, so the stored "user message" of two IDENTICAL requests DIFFERS —
 * which is why raw user-message clustering failed live (2026-06-25). This recovers the
 * stable request. Mirrors `@comis/web`'s `stripUserSystemContext` (the daemon must not
 * import @comis/web); if the envelope format in envelope-wrapper.ts changes, update both.
 */
function stripUserSystemContext(text: string): string {
  if (!text.includes("[System context]") && !text.includes("[End system context]")) return text;
  const endMarker = "[End system context]";
  const endIdx = text.lastIndexOf(endMarker);
  if (endIdx === -1) return text;
  const afterContext = text.slice(endIdx + endMarker.length);
  // Strip the channel header `[telegram] 678314278 (9:34 AM):` — its time is also volatile.
  const channelHeaderMatch = afterContext.match(/\s*\[[\w-]+\]\s+\S+\s+\([^)]*\):\s*/);
  if (channelHeaderMatch) {
    const msgStart = afterContext.indexOf(channelHeaderMatch[0]) + channelHeaderMatch[0].length;
    return afterContext.slice(msgStart).trim();
  }
  return afterContext.trim();
}

/**
 * RC-1 (SYNTH-EMBED-DEAD) + RC-2 (clustering signal) fix: attach a clustering
 * embedding to each source trajectory via the threaded embedder (`cachedPort` — the
 * cached + circuit-broken {@link import("@comis/core").EmbeddingPort} already used for
 * recall). The synthesis CLUSTER step groups by cosine similarity of `embedding`; a
 * trajectory with NO embedding is a SINGLETON, so `maxClusterCardinality` stays 1 and
 * nothing is ever admitted — which is exactly why skill synthesis was dead in production.
 *
 * - Embeds an aligned `embedTexts[i]` per trajectory — the caller passes a STABLE task
 *   SIGNATURE (the user request — RC-2), NOT the raw transcript, so two analogous
 *   successful tasks cluster even when the agent's response wording differs (raw-
 *   transcript cosine fell below the 0.82 threshold on near-identical tasks — live 2026-06-25).
 * - DEDUPES by the embed text — many per-turn trajectories share one session signature,
 *   so we embed each unique signature once and fan the vector back out.
 * - GRACEFUL: an absent/faulting/short-returning embedder leaves `embedding` undefined
 *   (= the prior singleton behaviour) and NEVER throws — the nightly synthesis cron
 *   must not break on an embedding hiccup (the circuit breaker may be open).
 */
async function attachClusteringEmbeddings(
  trajectories: SynthesisSourceTrajectory[],
  embedTexts: string[],
  embedder: EmbeddingPort | undefined,
): Promise<void> {
  if (!embedder || trajectories.length === 0 || embedTexts.length !== trajectories.length) return;
  const uniqueTexts = [...new Set(embedTexts)];
  const truncated = uniqueTexts.map((t) => (t.length > MAX_CLUSTER_EMBED_CHARS ? t.slice(0, MAX_CLUSTER_EMBED_CHARS) : t));
  let res: Awaited<ReturnType<EmbeddingPort["embedBatch"]>>;
  try {
    res = await embedder.embedBatch(truncated);
  } catch {
    return; // a misbehaving provider must never break the cron
  }
  if (!res.ok || res.value.length !== uniqueTexts.length) return; // graceful degradation
  const byText = new Map<string, number[]>();
  uniqueTexts.forEach((t, i) => byText.set(t, res.value[i]));
  trajectories.forEach((t, i) => {
    t.embedding = byText.get(embedTexts[i]);
  });
}

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
      // sessionKey → { full transcript (the synthesis input), task signature (the
      // clustering input) }, loaded at most once per session.
      const contentOf = (m: unknown): string => {
        const c = (m as { content?: unknown }).content;
        return typeof c === "string" ? c : "";
      };
      const roleOf = (m: unknown): string => {
        const r = (m as { role?: unknown }).role;
        return typeof r === "string" ? r : "";
      };
      const textCache = new Map<string, { text: string; signature: string } | undefined>();
      const sessionTexts = (sessionKey: string): { text: string; signature: string } | undefined => {
        if (textCache.has(sessionKey)) return textCache.get(sessionKey);
        const loaded = source.loadByFormattedKey(sessionKey);
        let val: { text: string; signature: string } | undefined;
        if (loaded !== undefined) {
          const text = loaded.messages.map(contentOf).filter((t) => t.length > 0).join("\n");
          // RC-2: the CLUSTERING signature = the user-role messages (the task INTENT the
          // user controls), which is stable across the agent's response wording. Two
          // analogous successful tasks then cluster even when the agent phrased its
          // answer differently (raw-transcript cosine fell below 0.82 on near-identical
          // tasks — live 2026-06-25). Fall back to the full text when a session has no
          // user message (so the signature is never empty).
          const userText = loaded.messages
            .filter((m) => roleOf(m) === "user")
            .map((m) => stripUserSystemContext(contentOf(m))) // RC-2: drop the volatile envelope so identical requests match
            .filter((t) => t.length > 0)
            .join("\n");
          const signature = userText.length > 0 ? userText : text;
          val = text.length > 0 ? { text, signature } : undefined;
        }
        textCache.set(sessionKey, val);
        return val;
      };

      const out: SynthesisSourceTrajectory[] = [];
      const signatures: string[] = []; // aligned with `out`; the per-trajectory clustering input (RC-2)
      for (const { trajectoryId, sessionId } of idsRes.value) {
        const texts = sessionTexts(sessionId);
        if (texts === undefined) continue; // no transcript for this turn's session → skip
        out.push({ trajectoryId, sessionId, sender: senderBySession.get(sessionId) ?? "", text: texts.text });
        signatures.push(texts.signature);
      }
      // RC-1/RC-2: attach clustering embeddings of the task SIGNATURE so structurally-
      // similar successes cluster (without them every trajectory is a singleton →
      // maxClusterCardinality 1 → admit:0). `text` (the full transcript) is unchanged —
      // it remains the synthesis INPUT the LLM distills the skill body from.
      await attachClusteringEmbeddings(out, signatures, deps.embeddingPort);
      return out;
    },
  };
}
