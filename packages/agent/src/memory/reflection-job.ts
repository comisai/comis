// SPDX-License-Identifier: Apache-2.0
/**
 * The reflection engine (v2.31 Reflection, Phase 223, REFLECT-01/03/04/05/06) —
 * the ONE outcome-gated job that REPLACES the dead embedding-clustering
 * `runSkillSynthesis`. It runs as an offline cron (wired daemon-side, Plan 05 —
 * NOT the hot path). One pass over the injected source trajectories:
 *
 *  1. **SELECT** (fail-closed, REFLECT-01 / INV-5): for each source,
 *     `OutcomeSignalPort.resolve`; keep ONLY `outcome === "success" && confidence
 *     >= minConfidence` AND BOTH anti-poison axes (FOLD-04): `source.trustedOrigin`
 *     (axis 1 — daemon-derived SESSION origin, INV-5/D-04) AND
 *     `!source.sourceTrustExternal` (axis 2 — the per-MEMORY source-trust belt; a
 *     planted `external` memory riding a trusted session seeds nothing, Pitfall 2).
 *     An untrusted-origin OR external-trust source NEVER seeds a doc. An unresolved
 *     outcome is fail-closed `continue`.
 *  2. **GROUP** (replaces `clusterSuccesses`, REFLECT-02): `Map<topicKey,
 *     members[]>` via `normalizeOpeningRequest(source.signature)` — a deterministic,
 *     keyless, content-light token-SET hash (NO embeddings). An empty topicKey
 *     (`""`, ungroupable) is skipped.
 *  3. **GATE** (anti-domination, REFLECT-03 / INV-2): `distinctSenderCardinality(
 *     members) >= 2` — N repeats of one `(sessionId, sender)` count as 1, so an
 *     attacker cannot corroborate a doc by repeating one success. Bounded by
 *     `maxDocsPerRun`.
 *  4. **REFLECT** (REFLECT-04): `store.get(docName)` → its `structuredBody`. New
 *     (no prior AST) → reflect a FRESH section list, `renderStructuredBody`.
 *     Exists → reflect delta-ops, `applyDeltaOps(prior, ops)` (untargeted sections
 *     byte-identical — Hindsight's drift-killer), `renderStructuredBody`. ONE cheap
 *     LLM call per topic via the injected adapter.
 *  5. **GUARD + ADMIT** (REFLECT-05/06): an empty/failed reflection → record
 *     `empty_reflection`, SKIP `store.admit` (the guard lives HERE — the store
 *     upsert overwrites `body` unconditionally on conflict, so the prior doc only
 *     survives if we skip the call). Else `validateLearnedDocBody({name,body,
 *     description})` → reject a critical poison/secret body. Else
 *     `store.admit({ kind:"skill", topicKey, structuredBody, body, mutating:false,
 *     proofCount: LOW_PROOF_COUNT, ... })` — at `trust=learned`/`state=candidate`
 *     (store-forced) and idempotent on the deterministic id.
 *
 * Kind-generic-READY: the engine populates only `kind:"skill"` in 223, but the
 * SELECT/GROUP/REFLECT seams are kind-agnostic so Phase 225 adds profile/topic by
 * varying select/group/prompt, not by adding a new engine.
 *
 * Closed graph: this job consumes `@comis/core` PORT TYPES + the static
 * `validateLearnedDocBody` keystone + the pure `applyDeltaOps`/`renderStructuredBody`
 * (agent→core is ALLOWED) + the injected source/store/adapter/clock. It imports NO
 * `@comis/memory` / `@comis/skills` value (the agent↛memory / agent↛skills build
 * cut). It emits NO `learning:skill_*` bus event — the daemon emits the counts
 * after the job returns (Plan 05).
 *
 * @module
 */

import { createHash } from "node:crypto";
import { ok, fromPromise, type Result } from "@comis/shared";
import type {
  LearningScope,
  MentalModelStorePort,
  OutcomeSignalPort,
  StructuredBody,
  DocSection,
  DeltaOp,
  ReflectAdmissionOutcome,
} from "@comis/core";
import { validateLearnedDocBody, MAX_DOC_NAME_LENGTH } from "@comis/core";
import { applyDeltaOps, renderStructuredBody } from "@comis/core";
import { normalizeOpeningRequest } from "./topic-key.js";
import type { ReflectionAdapter } from "./llm-reflection-adapter.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Max topics reflected (one LLM call each) per run — the DoS ceiling. */
const DEFAULT_MAX_DOCS_PER_RUN = 10;

/**
 * The LOW proof-count cap a reflected doc is admitted at, REGARDLESS of
 * corroboration group size — the INV-2 anti-domination belt (the real guard,
 * independent of `(sessionId, sender)` precision). A reflected doc seeds at
 * `candidate` and earns promotion only through the reuse-outcome loop (Loop C).
 */
const LOW_PROOF_COUNT = 1;

