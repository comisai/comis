// SPDX-License-Identifier: Apache-2.0
/**
 * DAG templates — pre-structured pipeline templates with ${VAR} slot filling.
 *
 * Four canonical named-graph templates (research-fanout, debate,
 * vote, map-reduce) that can be filled by weak models supplying slot values
 * rather than emitting full graph JSON. Unresolved slots produce an err result
 * rather than silently propagating a malformed task string.
 *
 * seedDefaultDagTemplates uses INSERT OR IGNORE semantics so operator-customized
 * templates are preserved across daemon restarts.
 *
 * No daemon import — all types are defined inline or imported from @comis/core.
 *
 * @module
 */
import { ok, err, type Result } from "@comis/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single node in a DAG template, using ${VAR} placeholders in task strings. */
export interface DagTemplateNode {
  nodeId: string;
  task: string;
  dependsOn: string[];
}

/** A named DAG template with slot definitions and canonical nodes. */
export interface DagTemplate {
  /** Human-readable label (used as the named-graph identifier). */
  label: string;
  /** Template nodes — task strings may contain ${VAR} placeholders. */
  nodes: DagTemplateNode[];
  /** Required slot names (e.g. ["TOPIC"] for research-fanout). */
  slots: string[];
}

/**
 * Minimal duck-typed NamedGraphStore interface.
 * @comis/memory is a devDependency of @comis/agent — use this inline interface
 * rather than importing NamedGraphStore directly to avoid a runtime dep issue.
 */
export interface NamedGraphStoreLike {
  save(entry: {
    id: string;
    tenantId: string;
    agentId: string;
    label: string;
    nodes: unknown[];
    edges: unknown[];
    settings: unknown;
  }): string;
}

// ---------------------------------------------------------------------------
// Canonical Templates
// ---------------------------------------------------------------------------

/**
 * Four canonical DAG templates for the small-model path.
 *
 * Each template uses ${VAR} placeholders in task strings:
 *   - research-fanout: ${TOPIC}
 *   - debate:          ${TOPIC}, ${PRO_AGENT}, ${CON_AGENT}
 *   - vote:            ${TOPIC}, ${VOTERS}
 *   - map-reduce:      ${TASK}, ${MAPPERS}
 */
