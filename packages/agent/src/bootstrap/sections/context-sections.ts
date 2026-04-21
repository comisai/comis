// SPDX-License-Identifier: Apache-2.0
/**
 * Context section builders: project context, subagent context,
 * subagent role, and post-compaction recovery.
 */

import type { BootstrapContextFile } from "../types.js";
import { extractMarkdownSections, MAX_POST_COMPACTION_CHARS } from "../section-extractor.js";
import { TEMPLATE_MARKER } from "../../workspace/templates.js";

export interface SubagentRoleParams {
  /** Task description assigned to the subagent */
  task: string;
  /** Nesting depth (1 = direct child of main agent) */
  depth?: number;
  /** Maximum allowed spawn depth */
  maxSpawnDepth?: number;
  /** Additional freeform context from the caller (appended after structured content) */
  extraContext?: string;
  /** File paths for subagent to reference */
  artifactRefs?: string[];
  /** Objective statement that survives compaction */
  objective?: string;
  /** Caller-supplied domain knowledge entries */
  domainKnowledge?: string[];
  /** Inherited workspace directory */
  workspaceDir?: string;
  /** Condensed parent context summary */
  parentSummary?: string;
  /** Map of all registered agent IDs to their workspace directories. */
  agentWorkspaces?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Task Planning (SEP system prompt section -- static, cache-stable)
// ---------------------------------------------------------------------------

/**
 * Build the Task Planning section for the Silent Execution Planner.
 *
 * Included in the static system prompt (cache-stable) when SEP is enabled.
 * Encourages the LLM to produce structured step output that SEP can parse.
 *
 * @param sepEnabled - Whether SEP is enabled for this agent
 * @param isMinimal - Whether the prompt is in minimal mode (sub-agents)
 * @returns Lines for the section, or empty array if disabled
 */
export function buildTaskPlanningSection(sepEnabled: boolean, isMinimal: boolean): string[] {
  if (!sepEnabled || isMinimal) return [];
  return [
    "## Task Planning",
    "When given a complex request that requires multiple steps:",
    "- Briefly outline your approach (numbered steps) before starting.",
    "- Execute steps in order. State which step you are working on.",
    "- After completing all steps, verify the result before responding.",
    "- If a step fails, note the failure and continue with remaining steps.",
  ];
}

// ---------------------------------------------------------------------------
// 16a. Persona (SOUL.md promoted to standalone section before Safety)
// ---------------------------------------------------------------------------

export function buildPersonaSection(
  files: BootstrapContextFile[],
): string[] {
  const soul = files.find((f) => f.path.toLowerCase() === "soul.md");
  if (!soul) return [];
  return [
    "## Persona",
    "This is your persona definition. Embody its personality and tone in all responses.",
    "Avoid stiff, generic replies. Follow the guidance below unless higher-priority instructions override it.",
    "",
    soul.content,
  ];
}

// ---------------------------------------------------------------------------
// Template detection
// ---------------------------------------------------------------------------

/**
 * Check if content is template-only (no user-written content).
 * Files with the template marker and only placeholder content are excluded
 * from the system prompt.
 */
function isTemplateOnly(content: string): boolean {
  if (!content.trimStart().startsWith(TEMPLATE_MARKER)) return false;
  const stripped = content
    .split("\n")
    .filter(line => {
      const t = line.trim();
      return t
        && t !== TEMPLATE_MARKER
        && !t.startsWith("#")
        && !t.startsWith("---")
        && !t.startsWith("<!--")
        && !(t.startsWith("_(") && t.endsWith(")_"));
    })
    .join("")
    .trim();
  return stripped.length === 0;
}

// ---------------------------------------------------------------------------
// Specialist AGENTS.md extract
// ---------------------------------------------------------------------------

/** Minimal platform instructions for specialist agents. */
const SPECIALIST_AGENTS_MD = `# Platform Instructions (Specialist)

## Safety
- Never leak secrets, API keys, or credentials in messages
- Never execute destructive operations without explicit confirmation
- Respect the Result<T,E> pattern — no thrown exceptions

## Workspace Files
- **ROLE.md** — Your role, behavioral guidelines, domain conventions (writable)
- **TOOLS.md** — Local environment notes (writable)
- **AGENTS.md** — Platform instructions (read-only)
- **SOUL.md** — Core personality (read-only)

## Output
- Use structured output as defined in ROLE.md
- Be concise — you're a specialist worker, not a conversationalist`;

// ---------------------------------------------------------------------------
// 16. Project Context (include in minimal)
// ---------------------------------------------------------------------------

export function buildProjectContextSection(
  files: BootstrapContextFile[],
   
  _isMinimal: boolean,
  excludeFiles?: Set<string>,
  workspaceProfile?: "full" | "specialist",
): string[] {
  if (files.length === 0) return [];
  const lines: string[] = ["## Project Context"];

  const roleMd = files.find((f) => f.path.toLowerCase() === "role.md");

  for (const file of files) {
    // SOUL.md is handled by buildPersonaSection -- skip it here
    if (file.path.toLowerCase() === "soul.md") continue;
    if (file.path.toLowerCase() === "role.md") continue; // appended after AGENTS.md
    if (excludeFiles?.has(file.path)) continue; // skip elevated files

    // For specialist profile, replace full AGENTS.md with minimal extract
    if (file.path.toLowerCase() === "agents.md" && workspaceProfile === "specialist") {
      lines.push("### AGENTS.md", "", SPECIALIST_AGENTS_MD);
    } else {
      lines.push(`### ${file.path}`, "", file.content);
    }

    // Append ROLE.md content right after AGENTS.md
    if (file.path.toLowerCase() === "agents.md" && roleMd && !roleMd.content.startsWith("[MISSING]")) {
      const trimmed = roleMd.content.trim();
      if (trimmed && !isTemplateOnly(trimmed)) {
        lines.push("", "### ROLE.md", "", trimmed);
      }
    }
  }
  // If all files were SOUL.md / ROLE.md, return empty
  if (lines.length === 1) return [];
  return lines;
}

// ---------------------------------------------------------------------------
// 16a-post. Post-Compaction Recovery (skip if minimal or no AGENTS.md)
// ---------------------------------------------------------------------------

export function buildPostCompactionRecoverySection(
  files: BootstrapContextFile[],
  isMinimal: boolean,
  sectionNames?: string[],
): string[] {
  if (isMinimal) return [];

  const agentsMd = files.find((f) => f.path.toLowerCase() === "agents.md");
  if (!agentsMd || agentsMd.content.startsWith("[MISSING]")) return [];

  const targetSections = sectionNames ?? ["Session Startup", "Red Lines"];
  const extracted = extractMarkdownSections(agentsMd.content, targetSections);
  if (extracted.length === 0) return [];

  let combined = extracted.join("\n\n");
  if (combined.length > MAX_POST_COMPACTION_CHARS) {
    combined = combined.slice(0, MAX_POST_COMPACTION_CHARS) + "\n...[truncated]...";
  }

  return [
    "## Post-Compaction Recovery",
    "If the conversation was just compacted (you see a compaction summary above),",
    "the summary is a hint -- NOT a substitute for your startup sequence.",
    "Re-execute your startup sequence now: re-read the required workspace files before responding to the user.",
    "",
    "Critical instructions from AGENTS.md:",
    "",
    combined,
  ];
}

// ---------------------------------------------------------------------------
// 17. Subagent Context (only for sub-agents / minimal mode)
// ---------------------------------------------------------------------------

export function buildSubagentContextSection(
  extraSystemPrompt: string | undefined,
): string[] {
  if (!extraSystemPrompt) return [];
  return ["## Additional Context", extraSystemPrompt];
}

// ---------------------------------------------------------------------------
// 18. Subagent Role (only for sub-agents -- structured replacement for buildSubagentContextSection)
// ---------------------------------------------------------------------------

export function buildSubagentRoleSection(
  params: SubagentRoleParams | undefined,
): string[] {
  if (!params) return [];
  const parentLabel = (params.depth ?? 1) >= 2 ? "parent orchestrator" : "main agent";
  const canSpawn = (params.depth ?? 1) < (params.maxSpawnDepth ?? 1);

  const lines: string[] = [
    "## Subagent Role",
    "",
    `You are a **subagent** spawned by the ${parentLabel} for a specific task.`,
    "",
    "### Your Task",
    `Complete this task: ${params.task}`,
    `You are NOT the ${parentLabel}. Do not try to be.`,
  ];

  // --- New enriched sections (inserted BEFORE Rules) ---

  if (params.objective) {
    lines.push(
      "",
      "### Objective",
      `Your primary objective: ${params.objective}`,
      "Stay focused on this objective throughout your execution. If you lose context due to compaction, re-read this section.",
    );
  }

  if (params.artifactRefs && params.artifactRefs.length > 0) {
    lines.push(
      "",
      "### Artifact References",
      "The following files are relevant to your task. Read them as needed using your file tools:",
    );
    for (const ref of params.artifactRefs) {
      lines.push(`- ${ref}`);
    }
  }

  if (params.domainKnowledge && params.domainKnowledge.length > 0) {
    lines.push("", "### Domain Knowledge");
    for (const entry of params.domainKnowledge) {
      lines.push("", entry);
    }
  }

  if (params.workspaceDir) {
    lines.push(
      "",
      "### Workspace",
      `Your workspace directory: ${params.workspaceDir}`,
      "This is inherited from your parent agent. Use it for file operations.",
    );
  }

  if (params.agentWorkspaces && Object.keys(params.agentWorkspaces).length > 0) {
    lines.push(
      "",
      "### Agent Workspaces",
      "All registered agents and their workspace directories:",
    );
    for (const [id, dir] of Object.entries(params.agentWorkspaces)) {
      lines.push(`- **${id}**: \`${dir}\``);
    }
    lines.push(
      "",
      "Use these paths when you need to read or modify another agent's workspace files.",
    );
  }

  if (params.parentSummary) {
    lines.push("", "### Parent Context", "", params.parentSummary);
  }

  // --- End enriched sections ---

  lines.push(
    "",
    "### Rules",
    "1. **Stay focused** -- Do your assigned task, nothing else.",
    `2. **Complete the task** -- Your final message is automatically reported to the ${parentLabel}.`,
    "3. **No side quests** -- No heartbeats, no proactive actions, no cron jobs.",
    "4. **Be ephemeral** -- You may be terminated after task completion.",
    "5. **Trust push-based completion** -- Descendant results are auto-announced; do not busy-poll for status.",
    "6. **Handle compacted output** -- If you see [compacted] or [truncated] markers, re-read with smaller chunks (offset/limit) instead of full-file requests.",
    "",
    "### Output Format",
    "Your final response should include:",
    "- What you accomplished or found",
    `- Any relevant details the ${parentLabel} should know`,
    "- Keep it concise but informative",
    "",
    "### Anti-Patterns",
    `- Do NOT initiate user conversations (that is the ${parentLabel}'s job)`,
    "- Do NOT send external messages unless explicitly tasked with a specific recipient",
    "- Do NOT create cron jobs or persistent state",
    `- Do NOT pretend to be the ${parentLabel}`,
    "- Only use the `message` tool when explicitly instructed to contact a specific external recipient",
  );

  if (canSpawn) {
    lines.push(
      "",
      "### Sub-Agent Spawning",
      "You CAN spawn your own sub-agents for parallel or complex work.",
      "Your sub-agents will announce their results back to you automatically.",
      "Do NOT repeatedly poll for status in a loop.",
      "Coordinate their work and synthesize results before reporting back.",
    );
  } else if ((params.depth ?? 1) >= (params.maxSpawnDepth ?? 1)) {
    lines.push(
      "",
      "### Sub-Agent Spawning",
      "You are a leaf worker and CANNOT spawn further sub-agents. Focus on your assigned task.",
    );
  }

  if (params.extraContext) {
    lines.push("", "### Additional Context", params.extraContext);
  }

  return lines;
}
