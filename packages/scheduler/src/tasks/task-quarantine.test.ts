// SPDX-License-Identifier: Apache-2.0
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import {
  computeWorkspacePolicyCombinedHash,
  createConversationRef,
  hashWorkspacePolicyContent,
} from "@comis/core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectTaskQuarantine,
  quarantineMalformedTerminalTaskGroups,
} from "./task-quarantine.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "comis-task-quarantine-"));
  dirs.push(value);
  return value;
}

function rawRoot(taskOverrides: Record<string, unknown> = {}) {
  const conversation = {
    tenantId: "tenant-a",
    agentId: "agent-a",
    partition: { kind: "agent" as const },
  };
  const conversationRef = createConversationRef(conversation);
  if (!conversationRef.ok) throw conversationRef.error;
  const content = "# Scope\n\nRemain within the configured scope.";
  const section = {
    id: "workspace:scope",
    sourceKind: "operator" as const,
    trust: "trusted" as const,
    stability: "stable" as const,
    content,
    contentHash: hashWorkspacePolicyContent(content),
    maxChars: 20_000,
  };
  const policy = {
    agentId: "agent-a",
    sections: [section],
    combinedHash: computeWorkspacePolicyCombinedHash([section]),
  };
  const task = {
    id: "task-a",
    agentId: "agent-a",
    origin: {
      turnScope: {
        conversation,
        principal: { principalId: "user-a" },
        endpoint: {
          channelType: "echo",
          channelInstanceId: "echo-main",
          conversationId: "conversation-a",
          conversationKind: "direct" as const,
        },
      },
      conversationRef: conversationRef.value,
      deliveryOrigin: {
        tenantId: "tenant-a",
        channelType: "echo",
        channelId: "conversation-a",
        userId: "user-a",
      },
      traceId: "trace-a",
      responseLocalePolicy: { source: "unset", enforceLocale: false },
      backgroundHopCount: 0,
    },
    sourceExecutionId: "source-a",
    lastSourceExecutionId: "source-a",
    sourceOccurrenceCount: 1,
    workspacePolicyHash: policy.combinedHash,
    responseLocalePolicy: { source: "unset", enforceLocale: false },
    text: "check outcome",
    contentTrust: "derived",
    confidence: 0.9,
    createdAtMs: 1_000,
    dueEarliestMs: 2_000,
    dueLatestMs: 3_000,
    expiresAtMs: 4_000,
    dedupeKey: "d".repeat(64),
    attemptCount: 0,
    preAcceptanceFailureCount: 0,
    status: "cancelled",
    terminalAttemptId: null,
    terminalAtMs: 2_000,
    ...taskOverrides,
  };
  return { formatVersion: 1 as const, tasks: [task], attempts: [], policySnapshots: [policy] };
}

