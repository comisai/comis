// SPDX-License-Identifier: Apache-2.0
/**
 * Per-package README forbidden-substring source-grep.
 *
 * Per-package READMEs must not advertise upstream-dependency relationships
 * forbidden by the target package graph. The substring map below is derived
 * verbatim from "Must NOT depend on" columns in the package graph. Each
 * entry is the `@comis/<name>` form to avoid false-positives on legitimate
 * domain terms ("the cron scheduler" must NOT match `scheduler` in agent
 * README).
 *
 * Escape hatch: regions wrapped in `<!-- arch-historical --> ... <!-- /arch-historical -->`
 * HTML comments are stripped before checking. Use sparingly for legitimate
 * historical references (e.g., a "before v2.0" migration note).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { formatViolations } from "../support/architecture-helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

// Derived VERBATIM from the package graph "Must NOT depend on" columns.
const FORBIDDEN_SUBSTRING_MAP: Record<string, readonly string[]> = {
  "packages/agent/README.md": [
    "@comis/infra", "@comis/memory", "@comis/scheduler", "@comis/channels",
    "@comis/gateway", "@comis/skills", "@comis/cli", "@comis/daemon",
    "@comis/orchestrator", "proper-lockfile",
  ],
  "packages/channels/README.md": [
    "@comis/infra", "@comis/agent", "@comis/scheduler", "@comis/gateway",
    "@comis/skills", "@comis/memory", "@comis/cli", "@comis/daemon",
    "@comis/orchestrator",
  ],
  "packages/cli/README.md": [
    "@comis/infra", "@comis/agent", "@comis/memory", "@comis/scheduler",
    "@comis/skills", "@comis/channels", "@comis/gateway", "@comis/daemon",
    "@comis/orchestrator",
  ],
  "packages/core/README.md": [
    "@comis/infra", "@comis/memory", "@comis/agent", "@comis/channels",
    "@comis/gateway", "@comis/skills", "@comis/scheduler", "@comis/cli",
    "@comis/daemon", "@comis/orchestrator",
  ],
  "packages/gateway/README.md": [
    "@comis/infra", "@comis/agent", "@comis/channels", "@comis/skills",
    "@comis/scheduler", "@comis/memory", "@comis/cli", "@comis/daemon",
    "@comis/orchestrator",
  ],
  "packages/infra/README.md": [
    "@comis/agent", "@comis/channels", "@comis/gateway", "@comis/skills",
    "@comis/scheduler", "@comis/memory", "@comis/cli", "@comis/daemon",
    "@comis/orchestrator",
  ],
  "packages/memory/README.md": [
    "@comis/infra", "@comis/agent", "@comis/channels", "@comis/gateway",
    "@comis/skills", "@comis/scheduler", "@comis/cli", "@comis/daemon",
    "@comis/orchestrator",
  ],
  "packages/orchestrator/README.md": [
    "@comis/infra", "@comis/scheduler", "@comis/gateway", "@comis/skills",
    "@comis/memory", "@comis/cli", "@comis/daemon",
  ],
  "packages/scheduler/README.md": [
    "@comis/infra", "@comis/memory", "@comis/agent", "@comis/channels",
    "@comis/gateway", "@comis/skills", "@comis/cli", "@comis/daemon",
    "@comis/orchestrator",
  ],
  "packages/shared/README.md": [
    // shared has zero deps — every @comis/* is forbidden.
    "@comis/core", "@comis/infra", "@comis/memory", "@comis/agent",
    "@comis/channels", "@comis/gateway", "@comis/skills", "@comis/scheduler",
    "@comis/cli", "@comis/daemon", "@comis/orchestrator",
  ],
  "packages/skills/README.md": [
    "@comis/infra", "@comis/agent", "@comis/channels", "@comis/gateway",
    "@comis/scheduler", "@comis/memory", "@comis/cli", "@comis/daemon",
    "@comis/orchestrator",
  ],
  "packages/daemon/README.md": [], // daemon depends on everything; no forbidden subs
  "packages/comis/README.md": [],  // umbrella; mentions everything intentionally
  "packages/web/README.md": [
    // web has NO project refs (standalone Lit/Vite SPA).
    "@comis/core", "@comis/infra", "@comis/memory", "@comis/agent",
    "@comis/channels", "@comis/gateway", "@comis/skills", "@comis/scheduler",
    "@comis/cli", "@comis/daemon", "@comis/orchestrator", "@comis/shared",
  ],
};

const HISTORICAL_RE = /<!--\s*arch-historical\s*-->[\s\S]*?<!--\s*\/arch-historical\s*-->/g;

describe("readme-no-forbidden-deps", () => {
  for (const [readmePath, forbidden] of Object.entries(FORBIDDEN_SUBSTRING_MAP)) {
    if (forbidden.length === 0) continue;
    it(`${readmePath} contains none of [${forbidden.join(", ")}]`, () => {
      const absolute = resolve(REPO_ROOT, readmePath);
      if (!existsSync(absolute)) {
        throw new Error(`Expected README missing at HEAD: ${readmePath}`);
      }
      const raw = readFileSync(absolute, "utf8");
      const sanitized = raw.replace(HISTORICAL_RE, "");
      const lines = sanitized.split("\n");
      const hits: { needle: string; lineNumber: number; line: string }[] = [];
      for (let i = 0; i < lines.length; i++) {
        for (const needle of forbidden) {
          if (lines[i].includes(needle)) {
            hits.push({ needle, lineNumber: i + 1, line: lines[i].trim() });
          }
        }
      }
      expect(
        hits,
        formatViolations({
          description:
            `${readmePath} references forbidden upstream dependencies. The target package graph forbids these edges; the README must not advertise them.`,
          violations: hits.map((h) => ({
            file: `${readmePath}:${h.lineNumber}`,
            line: h.lineNumber,
            snippet: `[${h.needle}] ${h.line}`,
          })),
          suggestedFix:
            'Remove the forbidden mention OR wrap a legitimate historical reference in <!-- arch-historical --> ... <!-- /arch-historical --> (use sparingly). Forbidden substrings are derived verbatim from the package graph "Must NOT depend on" columns.',
        }),
      ).toEqual([]);
    });
  }

  it("every expected README exists (sanity)", () => {
    const missing: string[] = [];
    for (const readmePath of Object.keys(FORBIDDEN_SUBSTRING_MAP)) {
      if (!existsSync(resolve(REPO_ROOT, readmePath))) {
        missing.push(readmePath);
      }
    }
    expect(
      missing,
      `Missing READMEs: ${missing.join(", ")}.`,
    ).toEqual([]);
  });
});
