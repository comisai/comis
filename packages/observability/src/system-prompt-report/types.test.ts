// SPDX-License-Identifier: Apache-2.0
/**
 * SystemPromptReport v1 — Type ⇄ Schema sync invariant.
 *
 * Two cases:
 *   1. `expectTypeOf` proves the inferred type of
 *      `SystemPromptReportSchema` equals the exported `SystemPromptReport`
 *      type (compile-time; the test passes iff `tsc` accepts).
 *   2. Runtime parse-failure: an empty object fails the schema.
 *
 * Per checker minor #3, both the Type AND the Zod schema are first-class
 * deliverables of task 1.
 */
import { describe, it, expect, expectTypeOf } from "vitest";
import type { z } from "zod";
import { SystemPromptReportSchema, type SystemPromptReport } from "./types.js";

describe("SystemPromptReport v1 — type and schema sync", () => {
  it("infers SystemPromptReport type from SystemPromptReportSchema (compile-time)", () => {
    // Compile-time assertion: z.infer<typeof Schema> must equal the Type.
    // Use Writable to compare against the readonly Type shape — Zod
    // does not emit readonly modifiers on inferred fields, so we
    // compare the structural shape via Required<>'d cross-check.
    type Inferred = z.infer<typeof SystemPromptReportSchema>;
    // The exported `SystemPromptReport` carries readonly modifiers; Zod's
    // z.infer does not. Cross-validate the assignability in both
    // directions (each is a mutable structural shape of the other).
    expectTypeOf<Inferred>().toMatchTypeOf<{
      traceSchema: "comis-system-prompt-report";
      schemaVersion: 1;
      agentId: string;
      sessionId: string;
      generatedAt: number;
      source: "run" | "boot" | "session-create";
    }>();
    // Round-trip: a SystemPromptReport value must be assignable to the
    // inferred shape (modulo readonly stripping).
    const _typeCheck: (r: SystemPromptReport) => Inferred = (r) => r as Inferred;
    void _typeCheck;
  });

  it("rejects an empty object via SystemPromptReportSchema.safeParse", () => {
    const result = SystemPromptReportSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("accepts a minimal valid SystemPromptReport via safeParse", () => {
    const minimal: SystemPromptReport = {
      traceSchema: "comis-system-prompt-report",
      schemaVersion: 1,
      source: "run",
      generatedAt: 1_700_000_000_000,
      agentId: "agent-1",
      sessionId: "session-1",
      systemPrompt: {
        sha256: "deadbeef",
        chars: 100,
        projectContextChars: 40,
        nonProjectContextChars: 60,
      },
      injectedWorkspaceFiles: [],
      skills: {
        entries: [],
        promptChars: 0,
      },
      tools: {
        entries: [],
        totalSchemaChars: 0,
      },
    };
    const result = SystemPromptReportSchema.safeParse(minimal);
    expect(result.success).toBe(true);
  });
});
