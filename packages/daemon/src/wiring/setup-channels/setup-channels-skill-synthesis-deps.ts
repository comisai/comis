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

import {
  type OutcomeSignalPort,
  type MentalModelStorePort,
  type ContextStorePort,
  type ContextBrowsePort,
  type AppContainer,
  type SessionStorePort,
  parseFormattedSessionKey,
} from "@comis/core";
import type { ReflectionSourceTrajectory } from "@comis/agent";
import type { MemoryApi } from "@comis/memory";
import { buildReviewSessionSource } from "./review-session-source.js";
import type { ReflectionCronDeps } from "./setup-channels-memory-crons-types.js";

/** The structural deps subset this helper reads (a slice of CronEventListenerDeps — avoids a cycle). */
export interface ReflectionDepsInput {
  container: AppContainer;
  tenantId: string;
  sessionStore: Pick<SessionStorePort, "listDetailed" | "loadByRef">;
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
 * Recover the user-authored request from the executor's persisted model-facing
 * envelope. LCD is lossless, so the stored user message includes dynamic system,
 * workspace, channel, and integration context ahead of the actual request. That
 * context is required for replay but is not trajectory evidence and must never be
 * distilled into a learned document.
 */
function stripExecutorEnvelope(text: string): string {
  const openMarker = "[System context]";
  const closeMarker = "[End system context]";
  const openIndex = text.indexOf(openMarker);
  if (openIndex === -1) return text;
  const closeIndex = text.indexOf(closeMarker, openIndex + openMarker.length);
  if (closeIndex === -1) return text;
  const afterContext = text.slice(closeIndex + closeMarker.length);
  const channelHeader = afterContext.match(/^\s*\[[\w-]+\]\s+\S+\s+\([^)]*\):\s*/);
  return (channelHeader ? afterContext.slice(channelHeader[0].length) : afterContext).trim();
}

/**
 * Derive the two origin-trust signals for a session-source sender. Prefer the
 * immutable, content-free ingress decision persisted on the trajectory. Synthetic
 * trajectories without that carrier fall back to `elevatedReply.senderTrustMap`
 * plus the configured `defaultTrustLevel`:
 *
 *  - `trustedOrigin` (ANTI-POISON AXIS 1): trusted iff the resolved tier is NOT the
 *    `"external"` tier. DENY-ON-UNKNOWN — no sender id, no `senderTrustMap` entry with
 *    an external default ⇒ `false`. NEVER default to trusted: a deny-default merely
 *    UNDER-seeds (benign), an allow-default would let a planted unknown-origin success
 *    corroborate a doc. The JOB enforces the filter (reflection-job.ts SELECT).
 *  - `explicitlyTrusted` (the SINGLE-OWNER belt): true iff the sender was found via an
 *    EXPLICIT `senderTrustMap` entry (the operator NAMED it) AND resolves to a non-external
 *    tier — NOT via a promiscuous `defaultTrustLevel`, NOT an unknown sender. Only an
 *    explicitly-trusted owner's repetition may corroborate a topic in `single_owner` mode,
 *    so a promiscuous-default success (trustedOrigin:true, explicitlyTrusted:false) can ride
 *    past SELECT yet NEVER self-corroborate by repetition.
 */
