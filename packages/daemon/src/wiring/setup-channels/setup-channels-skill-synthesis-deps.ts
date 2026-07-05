// SPDX-License-Identifier: Apache-2.0
/**
 * Assemble the closed-graph REFLECTION injectables for the `__REFLECT__` cron sentinel — the
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
 * What CHANGED from the synthesis bundle (delete, don't wrap):
 * - REMOVED the clustering embedding wiring (the embed-attach helper, its char cap,
 *   and the embedding port field). The reflection job groups by
 *   `normalizeOpeningRequest(signature)` — a deterministic, keyless topicKey (NO
 *   embeddings, so the embedding-singleton failure mode is gone).
 * - REMOVED the user-system-context strip here — its envelope-stripping algorithm
 *   now lives in topic-key.ts (the group-by key normalizer); this builder
 *   passes the raw user-role text through as `signature` and the job normalizes it.
 * - REMOVED the sandbox validation adapter + the mutating-approval gate — an
 *   advisory doc carries NO executable surface (the advisory-doc column was dropped), so
 *   the only validation is the STATIC `validateLearnedDocBody` keystone the JOB
 *   runs. Removing the gate removes an attack surface.
 * - ADDED a per-source `trustedOrigin` the job FILTERS on — derived
 *   DAEMON-SIDE here (the daemon has the session/sender-trust context; the
 *   `ResolvedOutcome` does NOT carry it).
 *
 * @module
 */

import type { OutcomeSignalPort, MentalModelStorePort, ContextStorePort, ContextBrowsePort, AppContainer } from "@comis/core";
import type { ReflectionSourceTrajectory } from "@comis/agent";
import type { MemoryApi } from "@comis/memory";
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
  /**
   * The high-trust SOURCE-MEMORY read surface the PROFILE/TOPIC source builders distil
   * over (the old user-rep/consolidation `memoryApi.inspect` read). The
   * SKILL builder does not use it (it reads outcome trajectories). Absent ⇒ the profile/
   * topic builders return empty (fail-closed — never fabricate a profile/topic source).
   */
  memoryApi?: Pick<MemoryApi, "inspect">;
}

/**
 * The untrusted-tier label every UNKNOWN/unmapped sender resolves to — the
 * `ElevatedReplyConfigSchema.defaultTrustLevel` default (schema-agent-prompt.ts)
 * and the memory `TrustLevel` external tier. A sender whose derived tier equals
 * this is NOT a trusted origin. Mirrors the delivery-service
 * "unmapped participant ⇒ external (inert)" classification.
 */
const UNTRUSTED_TRUST_TIER = "external";

/**
 * Derive whether a session-source sender is a TRUSTED origin, reading
 * the per-agent `elevatedReply.senderTrustMap` (senderId -> trust-tier name) with
 * the configured `defaultTrustLevel` (schema default `"external"`) for an unmapped
 * sender. A sender resolving to the `"external"` tier is NOT trusted.
 *
 * DENY-ON-UNKNOWN: when trust CANNOT be positively established — no
 * sender id, no `senderTrustMap` entry, and the default is the `"external"` tier —
 * the result is `false`. NEVER default to trusted: an untrusted/unknown-origin
 * success must seed nothing (a deny-default merely UNDER-seeds — under-learning is
 * benign; an allow-default would silently weaken this invariant by letting a planted
 * unknown-origin success corroborate a doc). The JOB enforces the filter
 * (reflection-job.ts SELECT); this is the daemon
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

    // Build the PER-KIND source trajectories for the reflection SELECT step (the
    // daemon-side `kind` seam). SKILL reflects over OUTCOME trajectories;
    // PROFILE/TOPIC reflect over high-trust SOURCE MEMORIES (the old user-rep/consolidation
    // corpus). Both carry BOTH anti-poison axes the job filters on.
    buildSourceTrajectories: async (
      kind: "skill" | "profile" | "topic",
      agentId: string,
      tenantId: string,
    ): Promise<ReflectionSourceTrajectory[]> => {
      if (kind === "skill") return buildSkillSources(deps, outcomeStore, agentId, tenantId);
      return buildMemorySources(deps, kind, agentId, tenantId);
    },
  };
}

/**
 * SKILL kind: enumerate the real per-turn outcome ids (listTrajectoryIds) and emit THOSE,
 * attaching each turn's LCD-merged session transcript (buildReviewSessionSource — NOT raw
 * listDetailed which is empty in DAG mode) as the text to generalize from. The reflection
 * SELECT resolves each `trajectoryId` against the outcome signal — outcomes are keyed by the
 * PER-TURN `traceId` (setup-learning.ts), NOT the sessionKey. Emitting the
 * sessionKey instead would never match resolve() → `selected:0` forever.
 */
async function buildSkillSources(
  deps: ReflectionDepsInput,
  outcomeStore: OutcomeSignalPort,
  agentId: string,
  tenantId: string,
): Promise<ReflectionSourceTrajectory[]> {
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

  // The per-agent trust derivation inputs (elevatedReply.senderTrustMap
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
      // strips the volatile executor envelope (the [System context] header),
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
  for (const { trajectoryId, sessionId, procedureDescriptor: descriptor } of idsRes.value) {
    const texts = sessionTexts(sessionId);
    if (texts === undefined) continue; // no transcript for this turn's session → skip
    const sender = senderBySession.get(sessionId) ?? "";
    // The content-free procedure descriptor read back from listTrajectoryIds (the ordered
    // tool-NAME sequence + counts). The KEY is the ordered sequence JOINED — order + repeats
    // preserved, NOT sorted/deduped (the sequence + counts contract). It is self-sufficient
    // because a custom procedure groupKey BYPASSES the Jaccard signature-merge (only
    // byte-identical keys collide). The tool method names never contain `>`, so the separator
    // is injective. Absent (empty) ⇒ omit — the turn ran no cap-mapped tool call sites.
    const sequence = descriptor ?? [];
    out.push({
      trajectoryId,
      sessionId,
      sender,
      text: texts.text,
      signature: texts.signature,
      // Trust axis 1: derive SESSION-origin trust DAEMON-SIDE
      // (deny-on-unknown). The job filters on it.
      trustedOrigin: deriveTrustedOrigin(sender, senderTrustMap, defaultTrustLevel),
      // Trust axis 2: the per-MEMORY source-trust axis is always
      // false for kind:skill — a skill source is an OUTCOME trajectory (a finished
      // session), NOT a source memory carrying a per-memory trustLevel.
      sourceTrustExternal: false,
      ...(sequence.length > 0 ? { procedureDescriptor: { key: sequence.join(">"), sequence } } : {}),
    });
  }
  return out;
}

