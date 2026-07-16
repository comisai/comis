// SPDX-License-Identifier: Apache-2.0
/**
 * Behavior tests for the `comis messages` CLI command.
 *
 * `comis messages` extracts the inbound channel messages users typed from the
 * LOCAL session logs (offline-by-design over the operator-owned data dir — the
 * same posture as `comis cost export`; it contacts NO daemon RPC, trivially
 * satisfying the cli-uses-typed-rpc gate) and renders them as a table
 * (preview), full-text chat log, JSON, or JSONL. Filters: channel type, chat
 * id, sender id, agent id, --since/--until (epoch ms, relative `Nm|Nh|Nd`, or
 * ISO date/datetime), the --date one-day sugar, --limit, --include-internal.
 *
 * The offline extraction helper is mocked so the command is driven without a
 * real data dir; the captured filter args assert the option parsing, and the
 * console output asserts each format's shape.
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestProgram,
  createConsoleSpy,
  createProcessExitSpy,
  getSpyOutput,
} from "../test-helpers.js";

// Mock the offline extraction helper so the command runs without a ~/.comis tree.
vi.mock("../util/offline-obs.js", () => ({
  extractSessionMessagesOffline: vi.fn(),
  resolveOfflineDataDir: vi.fn(() => "/fake/.comis"),
}));

// Mock withSpinner to pass-through (no ora spinner in tests).
vi.mock("../output/spinner.js", () => ({
  withSpinner: vi.fn(async (_text: string, fn: () => Promise<unknown>) => fn()),
}));

const { registerMessagesCommand } = await import("./messages.js");
const { extractSessionMessagesOffline } = await import("../util/offline-obs.js");

/** Two fixture extracted messages — the shape the offline helper returns. */
const FIXTURE_MESSAGES = [
  {
    timestamp: "2026-07-12T10:00:00.000Z",
    epochMs: Date.parse("2026-07-12T10:00:00.000Z"),
    channelType: "telegram",
    senderId: "555",
    envelopeTime: "10:00 AM",
    text: "first line\nsecond line of the same message",
    agentId: "default",
    chatId: "555",
    sessionKey: "default:555:555:peer:555",
    origin: "user" as const,
  },
  {
    timestamp: "2026-07-12T11:00:00.000Z",
    epochMs: Date.parse("2026-07-12T11:00:00.000Z"),
    channelType: "discord",
    senderId: "777",
    envelopeTime: "11:00 AM",
    text: "short one",
    agentId: "default",
    chatId: "777",
    sessionKey: "default:777:777:peer:777",
    origin: "user" as const,
  },
];

const CLEAN_COVERAGE = {
  filesScanned: 2,
  fileCapReached: false,
  filesUnreadable: 0,
  userRecordsSeen: 2,
  unparsedUserRecords: 0,
  recordCappedFiles: 0,
  internalExcluded: 0,
  truncated: false,
};

