// SPDX-License-Identifier: Apache-2.0
/**
 * FLOOR-01 (Phase 176): boot-time minViable viable-floor check.
 *
 * Computes
 *   minViable = bootstrapTotalTokens + toolSchemaTokens + outputHeadroomFloor
 *             + freshTailReserve + safetyMargin
 * per agent at boot and emits ONE WARN when the effective context window cannot
 * fit even the scaffold floor — so an infeasible window surfaces at boot instead
 * of on the first real message (the CWF-02 preflight runs only at turn time).
 *
 * I8 single-sourcing: every term imports its turn-time home module — never a
 * parallel formula. {@link VIABLE_FLOOR_SHARED_SOURCES} is the drift-pin
 * surface: viable-floor.test.ts asserts FUNCTION-REFERENCE IDENTITY against
 * each home module, so a re-derived local copy cannot pass (Pitfall 8).
 * WR-03 extends I8 from the formula to its INPUT: the toolSchemaTokens term
 * measures the same CONVERTED ToolDefinition corpus the turn-time S estimate
 * measures (lean descriptions + guidelines) via
 * {@link AgentBootWindowInfo.convertTools} — the daemon binds the executor's
 * own convertTools closure, so formula AND corpus are shared.
 *
 * WARN-only (I1/D-02 adapt-down moat): this module never throws on the
 * infeasible branch and never refuses boot. The daemon wiring (plan 176-05)
 * wraps the per-agent evaluation in a fail-open try/catch and threads
 * {@link collectAgentBootWindowInfo} beside the per-agent registry.
 *
 * @module
 */

import { toolDefOverheadChars } from "../executor/tool-overhead.js";
import type { ToolOverheadInput } from "../executor/tool-overhead.js";
import { computeOutputHeadroom } from "./output-headroom.js";
import {
  CHARS_PER_TOKEN_RATIO,
  SAFETY_MARGIN_PERCENT,
  MIN_SAFETY_MARGIN_TOKENS,
} from "./constants.js";
import { resolveEffectiveContextWindow } from "../model/effective-context-window.js";
import { resolveModelProfile } from "../executor/model-profile.js";
import type { ModelProfile, CapabilityClass } from "../executor/model-profile.js";
import { resolveScaffoldDefaults } from "../executor/scaffold-defaults.js";
import { DEFAULT_EFFECTIVE_CAP_BY_CLASS } from "./budget-capacity-cap.js";
import { PREAMBLE_WARN_THRESHOLD_BY_CLASS } from "../executor/executor-tool-assembly.js";
import { normalizeModelId } from "../provider/model-id-normalize.js";

// ---------------------------------------------------------------------------
// I8 drift-pin surface
// ---------------------------------------------------------------------------

/**
 * Drift-pin surface (I8/R-3): the floor's term functions ARE these imports.
 * viable-floor.test.ts asserts reference identity against each home module —
 * a re-derived local copy cannot pass.
 */
export const VIABLE_FLOOR_SHARED_SOURCES = {
  toolDefOverheadChars,
  computeOutputHeadroom,
  resolveEffectiveContextWindow,
  resolveScaffoldDefaults,
  resolveModelProfile,
  PREAMBLE_WARN_THRESHOLD_BY_CLASS,
  CHARS_PER_TOKEN_RATIO,
  SAFETY_MARGIN_PERCENT,
  MIN_SAFETY_MARGIN_TOKENS,
} as const;

// ---------------------------------------------------------------------------
// Boot-side window/profile resolution (the pi-executor mirror)
// ---------------------------------------------------------------------------

/** Per-agent boot window snapshot — the inputs the floor evaluation consumes. */
export interface AgentBootWindowInfo {
  agentId: string;
  providerId: string;
  /** The normalize-resolved model id (the id the registry find ran against). */
  modelId: string;
  /** Registry-enriched configured window (`find(...)?.contextWindow ?? 8_192`). */
  configuredWindow: number;
  /** Probe-served window — undefined when the probe did not run for this provider. */
  served?: number;
  /** min(configured, served?, capabilityCap) — same resolver as pi-executor. */
  effectiveWindow: number;
  /** Which constraint bound the effective window. */
  windowSource: "served" | "capability" | "configured";
  /** Profile resolved on the RECONCILED window, exactly like pi-executor.ts:363-368. */
  modelProfile: ModelProfile;
  /** bootstrapTotalMaxChars ?? bootstrapMaxChars from resolveScaffoldDefaults (A2). */
  scaffoldBootstrapChars: number;
  /** contextEngine.budget.minVisibleOutputTokens when configured. */
  minVisibleOutputTokens?: number;
  /** WR-03 (176 review): convert the raw boot toolset to the SAME
   *  ToolDefinition corpus the turn-time S estimate measures (lean-description
   *  swap + promptGuidelines append — tool-definition-adapter.ts). The daemon
   *  wiring binds the EXACT closure PiExecutorDeps.convertTools receives, so
   *  the boot toolSchemaTokens term and the turn-time S term measure ONE
   *  corpus by construction (I8 extended from the formula to its input —
   *  pre-fix the boot term ran the shared reduce over RAW descriptions, which
   *  are typically much longer than lean ones, systematically over-counting).
   *  Absent ⇒ the floor measures the raw toolset (conservative over-count;
   *  production wiring always binds it). */
  convertTools?: (tools: ReadonlyArray<ToolOverheadInput>) => ReadonlyArray<ToolOverheadInput>;
}