/** The admission confidence seed for a reflected advisory doc (no dynamic proof — advisory only). */
const REFLECT_ADMISSION_CONFIDENCE = 0.7;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * One finished source trajectory the job selects + groups over. The daemon
 * (Plan 05) builds these from the LCD-merged review source and injects them.
 * `text` is the flattened transcript the reflect adapter wraps; `signature` is the
 * envelope-stripped user-role text the topicKey is computed from; `sender` is the
 * message author the anti-domination cardinality counts on. `trustedOrigin` is
 * derived DAEMON-SIDE (the daemon has the session/sender-trust context — the
 * `ResolvedOutcome` does NOT carry it; Research A2) — the job FILTERS on it, it
 * does NOT compute trust itself.
 */
export interface ReflectionSourceTrajectory {
  /** The trajectory identity (the stable traceId the outcome signal keys on). */
  trajectoryId: string;
  /** The conversation/session the trajectory belongs to (anti-domination key part). */
  sessionId: string;
  /** The author of the trajectory (anti-domination key part; coarse is acceptable). */
  sender: string;
  /** The flattened trajectory text the reflect adapter wraps + distils. UNTRUSTED. */
  text: string;
  /** The envelope-stripped user-role text → `normalizeOpeningRequest` (the topicKey). */
  signature: string;
  /**
   * FOLD-04 ANTI-POISON AXIS 1 (the 223 session-origin belt). INV-5/D-04: false ⇒
   * this success NEVER seeds a doc (daemon-derived SESSION/sender origin trust). A
   * per-TRAJECTORY boolean — NOT a per-memory trust level.
   */
  trustedOrigin: boolean;
  /**
   * FOLD-04 ANTI-POISON AXIS 2 (Phase 225, the per-MEMORY source-trust belt —
   * GAP-3, the OLD user-rep layer-1 firewall, memory-user-representation-job.ts:322
   * `s.trustLevel !== "external"`). true ⇒ this source carries an `external`-trust
   * memory and NEVER seeds a doc, even riding a `trustedOrigin:true` session
   * (Pitfall 2: a planted external memory can ride a trusted session — the two axes
   * are DISTINCT and must BOTH pass). The daemon (Plan 04) sets it from the
   * per-memory `trustLevel === "external"`; for kind:skill the daemon sets it false
   * (skill sources are outcome trajectories, not source memories).
   */
  sourceTrustExternal: boolean;
}

/** The config slice the job reads (a structural subset; Phase 226 collapses to learning.reflect). */
export interface RunReflectionConfig {
  enabled: boolean;
  minConfidence: number;
  /** Max topics reflected per run (defaults to 10). */
  maxDocsPerRun: number;
}

/** A minimal structural logger (no Pino import — the closed-graph discipline). */
export interface RunReflectionJobLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Dependencies injected into {@link runReflection}. */
export interface RunReflectionDeps {
  agentId: string;
  tenantId: string;
  /** The (tenant, agent) isolation boundary every read/write rebinds to. */
  scope: LearningScope;
  /**
   * The doc family this run reflects (Phase 225 FOLD — the I7 kind-parameter).
   * Threaded onto the admitted doc's `kind` and into the doc-name prefix
   * (`<kind>-<topicKey>`) so the engine is ONE engine across skill/profile/topic.
   * Omitted ⇒ `"skill"` (a skill run is byte-identical to the 223 behavior).
   */
  kind?: "skill" | "profile" | "topic";
  /**
   * The per-kind GROUP key (Phase 225 FOLD). Maps a source to its corroboration
   * group: kind:skill keys on the normalized opening-request signature (the
   * default), kind:profile groups by user (one doc per user), kind:topic groups
   * its surprisal/observation clusters. Omitted ⇒ `normalizeOpeningRequest(
   * t.signature)` (byte-identical for kind:skill). An empty key (`""`) is
   * ungroupable and skipped (never corroborates — a singleton).
   */
  groupKey?: (t: ReflectionSourceTrajectory) => string;
  config: RunReflectionConfig;
  /** The LCD-merged source history the daemon injects (with the daemon-derived trustedOrigin). */
  sourceTrajectories: ReflectionSourceTrajectory[];
  /** The cheap-model reflect adapter (wraps the untrusted trajectory; ONE call per topic). */
  reflectionAdapter: Pick<ReflectionAdapter, "reflect">;
  /** The outcome-signal port (the fail-closed success gate). */
  outcomeSignal: Pick<OutcomeSignalPort, "resolve">;
  /**
   * The mental-model store (injected from @comis/memory). `get` reads the prior doc
   * for delta-ops; `admit` is the idempotent candidate write (a NEW doc, or a skill
   * doc — byte-identical with 223). `supersede` (Phase 225 FOLD-01) is the bi-temporal
   * history-append a profile/topic CORRECTION of an EXISTING doc routes through (the
   * prior body is preserved in `history`, never overwritten). Optional with a
   * skill-default posture: omitted ⇒ no doc supersedes (every kind admits, the 223
   * behavior); kind:skill NEVER supersedes even when wired.
   */
  mentalModelStore: Pick<MentalModelStorePort, "get" | "admit"> &
    Partial<Pick<MentalModelStorePort, "supersede">>;
  /** Wall-clock reads — durations + the admit timestamp. NEVER a wall-clock global. */
  clock: { now: () => number };
  /** Counts/ids-only event bus (the daemon emits the learning:skill_* events, Plan 05). */
  eventBus: { emit(event: string, payload: unknown): void };
  logger: RunReflectionJobLogger;
}