describe("comis messages", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(extractSessionMessagesOffline).mockReset();
    vi.mocked(extractSessionMessagesOffline).mockResolvedValue({
      messages: FIXTURE_MESSAGES,
      coverage: { ...CLEAN_COVERAGE },
    });
  });

  afterEach(() => {
    consoleSpy?.restore();
    exitSpy?.restore();
    vi.clearAllMocks();
  });

  async function run(args: string[]): Promise<void> {
    const program = createTestProgram();
    registerMessagesCommand(program);
    await program.parseAsync(["node", "comis", "messages", ...args]);
  }

  it("renders a first-line preview table with a message-count summary by default", async () => {
    consoleSpy = createConsoleSpy();
    await run([]);
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("telegram");
    expect(out).toContain("first line");
    // The table previews the FIRST line only — the second line rides json/text formats.
    expect(out).not.toContain("second line of the same message");
    expect(out).toContain("2 message(s)");
  });

  it("threads the channel/chat/sender/agent/limit/include-internal filters to the offline extraction", async () => {
    consoleSpy = createConsoleSpy();
    await run([
      "--channel", "telegram",
      "--chat", "555",
      "--sender", "666",
      "--agent", "support",
      "--limit", "50",
      "--include-internal",
    ]);
    expect(extractSessionMessagesOffline).toHaveBeenCalledTimes(1);
    const [dataDir, filter] = vi.mocked(extractSessionMessagesOffline).mock.calls[0]!;
    expect(dataDir).toBe("/fake/.comis");
    expect(filter.channel).toBe("telegram");
    expect(filter.chat).toBe("555");
    expect(filter.sender).toBe("666");
    expect(filter.agent).toBe("support");
    expect(filter.limit).toBe(50);
    expect(filter.includeInternal).toBe(true);
    expect(filter.sinceMs).toBeUndefined();
    expect(filter.untilMs).toBeUndefined();
  });

  it("parses ISO --since/--until into the epoch window", async () => {
    consoleSpy = createConsoleSpy();
    await run(["--since", "2026-07-12T10:00:00Z", "--until", "2026-07-13"]);
    const [, filter] = vi.mocked(extractSessionMessagesOffline).mock.calls[0]!;
    expect(filter.sinceMs).toBe(Date.parse("2026-07-12T10:00:00Z"));
    expect(filter.untilMs).toBe(Date.parse("2026-07-13"));
  });

  it("parses relative --since like 24h against the current clock", async () => {
    consoleSpy = createConsoleSpy();
    const before = Date.now();
    await run(["--since", "24h"]);
    const after = Date.now();
    const [, filter] = vi.mocked(extractSessionMessagesOffline).mock.calls[0]!;
    expect(filter.sinceMs).toBeGreaterThanOrEqual(before - 24 * 3_600_000);
    expect(filter.sinceMs).toBeLessThanOrEqual(after - 24 * 3_600_000);
  });

  it("expands --date into the UTC day window [00:00, next 00:00)", async () => {
    consoleSpy = createConsoleSpy();
    await run(["--date", "2026-07-12"]);
    const [, filter] = vi.mocked(extractSessionMessagesOffline).mock.calls[0]!;
    expect(filter.sinceMs).toBe(Date.parse("2026-07-12T00:00:00.000Z"));
    expect(filter.untilMs).toBe(Date.parse("2026-07-12T00:00:00.000Z") + 86_400_000);
  });

  it("rejects --date combined with --since/--until", async () => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    await expect(run(["--date", "2026-07-12", "--since", "24h"])).rejects.toThrow(
      "process.exit called",
    );
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(extractSessionMessagesOffline).not.toHaveBeenCalled();
  });

  it("rejects a malformed --date with a format-naming error", async () => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    await expect(run(["--date", "12/07/2026"])).rejects.toThrow("process.exit called");
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(getSpyOutput(consoleSpy.error)).toContain("YYYY-MM-DD");
    expect(extractSessionMessagesOffline).not.toHaveBeenCalled();
  });

  it("surfaces unreadable-file and record-cap coverage as warnings", async () => {
    consoleSpy = createConsoleSpy();
    vi.mocked(extractSessionMessagesOffline).mockResolvedValueOnce({
      messages: FIXTURE_MESSAGES,
      coverage: {
        ...CLEAN_COVERAGE,
        filesUnreadable: 2,
        recordCappedFiles: 1,
        fileCapReached: true,
      },
    });
    await run([]);
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("2 session file(s) were unreadable");
    expect(out).toContain("1 session file(s) hit the per-file record cap");
    expect(out).toContain("session-file walk hit its global cap");
  });

  it("rejects an unparsable --since with a form-naming error instead of silently widening", async () => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    await expect(run(["--since", "yesterday-ish"])).rejects.toThrow("process.exit called");
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    const err = getSpyOutput(consoleSpy.error);
    // The error names the accepted forms — a silent widen would dump everything.
    expect(err).toContain("epoch ms");
    expect(extractSessionMessagesOffline).not.toHaveBeenCalled();
  });

  it("emits the full records as JSON under --format json", async () => {
    consoleSpy = createConsoleSpy();
    await run(["--format", "json"]);
    const parsed = JSON.parse(getSpyOutput(consoleSpy.log)) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.text).toBe("first line\nsecond line of the same message");
    expect(parsed[0]!.sessionKey).toBe("default:555:555:peer:555");
  });

  it("emits messages with authoritative extraction coverage as a JSON report", async () => {
    consoleSpy = createConsoleSpy();
    vi.mocked(extractSessionMessagesOffline).mockResolvedValueOnce({
      messages: FIXTURE_MESSAGES,
      coverage: { ...CLEAN_COVERAGE, unparsedUserRecords: 2, truncated: true },
    });

    await run(["--format", "json-report"]);

    expect(JSON.parse(getSpyOutput(consoleSpy.log))).toEqual({
      schema: "comis-offline-channel-messages-report",
      schemaVersion: 1,
      messages: FIXTURE_MESSAGES,
      coverage: { ...CLEAN_COVERAGE, unparsedUserRecords: 2, truncated: true },
    });
  });

  it("emits one JSON record per line under --format jsonl", async () => {
    consoleSpy = createConsoleSpy();
    await run(["--format", "jsonl"]);
    const lines = getSpyOutput(consoleSpy.log).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[1]!) as { senderId: string }).senderId).toBe("777");
  });

  it("renders the full multi-line text under --format text", async () => {
    consoleSpy = createConsoleSpy();
    await run(["--format", "text"]);
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("second line of the same message");
    expect(out).toContain("[telegram] 555");
  });

  it("surfaces truncation and internal-exclusion coverage as actionable notes", async () => {
    consoleSpy = createConsoleSpy();
    vi.mocked(extractSessionMessagesOffline).mockResolvedValueOnce({
      messages: FIXTURE_MESSAGES,
      coverage: { ...CLEAN_COVERAGE, truncated: true, internalExcluded: 3, unparsedUserRecords: 1 },
    });
    await run([]);
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("--limit");
    expect(out).toContain("--include-internal");
    expect(out).toContain("1 user record(s) had no parsable envelope");
  });

  it("exits 1 with the failure surfaced when the offline extraction throws", async () => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    vi.mocked(extractSessionMessagesOffline).mockRejectedValueOnce(new Error("disk exploded"));
    await expect(run([])).rejects.toThrow("process.exit called");
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(getSpyOutput(consoleSpy.error)).toContain("disk exploded");
  });
});
