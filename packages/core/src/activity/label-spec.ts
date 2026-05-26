// SPDX-License-Identifier: Apache-2.0
/**
 * label-spec — the {@link LabelSpec} type (consumed by the template engine,
 * plan 70-04 Task 1). The registry (`registerActivityLabelSpec`) and the
 * theme-merge resolver (`resolveLabelSpec`) are added in Task 2.
 *
 * Pure domain: no logger, no I/O, no channel coupling.
 *
 * @module
 */
import type { SemanticPhase } from "./semantic-classifier.js";

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
