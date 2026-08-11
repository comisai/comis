// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConversationRef,
  type CapabilityServiceEvidencePolicy,
  type ComisLogger,
  type ManagedRunContentPort,
  type ManagedRunRecord,
  type ManagedRunStorePort,
} from "@comis/core";
import {
  createSqliteManagedRunContentStore,
  createSqliteManagedRunStore,
  initSchema,
} from "@comis/memory";
import { err } from "@comis/shared";
import {
  createManagedRunEvidenceBridge,
  type ManagedRunEvidenceBridgeDeps,
} from "./managed-run-evidence-bridge.js";

const NOW_MS = 1_800_000_000_000;
const BODY = Buffer.from("https://example.com/result/17", "utf8");
const conversationScope = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  partition: {
    kind: "endpoint-conversation-principal" as const,
    endpoint: {
      channelType: "telegram",
      channelInstanceId: "channel-instance_a",
      conversationId: "conversation_a",
      conversationKind: "direct" as const,
    },
    principalId: "principal_a",
  },
};
const conversationReference = createConversationRef(conversationScope);
if (!conversationReference.ok) throw conversationReference.error;

const policies: readonly CapabilityServiceEvidencePolicy[] = Object.freeze([
  Object.freeze({
    kind: "candidate_bundle",
    verificationLevel: "adapter_verified" as const,
    use: "outcome" as const,
  }),
  Object.freeze({
    kind: "delivery_reference",
    verificationLevel: "adapter_verified" as const,
    use: "delivery_reference" as const,
  }),
]);

function makeRecord(): ManagedRunRecord {
  return {
    schemaVersion: 1,
    managedRunId: "managed-run_a",
    serviceInstanceId: "service-instance_a",
    externalRunRefDigest: "a".repeat(64),
    activationDescriptorDigest: "d".repeat(64),
    tenantId: "tenant_a",
    agentId: "agent_a",
    principalId: "principal_a",
    conversationRef: conversationReference.value,
    turnScope: {
      conversation: conversationScope,
      principal: { principalId: "principal_a" },
      endpoint: conversationScope.partition.endpoint,
    },
    deliveryOrigin: {
      channelType: "telegram",
      channelId: "conversation_a",
      userId: "principal_a",
      tenantId: "tenant_a",
    },
    traceId: "10000000-0000-4000-8000-000000000001",
    trustLevel: "user",
    responseLocalePolicy: { locale: "en", source: "request", enforceLocale: true },
    workspacePolicyHash: "b".repeat(64),
    rootRunId: "root-run_a",
    initiationSource: "user_request",
    capturedAgentCapabilities: ["orch:read"],
    capturedToolIds: ["mcp:service_a.inspect"],
    capturedCapabilityViewHash: "c".repeat(64),
    executionAttachmentIds: [],
    terminalSessionIds: [],
    status: "active",
    statusReason: "activation_acknowledged",
    lastAcceptedReportSequence: 0,
    lastReducedReportSequence: 0,
    pendingContinuation: false,
    openAttentionCount: 0,
    createdAtMs: NOW_MS - 100,
    updatedAtMs: NOW_MS - 50,
  };
}

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(function child() { return this; }),
  } as unknown as ComisLogger;
}

function makeInput() {
  return {
    operationId: "operation_evidence_a",
    serviceInstanceId: "service-instance_a",
    managedRunId: "managed-run_a",
    evidenceRef: "evidence_a",
    kind: "delivery_reference",
    subjectDigest: "e".repeat(64),
    observedAtMs: NOW_MS - 10,
    expiresAtMs: NOW_MS + 60_000,
    contentHash: createHash("sha256").update(BODY).digest("hex"),
    verificationLevel: "adapter_verified" as const,
    bodyBase64: BODY.toString("base64"),
    delivery: { kind: "reference" as const },
  };
}

