// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

import {
  DEFAULT_TEMPLATES,
  PLATFORM_OWNED_FILES,
  USER_OWNED_FILES,
  WORKSPACE_FILE_NAMES,
} from "./templates.js";

// ---------------------------------------------------------------------------
// Prose invariants for the workspace AGENTS.md template.
//
// These tests lock the 2026-05-20 fix for the false-promise venv prose:
// before this fix, the template advertised a "Pre-warmed Python env
// (matplotlib, numpy, pandas on PATH)" that no code actually provisioned.
// Sub-agents read the lie, attempted `venv/bin/python3`, hit exit-127, and
// cascaded into the 5-failure exec kill-switch. The replacement prose tells
// the agent to create the venv on demand with `python3 -m venv venv`.
// ---------------------------------------------------------------------------

describe("DEFAULT_TEMPLATES workspace prose invariants", () => {
  it("AGENTS.md template must not advertise a pre-warmed venv that does not exist on disk", () => {
    const agentsMd = DEFAULT_TEMPLATES["AGENTS.md"];
    expect(agentsMd).not.toContain("Pre-warmed");
    expect(agentsMd).not.toContain("matplotlib, numpy, pandas on PATH");
  });

  it("AGENTS.md template must instruct the agent to create the venv on demand with python3 -m venv", () => {
    const agentsMd = DEFAULT_TEMPLATES["AGENTS.md"];
    expect(agentsMd).toContain("python3 -m venv");
  });

  it("AGENTS.md template must still document per-project venv convention so other guidance holds", () => {
    const agentsMd = DEFAULT_TEMPLATES["AGENTS.md"];
    expect(agentsMd).toContain("projects/<name>/.venv");
  });

  // -------------------------------------------------------------------------
  // 2026-06-04 fix: the workspace templates used to instruct the agent to
  // `read` the four identity files (SOUL/IDENTITY/USER/BOOTSTRAP) that are
  // ALREADY inlined into the system prompt. A model took that literally and
  // looped ~150 identical reads in one turn until it hit maxSteps. These
  // invariants lock the reworded prose: reference the inlined files in
  // context, never tool-read them; still WRITE IDENTITY.md / USER.md.
  // -------------------------------------------------------------------------

  it("AGENTS.md template must not instruct reading the inlined identity files with the read tool", () => {
    const agentsMd = DEFAULT_TEMPLATES["AGENTS.md"];
    expect(agentsMd).not.toContain("Read `SOUL.md`");
    expect(agentsMd).not.toContain("Read `USER.md`");
    expect(agentsMd).not.toContain("Read `IDENTITY.md`");
  });

  it("AGENTS.md template must state the identity files are already in context (inlined)", () => {
    const agentsMd = DEFAULT_TEMPLATES["AGENTS.md"];
    expect(agentsMd).toContain("already in your context");
  });

  it("BOOTSTRAP.md template must not instruct reading or opening SOUL.md with a tool", () => {
    const bootstrapMd = DEFAULT_TEMPLATES["BOOTSTRAP.md"];
    expect(bootstrapMd).not.toContain("Read SOUL.md's");
    expect(bootstrapMd).not.toContain("open `SOUL.md`");
  });

  it("BOOTSTRAP.md template must still instruct writing IDENTITY.md and USER.md during onboarding", () => {
    const bootstrapMd = DEFAULT_TEMPLATES["BOOTSTRAP.md"];
    expect(bootstrapMd).toContain("update\nIDENTITY.md and USER.md");
    expect(bootstrapMd).toContain("`IDENTITY.md` -- your name");
    expect(bootstrapMd).toContain("`USER.md` -- their name");
  });

  it("PLATFORM_OWNED_FILES union USER_OWNED_FILES equals WORKSPACE_FILE_NAMES (exhaustive partition)", () => {
    const union = [...PLATFORM_OWNED_FILES, ...USER_OWNED_FILES].slice().sort();
    const all = [...WORKSPACE_FILE_NAMES].slice().sort();
    expect(union).toEqual(all);
  });

  it("PLATFORM_OWNED_FILES intersect USER_OWNED_FILES is empty (disjoint partition)", () => {
    const platform = new Set<string>(PLATFORM_OWNED_FILES);
    for (const name of USER_OWNED_FILES) {
      expect(platform.has(name)).toBe(false);
    }
    const user = new Set<string>(USER_OWNED_FILES);
    for (const name of PLATFORM_OWNED_FILES) {
      expect(user.has(name)).toBe(false);
    }
  });

  it("core templates.ts and agent templates.ts remain byte-identical duplicates after the edit", () => {
    // The duplicate is intentional and tracked here.
    // From packages/core/src/workspace/templates.test.ts navigate up to the
    // repo root, then sibling-package into agent's copy.
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(thisDir, "..", "..", "..", "..");
    const coreCopy = readFileSync(
      resolve(repoRoot, "packages", "core", "src", "workspace", "templates.ts"),
      "utf-8",
    );
    const agentCopy = readFileSync(
      resolve(repoRoot, "packages", "agent", "src", "workspace", "templates.ts"),
      "utf-8",
    );
    expect(coreCopy).toEqual(agentCopy);
  });
});
