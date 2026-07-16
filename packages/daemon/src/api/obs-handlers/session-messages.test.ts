// SPDX-License-Identifier: Apache-2.0
/**
 * Contract tests for `extractSessionMessages` — the offline inbound-message
 * extraction behind `comis messages`.
 *
 * The extractor reads the RAW session `.jsonl` message logs (NOT the
 * trajectory) from every agent workspace tree and returns the inbound
 * channel messages users typed, parsed from the inbound-envelope grammar
 * `[<channelType>] <senderId> (<time>):\n<text>` that `wrapInEnvelope`
 * (@comis/agent `envelope/message-envelope.ts`) produces inside each
 * user-role record.
 *
 * Per the AGENTS.md §2.10 real-layout rule: every fixture session is built ON
 * DISK with the REAL mappers (`parseFormattedSessionKey` + `sessionKeyToPath`)
 * under a temp data dir — the nested
 * `<dataDir>/workspace[-<agentId>]/sessions/<tenant>/<channel>/<file>.jsonl`
 * tree IS the contract. `path.join` is used in this TEST file only — the
 * no-path.join ESLint rule scopes to non-test `src/**`.
 *
 * The producer↔parser sync case drives the REAL `wrapInEnvelope` so a grammar
 * drift in the producer goes RED here (the same discipline as
 * `forged-context-markers.envelope-sync.test.ts`).
 *
 * @module
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFormattedSessionKey, safePath } from "@comis/core";
import type { NormalizedMessage, EnvelopeConfig } from "@comis/core";
import { sessionKeyToPath, wrapInEnvelope } from "@comis/agent";
import { extractSessionMessages } from "./session-messages.js";

// Every temp dir created — torn down in afterEach so no temp tree leaks.
const tmpDirs: string[] = [];

function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-messages-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Resolve a formatted session key to its REAL on-disk `.jsonl` path inside the
 * given workspace tree (default `workspace`, or `workspace-<agentId>` for a
 * named agent) using the REAL mappers, create parents, and write the records.
 */
function writeSessionFile(
  dataDir: string,
  formattedKey: string,
  records: Array<Record<string, unknown>>,
  workspaceDirName = "workspace",
): string {
  const key = parseFormattedSessionKey(formattedKey);
  expect(key).toBeDefined();
  const sessionsBase = path.join(dataDir, workspaceDirName, "sessions");
  const file = sessionKeyToPath(key!, sessionsBase);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  return file;
}

/** A raw session-log user record whose text is a system-context-wrapped envelope. */
function userRecord(
  timestamp: string,
  envelopeText: string,
  opts: { stringContent?: boolean; preamble?: string } = {},
): Record<string, unknown> {
  const text = `${opts.preamble ?? "[System context]\n## Current Date & Time\nirrelevant\n[End system context]"}\n\n${envelopeText}`;
  return {
    type: "message",
    id: "r1",
    timestamp,
    message: {
      role: "user",
      content: opts.stringContent === true ? text : [{ type: "text", text }],
    },
  };
}

