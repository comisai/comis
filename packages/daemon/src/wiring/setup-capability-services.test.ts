// SPDX-License-Identifier: Apache-2.0
import net from "node:net";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY_SERVICE_BUNDLE_DIGEST } from "@comis/capability-service-sdk";
import {
  TypedEventBus,
  createConversationRef,
  createSecretManager,
  type CapabilityServiceContributionRegistration,
  type CapabilityServicesConfig,
  type ComisLogger,
  type ManagedRunPreparedStart,
} from "@comis/core";
import { initSchema } from "@comis/memory";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import type { ManagedRunActivationInput } from "./managed-run-activation-coordinator.js";
import { setupCapabilityServices } from "./setup-capability-services.js";

const NOW_MS = 1_800_000_000_000;
const BUNDLE_DIGEST = CAPABILITY_SERVICE_BUNDLE_DIGEST;
const BEARER = "synthetic-capability-service-bearer";
const CONVERSATION_SCOPE = {
  tenantId: "tenant_a",
  agentId: "agent_a",
  partition: {
    kind: "endpoint-conversation-principal" as const,
    endpoint: {
      channelType: "telegram",
      channelInstanceId: "channel-instance_a",
      conversationId: "conversation_a",
      threadId: "thread_a",
      conversationKind: "direct" as const,
    },
    principalId: "principal_a",
  },
};
const conversationRef = createConversationRef(CONVERSATION_SCOPE);
if (!conversationRef.ok) throw conversationRef.error;

const CONTRIBUTION: CapabilityServiceContributionRegistration = {
  contributionId: "example.service",
  configSections: [],
  serviceDefinitions: [{
    serviceDefinitionId: "example.service-definition",
    protocolId: "comis.capability-service/1",
    mcpServerName: "example-service",
    managedToolBindings: [],
    requestedScopes: ["health", "report"],
    evidencePolicies: [],
    dependsOn: [],
  }],
};

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

interface LinePeer {
  readonly socket: net.Socket;
  send(value: unknown): void;
  next(): Promise<Record<string, unknown>>;
  close(): void;
}

async function waitForSocket(socketPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("capability-service setup did not bind its socket");
}

async function connectPeer(socketPath: string): Promise<LinePeer> {
  await waitForSocket(socketPath);
  const socket = net.createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let buffered = "";
  const values: Record<string, unknown>[] = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];
  socket.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    while (buffered.includes("\n")) {
      const newline = buffered.indexOf("\n");
      const parsed = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
      buffered = buffered.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else values.push(parsed);
    }
  });
  return {
    socket,
    send(value) { socket.write(`${JSON.stringify(value)}\n`); },
    next: async () => {
      const value = values.shift();
      return value ?? new Promise<Record<string, unknown>>((resolve) => waiters.push(resolve));
    },
    close() { socket.destroy(); },
  };
}

function sendHandshake(peer: LinePeer): void {
  peer.send({
    bearer: BEARER,
    jsonrpc: "2.0",
    id: "operation_handshake_a",
    method: "capabilityServices.handshake",
    params: {
      protocolId: "comis.capability-service/1",
      bundleDigest: BUNDLE_DIGEST,
      operationId: "operation_handshake_a",
      serviceInstanceId: "service-instance_a",
      requestedScopes: ["health", "report"],
    },
  });
}

function makePrepared(externalRunRef: string): ManagedRunPreparedStart {
  return {
    state: "prepared",
    externalRunRef,
    registrationNonce: `registration-nonce-${externalRunRef}`,
    expiresAtMs: NOW_MS + 60_000,
    displayLabel: "Synthetic managed run",
  };
}

function makeActivation(operationId: string, externalRunRef: string): ManagedRunActivationInput {
  return {
    operationId,
    serviceInstanceId: "service-instance_a",
    prepared: makePrepared(externalRunRef),
    authority: {
      tenantId: "tenant_a",
      agentId: "agent_a",
      principalId: "principal_a",
      conversationRef: conversationRef.value,
      turnScope: {
        conversation: CONVERSATION_SCOPE,
        principal: { principalId: "principal_a" },
        endpoint: CONVERSATION_SCOPE.partition.endpoint,
      },
      deliveryOrigin: {
        channelType: "telegram",
        channelId: "conversation_a",
        userId: "principal_a",
        threadId: "thread_a",
        tenantId: "tenant_a",
      },
      traceId: "10000000-0000-4000-8000-000000000001",
      trustLevel: "user",
      responseLocalePolicy: { locale: "en", source: "request", enforceLocale: true },
      workspacePolicyHash: "b".repeat(64),
      rootRunId: "root-run_a",
      initiationSource: "user_request",
      capturedAgentCapabilities: ["orch:read", "orch:web"],
      capturedToolIds: ["mcp:service_a.inspect", "web_search"],
      capturedCapabilityViewHash: "c".repeat(64),
    },
  };
}

