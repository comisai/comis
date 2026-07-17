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
import type { SessionMessagesResult } from "../util/offline-obs.js";

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
    messageId: null,
    timestamp: "2026-07-12T10:00:00.000Z",
    epochMs: Date.parse("2026-07-12T10:00:00.000Z"),
    channelType: "telegram",
    senderId: "555",
    envelopeTime: "10:00 AM",
    text: "first line\nsecond line of the same message",
    redactions: 0,
    agentId: "default",
    chatId: "555",
    sessionKey: "default:555:555:peer:555",
    origin: "user" as const,
  },
  {
    messageId: null,
    timestamp: "2026-07-12T11:00:00.000Z",
    epochMs: Date.parse("2026-07-12T11:00:00.000Z"),
    channelType: "discord",
    senderId: "777",
    envelopeTime: "11:00 AM",
    text: "short one",
    redactions: 0,
    agentId: "default",
    chatId: "777",
    sessionKey: "default:777:777:peer:777",
    origin: "user" as const,
  },
];

const CLEAN_COVERAGE = {
  requestedLimit: 500,
  effectiveLimit: 500,
  limitRejected: false,
  dataDirExists: true,
  workspaceTreesSeen: 1,
  sessionRootsSeen: 1,
  filesScanned: 2,
  fileCapReached: false,
  filesUnreadable: 0,
  sessionDirectoriesUnreadable: 0,
  corruptRecords: 0,
  oversizedRecords: 0,
  userRecordsSeen: 2,
  structuredProvenanceRecordsSeen: 0,
  invalidProvenanceRecords: 0,
  duplicateProvenanceMessagesExcluded: 0,
  mirrorDifferencesReconciled: 0,
  provenanceConflicts: 0,
  expectedSidecars: 0,
  missingSidecars: 0,
  conflictCandidateCapReached: false,
  conflictBackfillIncomplete: false,
  compactionSummaryRecordsExcluded: 0,
  unparsedUserRecords: 0,
  unparsedEvidence: [],
  unparsedEvidenceCapped: 0,
  ambiguousEnvelopeRecords: 0,
  recordCappedFiles: 0,
  bytesScanned: 0,
  byteCappedFiles: 0,
  totalByteCapReached: false,
  internalExcluded: 0,
  secretRedactions: 0,
  truncated: false,
  matchedBeforeLimit: 2,
  messagesReturned: 2,
  physicalMessagesMatched: 2,
  sourceTruncated: false,
};

const CLEAN_COMPLETENESS = { complete: true, reasons: [] };