/**
 * Resolve the boot-side window + profile snapshot for one agent — the boot
 * mirror of the executor's turn-time resolution chain (pi-executor.ts:344-368):
 * normalize → registry find → capability cap (ONLY when the operator pinned
 * capabilityClass) → resolveEffectiveContextWindow → resolveModelProfile on the
 * RECONCILED window → resolveScaffoldDefaults.
 *
 * Mirroring the executor by construction (same resolver imports, same `?? 8_192`
 * fallback, same normalize step) means the boot floor and the first real turn
 * cannot disagree about the window (Pitfall 5).
 */
export function collectAgentBootWindowInfo(params: {
  agentId: string;
  providerId: string;
  modelId: string;
  /** The per-agent pi ModelRegistry find (registry-enriched contextWindow). */
  findModel: (
    provider: string,
    modelId: string,
  ) =>
    | {
        id: string;
        provider: string;
        contextWindow?: number;
        maxTokens?: number;
        reasoning?: boolean;
        input?: readonly string[];
      }
    | undefined;
  /** servedWindowByProvider.get(providerId) — undefined when the probe did not run. */
  served: number | undefined;
  /** providers.entries.<id>.capabilities.capabilityClass — the operator pin. */
  explicitCapabilityClass: string | undefined;
  /** PerAgentConfig — scaffold + budget knobs (read defensively). */
  agentConfig: Parameters<typeof resolveScaffoldDefaults>[1];
  /** WR-03: the executor's convertTools closure — see AgentBootWindowInfo.convertTools. */
  convertTools?: (tools: ReadonlyArray<ToolOverheadInput>) => ReadonlyArray<ToolOverheadInput>;
}): AgentBootWindowInfo {
  const normalizedId = normalizeModelId(params.providerId, params.modelId).modelId;
  const resolved = params.findModel(params.providerId, normalizedId);
  const configured = resolved?.contextWindow ?? 8_192;
  // Capability cap ONLY when the operator explicitly pinned a class — mirrors
  // pi-executor.ts:344-347 (no pin → Infinity → no class constraint).
  const explicitClass = params.explicitCapabilityClass;
  const capabilityCap =
    explicitClass != null ? (DEFAULT_EFFECTIVE_CAP_BY_CLASS[explicitClass] ?? Infinity) : Infinity;
  const { effectiveWindow, source } = resolveEffectiveContextWindow({
    configured,
    served: params.served,
    capabilityCap,
  });
  const modelProfile = resolveModelProfile(
    resolved ? { ...resolved, contextWindow: effectiveWindow } : undefined,
    explicitClass as CapabilityClass | undefined,
  );
  const scaffold = resolveScaffoldDefaults(modelProfile, params.agentConfig);
  // A2: small/nano → bootstrapTotalMaxChars (5_000); frontier/mid → undefined,
  // fall back to bootstrapMaxChars (always a number — the 20_000 sentinel).
  const scaffoldBootstrapChars = scaffold.bootstrapTotalMaxChars ?? scaffold.bootstrapMaxChars;
  const minVisibleOutputTokens = params.agentConfig.contextEngine?.budget?.minVisibleOutputTokens;
  return {
    agentId: params.agentId,
    providerId: params.providerId,
    modelId: normalizedId,
    configuredWindow: configured,
    served: params.served,
    effectiveWindow,
    windowSource: source,
    modelProfile,
    scaffoldBootstrapChars,
    minVisibleOutputTokens,
    ...(params.convertTools !== undefined && { convertTools: params.convertTools }),
  };
}

// ---------------------------------------------------------------------------
// The minViable equation (pure)
// ---------------------------------------------------------------------------

