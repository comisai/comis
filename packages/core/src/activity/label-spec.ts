// SPDX-License-Identifier: Apache-2.0
/**
 * label-spec — the activity {@link LabelSpec} type plus the module-level
 * registry ({@link registerActivityLabelSpec}) and the theme-merge resolver
 * ({@link resolveLabelSpec}) (ACT-06/08, spec §6.1/§6.2).
 *
 * The registry mirrors the verified `core/tool-metadata.ts` idiom: a
 * module-level `Map` keyed by tool name, written via spread-merge so different
 * sources can register different fields for the same tool incrementally.
 *
 * Resolution precedence is **theme-override > registered spec > semantic
 * fallback** (spec §6.2), applied as a deep merge: each layer's defined fields
 * win and undefined fields inherit, so a theme that overrides only the label
 * preserves the registered detail/detailKeys. A theme cannot remove the
 * allowlist — it can only add/replace fields (T-70-04-04).
 *
 * Pure domain: no logger, no I/O, no channel coupling. The template engine
 * (plan 70-04 Task 1) consumes the resolved {@link LabelSpec}; the observability
 * label-resolver (plan 70-08) is the production caller of {@link resolveLabelSpec}.
 *
 * @module
 */
import { classifySemanticPhase, type SemanticPhase } from "./semantic-classifier.js";

/**
 * A resolved activity label spec — the shape {@link import("./template-engine.js").applyTemplate}
 * consumes (spec §6.1 / §10.1). `label`/`detail` are `{key}`-placeholder
 * templates; `detailKeys` is the param-key allowlist the template engine
 * enforces (every other params key is dropped at the gate — SEC-03).
 */
export interface LabelSpec {
  /** The semantic phase this tool/action maps to (drives projection styling). */
  readonly semanticPhase: SemanticPhase;
  /** The label template, e.g. `configuring MCP server \`{name}\``. */
  readonly label: string;
  /** Optional detail template (a second, longer line). */
  readonly detail?: string;
  /**
   * The param-key allowlist. Only these keys may appear as `{key}` placeholders
   * and only these survive the template engine's allowlist filter. Absent or
   * empty → the template references no params (a static label).
   */
  readonly detailKeys?: readonly string[];
}

/**
 * Per-action label fields. A registered spec may declare a default
 * (tool-level) label and/or per-action overrides (spec §6.1 `actions` block).
 */
export interface ActionLabelSpec {
  /** Label template for this action (e.g. `configuring MCP server \`{name}\``). */
  readonly label?: string;
  /** Detail template for this action. */
  readonly detail?: string;
  /** Param-key allowlist for this action's templates. */
  readonly detailKeys?: readonly string[];
}

/**
 * The shape passed to {@link registerActivityLabelSpec} (spec §6.1). All fields
 * optional except none — a registration supplies a `semanticPhase` and/or
 * tool-level label fields and/or an `actions` map. Co-located with each tool's
 * definition (not central config).
 */
export interface RegisteredLabelSpec extends ActionLabelSpec {
  /** Overrides the semantic-classifier fallback for this tool. */
  readonly semanticPhase?: SemanticPhase;
  /** Per-action label overrides, keyed by the tool's `action` discriminator. */
  readonly actions?: Readonly<Record<string, ActionLabelSpec>>;
}

/**
 * An operator activity theme (spec §6.2). Rebrands per-tool labels without
 * touching code via `agents.<id>.activity.theme`. A theme override deep-merges
 * ON TOP of the registered spec / semantic fallback — overridden fields win,
 * the rest inherit. It can add or replace fields but cannot strip the allowlist.
 */
export interface ActivityTheme {
  /** Per-tool overrides, keyed by tool name. */
  readonly tools?: Readonly<Record<string, RegisteredLabelSpec>>;
}

/** Options for {@link resolveLabelSpec}. */
export interface ResolveLabelOptions {
  /** The tool's action discriminator (selects a per-action registered spec). */
  readonly action?: string;
  /** The active operator theme (highest-precedence override layer). */
  readonly theme?: ActivityTheme;
}

// ---------------------------------------------------------------------------
// Registry (module-level singleton Map — mirrors tool-metadata.ts)
// ---------------------------------------------------------------------------

const registry = new Map<string, RegisteredLabelSpec>();

