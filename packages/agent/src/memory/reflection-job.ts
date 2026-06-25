// SPDX-License-Identifier: Apache-2.0
/**
 * The reflection engine (v2.31 Reflection, Phase 223, REFLECT-01/03/04/05/06) —
 * the ONE outcome-gated job that REPLACES the dead embedding-clustering
 * `runSkillSynthesis`. It runs as an offline cron (wired daemon-side, Plan 05 —
 * NOT the hot path). One pass over the injected source trajectories:
 *
 *  1. **SELECT** (fail-closed, REFLECT-01 / INV-5): for each source,
 *     `OutcomeSignalPort.resolve`; keep ONLY `outcome === "success" && confidence
 *     >= minConfidence` AND `source.trustedOrigin` (INV-5/D-04 — an untrusted-origin
 *     success NEVER seeds a doc; the daemon derives trust, Research A2). An
 *     unresolved outcome is fail-closed `continue`.
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

import { ok, fromPromise, type Result } from "@comis/shared";
import type {
  LearningScope,
  MentalModelStorePort,
  OutcomeSignalPort,
  StructuredBody,
  DocSection,
  DeltaOp,
} from "@comis/core";
import { validateLearnedDocBody } from "@comis/core";
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
  /** INV-5/D-04: false ⇒ this success NEVER seeds a doc (daemon-derived trust). */
  trustedOrigin: boolean;
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
  config: RunReflectionConfig;
  /** The LCD-merged source history the daemon injects (with the daemon-derived trustedOrigin). */
  sourceTrajectories: ReflectionSourceTrajectory[];
  /** The cheap-model reflect adapter (wraps the untrusted trajectory; ONE call per topic). */
  reflectionAdapter: Pick<ReflectionAdapter, "reflect">;
  /** The outcome-signal port (the fail-closed success gate). */
  outcomeSignal: Pick<OutcomeSignalPort, "resolve">;
  /** The mental-model store (injected from @comis/memory, Plan 05). */
  mentalModelStore: Pick<MentalModelStorePort, "get" | "admit">;
  /** Wall-clock reads — durations + the admit timestamp. NEVER a wall-clock global. */
  clock: { now: () => number };
  /** Counts/ids-only event bus (the daemon emits the learning:skill_* events, Plan 05). */
  eventBus: { emit(event: string, payload: unknown): void };
  logger: RunReflectionJobLogger;
}

/**
 * The ACUTE reason a reflection run admitted nothing (or did) — a closed,
 * content-free enum so "why didn't a doc get learned?" is ONE readable field on
 * the funnel (the RC-4 diagnosability the synthesis-job established; the full
 * `reflectOutcome` rename is Phase 226). First-match-wins, computed from the
 * funnel counts:
 * - `no_successes`         — no trusted-origin `success`-outcome cleared SELECT.
 * - `uncorroborated`       — topics grouped but `maxTopicCardinality < 2` (the
 *                            anti-domination gate: needs ≥2 distinct (session,sender)).
 * - `empty_reflection`     — a corroborated topic reflected empty/failed (the
 *                            REFLECT-05 guard skipped the admit; the prior doc survives).
 * - `rejected_validation`  — a reflected body failed `validateLearnedDocBody`
 *                            (a poison/secret body rejected before durable storage).
 * - `admitted`             — ≥1 doc admitted.
 */
export type ReflectAdmissionOutcome =
  | "admitted"
  | "uncorroborated"
  | "rejected_validation"
  | "empty_reflection"
  | "no_successes";

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
}

