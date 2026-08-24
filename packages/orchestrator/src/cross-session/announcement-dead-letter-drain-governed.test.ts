// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import type {
  OutwardSendLedgerPort,
  OutwardSendRecord,
  OutwardSendState,
} from "@comis/core";
import type { DeadLetterQueueContext } from "./announcement-dead-letter-context.js";
import type { DeadLetterEntry } from "./announcement-dead-letter-file.js";
import { createGovernedDrainStage } from "./announcement-dead-letter-drain-governed.js";
import { createAnnouncementOperationDigests } from "./announcement-outward-operation.js";

const authority = {
  tenantId: "default",
  agentId: "agent-a",
  conversationRef: "conversation-a",
};

const endpoint = {
  channelType: "telegram",
  channelInstanceId: "test-instance",
  conversationId: "chat-a",
  conversationKind: "direct" as const,
};

const snapshot = {
  kind: "snapshot" as const,
  sourceAgentId: "agent-a",
  sourcePath: "artifact.bin",
  path: "/snapshots/artifact.bin",
  fileName: "artifact.bin",
  mimeType: "application/octet-stream",
  contentDigest: "a".repeat(64),
  sizeBytes: 1,
};

function makeEntry(overrides: Record<string, unknown> = {}): DeadLetterEntry {
  return {
    id: "entry-a",
    announcementText: "completion",
    channelType: "telegram",
    channelId: "chat-a",
    agentId: "agent-a",
    runId: "run-a",
    sessionKey: "default:agent-a:telegram:chat-a:user_a",
    failedAt: 0,
    attemptCount: 0,
    lastAttemptAt: 0,
    idempotencyKey: "operation-a",
    rootRunId: "root-a",
    stepIndex: 0,
    completionKeys: ["operation-a"],
    deliveryAuthority: authority,
    destinationEndpoint: endpoint,
    ...overrides,
  } as DeadLetterEntry;
}

function makeRow(
  entry: DeadLetterEntry,
  state: OutwardSendState,
  overrides: Partial<OutwardSendRecord> = {},
): OutwardSendRecord {
  const digests = createAnnouncementOperationDigests({
    channelType: entry.channelType,
    channelId: entry.channelId,
    text: entry.announcementText,
    ...(entry.threadId || entry.extra ? {
      options: {
        ...(entry.threadId ? { threadId: entry.threadId } : {}),
        ...(entry.extra ? { extra: entry.extra } : {}),
      },
    } : {}),
    ...(entry.attachment?.kind === "snapshot" ? { attachment: entry.attachment } : {}),
  });
  if (!digests.ok) throw digests.error;
  return {
    id: "row-a",
    rootRunId: entry.rootRunId ?? "root-a",
    stepIndex: entry.stepIndex ?? 0,
    agentId: entry.agentId ?? "agent-a",
    channelType: entry.channelType,
    channelId: entry.channelId,
    operationKind: "cross_session_announcement",
    operationFingerprint: digests.value.operationFingerprint,
    contentDigest: digests.value.contentDigest,
    state,
    attemptCount: 1,
    attemptedAtMs: 0,
    ...overrides,
  };
}

function makeLedger(overrides: Partial<OutwardSendLedgerPort> = {}): OutwardSendLedgerPort {
  return {
    lookupTerminalDecision: vi.fn(async () => ok(undefined)),
    recordTerminalDecision: vi.fn(async () => ok(undefined)),
    allocateStep: vi.fn(async () => ok(0)),
    lookup: vi.fn(async () => ok(undefined)),
    begin: vi.fn(async () => ok(undefined)),
    markUnknown: vi.fn(async () => ok(undefined)),
    reclaimPreSend: vi.fn(async () => ok(true)),
    commit: vi.fn(async () => ok(undefined)),
    markFailed: vi.fn(async () => ok(undefined)),
    parkUncertain: vi.fn(async () => ok(true)),
    hasUncertainty: vi.fn(async () => ok(false)),
    listUnreconciled: vi.fn(async () => ok([])),
    ...overrides,
  };
}

function makeContext(overrides: Record<string, unknown> = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const eventBus = { emit: vi.fn() };
  return {
    logger,
    eventBus,
    opts: {},
    governedSendToChannel: vi.fn(async () => ok({
      delivered: true as const,
      status: "accepted" as const,
      platformMessageId: "message-a",
    })),
    recordDrainingEntryTextChunks: vi.fn(async () => ok(undefined)),
    ...overrides,
  } as unknown as DeadLetterQueueContext;
}

