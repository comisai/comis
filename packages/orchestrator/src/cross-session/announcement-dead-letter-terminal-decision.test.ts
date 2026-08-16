// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAnnouncementTerminalDecisionStore,
  createTerminalDecisionRecord,
  isAnnouncementTerminalDecisionRecord,
} from "./announcement-dead-letter-terminal-decision.js";

const owner = {
  announcementText: "completion",
  channelType: "telegram",
  channelId: "chat-1",
  runId: "run-1",
  sessionKey: "default:agent-a:telegram:chat-1:user_a",
  failedAt: 1,
  attemptCount: 5,
};

describe("announcement terminal decisions", () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "announcement-terminal-decisions-"));
    filePath = join(directory, "dead-letters.jsonl");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("matches a content-free terminal decision across reconstructed owners", () => {
    const created = createTerminalDecisionRecord(owner, "no_reply", 10);
    if (!created.ok) throw created.error;

    expect(isAnnouncementTerminalDecisionRecord(created.value)).toBe(true);
    expect(JSON.stringify(created.value)).not.toContain(owner.sessionKey);
  });

  it("persists indexed ledgerless decisions outside the pending snapshot", async () => {
    const store = createAnnouncementTerminalDecisionStore(filePath);

    await expect(store.record(owner, "no_reply")).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(createAnnouncementTerminalDecisionStore(filePath).lookup({ ...owner }))
      .resolves.toMatchObject({ ok: true, value: "no_reply" });
  });

  it("rejects a conflicting outcome for the same durable identity", async () => {
    const store = createAnnouncementTerminalDecisionStore(filePath);

    await store.record(owner, "no_reply");

    await expect(store.record(owner, "discarded")).resolves.toMatchObject({ ok: false });
  });
});
