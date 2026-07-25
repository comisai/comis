// SPDX-License-Identifier: Apache-2.0
/** Canonical neutral workspace starters. Existing files are never overwritten. */

export const WORKSPACE_FILE_NAMES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "AGENTS.md",
  "ROLE.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "BOOT.md",
] as const;

export type WorkspaceFileName = (typeof WORKSPACE_FILE_NAMES)[number];

/** Files whose non-starter contents are trusted operator policy. */
export const OPERATOR_OWNED_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
  "AGENTS.md",
  "ROLE.md",
  "TOOLS.md",
  "HEARTBEAT.md",
  "BOOT.md",
] as const satisfies readonly WorkspaceFileName[];

/** Mutable agent state. It never becomes trusted policy. */
export const AGENT_STATE_FILES = ["BOOTSTRAP.md"] as const satisfies readonly WorkspaceFileName[];

/** Exact marker shared by untouched operator starters. */
export const TEMPLATE_MARKER = "<!-- COMIS-TEMPLATE -->";

/** Model-visible terminal signal returned after the canonical onboarding state is cleared. */
export const ONBOARDING_COMPLETE_TOOL_RESULT =
  "[onboarding_complete] BOOTSTRAP.md is empty and onboarding is complete. "
  + "Do not call more tools and do not ask any setup question. "
  + "Respond now with a brief confirmation that summarizes the confirmed choices.";

export const DEFAULT_TEMPLATES: Record<WorkspaceFileName, string> = {
  "SOUL.md": `${TEMPLATE_MARKER}
# SOUL.md

<!-- Optional operator-authored behavioral principles. -->
`,
  "IDENTITY.md": `${TEMPLATE_MARKER}
# IDENTITY.md

<!-- Optional operator-authored identity constraints. -->
`,
  "USER.md": `${TEMPLATE_MARKER}
# USER.md

<!-- Optional operator-authored user context and preferences. -->
`,
  "AGENTS.md": `${TEMPLATE_MARKER}
# AGENTS.md

<!-- Optional operator-authored persistent operating instructions. -->
`,
  "ROLE.md": `${TEMPLATE_MARKER}
# ROLE.md

<!-- Optional operator-authored role, scope, and response requirements. -->
`,
  "TOOLS.md": `${TEMPLATE_MARKER}
# TOOLS.md

<!-- Optional operator-authored environment and tool-use notes. -->
`,
  "HEARTBEAT.md": `${TEMPLATE_MARKER}
# HEARTBEAT.md

<!-- Optional operator-authored periodic-work policy. -->
`,
  "BOOTSTRAP.md": `# First-run setup

This is a new workspace with no saved setup. Guide the user through a short, natural conversation. Do not assume a domain, persona, language, permissions, or preferences that the user has not confirmed.

## Conversation contract

Your first response must be short and warm. Briefly explain that this is a fresh workspace, then ask only for the user's name and what they want to call you. Do not ask the remaining setup questions, list a questionnaire, or modify workspace files in the first response.

Continue over the next few messages, one stage per reply:

1. Confirm the names.
2. Ask about your role and scope, plus the user's preferred response style.
3. Ask about operational boundaries, desired initiative, and memory preferences for future conversations.

Ask only for information that is still missing. If the user already answered a later-stage question, acknowledge it and move to the next missing stage; never ask for an already answered value again. Keep each reply conversational rather than presenting the whole setup as a checklist. The user may explicitly skip an item or the rest of setup.

## Persisting confirmed setup

Record only choices the user confirms. Put agent identity in IDENTITY.md, user context and preferences in USER.md, and role, scope, response requirements, and boundaries in ROLE.md. Setup does not authorize tools, credentials, or side effects.

Do not persist anything on the first greeting. Once there is confirmed information to save, preserve all previously confirmed values. The edit tool has one path for the entire edits[] array: use one file per edit call and separate edit calls for different files. Never overwrite a successfully customized file with starter template content.

After writing, read the changed files and verify that every confirmed value is present. If any tool call fails, correct it and verify again. Clear BOOTSTRAP.md last, only after the setup stages are answered or explicitly skipped and all required writes have been verified successful. Use the write tool to replace BOOTSTRAP.md with the empty string; never use edit to clear it.

After that clear succeeds, stop using tools and do not ask any setup question or repeat any choices. Briefly summarize what was saved and confirm that setup is complete.
`,
  "BOOT.md": `${TEMPLATE_MARKER}
# BOOT.md

<!-- Optional operator-authored instructions for a new session. -->
`,
};

/** Untouched operator starters are omitted instead of becoming policy. */
export function isUntouchedWorkspaceTemplate(
  name: WorkspaceFileName,
  content: string,
): boolean {
  return OPERATOR_OWNED_FILES.some((operatorFile) => operatorFile === name)
    && content === DEFAULT_TEMPLATES[name];
}
