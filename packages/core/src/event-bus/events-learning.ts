// SPDX-License-Identifier: Apache-2.0
/**
 * LearningEvents: verified-learning (v2.26) write-back + telemetry events.
 *
 * Composed into `EventMap` (events.ts) as a sibling of `AgentEvents` — the
 * dedicated file keeps `events-agent.ts` under its 799-line cap (Plan 07 adds
 * its `learning:skill_*` telemetry keys to THIS same interface, not events-agent).
 *
 * Closed-graph discipline (the agent↛memory cut, SEC-01): the AGENT emits these
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
export interface LearningEvents {
  /**
   * ATTR-02: skill-use attribution complete for one turn. MINIMAL payload —
   * the per-turn used-skill ids + count ONLY, NEVER procedure bodies, the agent
   * response, or the read path. The bridge attributes a `read` whose path
   * matches a frozen learned-skill `<location>` to a skill (ATTR-01) and
   * accumulates the ids in a per-turn carrier; `postExecution` emits this event
   * with those ids. Emit site: `postExecution` (executor-post-execution.ts),
   * gated on a non-empty `usedSkillIds` (absent/empty ⇒ no emit, byte-identical
   * to pre-patch). The daemon subscriber (setup-learning.ts, Plan 07) threads
   * `usedSkillIds` into `observe()` → the `used_skill_ids` column. Mirrors the
   * counts/ids-only `memory:recall_used`; NOT trajectory-bridged (it joins
   * EVENTS_NOT_TRAJECTORY_MAPPED).
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
   * SKILL-09: a reflection run admitted N candidate skill docs. Emitted
   * DAEMON-SIDE (plain `eventBus.emit`, never `?.`) by the reflection cron
   * handler (setup-channels-memory-crons-wire.ts) AFTER `runReflection`
   * returns — the daemon emit (not the agent job) keeps the trajectory-bridge entry
   * landing with the emit (no agent-side gate trip). The `skill_synthesized` event
   * NAME is kept (the `reflect:*` rename is Phase 226). COUNT ONLY — the reflected
   * doc body content is a compile error here (the §2.7 / SEC-01 firewall). Bridged
   * (TRAJECTORY_BRIDGE_MAPPING) for `comis explain` / OBS-02.
   */
  "learning:skill_synthesized": {
    agentId: string;
    /** How many candidate skills were admitted this run (count only). */
    count: number;
    timestamp: number;
  };

  /**
   * OBS (hermes-usecases obs-loop 2026-06-25): the reflection-run FUNNEL — counts
   * ONLY, emitted DAEMON-SIDE alongside `learning:skill_synthesized` after
   * `runReflection` returns (the reflection cron wire maps the reflect result onto
   * these fields). Where `skill_synthesized.count` is only the ADMITTED tail, this
   * carries the whole funnel so `comis explain` answers "why didn't a skill get
   * learned" WITHOUT a DEBUG-log grep — the load-bearing field is
   * `maxClusterCardinality` (the distinct (session,sender) corroboration size; a
   * value of 1 = a single uncorroborated instance, so admission CORRECTLY refused;
   * the same conservatism that defeats skill-poisoning). The `skill_synthesis_funnel`
   * event NAME is kept (the `reflect:*` rename is Phase 226). COUNT ONLY — a reflected
   * doc body is a compile error here (the §2.7 / SEC-01 firewall). Bridged
   * (TRAJECTORY_BRIDGE_MAPPING) for `comis explain`.
   */
  "learning:skill_synthesis_funnel": {
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
     * RC-4: the acute reason this run admitted nothing (or `admitted`) — a content-free
     * closed enum so `comis explain` answers "why was 0 admitted" from ONE field. The
     * reflect verdict (classifyReflectOutcome): `no_successes` (no trusted-origin success
     * cleared SELECT) / `uncorroborated` (cardinality<2) / `empty_reflection` /
     * `rejected_validation` / `admitted`.
     */
    admissionOutcome: string;
    timestamp: number;
  };

  /**
   * SKILL-09: a synthesized candidate cleared (or failed) validation. Emitted
   * DAEMON-SIDE after the validation adapter returns. The static/dynamic verdict
   * BOOLEANS + the `coverage` CLOSED-ENUM ONLY — never the offending field name, a
   * finding body, or a script (the SEC-01 firewall; a body/scripts field is a
   * compile error). `coverage:'static-only'` means the dynamic sandbox replay did
   * NOT run (no bwrap jail / a script-free candidate); `'full'` means a jailed
   * script executed. Bridged for `comis explain` / OBS-02.
   */
  "learning:skill_validated": {
    agentId: string;
    /** The per-field static memory-poison scan passed (no CRITICAL field). */
    staticOk: boolean;
    /** The sandbox replay ran AND every embedded script exited 0 (false when static-only). */
    dynamicOk: boolean;
    /** Whether a real jail ran the dynamic replay (closed enum). */
    coverage: "full" | "static-only";
    timestamp: number;
  };

  /**
   * SURFACE-06: an attributed successful reuse promoted N candidate skills this
   * resolve (candidate→active past promoteAtProofCount). Emitted DAEMON-SIDE
   * (setup-learning.ts, Plan 05) — counts ONLY, never a procedure body/script/id-list.
   * Bridged for comis explain / OBS-02.
   */
  "learning:skill_promoted": {
    agentId: string;
    /** How many candidate skills were promoted to active this resolve (count only). */
    count: number;
    timestamp: number;
  };

  /**
   * SURFACE-06: a corroboration-gated decay-aware-trend WEAKENING demoted N skills
   * this resolve (active→stale→archived). Emitted DAEMON-SIDE — counts ONLY.
   */
  "learning:skill_demoted": {
    agentId: string;
    /** How many skills were demoted (active→stale→archived) this resolve (count only). */
    count: number;
    timestamp: number;
  };

  /**
   * REVISE-01 (v2.26 Phase 203): the user-model revision run soft-closed `superseded`
   * incumbents (higher/equal-trust contradiction), bumped `corroborated` confidences,
   * and `inserted` new current-truth entries. Emitted DAEMON-SIDE (setup-channels-memory-crons.ts,
   * Plan 05) — counts ONLY, never a profile entry's content/entry_type/id.
   */
  "learning:user_model_revised": {
    agentId: string;
    /** Incumbent profile entries soft-closed by a higher/equal-trust contradiction (count only). */
    superseded: number;
    /** Candidates that corroborated an incumbent — confidence bumped, no new row (count only). */
    corroborated: number;
    /** New entries inserted (no incumbent in that belief slot) (count only). */
    inserted: number;
    durationMs: number;
    timestamp: number;
  };

  /**
   * GENERAL-01 (v2.26 Phase 203): the consolidation generalization pass created `generalized`
   * higher-order semantic memories from `clustersConsidered` diversity-passing clusters.
   * Emitted DAEMON-SIDE — counts ONLY, never the synthesized content or source ids.
   */
  "learning:memory_generalized": {
    agentId: string;
    /** Higher-order semantic memories created this run (count only). */
    generalized: number;
    /** Clusters that met the diversity threshold and were considered (count only). */
    clustersConsidered: number;
    durationMs: number;
    timestamp: number;
  };
}
