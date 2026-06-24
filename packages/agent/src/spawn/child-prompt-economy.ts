// SPDX-License-Identifier: Apache-2.0
/**
 * Child-prompt economy (STRIP-01 / STRIP-02): drop the heavy inherited context
 * blocks from a READ-ONLY spawned child's assembled system prompt, on the SPAWN
 * side, while preserving the constitutional anti-injection safety core.
 *
 * A read-only child still ingests untrusted web/MCP/file content, so it remains
 * a prompt-injection target and MUST keep the safety floor (Pitfall 5 / STRIP-5).
 * The drop narrows CONTEXT only — it never widens capability.
 *
 * ===========================================================================
 * Task-0 spike findings (Q-STRIP-1) — the spawn → child-prompt path at HEAD
 * (feature/v2.30). These pin the drop points + the chosen mechanism.
 * ===========================================================================
 *
 * 1. The child's resolved PromptMode.
 *    A spawned child boots through the SAME assembly entry point as any turn:
 *    `assembleExecutionPrompt` (executor/prompt-assembly.ts:736). Its mode is
 *    `resolvePromptModeForProfile(baseMode, operationType, modelProfile,
 *    compactPrompt)` (prompt-assembly.ts:981) — typically "full" for a
 *    frontier/mid child (or "compact-secure" for a small/nano child).
 *    The RESEARCH assumption (A3/A4 — that the "minimal" mode already drops the
 *    heavy STRIP-01 blocks) is CONFIRMED WRONG: in system-prompt-assembler.ts
 *    the heavy sections use MODES_ALL (incl. "minimal"), and the `m==="minimal"`
 *    flag only shortens each builder's TEXT — it does not OMIT the section.
 *    ⇒ a real drop mechanism is required; we cannot just pick a mode.
 *
 * 2. WHERE the heavy blocks are emitted.
 *    project-context / workspace / skills / reasoning(thinking) / memory-recall
 *    are real SECTIONS in the assembled system-prompt string
 *    (system-prompt-assembler.ts SECTIONS table, lines 278-356), each emitting a
 *    stable `## <Heading>`, joined by SECTION_SEPARATOR ("\n\n---\n\n",
 *    system-prompt-assembler.ts:58). The RESEARCH "CLAUDE.md-equivalent overlay"
 *    maps to `## Project Context` (it injects AGENTS.md/ROLE.md — the project-
 *    instruction overlay, context-sections.ts:181). The RESEARCH "usage trailer"
 *    has NO Comis analogue in the prompt — token-budget is a DEBUG log line
 *    (prompt-assembly.ts:1989), never prompt text — so there is nothing to strip
 *    for it.
 *
 * 3. WHERE the safety core lives — same assembled string:
 *      - `## Safety`                        (core-sections.ts:28; ALWAYS the
 *                                            full 14-line buildSafetySection(false))
 *      - `## Config & Secret File Integrity`(tooling-sections.ts:185)
 *      - `## Authorized Senders`            (sender-trust, trust-sections.ts:129)
 *      - `## Autonomy`                      (autonomy-doctrine.ts:42)
 *
 * 4. MECHANISM (chosen): a post-assembly, per-child string strip on the child's
 *    OWN assembled `systemPrompt` — split on SECTION_SEPARATOR, drop the sections
 *    whose heading is in READ_ONLY_CHILD_DROP_HEADINGS, keep everything else
 *    (so the safety core survives by construction). Rationale:
 *      (a) cap-safe — ALL logic lives here; the two capped files
 *          (sub-agent-runner.ts 2643L, prompt-assembly.ts 2035L) take only a
 *          single call-site hook (Task 2), no section-builder edits;
 *      (b) testable in isolation — pure string → string;
 *      (c) per-child — operates on the child's own assembled prompt, never the
 *          shared SECTIONS state (T-221-STRIP-03), and works on BOTH assembly
 *          paths (full assembly + the parent-cache reuse path, prompt-assembly.ts
 *          806-974) because both yield a `systemPrompt` string.
 *
 * @module
 */

