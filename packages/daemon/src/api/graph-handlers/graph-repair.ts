// SPDX-License-Identifier: Apache-2.0
// @allow-throw: RPC handler module — all throws are caught and converted to JSON-RPC error responses by rpc-dispatch.ts:306-321.
/**
 * Graph repair (AUTHOR-01, Phase 174-03).
 *
 * The conservative, gated, deterministic weak-model repair branch extracted out
 * of `graph-helpers.ts` (DEFER-174-FILESIZE-01 — a §2.8 shrink-only refactor to
 * keep the graph-handlers/ subdir under its 500-line cap). Pure extraction: the
 * behavior, throw messages, and the `graph:repaired` emit shape are byte-identical
 * to the in-line block they replace. `buildGraphInput` (graph-helpers.ts) calls
 * `attemptWeakModelRepair` only on the weak + INVALID path; the capable and
 * weak-valid paths never enter this module.
 *
 *   - CapabilityClassParam (the tier param shared with buildGraphInput's signature)
 *   - isWeakCapabilityClass (the small/nano routing predicate)
 *   - BuildGraphRepairContext (the injected gate + matcher + emit inputs)
 *   - attemptWeakModelRepair (the deterministic repair → re-governed graph | throw | fall-through)
 *
 * @module
 */

import {
  parseExecutionGraph,
  validateAndSortGraph,
  systemNowMs,
  type AppContainer,
} from "@comis/core";
// AUTHOR-01 (Phase 174-03): the daemon consumes the injected matcher's result
// types (the matcher fn itself is imported only at the rpc-dispatch composition
// site and injected via deps.repairMatch — never a direct import in this pure
// helper). Type-only imports introduce no runtime daemon→agent coupling.
import type { CanonicalTemplatePattern, TemplateMatch } from "@comis/agent";
import type { ComisLogger } from "@comis/infra";
// DEFER-174-FILESIZE-01: this module references the base dep types directly
// (AppContainer["eventBus"] / ComisLogger) rather than indexing into
// graph-helpers' GraphHandlerDeps — so the import edge is ONE-directional
// (graph-helpers → graph-repair), never a graph-helpers ↔ graph-repair madge
// cycle on the emitted .d.ts (pnpm cycles).

// ---------------------------------------------------------------------------
// O3: capabilityClass routing predicate
//
// PRODUCER STATUS (wired by Phase 174-03 / AUTHOR-01): the producer is the
// gated SERVER-SIDE tier feed in graph-mutate.ts (resolveAuthoringTier →
// resolveCapabilityClass(_agentId)), threaded into buildGraphInput's `repair`
// context. It is GATED on orchestration.authoring.repairProducer: when the gate
// is OFF (the default) resolveAuthoringTier returns undefined →
// isWeakCapabilityClass(undefined) === false → the capable direct-emit path
// (byte-identical to pre-174). When the gate is ON and the agent's real
// (server-resolved, NOT tool-supplied — T-174-SPOOF) tier is small/nano, the
// weak branch runs the conservative deterministic repair below. The tool param
// `userParams.capabilityClass` is NEVER read for the tier.
// ---------------------------------------------------------------------------

/** Capability class values that select the weak-model (template/repair) path. */
export type CapabilityClassParam = "frontier" | "mid" | "small" | "nano" | undefined;

/**
 * Returns true when the capability class indicates a weak model (small or nano).
 * Weak models route to the template/repair path in buildGraphInput.
 * Capable models (frontier, mid) and unknown (undefined) route to the existing
 * direct-emit path unchanged.
 *
 * Fed undefined when the repairProducer gate is off (the default) → the capable
 * path. Exported for unit testing, which passes the argument directly.
 */
export function isWeakCapabilityClass(
  capabilityClass: CapabilityClassParam,
): boolean {
  return capabilityClass === "small" || capabilityClass === "nano";
}

/** The ValidatedGraph shape returned by validateAndSortGraph (ok branch). */
type ValidatedGraphResult = Extract<
  ReturnType<typeof validateAndSortGraph>,
  { ok: true }
>["value"];

/**
 * Optional repair context for buildGraphInput's weak-model branch (AUTHOR-01).
 * Carries the injected gate + matcher + the best-effort emit inputs. Absent in
 * legacy callers (tests that pass only params + capabilityClass) ⇒ the repair
 * branch is never entered ⇒ byte-identical fail-closed behavior.
 */
export interface BuildGraphRepairContext {
  /**
   * The orchestration.authoring gate (config.orchestration.authoring). When
   * `repairProducer` is true AND the calling agent resolves to a weak tier, an
   * invalid graph routes to the conservative deterministic repair instead of the
   * fail-closed Phase-157 throw. Shape mirrors GraphHandlerDeps.authoringConfig.
   */
  authoringConfig?: {
    repairProducer: boolean;
    intentAction: boolean;
    gbnfConstrain: boolean;
  };
  /**
   * The injected conservative repair matcher (`matchRawGraphToTemplate` from
   * @comis/agent). INJECTED — never a direct daemon→agent import inside this pure
   * helper; the boundary is crossed only at the rpc-dispatch composition site.
   * Returns a deterministic "matched"/"ambiguous"/"no-match" verdict.
   */
  repairMatch?: (rawGraph: unknown) => TemplateMatch;
  /** Event bus for the best-effort graph:repaired emit (try/catch guarded). */
  eventBus?: AppContainer["eventBus"];
  /** Logger for the best-effort emit's WARN-on-throw (mirrors emitPipelineAuthored). */
  logger?: ComisLogger;
  /** Correlation ids for the audit emit (envelope-only; never body). */
  agentId?: string;
  sessionKey?: string;
}