/** The five named terms, their sum, and the largest term's name. */
export interface MinViableEquation {
  terms: {
    bootstrapTotalTokens: number;
    toolSchemaTokens: number;
    outputHeadroomFloor: number;
    freshTailReserve: number;
    safetyMargin: number;
  };
  minViable: number;
  dominantTerm: keyof MinViableEquation["terms"];
}

/**
 * Compute the boot minViable equation. Pure — no I/O, no logging.
 *
 * Every term is single-sourced from its turn-time home (I8):
 *   - bootstrapTotalTokens: scaffold chars ÷ CHARS_PER_TOKEN_RATIO (constants.ts)
 *   - toolSchemaTokens: toolDefOverheadChars (tool-overhead.ts — the same function
 *     the turn-time S estimate uses) ÷ CHARS_PER_TOKEN_RATIO
 *   - outputHeadroomFloor: computeOutputHeadroom (output-headroom.ts) at the
 *     post-downshift MINIMUM level — the governor floors native reasoning at
 *     "low" (downshiftThinkingLevel), so "low" is the honest floor; "none"
 *     reserves the visible floor only. WARN only when even the floor cannot fit.
 *   - freshTailReserve: PREAMBLE_WARN_THRESHOLD_BY_CLASS (executor-tool-assembly.ts)
 *   - safetyMargin: the token-budget.ts M formula (SAFETY_MARGIN_PERCENT +
 *     MIN_SAFETY_MARGIN_TOKENS) against the boot effectiveWindow
 */
export function computeMinViableEquation(params: {
  tools: ReadonlyArray<ToolOverheadInput>;
  scaffoldBootstrapChars: number;
  reasoningStyle: "none" | "native";
  capabilityClass: string;
  effectiveWindow: number;
  minVisibleOutputTokens?: number;
}): MinViableEquation {
  const bootstrapTotalTokens = Math.ceil(params.scaffoldBootstrapChars / CHARS_PER_TOKEN_RATIO);
  const toolSchemaTokens = Math.ceil(toolDefOverheadChars(params.tools) / CHARS_PER_TOKEN_RATIO);

  // Post-downshift minimum thinking level: native → "low", none → "off".
  // When minVisibleOutputTokens is not configured, call with TWO args so
  // computeOutputHeadroom's own default (MIN_VISIBLE_OUTPUT_TOKENS) applies —
  // single-source; do NOT re-import the default here.
  const floorLevel = params.reasoningStyle === "native" ? "low" : "off";
  const outputHeadroomFloor =
    params.minVisibleOutputTokens === undefined
      ? computeOutputHeadroom(params.reasoningStyle, floorLevel)
      : computeOutputHeadroom(params.reasoningStyle, floorLevel, params.minVisibleOutputTokens);

  // A1: the per-class preamble threshold doubles as the fresh-tail reserve.
  // frontier's Infinity means "the preamble WARN never fires", NOT "infinite
  // preamble" — mapping Infinity → 0 keeps frontier's minViable finite and its
  // boot WARN practically unreachable (R-4: healthy boots stay silent).
  const thresholdByClass: Readonly<Record<string, number>> = PREAMBLE_WARN_THRESHOLD_BY_CLASS;
  const threshold = thresholdByClass[params.capabilityClass] ?? 0;
  const freshTailReserve = Number.isFinite(threshold) ? threshold : 0;

  // The token-budget.ts:84-87 M formula against the boot effectiveWindow.
  const safetyMargin = Math.max(
    Math.ceil((params.effectiveWindow * SAFETY_MARGIN_PERCENT) / 100),
    MIN_SAFETY_MARGIN_TOKENS,
  );

  const terms = {
    bootstrapTotalTokens,
    toolSchemaTokens,
    outputHeadroomFloor,
    freshTailReserve,
    safetyMargin,
  };
  const minViable =
    bootstrapTotalTokens + toolSchemaTokens + outputHeadroomFloor + freshTailReserve + safetyMargin;

  // Dominant term: max value; FIRST wins on tie (fixed key order as listed).
  const ordered: ReadonlyArray<readonly [keyof MinViableEquation["terms"], number]> = [
    ["bootstrapTotalTokens", bootstrapTotalTokens],
    ["toolSchemaTokens", toolSchemaTokens],
    ["outputHeadroomFloor", outputHeadroomFloor],
    ["freshTailReserve", freshTailReserve],
    ["safetyMargin", safetyMargin],
  ];
  let dominant = ordered[0];
  for (const entry of ordered) {
    if (entry[1] > dominant[1]) dominant = entry;
  }

  return { terms, minViable, dominantTerm: dominant[0] };
}

