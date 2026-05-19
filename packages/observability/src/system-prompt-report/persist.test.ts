// SPDX-License-Identifier: Apache-2.0
/**
 * persistSystemPromptReport — TDD cases per design §8.5.
 *
 * Both dual targets (`observabilityStore` and the
 * `SessionStoreReportSink` soft port) are exercised. The persist
 * function returns `Result` per AGENTS.md §2.1 — never throws.
 */
import { describe, it, expect, vi } from "vitest";
import type { SystemPromptReport } from "./types.js";
import type { ObservabilityStoreLike, SessionStoreReportSink } from "./persist.js";
import { persistSystemPromptReport } from "./persist.js";

function makeReport(overrides: Partial<SystemPromptReport> = {}): SystemPromptReport {
  return {
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
    skills: { entries: [], promptChars: 0 },
    tools: { entries: [], totalSchemaChars: 0 },
    ...overrides,
  };
}

function makeObsStore(): ObservabilityStoreLike & { insertSystemPromptReport: ReturnType<typeof vi.fn> } {
  return {
    insertSystemPromptReport: vi.fn(),
  };
}

function makeSessionSink(): SessionStoreReportSink & { writeSystemPromptReport: ReturnType<typeof vi.fn> } {
  return {
    writeSystemPromptReport: vi.fn(),
  };
}

describe("persistSystemPromptReport", () => {
  it("writes_to_session_entry when sessionStore is provided", async () => {
    const sessionStore = makeSessionSink();
    const report = makeReport();
    const result = await persistSystemPromptReport(report, { sessionStore });
    expect(result.ok).toBe(true);
    expect(sessionStore.writeSystemPromptReport).toHaveBeenCalledTimes(1);
    const arg = sessionStore.writeSystemPromptReport.mock.calls[0][0];
    expect(arg.sessionId).toBe("session-1");
    expect(arg.report).toBeDefined();
  });

  it("appends_to_observability_store when observabilityStore is provided", async () => {
    const observabilityStore = makeObsStore();
    const report = makeReport({ provider: "anthropic", model: "claude-3-opus" });
    const result = await persistSystemPromptReport(report, { observabilityStore });
    expect(result.ok).toBe(true);
    expect(observabilityStore.insertSystemPromptReport).toHaveBeenCalledTimes(1);
    const row = observabilityStore.insertSystemPromptReport.mock.calls[0][0];
    expect(row.agentId).toBe("agent-1");
    expect(row.sessionId).toBe("session-1");
    expect(row.systemSha256).toBe("deadbeef");
    expect(row.systemChars).toBe(100);
    expect(row.provider).toBe("anthropic");
    expect(row.model).toBe("claude-3-opus");
    // report_json is a valid JSON string
    expect(() => JSON.parse(row.reportJson)).not.toThrow();
  });

  it("double_write_when_both_provided invokes both sinks once", async () => {
    const observabilityStore = makeObsStore();
    const sessionStore = makeSessionSink();
    const report = makeReport();
    const result = await persistSystemPromptReport(report, {
      observabilityStore,
      sessionStore,
    });
    expect(result.ok).toBe(true);
    expect(observabilityStore.insertSystemPromptReport).toHaveBeenCalledTimes(1);
    expect(sessionStore.writeSystemPromptReport).toHaveBeenCalledTimes(1);
  });

  it("redaction_applied_before_persist via sanitizeForPersistence", async () => {
    const observabilityStore = makeObsStore();
    const report = makeReport({
      tools: {
        // Embed a credential-shaped substring in a tool name; the
        // sanitizer should mask it before INSERT.
        entries: [
          {
            name: "tool-leak-sk-ant-api03-AABBCCDDEEFFGGHHIIJJKKLL-very-long-suffix-text",
            propertiesCount: 0,
            schemaChars: 0,
            callable: true,
          },
        ],
        totalSchemaChars: 0,
      },
    });
    await persistSystemPromptReport(report, { observabilityStore });
    const row = observabilityStore.insertSystemPromptReport.mock.calls[0][0];
    const persistedJson = row.reportJson;
    // Raw secret-shaped substring must not survive in the persisted JSON.
    expect(persistedJson).not.toContain(
      "sk-ant-api03-AABBCCDDEEFFGGHHIIJJKKLL-very-long-suffix-text",
    );
  });

  it("degrades_silently_on_store_error returns err(...) with no throw", async () => {
    const observabilityStore: ObservabilityStoreLike = {
      insertSystemPromptReport: vi.fn(() => {
        throw new Error("DB busy");
      }),
    };
    const sessionStore = makeSessionSink();
    const report = makeReport();
    // No throw; returns err Result.
    const result = await persistSystemPromptReport(report, {
      observabilityStore,
      sessionStore,
    });
    expect(result.ok).toBe(false);
    // session-store write still attempted (best-effort)
    expect(sessionStore.writeSystemPromptReport).toHaveBeenCalledTimes(1);
  });

  it("returns ok when no stores are provided (no-op success)", async () => {
    const report = makeReport();
    const result = await persistSystemPromptReport(report, {});
    expect(result.ok).toBe(true);
  });

  it("propagates session-store errors as a non-throwing Result.err", async () => {
    const sessionStore: SessionStoreReportSink = {
      writeSystemPromptReport: vi.fn(() => {
        throw new Error("session DB read-only");
      }),
    };
    const report = makeReport();
    const result = await persistSystemPromptReport(report, { sessionStore });
    expect(result.ok).toBe(false);
  });
});