describe("follow-up task quarantine file inspection", () => {
  it("reports a missing private evidence file as valid and empty", async () => {
    const directoryPath = await directory();

    await expect(inspectTaskQuarantine(join(directoryPath, "tasks-quarantine.jsonl"))).resolves.toEqual({
      ok: true,
      value: { exists: false, bytes: 0, digest: null, recordCount: 0, state: "valid" },
    });
  });

  it("reports permissive evidence-file permissions as invalid authority", async () => {
    const directoryPath = await directory();
    const filePath = join(directoryPath, "tasks-quarantine.jsonl");
    await writeFile(filePath, "", { mode: 0o600 });
    await chmod(filePath, 0o644);

    await expect(inspectTaskQuarantine(filePath)).resolves.toEqual({
      ok: true,
      value: { exists: true, bytes: 0, digest: null, recordCount: 0, state: "invalid" },
    });
  });

  it("rejects relative inspection and quarantine paths or unsafe timestamps", async () => {
    expect(await inspectTaskQuarantine("relative.jsonl")).toMatchObject({
      ok: false,
      error: { code: "invalid_state", errorKind: "validation" },
    });
    expect(await quarantineMalformedTerminalTaskGroups({
      raw: rawRoot({ text: "" }),
      quarantinePath: "relative.jsonl",
      quarantinedAtMs: 1,
    })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await quarantineMalformedTerminalTaskGroups({
      raw: rawRoot({ text: "" }),
      quarantinePath: join(await directory(), "quarantine.jsonl"),
      quarantinedAtMs: -1,
    })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("appends exact malformed terminal groups once and reports valid evidence", async () => {
    const directoryPath = await directory();
    const quarantinePath = join(directoryPath, "nested", "tasks-quarantine.jsonl");
    const raw = rawRoot({ text: "" });
    expect(await quarantineMalformedTerminalTaskGroups({ raw, quarantinePath, quarantinedAtMs: 5_000 }))
      .toMatchObject({
        ok: true,
        value: { root: { tasks: [], attempts: [], policySnapshots: [] }, quarantinedRecordCount: 2 },
      });
    const before = await readFile(quarantinePath);
    expect(await quarantineMalformedTerminalTaskGroups({ raw, quarantinePath, quarantinedAtMs: 6_000 }))
      .toMatchObject({ ok: true, value: { quarantinedRecordCount: 2 } });
    expect(await readFile(quarantinePath)).toEqual(before);
    expect(await inspectTaskQuarantine(quarantinePath)).toMatchObject({
      ok: true,
      value: { exists: true, bytes: before.byteLength, recordCount: 2, state: "valid" },
    });
  });

  it("rejects unbounded envelopes duplicate identities and ambiguous valid graphs", async () => {
    const quarantinePath = join(await directory(), "tasks-quarantine.jsonl");
    expect(await quarantineMalformedTerminalTaskGroups({
      raw: { formatVersion: 1, tasks: [{}], attempts: [], policySnapshots: [] },
      quarantinePath,
      quarantinedAtMs: 1,
    })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    const duplicate = rawRoot({ text: "" });
    expect(await quarantineMalformedTerminalTaskGroups({
      raw: { ...duplicate, tasks: [duplicate.tasks[0], duplicate.tasks[0]] },
      quarantinePath,
      quarantinedAtMs: 1,
    })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await quarantineMalformedTerminalTaskGroups({
      raw: { formatVersion: 1, tasks: [], attempts: [], policySnapshots: [] },
      quarantinePath,
      quarantinedAtMs: 1,
    })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("refuses quarantine when malformed records include active task authority", async () => {
    const quarantinePath = join(await directory(), "tasks-quarantine.jsonl");
    expect(await quarantineMalformedTerminalTaskGroups({
      raw: rawRoot({ status: "pending", nextAttemptAtMs: 2_000, text: "", terminalAttemptId: undefined, terminalAtMs: undefined }),
      quarantinePath,
      quarantinedAtMs: 1,
    })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
    expect(await quarantineMalformedTerminalTaskGroups({
      raw: rawRoot({ status: "checking", activeAttemptId: undefined, terminalAttemptId: undefined, terminalAtMs: undefined }),
      quarantinePath,
      quarantinedAtMs: 1,
    })).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  });

  it("reports malformed JSON forged hashes duplicate entries and oversized files as invalid", async () => {
    const directoryPath = await directory();
    for (const [name, bytes] of [
      ["invalid-json", "{invalid\n"],
      ["invalid-row", `${JSON.stringify({ formatVersion: 1 })}\n`],
    ] as const) {
      const filePath = join(directoryPath, `${name}.jsonl`);
      await writeFile(filePath, bytes, { mode: 0o600 });
      expect(await inspectTaskQuarantine(filePath)).toMatchObject({ ok: true, value: { state: "invalid" } });
    }

    const validPath = join(directoryPath, "valid.jsonl");
    await quarantineMalformedTerminalTaskGroups({
      raw: rawRoot({ text: "" }), quarantinePath: validPath, quarantinedAtMs: 1,
    });
    const firstLine = (await readFile(validPath, "utf8")).trim().split("\n")[0]!;
    const duplicatePath = join(directoryPath, "duplicate.jsonl");
    await writeFile(duplicatePath, `${firstLine}\n${firstLine}\n`, { mode: 0o600 });
    expect(await inspectTaskQuarantine(duplicatePath)).toMatchObject({ ok: true, value: { state: "invalid" } });

    const forged = JSON.parse(firstLine) as Record<string, unknown>;
    forged.recordHash = "f".repeat(64);
    const forgedPath = join(directoryPath, "forged.jsonl");
    await writeFile(forgedPath, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
    expect(await inspectTaskQuarantine(forgedPath)).toMatchObject({ ok: true, value: { state: "invalid" } });

    const oversizedPath = join(directoryPath, "oversized.jsonl");
    await writeFile(oversizedPath, Buffer.alloc(16 * 1_024 * 1_024 + 1), { mode: 0o600 });
    expect(await inspectTaskQuarantine(oversizedPath)).toMatchObject({ ok: true, value: { state: "invalid" } });
  });

  it("rejects directory and symbolic-link quarantine authorities", async () => {
    const directoryPath = await directory();
    const directoryFile = join(directoryPath, "directory.jsonl");
    await mkdir(directoryFile);
    expect(await inspectTaskQuarantine(directoryFile)).toMatchObject({ ok: true, value: { state: "invalid" } });

    const target = join(directoryPath, "target.jsonl");
    await writeFile(target, "", { mode: 0o600 });
    const link = join(directoryPath, "link.jsonl");
    await symlink(target, link);
    expect(await inspectTaskQuarantine(link)).toMatchObject({ ok: true, value: { state: "invalid" } });
  });

  it("rejects non-regular quarantine append targets before writing evidence", async () => {
    const directoryPath = await directory();
    const quarantinePath = join(directoryPath, "tasks-quarantine.jsonl");
    await mkdir(quarantinePath);
    expect(await quarantineMalformedTerminalTaskGroups({
      raw: rawRoot({ text: "" }), quarantinePath, quarantinedAtMs: 1,
    })).toMatchObject({ ok: false, error: { code: "invalid_state", errorKind: "validation" } });
  });

  it("closes quarantine over terminal task attempt and policy references", async () => {
    const quarantinePath = join(await directory(), "tasks-quarantine.jsonl");
    const taskSeed = rawRoot({
      status: "delivered",
      text: "",
      terminalAttemptId: "attempt-a",
      terminalAtMs: 3_000,
    });
    const terminalAttempt = {
      id: "attempt-a",
      bootId: "boot-a",
      rootRunId: "root-a",
      taskIds: ["task-a"],
      tenantId: "tenant-a",
      agentId: "agent-a",
      conversationRef: taskSeed.tasks[0]!.origin.conversationRef,
      startedAtMs: 2_000,
      status: "failed",
      failureStage: "model",
      errorKind: "dependency",
      failedChunks: 0,
      check: { status: "not_returned" },
      terminalAtMs: 3_000,
    };

    await expect(quarantineMalformedTerminalTaskGroups({
      raw: { ...taskSeed, attempts: [terminalAttempt] },
      quarantinePath,
      quarantinedAtMs: 5_000,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        root: { tasks: [], attempts: [], policySnapshots: [] },
        quarantinedRecordCount: 3,
      },
    });
  });

  it("expands an invalid terminal attempt to its task and workspace policy", async () => {
    const quarantinePath = join(await directory(), "tasks-quarantine.jsonl");
    const base = rawRoot();
    const invalidAttempt = {
      id: "attempt-a",
      agentId: "agent-a",
      status: "failed",
      taskIds: ["task-a"],
    };

    await expect(quarantineMalformedTerminalTaskGroups({
      raw: { ...base, attempts: [invalidAttempt] },
      quarantinePath,
      quarantinedAtMs: 5_000,
    })).resolves.toMatchObject({
      ok: true,
      value: { quarantinedRecordCount: 3 },
    });
  });

  it("expands an invalid policy snapshot to every referencing terminal task", async () => {
    const quarantinePath = join(await directory(), "tasks-quarantine.jsonl");
    const base = rawRoot();
    const policy = {
      ...base.policySnapshots[0]!,
      sections: [{
        ...base.policySnapshots[0]!.sections[0]!,
        content: "# Changed\n\nConflicting policy bytes.",
      }],
    };

    await expect(quarantineMalformedTerminalTaskGroups({
      raw: { ...base, policySnapshots: [policy] },
      quarantinePath,
      quarantinedAtMs: 5_000,
    })).resolves.toMatchObject({
      ok: true,
      value: { quarantinedRecordCount: 2 },
    });
  });

  it("refuses a terminal group referenced by an otherwise separate attempt", async () => {
    const quarantinePath = join(await directory(), "tasks-quarantine.jsonl");
    const base = rawRoot({ text: "" });
    const externalAttempt = {
      id: "attempt-external",
      bootId: "boot-a",
      rootRunId: "root-a",
      agentId: "agent-a",
      tenantId: "tenant-a",
      conversationRef: base.tasks[0]!.origin.conversationRef,
      startedAtMs: 1_000,
      status: "failed",
      taskIds: ["task-a"],
      check: { status: "not_returned" },
      deliveringAtMs: null,
      failureStage: "owner_recovery_before_delivery",
      errorKind: "internal",
      deliveredChunks: 0,
      failedChunks: 0,
      terminalAtMs: 2_000,
    };

    await expect(quarantineMalformedTerminalTaskGroups({
      raw: { ...base, attempts: [externalAttempt] },
      quarantinePath,
      quarantinedAtMs: 5_000,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_state", errorKind: "validation" },
    });
  });
});
