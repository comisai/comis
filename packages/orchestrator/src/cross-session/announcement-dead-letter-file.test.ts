// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeadLetterEntry } from "./announcement-dead-letter.js";
import {
  readDeadLetterEntries,
  writeDeadLetterEntries,
  type DeadLetterWriteOperations,
} from "./announcement-dead-letter-file.js";

const randomBytes = vi.hoisted(() => vi.fn(() => Buffer.from("01020304", "hex")));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomBytes,
}));

function makeEntry(): DeadLetterEntry {
  return {
    id: "entry-1",
    announcementText: "sensitive completion",
    channelType: "telegram",
    channelId: "chat-1",
    runId: "run-1",
    failedAt: 1,
    attemptCount: 0,
    lastAttemptAt: 1,
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

  it("fails closed when any persisted JSONL row is malformed", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    const original = `${JSON.stringify(makeEntry())}\n{"broken":\n`;
    const logger = { warn: vi.fn() };
    await writeFile(filePath, original, { encoding: "utf8", mode: 0o600 });

    const result = await readDeadLetterEntries(filePath, logger);

    expect(result).toMatchObject({ ok: false });
    expect(logger.warn).toHaveBeenCalledWith(
      {
        errorKind: "precondition",
        hint: "repair or quarantine the malformed dead-letter file before accepting or draining announcements",
      },
      "Malformed dead-letter file blocked",
    );
    expect(await readFile(filePath, "utf8")).toBe(original);
  });

  it("fails closed when a JSON row lacks the dead-letter storage contract", async () => {
    directory = await mkdtemp(join(tmpdir(), "comis-dlq-file-"));
    const filePath = join(directory, "dead-letters.jsonl");
    await writeFile(filePath, "{}\n", { encoding: "utf8", mode: 0o600 });

    await expect(readDeadLetterEntries(filePath)).resolves.toMatchObject({
      ok: false,
    });
    expect(await readFile(filePath, "utf8")).toBe("{}\n");
  });
});
