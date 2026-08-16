// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err } from "@comis/shared";
import { ConversationRefSchema } from "@comis/core";
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

  it("retires replay guards only when their producer completion retires", async () => {
    const store = createAnnouncementTerminalDecisionStore(filePath);
    const second = { ...owner, runId: "run-2", idempotencyKey: "operation-2" };
    const third = { ...owner, runId: "run-3", idempotencyKey: "operation-3" };

    await store.record(owner, "delivered");
    await store.record(second, "discarded");
    await store.record({
      ...third,
      completionKeys: ["completion-3a", "completion-3b"],
    }, "no_reply");

    await expect(store.retire(["completion-3a"])).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(store.lookup(owner)).resolves.toEqual({ ok: true, value: "delivered" });
    await expect(store.lookup(second)).resolves.toEqual({ ok: true, value: "discarded" });
    await expect(store.lookup(third)).resolves.toEqual({ ok: true, value: "no_reply" });
    await expect(store.retire(["completion-3b"])).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(store.lookup(third)).resolves.toEqual({ ok: true, value: undefined });
    expect(await readdir(directory)).toEqual(["dead-letters.jsonl.terminal-decisions.jsonl"]);
    const rows = (await readFile(
      join(directory, "dead-letters.jsonl.terminal-decisions.jsonl"),
      "utf8",
    )).trim().split("\n");
    expect(rows).toHaveLength(2);
  });

  it("recovers a prepared retirement after producer deletion", async () => {
    const producer = {
      tenantId: "tenant_a",
      agentId: "agent_a",
      conversationRef: ConversationRefSchema.parse(`cv_${"a".repeat(43)}`),
    };
    const first = createAnnouncementTerminalDecisionStore(filePath);
    await first.record({ ...owner, completionKeys: ["completion-crash"] }, "delivered");
    await expect(first.prepareRetirement(["completion-crash"], producer))
      .resolves.toEqual({ ok: true, value: undefined });
    await expect(first.collectRetirements(async () => ({ ok: true, value: true })))
      .resolves.toEqual({ ok: true, value: 0 });

    const restarted = createAnnouncementTerminalDecisionStore(filePath);
    await expect(restarted.lookup(owner)).resolves.toEqual({ ok: true, value: "delivered" });
    await expect(restarted.collectRetirements(
      async () => ({ ok: true, value: false }),
      () => ({ ok: true, value: true }),
    )).resolves.toEqual({ ok: true, value: 0 });
    await expect(restarted.lookup(owner)).resolves.toEqual({ ok: true, value: "delivered" });
    await expect(restarted.collectRetirements(
      async () => ({ ok: true, value: false }),
      () => ({ ok: true, value: false }),
    ))
      .resolves.toEqual({ ok: true, value: 1 });
    await expect(restarted.lookup(owner)).resolves.toEqual({ ok: true, value: undefined });
  });

  it("keeps a terminal guard authoritative after its renamed index is visible", async () => {
    const store = createAnnouncementTerminalDecisionStore(filePath, {
      syncDirectory: async () => err(new Error("directory sync failed")),
    });

    await expect(store.record(owner, "no_reply")).resolves.toMatchObject({ ok: false });
    await expect(store.lookup(owner)).resolves.toEqual({ ok: true, value: "no_reply" });
    await expect(createAnnouncementTerminalDecisionStore(filePath).lookup(owner))
      .resolves.toEqual({ ok: true, value: "no_reply" });
  });
});