/**
 * The ACUTE reason a reflection run admitted nothing (or did) — a closed,
 * content-free enum so "why didn't a doc get learned?" is ONE readable field on
 * the funnel (the RC-4 diagnosability the synthesis-job established).
 *
 * IN-02: the canonical definition moved to `@comis/core` (events-learning.ts) so
 * the `reflect:funnel.admissionOutcome` event payload is typed to the SAME closed
 * union (core cannot import @comis/agent — the agent→core direction only). This
 * job's `classifyReflectOutcome` produces it; the daemon emit assigns it onto the
 * event field; one shared union ties them together (a free-form string is a compile
 * error). Re-exported here so existing `@comis/agent` consumers keep importing it
 * from the agent barrel unchanged. First-match-wins precedence (computed from the
 * funnel counts) is documented at {@link classifyReflectOutcome} below:
 * - `no_successes`         — no trusted-origin `success`-outcome cleared SELECT.
 * - `uncorroborated`       — topics grouped but `maxTopicCardinality < 2` (the
 *                            anti-domination gate: needs ≥2 distinct (session,sender)).
 * - `empty_reflection`     — a corroborated topic reflected empty/failed (the
 *                            REFLECT-05 guard skipped the admit; the prior doc survives).
 * - `rejected_validation`  — a reflected body failed `validateLearnedDocBody`
 *                            (a poison/secret body rejected before durable storage).
 * - `rejected_name_length` — a reflected doc's NAME exceeded `MAX_DOC_NAME_LENGTH`
 *                            (the 225 WR-01 gap: previously mis-reported as
 *                            `rejected_validation`). Reported as its own reason so an
 *                            operator distinguishes a name-length over-cap from a poison
 *                            verdict (counts-only — never the offending name).
 * - `untrusted_origin`     — every selected success was dropped at SELECT for an
 *                            untrusted origin / external-trust source (D5 salvage): the
 *                            specific "nothing trusted survived" reason, out-ranking the
 *                            generic `no_successes`.
 * - `admitted`             — ≥1 doc admitted.
 */
export type { ReflectAdmissionOutcome };

/** What {@link runReflection} returns — counts/closed-scalars only; the daemon emits the events. */
export interface RunReflectionResult {
  /** The acute reason this run admitted nothing (or `admitted`) — a content-free verdict. */
  admissionOutcome: ReflectAdmissionOutcome;
  /** How many trusted-origin success trajectories cleared SELECT. */
  selected: number;
  /** How many docs were admitted to the store this run. */
  admitted: number;
  /** The largest distinct-(sessionId, sender) cardinality across the topic groups (anti-domination telemetry). */
  maxTopicCardinality: number;
  /** How many corroborated topics were SKIPPED (empty reflection or rejected validation). */
  skipped: number;
  /**
   * Phase 226 (D5 salvage): how many `success` sources were dropped at SELECT for an
   * untrusted origin (FOLD-04 axis 1) or external-trust source (axis 2). Counts only.
   * Lets the daemon emit `untrusted_origin` when this is the acute reason nothing seeded.
   */
  untrustedDrops: number;
  /**
   * Phase 226 (the 225 WR-01 gap): how many corroborated topics had their reflected doc
   * rejected for a NAME-length over-cap (distinct from a poison `rejected_validation`).
   * Counts only — never the offending name.
   */
  nameLengthRejections: number;
  /**
   * OBS-1 (hindsight-reflection-20260626): the count of source trajectories that ENTERED this run
   * (pre-SELECT input). With `totalSourceChars` it distinguishes "no sources built" (0 → a wiring gap)
   * from "sources existed but dropped/uncorroborated". Counts only.
   */
  sourceTrajectoryCount: number;
  /**
   * OBS-1: total characters of the SELECTED source transcripts fed to the reflect call (count only,
   * never the text). The empty-vs-real discriminator — a non-trivial value with a junk admitted doc is
   * an LLM-yield issue (SYNTH-YIELD), not an empty-source wiring bug.
   */
  totalSourceChars: number;
}

// ---------------------------------------------------------------------------
// Anti-domination cardinality (the ≥2-distinct corroboration metric, INV-2)
// ---------------------------------------------------------------------------

