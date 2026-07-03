// SPDX-License-Identifier: Apache-2.0
/**
 * LearningEvents: verified-learning write-back + telemetry events.
 *
 * Composed into `EventMap` (events.ts) as a sibling of `AgentEvents` — the
 * dedicated file keeps `events-agent.ts` under its 799-line cap (the
 * `learning:skill_*` telemetry keys live on THIS same interface, not events-agent).
 *
 * Closed-graph discipline (the agent↛memory cut): the AGENT emits these
 * events; the DAEMON write-back subscriber does the memory store write. Mirrors
 * the `memory:recall_used → setup-memory-usefulness-wiring.ts → recordUsage`
 * precedent — the agent never imports `@comis/memory`.
 *
 * Counts/ids/closed-scalars ONLY — never bodies, procedure content, or query
 * text crosses the bus (§2.7, the whole memory: / learning: event family).
 * Adding a content-bearing field is a compile error by design (proven by an
 * `@ts-expect-error` test in events-learning.test.ts).
 *
 * Find events by prefix: memory:skill_*.
 */

/**
 * The CLOSED set of acute reasons a reflection run admitted nothing (or did) —
 * the content-free verdict carried on `reflect:funnel.admissionOutcome`.
 *
 * Canonical HERE in `@comis/core`: the event payload that uses it lives in
 * this file, and `@comis/agent` cannot be imported by core (the agent→core direction
 * only). `@comis/agent`'s reflection-job re-exports THIS type and its
 * `classifyReflectOutcome` returns it, so the daemon emit (which assigns the value)
 * and this event contract share one closed union — a free-form string assigned into
 * the funnel field is a compile error, not a silent contract drift.
 *
 * Precedence/meaning is documented at the reflection classifier
 * (`@comis/agent` reflection-job.ts `classifyReflectOutcome`):
 *  `admitted` / `untrusted_origin` / `no_successes` / `uncorroborated` /
 *  `empty_reflection` / `rejected_name_length` / `rejected_validation`.
 */
export type ReflectAdmissionOutcome =
  | "admitted"
  | "uncorroborated"
  | "rejected_validation"
  | "rejected_name_length"
  | "untrusted_origin"
  | "empty_reflection"
  | "no_successes";

export interface LearningEvents {
  /**
   * Skill-use attribution complete for one turn. MINIMAL payload —
   * the per-turn used-skill ids + count ONLY, NEVER procedure bodies, the agent
   * response, or the read path. The bridge attributes a `read` whose path
   * matches a frozen learned-skill `<location>` to a skill and
   * accumulates the ids in a per-turn carrier; `postExecution` emits this event
   * with those ids. Emit site: `postExecution` (executor-post-execution.ts),
   * gated on a non-empty `usedSkillIds` (absent/empty ⇒ no emit).
   * The daemon subscriber (setup-learning.ts) threads
   * `usedSkillIds` into `observe()` → the `used_skill_ids` column. Mirrors the
   * counts/ids-only `memory:recall_used`. Trajectory-bridged → `memory.skill_used`,
   * so `explain.learning.skillsUsed`
   * surfaces the inline-credited ids without a DB hand-join.
   */
  "memory:skill_used": {
    agentId: string;
    sessionKey?: string;
    traceId: string;
    /** Opaque learned-skill ids (skillNames) attributed as USED this turn —
     *  ids only, never procedure bodies. */
    usedSkillIds: string[];
    /** == usedSkillIds.length (parity with the counts-only family). */
    usedCount: number;
    timestamp: number;
  };

  /**
   * The full per-turn topic-match reuse-attribution CENSUS.
   * `memory:skill_used` fires only when ≥1 skill is CREDITED, so a
   * surfaced skill that JUST missed the bar (coverage under threshold, or below the absolute
   * floor) or a doc with no topicTokens left NO signal — "why wasn't my skill reused?"
   * needed a debugger. Emitted per turn when ≥1 learned skill is surfaced for topic-match, with a
   * content-free score per surfaced skill (the NAME is an opaque id; the rest are numbers — never
   * a procedure body). Bridged to the `memory.skill_surfaced` trajectory record; folded into
   * `explain.learning.skillsSurfacedButUncredited` so the near-miss is diagnosable in one call.
   */
  "memory:skill_surfaced": {
    agentId: string;
    sessionKey?: string;
    traceId: string;
    /** Learned skills surfaced (recall + standing block) and scored for topic-match reuse this turn. */
    surfacedCount: number;
    /** How many of them this turn CREDITED (== the usedSkillIds the topic-match leg contributes). */
    creditedCount: number;
    /** Per-surfaced-skill score — content-free (name is an id; coverage/sharedCount are numbers). */
    scores: Array<{ name: string; coverage: number; sharedCount: number; credited: boolean; hasTopicTokens: boolean }>;
    timestamp: number;
  };

