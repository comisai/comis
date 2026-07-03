// SPDX-License-Identifier: Apache-2.0
/**
 * Strict-scope prompt template for `comis config tooling-fill`.
 *
 * Generates the prompt that goes to the local daemon's `/api/chat`. The
 * prompt enforces a strict 2-line response contract: only DESCRIPTION +
 * REPLACES_PACKAGES are emitted; no extra fields, prose, or commentary.
 *
 * Variants:
 *   - "mcp" — describes an MCP server and the npm/pip packages it replaces
 *     (drives the install-detour subsystem).
 *   - "skills" — REFINES an existing SKILL.md description rather than
 *     inventing a new one. replacesPackages is rare for skills but
 *     supported (e.g. a markdown-formatter skill replaces prettier).
 *
 * Pure string template — deterministic, no Date.now, no randomness, no
 * Result wrapping (KISS principle: simplest correct implementation).
 *
 * @module
 */

export type FillKind = "mcp" | "skills";

export interface FillPromptArgs {
  readonly kind: FillKind;
  readonly name: string;
  /** For MCP: the install/run command (e.g. "uvx yfinance-mcp@latest"). */
  readonly mcpCommand?: string;
  /** For skills: the manifest description (refine, don't invent). */
  readonly skillDescription?: string;
  /**
   * Existing description (operator forced refill via --force) — provides
   * context to the agent without requiring it to be preserved.
   */
  readonly currentDescription?: string;
}

/**
 * Single source of truth for the response-format instruction block.
 *
 * Byte-identical across kinds — extracted as a constant so the
 * "block-equality" test is structural, not coincidental. This is the surface
 * that the response-parser.ts grammar reflects.
 */
const RESPONSE_FORMAT_BLOCK = [
  "Respond with EXACTLY two lines, in this order, and nothing else:",
  "",
  "DESCRIPTION: <one-line description, ≤ 120 characters>",
  'REPLACES_PACKAGES: <JSON array of npm/pip package names, e.g. ["yfinance", "yahoo-finance2"]>',
  "",
  "Do NOT include any other text, fields, or commentary. Do NOT emit",
  "CLUSTER:, INSTALL_DETOURS:, code fences, markdown, or explanations.",
  "Package names must match the pattern /^@?[a-z0-9][a-z0-9._-]*(?:\\/[a-z0-9][a-z0-9._-]*)?$/i.",
  "If no packages are replaced, emit REPLACES_PACKAGES: [].",
].join("\n");

/**
 * Build the agent prompt for filling a single capability hint.
 *
 * Returns a plain string — no Result wrapping for this trivial transform.
 * Callers POST the returned string as the user message to /api/chat.
 */
export function buildFillPrompt(args: FillPromptArgs): string {
  const sections: string[] = [];

  if (args.kind === "mcp") {
    sections.push(
      `You are filling the capability hint for an MCP server named "${args.name}".`,
    );
    if (args.mcpCommand !== undefined && args.mcpCommand.length > 0) {
      sections.push(`Install/run command: ${args.mcpCommand}`);
    }
    sections.push(
      "Task: produce (1) a one-line description of what this MCP provides, " +
        "and (2) the list of npm or pip packages this MCP replaces — i.e. " +
        "packages an operator would otherwise have installed locally to " +
        "perform the same task. The replaces list drives the install-detour " +
        "subsystem which refuses `pip install <X>` / `npm install <X>` for " +
        "packages in this list and routes the agent to the connected MCP " +
        "instead.",
    );
  } else {
    sections.push(
      `You are filling the capability hint for a skill named "${args.name}".`,
    );
    if (
      args.skillDescription !== undefined &&
      args.skillDescription.length > 0
    ) {
      sections.push(
        `Existing manifest description: "${args.skillDescription}"`,
      );
      sections.push(
        // REFINE / CONDENSE: do not invent. "REFINE" must stay uppercase —
        // tests assert the literal token.
        "Task: REFINE OR CONDENSE the existing description (do not invent " +
          "a new one). Then list any npm/pip packages this skill replaces — " +
          "usually [] for skills, but supported (e.g. a markdown-formatter " +
          "skill might replace prettier or markdownlint).",
      );
    } else {
      sections.push(
        "Task: produce a one-line description of what this skill does, and " +
          "list any npm/pip packages it replaces (usually [] for skills, " +
          "but supported).",
      );
    }
  }

  if (
    args.currentDescription !== undefined &&
    args.currentDescription.length > 0
  ) {
    sections.push(
      `Current description (being refilled): "${args.currentDescription}"`,
    );
  }

  sections.push("");
  sections.push(RESPONSE_FORMAT_BLOCK);
  return sections.join("\n\n");
}
