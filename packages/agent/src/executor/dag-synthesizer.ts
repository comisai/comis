// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic intent → ExecutionGraph synthesizer (AUTHOR-02 / Phase 174-04).
 *
 * Expands a one-line intent — `{ pattern, agents|tasks, rounds?, budget? }` —
 * into a VALIDATED ExecutionGraph by mapping `pattern` to one of the
 * CANONICAL_DAG_TEMPLATES (research-fanout / debate / vote / map-reduce),
 * deriving the template's slot values from `agents`/`tasks`, filling via
 * fillDagTemplate (which JSON-escapes weak-model slot values, CR-03), then
 * re-running the SAME governance a hand-authored graph takes
 * (parseExecutionGraph + validateAndSortGraph).
 *
 * This is THE small-model differentiator: the model expresses *what* (a pattern
 * + a few names) rather than the nested type_config union the raw pipeline
 * schema requires.
 *
 * GOVERNANCE (D-GOVERNANCE / §9): the synthesizer is PURE — it RETURNS a graph
 * and NEVER executes one. The caller (the pipeline tool's from_intent action)
 * dispatches the returned graph through the EXISTING graph.execute path, so the
 * synthesized graph hits define-time governance (parse / topo-sort /
 * validateTypeConfigs) AND spawn-time governance (the sub-agent denylist +
 * child⊆parent intersection) automatically. A synthesizer that
 * constructed-and-ran a graph directly would bypass all of it — forbidden.
 *
 * Returns err on an unknown pattern or a missing required slot input (e.g.
 * debate without 2 agents) — NEVER a partial or invalid graph
 * (T-174-SYNTH-INPUT).
 *
 * No daemon import — this lives in @comis/agent. The pipeline tool imports
 * synthesizeFromIntent; the synthesized graph then travels in-band on the
 * graph.execute rpcCall, where the daemon gates + audits it.
 *
 * @module
 */
import { ok, err, type Result } from "@comis/shared";
import { parseExecutionGraph, validateAndSortGraph, type ExecutionGraph } from "@comis/core";
import { CANONICAL_DAG_TEMPLATES, fillDagTemplate, type DagTemplate } from "./dag-templates.js";

/** The closed set of canonical patterns the synthesizer can expand. */
export type SynthesisPattern = "research-fanout" | "debate" | "vote" | "map-reduce";

/**
 * A one-line authoring intent. The model supplies a pattern plus the minimal
 * slot inputs that pattern needs; the synthesizer expands the canonical
 * template.
 */
export interface SynthesisIntent {
  /** Which canonical template to expand (closed set). */
  pattern: SynthesisPattern;
  /** debate: [PRO, CON]; vote: VOTERS; map-reduce: MAPPERS. */
  agents?: string[];
  /** Alternative driver of the TOPIC / TASK slots (tasks[0] is the topic). */
  tasks?: string[];
  /** Optional; reserved for future driver-node expansion (accepted, not yet expanded). */
  rounds?: number;
  /** Optional resource budget, passed through onto the synthesized graph. */
  budget?: { maxTokens?: number; maxCost?: number };
}

/** Default topic/task when the intent supplies no task text. */
const DEFAULT_TOPIC = "the requested task";

/**
 * Compute the slot map for `pattern` from the intent, or return err naming the
 * missing required input. Every declared template slot MUST be provided —
 * fillDagTemplate err's on any residual ${VAR}, and a partial graph is never
 * returned.
 */
function slotsForPattern(intent: SynthesisIntent): Result<Record<string, string>, string> {
  const topic = intent.tasks?.[0]?.trim() || DEFAULT_TOPIC;
  // IN-02: trim + drop blank entries BEFORE any count/use. A blank agent name
  // is garbage-in — `["", ""]` would otherwise pass the debate length gate and
  // fill PRO_AGENT="" / CON_AGENT="" (a "...Agent: " blank-role graph). Filtering
  // here makes blank agents trip the same "requires 2 agents" err as `[]`, and
  // keeps the vote/map-reduce pool join free of empty fragments.
  const agents = (intent.agents ?? []).map((a) => a.trim()).filter(Boolean);

  switch (intent.pattern) {
    case "research-fanout":
      return ok({ TOPIC: topic });
    case "debate":
      // The canonical debate template needs two NON-EMPTY advocate agents.
      if (agents.length < 2) {
        return err(
          `debate requires 2 agents (got ${agents.length}) — provide agents: [PRO, CON] (e.g. ["bull", "bear"]).`,
        );
      }
      return ok({ TOPIC: topic, PRO_AGENT: agents[0]!, CON_AGENT: agents[1]! });
    case "vote":
      // VOTERS is a single descriptive pool string; agents (when supplied) name it.
      return ok({ TOPIC: topic, VOTERS: agents.length > 0 ? agents.join(", ") : "the voter pool" });
    case "map-reduce":
      return ok({ TASK: topic, MAPPERS: agents.length > 0 ? agents.join(", ") : "the mapper pool" });
    default: {
      // Exhaustiveness: an unknown pattern is an err, never a throw.
      const _exhaustive: never = intent.pattern;
      return err(`Unknown synthesis pattern: ${String(_exhaustive)}.`);
    }
  }
}

/**
 * Deterministically expand a one-line intent into a VALIDATED ExecutionGraph via
 * the canonical templates. Returns err on an unknown pattern or a missing
 * required slot input. NEVER executes the graph — the caller dispatches it
 * through graph.execute so governance applies automatically.
 */
export function synthesizeFromIntent(intent: SynthesisIntent): Result<ExecutionGraph, string> {
  const template: DagTemplate | undefined = CANONICAL_DAG_TEMPLATES[intent.pattern];
  if (!template) {
    return err(
      `Unknown synthesis pattern: ${String(intent.pattern)}. Valid patterns: research-fanout, debate, vote, map-reduce.`,
    );
  }

  const slots = slotsForPattern(intent);
  if (!slots.ok) return slots;

  // Fill the template slots — JSON-escapes weak-model values (CR-03) and err's
  // on any unresolved ${VAR} so a partial graph is never produced.
  const filled = fillDagTemplate(template, slots.value);
  if (!filled.ok) return filled;

  // Build the raw graph and run the SAME governance a hand-authored graph takes
  // (D-SAME-VALIDATION §9): the label carries the user's one-line intent.
  const rawGraph = {
    nodes: filled.value,
    label: template.label,
    ...(intent.budget !== undefined && { budget: intent.budget }),
  };

  const parsed = parseExecutionGraph(rawGraph);
  if (!parsed.ok) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return err(`Synthesized graph failed validation: ${issues}`);
  }

  const validated = validateAndSortGraph(parsed.value);
  if (!validated.ok) {
    return err(`Synthesized graph failed validation: ${validated.error.message}`);
  }

  // Return the parsed ExecutionGraph (NOT the run order) — the caller dispatches
  // it through graph.execute; this fn never executes it.
  return ok(parsed.value);
}