function activationResponse(request: Record<string, unknown>): unknown {
  const params = request["params"] as Record<string, unknown>;
  return {
    jsonrpc: "2.0",
    id: request["id"],
    result: {
      managedRunId: params["managedRunId"],
      externalRunRef: params["externalRunRef"],
      state: "active",
      activatedAtMs: NOW_MS,
    },
  };
}

describe("production capability-service setup", () => {
  const temporaryDirectories: string[] = [];
  const peers: LinePeer[] = [];
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const peer of peers.splice(0)) peer.close();
    for (const db of databases.splice(0)) {
      if (db.open) db.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeRuntime() {
    const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "cpsetup-")));
    temporaryDirectories.push(dataDir);
    chmodSync(dataDir, 0o700);
    const socketPath = join(dataDir, "control", "service.sock");
    const config: CapabilityServicesConfig = {
      instances: [{
        serviceInstanceId: "service-instance_a",
        serviceDefinitionId: "example.service-definition",
        enabled: true,
        mcpServerName: "example-service",
        control: {
          transport: "unix",
          socketPath,
          credentialRef: "secret://capability-services/service-instance_a",
        },
        allowedAgents: ["agent_a"],
        allowedWorkspaceRoots: [],
        allowedRuntimeRoots: [],
      }],
      privateContentDirectory: "managed-runs/private",
      reportRetentionMs: 60_000,
      maxObservedClockSkewMs: 5_000,
      recoveryBatchSize: 32,
      requestDeadlineMs: 5_000,
    };
    const db = new Database(":memory:");
    databases.push(db);
    initSchema(db, 4);
    return {
      dataDir,
      socketPath,
      config,
      db,
      clock: createFakeClock(NOW_MS),
      logger: makeLogger(),
      secretManager: createSecretManager({
        "capability-services/service-instance_a": BEARER,
      }),
    };
  }

  it("wires durable execution attachment authority and startup reconciliation", async () => {
    const fixture = makeRuntime();
    const setupPromise = setupCapabilityServices({
      contributions: [CONTRIBUTION],
      config: fixture.config,
      db: fixture.db,
      dataDir: fixture.dataDir,
      secretManager: fixture.secretManager,
      eventBus: new TypedEventBus(),
      logger: fixture.logger,
      clock: fixture.clock,
      timers: createFakeTimers(NOW_MS),
    });
    const peer = await connectPeer(fixture.socketPath);
    peers.push(peer);
    sendHandshake(peer);
    expect(await peer.next()).toHaveProperty("result");

    const setup = await setupPromise;
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    expect(setup.value).toMatchObject({
      attachments: {
        create: expect.any(Function),
        revoke: expect.any(Function),
        reconcile: expect.any(Function),
      },
      attachmentAuthority: {
        create: expect.any(Function),
        validateActive: expect.any(Function),
        reconcileAll: expect.any(Function),
      },
      attachmentRecoverySummary: { recovered: [], preserved: [] },
    });
    await expect(setup.value.shutdown()).resolves.toEqual({ ok: true, value: undefined });
  });

  it("activates reports and recovers an expired uncertain preparation before purge", async () => {
    const fixture = makeRuntime();
    const firstTimers = createFakeTimers(NOW_MS);
    const firstSetup = setupCapabilityServices({
      contributions: [CONTRIBUTION],
      config: fixture.config,
      db: fixture.db,
      dataDir: fixture.dataDir,
      secretManager: fixture.secretManager,
      eventBus: new TypedEventBus(),
      logger: fixture.logger,
      clock: fixture.clock,
      timers: firstTimers,
    });
    const firstPeer = await connectPeer(fixture.socketPath);
    peers.push(firstPeer);
    sendHandshake(firstPeer);
    expect(await firstPeer.next()).toHaveProperty("result");
    const first = await firstSetup;
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.runtime.getActiveView().instances).toEqual([
      expect.objectContaining({ serviceInstanceId: "service-instance_a", state: "active" }),
    ]);
    expect(statSync(join(fixture.dataDir, "managed-runs", "private")).mode & 0o777).toBe(0o700);

    const activePromise = first.value.activationCoordinator.activatePrepared(
      makeActivation("operation_prepare_active", "external-run-active"),
    );
    const activateRequest = await firstPeer.next();
    expect(activateRequest).toMatchObject({ method: "managedRuns.activate" });
    firstPeer.send(activationResponse(activateRequest));
    const activated = await activePromise;
    expect(activated).toMatchObject({ ok: true, value: { kind: "activated" } });
    if (!activated.ok || activated.value.kind !== "activated") return;
    const activeManagedRunId = activated.value.record.managedRunId;

    firstPeer.send({
      bearer: BEARER,
      jsonrpc: "2.0",
      id: "operation_report_active",
      method: "managedRuns.report",
      params: {
        operationId: "operation_report_active",
        managedRunId: activeManagedRunId,
        serviceReportId: "service-report-active",
        kind: "progress",
        summary: "Synthetic progress",
      },
    });
    expect(await firstPeer.next()).toMatchObject({
      result: { acceptedSequence: 1, serviceReportId: "service-report-active" },
    });

    const uncertainPromise = first.value.activationCoordinator.activatePrepared(
      makeActivation("operation_prepare_uncertain", "external-run-uncertain"),
    );
    const uncertainRequest = await firstPeer.next();
    expect(uncertainRequest).toMatchObject({ method: "managedRuns.activate" });
    firstTimers.advance(5_000);
    const uncertain = await uncertainPromise;
    expect(uncertain).toMatchObject({ ok: true, value: { kind: "activation_unknown" } });
    if (!uncertain.ok || uncertain.value.kind !== "activation_unknown") return;
    const uncertainRecord = uncertain.value.record;
    expect(await first.value.shutdown()).toEqual({ ok: true, value: undefined });
    firstPeer.close();

    fixture.clock.advance(120_000);
    const secondTimers = createFakeTimers(fixture.clock.now());
    const secondSetup = setupCapabilityServices({
      contributions: [CONTRIBUTION],
      config: fixture.config,
      db: fixture.db,
      dataDir: fixture.dataDir,
      secretManager: fixture.secretManager,
      eventBus: new TypedEventBus(),
      logger: fixture.logger,
      clock: fixture.clock,
      timers: secondTimers,
    });
    const secondPeer = await connectPeer(fixture.socketPath);
    peers.push(secondPeer);
    sendHandshake(secondPeer);
    expect(await secondPeer.next()).toHaveProperty("result");
    const abandonRequest = await secondPeer.next();
    expect(abandonRequest).toMatchObject({
      method: "managedRuns.abandon",
      params: {
        externalRunRef: "external-run-uncertain",
        reason: "registration_expired",
        disposition: "reap_safe",
      },
    });
    const abandonParams = abandonRequest["params"] as Record<string, unknown>;
    secondPeer.send({
      jsonrpc: "2.0",
      id: abandonRequest["id"],
      result: {
        externalRunRef: abandonParams["externalRunRef"],
        state: "abandoned",
        disposition: abandonParams["disposition"],
        terminalTransition: "unbound_preparation_abandoned",
      },
    });
    const second = await secondSetup;
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.recoverySummary).toMatchObject({
      activated: [],
      cancelled: [uncertainRecord.managedRunId],
      unknown: [],
      invalid: [],
      failed: [],
    });

    expect(await second.value.store.get(
      { kind: "service", serviceInstanceId: "service-instance_a" },
      activeManagedRunId,
    )).toMatchObject({
      ok: true,
      value: { status: "active", lastAcceptedReportSequence: 1, pendingContinuation: true },
    });
    expect(await second.value.store.get(
      { kind: "service", serviceInstanceId: "service-instance_a" },
      uncertainRecord.managedRunId,
    )).toMatchObject({ ok: true, value: { status: "cancelled" } });
    expect(await second.value.contentStore.getActivationDescriptorForRecovery(
      {
        tenantId: uncertainRecord.tenantId,
        agentId: uncertainRecord.agentId,
        managedRunId: uncertainRecord.managedRunId,
      },
      uncertainRecord.activationDescriptorRef!,
      { kind: "recovery" },
    )).toEqual({ ok: true, value: undefined });
    expect(await second.value.shutdown()).toEqual({ ok: true, value: undefined });
  });

  it("rejects a configured socket outside the daemon data directory", async () => {
    const fixture = makeRuntime();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "cpoutside-")));
    temporaryDirectories.push(outside);
    chmodSync(outside, 0o700);
    const result = await setupCapabilityServices({
      contributions: [CONTRIBUTION],
      config: {
        ...fixture.config,
        instances: [{
          ...fixture.config.instances[0],
          control: { ...fixture.config.instances[0]!.control, socketPath: join(outside, "service.sock") },
        }],
      },
      db: fixture.db,
      dataDir: fixture.dataDir,
      secretManager: fixture.secretManager,
      eventBus: new TypedEventBus(),
      logger: fixture.logger,
      clock: fixture.clock,
      timers: createFakeTimers(NOW_MS),
    });

    expect(result).toMatchObject({ ok: false });
    expect(existsSync(join(outside, "service.sock"))).toBe(false);
  });

  it("publishes an inert empty view when no service is linked or configured", async () => {
    const fixture = makeRuntime();
    const result = await setupCapabilityServices({
      contributions: [],
      config: { ...fixture.config, instances: [] },
      db: fixture.db,
      dataDir: fixture.dataDir,
      secretManager: fixture.secretManager,
      eventBus: new TypedEventBus(),
      logger: fixture.logger,
      clock: fixture.clock,
      timers: createFakeTimers(NOW_MS),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        recoverySummary: {
          activated: [], cancelled: [], unknown: [], invalid: [], failed: [],
        },
      },
    });
    if (result.ok) {
      expect(result.value.runtime.getActiveView().instances).toEqual([]);
      expect(await result.value.shutdown()).toEqual({ ok: true, value: undefined });
    }
  });
});
