// SPDX-License-Identifier: Apache-2.0
/**
 * Deterministic, conservative DAG template matcher (AUTHOR-01 / Phase 174-03).
 *
 * Maps a weak-model raw graph to one of the CANONICAL_DAG_TEMPLATES by SHAPE
 * (node count + dependency topology: N independent leaves + a single fan-in) and
 * slot/keyword inference. It is the daemon-side conservative repair primitive:
 * pure, deterministic, and NO model reprompt (D-CONSERVATIVE — the
 * repairDagWithBoundedRetries reprompt seam is the agent-side path; the daemon
 * RPC handler has no model loop, so the repair here is template-match only).
 *
 * Returns "matched" ONLY when exactly one template fits unambiguously by SHAPE
 * AND the graph's task/nodeId text corroborates that template's intent via a
 * disambiguating keyword (WR-01: shape alone is never enough — buildMatch
 * discards the user's tasks for the canonical strings, so a shape-only match
 * would silently rewrite the intent); otherwise "ambiguous" (a plausible shape
 * the content does not confirm, or >=2 plausible canonical shapes — surface a
 * structured did-you-mean) or "no-match" (fall through to the fail-closed throw).
 *
 * On "matched", slot values are filled via fillDagTemplate, which JSON-escapes
 * weak-model slot values (CR-03) so the filled graph parses clean.
 *
 * No daemon import — this lives in @comis/agent and is INJECTED into the daemon
 * buildGraphInput via deps.repairMatch (the daemon→agent boundary is crossed at
 * the rpc-dispatch composition site only, never inside the pure helper).
 *
 * @module
 */
import { CANONICAL_DAG_TEMPLATES, fillDagTemplate } from "./dag-templates.js";

/** Canonical template keys (closed set — mirrors CANONICAL_DAG_TEMPLATES). */
export type CanonicalTemplatePattern = "research-fanout" | "debate" | "vote" | "map-reduce";

/**
 * Result of matching a raw graph to a canonical template.
 *   - matched:   exactly one template fits unambiguously; filledNodes are ready
 *                to parse + validate (the SAME governance a hand-authored graph
 *                takes).
 *   - ambiguous: >=2 plausible canonical shapes — the caller surfaces a
 *                structured did-you-mean (no synthesis).
 *   - no-match:  no canonical shape fits — the caller falls through to the
 *                existing fail-closed throw.
 */
export type TemplateMatch =
  | { kind: "matched"; pattern: CanonicalTemplatePattern; filledNodes: unknown[] }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "no-match" };

// ---------------------------------------------------------------------------
// Raw-graph shape extraction (duck-typed; the input is unknown weak-model JSON)
// ---------------------------------------------------------------------------

interface RawNode {
  nodeId: string;
  task: string;
  dependsOn: string[];
}

/**
 * Normalize an unknown raw graph into typed nodes, tolerating both camelCase and
 * snake_case (weak models emit either). Returns undefined when the input is not
 * a non-empty {nodes:[...]} object — the matcher then reports "no-match".
 */
function extractNodes(rawGraph: unknown): RawNode[] | undefined {
  if (rawGraph === null || typeof rawGraph !== "object") return undefined;
  const rawNodes = (rawGraph as { nodes?: unknown }).nodes;
  if (!Array.isArray(rawNodes) || rawNodes.length === 0) return undefined;

  const nodes: RawNode[] = [];
  for (const raw of rawNodes) {
    if (raw === null || typeof raw !== "object") return undefined;
    const r = raw as Record<string, unknown>;
    const nodeId = (r.nodeId ?? r.node_id) as unknown;
    const task = r.task as unknown;
    const dependsOnRaw = (r.dependsOn ?? r.depends_on) as unknown;
    if (typeof nodeId !== "string" || typeof task !== "string") return undefined;
    const dependsOn = Array.isArray(dependsOnRaw)
      ? dependsOnRaw.filter((d): d is string => typeof d === "string")
      : [];
    nodes.push({ nodeId, task, dependsOn });
  }
  return nodes;
}

