// SPDX-License-Identifier: Apache-2.0
/**
 * label-spec — the activity {@link LabelSpec} type plus the module-level
 * registry ({@link registerActivityLabelSpec}) and the theme-merge resolver
 * ({@link resolveLabelSpec}).
 *
 * The registry mirrors the verified `core/tool-metadata.ts` idiom: a
 * module-level `Map` keyed by tool name, written via spread-merge so different
 * sources can register different fields for the same tool incrementally.
 *
 * Resolution precedence is **theme-override > registered spec > semantic
 * fallback**, applied as a deep merge: each layer's defined fields
 * win and undefined fields inherit, so a theme that overrides only the label
 * preserves the registered detail/detailKeys. A theme cannot remove the
 * allowlist — it can only add/replace fields.
 *
 * Pure domain: no logger, no I/O, no channel coupling. The template engine
 * consumes the resolved {@link LabelSpec}; the observability
 * label-resolver is the production caller of {@link resolveLabelSpec}.
 *
 * @module
 */
import { classifySemanticPhase, type SemanticPhase } from "./semantic-classifier.js";

/**
 * A resolved activity label spec — the shape {@link import("./template-engine.js").applyTemplate}
 * consumes. `label`/`detail` are `{key}`-placeholder
 * templates; `detailKeys` is the param-key allowlist the template engine
 * enforces (every other params key is dropped at the gate).
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
  /**
   * Optional override hook. Receives RAW params — the transform is responsible
   * for its own redaction (e.g. parseShellCommand at shell-label-parser.ts:40
   * self-redacts via redactValue at line 53). Returned string MUST be safe to
   * render. applyTemplate runs redactValue on the output defense-in-depth.
   */
  readonly transform?: (params: Readonly<Record<string, unknown>>) => string;
}

/**
 * Per-action label fields. A registered spec may declare a default
 * (tool-level) label and/or per-action overrides (the `actions` block).
 */
export interface ActionLabelSpec {
  /** Label template for this action (e.g. `configuring MCP server \`{name}\``). */
  readonly label?: string;
  /** Detail template for this action. */
  readonly detail?: string;
  /** Param-key allowlist for this action's templates. */
  readonly detailKeys?: readonly string[];
  /**
   * Optional override hook. Receives RAW params — the transform is responsible
   * for its own redaction (e.g. parseShellCommand at shell-label-parser.ts:40
   * self-redacts via redactValue at line 53). Returned string MUST be safe to
   * render. applyTemplate runs redactValue on the output defense-in-depth.
   */
  readonly transform?: (params: Readonly<Record<string, unknown>>) => string;
}

/**
 * The shape passed to {@link registerActivityLabelSpec}. All fields
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
 * Theme-supplied status markers. A theme overrides the default status
 * glyphs (the `✓`/`❌`/`🤖`/running markers) that surface in activity labels.
 * The ascii theme supplies emoji-free markers so "ASCII strips all emoji"
 * holds. These are advisory display strings, NOT part of the label
 * allowlist/merge — the resolved marker is baked into
 * {@link import("./activity-event.js").ActivityEvent}.defaultLabel upstream of
 * the channel painter, so {@link resolveLabelSpec} never reads them.
 *
 * All four fields are REQUIRED within this type: a theme that opts into markers
 * supplies the full set (no partial-marker ambiguity). The field on
 * {@link ActivityTheme} that carries this is itself optional (purely additive).
 */
export interface ActivityStatusMarkers {
  /** Marker for a completed/successful event (default theme: "✓"). */
  readonly success: string;
  /** Marker for a failed event (default theme: "❌"). */
  readonly failure: string;
  /** Marker prefix for a subagent event (default theme: "🤖"). */
  readonly subagent: string;
  /** Marker for an in-flight/running event (default theme: e.g. a wrench). */
  readonly running: string;
  /**
   * Separator between an event label and its
   * coalesced-group count (e.g. `reading config ×3`). Defaults to `"×"` U+00D7
   * for the default/playful/terminal-minimal themes; the ascii theme overrides
   * to `"x"` (lowercase Latin) so the strict ASCII-parity test
   * (`packages/channels/src/shared/strategies/ascii-parity.test.ts`,
   * `/[^\x00-\x7F]/`) passes. Optional for forward-compatibility:
   * a custom theme that omits this field falls back to the default `"×"`.
   */
  readonly surrogateSeparator?: string;
}

/**
 * An operator activity theme. Rebrands per-tool labels without
 * touching code via `agents.<id>.activity.theme`. A theme override deep-merges
 * ON TOP of the registered spec / semantic fallback — overridden fields win,
 * the rest inherit. It can add or replace fields but cannot strip the allowlist.
 */