// ---------------------------------------------------------------------------
// WARN emitter
// ---------------------------------------------------------------------------

/**
 * Evaluate the viable floor for one agent and WARN once when the effective
 * window is below minViable.
 *
 * Healthy (effectiveWindow >= minViable) → returns undefined, emits NOTHING
 * (R-4). Infeasible → ONE structured WARN (I7: every term named with its value,
 * the binding window source, the per-source knob sentence, and — when tool
 * schemas dominate — the active-tool-ceiling lever) and returns the equation.
 *
 * Never throws on the emit path (I1/D-02): errorKind "config" (A5) — the
 * window/scaffold mismatch is configuration, not a runtime resource failure.
 */
export function evaluateViableFloorForAgent(params: {
  info: AgentBootWindowInfo;
  tools: ReadonlyArray<ToolOverheadInput>;
  logger: { warn(obj: Record<string, unknown>, msg: string): void };
}): MinViableEquation | undefined {
  const { info } = params;
  // WR-03: measure the corpus the turn actually ships. The turn-time S term
  // runs the shared toolDefOverheadChars over the CONVERTED ToolDefinition[]
  // (lean descriptions + guidelines, via the executor's convertTools); the
  // daemon loop feeds this function the RAW AgentTool[], so without the same
  // conversion the boot term systematically over-counts (raw descriptions ≫
  // lean) and the WARN false-positives on agents that genuinely fit.
  const floorTools = info.convertTools ? info.convertTools(params.tools) : params.tools;
  const eq = computeMinViableEquation({
    tools: floorTools,
    scaffoldBootstrapChars: info.scaffoldBootstrapChars,
    reasoningStyle: info.modelProfile.reasoningStyle,
    capabilityClass: info.modelProfile.capabilityClass,
    effectiveWindow: info.effectiveWindow,
    minVisibleOutputTokens: info.minVisibleOutputTokens,
  });
  if (info.effectiveWindow >= eq.minViable) {
    return undefined; // R-4: healthy boots stay silent.
  }

  // Per-source knob sentence — fixed-string templates + numbers + knob names
  // only (I7/T-176-08: no schema bodies, no message content, no env values).
  // IN-06 (WR-01 principle): the capability branch leads with the PIN — the
  // boot resolver (like the executor reconcile) reads only
  // DEFAULT_EFFECTIVE_CAP_BY_CLASS[pinned class]; the contextEngine.budget.*
  // caps can only clamp FURTHER and cannot raise this bind, so they are a
  // dead lever here (named only as a does-not-move note).
  const knobSentence =
    info.windowSource === "served"
      ? `Raise the served window: OLLAMA_CONTEXT_LENGTH=${info.configuredWindow} ollama serve, or Modelfile 'PARAMETER num_ctx ${info.configuredWindow}'. `
      : info.windowSource === "capability"
        ? `Pin a higher class (or remove the pin) via providers.entries.${info.providerId}.capabilities.capabilityClass — the contextEngine.budget.* caps do not move this bind. `
        : `Raise the model's configured window: providers.entries.${info.providerId}.models[].contextWindow. `;
  const dominanceSentence =
    eq.dominantTerm === "toolSchemaTokens"
      ? `Tool schemas dominate the floor — reduce the active tool surface: pin capabilityClass (small defers to a 24-tool active ceiling via discover_tools) or disable unused MCP servers / builtin tool groups.`
      : "";

  params.logger.warn(
    {
      agentId: info.agentId,
      effectiveWindow: info.effectiveWindow,
      windowSource: info.windowSource,
      minViable: eq.minViable,
      ...eq.terms,
      dominantTerm: eq.dominantTerm,
      errorKind: "config" as const,
      submodule: "viable-floor",
      hint:
        `minViable = bootstrapTotalTokens(${eq.terms.bootstrapTotalTokens}) + toolSchemaTokens(${eq.terms.toolSchemaTokens})` +
        ` + outputHeadroomFloor(${eq.terms.outputHeadroomFloor}) + freshTailReserve(${eq.terms.freshTailReserve})` +
        ` + safetyMargin(${eq.terms.safetyMargin}) = ${eq.minViable} exceeds effectiveWindow ${info.effectiveWindow}` +
        ` [source: ${info.windowSource}]. ${knobSentence}${dominanceSentence}`,
    },
    "Boot viable-floor check: effective window below minViable — agent will degrade on real turns (WARN-only, boot continues)",
  );
  return eq;
}