/**
 * The raw (snake/camel-normalized) graph shape the matcher inspects. Mirrors the
 * object buildGraphInput assembles before parseExecutionGraph — only the fields
 * the repair path consults are needed.
 */
interface RawGraphForRepair {
  nodes: unknown[];
  label: string | undefined;
  [key: string]: unknown;
}

/**
 * Result of the weak-model repair attempt.
 *   - "repaired": an unambiguous match was re-governed clean → return `value`.
 *   - "fall-through": no-match, gate off, or a repaired graph that itself failed
 *     re-validation → the caller throws its existing fail-closed Phase-157 error
 *     (so the throw message stays owned by buildGraphInput, byte-identical).
 * The "ambiguous" verdict throws a structured did-you-mean directly here
 * (T-174-FALSESYNTH — no synthesis on an ambiguous shape).
 */
export type WeakModelRepairResult =
  | { kind: "repaired"; value: ValidatedGraphResult }
  | { kind: "fall-through" };

/**
 * The conservative, gated, deterministic repair for a weak + INVALID graph
 * (AUTHOR-01). Reached ONLY when repairProducer is on AND the server-resolved
 * tier is weak (FLAGS-OFF can never reach here — capabilityClass resolves
 * undefined when the gate is off, so isWeakCapabilityClass is false upstream and
 * the capable path ran).
 *
 *   - If the repair gate is ON (repairProducer) AND a repairMatch is injected:
 *     conservatively match the raw graph to a canonical template. On an
 *     unambiguous match → re-parse + re-validate the filled graph (the SAME
 *     governance) → emit graph:repaired (best-effort) → return it. On
 *     "ambiguous" → throw a structured did-you-mean (no false synthesis). On
 *     "no-match" / a repaired graph that still fails validation → "fall-through".
 *   - When the gate is OFF / no matcher → "fall-through".
 */
export function attemptWeakModelRepair(
  rawGraph: RawGraphForRepair,
  capabilityClass: CapabilityClassParam,
  repair: BuildGraphRepairContext | undefined,
): WeakModelRepairResult {
  if (repair?.authoringConfig?.repairProducer && repair.repairMatch) {
    // Match the ORIGINAL (snake/camel-normalized) raw graph by shape. The
    // matcher is pure + deterministic (no model reprompt — D-CONSERVATIVE).
    const m = repair.repairMatch(rawGraph);
    if (m.kind === "matched") {
      // Re-run the SAME governance on the repaired graph (D-SAME-VALIDATION §9):
      // parse → topo-sort. A repaired graph is NEVER returned unvalidated.
      const reparsed = parseExecutionGraph({ nodes: m.filledNodes, label: rawGraph.label });
      if (reparsed.ok) {
        const revalidated = validateAndSortGraph(reparsed.value);
        if (revalidated.ok) {
          emitGraphRepaired(repair, m.pattern, revalidated.value.graph.nodes.length, capabilityClass);
          return { kind: "repaired", value: revalidated.value };
        }
      }
      // A repaired graph that does not itself validate falls through to the
      // existing throw (never return an unvalidated graph).
    } else if (m.kind === "ambiguous") {
      // T-174-FALSESYNTH: no synthesis on an ambiguous shape — surface the
      // plausible templates so the model can pick one explicitly.
      throw new Error(
        `Graph invalid and ambiguous. Did you mean one of these templates: ${m.candidates.join(", ")}? Use the from_intent action with an explicit pattern.`,
      );
    }
    // "no-match" → fall through to the fail-closed throw.
  }
  return { kind: "fall-through" };
}

/**
 * Best-effort emit of graph:repaired (AUTHOR-01). Mirrors the 173
 * emitPipelineAuthored guard: telemetry MUST NEVER break the operation it
 * measures (the bus has no listener error isolation; a diagnostic-buffer SQLite
 * flush can throw). Counts/ids/enums ONLY — never the graph body (§2.7 / D-EVENT).
 */
function emitGraphRepaired(
  repair: BuildGraphRepairContext,
  pattern: CanonicalTemplatePattern,
  nodeCount: number,
  capabilityClass: CapabilityClassParam,
): void {
  try {
    repair.eventBus?.emit("graph:repaired", {
      pattern,
      nodeCount,
      capabilityClass: capabilityClass ?? "unknown",
      agentId: repair.agentId,
      sessionKey: repair.sessionKey,
      timestamp: systemNowMs(),
    });
  } catch (err) {
    repair.logger?.warn(
      {
        err,
        errorKind: "internal" as const,
        hint: "graph:repaired audit emit failed (likely an obs-buffer SQLite flush throw); the repaired graph proceeds unaffected",
      },
      "graph-repaired audit emit failed (best-effort)",
    );
  }
}
