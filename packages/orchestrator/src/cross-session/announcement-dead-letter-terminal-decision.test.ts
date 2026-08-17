// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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

async function durableRecordFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path);
    }
  };
  await visit(directory);
  return files.sort();
}

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
    await expect(createAnnouncementTerminalDecisionStore(filePath).lookup(owner))
      .resolves.toEqual({ ok: true, value: "delivered" });
    await expect(createAnnouncementTerminalDecisionStore(filePath).lookup(second))
      .resolves.toEqual({ ok: true, value: "discarded" });
  });

  it("writes independent terminal keys without replacing existing guard files", async () => {
    const store = createAnnouncementTerminalDecisionStore(filePath);
    await store.record(owner, "delivered");
    const firstFiles = await durableRecordFiles(directory);
    expect(firstFiles).toHaveLength(1);
    const firstStat = await stat(firstFiles[0]!);

    await store.record({ ...owner, runId: "run-2", idempotencyKey: "operation-2" }, "discarded");

    const secondFiles = await durableRecordFiles(directory);
    expect(secondFiles).toHaveLength(2);
    expect((await stat(firstFiles[0]!)).ino).toBe(firstStat.ino);
  });

  it("recovers a prepared retirement after producer deletion", async () => {
    const producer = {
      kind: "session" as const,
      tenantId: "tenant_a",
      agentId: "agent_a",
      conversationRef: ConversationRefSchema.parse(`cv_${"a".repeat(43)}`),
      checkpointId: "checkpoint-a",
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

  it("retires chunk guards by their explicit producer key", async () => {
    const store = createAnnouncementTerminalDecisionStore(filePath);
    const chunkOwner = {
      ...owner,
      idempotencyKey: "chunk-operation",
      completionKeys: ["parent-operation", "logical-completion"],
      retirementKeys: ["logical-completion"],
    };

    await store.record(chunkOwner, "delivered");
    await expect(store.retire(["logical-completion"]))
      .resolves.toEqual({ ok: true, value: undefined });
    await expect(store.lookup(chunkOwner))
      .resolves.toEqual({ ok: true, value: undefined });
  });

  it("keeps a terminal guard authoritative after its renamed record is visible", async () => {
    const store = createAnnouncementTerminalDecisionStore(filePath, {
      syncDirectory: async () => err(new Error("directory sync failed")),
    });

    await expect(store.record(owner, "no_reply")).resolves.toMatchObject({ ok: false });
    await expect(store.lookup(owner)).resolves.toEqual({ ok: true, value: "no_reply" });
    await expect(createAnnouncementTerminalDecisionStore(filePath).lookup(owner))
      .resolves.toEqual({ ok: true, value: "no_reply" });
  });

  it("reloads a repaired terminal record without restarting", async () => {
    const record = createTerminalDecisionRecord(owner, "no_reply", 10);
    if (!record.ok) throw record.error;
    const recordDirectory = join(
      `${filePath}.terminal-decisions`,
      "decisions",
      record.value.keyDigest.slice(0, 2),
    );
    const recordPath = join(recordDirectory, `${record.value.keyDigest}.json`);
    await mkdir(recordDirectory, { recursive: true });
    await writeFile(recordPath, "{malformed");
    const store = createAnnouncementTerminalDecisionStore(filePath);

    await expect(store.lookup(owner)).resolves.toMatchObject({ ok: false });
    await writeFile(recordPath, JSON.stringify(record.value));

    await expect(store.lookup(owner)).resolves.toEqual({ ok: true, value: "no_reply" });
    await expect(store.listInvalid()).resolves.toEqual({ ok: true, value: [] });
  });

  const retirementProducer = {
    kind: "session" as const,
    tenantId: "tenant_a",
    agentId: "agent_a",
    conversationRef: ConversationRefSchema.parse(`cv_${"b".repeat(43)}`),
    checkpointId: "checkpoint-b",
  };

  it("quarantines store entries that are not shard directories", async () => {
    const store = createAnnouncementTerminalDecisionStore(filePath);
    await store.record(owner, "delivered");
    const decisions = join(`${filePath}.terminal-decisions`, "decisions");
    // A shard name is two hex characters; anything else is unreadable layout
    // rather than an unreadable record, so it is retained as evidence.
    await mkdir(join(decisions, "zz"), { recursive: true });
    await writeFile(join(decisions, "loose-record"), "{}");

    const invalid = await createAnnouncementTerminalDecisionStore(filePath).listInvalid();
    if (!invalid.ok) throw invalid.error;
    expect(invalid.value).toHaveLength(2);
    expect(invalid.value.every((row) => row.reason === "schema_mismatch")).toBe(true);
    // The valid record beside them still resolves.
    await expect(createAnnouncementTerminalDecisionStore(filePath).lookup(owner))
      .resolves.toEqual({ ok: true, value: "delivered" });
  });

  it("clears a leftover temporary write and quarantines an unrecognized record name", async () => {
    const store = createAnnouncementTerminalDecisionStore(filePath);
    await store.record(owner, "delivered");
    const [recordPath] = await durableRecordFiles(directory);
    const shard = dirname(recordPath!);
    const digest = basename(recordPath!, ".json");
    const leftover = join(shard, `${digest}.json.aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp`);
    await writeFile(leftover, "half-written");
    await writeFile(join(shard, "not-a-digest.json"), "{}");

    const invalid = await createAnnouncementTerminalDecisionStore(filePath).listInvalid();
    if (!invalid.ok) throw invalid.error;
    // The interrupted write is swept; only the unrecognized name is evidence.
    expect(invalid.value).toHaveLength(1);
    expect(await durableRecordFiles(directory)).not.toContain(leftover);
  });

  it("rejects a retirement intent naming no completion or a malformed producer", async () => {
    const store = createAnnouncementTerminalDecisionStore(filePath);

    await expect(store.prepareRetirement([], retirementProducer))
      .resolves.toMatchObject({ ok: false });
    await expect(store.prepareRetirement([""], retirementProducer))
      .resolves.toMatchObject({ ok: false });
    await expect(store.prepareRetirement(
      ["completion-a"],
      { kind: "unknown" } as unknown as typeof retirementProducer,
    )).resolves.toMatchObject({ ok: false });
  });

  it("keeps a repeated retirement intent single and surfaces probe failures", async () => {
    const store = createAnnouncementTerminalDecisionStore(filePath);
    await store.record({ ...owner, completionKeys: ["completion-repeat"] }, "delivered");

    await expect(store.prepareRetirement(["completion-repeat"], retirementProducer))
      .resolves.toEqual({ ok: true, value: undefined });
    // Re-preparing the same intent is a no-op, not a second retirement.
    await expect(store.prepareRetirement(["completion-repeat"], retirementProducer))
      .resolves.toEqual({ ok: true, value: undefined });

    await expect(store.collectRetirements(async () => err(new Error("producer probe failed"))))
      .resolves.toMatchObject({ ok: false });
    await expect(store.collectRetirements(
      async () => ({ ok: true, value: false }),
      () => err(new Error("ownership probe failed")),
    )).resolves.toMatchObject({ ok: false });
    // Neither failed probe may retire the guard.
    await expect(store.lookup(owner)).resolves.toEqual({ ok: true, value: "delivered" });

    await expect(store.collectRetirements(async () => ({ ok: true, value: false })))
      .resolves.toEqual({ ok: true, value: 1 });
  });
});