/** Distinct (sessionId, sender) cardinality of a member set (the anti-domination metric). */
function distinctSenderCardinality(members: ReflectionSourceTrajectory[]): number {
  const seen = new Set<string>();
  for (const m of members) {
    // session_id + sender — repeating one (session, sender) N times counts once.
    seen.add(`${m.sessionId} ${m.sender}`);
  }
  return seen.size;
}

/**
 * Classify the ACUTE reason a reflection run admitted nothing (or did) from the
 * funnel counts. Pure + first-match-wins (the order encodes precedence: a success
 * short-circuits, then each upstream gate in pipeline order).
 */
export function classifyReflectOutcome(f: {
  selected: number;
  maxTopicCardinality: number;
  admitted: number;
  emptyReflections: number;
  /** Phase 226: success sources dropped at SELECT for untrusted origin / external-trust. */
  untrustedDrops?: number;
  /** Phase 226: corroborated topics rejected for a doc-name over-cap (the 225 WR-01 gap). */
  nameLengthRejections?: number;
}): ReflectAdmissionOutcome {
  if (f.admitted > 0) return "admitted";
  // D5 salvage: when SELECT kept NOTHING but some success was dropped for an untrusted
  // origin / external-trust source, that is the SPECIFIC reason — out-rank no_successes.
  if (f.selected === 0 && (f.untrustedDrops ?? 0) > 0) return "untrusted_origin";
  if (f.selected === 0) return "no_successes";
  if (f.maxTopicCardinality < 2) return "uncorroborated";
  if (f.emptyReflections > 0) return "empty_reflection";
  // The 225 WR-01 gap: a name-length over-cap rejection is reported as ITS OWN reason
  // rather than mis-attributed to the poison verdict below.
  if ((f.nameLengthRejections ?? 0) > 0) return "rejected_name_length";
  return "rejected_validation";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flatten a topic group's member text into one block for the reflect call (the adapter wraps it). */
function groupText(members: ReflectionSourceTrajectory[]): string {
  return members.map((m) => m.text).join("\n\n---\n\n");
}

/**
 * The deterministic doc NAME a topicKey reflects into. The store keys a row on
 * `(tenant, agent, kind, topicKey, name)`, so a STABLE name per topicKey makes a
 * re-run hit the SAME row (idempotent re-admit, REFLECT-06). Content-light — the
 * topicKey is already a sha256 hex of the normalized intent (INV-6), never the raw
 * transcript; the `skill-` prefix keeps the kebab-case lookup-name contract.
 *
 * WR-01 (Phase 223 review): the name embeds the FULL topicKey (NOT a 16-char/64-bit
 * truncation), so name↔topicKey is bijective. The store's name-keyed `get`/`promoteByName`/
 * `demoteByName` resolve on name alone — a truncated name let two distinct
 * topicKeys (colliding on their first 16 hex chars) produce the SAME name with
 * DIFFERENT topic_key, two rows coexisting under the `(tenant, agent, kind,
 * topic_key, name)` UNIQUE constraint, and a name-keyed promote/demote then
 * cross-wired BOTH. The full topicKey makes `(tenant, agent, kind, name)` unique,
 * so the name-keyed lifecycle is unambiguous.
 *
 * Phase 225 FOLD: the prefix is the KIND (`<kind>-<topicKey>`) — `profile-`/
 * `topic-` keep `(tenant, agent, kind, name)` unique ACROSS kinds (a profile and a
 * skill that happen to share a topicKey get distinct names).
 *
 * WR-01 (Phase 225 review): unlike skill/topic — whose topicKey is ALWAYS a 64-char
 * sha256 hex (`normalizeOpeningRequest`), so the name is 70 chars, bounded — the
 * PROFILE group key is the RAW userId (the daemon sets `groupKey: (t) => t.sender`).
 * A long sender id (a namespaced/email-channel address) makes `profile-<rawUserId>`
 * exceed `MAX_DOC_NAME_LENGTH` (120); `validateLearnedDocBody` would then reject it
 * AFTER the per-topic reflect call burned an LLM call, and the funnel would mis-report
 * the silent drop as `rejected_validation` (a poison verdict) rather than a
 * name-length problem. So the name is BOUNDED here: when `<kind>-<topicKey>` would
 * overflow the cap we hash the group key into the name (`<kind>-<sha256hex>`),
 * length-stable for ANY kind/groupKey origin. CRITICAL: only the NAME is hashed — the
 * RAW `topicKey` still rides the admit input's `topicKey` column, so the
 * `<user_profile>` read selector (`prompt-assembly.ts`, `d.topicKey === userId`)
 * still resolves the profile. For the common short-id case (Telegram numeric, Discord/
 * Slack snowflakes) and for ALL skill/topic docs the raw name is already under the
 * cap, so this is byte-identical to the prior `<kind>-<topicKey>`.
 */
function docNameForTopic(kind: "skill" | "profile" | "topic", topicKey: string): string {
  const name = `${kind}-${topicKey}`;
  if (name.length <= MAX_DOC_NAME_LENGTH) return name;
  // Over-cap raw group key (a long profile userId) → hash the KEY into the name. The
  // raw userId is preserved on the admit's `topicKey` column for the read selector.
  return `${kind}-${createHash("sha256").update(topicKey).digest("hex")}`;
}

/** The default GROUP key (kind:skill) — the normalized opening-request signature. */
function defaultGroupKey(t: ReflectionSourceTrajectory): string {
  return normalizeOpeningRequest(t.signature);
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Run one reflection pass for a single agent. Non-fatal posture: a single topic's
 * resolve/reflect/admit fault is logged + skipped (the run returns `ok` with the
 * counts). The run returns `err` only on an unrecoverable precondition.
 */
export async function runReflection(deps: RunReflectionDeps): Promise<Result<RunReflectionResult, Error>> {
  // `reflectionAdapter` + `mentalModelStore` are destructured (and used) inside the
  // per-topic `reflectTopic` helper off the same `deps`, not in this function body.
  const { agentId, scope, config, sourceTrajectories, outcomeSignal, clock, logger } = deps;
  // The per-kind group function (Phase 225 FOLD) — defaults to the skill behavior.
  const groupKey = deps.groupKey ?? defaultGroupKey;

  const startMs = clock.now();
  const maxDocsPerRun = config.maxDocsPerRun ?? DEFAULT_MAX_DOCS_PER_RUN;

  // 1. SELECT (fail-closed): keep only trusted-origin `success` >= minConfidence.
  const selected: ReflectionSourceTrajectory[] = [];
  // Phase 226 (D5 salvage): count the successes dropped at SELECT for an untrusted origin
  // (axis 1) / external-trust source (axis 2). Counts only — feeds the `untrusted_origin`
  // verdict when this is the acute reason nothing seeded.
  let untrustedDrops = 0;
  for (const t of sourceTrajectories) {
    // FOLD-04 AXIS 1 (INV-5/D-04 — the 223 session-origin belt): an untrusted-origin
    // success NEVER seeds a doc. Filter FIRST (cheap, before the outcome resolve) — a
    // planted/untrusted trajectory cannot even reach the corroboration gate.
    if (!t.trustedOrigin) {
      untrustedDrops += 1;
      logger.debug(
        {
          agentId,
          step: "select" as const,
          trajectoryId: t.trajectoryId,
          errorKind: "precondition" as const,
          hint: "untrusted-origin success — never seeds a doc (INV-5/D-04 axis 1), skipped",
        },
        "reflection: untrusted-origin trajectory skipped",
      );
      continue;
    }
    // FOLD-04 AXIS 2 (Phase 225 GAP-3 — the per-MEMORY source-trust belt, the OLD
    // user-rep layer-1 firewall). A source carrying an `external`-trust memory NEVER
    // seeds a doc, even riding a `trustedOrigin:true` session (Pitfall 2: a planted
    // external memory can ride a trusted session — the two axes are DISTINCT and must
    // BOTH pass). The daemon (Plan 04) sets `sourceTrustExternal` from the per-memory
    // `trustLevel === "external"`; for kind:skill it is always false. SECOND fail-closed
    // exclude AFTER axis 1 so the two compose.
    if (t.sourceTrustExternal) {
      untrustedDrops += 1;
      logger.debug(
        {
          agentId,
          step: "select" as const,
          trajectoryId: t.trajectoryId,
          errorKind: "precondition" as const,
          hint: "external-trust source — excluded from doc seeding (FOLD-04 axis 2 / INV-5), skipped",
        },
        "reflection: external-trust source skipped",
      );
      continue;
    }
    const resolved = await fromPromise(outcomeSignal.resolve(t.trajectoryId, scope));
    if (!resolved.ok || !resolved.value.ok) {
      logger.debug(
        {
          agentId,
          step: "select" as const,
          trajectoryId: t.trajectoryId,
          // Closed-union: an unresolved outcome is an unmet precondition for selection
          // (fail-closed) — not a fault.
          errorKind: "precondition" as const,
          hint: "outcome unresolved (unknown/error) — skipped, fail-closed",
        },
        "reflection: outcome unresolved, skipping trajectory",
      );
      continue; // fail-closed: an unresolved outcome is NOT a success
    }
    const outcome = resolved.value.value;
    if (outcome.outcome === "success" && outcome.confidence >= config.minConfidence) {
      selected.push(t);
    }
  }

  logger.debug(
    { agentId, step: "select" as const, candidates: sourceTrajectories.length, selected: selected.length },
    "reflection selection complete",
  );

  // OBS-1: content-free source telemetry for the funnel. `sourceTrajectoryCount` is the pre-SELECT
  // input size; `totalSourceChars` is the chars of the SELECTED transcripts that actually feed the
  // reflect call (0 when nothing survived SELECT). Together they let `comis explain` tell an empty-
  // source wiring gap from an LLM-yield (real text in, junk doc out) without reading the transcript.
  const sourceTrajectoryCount = sourceTrajectories.length;
  const totalSourceChars = selected.reduce((n, t) => n + t.text.length, 0);

  if (selected.length === 0) {
    // D5 salvage: when nothing survived SELECT, the acute reason is `untrusted_origin` if
    // some success was dropped for an untrusted origin / external-trust source, else `no_successes`.
    const emptyOutcome = classifyReflectOutcome({ selected: 0, maxTopicCardinality: 0, admitted: 0, emptyReflections: 0, untrustedDrops });
    logRunComplete(deps, startMs, { selected: 0, admitted: 0, maxTopicCardinality: 0, skipped: 0, emptyReflections: 0, untrustedDrops, nameLengthRejections: 0 });
    return ok({ admissionOutcome: emptyOutcome, selected: 0, admitted: 0, maxTopicCardinality: 0, skipped: 0, untrustedDrops, nameLengthRejections: 0, sourceTrajectoryCount, totalSourceChars });
  }

  // 2. GROUP (replaces clusterSuccesses): Map<topicKey, members[]> via the per-kind
  //    group function (Phase 225 FOLD — defaults to the skill normalizeOpeningRequest).
  const groups = new Map<string, ReflectionSourceTrajectory[]>();
  for (const t of selected) {
    const key = groupKey(t);
    if (key === "") continue; // ungroupable signature — never corroborates (a singleton)
    const members = groups.get(key);
    if (members) members.push(t);
    else groups.set(key, [t]);
  }

  // 3. GATE + 4. REFLECT + 5. GUARD/ADMIT. Bound by maxDocsPerRun.
  let admitted = 0;
  let skipped = 0;
  let emptyReflections = 0;
  // Phase 226 (the 225 WR-01 gap): corroborated topics whose reflected doc NAME was over-cap.
  let nameLengthRejections = 0;
  let maxTopicCardinality = 0;
  let reflectedTopics = 0;

  for (const [topicKey, members] of groups) {
    const cardinality = distinctSenderCardinality(members);
    maxTopicCardinality = Math.max(maxTopicCardinality, cardinality);
    // INV-2/D-05: a topic needs >=2 distinct (sessionId, sender) to corroborate.
    if (cardinality < 2) continue;

    // Bound the number of LLM calls per run.
    if (reflectedTopics >= maxDocsPerRun) {
      logger.debug(
        { agentId, step: "reflect" as const, maxDocsPerRun, hint: "maxDocsPerRun reached — remaining topics deferred to the next run" },
        "reflection bounded by maxDocsPerRun",
      );
      break;
    }
    reflectedTopics += 1;

    const r = await reflectTopic({ deps, topicKey, members });
    if (r === "empty") {
      emptyReflections += 1;
      skipped += 1;
    } else if (r === "rejected") {
      skipped += 1;
    } else if (r === "rejected_name_length") {
      // A name-length over-cap rejection is a SKIP (no admit) AND a counted reason so the
      // funnel verdict can report `rejected_name_length` instead of the poison verdict.
      nameLengthRejections += 1;
      skipped += 1;
    } else if (r === "admitted") {
      admitted += 1;
    }
    // "skipped" (a per-topic reflect/admit fault) increments neither admit nor empty.
  }

  const admissionOutcome = classifyReflectOutcome({ selected: selected.length, maxTopicCardinality, admitted, emptyReflections, untrustedDrops, nameLengthRejections });

  logRunComplete(deps, startMs, { selected: selected.length, admitted, maxTopicCardinality, skipped, emptyReflections, untrustedDrops, nameLengthRejections });

  return ok({ admissionOutcome, selected: selected.length, admitted, maxTopicCardinality, skipped, untrustedDrops, nameLengthRejections, sourceTrajectoryCount, totalSourceChars });
}

// ---------------------------------------------------------------------------
// Per-topic reflect + guard + admit
// ---------------------------------------------------------------------------

type TopicOutcome = "admitted" | "empty" | "rejected" | "rejected_name_length" | "skipped";

interface ReflectTopicArgs {
  deps: RunReflectionDeps;
  topicKey: string;
  members: ReflectionSourceTrajectory[];
}

/**
 * Reflect ONE corroborated topic into a doc: read the prior AST, reflect (fresh
 * synth or delta-ops), GUARD the empty-content case (skip admit — REFLECT-05),
 * validate (reject critical — REFLECT-06), then admit at candidate/learned/proof=1.
 */
async function reflectTopic(args: ReflectTopicArgs): Promise<TopicOutcome> {
  const { deps, topicKey, members } = args;
  const { agentId, scope, reflectionAdapter, mentalModelStore, clock, logger } = deps;
  // The doc family (Phase 225 FOLD) — defaults to skill (a skill run is unchanged).
  const kind = deps.kind ?? "skill";

  const docName = docNameForTopic(kind, topicKey);

  // 4a. Read the prior doc's structured AST (absent ⇒ a NEW doc — synthesize fresh, A6).
  const priorRes = await fromPromise(mentalModelStore.get(docName, scope));
  if (!priorRes.ok || !priorRes.value.ok) {
    logger.warn(
      {
        agentId,
        step: "reflect" as const,
        errorKind: "dependency" as const,
        topicKey,
        hint: "store.get faulted for the prior doc — topic skipped this run (no admit)",
      },
      "reflection: prior-doc read faulted, skipping topic",
    );
    return "skipped";
  }
  const prior = priorRes.value.value; // MentalModel | undefined
  const priorSections: DocSection[] = prior?.structuredBody?.sections ?? [];

  // 4b. ONE cheap LLM call per topic (the adapter wraps the UNTRUSTED transcript, INV-5).
  const reflectRes = await fromPromise(
    reflectionAdapter.reflect({ trajectoryText: groupText(members), currentSections: priorSections }),
  );
  if (!reflectRes.ok || !reflectRes.value.ok) {
    // A per-topic reflect fault (transport / model error). NON-FATAL: the topic is
    // skipped and the prior doc survives (the adapter already WARNed with the
    // network/dependency errorKind). Treated as empty-content (REFLECT-05): NO admit.
    logger.debug(
      { agentId, step: "reflect" as const, topicKey, hint: "reflect call faulted — topic skipped, prior doc survives (REFLECT-05)" },
      "reflection call faulted for topic, skipping",
    );
    return "empty";
  }
  const reflection = reflectRes.value.value;

  // 4c. Build the next structured body: delta-ops over the prior AST (existing doc)
  //     or the fresh section list (new doc).
  const nextBody = buildNextBody(prior?.structuredBody, reflection);

  // 5a. EMPTY-CONTENT GUARD (REFLECT-05) — the guard lives HERE, NOT the store (the
  //     store upsert overwrites `body` unconditionally on conflict, so the prior doc
  //     survives ONLY if we skip the admit CALL). An empty next body (no sections, or
  //     an existing-doc refresh that produced no change) is skipped, reason-coded.
  if (nextBody === undefined || nextBody.sections.length === 0) {
    logger.debug(
      { agentId, step: "admit" as const, topicKey, hint: "empty/no-change reflection — admit skipped, prior doc survives (REFLECT-05)" },
      "reflection produced no content, skipping admit",
    );
    return "empty";
  }

  const body = renderStructuredBody(nextBody);
  const description = deriveDescription(nextBody);

  // 5b. STATIC GUARD (REFLECT-06): validateLearnedDocBody is ALL the validation an
  //     advisory doc receives (INV-3) — a CRITICAL poison/secret in name/body/desc rejects.
  const validation = validateLearnedDocBody({ name: docName, body, description });
  if (!validation.ok) {
    // Phase 226 (the 225 WR-01 gap): distinguish a NAME-length over-cap rejection from a
    // poison/secret rejection so the funnel verdict reports the SPECIFIC reason instead of
    // mis-attributing it to `rejected_validation`. (docNameForTopic hashes an over-cap name,
    // so in the normal flow this never fires — but if a name-length finding ever occurs the
    // enum can now express it.) Content-free: the field NAME + pattern LABELS only.
    const nameLengthRejected = validation.findings.some(
      (f) => f.field === "name" && f.patterns.includes("name-too-long"),
    );
    logger.warn(
      {
        agentId,
        step: "admit" as const,
        errorKind: "validation" as const,
        topicKey,
        // Content-free: the rejected field names + pattern LABELS only (never the body).
        rejectedFields: validation.findings.map((f) => f.field),
        hint: nameLengthRejected
          ? "reflected doc NAME exceeded MAX_DOC_NAME_LENGTH — NOT admitted"
          : "reflected doc body failed the static poison/secret scan — NOT admitted",
      },
      "reflection doc rejected by validateLearnedDocBody",
    );
    return nameLengthRejected ? "rejected_name_length" : "rejected";
  }

  // 5c. WRITE. A profile/topic CORRECTION of an EXISTING doc routes through
  //     `supersede` (FOLD-01) — the bi-temporal history-append that preserves the prior
  //     body in `history` rather than the destructive `admit` upsert (which overwrites
  //     `body` + nulls `history` on conflict). A NEW doc (no prior) ALWAYS admits; a
  //     SKILL doc ALWAYS admits (byte-identical with 223 — skill never supersedes,
  //     even when `supersede` is wired). On a `not-found` supersede (the doc was
  //     evicted between the `get` and the supersede — a race) we FALL BACK to admit so
  //     the correction is never silently lost.
  const sourceTrajIds = members.map((m) => m.trajectoryId);
  const isExistingDoc = prior !== undefined;
  const supersede = mentalModelStore.supersede;
  if (kind !== "skill" && isExistingDoc && supersede !== undefined) {
    const supersedeRes = await fromPromise(supersede({ name: docName, body, structuredBody: nextBody }, scope, clock.now()));
    if (!supersedeRes.ok || !supersedeRes.value.ok) {
      logger.warn(
        { agentId, step: "admit" as const, errorKind: "dependency" as const, topicKey, hint: "store.supersede faulted — topic skipped (prior doc intact)" },
        "reflection supersede faulted, skipping topic",
      );
      return "skipped";
    }
    if (supersedeRes.value.value === "superseded") {
      // A profile/topic correction landed in history (the prior body preserved).
      return "admitted";
    }
    // "not-found": the scoped incumbent vanished between get and supersede — fall through
    // to admit so the reflected doc is still written (never lose the correction).
    logger.debug(
      { agentId, step: "admit" as const, topicKey, hint: "supersede found no incumbent (get→supersede race) — falling back to admit" },
      "reflection supersede not-found, admitting instead",
    );
  }

  // ADMIT at trust=learned / state=candidate (store-forced) / LOW proof_count /
  // deterministic id (idempotent re-admit, REFLECT-06). The NEW-doc path for every kind,
  // the skill path always, and the profile/topic supersede `not-found` fallback.
  const admitRes = await fromPromise(
    mentalModelStore.admit(
      {
        name: docName,
        description,
        body,
        structuredBody: nextBody,
        kind, // Phase 225 FOLD — the threaded doc family (skill default)
        topicKey,
        mutating: false, // advisory doc — never state-mutating (INV-3); read-only auto-surfaces
        proofCount: LOW_PROOF_COUNT, // INV-2 anti-domination cap, regardless of cardinality
        confidence: REFLECT_ADMISSION_CONFIDENCE,
        sourceTrajIds,
        createdAt: clock.now(),
      },
      scope,
    ),
  );
  if (!admitRes.ok || !admitRes.value.ok) {
    logger.warn(
      { agentId, step: "admit" as const, errorKind: "dependency" as const, topicKey, hint: "store.admit faulted — topic skipped" },
      "reflection admit faulted, skipping topic",
    );
    return "skipped";
  }
  // `admitted:false` (an idempotent re-admit of an unchanged doc) is not a NEW doc.
  return admitRes.value.value.admitted ? "admitted" : "skipped";
}

/**
 * Build the next structured body. An EXISTING doc (prior AST present) refreshes via
 * delta-ops (`applyDeltaOps` — untargeted sections byte-identical); an empty op list
 * is a no-op refresh ⇒ `undefined` (the guard skips the admit). A NEW doc takes the
 * fresh section list. A reflection carrying NEITHER usable shape ⇒ `undefined`.
 */
function buildNextBody(prior: StructuredBody | undefined, reflection: { ops?: DeltaOp[]; sections?: DocSection[] }): StructuredBody | undefined {
  if (prior !== undefined && prior.sections.length > 0) {
    // Existing doc → delta-ops refresh. An empty/absent op list is a no-op (no change).
    if (!reflection.ops || reflection.ops.length === 0) return undefined;
    return applyDeltaOps(prior, reflection.ops);
  }
  // New doc → fresh section list.
  if (reflection.sections && reflection.sections.length > 0) {
    return { sections: reflection.sections };
  }
  return undefined;
}

/** Derive the doc description from its first section (the "Use when…" trigger). Content from the doc itself. */
function deriveDescription(body: StructuredBody): string {
  const first = body.sections[0];
  if (!first) return "Learned advisory doc.";
  // The first section's body (trimmed to a sane length) — the trigger sentence.
  const text = first.body.trim();
  return text.length > 0 ? text.slice(0, 200) : first.heading;
}

/** Emit the once-per-run INFO summary line (the RC-4 grep-able "why 0 admitted" verdict). */
function logRunComplete(
  deps: RunReflectionDeps,
  startMs: number,
  counts: {
    selected: number;
    admitted: number;
    maxTopicCardinality: number;
    skipped: number;
    emptyReflections: number;
    untrustedDrops: number;
    nameLengthRejections: number;
  },
): void {
  const admissionOutcome = classifyReflectOutcome({
    selected: counts.selected,
    maxTopicCardinality: counts.maxTopicCardinality,
    admitted: counts.admitted,
    emptyReflections: counts.emptyReflections,
    untrustedDrops: counts.untrustedDrops,
    nameLengthRejections: counts.nameLengthRejections,
  });
  deps.logger.info(
    {
      agentId: deps.agentId,
      submodule: "reflection-job",
      selected: counts.selected,
      admitted: counts.admitted,
      maxTopicCardinality: counts.maxTopicCardinality,
      skipped: counts.skipped,
      admissionOutcome, // RC-4: the readable "why 0 admitted" verdict, grep-able in the log
      durationMs: deps.clock.now() - startMs,
    },
    "reflection run complete",
  );
}