// ---------------------------------------------------------------------------
// Anti-domination cardinality (copied VERBATIM from skill-synthesis-job.ts)
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
}): ReflectAdmissionOutcome {
  if (f.admitted > 0) return "admitted";
  if (f.selected === 0) return "no_successes";
  if (f.maxTopicCardinality < 2) return "uncorroborated";
  if (f.emptyReflections > 0) return "empty_reflection";
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
 */
function docNameForTopic(topicKey: string): string {
  return `skill-${topicKey.slice(0, 16)}`;
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
  const { agentId, scope, config, sourceTrajectories, reflectionAdapter, outcomeSignal, mentalModelStore, clock, logger } =
    deps;

  const startMs = clock.now();
  const maxDocsPerRun = config.maxDocsPerRun ?? DEFAULT_MAX_DOCS_PER_RUN;

  // 1. SELECT (fail-closed): keep only trusted-origin `success` >= minConfidence.
  const selected: ReflectionSourceTrajectory[] = [];
  for (const t of sourceTrajectories) {
    // INV-5/D-04: an untrusted-origin success NEVER seeds a doc. Filter FIRST (cheap,
    // before the outcome resolve) — a planted/untrusted trajectory cannot even reach
    // the corroboration gate.
    if (!t.trustedOrigin) {
      logger.debug(
        {
          agentId,
          step: "select" as const,
          trajectoryId: t.trajectoryId,
          errorKind: "precondition" as const,
          hint: "untrusted-origin success — never seeds a doc (INV-5/D-04), skipped",
        },
        "reflection: untrusted-origin trajectory skipped",
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

  if (selected.length === 0) {
    logRunComplete(deps, startMs, { selected: 0, admitted: 0, maxTopicCardinality: 0, skipped: 0, emptyReflections: 0 });
    return ok({ admissionOutcome: "no_successes", selected: 0, admitted: 0, maxTopicCardinality: 0, skipped: 0 });
  }

  // 2. GROUP (replaces clusterSuccesses): Map<topicKey, members[]> via the deterministic key.
  const groups = new Map<string, ReflectionSourceTrajectory[]>();
  for (const t of selected) {
    const key = normalizeOpeningRequest(t.signature);
    if (key === "") continue; // ungroupable signature — never corroborates (a singleton)
    const members = groups.get(key);
    if (members) members.push(t);
    else groups.set(key, [t]);
  }

  // 3. GATE + 4. REFLECT + 5. GUARD/ADMIT. Bound by maxDocsPerRun.
  let admitted = 0;
  let skipped = 0;
  let emptyReflections = 0;
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
    } else if (r === "admitted") {
      admitted += 1;
    }
    // "skipped" (a per-topic reflect/admit fault) increments neither admit nor empty.
  }

  const admissionOutcome = classifyReflectOutcome({ selected: selected.length, maxTopicCardinality, admitted, emptyReflections });

  logRunComplete(deps, startMs, { selected: selected.length, admitted, maxTopicCardinality, skipped, emptyReflections });

  return ok({ admissionOutcome, selected: selected.length, admitted, maxTopicCardinality, skipped });
}

// ---------------------------------------------------------------------------
// Per-topic reflect + guard + admit
// ---------------------------------------------------------------------------

type TopicOutcome = "admitted" | "empty" | "rejected" | "skipped";

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

  const docName = docNameForTopic(topicKey);

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
    logger.warn(
      {
        agentId,
        step: "admit" as const,
        errorKind: "validation" as const,
        topicKey,
        // Content-free: the rejected field names + pattern LABELS only (never the body).
        rejectedFields: validation.findings.map((f) => f.field),
        hint: "reflected doc body failed the static poison/secret scan — NOT admitted",
      },
      "reflection doc rejected by validateLearnedDocBody",
    );
    return "rejected";
  }

  // 5c. ADMIT at trust=learned / state=candidate (store-forced) / LOW proof_count /
  //     deterministic id (idempotent re-admit, REFLECT-06).
  const sourceTrajIds = members.map((m) => m.trajectoryId);
  const admitRes = await fromPromise(
    mentalModelStore.admit(
      {
        name: docName,
        description,
        body,
        structuredBody: nextBody,
        kind: "skill",
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
  counts: { selected: number; admitted: number; maxTopicCardinality: number; skipped: number; emptyReflections: number },
): void {
  const admissionOutcome = classifyReflectOutcome({
    selected: counts.selected,
    maxTopicCardinality: counts.maxTopicCardinality,
    admitted: counts.admitted,
    emptyReflections: counts.emptyReflections,
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