describe("managed-run evidence bridge", () => {
  const directories: string[] = [];
  let db: Database.Database;
  let store: ManagedRunStorePort;
  let contentStore: ManagedRunContentPort;
  let logger: ComisLogger;

  beforeEach(async () => {
    db = new Database(":memory:");
    initSchema(db, 4);
    store = createSqliteManagedRunStore(db);
    expect((await store.create(makeRecord())).ok).toBe(true);
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "managed-run-evidence-")));
    directories.push(directory);
    chmodSync(directory, 0o700);
    const content = createSqliteManagedRunContentStore(db, {
      directoryPath: directory,
      nowMs: () => NOW_MS,
    });
    if (!content.ok) throw content.error;
    contentStore = content.value;
    logger = makeLogger();
  });

  afterEach(() => {
    db.close();
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeBridge(overrides: Partial<ManagedRunEvidenceBridgeDeps> = {}) {
    return createManagedRunEvidenceBridge({
      store,
      contentStore,
      nowMs: () => NOW_MS,
      resolveEvidencePolicies: (serviceInstanceId) => serviceInstanceId === "service-instance_a"
        ? policies
        : undefined,
      logger,
      ...overrides,
    });
  }

  it("stores configured adapter evidence immutably under exact run authority", async () => {
    const accepted = await makeBridge().putEvidence(makeInput());

    expect(accepted).toMatchObject({
      ok: true,
      value: {
        kind: "accepted",
        evidence: {
          evidenceRef: "evidence_a",
          kind: "delivery_reference",
          verificationLevel: "adapter_verified",
          deliveryKind: "reference",
        },
      },
    });
    const stored = await contentStore.getEvidence({
      tenantId: "tenant_a",
      agentId: "agent_a",
      managedRunId: "managed-run_a",
    }, "evidence_a");
    expect(stored.ok && stored.value).toBeDefined();
    expect(JSON.parse(Buffer.from(stored.ok ? stored.value ?? [] : []).toString("utf8")))
      .toEqual({ schemaVersion: 1, bodyBase64: BODY.toString("base64"), delivery: { kind: "reference" } });
    expect(await makeBridge().putEvidence(makeInput())).toMatchObject({
      ok: true,
      value: { kind: "identical_replay" },
    });
  });

  it("rejects reserved verification unconfigured kinds mismatched delivery and altered replay", async () => {
    const bridge = makeBridge();
    expect(await bridge.putEvidence({
      ...makeInput(),
      verificationLevel: "host_verified",
    })).toMatchObject({ ok: true, value: { kind: "rejected", reasonCode: "verification_not_allowed" } });
    expect(await bridge.putEvidence({
      ...makeInput(),
      kind: "unconfigured",
    })).toMatchObject({ ok: true, value: { kind: "rejected", reasonCode: "verification_not_allowed" } });
    expect(await bridge.putEvidence({
      ...makeInput(),
      delivery: { kind: "attachment", fileName: "report.md", mediaType: "text/markdown" },
    })).toMatchObject({ ok: true, value: { kind: "rejected", reasonCode: "delivery_policy_mismatch" } });
    expect((await bridge.putEvidence(makeInput())).ok).toBe(true);
    expect(await bridge.putEvidence({
      ...makeInput(),
      operationId: "operation_evidence_changed",
      subjectDigest: "f".repeat(64),
    })).toMatchObject({ ok: true, value: { kind: "rejected", reasonCode: "replay_conflict" } });
  });

  it("removes a newly published private body when its durable index fails", async () => {
    const failingStore: ManagedRunStorePort = {
      ...store,
      appendEvidence: vi.fn(async () => err(new Error("synthetic evidence index failure"))),
    };

    expect((await makeBridge({ store: failingStore }).putEvidence(makeInput())).ok).toBe(false);
    expect(await contentStore.getEvidence({
      tenantId: "tenant_a",
      agentId: "agent_a",
      managedRunId: "managed-run_a",
    }, "evidence_a")).toEqual({ ok: true, value: undefined });
  });
});
