// SPDX-License-Identifier: Apache-2.0

export interface ReviewedLauncherRequirement {
  readonly path: `/usr/local/bin/${string}`;
  readonly reviewedToken: string;
  readonly version: string;
}

export const E0_CODEX_LAUNCHER_REQUIREMENT = Object.freeze({
  path: "/usr/local/bin/e0-codex-launcher",
  reviewedToken: "e0-reviewed",
  version: "codex-cli 0.147.0",
} satisfies ReviewedLauncherRequirement);

export const WAVE4_CODEX_LAUNCHER_REQUIREMENT = Object.freeze({
  path: "/usr/local/bin/wave4-codex-launcher",
  reviewedToken: "wave4-reviewed",
  version: "codex-cli 0.147.0",
} satisfies ReviewedLauncherRequirement);

export const WAVE4_CLAUDE_LAUNCHER_REQUIREMENT = Object.freeze({
  path: "/usr/local/bin/wave4-claude-launcher",
  reviewedToken: "wave4-claude-reviewed",
  version: "2.1.233 (Claude Code)",
} satisfies ReviewedLauncherRequirement);

export const REVIEWED_LAUNCHER_REQUIREMENTS = Object.freeze([
  E0_CODEX_LAUNCHER_REQUIREMENT,
  WAVE4_CODEX_LAUNCHER_REQUIREMENT,
  WAVE4_CLAUDE_LAUNCHER_REQUIREMENT,
]);
