/**
 * Skills and memory section builders: skills listing, prompt skills,
 * memory recall, and workspace.
 */

// ---------------------------------------------------------------------------
// 5. Skills (merged: filesystem + prompt skills in one section)
// ---------------------------------------------------------------------------

export function buildSkillsSection(
  skillsPrompt: string | undefined,
  isMinimal: boolean,
  promptSkillsXml?: string,
  activePromptSkillContent?: string,
): string[] {
  if (isMinimal) return [];

  const hasFs = Boolean(skillsPrompt);
  const hasPrompt = Boolean(promptSkillsXml) || Boolean(activePromptSkillContent);

  if (!hasFs && !hasPrompt) return [];

  const lines: string[] = [
    "## Skills",
    "Before replying, scan the available skill descriptions below.",
    "- If exactly one skill clearly applies: read its SKILL.md at the listed location with `read`, then **follow its procedure step by step**. Do not take shortcuts (e.g. searching the web for a pre-built solution instead of building as the skill instructs).",
    "- If multiple could apply: choose the most specific one, then read and follow it.",
    "- If none clearly apply: do not read any SKILL.md.",
    "Never read more than one skill up front; select first, then read.",
    "- **Delegation exception**: If you are delegating the task to a sub-agent, do NOT read or copy SKILL.md contents into the task. The sub-agent has the same skills and will read SKILL.md itself. Just describe the goal.",
  ];

  // When both types present, use subsection headers
  if (hasFs && hasPrompt) {
    lines.push("", "### Filesystem Skills", "", skillsPrompt!);
    lines.push("", "### Prompt Skills");
    lines.push("When a skill file references a relative path, resolve it against the skill directory.");
    if (promptSkillsXml) lines.push("", promptSkillsXml);
    if (activePromptSkillContent) lines.push("", activePromptSkillContent);
  } else if (hasFs) {
    // Only filesystem skills -- no subsection needed (backward compat)
    lines.push("", skillsPrompt!);
  } else {
    // Only prompt skills
    lines.push("", "### Prompt Skills");
    lines.push("When a skill file references a relative path, resolve it against the skill directory.");
    if (promptSkillsXml) lines.push("", promptSkillsXml);
    if (activePromptSkillContent) lines.push("", activePromptSkillContent);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// 6. Memory Recall (skip if minimal or no memory tools)
// ---------------------------------------------------------------------------

export function buildMemoryRecallSection(
  hasMemoryTools: boolean,
  isMinimal: boolean,
): string[] {
  if (isMinimal || !hasMemoryTools) return [];
  return [
    "## Memory",
    "You have persistent memory across conversations.",
    "",
    "### Mandatory Recall",
    "Before answering ANY question about these topics, you MUST run `memory_search` first:",
    "- Prior work or past projects",
    "- Past decisions or agreements",
    "- Dates, timelines, or schedules discussed previously",
    "- People, names, or contacts mentioned in prior sessions",
    "- User preferences or habits",
    "- Todos, action items, or commitments",
    "",
    "If memory_search returns relevant results, use them in your answer.",
    "If memory_search returns no results, answer based on available context. Do not mention that you searched.",
    "",
    "### Tools",
    '- **memory_search**: Search past conversations and stored facts. Use natural language queries (e.g., "user\'s timezone preference" not just "timezone").',
    '- **memory_store**: Save facts, preferences, decisions, and context for future recall. Use tags for categorization (e.g., ["preference"], ["project"]).',
    "",
    "### When to Store",
    "Save proactively when the user shares preferences, makes decisions, provides important context, or assigns action items.",
    "",
    "### Proactive Storage",
    "When the user shares preferences, decisions, or important context, store it immediately via memory_store -- don't wait to be asked.",
    "If they mention their timezone, preferred name, project deadlines, or any durable fact -- store it now.",
    "For environment-specific notes (camera names, SSH hosts, TTS voices), update TOOLS.md directly via workspace file write.",
    "",
    "### What to NEVER Store",
    "Never store credentials, API keys, tokens, passwords, or secret values via memory_store.",
    "If a user shares a secret (e.g., during env_set), do not echo, repeat, or memorize its value.",
    "Store only the fact that a key was set, not its value (e.g., 'User configured OPENAI_API_KEY').",
    "",
    "### Recall Anti-Patterns",
    'WRONG: Answering "what timezone am I in?" from general knowledge without searching memory',
    'WRONG: Saying "I don\'t have that information" before running memory_search',
    'WRONG: Telling the user "I searched my memory and found nothing" (do not mention the search)',
    'RIGHT: Run memory_search first, then answer naturally using results (or general knowledge if no results)',
  ];
}

// ---------------------------------------------------------------------------
// 7. Workspace (include in minimal)
// ---------------------------------------------------------------------------

export function buildWorkspaceSection(
  workspaceDir: string | undefined,
   
  _isMinimal: boolean,
): string[] {
  if (!workspaceDir) return [];
  return [
    "## Workspace",
    `Your working directory: ${workspaceDir}`,
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    "",
    "### Workspace Isolation",
    "All file operations are sandboxed to this directory. You cannot read or write files outside it.",
    "Sub-agents you spawn share this same workspace — files they create are directly accessible at this path.",
    "Skill directories (e.g., ~/.comis/skills) are read-only accessible — you can read skill files but not modify them.",
    "Other top-level agents (different agentId) have their own separate workspaces.",
    "In execution pipelines, a shared pipeline folder may also be available for cross-node file exchange (see Shared Pipeline Folder section if present).",
  ];
}