describe("governed dead-letter drain boundaries", () => {
  it("reports incomplete and invalid governed identities without consulting the ledger", async () => {
    const context = makeContext();
    const stage = createGovernedDrainStage(context);
    const ledger = makeLedger();

    const missing = makeEntry({ agentId: undefined });
    await expect(stage.drainPreparedGovernedEntry(ledger, missing)).resolves.toBe("retained");
    expect(missing.lastError).toBe("identity_incomplete");

    const invalid = makeEntry({ extra: { unsupported: 1n } });
    await expect(stage.drainPreparedGovernedEntry(ledger, invalid)).resolves.toBe("retained");
    expect(invalid.lastError).toBe("operation_validation_blocked");
    expect(ledger.lookup).not.toHaveBeenCalled();
  });

  it("bounds repeated ledger-failure diagnostics", () => {
    const context = makeContext();
    const stage = createGovernedDrainStage(context);
    for (let index = 0; index < 514; index++) {
      stage.logLedgerFailure(
        makeEntry({ id: `entry-${index}` }),
        "lookup",
        "dependency",
        "repair storage",
        "Ledger unavailable",
      );
    }
    stage.logLedgerFailure(
      makeEntry({ id: "entry-513" }),
      "lookup",
      "dependency",
      "repair storage",
      "Ledger unavailable",
    );
    expect(context.logger?.error).toHaveBeenCalledTimes(514);
    expect(context.logger?.debug).toHaveBeenCalledOnce();
  });

  it("retains rejected, uncertain, receiptless, and uncommitted platform outcomes", async () => {
    const scenarios = [
      {
        outcome: ok({ delivered: false as const, status: "rejected" as const }),
        expected: "outward_transport_rejected",
      },
      {
        outcome: ok({ delivered: false as const, status: "unknown" as const }),
        expected: "outward_transport_uncertain",
      },
      {
        outcome: ok({ delivered: true as const, status: "accepted" as const }),
        expected: "outward_platform_receipt_missing",
      },
    ];
    for (const scenario of scenarios) {
      const context = makeContext({ governedSendToChannel: async () => scenario.outcome });
      const entry = makeEntry();
      await expect(createGovernedDrainStage(context).drainPreparedGovernedEntry(makeLedger(), entry))
        .resolves.toBe("retained");
      expect(entry.lastError).toBe(scenario.expected);
    }

    const context = makeContext();
    const entry = makeEntry();
    const ledger = makeLedger({ commit: vi.fn(async () => err(new Error("ledger unavailable"))) });
    await expect(createGovernedDrainStage(context).drainPreparedGovernedEntry(ledger, entry))
      .resolves.toBe("retained");
    expect(entry.lastError).toBe("outward_receipt_commit_blocked");
  });

  it("reports session-observation failure and retains unresolved governed text", async () => {
    const context = makeContext({
      opts: { ensureSessionObservation: () => err(new Error("trajectory unavailable")) },
      governedSendToChannel: async () => err(new Error("transport unavailable")),
    });
    const entry = makeEntry({ stepIndex: undefined });
    await expect(createGovernedDrainStage(context).drainGovernedEntry(makeLedger(), entry))
      .resolves.toBe("retained");
    expect(context.logger?.warn).toHaveBeenCalledOnce();
    expect(entry.lastError).toBe("outward_operation_unresolved");
  });

  it("rejects attachment lookup, preparation, mapping, identity, and receipt inconsistencies", async () => {
    const lookupFailure = makeEntry({ attachment: snapshot });
    await expect(createGovernedDrainStage(makeContext()).drainGovernedEntry(makeLedger({
      lookup: vi.fn(async () => err(new Error("ledger unavailable"))),
    }), lookupFailure)).resolves.toBe("retained");
    expect(lookupFailure.lastError).toBe("outward_ledger_lookup_blocked");

    const source = makeEntry({
      attachment: { kind: "source", sourceAgentId: "agent-a", path: "artifact.bin" },
    });
    await expect(createGovernedDrainStage(makeContext()).drainGovernedEntry(makeLedger({
      lookup: vi.fn(async () => ok(makeRow(source, "unresolved"))),
    }), source)).resolves.toBe("retained");
    expect(source.lastError).toBe("attachment_preparation_blocked");

    const mapping = makeEntry({ attachment: snapshot });
    await expect(createGovernedDrainStage(makeContext()).drainGovernedEntry(makeLedger({
      lookup: vi.fn(async () => ok(makeRow(mapping, "unresolved"))),
      allocateStep: vi.fn(async () => ok(9)),
    }), mapping)).resolves.toBe("retained");
    expect(mapping.lastError).toBe("outward_operation_mapping_mismatch");

    const mismatch = makeEntry({ attachment: snapshot });
    await expect(createGovernedDrainStage(makeContext()).drainGovernedEntry(makeLedger({
      lookup: vi.fn(async () => ok(makeRow(mismatch, "unresolved", { agentId: "agent-b" }))),
    }), mismatch)).resolves.toBe("retained");
    expect(mismatch.lastError).toBe("outward_operation_identity_mismatch");

    const receiptless = makeEntry({ attachment: snapshot });
    await expect(createGovernedDrainStage(makeContext()).drainGovernedEntry(makeLedger({
      lookup: vi.fn(async () => ok(makeRow(receiptless, "committed", { platformMessageId: undefined }))),
    }), receiptless)).resolves.toBe("retained");
    expect(receiptless.lastError).toBe("outward_committed_receipt_missing");
  });
});