function deriveOriginTrust(
  sender: string,
  senderTrustMap: Record<string, string>,
  defaultTrustLevel: string,
  persisted?: { senderTrust?: string; senderTrustExplicit?: boolean },
): { trustedOrigin: boolean; explicitlyTrusted: boolean } {
  if (persisted?.senderTrust !== undefined) {
    const trustedOrigin = persisted.senderTrust !== UNTRUSTED_TRUST_TIER;
    return {
      trustedOrigin,
      explicitlyTrusted: persisted.senderTrustExplicit === true && trustedOrigin,
    };
  }
  // Without persisted evidence, no sender id means trust cannot be established.
  if (sender.length === 0) return { trustedOrigin: false, explicitlyTrusted: false };
  const explicitEntry = Object.prototype.hasOwnProperty.call(senderTrustMap, sender);
  const tier = senderTrustMap[sender] ?? defaultTrustLevel;
  const trustedOrigin = tier !== UNTRUSTED_TRUST_TIER;
  // Explicitly trusted ONLY when the operator NAMED this sender (an explicit map entry)
  // AND that entry resolves to a trusted tier — a promiscuous default never qualifies.
  return { trustedOrigin, explicitlyTrusted: explicitEntry && trustedOrigin };
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
    sessionStore: deps.sessionStore,
    lcdStore: deps.lcdStore,
    contextBrowse: deps.contextBrowse,
  });
  const listed = source.listDetailed({ tenantId, agentId });
  if (!listed.ok) return [];
  const entryBySessionId = new Map<string, (typeof listed.value)[number]>();
  const senderBySession = new Map<string, string>();
  for (const entry of listed.value) {
    entryBySessionId.set(entry.sessionKey, entry);
    senderBySession.set(entry.sessionKey, entry.principalId ?? "");
  }

  // The per-agent trust derivation inputs (elevatedReply.senderTrustMap
  // + defaultTrustLevel). Read once per run. The config is always default-parsed
  // (schema-agent-runtime.ts:377), so an agent that never configured elevatedReply
  // gets `{}` + `"external"` ⇒ every unmapped sender is deny-on-unknown.
  const agentConfig = deps.container.config.agents?.[agentId];
  const elevatedReply = agentConfig?.elevatedReply;
  const senderTrustMap: Record<string, string> = elevatedReply?.senderTrustMap ?? {};
  const defaultTrustLevel: string = elevatedReply?.defaultTrustLevel ?? UNTRUSTED_TRUST_TIER;

  // sessionKey → the loaded message rows, loaded at most once per session.
  const contentOf = (m: unknown): string => {
    const c = (m as { content?: unknown }).content;
    return typeof c === "string" ? c : "";
  };
  const roleOf = (m: unknown): string => {
    const r = (m as { role?: unknown }).role;
    return typeof r === "string" ? r : "";
  };
  const createdAtOf = (m: unknown): number | undefined => {
    const c = (m as { createdAt?: unknown }).createdAt;
    return typeof c === "number" ? c : undefined;
  };
  const rowsCache = new Map<string, unknown[] | undefined>();
  const sessionRows = (sessionKey: string): unknown[] | undefined => {
    if (rowsCache.has(sessionKey)) return rowsCache.get(sessionKey);
    const entry = entryBySessionId.get(sessionKey);
    if (!entry) return undefined;
    const loaded = source.loadByRef({ tenantId, agentId }, entry.conversationRef);
    const rows = loaded.ok
      ? loaded.value?.messages.filter((m) => contentOf(m).length > 0)
      : undefined;
    const val = rows !== undefined && rows.length > 0 ? rows : undefined;
    rowsCache.set(sessionKey, val);
    return val;
  };
  // Derive { text, signature } for ONE turn. When BOTH the turn's `observedAt` (the
  // outcome ledger window key) AND per-row `createdAt` timestamps are available (the
  // LCD/DAG default), the turn's rows are the session rows with
  // `createdAt ∈ (prevObservedAt, observedAt]` — its signature is THAT turn's
  // user text and its text THAT turn's exchange, so a single long DM yields
  // PER-TURN topics instead of one whole-session mega-topic (live incident:
  // 42 selected → distinctTopicKeys 1 → one mega-doc). A windowed turn whose
  // slice holds no user text (e.g. a severed LCD) is SKIPPED (under-learning is
  // benign). Without timestamps (pipeline-mode daemon store / a non-sqlite
  // outcome store), fall back to the v1 whole-session texts — unchanged behavior.
  const turnTexts = (
    rows: unknown[],
    windowed: boolean,
    prevObservedAt: number,
    observedAt: number,
  ): { text: string; signature: string } | undefined => {
    const turnRows = windowed
      ? rows.filter((m) => {
          const at = createdAtOf(m);
          return at !== undefined && at > prevObservedAt && at <= observedAt;
        })
      : rows;
    if (turnRows.length === 0) return undefined;
    const trajectoryContentOf = (message: unknown): string => {
      const content = contentOf(message);
      return roleOf(message) === "user" ? stripExecutorEnvelope(content) : content;
    };
    const text = turnRows.map(trajectoryContentOf).filter((t) => t.length > 0).join("\n");
    // The topicKey signature = the user-role messages (the task INTENT the user
    // controls), which is stable across the agent's response wording. The JOB
    // normalizes it via normalizeOpeningRequest (topic-key.ts) — which also
    // strips the volatile executor envelope (the [System context] header),
    // so identical requests at different times collapse to the same topicKey.
    const userText = turnRows
      .filter((m) => roleOf(m) === "user")
      .map(trajectoryContentOf)
      .filter((t) => t.length > 0)
      .join("\n");
    // A WINDOWED turn with no user text never seeds (a per-turn topic must be the
    // user's intent); the un-windowed fallback keeps the v1 full-text fallback.
    if (userText.length === 0 && windowed) return undefined;
    const signature = userText.length > 0 ? userText : text;
    return text.length > 0 ? { text, signature } : undefined;
  };

  // Per-session ascending order by observedAt so each turn's window is
  // (previous turn's observedAt, this turn's observedAt].
  const ids = [...idsRes.value].sort((a, b) => (a.observedAt ?? 0) - (b.observedAt ?? 0));
  const prevObservedBySession = new Map<string, number>();

  const out: ReflectionSourceTrajectory[] = [];
  for (const {
    trajectoryId,
    sessionId,
    observedAt,
    senderTrust,
    senderTrustExplicit,
    procedureDescriptor: descriptor,
  } of ids) {
    const rows = sessionRows(sessionId);
    if (rows === undefined) continue; // no transcript for this turn's session → skip
    // Windowing needs BOTH the ledger observedAt AND at least one timestamped row.
    const windowed = typeof observedAt === "number" && rows.some((m) => createdAtOf(m) !== undefined);
    const prevObservedAt = prevObservedBySession.get(sessionId) ?? Number.NEGATIVE_INFINITY;
    if (typeof observedAt === "number") prevObservedBySession.set(sessionId, observedAt);
    const texts = turnTexts(rows, windowed, prevObservedAt, typeof observedAt === "number" ? observedAt : Number.POSITIVE_INFINITY);
    if (texts === undefined) continue; // empty window (severed LCD / no user text) → skip
    const sender = senderBySession.get(sessionId)
      || parseFormattedSessionKey(sessionId)?.userId
      || "";
    // The content-free procedure descriptor read back from listTrajectoryIds (the ordered
    // tool-NAME sequence + counts). The KEY is the ordered sequence JOINED — order + repeats
    // preserved, NOT sorted/deduped (the sequence + counts contract). It is self-sufficient
    // because a custom procedure groupKey BYPASSES the Jaccard signature-merge (only
    // byte-identical keys collide). The tool method names never contain `>`, so the separator
    // is injective. Absent (empty) ⇒ omit — the turn ran no cap-mapped tool call sites.
    const sequence = descriptor ?? [];
    // Trust axis 1 (trustedOrigin) + the single-owner belt (explicitlyTrusted), both
    // resolved daemon-side at ingress and persisted content-free. The config lookup
    // remains a fail-closed fallback for synthetic rows without that carrier.
    const originTrust = deriveOriginTrust(
      sender,
      senderTrustMap,
      defaultTrustLevel,
      { senderTrust, senderTrustExplicit },
    );
    out.push({
      trajectoryId,
      sessionId,
      sender,
      text: texts.text,
      signature: texts.signature,
      trustedOrigin: originTrust.trustedOrigin,
      explicitlyTrusted: originTrust.explicitlyTrusted,
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
        // The single-owner belt: the profile/topic corpus is read ONLY from the high-trust
        // system/learned tiers (trust-gated at admission), so it is explicitly trusted — a
        // single owner's profile/topic may corroborate by repetition in single_owner mode.
        // An `external` row (defence-in-depth) is still excluded by axis 2 regardless.
        explicitlyTrusted: true,
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