export interface ActivityTheme {
  /** Per-tool overrides, keyed by tool name. */
  readonly tools?: Readonly<Record<string, RegisteredLabelSpec>>;
  /**
   * Status-marker overrides. Optional — a theme without markers
   * inherits the default glyphs. Consumed by the observability layer,
   * NOT by {@link resolveLabelSpec} (markers are a parallel
   * advisory tier, never part of the label-merge).
   */
  readonly markers?: ActivityStatusMarkers;
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
 * Returns `true` iff a label spec was **explicitly registered** for `toolName`
 * via {@link registerActivityLabelSpec}. Introspects the registry `Map`
 * directly (mirrors the `getToolMetadata` idiom in tool-metadata.ts).
 *
 * This is the coverage-gate primitive: {@link resolveLabelSpec} is
 * TOTAL — it always returns a humanized fallback — so "did resolution succeed?"
 * is a no-op check. The transparency gate must ask "was a spec registered?",
 * which is exactly this predicate.
 */
export function hasRegisteredLabelSpec(toolName: string): boolean {
  return registry.has(toolName);
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
 * applying the precedence **theme-override > registered > pattern catch-all
 * > semantic fallback** as a deep, per-field merge.
 *
 * The pattern catch-all (Layer 2.5; see {@link tryPatternSpec}) only fires when
 * no spec is registered for the tool name, so an explicit
 * {@link registerActivityLabelSpec} call (Layer 2) and a theme override
 * (Layer 3) both still win above it.
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
  let transform: ((params: Readonly<Record<string, unknown>>) => string) | undefined;

  // Layer 2 — registered spec (tool-level first, then the per-action override).
  const registered = registry.get(toolName);
  if (registered !== undefined) {
    if (registered.semanticPhase !== undefined) semanticPhase = registered.semanticPhase;
    ({ label, detail, detailKeys, transform } = mergeActionFields(
      { label, detail, detailKeys, transform },
      registered,
    ));
    const action = opts.action;
    if (action !== undefined && registered.actions !== undefined) {
      const actionSpec = lookup(registered.actions, action);
      if (actionSpec !== undefined) {
        ({ label, detail, detailKeys, transform } = mergeActionFields(
          { label, detail, detailKeys, transform },
          actionSpec,
        ));
      }
    }
  } else {
    // Layer 2.5 — pattern catch-all. Only fires when no spec is
    // explicitly registered, so Layer 2 still wins. Theme override (Layer 3)
    // still deep-merges on top.
    const pattern = tryPatternSpec(toolName);
    if (pattern !== undefined) {
      if (pattern.semanticPhase !== undefined) semanticPhase = pattern.semanticPhase;
      ({ label, detail, detailKeys, transform } = mergeActionFields(
        { label, detail, detailKeys, transform },
        pattern,
      ));
    }
  }

  // Layer 3 — theme override (highest precedence; deep-merge per field).
  const themeOverride =
    opts.theme?.tools !== undefined ? lookup(opts.theme.tools, toolName) : undefined;
  if (themeOverride !== undefined) {
    if (themeOverride.semanticPhase !== undefined) semanticPhase = themeOverride.semanticPhase;
    ({ label, detail, detailKeys, transform } = mergeActionFields(
      { label, detail, detailKeys, transform },
      themeOverride,
    ));
  }

  return {
    semanticPhase,
    label,
    ...(detail !== undefined ? { detail } : {}),
    ...(detailKeys !== undefined ? { detailKeys } : {}),
    ...(transform !== undefined ? { transform } : {}),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ResolvedFields {
  label: string;
  detail: string | undefined;
  detailKeys: readonly string[] | undefined;
  transform: ((params: Readonly<Record<string, unknown>>) => string) | undefined;
}

/**
 * Deep-merge one layer's label fields onto the accumulator: a defined field on
 * `next` wins; an undefined field leaves the accumulator's value intact (this
 * is the "override one field, inherit the rest" semantics).
 */
function mergeActionFields(base: ResolvedFields, next: ActionLabelSpec): ResolvedFields {
  return {
    label: next.label ?? base.label,
    detail: next.detail ?? base.detail,
    detailKeys: next.detailKeys ?? base.detailKeys,
    transform: next.transform ?? base.transform,
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

/**
 * Pattern catch-all for dynamically-discovered tool names that have no
 * co-located source file to register a label spec on (e.g. MCP tools, which
 * are discovered at runtime). Currently matches `^mcp__<server>--<method>$`
 * and synthesizes a clean `using <server> · <method humanized>` label.
 *
 * Pure function; returns `undefined` when no pattern matches so the resolver
 * falls through to the semantic-classifier humanize fallback. Invoked from
 * {@link resolveLabelSpec} as Layer 2.5 — only when no spec is registered
 * for the tool name, so explicit registrations (Layer 2) and theme overrides
 * (Layer 3) still win.
 *
 * The server-name segment cannot contain `-` (the regex's `[^-]+` capture),
 * so `--` is unambiguous as the method separator. The method segment is
 * humanized via `_` → ` ` AND `-` → ` ` so `mcp__svc--foo-bar` cleanly
 * yields `"using svc · foo bar"` rather than leaking the dash.
 */
function tryPatternSpec(toolName: string): RegisteredLabelSpec | undefined {
  const mcp = /^mcp__([^-]+)--(.+)$/.exec(toolName);
  if (mcp !== null) {
    const server = mcp[1] ?? "";
    const method = (mcp[2] ?? "").replace(/_/g, " ").replace(/-/g, " ").trim();
    return { semanticPhase: "tool", label: `using ${server} · ${method}` };
  }
  return undefined;
}
