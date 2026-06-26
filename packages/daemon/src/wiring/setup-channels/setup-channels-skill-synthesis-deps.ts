// SPDX-License-Identifier: Apache-2.0
/**
 * Assemble the closed-graph REFLECTION injectables (v2.31 Reflection, Phase 223
 * Plan 05, REFLECT-01/02) for the `__REFLECT__` cron sentinel — the
 * reflect-engine replacement for the deleted `buildSkillSynthesisCronDeps`
 * embedding-clustering bundle.
 *
 * Split out of setup-channels-credentials.ts (the 600L setup-channels dir cap) so
 * the daemon's SOLE composition-root join of @comis/memory (the mental-model +
 * outcome stores) + @comis/agent (the reflection job, PORT TYPES only) lives in
 * its own leaf. The agent job NEVER imports @comis/memory — the daemon injects the
 * real adapters (the architecture-graph.test.ts agent↛memory cut).
 *
 * Returns `undefined` when the stores are not wired (then the sentinel reports a
 * clean "surface not wired" error) — but with the per-agent learningSkills flag
 * OFF by default the sentinel short-circuits ok BEFORE it ever reads this bundle,
 * so a default install never exercises this path.
 *
 * What CHANGED from the synthesis bundle (D-07 / I1 — delete, don't wrap):
 * - REMOVED the clustering embedding wiring (the embed-attach helper, its char cap,
 *   and the embedding port field). The reflection job groups by
 *   `normalizeOpeningRequest(signature)` — a deterministic, keyless topicKey (NO
 *   embeddings, so the SYNTH-EMBED-DEAD singleton failure is gone).
 * - REMOVED the user-system-context strip here — its envelope-stripping algorithm
 *   now lives in Plan 01's topic-key.ts (the group-by key normalizer); this builder
 *   passes the raw user-role text through as `signature` and the job normalizes it.
 * - REMOVED the sandbox validation adapter + the mutating-approval gate — an
 *   advisory doc carries NO executable surface (Phase 222 dropped the column), so
 *   the only validation is the STATIC `validateLearnedDocBody` keystone the JOB
 *   runs (INV-3). Removing the gate removes an attack surface (INV-3 strengthened).
 * - ADDED a per-source `trustedOrigin` (INV-5/D-04) the job FILTERS on — derived
 *   DAEMON-SIDE here (the daemon has the session/sender-trust context; the
 *   `ResolvedOutcome` does NOT carry it — Research A2).
 *
 * @module
 */

import type { OutcomeSignalPort, MentalModelStorePort, ContextStorePort, ContextBrowsePort, AppContainer } from "@comis/core";
import type { ReflectionSourceTrajectory } from "@comis/agent";
import { buildReviewSessionSource } from "./review-session-source.js";
import type { ReflectionCronDeps } from "./setup-channels-memory-crons-types.js";

/** The structural deps subset this helper reads (a slice of CronEventListenerDeps — avoids a cycle). */
export interface ReflectionDepsInput {
  container: AppContainer;
  tenantId?: string;
  sessionStore: { listDetailed(tenantId?: string): unknown[]; loadByFormattedKey(sessionKey: string): unknown };
  lcdStore?: Pick<ContextStorePort, "getMessages">;
  contextBrowse?: ContextBrowsePort;
  outcomeStore?: OutcomeSignalPort;
  learnedSkillStore?: MentalModelStorePort;
}

/**
 * The untrusted-tier label every UNKNOWN/unmapped sender resolves to — the
 * `ElevatedReplyConfigSchema.defaultTrustLevel` default (schema-agent-prompt.ts)
 * and the memory `TrustLevel` external tier. A sender whose derived tier equals
 * this is NOT a trusted origin (INV-5/D-04). Mirrors the delivery-service
 * "unmapped participant ⇒ external (inert)" classification.
 */
const UNTRUSTED_TRUST_TIER = "external";

/**
 * Derive whether a session-source sender is a TRUSTED origin (INV-5/D-04), reading
 * the per-agent `elevatedReply.senderTrustMap` (senderId -> trust-tier name) with
 * the configured `defaultTrustLevel` (schema default `"external"`) for an unmapped
 * sender. A sender resolving to the `"external"` tier is NOT trusted.
 *
 * DENY-ON-UNKNOWN (M-1/INV-5): when trust CANNOT be positively established — no
 * sender id, no `senderTrustMap` entry, and the default is the `"external"` tier —
 * the result is `false`. NEVER default to trusted: an untrusted/unknown-origin
 * success must seed nothing (a deny-default merely UNDER-seeds — under-learning is
 * benign; an allow-default would silently weaken INV-5 by letting a planted
 * unknown-origin success corroborate a doc). The JOB enforces the filter
 * (reflection-job.ts SELECT, RED both directions in Plan 04); this is the daemon
 * DERIVATION that feeds it.
 */
