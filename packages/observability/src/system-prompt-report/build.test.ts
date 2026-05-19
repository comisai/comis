// SPDX-License-Identifier: Apache-2.0
/**
 * buildSystemPromptReport — TDD cases.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { buildSystemPromptReport } from "./build.js";
import type { BootstrapFileForReport, ResolvedToolForReport } from "./build.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBaseParams(overrides: Partial<Parameters<typeof buildSystemPromptReport>[0]> = {}) {
  return {
    source: "run" as const,
    generatedAt: 1_700_000_000_000,
    agentId: "agent-1",
    sessionId: "session-1",
    systemPrompt: "system body",
    bootstrapMaxChars: 20_000,
    bootstrapFiles: [] as BootstrapFileForReport[],
    tools: [] as ResolvedToolForReport[],
    ...overrides,
  };
}

const SHA = (s: string): string => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("buildSystemPromptReport", () => {
  it("counts_chars_correctly between project-context markers", () => {
    const systemPrompt =
      "abc\n# Project Context\nxyz\n## Silent Replies\nfoo";
    const report = buildSystemPromptReport(
      makeBaseParams({ systemPrompt }),
    );
    expect(report.systemPrompt.chars).toBe(systemPrompt.length);
    // projectContextChars = chars between "# Project Context" header
    // end-of-line and "## Silent Replies" start.
    expect(report.systemPrompt.projectContextChars).toBeGreaterThan(0);
    expect(report.systemPrompt.nonProjectContextChars).toBe(
      report.systemPrompt.chars - report.systemPrompt.projectContextChars,
    );
  });

  it("missing_file_recorded with rawChars=0 and missing=true", () => {
    const bootstrapFiles: BootstrapFileForReport[] = [
      {
        name: "IDENTITY.md",
        missing: true,
        rawChars: 0,
        injectedChars: 0,
      },
    ];
    const report = buildSystemPromptReport(makeBaseParams({ bootstrapFiles }));
    expect(report.injectedWorkspaceFiles).toHaveLength(1);
    expect(report.injectedWorkspaceFiles[0]?.name).toBe("IDENTITY.md");
    expect(report.injectedWorkspaceFiles[0]?.missing).toBe(true);
    expect(report.injectedWorkspaceFiles[0]?.rawChars).toBe(0);
    expect(report.injectedWorkspaceFiles[0]?.sha256).toBeUndefined();
  });

  it("truncated_file_flagged when injectedChars equals bootstrapMaxChars cap", () => {
    const rawContent = "x".repeat(50_000);
    const bootstrapFiles: BootstrapFileForReport[] = [
      {
        name: "AGENTS.md",
        missing: false,
        rawChars: rawContent.length,
        injectedChars: 20_000,
        rawContent,
      },
    ];
    const report = buildSystemPromptReport(
      makeBaseParams({ bootstrapFiles, bootstrapMaxChars: 20_000 }),
    );
    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(true);
    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe(20_000);
  });

  it("agents_md_default_entry produced from a single AGENTS.md bootstrap file", () => {
    const bootstrapFiles: BootstrapFileForReport[] = [
      {
        name: "AGENTS.md",
        missing: false,
        rawChars: 1000,
        injectedChars: 1000,
        rawContent: "agents-md-content",
      },
    ];
    const report = buildSystemPromptReport(makeBaseParams({ bootstrapFiles }));
    expect(report.injectedWorkspaceFiles).toHaveLength(1);
    expect(report.injectedWorkspaceFiles[0]?.name).toBe("AGENTS.md");
    expect(report.injectedWorkspaceFiles[0]?.missing).toBe(false);
    expect(report.injectedWorkspaceFiles[0]?.sha256).toBe(SHA("agents-md-content"));
  });

  it("tools_schema_chars_cached across two builds with the same tool object", () => {
    const sharedSchema = { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } };
    const tool: ResolvedToolForReport = {
      name: "read_file",
      schema: sharedSchema,
    };
    const before = JSON.stringify;
    let stringifyCallCount = 0;
    JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      stringifyCallCount += 1;
      return before.apply(JSON, args);
    }) as typeof JSON.stringify;
    try {
      buildSystemPromptReport(makeBaseParams({ tools: [tool] }));
      const callsAfterFirstBuild = stringifyCallCount;
      buildSystemPromptReport(makeBaseParams({ tools: [tool] }));
      const callsAfterSecondBuild = stringifyCallCount;
      // Second build should NOT add a second JSON.stringify of the same
      // schema object (WeakMap cache hit).
      expect(callsAfterSecondBuild - callsAfterFirstBuild).toBeLessThan(
        callsAfterFirstBuild,
      );
    } finally {
      JSON.stringify = before;
    }
  });

  it("tool_marked_not_callable_when_policy_filtered", () => {
    const tools: ResolvedToolForReport[] = [
      { name: "read_file", schema: { type: "object" } },
      { name: "exec", schema: { type: "object" } },
    ];
    const report = buildSystemPromptReport(
      makeBaseParams({
        tools,
        policyFilteredToolNames: new Set(["exec"]),
      }),
    );
    const execEntry = report.tools.entries.find((e) => e.name === "exec");
    const readEntry = report.tools.entries.find((e) => e.name === "read_file");
    expect(execEntry?.callable).toBe(false);
    expect(readEntry?.callable).toBe(true);
  });

  it("system_prompt_sha256_computed via createHash over assembled prompt", () => {
    const systemPrompt = "the assembled system prompt body";
    const report = buildSystemPromptReport(makeBaseParams({ systemPrompt }));
    expect(report.systemPrompt.sha256).toBe(SHA(systemPrompt));
  });

  it("injected_files_sha256_when_present and omitted when missing", () => {
    const bootstrapFiles: BootstrapFileForReport[] = [
      {
        name: "AGENTS.md",
        missing: false,
        rawChars: 5,
        injectedChars: 5,
        rawContent: "hello",
      },
      {
        name: "USER.md",
        missing: true,
        rawChars: 0,
        injectedChars: 0,
      },
    ];
    const report = buildSystemPromptReport(makeBaseParams({ bootstrapFiles }));
    const agents = report.injectedWorkspaceFiles.find(
      (f) => f.name === "AGENTS.md",
    );
    const user = report.injectedWorkspaceFiles.find((f) => f.name === "USER.md");
    expect(agents?.sha256).toBe(SHA("hello"));
    expect(user?.sha256).toBeUndefined();
  });
});

describe("buildSystemPromptReport — single-trailing-whitespace tolerance (deviation H)", () => {
  it("does_not_flag_single_char_delta_as_truncation: rawChars - injectedChars == 1", () => {
    // Mirrors the audit evidence: SOUL.md 2840→2839, IDENTITY.md
    // 787→786, USER.md 458→457. All three are single-newline strips.
    const bootstrapFiles: BootstrapFileForReport[] = [
      {
        name: "SOUL.md",
        missing: false,
        rawChars: 2840,
        injectedChars: 2839,
        rawContent: "x".repeat(2840),
      },
    ];
    const report = buildSystemPromptReport(makeBaseParams({ bootstrapFiles }));
    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(false);
    expect(report.bootstrapTruncation.filesTruncated).toBe(0);
    expect(report.bootstrapTruncation.applied).toBe(false);
  });

  it("does_flag_multi_char_delta_as_truncation: rawChars - injectedChars > 1", () => {
    const bootstrapFiles: BootstrapFileForReport[] = [
      {
        name: "SOUL.md",
        missing: false,
        rawChars: 2840,
        injectedChars: 2820, // 20-char delta — real truncation
        rawContent: "x".repeat(2840),
      },
    ];
    const report = buildSystemPromptReport(makeBaseParams({ bootstrapFiles }));
    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(true);
    expect(report.bootstrapTruncation.filesTruncated).toBe(1);
    expect(report.bootstrapTruncation.applied).toBe(true);
  });

  it("zero_delta_is_not_truncation: rawChars == injectedChars", () => {
    const bootstrapFiles: BootstrapFileForReport[] = [
      {
        name: "IDENTITY.md",
        missing: false,
        rawChars: 100,
        injectedChars: 100,
        rawContent: "y".repeat(100),
      },
    ];
    const report = buildSystemPromptReport(makeBaseParams({ bootstrapFiles }));
    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(false);
    expect(report.bootstrapTruncation.filesTruncated).toBe(0);
  });

  it("missing_file_never_truncated_regardless_of_delta (existing regression guard)", () => {
    const bootstrapFiles: BootstrapFileForReport[] = [
      {
        name: "USER.md",
        missing: true,
        rawChars: 0,
        injectedChars: 0,
      },
    ];
    const report = buildSystemPromptReport(makeBaseParams({ bootstrapFiles }));
    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(false);
    expect(report.injectedWorkspaceFiles[0]?.missing).toBe(true);
  });
});

describe("buildSystemPromptReport — metadata pass-through", () => {
  beforeEach(() => {
    // No-op; placeholder for any future stateful cache shared across cases.
  });

  it("passes_traceId_provider_model_runId_through_unchanged via context cluster", () => {
    const report = buildSystemPromptReport(
      makeBaseParams({
        context: {
          traceId: "trace-abc",
          provider: "anthropic",
          model: "claude-3-opus",
          runId: "run-42",
          sessionKey: "agent-1:telegram:chat-1",
          workspaceDir: "/tmp/ws",
          tenantId: "tenant-x",
        },
      }),
    );
    expect(report.traceId).toBe("trace-abc");
    expect(report.provider).toBe("anthropic");
    expect(report.model).toBe("claude-3-opus");
    expect(report.runId).toBe("run-42");
    expect(report.sessionKey).toBe("agent-1:telegram:chat-1");
    expect(report.workspaceDir).toBe("/tmp/ws");
    expect(report.tenantId).toBe("tenant-x");
  });

  it("uses_provided_skills_block_when_supplied", () => {
    const report = buildSystemPromptReport(
      makeBaseParams({
        skillsPrompt: {
          entries: [
            { name: "skill-a", blockChars: 120 },
            { name: "skill-b", blockChars: 240 },
          ],
          promptChars: 400,
        },
      }),
    );
    expect(report.skills.entries).toHaveLength(2);
    expect(report.skills.promptChars).toBe(400);
  });

  it("memoryInjection_optional_passed_through_unchanged_when_provided", () => {
    const report = buildSystemPromptReport(
      makeBaseParams({
        memoryInjection: {
          ragHits: 3,
          charsInjected: 512,
          trustTags: ["learned", "system"],
        },
      }),
    );
    expect(report.memoryInjection?.ragHits).toBe(3);
    expect(report.memoryInjection?.charsInjected).toBe(512);
    expect(report.memoryInjection?.trustTags).toEqual(["learned", "system"]);
  });

  // -------------------------------------------------------------------------
  // buildSystemPromptReport must persist bootstrapMaxChars (required) and
  // bootstrapTotalMaxChars (optional) through to the returned report so
  // operators can read the budget knobs that produced the truncation
  // outcome.
  // -------------------------------------------------------------------------
  it("buildSystemPromptReport persists bootstrapMaxChars from BuildParams", () => {
    const report = buildSystemPromptReport(makeBaseParams({ bootstrapMaxChars: 20_000 }));
    expect(report.bootstrapMaxChars).toBe(20_000);
  });

  it("buildSystemPromptReport persists bootstrapTotalMaxChars when supplied", () => {
    const report = buildSystemPromptReport(
      makeBaseParams({ bootstrapMaxChars: 20_000, bootstrapTotalMaxChars: 50_000 }),
    );
    expect(report.bootstrapTotalMaxChars).toBe(50_000);
  });

  it("buildSystemPromptReport omits bootstrapTotalMaxChars when not supplied", () => {
    const report = buildSystemPromptReport(makeBaseParams({ bootstrapMaxChars: 20_000 }));
    expect(report.bootstrapTotalMaxChars).toBeUndefined();
  });
});