  /**
   * A reflection run admitted N candidate
   * docs. Emitted DAEMON-SIDE (plain `eventBus.emit`, never `?.`) by the reflection
   * cron handler (setup-channels-memory-crons-wire.ts) AFTER `runReflection` returns
   * — the daemon emit (not the agent job) keeps the trajectory-bridge entry landing
   * with the emit (no agent-side gate trip). The `reflect:*` prefix covers the
   * reflection funnel only — the forget/outcome events carry `learning:*` names.
   * COUNT ONLY — the reflected doc body is
   * a compile error here (the §2.7 counts-only firewall). Bridged
   * (TRAJECTORY_BRIDGE_MAPPING) for `comis explain`.
   */
  "reflect:admitted": {
    agentId: string;
    /** How many candidate docs were admitted this run (count only). */
    count: number;
    timestamp: number;
  };

  /**
   * The reflection-run FUNNEL — counts ONLY,
   * emitted DAEMON-SIDE alongside `reflect:admitted` after `runReflection` returns (the
   * reflection cron wire maps the reflect result onto these fields). Where
   * `reflect:admitted.count` is only the ADMITTED tail, this carries the whole funnel so
   * `comis explain` answers "why didn't a doc get learned" WITHOUT a DEBUG-log grep — the
   * load-bearing field is `maxClusterCardinality` (the distinct (session,sender)
   * corroboration size; a value of 1 = a single uncorroborated instance, so admission
   * CORRECTLY refused; the same conservatism that defeats poisoning).
   * COUNT ONLY — a reflected doc
   * body is a compile error here (the §2.7 counts-only firewall). Bridged
   * (TRAJECTORY_BRIDGE_MAPPING) for `comis explain`.
   */
  "reflect:funnel": {
    agentId: string;
    /** Trusted-origin success trajectories that entered reflection this run (count only; == reflect `selected`). */
    synthesized: number;
    /** Reflected docs that cleared the static validateLearnedDocBody guard + admit (count only). */
    validated: number;
    /** Docs admitted to the store (trust=learned) this run (count only). */
    admitted: number;
    /** The largest distinct (session,sender) corroboration size (1 = single instance → not admissible). */
    maxClusterCardinality: number;
    /**
     * How many DISTINCT topicKey groups the selected sources formed — the under-merge
     * DISCRIMINATOR. `synthesized:2, distinctTopicKeys:2, maxClusterCardinality:1` = 2 successes that
     * landed on 2 SEPARATE topics (under-merge), vs `distinctTopicKeys:1, maxClusterCardinality:2` =
     * genuinely corroborated. Answers "admitted=0 DESPITE corroboration?" from ONE field. Content-free
     * (a count, like `maxClusterCardinality`).
     */
    distinctTopicKeys: number;
    /**
     * Success sources DROPPED at SELECT for an untrusted origin / external-trust source (count only).
     * The MAGNITUDE behind an `untrusted_origin` verdict — the enum says WHICH, this says HOW MANY, so
     * `comis explain` answers "is untrusted-origin a one-off or systematic" without a daemon.log grep.
     * Content-free (a count, like `admitted`).
     */
    untrustedDrops: number;
    /** Corroborated topics whose reflected doc NAME exceeded MAX_DOC_NAME_LENGTH (count only — never the name). */
    nameLengthRejections: number;
    /** Corroborated topics SKIPPED (empty reflection or rejected validation) — count only. */
    skipped: number;
    /**
     * The count of source trajectories that ENTERED this run (pre-SELECT input). Paired with
     * `totalSourceChars` it distinguishes "no sources were built" (count 0 → a wiring gap) from
     * "sources existed but were dropped/uncorroborated". Content-free (a count).
     */
    sourceTrajectoryCount: number;
    /**
     * Total characters of the SELECTED source transcripts fed to the reflect call (count only,
     * never the text). The empty-vs-real discriminator: a non-trivial `totalSourceChars` with a junk/
     * generic admitted doc is an LLM-yield issue, NOT an empty-source wiring bug — answers it from
     * `comis explain` instead of tracing buildSourceTrajectories→getMessages→partsToMessage by hand.
     */
    totalSourceChars: number;
    /**
     * The acute reason this run admitted nothing (or `admitted`) — a content-free
     * closed enum so `comis explain` answers "why was 0 admitted" from ONE field. The
     * reflect verdict (classifyReflectOutcome): `no_successes` (no trusted-origin success
     * cleared SELECT) / `untrusted_origin` (all successes dropped at SELECT for an
     * untrusted origin / external-trust source) / `uncorroborated` (cardinality<2) /
     * `empty_reflection` / `rejected_name_length` (doc name over MAX_DOC_NAME_LENGTH) /
     * `rejected_validation` / `admitted`.
     *
     * Typed to the CLOSED {@link ReflectAdmissionOutcome} union so
     * the closed-enum contract is type-enforced — a free-form string into the funnel field
     * is a compile error, not a silent contract drift.
     */
    admissionOutcome: ReflectAdmissionOutcome;
    timestamp: number;
  };

