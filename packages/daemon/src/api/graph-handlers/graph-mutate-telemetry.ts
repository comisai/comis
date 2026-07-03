// SPDX-License-Identifier: Apache-2.0
/**
 * Graph-mutate authoring telemetry/audit helpers.
 *
 * The best-effort, counts-only telemetry + audit emitters and the server-side
 * tier/repair-context derivations consumed by the write-side graph handlers
 * (graph-mutate.ts). Extracted to keep graph-mutate.ts under the graph-handlers/
 * 500-line cap (§2.8 shrink-only) — behavior is byte-identical to the prior
 * inline closures.
 *
 * `createGraphMutateTelemetry(deps)` returns the closures over the injected
 * GraphHandlerDeps; graph-mutate.ts calls it once at bind time and destructures
 * the helpers.
 *
 * @module
 */

import { systemNowMs } from "@comis/core";
import type { GraphHandlerDeps, BuildGraphRepairContext } from "./graph-helpers.js";

/** The closed set of canonical from_intent patterns (mirrors the synthesizer). */
export const SYNTH_PATTERNS = ["research-fanout", "debate", "vote", "map-reduce"] as const;
export type SynthPattern = (typeof SYNTH_PATTERNS)[number];
export const isSynthPattern = (v: string): v is SynthPattern =>
  (SYNTH_PATTERNS as readonly string[]).includes(v);

/** The authoring telemetry/audit helpers bound over GraphHandlerDeps. */
export interface GraphMutateTelemetry {
  /** Emit a counts-only `pipeline:authored` per authoring invocation. */
  emitPipelineAuthored: (
    action: "define" | "execute",
    schemaValid: boolean,
    rawParams: Record<string, unknown>,
  ) => void;
  /** Resolve the calling agent's tier SERVER-SIDE, gated on repairProducer. */
  resolveAuthoringTier: (
    d: GraphHandlerDeps,
    rawParams: Record<string, unknown>,
  ) => "frontier" | "mid" | "small" | "nano" | undefined;
  /** Assemble the repair context buildGraphInput needs for the gated branch. */
  repairContext: (
    d: GraphHandlerDeps,
    rawParams: Record<string, unknown>,
  ) => BuildGraphRepairContext;
  /** Best-effort audit emit for a from_intent synthesis. */
  emitGraphSynthesized: (
    pattern: SynthPattern,
    nodeCount: number,
    rawParams: Record<string, unknown>,
  ) => void;
}

/**
 * Build the authoring telemetry/audit helpers over the injected deps. The
 * emitters are best-effort (try/catch guarded) — telemetry can never break the
 * operation it measures.
 */