/**
 * The canonical "fan-out → fan-in" shape: exactly N independent leaf nodes
 * (dependsOn empty) plus exactly ONE fan-in node that depends on ALL N leaves
 * (and nothing else). Returns the leaf count when the shape holds, else
 * undefined. This is the shared topology of every canonical template.
 */
function fanInLeafCount(nodes: RawNode[]): number | undefined {
  const ids = new Set(nodes.map((n) => n.nodeId));
  const leaves = nodes.filter((n) => n.dependsOn.length === 0);
  const nonLeaves = nodes.filter((n) => n.dependsOn.length > 0);
  if (nonLeaves.length !== 1) return undefined;
  const fanIn = nonLeaves[0]!;
  const leafIds = new Set(leaves.map((n) => n.nodeId));
  // The fan-in must depend on every leaf and only on leaves that exist.
  if (fanIn.dependsOn.length !== leaves.length) return undefined;
  for (const dep of fanIn.dependsOn) {
    if (!ids.has(dep) || !leafIds.has(dep)) return undefined;
  }
  // Every node is either a leaf or the single fan-in (no other topology).
  if (leaves.length + 1 !== nodes.length) return undefined;
  return leaves.length;
}

// ---------------------------------------------------------------------------
// Keyword inference (disambiguates same-shape templates)
// ---------------------------------------------------------------------------

/**
 * Per-template disambiguating keyword sets. research-fanout / vote / map-reduce
 * share the 4-node 3+1 shape, so a same-shape raw graph is "ambiguous" UNLESS
 * its task/nodeId text matches exactly one template's keywords. debate is the
 * only 3-node 2+1 template, so it is shape-unique.
 */
const TEMPLATE_KEYWORDS: Record<CanonicalTemplatePattern, RegExp> = {
  "research-fanout": /\b(research|synthes|perspective|findings)\w*/i,
  debate: /\b(debate|advocate|argue|moderat|verdict|for the position|against the position)\w*/i,
  vote: /\b(vote|voter|ballot|tally|aggregat|majority)\w*/i,
  "map-reduce": /\b(map|mapper|reduce|reducer)\w*/i,
};

/** Concatenate all nodeId + task text for keyword scanning. */
function graphText(nodes: RawNode[]): string {
  return nodes.map((n) => `${n.nodeId} ${n.task}`).join(" ");
}

// ---------------------------------------------------------------------------
// Slot inference (fill the matched template's slots from the raw graph)
// ---------------------------------------------------------------------------

/**
 * Infer slot values for a matched template from the raw graph. The topic/task
 * slot is taken from the graph label (the user's one-line intent); agent/voter
 * slots fall back to a neutral placeholder when not directly extractable
 * (fillDagTemplate err's on any unresolved slot, so every declared slot must be
 * provided — a conservative non-empty default keeps the matched graph valid
 * rather than silently dropping a node).
 */
function inferSlots(
  pattern: CanonicalTemplatePattern,
  rawGraph: unknown,
  nodes: RawNode[],
): Record<string, string> {
  const label =
    (rawGraph !== null && typeof rawGraph === "object"
      ? ((rawGraph as { label?: unknown }).label as unknown)
      : undefined);
  // The topic is the user intent: prefer the label, else the first leaf's task.
  const topic =
    typeof label === "string" && label.trim().length > 0
      ? label.trim()
      : (nodes.find((n) => n.dependsOn.length === 0)?.task ?? "the task");

  switch (pattern) {
    case "research-fanout":
      return { TOPIC: topic };
    case "debate":
      // Try to lift the two advocate agents from "Agent: X" mentions in the
      // independent leaves; fall back to neutral role labels.
      {
        const leaves = nodes.filter((n) => n.dependsOn.length === 0);
        const agents = leaves
          .map((n) => /agent:\s*([\w.-]+)/i.exec(n.task)?.[1])
          .filter((a): a is string => typeof a === "string");
        return {
          TOPIC: topic,
          PRO_AGENT: agents[0] ?? "advocate",
          CON_AGENT: agents[1] ?? "opponent",
        };
      }
    case "vote":
      return { TOPIC: topic, VOTERS: "the voter pool" };
    case "map-reduce":
      return { TASK: topic, MAPPERS: "the mapper pool" };
  }
}