  /**
   * An attributed successful reuse promoted N candidate skills this
   * resolve (candidate→active past promoteAtProofCount). Emitted DAEMON-SIDE
   * (setup-learning.ts) — counts ONLY, never a procedure body/script/id-list.
   * Bridged for comis explain.
   */
  "learning:skill_promoted": {
    agentId: string;
    /** How many candidate skills were promoted to active this resolve (count only). */
    count: number;
    timestamp: number;
  };

  /**
   * A corroboration-gated decay-aware-trend WEAKENING demoted N skills
   * this resolve (active→stale→archived). Emitted DAEMON-SIDE.
   *
   * Carries the demoted skill NAMES + the
   * trigger trajectory id alongside the count, so `explain` answers "WHICH skill demoted and WHY"
   * in one call (a count-only payload — "2 demoted" with no name — would force a daemon.log +
   * mental_models hand-join). Content-free: skill NAMES are the same opaque id-class as
   * `skill.prompt_invoked.skillName`
   * + a trajectory id — never a procedure body/script.
   */
  "learning:skill_demoted": {
    agentId: string;
    /** How many skills were demoted (active→stale→archived) this resolve (count only). */
    count: number;
    /** The demoted skill NAMES (id-class; == count entries). */
    demotedSkillNames?: string[];
    /** The trajectory whose failure/correction outcome drove this demote (the WHY). */
    triggerTrajectoryId?: string;
    timestamp: number;
  };

  /**
   * Correction-driven demote: a user CORRECTION was observed as a soft-failure of a
   * PRIOR trajectory (the correction reader, setup-learning-reactions.ts). Carried INTERNALLY on the
   * daemon bus (NOT bridged to the trajectory — the resulting demote already emits
   * `learning:skill_demoted`) so `wireLearningOutcome` (which owns the gated skill-transition + its
   * corroboration/trend state) can RE-RUN the skill transition for that trajectory's credited skills
   * with a `corrected` verdict → a corroborated correction flips the wrong skill active/candidate→stale
   * (kept, not deleted). Content-free: ids + a confidence scalar ONLY, never a body.
   */
  "learning:correction_observed": {
    agentId: string;
    tenantId: string;
    sessionId: string;
    /** The PRIOR trajectory the correction soft-failed (the verdict turn whose skill should demote). */
    trajectoryId: string;
    /** The capped correction confidence (the soft-failure reward). */
    confidence: number;
    timestamp: number;
  };

  // Deliberately absent: there is no sandbox-validation, user-rep-revision, or
  // consolidation-generalization telemetry event — those paths are handled by the
  // reflection engine, so such keys would have zero emitters. A guard test
  // (events-learning.test.ts) pins that they stay out of this interface.
}
