// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";

import { DEFAULT_TEMPLATES } from "./templates.js";

// ---------------------------------------------------------------------------
// Prose invariants for the workspace AGENTS.md template — agent-package copy.
//
// This file mirrors the first three tests of
// `packages/core/src/workspace/templates.test.ts`. The cross-file byte-identical
// equivalence test lives in the core copy only (single source of truth — the
// agent-package copy is the duplicate that must match core).
// ---------------------------------------------------------------------------

describe("DEFAULT_TEMPLATES workspace prose invariants (agent copy)", () => {
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
});