/**
 * Register an activity label spec for a tool. Merges with any existing spec via
 * spread (incremental registration from different sources), mirroring
 * `registerToolMetadata`. The nested `actions` map is merged key-by-key so two
 * sources can register different actions for the same tool.
 */
export function registerActivityLabelSpec(toolName: string, spec: RegisteredLabelSpec): void {
  const existing = registry.get(toolName);
  if (existing === undefined) {
    registry.set(toolName, spec);
    return;
  }
  registry.set(toolName, {
    ...existing,
    ...spec,
    actions: { ...existing.actions, ...spec.actions },
  });
}

/**
 * Clears the registry. Test-only — underscore prefix signals internal use.
 * Import directly from label-spec.ts in test files, NOT from a barrel.
 */
export function _clearActivityLabelSpecsForTest(): void {
  registry.clear();
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective {@link LabelSpec} for a tool (and optionally an action),
 * applying the precedence **theme-override > registered > semantic fallback**
 * (spec §6.2) as a deep, per-field merge.
 *
 * @param toolName - the tool name (used for the semantic fallback + lookups)
 * @param opts     - optional `action` selector and `theme` override layer
 * @returns the fully-resolved label spec (always has a `semanticPhase` + `label`)
 */
export function resolveLabelSpec(toolName: string, opts: ResolveLabelOptions = {}): LabelSpec {
  // Layer 1 — semantic fallback: classifier-derived phase + a humanized label.
  let semanticPhase: SemanticPhase = classifySemanticPhase(toolName);
  let label: string = humanizeToolName(toolName);
  let detail: string | undefined;
  let detailKeys: readonly string[] | undefined;

  // Layer 2 — registered spec (tool-level first, then the per-action override).
  const registered = registry.get(toolName);
  if (registered !== undefined) {
    if (registered.semanticPhase !== undefined) semanticPhase = registered.semanticPhase;
    ({ label, detail, detailKeys } = mergeActionFields(
      { label, detail, detailKeys },
      registered,
    ));
    const action = opts.action;
    if (action !== undefined && registered.actions !== undefined) {
      const actionSpec = lookup(registered.actions, action);
      if (actionSpec !== undefined) {
        ({ label, detail, detailKeys } = mergeActionFields(
          { label, detail, detailKeys },
          actionSpec,
        ));
      }
    }
  }

  // Layer 3 — theme override (highest precedence; deep-merge per field).
  const themeOverride =
    opts.theme?.tools !== undefined ? lookup(opts.theme.tools, toolName) : undefined;
  if (themeOverride !== undefined) {
    if (themeOverride.semanticPhase !== undefined) semanticPhase = themeOverride.semanticPhase;
    ({ label, detail, detailKeys } = mergeActionFields(
      { label, detail, detailKeys },
      themeOverride,
    ));
  }

  return {
    semanticPhase,
    label,
    ...(detail !== undefined ? { detail } : {}),
    ...(detailKeys !== undefined ? { detailKeys } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedFields {
  label: string;
  detail: string | undefined;
  detailKeys: readonly string[] | undefined;
}

/**
 * Deep-merge one layer's label fields onto the accumulator: a defined field on
 * `next` wins; an undefined field leaves the accumulator's value intact (this
 * is the "override one field, inherit the rest" semantics of ACT-08).
 */
function mergeActionFields(base: ResolvedFields, next: ActionLabelSpec): ResolvedFields {
  return {
    label: next.label ?? base.label,
    detail: next.detail ?? base.detail,
    detailKeys: next.detailKeys ?? base.detailKeys,
  };
}

/**
 * Read a value from a string-keyed record by an own-property key. Returns
 * `undefined` for absent or inherited keys — guards against prototype-chain
 * access (no object-injection sink).
 */
function lookup<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return Object.entries(record).find(([k]) => k === key)?.[1];
}

/**
 * Turn a snake_cased tool name into a humanized fallback label (e.g.
 * `web_search` → `web search`). Used only when no registered spec or theme
 * supplies a label, so a fallback resolution always yields a non-empty string.
 */
function humanizeToolName(toolName: string): string {
  const humanized = toolName.replace(/_/g, " ").trim();
  return humanized.length > 0 ? humanized : "running tool";
}