function deriveTrustedOrigin(
  sender: string,
  senderTrustMap: Record<string, string>,
  defaultTrustLevel: string,
): boolean {
  // No sender id ⇒ cannot establish trust ⇒ deny-on-unknown.
  if (sender.length === 0) return false;
  const tier = senderTrustMap[sender] ?? defaultTrustLevel;
  // Trusted iff the resolved tier is NOT the untrusted/external tier.
  return tier !== UNTRUSTED_TRUST_TIER;
}

/**
 * Build the reflection cron bundle, or `undefined` when the @comis/memory stores
 * are absent. The reflect ADAPTER is built per-run inside the sentinel handler (it
 * needs the resolved model/key); THIS bundle carries the mental-model store + the
 * outcome success gate + the trusted-origin source builder.
 */
export function buildReflectionCronDeps(deps: ReflectionDepsInput): ReflectionCronDeps | undefined {
  const { learnedSkillStore, outcomeStore } = deps;
  if (!learnedSkillStore || !outcomeStore) return undefined;

  return {
    learnedSkillStore,
    outcomeSignal: outcomeStore,

    // Build the source trajectories for the reflection SELECT step, which resolves
    // each one's `trajectoryId` against the outcome signal. Outcomes are keyed by
    // the PER-TURN `traceId` (setup-learning.ts), NOT the sessionKey — so we
    // ENUMERATE the real per-turn ids from the outcome ledger (listTrajectoryIds)
    // and emit THOSE, attaching each turn's session transcript (buildReviewSessionSource
    // — LCD-merged, NOT raw listDetailed which is empty in DAG mode) as the text to
    // generalize from. Pre-fix this emitted the sessionKey, which resolve() never
    // matched → `selected:0` forever on the single-agent path (live VPS 2026-06-18).
    buildSourceTrajectories: async (agentId: string, tenantId: string): Promise<ReflectionSourceTrajectory[]> => {
      // Fail-closed: without an enumerable, resolvable id source there is nothing to
      // reflect on (never fall back to a non-resolvable identity like the sessionKey).
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

      // INV-5/D-04: the per-agent trust derivation inputs (elevatedReply.senderTrustMap
      // + defaultTrustLevel). Read once per run. The config is always default-parsed
      // (schema-agent-runtime.ts:377), so an agent that never configured elevatedReply
      // gets `{}` + `"external"` ⇒ every unmapped sender is deny-on-unknown.
      const agentConfig = deps.container.config.agents?.[agentId];
      const elevatedReply = agentConfig?.elevatedReply;
      const senderTrustMap: Record<string, string> = elevatedReply?.senderTrustMap ?? {};
      const defaultTrustLevel: string = elevatedReply?.defaultTrustLevel ?? UNTRUSTED_TRUST_TIER;

      // sessionKey → { full transcript (the reflect input), task signature (the
      // topicKey group-by input) }, loaded at most once per session.
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
          // The topicKey signature = the user-role messages (the task INTENT the user
          // controls), which is stable across the agent's response wording. The JOB
          // normalizes it via normalizeOpeningRequest (topic-key.ts) — which also
          // strips the volatile executor envelope (the RC-2 [System context] header),
          // so identical requests at different times collapse to the same topicKey.
          // Fall back to the full text when a session has no user message (so the
          // signature is never empty).
          const userText = loaded.messages
            .filter((m) => roleOf(m) === "user")
            .map((m) => contentOf(m))
            .filter((t) => t.length > 0)
            .join("\n");
          const signature = userText.length > 0 ? userText : text;
          val = text.length > 0 ? { text, signature } : undefined;
        }
        textCache.set(sessionKey, val);
        return val;
      };

      const out: ReflectionSourceTrajectory[] = [];
      for (const { trajectoryId, sessionId } of idsRes.value) {
        const texts = sessionTexts(sessionId);
        if (texts === undefined) continue; // no transcript for this turn's session → skip
        const sender = senderBySession.get(sessionId) ?? "";
        out.push({
          trajectoryId,
          sessionId,
          sender,
          text: texts.text,
          signature: texts.signature,
          // FOLD-04 AXIS 1 (INV-5/D-04): derive SESSION-origin trust DAEMON-SIDE
          // (deny-on-unknown). The job filters on it.
          trustedOrigin: deriveTrustedOrigin(sender, senderTrustMap, defaultTrustLevel),
          // FOLD-04 AXIS 2 (Phase 225): the per-MEMORY source-trust axis is always
          // false for kind:skill — a skill source is an OUTCOME trajectory (a finished
          // session), NOT a source memory carrying a per-memory trustLevel. The
          // profile/topic builders (Plan 04) set this from the memory's
          // `trustLevel === "external"`.
          sourceTrustExternal: false,
        });
      }
      return out;
    },
  };
}
