// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 24 behavioral-metric aggregator (OBS-CAP-03).
 *
 * Computes per-provider rates for the four OBS-CAP-03 metrics from a typed
 * event stream:
 *
 *   1. firstNonDiscoveryActionIsMcp
 *      First non-discovery tool call: name matches `mcp__*--*` (i.e.,
 *      `extractMcpServerName(name)` returns non-undefined).
 *
 *   2. firstNonDiscoveryActionIsInstall
 *      First non-discovery tool call: tool === "exec" AND command parses as
 *      install via the leading-token rule (pip/pip3, python -m pip, npm,
 *      pnpm, yarn).
 *
 *   3. installBeforeFirstMcpDataFetch
 *      First exec install timestamp < first finance-data MCP fetch timestamp.
 *
 *   4. installDetourHintCoverage
 *      Among rounds with at least one tool:install_detour_detected event of
 *      action: "hinted", did the Wave-3 caller record at least one `true` in
 *      hintAugmentations[]? Phase 24's Wave-3 caller (24-05) records `true`
 *      per hinted event by construction (the structurally-constant fallback);
 *      v1 reports the rate as 1.0 by design. The metric DEFINITION is
 *      verified at the unit-test level via synthetic event streams in
 *      metric-aggregator.test.ts (RoundSignals.installDetourHintCoverage =
 *      true / false / null cases).
 *
 * Discovery-action classifier (RESEARCH §3.6 -- closed list + regex):
 *   - Fixed names: discover_tools, tool_search_tool_regex, mcp_list_tools.
 *   - Regex: /^(list|search|discover|find).*tool/i.
 *
 * The aggregator lives under test/support/ (NOT packages/*\/src/) per
 * RESEARCH §5.9 -- Phase 19's DEFER-04 architecture-grep blocks
 * `discover_tools` / `tool_search_tool_regex` literals in production source.
 *
 * Install classifier scope: "is this an install command?" only. Detour
 * overlap detection is the production parser's job (parseInstallDetour) --
 * this helper does NOT need to know about overlaps to classify install vs
 * non-install events for the OBS-CAP-03 first-action contract. This is a
 * deliberate design choice: parseInstallDetour returns null when no overlap
 * is detected (install-detour.ts:143), so passing a no-op port would
 * misclassify every install command as non-install. The leading-token rule
 * here mirrors install-detour.ts:232-268 (parseInstallSegment).
 *
 * @module
 */

import { extractMcpServerName } from "@comis/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Subset of tool:executed event fields used by the aggregator. */
export interface ToolEvent {
  readonly toolName: string;
  readonly timestamp: number;
  readonly success?: boolean;
  readonly params?: Record<string, unknown>;
}

/** Subset of tool:install_detour_detected event fields used by the aggregator. */
export interface InstallDetourEvent {
  readonly action:
    | "observed"
    | "hinted"
    | "soft_stopped"
    | "override_requested"
    | "overridden"
    | "override_denied";
  readonly mode: "observe" | "advise" | "soft-stop";
  readonly timestamp: number;
}

/**
 * Per-round binary signals.
 *
 * `installDetourHintCoverage` is `null` when the round had no
 * overlap-triggering install (no "hinted" events); the aggregator excludes
 * null rounds from the rate denominator.
 */
export interface RoundSignals {
  firstNonDiscoveryActionIsMcp: boolean;
  firstNonDiscoveryActionIsInstall: boolean;
  installBeforeFirstMcpDataFetch: boolean;
  /** null when no overlap-triggering install ran in the round. */
  installDetourHintCoverage: boolean | null;
}

/** Per-metric aggregate emitted in the JSON report. */
export interface ProviderReport {
  rounds: number;
  firstNonDiscoveryActionIsMcp: { rate: number; count: number };
  firstNonDiscoveryActionIsInstall: { rate: number; count: number };
  installBeforeFirstMcpDataFetch: { rate: number; count: number };
  installDetourHintCoverage: { rate: number; count: number };
}

/** Top-level JSON report written by the Wave-3 behavioral suite. */
export interface MetricsReport {
  providers: Record<string, ProviderReport>;
  totalRounds: number;
  fixturesRun: string[];
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Classifiers (exported -- consumed by the Wave-3 behavioral suite)
// ---------------------------------------------------------------------------

/** Closed discovery-tool name list (RESEARCH §3.6). */
const FIXED_DISCOVERY_NAMES: ReadonlySet<string> = new Set([
  "discover_tools",
  "tool_search_tool_regex",
  "mcp_list_tools",
]);
// Match snake_case / kebab-case forms only -- require an explicit separator
// before "tool". The earlier `^(list|search|discover|find).*tool/i` matched
// camelCase names like `findFootprintTool` and `searchengine_for_a_cool_tool`
// because `.*` greedy-consumed everything before "tool". This rules them out
// while still matching the deliberate discovery-style names in the unit tests
// (`list_tools`, `search_for_tool`, `find_my_tool`, `discover_my_tool`).
const DISCOVERY_PATTERN =
  /^(list|search|discover|find)(?:[_-][a-z]+)*[_-]tools?$/i;

/**
 * Classify a tool name as a discovery action.
 *
 * Discovery actions are excluded from the "first non-discovery action"
 * metric -- they're scaffolding, not capability use.
 */
export function isDiscoveryTool(toolName: string): boolean {
  return FIXED_DISCOVERY_NAMES.has(toolName) || DISCOVERY_PATTERN.test(toolName);
}

/**
 * Classify a tool name as an MCP-bridged tool call.
 *
 * Returns true iff `toolName` matches the canonical sanitized MCP form
 * `mcp__server--tool` (per @comis/shared/extractMcpServerName).
 */
export function isMcpTool(toolName: string): boolean {
  return extractMcpServerName(toolName) !== undefined;
}

/**
 * Classify an exec call as an install command using the design §8.1
 * leading-token rule.
 *
 * Mirrors install-detour.ts:232-268 (parseInstallSegment). This is the
 * "is this an install command?" question only -- it does NOT consult
 * connected-MCP overlaps, which is a separate concern owned by the
 * production parseInstallDetour.
 *
 * Recognized forms:
 *   pip install ...        | pip3 install ...
 *   python -m pip install ... | python3 -m pip install ...
 *   npm install ... | npm i ... | npm add ...
 *   pnpm install ... | pnpm add ...
 *   yarn add ...
 *
 * Quoted strings, command substitution, heredocs, npx, pwsh -c, and
 * standalone `python -m foo` invocations all return false.
 */
export function isInstallExec(
  toolName: string,
  params: Record<string, unknown> | undefined,
): boolean {
  if (toolName !== "exec") return false;
  const cmd =
    typeof params?.["command"] === "string" ? (params["command"] as string) : "";
  if (cmd === "") return false;
  return isInstallCommand(cmd);
}

/** Returns true when toolName is a finance-data MCP DATA-FETCH (not a discovery call). */
function isFinanceDataMcpFetch(toolName: string): boolean {
  const server = extractMcpServerName(toolName);
  return server === "finance-data" && !isDiscoveryTool(toolName);
}

/**
 * Inline leading-token install-form detector (mirrors install-detour.ts
 * `parseInstallSegment`).
 *
 * Whitespace-tokenizes the command and inspects the leading tokens. Returns
 * true iff the command shape matches a recognized install form. Does not
 * tokenize package args or check for overlaps -- that's the production
 * parser's job. Pure function, no module state.
 */
function isInstallCommand(command: string): boolean {
  // Reject commands with shell-meta segments that the design defers to the
  // top-level segment splitter. We accept simple top-level forms only.
  // (The aggregator's contract is per-event classification, not policy.)
  const tokens = command.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < 2) return false;

  const lead = tokens[0];
  if (lead === "pip" || lead === "pip3") {
    return tokens[1] === "install";
  }
  if (lead === "python" || lead === "python3") {
    // python -m pip install ...
    return (
      tokens[1] === "-m" && tokens[2] === "pip" && tokens[3] === "install"
    );
  }
  if (lead === "npm") {
    const verb = tokens[1];
    return verb === "install" || verb === "i" || verb === "add";
  }
  if (lead === "pnpm") {
    const verb = tokens[1];
    return verb === "install" || verb === "add";
  }
  if (lead === "yarn") {
    return tokens[1] === "add";
  }
  return false;
}

// ---------------------------------------------------------------------------
// Pure round-signal computation
// ---------------------------------------------------------------------------

/**
 * Convert raw event captures into the four binary RoundSignals.
 *
 * @param events            All tool:executed events captured during the round (any order; sorted internally by timestamp).
 * @param detourEvents      All tool:install_detour_detected events captured during the round.
 * @param hintAugmentations Booleans recorded by the Wave-3 caller per hinted event: did the result envelope carry details.installDetourHint?
 */
export function computeRoundSignals(
  events: readonly ToolEvent[],
  detourEvents: readonly InstallDetourEvent[],
  hintAugmentations: readonly boolean[],
): RoundSignals {
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const firstNonDiscovery = sorted.find((e) => !isDiscoveryTool(e.toolName));

  const firstNonDiscoveryActionIsMcp =
    firstNonDiscovery !== undefined && isMcpTool(firstNonDiscovery.toolName);
  const firstNonDiscoveryActionIsInstall =
    firstNonDiscovery !== undefined &&
    isInstallExec(firstNonDiscovery.toolName, firstNonDiscovery.params);

  const firstInstall = sorted.find((e) => isInstallExec(e.toolName, e.params));
  const firstFinanceFetch = sorted.find((e) => isFinanceDataMcpFetch(e.toolName));
  const installBeforeFirstMcpDataFetch =
    firstInstall !== undefined &&
    firstFinanceFetch !== undefined &&
    firstInstall.timestamp < firstFinanceFetch.timestamp;

  // Install-detour-hint coverage:
  // - null when no overlap-triggering install ran in the round (denominator excludes).
  // - true iff every recorded augmentation flag is true (every hinted overlap had
  //   a corresponding hint augmentation in the result envelope).
  // - false otherwise.
  // The Wave-3 caller (24-05) records hintAugmentations.length === hintedCount by
  // construction; v1 reports the rate as structurally constant -- see module JSDoc.
  const hintedCount = detourEvents.filter((e) => e.action === "hinted").length;
  let installDetourHintCoverage: boolean | null;
  if (hintedCount === 0) {
    installDetourHintCoverage = null;
  } else if (hintAugmentations.length === 0) {
    installDetourHintCoverage = false;
  } else {
    installDetourHintCoverage = hintAugmentations.every(Boolean);
  }

  return {
    firstNonDiscoveryActionIsMcp,
    firstNonDiscoveryActionIsInstall,
    installBeforeFirstMcpDataFetch,
    installDetourHintCoverage,
  };
}

// ---------------------------------------------------------------------------
// Aggregator class
// ---------------------------------------------------------------------------

/**
 * Per-provider RoundSignals accumulator.
 *
 * The aggregator does NOT enforce a round count -- that's the test's job
 * (driven by parseRoundsPerProvider() in test-providers.ts). The aggregator
 * just records whatever recordRound calls happen and computes rates on
 * finalize.
 */
export class MetricAggregator {
  private readonly byProvider = new Map<string, RoundSignals[]>();

  /**
   * Record one round's signals for a provider. Mutates the aggregator.
   */
  recordRound(provider: string, signals: RoundSignals): void {
    const existing = this.byProvider.get(provider) ?? [];
    existing.push(signals);
    this.byProvider.set(provider, existing);
  }

  /**
   * Number of rounds recorded for a provider. Returns 0 for unknown providers.
   */
  roundCount(provider: string): number {
    return this.byProvider.get(provider)?.length ?? 0;
  }

  /**
   * Compute the JSON report from all recorded rounds.
   *
   * @param fixturesRun Names of fixtures driven during the run -- copied
   *                    verbatim into the report's `fixturesRun` field.
   */
  finalize(fixturesRun: readonly string[]): MetricsReport {
    const providers: Record<string, ProviderReport> = {};
    let totalRounds = 0;

    for (const [provider, rounds] of this.byProvider.entries()) {
      totalRounds += rounds.length;
      providers[provider] = {
        rounds: rounds.length,
        firstNonDiscoveryActionIsMcp: rateOf(
          rounds,
          (s) => s.firstNonDiscoveryActionIsMcp,
        ),
        firstNonDiscoveryActionIsInstall: rateOf(
          rounds,
          (s) => s.firstNonDiscoveryActionIsInstall,
        ),
        installBeforeFirstMcpDataFetch: rateOf(
          rounds,
          (s) => s.installBeforeFirstMcpDataFetch,
        ),
        installDetourHintCoverage: rateOfNullable(
          rounds,
          (s) => s.installDetourHintCoverage,
        ),
      };
    }

    return {
      providers,
      totalRounds,
      fixturesRun: [...fixturesRun],
      // ISO-8601 UTC -- no PII, no local-time leak (T-24-04-02 disposition: accept).
      timestamp: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rateOf(
  rounds: readonly RoundSignals[],
  pick: (s: RoundSignals) => boolean,
): { rate: number; count: number } {
  if (rounds.length === 0) return { rate: 0, count: 0 };
  const count = rounds.reduce((acc, r) => acc + (pick(r) ? 1 : 0), 0);
  return { rate: count / rounds.length, count };
}

function rateOfNullable(
  rounds: readonly RoundSignals[],
  pick: (s: RoundSignals) => boolean | null,
): { rate: number; count: number } {
  const applicable = rounds.filter((r) => pick(r) !== null);
  if (applicable.length === 0) return { rate: 0, count: 0 };
  const count = applicable.reduce(
    (acc, r) => acc + (pick(r) === true ? 1 : 0),
    0,
  );
  return { rate: count / applicable.length, count };
}