export const CANONICAL_DAG_TEMPLATES: Record<string, DagTemplate> = {
  "research-fanout": {
    label: "research-fanout",
    slots: ["TOPIC"],
    nodes: [
      {
        nodeId: "research-1",
        task: "Research perspective 1 on: ${TOPIC}",
        dependsOn: [],
      },
      {
        nodeId: "research-2",
        task: "Research perspective 2 on: ${TOPIC}",
        dependsOn: [],
      },
      {
        nodeId: "research-3",
        task: "Research perspective 3 on: ${TOPIC}",
        dependsOn: [],
      },
      {
        nodeId: "synthesize",
        task: "Synthesize all research findings on ${TOPIC} into a cohesive summary",
        dependsOn: ["research-1", "research-2", "research-3"],
      },
    ],
  },

  debate: {
    label: "debate",
    slots: ["TOPIC", "PRO_AGENT", "CON_AGENT"],
    nodes: [
      {
        nodeId: "pro-advocate",
        task: "Argue the strongest case FOR the position on: ${TOPIC}. Agent: ${PRO_AGENT}",
        dependsOn: [],
      },
      {
        nodeId: "con-advocate",
        task: "Argue the strongest case AGAINST the position on: ${TOPIC}. Agent: ${CON_AGENT}",
        dependsOn: [],
      },
      {
        nodeId: "moderator",
        task: "Moderate the debate on ${TOPIC}, synthesize both sides, and provide a balanced verdict",
        dependsOn: ["pro-advocate", "con-advocate"],
      },
    ],
  },

  vote: {
    label: "vote",
    slots: ["TOPIC", "VOTERS"],
    nodes: [
      {
        nodeId: "voter-1",
        task: "Cast your vote and reasoning on: ${TOPIC}. Voters in pool: ${VOTERS}",
        dependsOn: [],
      },
      {
        nodeId: "voter-2",
        task: "Cast your vote and reasoning on: ${TOPIC}. Voters in pool: ${VOTERS}",
        dependsOn: [],
      },
      {
        nodeId: "voter-3",
        task: "Cast your vote and reasoning on: ${TOPIC}. Voters in pool: ${VOTERS}",
        dependsOn: [],
      },
      {
        nodeId: "aggregator",
        task: "Aggregate all votes on ${TOPIC}, tally results, and declare the majority outcome",
        dependsOn: ["voter-1", "voter-2", "voter-3"],
      },
    ],
  },

  "map-reduce": {
    label: "map-reduce",
    slots: ["TASK", "MAPPERS"],
    nodes: [
      {
        nodeId: "mapper-1",
        task: "Map phase 1 of: ${TASK}. Available mappers: ${MAPPERS}",
        dependsOn: [],
      },
      {
        nodeId: "mapper-2",
        task: "Map phase 2 of: ${TASK}. Available mappers: ${MAPPERS}",
        dependsOn: [],
      },
      {
        nodeId: "mapper-3",
        task: "Map phase 3 of: ${TASK}. Available mappers: ${MAPPERS}",
        dependsOn: [],
      },
      {
        nodeId: "reducer",
        task: "Reduce and merge all mapped outputs from ${TASK} into a final result",
        dependsOn: ["mapper-1", "mapper-2", "mapper-3"],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Template Filling
// ---------------------------------------------------------------------------

/** Regex for detecting ${VAR} slot patterns (used for detection pass). */
const SLOT_DETECT_RE = /\$\{([A-Z_]+)\}/;

/** Regex for replacing ${VAR} slot patterns (global, used for replace pass). */
const SLOT_REPLACE_RE = /\$\{([A-Z_]+)\}/g;

/**
 * Fill a DAG template by replacing all ${VAR} slot placeholders with the
 * provided variable values.
 *
 * Returns ok(filledNodes) on success. Returns err("Unresolved template slots
 * remain: VAR1, VAR2") if any slot remains after filling — the caller must
 * treat this as a failure and NOT proceed with the unfilled graph.
 *
 * Wiring: the canonical templates are seeded into the named-graph store at
 * daemon boot (seedDefaultDagTemplates, wired in daemon.ts). The producers
 * that select a template and call fillDagTemplate with weak-model slot values
 * are the small-model graph-repair path (the conservative template matcher in
 * dag-template-match.ts, alongside repairDagWithBoundedRetries) and the intent
 * synthesizer (dag-synthesizer.ts).
 *
 * @param template - The DAG template to fill.
 * @param vars - Map of slot name (e.g. "TOPIC") to replacement value.
 */
export function fillDagTemplate(
  template: DagTemplate,
  vars: Record<string, string>,
): Result<DagTemplateNode[], string> {
  // Deep-clone the nodes via JSON round-trip to avoid mutating the template
  const cloned = JSON.parse(JSON.stringify(template.nodes)) as DagTemplateNode[];

  // Serialize to JSON, perform the replacement pass, then parse back.
  // Note: SLOT_REPLACE_RE is global — reset lastIndex between uses by
  // always using it only within .replace() which handles index internally.
  //
  // Slot values come straight from a weak model and may contain JSON
  // metacharacters (double-quote, backslash, newline). Substituting them RAW
  // into the serialized JSON string would corrupt the structure and make the
  // JSON.parse below throw an uncaught SyntaxError out of this Result-returning
  // function. Escape each value via JSON.stringify(value).slice(1, -1) so it is
  // inserted as a valid JSON string body (the surrounding quotes already exist
  // in `serialized`), keeping the structure well-formed regardless of content.
  const serialized = JSON.stringify(cloned);
  const replaced = serialized.replace(SLOT_REPLACE_RE, (_, k: string) => {
    if (vars[k] === undefined) return `\${${k}}`;
    // Escape for safe insertion inside an existing JSON string literal.
    return JSON.stringify(vars[k]).slice(1, -1);
  });

  // Detection pass: check for any remaining unresolved slots.
  // Use a non-global regex here to avoid lastIndex state issues.
  const remaining = findUnresolvedSlots(replaced);
  if (remaining.length > 0) {
    return err(`Unresolved template slots remain: ${remaining.join(", ")}`);
  }

  // Defensive parse guard. Escaping above already prevents structural
  // corruption, but a Result-returning contract must never throw — surface any
  // residual parse failure as err() rather than letting it propagate.
  let filled: DagTemplateNode[];
  try {
    filled = JSON.parse(replaced) as DagTemplateNode[];
  } catch (parseErr) {
    return err(
      `Filled template did not parse as valid JSON: ${
        parseErr instanceof Error ? parseErr.message : String(parseErr)
      }`,
    );
  }
  return ok(filled);
}

/**
 * Find all unresolved ${VAR} slot names in a JSON string.
 * Uses exec() loop on a fresh regex instance to avoid lastIndex issues.
 */
function findUnresolvedSlots(json: string): string[] {
  const found = new Set<string>();
  // Create a fresh global regex for iteration — avoids stale lastIndex
  const re = new RegExp(SLOT_DETECT_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(json)) !== null) {
    found.add(match[1]);
  }
  return Array.from(found);
}

// ---------------------------------------------------------------------------
// Default Template Seeding (INSERT OR IGNORE semantics)
// ---------------------------------------------------------------------------

const SYSTEM_TENANT_ID = "system";
const SYSTEM_AGENT_ID = "system";

/**
 * Seed the four canonical DAG templates into the named-graph store.
 *
 * Uses INSERT OR IGNORE semantics (try/catch on duplicate key) so that
 * operator-customized templates are never overwritten on daemon restart.
 *
 * @param store - A NamedGraphStore-compatible object (duck-typed).
 */
export function seedDefaultDagTemplates(store: NamedGraphStoreLike): void {
  for (const [key, template] of Object.entries(CANONICAL_DAG_TEMPLATES)) {
    try {
      store.save({
        id: `system-template-${key}`,
        tenantId: SYSTEM_TENANT_ID,
        agentId: SYSTEM_AGENT_ID,
        label: template.label,
        nodes: template.nodes,
        edges: [],
        settings: { isTemplate: true, slots: template.slots },
      });
    } catch {
      // INSERT OR IGNORE: duplicate key or unique constraint — template already
      // exists (possibly operator-customized); skip silently.
    }
  }
}
