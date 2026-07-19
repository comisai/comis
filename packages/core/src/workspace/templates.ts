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

This is a new workspace. Briefly explain that setup is available and invite the user to configure any relevant role, scope, user context, and response preferences. Do not assume choices the user has not made.

Record only choices the user confirms in the appropriate workspace files. Setup does not authorize tools, credentials, or side effects. When setup is complete, clear BOOTSTRAP.md so it does not run again.
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