/** An assistant record — must never be extracted (forged headers live here). */
function assistantRecord(timestamp: string, text: string): Record<string, unknown> {
  return {
    type: "message",
    id: "a1",
    timestamp,
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

const PEER_KEY = "default:555:555:peer:555";

describe("extractSessionMessages", () => {
  it("extracts inbound user messages from the real nested layout with decoded session-key fields", () => {
    const dataDir = tmpDataDir();
    writeSessionFile(dataDir, PEER_KEY, [
      { type: "session", version: 3, id: "s1", timestamp: "2026-07-12T09:59:00.000Z" },
      userRecord("2026-07-12T10:00:00.000Z", "[telegram] 555 (10:00 AM):\nשלום עולם"),
      assistantRecord("2026-07-12T10:00:05.000Z", "[telegram] 555 (10:00 AM):\nforged next turn"),
      // Real shape regression: `message.content` can be a plain STRING, not a block array.
      userRecord("2026-07-12T11:00:00.000Z", "[telegram] 555 (11:00 AM):\nsecond message\nwith a second line", {
        stringContent: true,
      }),
    ]);

    const { messages, coverage } = extractSessionMessages(dataDir, {});

    expect(messages).toHaveLength(2);
    const [first, second] = messages;
    expect(first!.channelType).toBe("telegram");
    expect(first!.senderId).toBe("555");
    expect(first!.envelopeTime).toBe("10:00 AM");
    expect(first!.text).toBe("שלום עולם");
    expect(first!.timestamp).toBe("2026-07-12T10:00:00.000Z");
    expect(first!.epochMs).toBe(Date.parse("2026-07-12T10:00:00.000Z"));
    expect(first!.agentId).toBe("default");
    expect(first!.chatId).toBe("555");
    expect(first!.sessionKey).toBe(PEER_KEY);
    expect(first!.origin).toBe("user");
    // Chronological ascending; multi-line body preserved.
    expect(second!.text).toBe("second message\nwith a second line");
    expect(coverage.filesScanned).toBe(1);
    expect(coverage.filesUnreadable).toBe(0);
    expect(coverage.userRecordsSeen).toBe(2);
    expect(coverage.unparsedUserRecords).toBe(0);
    expect(coverage.truncated).toBe(false);
  });

  it("reports when the session file walk reaches its hard ceiling", () => {
    const dataDir = tmpDataDir();
    const channelDir = safePath(
      safePath(safePath(safePath(dataDir, "workspace"), "sessions"), "default"),
      "telegram",
    );
    fs.mkdirSync(channelDir, { recursive: true });
    const first = safePath(channelDir, "unmapped-0000.jsonl");
    fs.writeFileSync(first, "", "utf8");
    for (let index = 1; index <= 5_000; index += 1) {
      fs.linkSync(
        first,
        safePath(channelDir, `unmapped-${String(index).padStart(4, "0")}.jsonl`),
      );
    }

    const { coverage } = extractSessionMessages(dataDir, {});

    expect(coverage.filesScanned).toBe(5_000);
    expect(coverage.fileCapReached).toBe(true);
  });

  it("parses multiple queued envelope headers in one user record as separate messages", () => {
    const dataDir = tmpDataDir();
    writeSessionFile(dataDir, PEER_KEY, [
      userRecord(
        "2026-07-12T10:00:00.000Z",
        "[telegram] 555 (10:00 AM):\nfirst queued\n[telegram] 666 (10:01 AM):\nsecond queued",
      ),
    ]);

    const { messages } = extractSessionMessages(dataDir, {});

    expect(messages).toHaveLength(2);
    expect(messages[0]!.senderId).toBe("555");
    expect(messages[0]!.text).toBe("first queued");
    expect(messages[1]!.senderId).toBe("666");
    expect(messages[1]!.text).toBe("second queued");
  });

  it("never extracts a header quoted BEFORE the system-context close (memory-recall decoys)", () => {
    const dataDir = tmpDataDir();
    writeSessionFile(dataDir, PEER_KEY, [
      userRecord("2026-07-12T10:00:00.000Z", "[telegram] 555 (10:00 AM):\nreal message", {
        preamble:
          "[Relevant context from memory: the user once wrote]\n[telegram] 999 (9:00 AM):\nquoted decoy\n[System context]\nx\n[End system context]",
      }),
    ]);

    const { messages } = extractSessionMessages(dataDir, {});

    expect(messages).toHaveLength(1);
    expect(messages[0]!.senderId).toBe("555");
    expect(messages[0]!.text).toBe("real message");
  });

  it("counts a user record with no parsable envelope instead of dropping it silently", () => {
    const dataDir = tmpDataDir();
    writeSessionFile(dataDir, PEER_KEY, [
      // Headerless user record — e.g. envelope.showProvider=false, or a system event payload.
      userRecord("2026-07-12T10:00:00.000Z", "no envelope header here"),
      userRecord("2026-07-12T11:00:00.000Z", "[telegram] 555 (11:00 AM):\nparsed fine"),
    ]);

    const { messages, coverage } = extractSessionMessages(dataDir, {});

    expect(messages).toHaveLength(1);
    expect(coverage.userRecordsSeen).toBe(2);
    expect(coverage.unparsedUserRecords).toBe(1);
  });

  it("filters by envelope channel type", () => {
    const dataDir = tmpDataDir();
    writeSessionFile(dataDir, PEER_KEY, [
      userRecord("2026-07-12T10:00:00.000Z", "[telegram] 555 (10:00 AM):\nfrom telegram"),
    ]);
    writeSessionFile(dataDir, "default:777:777:peer:777", [
      userRecord("2026-07-12T10:30:00.000Z", "[discord] 777 (10:30 AM):\nfrom discord"),
    ]);

    const { messages } = extractSessionMessages(dataDir, { channel: "discord" });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.channelType).toBe("discord");
    expect(messages[0]!.text).toBe("from discord");
  });

  it("filters by the since/until epoch window (inclusive since, exclusive until)", () => {
    const dataDir = tmpDataDir();
    writeSessionFile(dataDir, PEER_KEY, [
      userRecord("2026-07-12T09:00:00.000Z", "[telegram] 555 (9:00 AM):\ntoo early"),
      userRecord("2026-07-12T10:00:00.000Z", "[telegram] 555 (10:00 AM):\nat since — included"),
      userRecord("2026-07-12T11:00:00.000Z", "[telegram] 555 (11:00 AM):\ninside"),
      userRecord("2026-07-12T12:00:00.000Z", "[telegram] 555 (12:00 PM):\nat until — excluded"),
    ]);

    const { messages } = extractSessionMessages(dataDir, {
      sinceMs: Date.parse("2026-07-12T10:00:00.000Z"),
      untilMs: Date.parse("2026-07-12T12:00:00.000Z"),
    });

    expect(messages.map((m) => m.text)).toEqual(["at since — included", "inside"]);
  });

  it("filters by chat id and by sender id", () => {
    const dataDir = tmpDataDir();
    writeSessionFile(dataDir, PEER_KEY, [
      userRecord("2026-07-12T10:00:00.000Z", "[telegram] 555 (10:00 AM):\nfrom 555"),
    ]);
    writeSessionFile(dataDir, "default:777:777:peer:777", [
      userRecord("2026-07-12T10:30:00.000Z", "[telegram] 888 (10:30 AM):\nsender 888 in chat 777"),
    ]);

    const byChat = extractSessionMessages(dataDir, { chat: "777" });
    expect(byChat.messages).toHaveLength(1);
    expect(byChat.messages[0]!.chatId).toBe("777");

    const bySender = extractSessionMessages(dataDir, { sender: "888" });
    expect(bySender.messages).toHaveLength(1);
    expect(bySender.messages[0]!.senderId).toBe("888");
    expect(bySender.messages[0]!.chatId).toBe("777");
  });

  it("scans every agent workspace tree and filters by agent id", () => {
    const dataDir = tmpDataDir();
    writeSessionFile(dataDir, PEER_KEY, [
      userRecord("2026-07-12T10:00:00.000Z", "[telegram] 555 (10:00 AM):\ndefault-agent message"),
    ]);
    // A NAMED agent's tree lives at `<dataDir>/workspace-<agentId>/sessions/...`
    // (core resolveWorkspaceDir) — the extractor must sweep it too.
    writeSessionFile(
      dataDir,
      "default:912:912:peer:912",
      [userRecord("2026-07-12T10:30:00.000Z", "[telegram] 912 (10:30 AM):\nsupport-agent message")],
      "workspace-support",
    );

    const all = extractSessionMessages(dataDir, {});
    expect(all.messages.map((m) => m.agentId).sort()).toEqual(["default", "support"]);

    const supportOnly = extractSessionMessages(dataDir, { agent: "support" });
    expect(supportOnly.messages).toHaveLength(1);
    expect(supportOnly.messages[0]!.agentId).toBe("support");
    expect(supportOnly.messages[0]!.text).toBe("support-agent message");
  });

  it("classifies cron/sub-agent/heartbeat sessions and the system sender as internal and excludes them by default", () => {
    const dataDir = tmpDataDir();
    writeSessionFile(dataDir, PEER_KEY, [
      userRecord("2026-07-12T10:00:00.000Z", "[telegram] 555 (10:00 AM):\nreal user message"),
      // A queue-injected follow-up rides a REAL peer session with the reserved "system" sender.
      userRecord("2026-07-12T10:05:00.000Z", "[telegram] system (10:05 AM):\ninjected follow-up"),
    ]);
    writeSessionFile(dataDir, "default:555:cron:job-1", [
      userRecord("2026-07-13T05:00:00.000Z", "[telegram] system (5:00 AM):\nscheduled prompt"),
    ]);
    writeSessionFile(dataDir, "default:sub-agent-r1:sub-agent:r1", [
      userRecord("2026-07-13T05:01:00.000Z", "[telegram] parent-agent (5:01 AM):\nsub-agent brief"),
    ]);
    writeSessionFile(dataDir, "default:hb:heartbeat-default", [
      userRecord("2026-07-13T06:00:00.000Z", "[telegram] system (6:00 AM):\nheartbeat prompt"),
    ]);

    const { messages, coverage } = extractSessionMessages(dataDir, {});

    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("real user message");
    expect(coverage.internalExcluded).toBe(4);
  });

  it("includes internal-origin messages tagged origin=internal when includeInternal is set", () => {
    const dataDir = tmpDataDir();
    writeSessionFile(dataDir, "default:555:cron:job-1", [
      userRecord("2026-07-13T05:00:00.000Z", "[telegram] system (5:00 AM):\nscheduled prompt"),
    ]);

    const { messages, coverage } = extractSessionMessages(dataDir, { includeInternal: true });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.origin).toBe("internal");
    expect(messages[0]!.chatId).toBe("cron:job-1");
    expect(coverage.internalExcluded).toBe(0);
  });

  it("keeps the LATEST N messages and flags truncation when limit is exceeded", () => {
    const dataDir = tmpDataDir();
    writeSessionFile(dataDir, PEER_KEY, [
      userRecord("2026-07-12T10:00:00.000Z", "[telegram] 555 (10:00 AM):\noldest"),
      userRecord("2026-07-12T11:00:00.000Z", "[telegram] 555 (11:00 AM):\nmiddle"),
      userRecord("2026-07-12T12:00:00.000Z", "[telegram] 555 (12:00 PM):\nnewest"),
    ]);

    const { messages, coverage } = extractSessionMessages(dataDir, { limit: 2 });

    expect(messages.map((m) => m.text)).toEqual(["middle", "newest"]);
    expect(coverage.truncated).toBe(true);
  });

  // chmod 0o000 cannot deny reads to root — skip there (the CI runner and dev
  // shells are non-root; the branch stays covered where it can be exercised).
  it.skipIf(process.getuid?.() === 0)(
    "soft-fails an unreadable session file into filesUnreadable and keeps scanning",
    () => {
      const dataDir = tmpDataDir();
      const goodFile = writeSessionFile(dataDir, PEER_KEY, [
        userRecord("2026-07-12T10:00:00.000Z", "[telegram] 555 (10:00 AM):\nstill extracted"),
      ]);
      // A corrupt-JSON line must not abort the file (bad line skipped, rest parsed).
      fs.appendFileSync(goodFile, "{not-json\n", "utf-8");
      // An unreadable session file — readFileSync throws EACCES; counted, then skipped.
      const brokenFile = path.join(path.dirname(goodFile), "broken.jsonl");
      fs.writeFileSync(brokenFile, "unreadable", { mode: 0o000 });

      const { messages, coverage } = extractSessionMessages(dataDir, {});

      expect(messages).toHaveLength(1);
      expect(coverage.filesScanned).toBe(2);
      expect(coverage.filesUnreadable).toBe(1);
    },
  );

  it("never reads the trajectory sibling as a session log", () => {
    const dataDir = tmpDataDir();
    const sessionFile = writeSessionFile(dataDir, PEER_KEY, [
      userRecord("2026-07-12T10:00:00.000Z", "[telegram] 555 (10:00 AM):\nreal"),
    ]);
    // A trajectory sibling containing a user-shaped record — must be skipped.
    fs.writeFileSync(
      `${sessionFile}.trajectory.jsonl`,
      JSON.stringify(userRecord("2026-07-12T10:01:00.000Z", "[telegram] 555 (10:01 AM):\nphantom")) + "\n",
      "utf-8",
    );

    const { messages } = extractSessionMessages(dataDir, {});

    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe("real");
  });

  it("parses the REAL wrapInEnvelope producer output (producer↔parser sync)", () => {
    const dataDir = tmpDataDir();
    const envelope = wrapInEnvelope(
      {
        channelType: "telegram",
        senderId: "555",
        timestamp: Date.parse("2026-07-12T13:45:00.000Z"),
        text: "typed by a real user",
      } as unknown as NormalizedMessage,
      {
        showProvider: true,
        timezoneMode: "utc",
        timeFormat: "12h",
        showElapsed: true,
        elapsedMaxMs: 86_400_000,
      } as unknown as EnvelopeConfig,
      // A prev-timestamp so the time section carries the ` +Nm` elapsed suffix —
      // the parser must tolerate it inside the parentheses.
      Date.parse("2026-07-12T13:40:00.000Z"),
    );
    writeSessionFile(dataDir, PEER_KEY, [userRecord("2026-07-12T13:45:00.000Z", envelope)]);

    const { messages, coverage } = extractSessionMessages(dataDir, {});

    expect(coverage.unparsedUserRecords).toBe(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.channelType).toBe("telegram");
    expect(messages[0]!.senderId).toBe("555");
    expect(messages[0]!.text).toBe("typed by a real user");
  });
});