import { isReadOnlyTool } from "../executor/tool-parallelism.js";
import { SECTION_SEPARATOR } from "../bootstrap/index.js";
import type { SystemPromptBlocks } from "../bootstrap/index.js";

// ---------------------------------------------------------------------------
// The drop / keep heading contract
// ---------------------------------------------------------------------------

/**
 * The heavy inherited section headings dropped for a read-only child (STRIP-01).
 * Each is a real `## <Heading>` emitted by the SECTIONS builders (see the
 * Task-0 spike notes above for the file:line of each). `## Project Context` is
 * the CLAUDE.md-equivalent overlay; `## Extended Thinking` / `## Reasoning
 * Format` are the two thinking-guidance variants the reasoning builder emits.
 */
export const READ_ONLY_CHILD_DROP_HEADINGS: readonly string[] = [
  "## Project Context",
  "## Workspace",
  "## Skills",
  "## Memory",
  "## Extended Thinking",
  "## Reasoning Format",
];

/**
 * The constitutional anti-injection floor that MUST survive the drop
 * (STRIP-5 / Pitfall 5). Used by the safety-core assertion; kept disjoint from
 * the drop set by an arch-style test in child-prompt-economy.test.ts.
 */
export const READ_ONLY_CHILD_KEEP_HEADINGS: readonly string[] = [
  "## Safety",
  "## Config & Secret File Integrity",
  "## Authorized Senders",
  "## Autonomy",
];

/** Drop-heading lookup; a section is dropped iff its heading is a member. */
const DROP_SET: ReadonlySet<string> = new Set(READ_ONLY_CHILD_DROP_HEADINGS);

// ---------------------------------------------------------------------------
// Read-only child detection
// ---------------------------------------------------------------------------

/**
 * Whether a spawned child is read-only — i.e. its entire tool surface is
 * read-only (every tool ⊆ the read-only set per `isReadOnlyTool`), OR it
 * carries an explicit read-only role.
 *
 * Conservative by construction (T-221-STRIP-02): a child is read-only ONLY when
 * we can PROVE it. Any tool that is not provably read-only — a mutating tool
 * (`exec`/`edit`/`write`/...) OR an unknown/unregistered tool — makes the child
 * NOT read-only, and a mutating tool overrides even an explicit read-only role
 * (capability is never widened by the hint). An empty tool surface is NOT
 * read-only on its own (no proof of intent), but the explicit read-only role
 * still classifies a no-tool child as read-only.
 *
 * Delegates the per-tool decision to `isReadOnlyTool` (executor/tool-parallelism)
 * → `getToolMetadata().isReadOnly` (@comis/core) so the classification reuses the
 * single registry source of truth rather than a hand-rolled list.
 *
 * @param childToolNames - The child's resolved tool surface (tool names).
 * @param role - Optional explicit role; "read-only" classifies as read-only
 *   UNLESS a mutating tool is present.
 */
export function isReadOnlyChild(childToolNames: readonly string[], role?: string): boolean {
  // A mutating/unknown tool always wins — never widen capability via the hint.
  const everyToolReadOnly = childToolNames.every((name) => isReadOnlyTool(name));

  if (role === "read-only") {
    // Explicit read-only role: honor it unless a tool proves the child can mutate.
    return everyToolReadOnly;
  }

  // No role hint: require BOTH a non-empty surface AND every tool read-only.
  // An empty surface has no proof of read-only intent → not read-only.
  return childToolNames.length > 0 && everyToolReadOnly;
}

// ---------------------------------------------------------------------------
// The section-drop
// ---------------------------------------------------------------------------

/**
 * Extract the first line of a section (its `## Heading`, when present).
 * Sections are assembled as `lines.join("\n")`, so the heading is line 0.
 */