export function createGraphMutateTelemetry(deps: GraphHandlerDeps): GraphMutateTelemetry {
  // Emit a counts-only `pipeline:authored` per authoring invocation (define +
  // execute), where schema validity and the resolved capabilityClass tier
  // converge. Counts/ids/closed-enums ONLY — no node task, type_config value,
  // label, or any pipeline body reaches the bus (§2.7). The tier is resolved
  // DAEMON-SIDE from the RAW _agentId (spoofing mitigation) via the injected
  // resolver — never a tool-supplied param — and fail-safes to "unknown" when
  // unresolvable (record honestly, never silently drop, never default to
  // "frontier"). `repaired` is the literal false: the weak-model repair
  // producer is a separate path (see graph-repair.ts) and is NOT wired here.
  //
  // METRIC DENOMINATOR: an authoring invocation is
  // counted on every CONTRACT-PARSE-REACHABLE path — graph.define emits on a
  // strict-contract parse rejection AND a buildGraphInput throw; graph.execute
  // (a loose z.record contract) emits on the buildGraphInput throw. The bespoke
  // pre-Zod guards (define's "Missing required parameter: nodes" empty-call
  // check, execute's a2a-disabled policy gate) emit NOTHING — an empty/garbage
  // call or a policy rejection is not an authoring attempt. This boundary is
  // deliberate (documented in fleet-findings.ts's pipeline_authoring finding +
  // docs/developer-guide/event-bus.mdx).
  const emitPipelineAuthored = (
    action: "define" | "execute",
    schemaValid: boolean,
    rawParams: Record<string, unknown>,
  ): void => {
    // The emit MUST be best-effort — telemetry can
    // never break the operation it measures. `deps.eventBus.emit` delegates to
    // Node's EventEmitter with NO listener error isolation, and the subscribed
    // `pipeline:authored` listener pushes into the obs diagnostic buffer whose
    // synchronous SQLite flush (on its 50th item) can throw SQLITE_BUSY/FULL/
    // disk-error. On the SUCCESS path this emit is called OUTSIDE the handler's
    // buildGraphInput try (and, for graph.execute, BEFORE graphCoordinator.run),
    // so an unguarded throw here would fail a VALID graph.define/execute purely
    // because a telemetry insert failed — and on the invalid path it would mask
    // the user-facing graph-validation error. Swallow any emit throw and log it
    // at WARN (hint + errorKind) so the measured operation always proceeds.
    try {
      const capabilityClass =
        deps.resolveCapabilityClass?.(rawParams._agentId as string | undefined) ?? "unknown";
      deps.eventBus?.emit("pipeline:authored", {
        action,
        capabilityClass,
        schemaValid,
        repaired: false,
        agentId: rawParams._agentId as string | undefined,
        sessionKey: rawParams._callerSessionKey as string | undefined,
        timestamp: systemNowMs(),
      });
    } catch (err) {
      deps.logger?.warn(
        {
          err,
          action,
          errorKind: "internal" as const,
          hint: "pipeline:authored telemetry emit failed (likely an obs-buffer SQLite flush throw); the graph operation proceeds unaffected",
        },
        "pipeline-authoring telemetry emit failed (best-effort)",
      );
    }
  };

  // Resolve the calling agent's capabilityClass tier for the buildGraphInput
  // repair decision, GATED on repairProducer. When the gate is off (or absent)
  // this returns undefined so buildGraphInput takes the capable direct path —
  // byte-identical to the ungated behavior. The tier is resolved SERVER-SIDE
  // from the RAW _agentId (spoofing mitigation), reusing the injected
  // resolveCapabilityClass — the tool-supplied capabilityClass param is NEVER
  // read for the tier.
  const resolveAuthoringTier = (
    d: GraphHandlerDeps,
    rawParams: Record<string, unknown>,
  ): "frontier" | "mid" | "small" | "nano" | undefined =>
    d.authoringConfig?.repairProducer
      ? d.resolveCapabilityClass?.(rawParams._agentId as string | undefined)
      : undefined;

  // Assemble the repair context buildGraphInput needs for the gated
  // weak-model branch (the injected matcher + gate + best-effort emit inputs).
  // Correlation ids ride from the RAW params (envelope-only — never body).
  const repairContext = (
    d: GraphHandlerDeps,
    rawParams: Record<string, unknown>,
  ): BuildGraphRepairContext => ({
    authoringConfig: d.authoringConfig,
    repairMatch: d.repairMatch,
    eventBus: d.eventBus,
    logger: d.logger,
    agentId: rawParams._agentId as string | undefined,
    sessionKey: rawParams._callerSessionKey as string | undefined,
  });

  // Best-effort audit emit for a from_intent synthesis
  // (mirrors emitPipelineAuthored's guard — telemetry never breaks the
  // measured op). Counts/ids/closed-enums ONLY (pattern + GOVERNED node count +
  // correlation ids; NEVER the graph body / node task / one-line intent — §2.7).
  // Called AFTER buildGraphInput + validateTypeConfigs, so it reflects a GOVERNED graph.
  const emitGraphSynthesized = (
    pattern: SynthPattern,
    nodeCount: number,
    rawParams: Record<string, unknown>,
  ): void => {
    try {
      deps.eventBus?.emit("graph:synthesized_from_intent", {
        pattern,
        nodeCount,
        agentId: rawParams._agentId as string | undefined,
        sessionKey: rawParams._callerSessionKey as string | undefined,
        timestamp: systemNowMs(),
      });
    } catch (err) {
      deps.logger?.warn(
        {
          err,
          pattern,
          errorKind: "internal" as const,
          hint: "graph:synthesized_from_intent audit emit failed (likely an obs-buffer SQLite flush throw); the synthesized graph proceeds unaffected",
        },
        "from-intent synthesis audit emit failed (best-effort)",
      );
    }
  };

  return { emitPipelineAuthored, resolveAuthoringTier, repairContext, emitGraphSynthesized };
}