/**
 * PROFILE / TOPIC kinds (daemon side, axis 2): build sources from the
 * agent's high-trust SOURCE MEMORIES (the corpus the old user-rep/consolidation jobs read
 * via `memoryApi.inspect`), NOT outcome trajectories. For EACH source memory we set:
 *
 *  - `sourceTrustExternal = (trustLevel === "external")` — the load-bearing axis 2,
 *    the OLD user-rep layer-1 firewall (memory-user-representation-job.ts:322
 *    `s.trustLevel !== "external"`). A planted `external`-trust memory rides through with
 *    `sourceTrustExternal:true`; the engine SELECT then excludes it EVEN on a trusted
 *    session (the two axes compose). The exclude lives in the JOB (one
 *    authoritative layer), this is the daemon DERIVATION feeding it.
 *  - `trustedOrigin: true` — a high-trust (system/learned) source memory IS the trusted
 *    corpus (the old user-rep semantics: the per-MEMORY external exclude is the firewall,
 *    not a per-session origin check). An `external` source carries `trustedOrigin:true` too
 *    but is excluded by axis 2 regardless — proving the axes are distinct.
 *  - PROFILE: `sender = userId` so the engine's profile `groupKey: (t) => t.sender` yields
 *    `topicKey === userId` (one doc per user, which the `<user_profile>` read selects
 *    on); the `signature` carries the userId so distinct users never collapse into one group.
 *  - TOPIC: groups like skill via the engine's default `normalizeOpeningRequest(signature)`,
 *    so the `signature` is the memory content (the cluster's representative text).
 *
 * Fail-closed: absent the `memoryApi` read surface there is nothing to seed a profile/topic
 * from → empty (never fabricate a source). Reads system + learned (the high-trust tiers the
 * old job read); `external` rows are NOT read here — but a row whose trust is `external`
 * (defence-in-depth, should it appear) still gets `sourceTrustExternal:true`.
 */
function buildMemorySources(
  deps: ReflectionDepsInput,
  kind: "profile" | "topic",
  agentId: string,
  tenantId: string,
): ReflectionSourceTrajectory[] {
  const memoryApi = deps.memoryApi;
  if (!memoryApi) return []; // fail-closed: no read surface ⇒ no profile/topic sources

  // Read the agent's HIGH-TRUST source memories (system + learned) — the corpus the old
  // user-rep/consolidation jobs distilled. Each row carries its own per-memory trustLevel.
  const SOURCE_READ_LIMIT = 1000;
  const out: ReflectionSourceTrajectory[] = [];
  for (const trustLevel of ["system", "learned"] as const) {
    const rows = memoryApi.inspect({ tenantId, agentId, trustLevel, limit: SOURCE_READ_LIMIT });
    for (const row of rows) {
      const content = typeof row.content === "string" ? row.content : "";
      if (content.length === 0) continue; // never seed an empty source
      const userId = typeof row.userId === "string" ? row.userId : "";
      const rowTrust = typeof row.trustLevel === "string" ? row.trustLevel : trustLevel;
      // PROFILE groups by user (signature carries the userId ⇒ distinct users ⇒ distinct
      // groups, even when two users phrase a fact identically). TOPIC groups on the content
      // (the engine's default normalizeOpeningRequest signature).
      const signature = kind === "profile" ? `${userId}\n${content}` : content;
      out.push({
        // The provenance id of THIS source memory (opaque). The profile/topic SELECT does
        // NOT resolve an outcome — these sources are pre-trusted corpus memories, gated by
        // the two trust axes (not the outcome signal). The id is carried for provenance only.
        trajectoryId: typeof row.id === "string" ? row.id : "",
        // sessionId: the source session (so distinct sessions corroborate via the engine's
        // ≥2-distinct (sessionId, sender) gate). The memory's source.sessionKey when present.
        sessionId: readSessionKey(row),
        // PROFILE: sender IS the userId (⇒ profile groupKey `t.sender` ⇒ topicKey === userId).
        sender: userId,
        text: content,
        signature,
        // The high-trust source corpus is the trusted origin (the old user-rep semantics);
        // axis 2 below is the per-memory firewall.
        trustedOrigin: true,
        // Trust axis 2 (the old layer-1 firewall, memory-user-representation-job.ts:322):
        // an `external`-trust source memory NEVER seeds a doc — the job SELECT excludes it.
        sourceTrustExternal: rowTrust === "external",
      });
    }
  }
  return out;
}

/** The source session key from a memory row's provenance (`source.sessionKey`), or `""`. */
function readSessionKey(row: Record<string, unknown>): string {
  const source = row.source;
  if (source && typeof source === "object") {
    const sk = (source as { sessionKey?: unknown }).sessionKey;
    if (typeof sk === "string") return sk;
  }
  return "";
}