function sectionHeading(section: string): string {
  const newlineIdx = section.indexOf("\n");
  return (newlineIdx === -1 ? section : section.slice(0, newlineIdx)).trim();
}

/**
 * Drop the heavy inherited blocks (READ_ONLY_CHILD_DROP_HEADINGS) from an
 * assembled child system prompt, preserving every other section — including the
 * full safety core (STRIP-01 + STRIP-5).
 *
 * Splits on SECTION_SEPARATOR (the exact joiner the assembler uses), removes the
 * sections whose leading `## Heading` is in the drop set, and re-joins the
 * survivors with the same separator. A no-op (returns the input unchanged) when
 * no heavy section is present, so a NON-read-only path that never calls this, or
 * an already-lean prompt, is byte-identical.
 *
 * Pure + total: never throws; operates only on the passed string.
 *
 * @param assembledPrompt - The child's assembled system-prompt string.
 * @returns The prompt with the heavy sections removed.
 */
export function economiseChildPrompt(assembledPrompt: string): string {
  const sections = assembledPrompt.split(SECTION_SEPARATOR);
  const kept = sections.filter((section) => !DROP_SET.has(sectionHeading(section)));
  // Preserve byte-identity when nothing was dropped (no spurious re-join diff).
  if (kept.length === sections.length) return assembledPrompt;
  return kept.join(SECTION_SEPARATOR);
}

// ---------------------------------------------------------------------------
// Spawn-side wiring (STRIP-02)
// ---------------------------------------------------------------------------

/** The economised child prompt — the input window the child boots with. */
export interface EconomisedChildPrompt {
  /** The (possibly stripped) full system-prompt string. */
  systemPrompt: string;
  /** The (possibly stripped) cache blocks; undefined passes through untouched. */
  systemPromptBlocks?: SystemPromptBlocks;
}

/**
 * Apply the read-only-child prompt economy on the SPAWN side (STRIP-02): if the
 * child is read-only, drop the heavy inherited blocks from BOTH the assembled
 * `systemPrompt` string AND the `systemPromptBlocks.semiStableBody`; otherwise
 * pass everything through byte-identically (a mutating or unknown-tool child
 * gets the full prompt — conservative, T-221-STRIP-02).
 *
 * Both representations must be stripped because the multi-block path
 * (request-body/breakpoint-orchestration.ts) builds the system message from
 * `staticPrefix`/`attribution`/`semiStableBody` when blocks are present, which
 * OVERRIDES the flat string — stripping only the string would be a no-op at the
 * wire. The heavy sections all live in `semiStableBody` (identity/persona →
 * staticPrefix, safety/language → attribution, everything else → body per the
 * assembler's block boundaries), and the safety-core sections that live in the
 * body (config-secret/sender-trust/autonomy) are NOT in the drop set, so they
 * survive. `staticPrefix`/`attribution` are passed through unchanged.
 *
 * Single chokepoint so the call site in the (capped) prompt-assembly.ts stays a
 * one-liner per assembly path.
 *
 * @param systemPrompt - The child's assembled system-prompt string.
 * @param systemPromptBlocks - The child's cache blocks (may be undefined).
 * @param childToolNames - The child's resolved tool surface.
 * @param role - Optional explicit role (e.g. "read-only").
 */
export function economiseForReadOnlyChild(
  systemPrompt: string,
  systemPromptBlocks: SystemPromptBlocks | undefined,
  childToolNames: readonly string[],
  role?: string,
): EconomisedChildPrompt {
  if (!isReadOnlyChild(childToolNames, role)) {
    return { systemPrompt, systemPromptBlocks };
  }
  return {
    systemPrompt: economiseChildPrompt(systemPrompt),
    systemPromptBlocks: systemPromptBlocks
      ? { ...systemPromptBlocks, semiStableBody: economiseChildPrompt(systemPromptBlocks.semiStableBody) }
      : undefined,
  };
}
