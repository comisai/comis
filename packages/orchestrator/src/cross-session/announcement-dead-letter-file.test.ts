// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationLocator } from "@comis/core";
import type { DeadLetterEntry } from "./announcement-dead-letter.js";
import {
  isAnnouncementChannelType,
  isAnnouncementProducerRecoveryOutcome,
  readDeadLetterEntries,
  readDeadLetterSnapshot,
  writeDeadLetterEntries,
  type DeadLetterWriteOperations,
} from "./announcement-dead-letter-file.js";

const ANNOUNCEMENT_TOOL_RESULT_RESPONSE_MAX_CHARS = 100_000;

const randomBytes = vi.hoisted(() => vi.fn(() => Buffer.from("01020304", "hex")));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomBytes,
}));

function makeEntry(): DeadLetterEntry {
  const locator = createConversationLocator({
    tenantId: "default",
    agentId: "agent-a",
    partition: { kind: "agent" },
  });
  if (!locator.ok) throw locator.error;
  return {
    id: "entry-1",
    announcementText: "sensitive completion",
    channelType: "telegram",
    channelId: "chat-1",
    agentId: "agent-a",
    runId: "run-1",
    sessionKey: "default:agent-a:telegram:chat-1:user_a",
    failedAt: 1,
    attemptCount: 0,
    lastAttemptAt: 1,
    deliveryAuthority: {
      tenantId: "default",
      agentId: "agent-a",
      conversationRef: locator.value.conversationRef,
    },
    destinationEndpoint: {
      channelType: "telegram",
      channelInstanceId: "test-instance",
      conversationId: "chat-1",
      conversationKind: "direct",
    },
  };
}

function createRecordingOperations(
  events: string[],
  failure: { syncPath?: string; chmodPath?: string } = {},
): DeadLetterWriteOperations {
  return {
    open: async (path, flags, mode) => {
      events.push(`open:${path}:${flags}:${mode ?? "none"}`);
      return {
        chmod: async (nextMode) => {
          events.push(`handle-chmod:${path}:${nextMode}`);
        },
        writeFile: async () => {
          events.push(`write:${path}`);
        },
        sync: async () => {
          events.push(`sync:${path}`);
          if (path === failure.syncPath) throw new Error("sync unavailable");
        },
        close: async () => {
          events.push(`close:${path}`);
        },
      };
    },
    rename: async (oldPath, newPath) => {
      events.push(`rename:${oldPath}:${newPath}`);
    },
    unlink: async (path) => {
      events.push(`unlink:${path}`);
    },
    chmod: async (path, mode) => {
      events.push(`chmod:${path}:${mode}`);
      if (path === failure.chmodPath) throw new Error("chmod unavailable");
    },
  };
}

