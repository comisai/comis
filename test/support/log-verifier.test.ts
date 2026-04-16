import { describe, it, expect } from "vitest";
import {
  parseLogLines,
  createLogCapture,
  assertLogContains,
  assertLogSequence,
  filterLogs,
} from "./log-verifier.js";

// ---------------------------------------------------------------------------
// Sample log lines (Pino JSON format)
// ---------------------------------------------------------------------------

const SAMPLE_LOGS = [
  '{"level":"info","levelValue":30,"time":"2026-01-01T00:00:00.000Z","msg":"Comis daemon started","name":"comis-daemon"}',
  '{"level":"debug","levelValue":20,"time":"2026-01-01T00:00:01.000Z","msg":"Memory services initialized","name":"comis-daemon","dbPath":"/tmp/test.db"}',
  '{"level":"info","levelValue":30,"time":"2026-01-01T00:00:02.000Z","msg":"Agent executor initialized","name":"comis-daemon","agentId":"default"}',
  '{"level":"info","levelValue":30,"time":"2026-01-01T00:00:03.000Z","msg":"Gateway server started","name":"comis-daemon","host":"127.0.0.1","port":4766}',
].join("\n");

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("log-verifier", () => {
  describe("parseLogLines", () => {
    it("parses valid JSON log lines into LogEntry array", () => {
      const entries = parseLogLines(SAMPLE_LOGS);
      expect(entries).toHaveLength(4);
      expect(entries[0]!.level).toBe("info");
      expect(entries[0]!.msg).toBe("Comis daemon started");
      expect(entries[0]!.name).toBe("comis-daemon");
      expect(entries[1]!.level).toBe("debug");
      expect(entries[1]!.msg).toBe("Memory services initialized");
      expect(entries[1]!.dbPath).toBe("/tmp/test.db");
    });

    it("skips non-JSON lines gracefully", () => {
      const input = [
        '{"level":"info","levelValue":30,"time":"2026-01-01T00:00:00.000Z","msg":"hello"}',
        "this is not json",
        "[2026-01-01] some pino-pretty output",
        '{"level":"warn","levelValue":40,"time":"2026-01-01T00:00:01.000Z","msg":"warning"}',
      ].join("\n");

      const entries = parseLogLines(input);
      expect(entries).toHaveLength(2);
      expect(entries[0]!.level).toBe("info");
      expect(entries[1]!.level).toBe("warn");
    });

    it("handles empty input", () => {
      expect(parseLogLines("")).toHaveLength(0);
      expect(parseLogLines("   ")).toHaveLength(0);
      expect(parseLogLines("\n\n\n")).toHaveLength(0);
    });

    it("skips JSON objects without level and msg fields", () => {
      const input = [
        '{"foo":"bar"}',
        '{"level":"info","levelValue":30,"time":"2026-01-01T00:00:00.000Z","msg":"valid"}',
      ].join("\n");

      const entries = parseLogLines(input);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.msg).toBe("valid");
    });
  });

  describe("createLogCapture", () => {
    it("captures written chunks and parses as log entries", () => {
      const { stream, getEntries } = createLogCapture();

      stream.write('{"level":"info","levelValue":30,"time":"2026-01-01T00:00:00.000Z","msg":"test line 1"}\n');
      stream.write('{"level":"debug","levelValue":20,"time":"2026-01-01T00:00:01.000Z","msg":"test line 2"}\n');

      const entries = getEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0]!.msg).toBe("test line 1");
      expect(entries[1]!.msg).toBe("test line 2");
    });

    it("returns empty array when nothing written", () => {
      const { getEntries } = createLogCapture();
      expect(getEntries()).toHaveLength(0);
    });

    it("handles Buffer chunks", () => {
      const { stream, getEntries } = createLogCapture();
      const line = '{"level":"info","levelValue":30,"time":"2026-01-01T00:00:00.000Z","msg":"buffer test"}\n';
      stream.write(Buffer.from(line, "utf-8"));

      const entries = getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.msg).toBe("buffer test");
    });
  });

  describe("assertLogContains", () => {
    const entries = parseLogLines(SAMPLE_LOGS);

    it("matches by level", () => {
      const result = assertLogContains(entries, { level: "debug" });
      expect(result.matched).toBe(true);
      expect(result.entry!.msg).toBe("Memory services initialized");
    });

    it("matches by msg substring", () => {
      const result = assertLogContains(entries, { msg: "Gateway server" });
      expect(result.matched).toBe(true);
      expect(result.entry!.msg).toBe("Gateway server started");
    });

    it("matches by msg regex", () => {
      const result = assertLogContains(entries, { msg: /agent.*initialized/i });
      expect(result.matched).toBe(true);
      expect(result.entry!.msg).toBe("Agent executor initialized");
    });

    it("matches by arbitrary field (e.g., agentId)", () => {
      const result = assertLogContains(entries, { agentId: "default" });
      expect(result.matched).toBe(true);
      expect(result.entry!.msg).toBe("Agent executor initialized");
    });

    it("matches by multiple fields simultaneously", () => {
      const result = assertLogContains(entries, { level: "info", port: 4766 });
      expect(result.matched).toBe(true);
      expect(result.entry!.msg).toBe("Gateway server started");
    });

    it("returns matched:false when no match", () => {
      const result = assertLogContains(entries, { level: "fatal" });
      expect(result.matched).toBe(false);
      expect(result.error).toContain("No log entry matches pattern");
      expect(result.error).toContain("fatal");
    });

    it("returns the matched entry on success", () => {
      const result = assertLogContains(entries, { msg: "Comis daemon started" });
      expect(result.matched).toBe(true);
      expect(result.entry).toBeDefined();
      expect(result.entry!.level).toBe("info");
      expect(result.entry!.time).toBe("2026-01-01T00:00:00.000Z");
    });
  });

  describe("assertLogSequence", () => {
    const entries = parseLogLines(SAMPLE_LOGS);

    it("finds patterns in correct order", () => {
      const result = assertLogSequence(entries, [
        { msg: "daemon started" },
        { msg: "Memory services" },
        { msg: "Gateway server" },
      ]);
      expect(result.matched).toBe(true);
      expect(result.entries).toHaveLength(3);
    });

    it("fails when order is wrong", () => {
      const result = assertLogSequence(entries, [
        { msg: "Gateway server" },
        { msg: "daemon started" },
      ]);
      expect(result.matched).toBe(false);
      expect(result.error).toContain("Pattern 1 not found after index");
    });

    it("fails when pattern is missing", () => {
      const result = assertLogSequence(entries, [
        { msg: "daemon started" },
        { msg: "this does not exist" },
      ]);
      expect(result.matched).toBe(false);
      expect(result.error).toContain("Pattern 1 not found");
    });

    it("returns all matched entries on success", () => {
      const result = assertLogSequence(entries, [
        { level: "info", msg: "daemon started" },
        { level: "debug" },
        { agentId: "default" },
      ]);
      expect(result.matched).toBe(true);
      expect(result.entries).toHaveLength(3);
      expect(result.entries![0]!.msg).toBe("Comis daemon started");
      expect(result.entries![1]!.msg).toBe("Memory services initialized");
      expect(result.entries![2]!.msg).toBe("Agent executor initialized");
    });

    it("handles empty patterns array", () => {
      const result = assertLogSequence(entries, []);
      expect(result.matched).toBe(true);
      expect(result.entries).toHaveLength(0);
    });
  });

  describe("filterLogs", () => {
    const entries = parseLogLines(SAMPLE_LOGS);

    it("returns all matching entries", () => {
      const infoLogs = filterLogs(entries, { level: "info" });
      expect(infoLogs).toHaveLength(3);
      infoLogs.forEach((entry) => expect(entry.level).toBe("info"));
    });

    it("returns empty array when no matches", () => {
      const fatalLogs = filterLogs(entries, { level: "fatal" });
      expect(fatalLogs).toHaveLength(0);
    });

    it("filters by regex pattern", () => {
      const matched = filterLogs(entries, { msg: /initialized/ });
      expect(matched).toHaveLength(2);
    });
  });
});