// ---------------------------------------------------------------------------
// The matcher
// ---------------------------------------------------------------------------

/**
 * Conservatively match a weak-model raw graph to a canonical template by SHAPE
 * (node count + dependency topology) corroborated by KEYWORD (WR-01).
 * Deterministic, no model call. Returns "matched" ONLY when exactly one
 * template fits the shape AND a disambiguating keyword confirms the intent;
 * otherwise "ambiguous" (shape fits but content does not corroborate, or >=2
 * plausible) or "no-match". On "matched", the slot values are filled via
 * fillDagTemplate (which JSON-escapes weak-model values).
 */
export function matchRawGraphToTemplate(rawGraph: unknown): TemplateMatch {
  const nodes = extractNodes(rawGraph);
  if (!nodes) return { kind: "no-match" };

  const leafCount = fanInLeafCount(nodes);
  if (leafCount === undefined) return { kind: "no-match" };

  // Shape-filter: which canonical templates have this exact node count +
  // (N leaves + 1 fan-in) topology?
  const allPatterns = Object.keys(CANONICAL_DAG_TEMPLATES) as CanonicalTemplatePattern[];
  const shapeCandidates = allPatterns.filter((p) => {
    const tNodes = CANONICAL_DAG_TEMPLATES[p]!.nodes as RawNode[];
    if (tNodes.length !== nodes.length) return false;
    const tLeaves = tNodes.filter((n) => n.dependsOn.length === 0).length;
    return tLeaves === leafCount;
  });

  if (shapeCandidates.length === 0) return { kind: "no-match" };

  // The graph text (nodeId + task) used to corroborate the matched template's
  // INTENT against its shape (WR-01). buildMatch's fillDagTemplate REPLACES the
  // user's tasks with the canonical template strings, so a `matched` on shape
  // alone silently rewrites the user's intent — every `matched` must be gated
  // on at least one disambiguating keyword, never on shape alone.
  const text = graphText(nodes);

  // A single template fits the shape (e.g. debate's unique 3-node 2+1). SHAPE
  // alone is NOT enough (WR-01): the user's tasks would be discarded for the
  // canonical strings. Require the candidate's keyword set to corroborate the
  // intent; on a keyword miss, return the structured did-you-mean (no false
  // synthesis) — the shape is plausible but the content does not confirm it.
  if (shapeCandidates.length === 1) {
    const only = shapeCandidates[0]!;
    if (!TEMPLATE_KEYWORDS[only].test(text)) {
      return { kind: "ambiguous", candidates: [only] };
    }
    return buildMatch(only, rawGraph, nodes);
  }

  // Several templates share the shape → disambiguate by keywords. A template is
  // a keyword candidate only if its keyword set matches the graph text.
  const keywordCandidates = shapeCandidates.filter((p) => TEMPLATE_KEYWORDS[p].test(text));

  if (keywordCandidates.length === 1) {
    return buildMatch(keywordCandidates[0]!, rawGraph, nodes);
  }

  // Zero keyword hits, or >=2 → ambiguous (D-CONSERVATIVE: no false synthesis).
  // The candidate list is the shape-fitting templates (the genuinely plausible
  // ones), or the keyword-overlapping subset when that is the narrower set.
  const candidates = keywordCandidates.length >= 2 ? keywordCandidates : shapeCandidates;
  return { kind: "ambiguous", candidates: [...candidates] };
}

/**
 * Fill the matched template and return a "matched" result, or fall through to
 * "no-match" if the fill leaves unresolved slots (never return an unfilled
 * graph — fillDagTemplate err's on residual ${VAR}).
 */
function buildMatch(
  pattern: CanonicalTemplatePattern,
  rawGraph: unknown,
  nodes: RawNode[],
): TemplateMatch {
  const template = CANONICAL_DAG_TEMPLATES[pattern]!;
  const vars = inferSlots(pattern, rawGraph, nodes);
  const filled = fillDagTemplate(template, vars);
  if (!filled.ok) return { kind: "no-match" };
  return { kind: "matched", pattern, filledNodes: filled.value };
}