describe("announcement dead-letter file", () => {
  let directory: string | undefined;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("accepts contributed channel identifiers and rejects control characters", () => {
    expect(isAnnouncementChannelType("plugin.acme-chat")).toBe(true);
    expect(isAnnouncementChannelType("plugin/acme\nchat")).toBe(false);
    expect(isAnnouncementChannelType("")).toBe(false);
  });

  it("atomically round-trips a durable queue snapshot", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    const entry = makeEntry();

    expect(await writeDeadLetterEntries(filePath, [entry])).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await readDeadLetterEntries(filePath)).toEqual({
      ok: true,
      value: [entry],
    });
  });

  it("rejects snapshots beyond bounded bytes and physical rows", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    await writeFile(filePath, "{}\n{}\n{}\n", { encoding: "utf8", mode: 0o600 });

    await expect(readDeadLetterSnapshot(filePath, undefined, {
      maxRows: 2,
      maxBytes: 1_024,
    })).resolves.toMatchObject({
      ok: false,
      error: { message: "Dead-letter snapshot exceeds the row limit" },
    });
    await expect(readDeadLetterSnapshot(filePath, undefined, {
      maxRows: 10,
      maxBytes: 4,
    })).resolves.toMatchObject({
      ok: false,
      error: { message: "Dead-letter snapshot exceeds the byte limit" },
    });
  });

  it("restricts the persisted announcement snapshot to the service user", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    const entry = makeEntry();

    expect(await writeDeadLetterEntries(filePath, [entry])).toEqual({
      ok: true,
      value: undefined,
    });

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("syncs the private file and parent directory before persistence succeeds", async () => {
    const events: string[] = [];
    const filePath = "/data/dead-letters.jsonl";
    const temporaryPath = `${filePath}.tmp.01020304`;

    expect(
      await writeDeadLetterEntries(
        filePath,
        [makeEntry()],
        createRecordingOperations(events),
      ),
    ).toEqual({ ok: true, value: undefined });

    expect(events).toEqual([
      `open:${temporaryPath}:wx:${0o600}`,
      `write:${temporaryPath}`,
      `sync:${temporaryPath}`,
      `close:${temporaryPath}`,
      `rename:${temporaryPath}:${filePath}`,
      `chmod:${filePath}:${0o600}`,
      `open:${filePath}:r:none`,
      `sync:${filePath}`,
      `close:${filePath}`,
      "open:/data:r:none",
      "sync:/data",
      "close:/data",
    ]);
  });

  it("avoids fchmod because the daemon Node permission model disables that API", async () => {
    const handleChmod = vi.fn().mockRejectedValue(
      Object.assign(new Error("fchmod API is disabled when Permission Model is enabled."), {
        code: "ERR_ACCESS_DENIED",
      }),
    );
    const operations = createRecordingOperations([]);
    const openOriginal = operations.open;
    operations.open = async (...args) => {
      const handle = await openOriginal(...args);
      return { ...handle, chmod: handleChmod };
    };

    await expect(
      writeDeadLetterEntries("/data/dead-letters.jsonl", [makeEntry()], operations),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(handleChmod).not.toHaveBeenCalled();
  });

  it("returns an error when the parent directory cannot be synced", async () => {
    const events: string[] = [];
    const result = await writeDeadLetterEntries(
      "/data/dead-letters.jsonl",
      [makeEntry()],
      createRecordingOperations(events, { syncPath: "/data" }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { state: "snapshot_visible" },
    });
    expect(events.slice(-3)).toEqual([
      "open:/data:r:none",
      "sync:/data",
      "close:/data",
    ]);
  });

  it.each([
    ["final chmod", { chmodPath: "/data/dead-letters.jsonl" }],
    ["final file sync", { syncPath: "/data/dead-letters.jsonl" }],
  ])("reports a visible snapshot when %s fails after rename", async (_label, failure) => {
    const result = await writeDeadLetterEntries(
      "/data/dead-letters.jsonl",
      [makeEntry()],
      createRecordingOperations([], failure),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { state: "snapshot_visible" },
    });
  });

  it("syncs the parent directory after removing the final queue row", async () => {
    const events: string[] = [];
    const filePath = "/data/dead-letters.jsonl";

    expect(
      await writeDeadLetterEntries(
        filePath,
        [],
        createRecordingOperations(events),
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(events).toEqual([
      `unlink:${filePath}`,
      "open:/data:r:none",
      "sync:/data",
      "close:/data",
    ]);
  });

  it("returns an error result when the temporary-path nonce cannot be created", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    const entry = makeEntry();
    randomBytes.mockImplementationOnce(() => {
      throw new Error("nonce unavailable");
    });

    await expect(writeDeadLetterEntries(filePath, [entry])).resolves.toMatchObject({
      ok: false,
      error: { state: "snapshot_unchanged" },
    });
  });

  it("rejects invalid in-memory rows before replacing a durable snapshot", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    const entry = makeEntry();
    await writeDeadLetterEntries(filePath, [entry]);
    const original = await readFile(filePath, "utf8");

    const result = await writeDeadLetterEntries(filePath, [
      { recordType: "parent_decision_reservation", id: "incomplete" } as never,
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: { state: "snapshot_unchanged" },
    });
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("rejects a tool recovery response above its durable contract", () => {
    expect(isAnnouncementProducerRecoveryOutcome({
      kind: "tool_result",
      terminalReason: "completed",
      completedAtMs: 1,
      response: "x".repeat(ANNOUNCEMENT_TOOL_RESULT_RESPONSE_MAX_CHARS + 1),
      stats: { runtimeMs: 1, totalTokens: 1, totalCost: 0 },
    })).toBe(false);
  });

  it("rejects an oversized in-memory row before replacing a durable snapshot", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    const entry = makeEntry();
    await writeDeadLetterEntries(filePath, [entry]);
    const original = await readFile(filePath, "utf8");

    const result = await writeDeadLetterEntries(filePath, [{
      ...entry,
      announcementText: "x".repeat(1_048_577),
    }]);

    expect(result).toMatchObject({
      ok: false,
      error: { state: "snapshot_unchanged" },
    });
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("bounds oversized persisted evidence and never exposes it in the operator record", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    const oversized = "private-marker-" + "x".repeat(1_048_577);
    await writeFile(filePath, `${oversized}\n`, { encoding: "utf8", mode: 0o600 });

    const result = await readDeadLetterEntries(filePath);

    expect(result).toMatchObject({
      ok: true,
      value: [{
        recordType: "invalid_record",
        reason: "oversized_row",
        rawTruncated: true,
      }],
    });
    if (!result.ok) throw result.error;
    const record = result.value[0] as Record<string, unknown>;
    expect(String(record.rawLine).length).toBeLessThanOrEqual(4_096);
    expect(String(record.rawDigest)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("isolates an oversized persisted row that otherwise matches the schema", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    const oversized = {
      ...makeEntry(),
      announcementText: "x".repeat(1_048_577),
    };
    await writeFile(filePath, `${JSON.stringify(oversized)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    await expect(readDeadLetterEntries(filePath)).resolves.toMatchObject({
      ok: true,
      value: [{
        recordType: "invalid_record",
        reason: "oversized_row",
      }],
    });
  });

  it("isolates a malformed row while preserving valid persisted rows", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    const second = { ...makeEntry(), id: "entry-2", runId: "run-2" };
    const original = `${JSON.stringify(makeEntry())}\n{"broken":\n${JSON.stringify(second)}\n`;
    const logger = { warn: vi.fn() };
    await writeFile(filePath, original, { encoding: "utf8", mode: 0o600 });

    const result = await readDeadLetterEntries(filePath, logger);

    expect(result).toMatchObject({
      ok: true,
      value: [
        { id: "entry-1", runId: "run-1" },
        {
          recordType: "invalid_record",
          reason: "invalid_json",
          sourceLine: 2,
          rawBytes: 10,
        },
        { id: "entry-2", runId: "run-2" },
      ],
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        invalidRowCount: 1,
        errorKind: "precondition",
        hint: "review and explicitly release invalid dead-letter records; valid announcements remain available",
      }),
      "Invalid dead-letter rows quarantined",
    );
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("classifies a JSON row outside the dead-letter storage contract", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    await writeFile(filePath, "{}\n", { encoding: "utf8", mode: 0o600 });

    await expect(readDeadLetterEntries(filePath)).resolves.toMatchObject({
      ok: true,
      value: [{
        recordType: "invalid_record",
        reason: "schema_mismatch",
        sourceLine: 1,
        rawBytes: 2,
      }],
    });
    expect(await readFile(filePath, "utf8")).toBe("{}\n");
  });

  it("isolates a governed row whose authenticated recovery route is incomplete", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    const entry = {
      ...makeEntry(),
      rootRunId: "root-1",
      stepIndex: 1,
    };
    delete (entry as Partial<DeadLetterEntry>).destinationEndpoint;
    await writeFile(filePath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });

    await expect(readDeadLetterEntries(filePath)).resolves.toMatchObject({
      ok: true,
      value: [{
        recordType: "invalid_record",
        reason: "schema_mismatch",
      }],
    });
  });
});
