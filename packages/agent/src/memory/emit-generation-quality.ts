// SPDX-License-Identifier: Apache-2.0
/**
 * GENQ-01: the shared, guarded emit helper for `memory:generation_quality`.
 *
 * The single call site every memory-generation pass (consolidation, reasoning,
 * user-representation) routes through, mirroring the context-engine's
 * `emitSummaryLanguageMismatch` (OBS-01). It runs the pure single-source
 * `classifyGenerationQuality` (I7) over the pass's (source → output) text pair
 * and, ONLY when a quality issue is present, emits a content-free event so the
 * F-ML1 regression class (a weak local model translating non-Latin source
 * memories into a Latin output) becomes a counted `comis fleet` finding instead
 * of an offline-probe finding.
 *
 * VISIBILITY ONLY — never gates the generation. The emit is strictly additive and
 * GUARDED: a throwing subscriber NEVER fails the (cron) generation pass. The
 * payload carries the closed `GenerationPass` + `ScriptClass` enums + booleans +
 * the agentId ONLY — NEVER the source or generated body (§2.7).
 * @module
 */
import { classifyGenerationQuality, type GenerationPass } from "@comis/core";
import type { EventMap, ErrorKind } from "@comis/core";

/** The narrow bus the memory-generation jobs inject (a typed-payload superset of
 *  `TypedEventBus` is not threaded into the cron jobs). The payload is constructed
 *  as a typed `EventMap` literal below, so the SHAPE is still compile-checked. */
type NarrowEventBus = { emit(event: string, payload: unknown): void };

/** The narrow logger the memory-generation jobs inject — a structural subset that
 *  `ComisLogger` also satisfies (matches the jobs' own `deps.logger` shape, whose
 *  `warn(obj, msg)` is stricter than `ComisLogger`'s overloaded `LogMethod`). */
type NarrowLogger = { warn(obj: Record<string, unknown>, msg: string): void };

/**
 * Classify one generation pass and emit `memory:generation_quality` iff an issue
 * is detected (`languageMismatch || emptyOutput || formatViolation`). A clean
 * pass is silent (no event), so the fleet count is the regression count.
 *
 * @param eventBus - the pass's typed bus (absent ⇒ a silent no-op via the `?.`)
 * @param logger   - structured logger for the guarded-emit failure WARN
 * @param args.pass           - which generation pass (closed union)
 * @param args.sourceText     - the generation INPUT (the source memories/chunk)
 * @param args.outputText     - the generated OUTPUT text
 * @param args.formatViolation - caller-supplied: the output failed to parse into
 *   the pass's expected structured form (the pass owns its schema; the pure
 *   classifier cannot know it). Defaults false.
 * @param args.nowMs          - the injected clock read for the event timestamp
 */
export function emitGenerationQuality(
  eventBus: NarrowEventBus | undefined,
  logger: NarrowLogger,
  args: {
    agentId: string;
    sessionKey?: string;
    pass: GenerationPass;
    sourceText: string;
    outputText: string;
    formatViolation?: boolean;
    nowMs: number;
  },
): void {
  const c = classifyGenerationQuality(args.sourceText, args.outputText);
  const formatViolation = args.formatViolation ?? false;
  // VISIBILITY ONLY: a clean pass emits nothing; the fleet count == regression count.
  if (!c.languageMismatch && !c.emptyOutput && !formatViolation) return;

  // Typed literal so the payload SHAPE is compile-checked against the EventMap
  // even though the narrow job bus accepts `unknown`.
  const payload: EventMap["memory:generation_quality"] = {
    agentId: args.agentId,
    ...(args.sessionKey !== undefined ? { sessionKey: args.sessionKey } : {}),
    pass: args.pass,
    sourceScript: c.sourceScript,
    outputScript: c.outputScript,
    languageMismatch: c.languageMismatch,
    emptyOutput: c.emptyOutput,
    formatViolation,
    timestamp: args.nowMs,
  };
  try {
    eventBus?.emit("memory:generation_quality", payload);
  } catch (err) {
    // Guarded-emit (the emitSummaryLanguageMismatch isolation pattern):
    // observability NEVER fails the generation pass. Content-free WARN (§2.7).
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        agentId: args.agentId,
        hint: "memory:generation_quality subscriber threw; signal dropped, generation unaffected — inspect the failing event subscriber (trajectory writer / health-signal sink)",
        errorKind: "dependency" as ErrorKind,
      },
      "generation_quality emit failed (non-fatal)",
    );
  }
}
