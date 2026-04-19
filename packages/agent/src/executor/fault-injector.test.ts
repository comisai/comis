import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tryInjectSilentFailure } from "./fault-injector.js";

describe("fault-injector", () => {
  let tmp: string;
  let flagPath: string;
  let logger: { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
  const originalEnv = process.env.COMIS_TEST_SILENT_FAIL_FLAG;
  const originalScope = process.env.COMIS_TEST_SILENT_FAIL_SCOPE;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fault-injector-test-"));
    flagPath = join(tmp, "fault-flag");
    logger = { warn: vi.fn(), debug: vi.fn() };
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.COMIS_TEST_SILENT_FAIL_FLAG;
    } else {
      process.env.COMIS_TEST_SILENT_FAIL_FLAG = originalEnv;
    }
    if (originalScope === undefined) {
      delete process.env.COMIS_TEST_SILENT_FAIL_SCOPE;
    } else {
      process.env.COMIS_TEST_SILENT_FAIL_SCOPE = originalScope;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns undefined (no fault) when env var is unset", () => {
    delete process.env.COMIS_TEST_SILENT_FAIL_FLAG;
    // Even if the file exists, without the env var the injector is inert.
    writeFileSync(flagPath, "");
    expect(tryInjectSilentFailure(logger)).toBeUndefined();
    expect(existsSync(flagPath)).toBe(true); // file untouched
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns undefined (no fault) when env var is set but flag file does not exist", () => {
    process.env.COMIS_TEST_SILENT_FAIL_FLAG = flagPath;
    // Flag not armed.
    expect(tryInjectSilentFailure(logger)).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    // Debug log only fires on unexpected FS errors, not ENOENT.
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("consumes the flag and returns synthetic failure when armed", () => {
    process.env.COMIS_TEST_SILENT_FAIL_FLAG = flagPath;
    writeFileSync(flagPath, "");
    expect(existsSync(flagPath)).toBe(true);

    const result = tryInjectSilentFailure(logger, { agentId: "test-agent" });

    expect(result).toEqual({
      finishReason: "error",
      response: "",
      llmCalls: 0,
      stepsExecuted: 0,
    });
    // Flag auto-consumed.
    expect(existsSync(flagPath)).toBe(false);
    // WARN log with the injected context.
    expect(logger.warn).toHaveBeenCalledOnce();
    const warnArgs = logger.warn.mock.calls[0]!;
    expect(warnArgs[0]).toMatchObject({
      agentId: "test-agent",
      errorKind: "dependency",
    });
    expect(warnArgs[1]).toContain("Synthetic silent LLM failure injected");
  });

  it("only one caller wins when the flag is consumed in parallel (atomic consume)", () => {
    process.env.COMIS_TEST_SILENT_FAIL_FLAG = flagPath;
    writeFileSync(flagPath, "");

    // Simulate 5 parallel execute() calls racing for the same flag.
    const results = [
      tryInjectSilentFailure(logger),
      tryInjectSilentFailure(logger),
      tryInjectSilentFailure(logger),
      tryInjectSilentFailure(logger),
      tryInjectSilentFailure(logger),
    ];

    const winners = results.filter((r) => r !== undefined);
    const losers = results.filter((r) => r === undefined);

    // Exactly one injection fires.
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(4);
    // WARN log only for the winner.
    expect(logger.warn).toHaveBeenCalledOnce();
    // Flag is gone.
    expect(existsSync(flagPath)).toBe(false);
  });

  it("is one-shot: second call after consumption returns undefined (no fault)", () => {
    process.env.COMIS_TEST_SILENT_FAIL_FLAG = flagPath;
    writeFileSync(flagPath, "");

    const first = tryInjectSilentFailure(logger);
    expect(first).toBeDefined();

    // Second call should see ENOENT, return undefined.
    const second = tryInjectSilentFailure(logger);
    expect(second).toBeUndefined();

    // Only the first call should have WARN-logged.
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("falls through to real execution when flag path points to a directory (EISDIR)", () => {
    process.env.COMIS_TEST_SILENT_FAIL_FLAG = tmp; // tmp is the directory itself, not a file

    const result = tryInjectSilentFailure(logger);

    // Unexpected FS error → debug log, no fault injection, no WARN.
    expect(result).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledOnce();
    const debugArgs = logger.debug.mock.calls[0]!;
    expect(debugArgs[1]).toContain("Fault flag consume failed");
  });

  describe("scope gating (COMIS_TEST_SILENT_FAIL_SCOPE)", () => {
    it("SCOPE=subagent: skips parent sessions, flag remains armed", () => {
      process.env.COMIS_TEST_SILENT_FAIL_FLAG = flagPath;
      process.env.COMIS_TEST_SILENT_FAIL_SCOPE = "subagent";
      writeFileSync(flagPath, "");

      const result = tryInjectSilentFailure(logger, { sessionKey: "default:web-user:probe-1" });

      expect(result).toBeUndefined();
      expect(logger.warn).not.toHaveBeenCalled();
      // Flag NOT consumed — subsequent sub-agent call can still fire it.
      expect(existsSync(flagPath)).toBe(true);
    });

    it("SCOPE=subagent: fires on sub-agent sessions", () => {
      process.env.COMIS_TEST_SILENT_FAIL_FLAG = flagPath;
      process.env.COMIS_TEST_SILENT_FAIL_SCOPE = "subagent";
      writeFileSync(flagPath, "");

      const result = tryInjectSilentFailure(logger, {
        sessionKey: "default:sub-agent-abc123:sub-agent:abc123",
      });

      expect(result).toEqual({
        finishReason: "error",
        response: "",
        llmCalls: 0,
        stepsExecuted: 0,
      });
      expect(existsSync(flagPath)).toBe(false);
      expect(logger.warn).toHaveBeenCalledOnce();
    });

    it("SCOPE=parent: fires on parent sessions only", () => {
      process.env.COMIS_TEST_SILENT_FAIL_FLAG = flagPath;
      process.env.COMIS_TEST_SILENT_FAIL_SCOPE = "parent";
      writeFileSync(flagPath, "");

      const subResult = tryInjectSilentFailure(logger, {
        sessionKey: "default:sub-agent-abc:sub-agent:abc",
      });
      expect(subResult).toBeUndefined();
      expect(existsSync(flagPath)).toBe(true); // preserved for parent

      const parentResult = tryInjectSilentFailure(logger, { sessionKey: "default:web-user:probe" });
      expect(parentResult).toBeDefined();
      expect(existsSync(flagPath)).toBe(false);
    });

    it("SCOPE unset (or 'all'): no filtering, any session fires", () => {
      process.env.COMIS_TEST_SILENT_FAIL_FLAG = flagPath;
      delete process.env.COMIS_TEST_SILENT_FAIL_SCOPE;
      writeFileSync(flagPath, "");

      const result = tryInjectSilentFailure(logger, { sessionKey: "default:web-user:probe" });
      expect(result).toBeDefined();
    });
  });
});