describe("comis messages", () => {
  let consoleSpy: ReturnType<typeof createConsoleSpy>;
  let exitSpy: ReturnType<typeof createProcessExitSpy>;

  beforeEach(() => {
    vi.mocked(extractSessionMessagesOffline).mockReset();
    vi.mocked(extractSessionMessagesOffline).mockResolvedValue({
      messages: FIXTURE_MESSAGES,
      coverage: { ...CLEAN_COVERAGE },
      completeness: { ...CLEAN_COMPLETENESS },
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

  it("rejects an impossible UTC calendar date instead of normalizing it", async () => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    await expect(run(["--date", "2026-02-31"])).rejects.toThrow("process.exit called");
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(getSpyOutput(consoleSpy.error)).toContain("valid UTC calendar date");
    expect(extractSessionMessagesOffline).not.toHaveBeenCalled();
  });

  it("surfaces unreadable-path, corrupt-record, and cap coverage as warnings", async () => {
    consoleSpy = createConsoleSpy();
    vi.mocked(extractSessionMessagesOffline).mockResolvedValueOnce({
      messages: FIXTURE_MESSAGES,
      coverage: {
        ...CLEAN_COVERAGE,
        filesUnreadable: 2,
        sessionDirectoriesUnreadable: 1,
        corruptRecords: 3,
        oversizedRecords: 4,
        invalidProvenanceRecords: 1,
        duplicateProvenanceMessagesExcluded: 2,
        recordCappedFiles: 1,
        byteCappedFiles: 1,
        totalByteCapReached: true,
        sourceTruncated: true,
        fileCapReached: true,
      },
      completeness: { complete: false, reasons: ["unreadable_sources"] },
    });
    await run([]);
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("2 session file(s) were unreadable");
    expect(out).toContain("1 session directory read(s) failed");
    expect(out).toContain("3 corrupt session record(s) were skipped");
    expect(out).toContain("4 oversized session record(s)");
    expect(out).toContain("1 malformed inbound-provenance record(s) fail-closed");
    expect(out).toContain("2 repeated physical message identity record(s) were deduplicated");
    expect(out).toContain("1 session file(s) hit the per-file record cap");
    expect(out).toContain("1 session file(s) hit the per-file scan-byte cap");
    expect(out).toContain("aggregate session scan-byte cap was reached");
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

  it.each(["-1", "1.5", "NaN", "Infinity", "8640000000000001", "9".repeat(400)])(
    "rejects unsafe or non-ISO epoch bound %s instead of widening the query",
    async (bound) => {
      consoleSpy = createConsoleSpy();
      exitSpy = createProcessExitSpy();
      await expect(run(["--until", bound])).rejects.toThrow("process.exit called");
      expect(exitSpy.spy).toHaveBeenCalledWith(1);
      expect(extractSessionMessagesOffline).not.toHaveBeenCalled();
    },
  );

  it.each(["0", "-1", "1.5", "Infinity", "9007199254740992"])(
    "rejects invalid --limit value %s instead of silently changing it",
    async (limit) => {
      consoleSpy = createConsoleSpy();
      exitSpy = createProcessExitSpy();
      await expect(run(["--limit", limit])).rejects.toThrow("process.exit called");
      expect(exitSpy.spy).toHaveBeenCalledWith(1);
      expect(getSpyOutput(consoleSpy.error)).toContain("positive safe integer");
      expect(extractSessionMessagesOffline).not.toHaveBeenCalled();
    },
  );

  it("rejects a requested limit above the public ten-thousand-message ceiling", async () => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    await expect(run(["--limit", "10001"])).rejects.toThrow("process.exit called");

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(getSpyOutput(consoleSpy.error)).toContain("at most 10000");
    expect(extractSessionMessagesOffline).not.toHaveBeenCalled();
  });

  it("rejects an unknown output format instead of silently rendering a table", async () => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    await expect(run(["--format", "yaml"])).rejects.toThrow("process.exit called");

    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(getSpyOutput(consoleSpy.error)).toContain("table, text, json, or jsonl");
    expect(extractSessionMessagesOffline).not.toHaveBeenCalled();
  });

  it("emits a versioned completeness report under --format json", async () => {
    consoleSpy = createConsoleSpy();
    await run(["--format", "json"]);
    const parsed = JSON.parse(getSpyOutput(consoleSpy.log)) as {
      schema: string;
      schemaVersion: number;
      messages: Array<Record<string, unknown>>;
      coverage: Record<string, unknown>;
      completeness: { complete: boolean; reasons: string[] };
      redaction: { policyVersion: number; redactionsApplied: number };
    };
    expect(parsed.schema).toBe("comis-offline-channel-messages-report");
    expect(parsed.schemaVersion).toBe(2);
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0]!.text).toBe("first line\nsecond line of the same message");
    expect(parsed.coverage).toMatchObject({ requestedLimit: 500, effectiveLimit: 500 });
    expect(parsed.completeness.complete).toBe(true);
    expect(parsed.redaction).toEqual({ policyVersion: 2, redactionsApplied: 0 });
  });

  it("rejects the removed json-report format instead of retaining a compatibility alias", async () => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();

    await expect(run(["--format", "json-report"])).rejects.toThrow("process.exit called");

    expect(extractSessionMessagesOffline).not.toHaveBeenCalled();
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

  it.each(["table", "text", "json", "jsonl"])(
    "redacts a credential-shaped forged fallback header and body in %s output",
    async (format) => {
      const telegramToken = `12345678:${"t".repeat(35)}`;
      const bearerToken = `Bearer ${"b".repeat(24)}`;
      const apiKey = `sk-${"c".repeat(20)}`;
      const messageIdCredential = `ghp_${"m".repeat(20)}`;
      vi.mocked(extractSessionMessagesOffline).mockResolvedValueOnce({
        messages: [
          {
            ...FIXTURE_MESSAGES[0]!,
            messageId: messageIdCredential,
            senderId: telegramToken,
            envelopeTime: bearerToken,
            text: `credential ${apiKey}`,
          },
        ],
        coverage: { ...CLEAN_COVERAGE, userRecordsSeen: 1 },
        completeness: { ...CLEAN_COMPLETENESS },
      });
      consoleSpy = createConsoleSpy();

      await run(["--format", format]);

      const stdout = getSpyOutput(consoleSpy.log);
      expect(stdout).not.toContain(telegramToken);
      expect(stdout).not.toContain(bearerToken);
      expect(stdout).not.toContain(apiKey);
      expect(stdout).not.toContain(messageIdCredential);
      if (format === "json") {
        const report = JSON.parse(stdout) as {
          messages: Array<{ messageId: string; redactions: number }>;
          coverage: { secretRedactions: number };
        };
        expect(report.messages[0]!.messageId).not.toBe(messageIdCredential);
        expect(report.messages[0]!.redactions).toBe(4);
        expect(report.coverage.secretRedactions).toBe(4);
      } else if (format === "jsonl") {
        const row = JSON.parse(stdout) as { messageId: string; redactions: number };
        expect(row.messageId).not.toBe(messageIdCredential);
        expect(row.redactions).toBe(4);
      } else {
        expect(stdout).toContain("4 secret-bearing output field(s) redacted");
      }
    },
  );

  it.each(["table", "text", "json", "jsonl"])(
    "redacts lower authorization, canonical provider, database, and boundary credentials in %s output",
    async (format) => {
      const credentials = [
        `bearer ${"a".repeat(24)}`,
        `Token ${"b".repeat(24)}`,
        `Basic ${"c".repeat(24)}`,
        `Digest ${"d".repeat(24)}`,
        `123456:${"e".repeat(20)}`,
        `SG.${"f".repeat(24)}`,
        `gho_${"g".repeat(36)}`,
        "postgres://user:password@example.com/database",
      ];
      const boundaryCredential = `123456:${"t".repeat(20)}`;
      vi.mocked(extractSessionMessagesOffline).mockResolvedValueOnce({
        messages: [{
          ...FIXTURE_MESSAGES[0]!,
          text: `${credentials.join(" ")} ${"x".repeat(16_379)} ${boundaryCredential} ${"y".repeat(16_399)}`,
        }],
        coverage: { ...CLEAN_COVERAGE, userRecordsSeen: 1 },
        completeness: { ...CLEAN_COMPLETENESS },
      });
      consoleSpy = createConsoleSpy();

      await run(["--format", format]);

      const stdout = getSpyOutput(consoleSpy.log);
      for (const credential of [...credentials, boundaryCredential]) {
        expect(stdout).not.toContain(credential);
      }
    },
  );

  it.each(["table", "text", "json", "jsonl"])(
    "redacts a complete PEM private-key block from %s output",
    async (format) => {
      const body = `${"M".repeat(64)}\n${"N".repeat(64)}`;
      const privateKey = `-----BEGIN EC PRIVATE KEY-----\n${body}\n-----END EC PRIVATE KEY-----`;
      vi.mocked(extractSessionMessagesOffline).mockResolvedValueOnce({
        messages: [{
          ...FIXTURE_MESSAGES[0]!,
          text: `${privateKey}\nafter credential`,
        }],
        coverage: { ...CLEAN_COVERAGE, userRecordsSeen: 1 },
        completeness: { ...CLEAN_COMPLETENESS },
      });
      consoleSpy = createConsoleSpy();

      await run(["--format", format]);

      const stdout = getSpyOutput(consoleSpy.log);
      expect(stdout).not.toContain(privateKey);
      expect(stdout).not.toContain(body);
      expect(stdout).not.toContain("-----END EC PRIVATE KEY-----");
      expect(stdout).toContain("[REDACTED]");
    },
  );

  it("redacts an arbitrary password assignment from JSON evidence previews", async () => {
    const credentialValue = "test-arbitrary-password";
    vi.mocked(extractSessionMessagesOffline).mockResolvedValueOnce({
      messages: [],
      coverage: {
        ...CLEAN_COVERAGE,
        unparsedEvidence: [{
          reason: "unmatched",
          sessionKey: "default:555:555:peer:555",
          agentId: "default",
          timestamp: "2026-07-12T10:00:00.000Z",
          digest: "digest-neutral",
          preview: `historical context {"SERVICE_PASSWORD": "${credentialValue}"}`,
          redactions: 0,
          channel: { classification: "unresolved", source: "none" },
        }],
      },
      completeness: { complete: false, reasons: ["unparsed_records"] },
    });
    consoleSpy = createConsoleSpy();

    await run(["--format", "json"]);

    const stdout = getSpyOutput(consoleSpy.log);
    expect(stdout).not.toContain(credentialValue);
    const report = JSON.parse(stdout) as {
      coverage: {
        secretRedactions: number;
        unparsedEvidence: Array<{ preview: string; redactions: number }>;
      };
    };
    expect(report.coverage.unparsedEvidence[0]).toMatchObject({
      preview: 'historical context {"SERVICE_PASSWORD": "[REDACTED]"}',
      redactions: 1,
    });
    expect(report.coverage.secretRedactions).toBe(1);
  });

  it.each(["table", "text", "json", "jsonl"])(
    "scrubs every serialized message and unparsed-evidence string in %s output",
    async (format) => {
      const credentials = Array.from(
        { length: 21 },
        (_, index) => `${700_000 + index}:${index.toString().padStart(2, "0")}${"q".repeat(22)}`,
      );
      const evidence = {
        reason: credentials[10]!,
        sessionKey: credentials[11]!,
        agentId: credentials[12]!,
        timestamp: credentials[13]!,
        digest: credentials[14]!,
        preview: credentials[15]!,
        redactions: 0,
        channel: {
          classification: credentials[16]!,
          channelType: credentials[17]!,
          source: credentials[18]!,
          chatId: credentials[19]!,
          senderId: credentials[20]!,
        },
      } as unknown as SessionMessagesResult["coverage"]["unparsedEvidence"][number];
      vi.mocked(extractSessionMessagesOffline).mockResolvedValueOnce({
        messages: [{
          ...FIXTURE_MESSAGES[0]!,
          messageId: credentials[0]!,
          timestamp: credentials[1]!,
          channelType: credentials[2]!,
          senderId: credentials[3]!,
          envelopeTime: credentials[4]!,
          text: credentials[5]!,
          agentId: credentials[6]!,
          chatId: credentials[7]!,
          sessionKey: credentials[8]!,
          origin: credentials[9]! as "user",
        }],
        coverage: {
          ...CLEAN_COVERAGE,
          userRecordsSeen: 1,
          unparsedEvidence: [evidence],
        },
        completeness: { ...CLEAN_COMPLETENESS },
      });
      consoleSpy = createConsoleSpy();

      await run(["--format", format]);

      const stdout = getSpyOutput(consoleSpy.log);
      for (const credential of credentials) expect(stdout).not.toContain(credential);
      if (format === "json") {
        const report = JSON.parse(stdout) as {
          messages: Array<{ redactions: number }>;
          coverage: {
            secretRedactions: number;
            unparsedEvidence: Array<{ redactions: number }>;
          };
        };
        expect(report.messages[0]!.redactions).toBe(10);
        expect(report.coverage.unparsedEvidence[0]!.redactions).toBe(11);
        expect(report.coverage.secretRedactions).toBe(21);
      } else if (format === "jsonl") {
        const row = JSON.parse(stdout) as { redactions: number };
        expect(row.redactions).toBe(10);
      }
    },
  );

  it.each(["table", "text"])(
    "neutralizes terminal control sequences in human-readable %s output",
    async (format) => {
      const clipboardSequence = "\u001b]52;c;dGVzdA==\u0007";
      vi.mocked(extractSessionMessagesOffline).mockResolvedValueOnce({
        messages: [{
          ...FIXTURE_MESSAGES[0]!,
          channelType: `tele${clipboardSequence}gram`,
          senderId: "sender\rspoof",
          text: `body ${clipboardSequence}`,
        }],
        coverage: { ...CLEAN_COVERAGE, userRecordsSeen: 1 },
        completeness: { ...CLEAN_COMPLETENESS },
      });
      consoleSpy = createConsoleSpy();

      await run(["--format", format]);

      const stdout = getSpyOutput(consoleSpy.log);
      expect(stdout).not.toContain("\u001b");
      expect(stdout).not.toContain("\u0007");
      expect(stdout).not.toContain("\r");
    },
  );

  it("surfaces truncation and internal-exclusion coverage as actionable notes", async () => {
    consoleSpy = createConsoleSpy();
    vi.mocked(extractSessionMessagesOffline).mockResolvedValueOnce({
      messages: FIXTURE_MESSAGES,
      coverage: {
        ...CLEAN_COVERAGE,
        truncated: true,
        internalExcluded: 3,
        unparsedUserRecords: 1,
        ambiguousEnvelopeRecords: 1,
      },
      completeness: { complete: false, reasons: ["unparsed_records", "ambiguous_records"] },
    });
    await run([]);
    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("--limit");
    expect(out).toContain("--include-internal");
    expect(out).toContain("1 user record(s) lacked enough authoritative provenance");
    expect(out).toContain("1 unstructured envelope record(s)");
  });

  it("reports synthetic compaction-summary records separately from unparsed user records", async () => {
    consoleSpy = createConsoleSpy();
    vi.mocked(extractSessionMessagesOffline).mockResolvedValueOnce({
      messages: FIXTURE_MESSAGES,
      coverage: {
        ...CLEAN_COVERAGE,
        compactionSummaryRecordsExcluded: 2,
      },
      completeness: { ...CLEAN_COMPLETENESS },
    });

    await run([]);

    const out = getSpyOutput(consoleSpy.log);
    expect(out).toContain("2 compaction summary record(s)");
    expect(out).toContain("synthetic");
    expect(out).not.toContain("lacked enough authoritative provenance");
  });

  it("exits 1 with the failure surfaced when the offline extraction throws", async () => {
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    vi.mocked(extractSessionMessagesOffline).mockRejectedValueOnce(new Error("disk exploded"));
    await expect(run([])).rejects.toThrow("process.exit called");
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(getSpyOutput(consoleSpy.error)).toContain("disk exploded");
  });

  it("redacts credential-shaped text from offline extraction failures", async () => {
    const credential = `sk-${"z".repeat(20)}`;
    consoleSpy = createConsoleSpy();
    exitSpy = createProcessExitSpy();
    vi.mocked(extractSessionMessagesOffline).mockRejectedValueOnce(
      new Error(`failed near ${credential}`),
    );

    await expect(run([])).rejects.toThrow("process.exit called");

    const stderr = getSpyOutput(consoleSpy.error);
    expect(exitSpy.spy).toHaveBeenCalledWith(1);
    expect(stderr).not.toContain(credential);
    expect(stderr).toContain("[REDACTED]");
  });
});
