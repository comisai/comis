// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import net from "node:net";
import { chmodSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as waitForTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ComisLogger,
  type PlannedCapabilityServiceDefinition,
  type PlannedCapabilityServiceInstance,
} from "@comis/core";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { err, ok } from "@comis/shared";
import type { ManagedRunEvidenceBridge } from "./managed-run-evidence-bridge.js";
import type { ManagedAttentionResponseBridge } from "./managed-attention-response-bridge.js";
import type { ManagedRunReportBridge } from "./managed-run-report-bridge.js";
import type { ManagedRunReleaseCoordinator } from "./managed-run-release-coordinator.js";
import { createUnixCapabilityServiceHostRuntime } from "./capability-service-unix-host.js";

const NOW_MS = 1_800_000_000_000;
const BUNDLE_DIGEST = "82297e6ae5ae8e2defb7f10b9962e98a3e86140c3941061584ed713a12a999ad";
const BEARER = "synthetic-capability-service-bearer";

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

function makeDefinition(
  release = false,
  attentionResponse = false,
): PlannedCapabilityServiceDefinition {
  return {
    contributionId: "example.service",
    serviceDefinitionId: "example.service-definition",
    protocolId: "comis.capability-service/1",
    mcpServerName: "example-service",
    managedToolBindings: [],
    requestedScopes: [
      "health",
      ...(attentionResponse ? ["attention_response" as const] : []),
      "evidence",
      "report",
      ...(release ? ["workspace_lease" as const] : []),
    ],
    evidencePolicies: [{
      kind: "delivery_reference",
      verificationLevel: "adapter_verified",
      use: "delivery_reference",
    }],
    dependsOn: [],
  };
}

function makeInstance(socketPath: string): PlannedCapabilityServiceInstance {
  return {
    contributionId: "example.service",
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
  };
}

interface LinePeer {
  readonly socket: net.Socket;
  send(value: unknown): void;
  next(): Promise<Record<string, unknown>>;
  close(): void;
}

async function connectPeer(socketPath: string): Promise<LinePeer> {
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
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const parsed = JSON.parse(line) as Record<string, unknown>;
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

function handshake(bearer: string, release = false, attentionResponse = false): unknown {
  return {
    bearer,
    jsonrpc: "2.0",
    id: "operation_handshake_a",
    method: "capabilityServices.handshake",
    params: {
      protocolId: "comis.capability-service/1",
      bundleDigest: BUNDLE_DIGEST,
      operationId: "operation_handshake_a",
      serviceInstanceId: "service-instance_a",
      requestedScopes: [
        "health",
        ...(attentionResponse ? ["attention_response"] : []),
        "evidence",
        "report",
        ...(release ? ["workspace_lease"] : []),
      ],
    },
  };
}

describe("daemon-owned capability-service Unix host", () => {
  const temporaryDirectories: string[] = [];
  const peers: LinePeer[] = [];

  afterEach(() => {
    for (const peer of peers.splice(0)) peer.close();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeRoot(): { directory: string; socketPath: string } {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "cphost-")));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o700);
    return { directory, socketPath: join(directory, "service.sock") };
  }

  function makeHost(
    socketPath: string,
    reportBridge?: ManagedRunReportBridge,
    evidenceBridge?: ManagedRunEvidenceBridge,
    releaseCoordinator?: ManagedRunReleaseCoordinator,
    attentionResponseBridge?: ManagedAttentionResponseBridge,
  ) {
    const clock = createFakeClock(NOW_MS);
    const timers = createFakeTimers(NOW_MS);
    const hostDeps = {
      definitions: [makeDefinition(
        releaseCoordinator !== undefined,
        attentionResponseBridge !== undefined,
      )],
      instances: [makeInstance(socketPath)],
      credentials: new Map([["service-instance_a", () => BEARER]]),
      bundleDigest: BUNDLE_DIGEST,
      socketRoot: dirname(socketPath),
      attentionResponseBridge: attentionResponseBridge ?? {
        receiveAttentionResponse: vi.fn(async () => ok({
          kind: "pending" as const,
          managedRunId: "managed-run_a",
          externalKey: "attention_a",
        })),
      },
      reportBridge: reportBridge ?? {
        ingestReport: vi.fn(async () => ok({
          kind: "accepted" as const,
          report: {
            schemaVersion: 1 as const,
            serviceInstanceId: "service-instance_a",
            managedRunId: "managed-run_a",
            serviceReportId: "service-report_a",
            sequence: 1,
            kind: "progress" as const,
            contentRef: "service-report_a",
            contentHash: "a".repeat(64),
            receivedAtMs: NOW_MS,
            retainedUntilMs: NOW_MS + 60_000,
          },
        })),
      },
      evidenceBridge: evidenceBridge ?? {
        putEvidence: vi.fn(async () => ok({
          kind: "accepted" as const,
          evidence: {
            schemaVersion: 1 as const,
            serviceInstanceId: "service-instance_a",
            managedRunId: "managed-run_a",
            evidenceRef: "evidence_a",
            kind: "delivery_reference",
            subjectDigest: "e".repeat(64),
            observedAtMs: NOW_MS - 10,
            expiresAtMs: NOW_MS + 60_000,
            contentRef: "evidence_a",
            contentHash: "a".repeat(64),
            privateContentHash: "b".repeat(64),
            verificationLevel: "adapter_verified" as const,
            deliveryKind: "reference" as const,
            receivedAtMs: NOW_MS,
          },
        })),
      },
      releaseCoordinator: releaseCoordinator ?? {
        release: vi.fn(async () => ok({ kind: "rejected" as const, reasonCode: "state_mismatch" as const })),
      },
      requestDeadlineMs: 5_000,
      clock,
      timers,
      logger: makeLogger(),
    };
    return {
      clock,
      timers,
      created: createUnixCapabilityServiceHostRuntime(hostDeps),
    };
  }

  it("delivers owner-private attention responses to the authenticated service", async () => {
    const root = makeRoot();
    const receiveAttentionResponse = vi.fn(async () => ok({
      kind: "delivered" as const,
      managedRunId: "managed-run_a",
      externalKey: "backend-id-format",
      response: "Use monotonic issue-N values.",
    }));
    const host = makeHost(
      root.socketPath,
      undefined,
      undefined,
      undefined,
      { receiveAttentionResponse },
    );
    if (!host.created.ok) throw host.created.error;
    const constructed = await host.created.value.activators[0]!.construct(makeInstance(root.socketPath));
    if (!constructed.ok) throw constructed.error;
    const started = constructed.value.start();
    const peer = await connectPeer(root.socketPath);
    peers.push(peer);
    peer.send(handshake(BEARER, false, true));
    await peer.next();
    if (!(await started).ok) return;

    peer.send({
      bearer: BEARER,
      jsonrpc: "2.0",
      id: "operation_attention_response_a",
      method: "managedRuns.receiveAttentionResponse",
      params: {
        operationId: "operation_attention_response_a",
        managedRunId: "managed-run_a",
        externalKey: "backend-id-format",
      },
    });

    expect(await peer.next()).toEqual({
      jsonrpc: "2.0",
      id: "operation_attention_response_a",
      result: {
        managedRunId: "managed-run_a",
        externalKey: "backend-id-format",
        state: "delivered",
        response: "Use monotonic issue-N values.",
      },
    });
    expect(receiveAttentionResponse).toHaveBeenCalledWith({
      operationId: "operation_attention_response_a",
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      externalKey: "backend-id-format",
    });
    expect(await constructed.value.close()).toEqual({ ok: true, value: undefined });
  });

  it("routes authenticated release requests through host authority", async () => {
    const root = makeRoot();
    const release: ManagedRunReleaseCoordinator["release"] = vi.fn(async () => ok({
      kind: "released" as const,
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      disposition: "reap_safe" as const,
      releasedAtMs: NOW_MS,
    }));
    const host = makeHost(root.socketPath, undefined, undefined, { release });
    if (!host.created.ok) throw host.created.error;
    const constructed = await host.created.value.activators[0]!.construct(makeInstance(root.socketPath));
    if (!constructed.ok) throw constructed.error;
    const started = constructed.value.start();
    const peer = await connectPeer(root.socketPath);
    peers.push(peer);
    peer.send(handshake(BEARER, true));
    await peer.next();
    if (!(await started).ok) return;

    peer.send({
      bearer: BEARER,
      jsonrpc: "2.0",
      id: "operation_release_a",
      method: "managedRuns.release",
      params: {
        operationId: "operation_release_a",
        managedRunId: "managed-run_a",
        workspaceLeaseId: "workspace-lease_a",
        disposition: "reap_safe",
        releasedAtMs: NOW_MS,
      },
    });
    expect(await peer.next()).toEqual({
      jsonrpc: "2.0",
      id: "operation_release_a",
      result: {
        managedRunId: "managed-run_a",
        workspaceLeaseId: "workspace-lease_a",
        state: "released",
        disposition: "reap_safe",
        releasedAtMs: NOW_MS,
      },
    });
    expect(release).toHaveBeenCalledWith({
      operationId: "operation_release_a",
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      disposition: "reap_safe",
      releasedAtMs: NOW_MS,
    });
    expect(await constructed.value.close()).toEqual({ ok: true, value: undefined });
  });

  it("owns a 0600 socket and carries handshake control and reports bidirectionally", async () => {
    const root = makeRoot();
    const reportBridge: ManagedRunReportBridge = {
      ingestReport: vi.fn(async () => ok({
        kind: "accepted" as const,
        report: {
          schemaVersion: 1 as const,
          serviceInstanceId: "service-instance_a",
          managedRunId: "managed-run_a",
          serviceReportId: "service-report_a",
          sequence: 7,
          kind: "progress" as const,
          contentRef: "service-report_a",
          contentHash: "a".repeat(64),
          receivedAtMs: NOW_MS,
          retainedUntilMs: NOW_MS + 60_000,
        },
      })),
    };
    const evidenceBody = Buffer.from("https://example.com/result/17", "utf8");
    const evidenceHash = createHash("sha256").update(evidenceBody).digest("hex");
    const evidenceBridge: ManagedRunEvidenceBridge = {
      putEvidence: vi.fn(async () => ok({
        kind: "accepted" as const,
        evidence: {
          schemaVersion: 1 as const,
          serviceInstanceId: "service-instance_a",
          managedRunId: "managed-run_a",
          evidenceRef: "evidence_a",
          kind: "delivery_reference",
          subjectDigest: "e".repeat(64),
          observedAtMs: NOW_MS - 10,
          expiresAtMs: NOW_MS + 60_000,
          contentRef: "evidence_a",
          contentHash: evidenceHash,
          privateContentHash: "b".repeat(64),
          verificationLevel: "adapter_verified" as const,
          deliveryKind: "reference" as const,
          receivedAtMs: NOW_MS,
        },
      })),
    };
    const host = makeHost(root.socketPath, reportBridge, evidenceBridge);
    expect(host.created.ok).toBe(true);
    if (!host.created.ok) return;
    const constructed = await host.created.value.activators[0]!.construct(makeInstance(root.socketPath));
    expect(constructed.ok).toBe(true);
    if (!constructed.ok) return;
    expect(statSync(root.socketPath).mode & 0o777).toBe(0o600);

    const started = constructed.value.start();
    const peer = await connectPeer(root.socketPath);
    peers.push(peer);
    peer.send(handshake(BEARER));
    expect(await peer.next()).toMatchObject({
      id: "operation_handshake_a",
      result: {
        protocolId: "comis.capability-service/1",
        bundleDigest: BUNDLE_DIGEST,
        serviceInstanceId: "service-instance_a",
        activeScopes: ["health", "evidence", "report"],
      },
    });
    expect(await started).toEqual({
      ok: true,
      value: {
        protocolId: "comis.capability-service/1",
        serviceInstanceId: "service-instance_a",
        activeScopes: ["health", "evidence", "report"],
      },
    });

    const activation = host.created.value.control.activate({
      operationId: "operation_activate_a",
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      externalRunRef: "external-run_a",
      registrationNonce: "registration-nonce_a",
      workspaceLeaseId: "workspace-lease_a",
      executionAttachmentId: "execution-attachment_a",
      attachmentTargetName: `attachment-${"a".repeat(32)}.sock`,
    });
    const activationRequest = await peer.next();
    expect(activationRequest).toMatchObject({
      bearer: BEARER,
      id: "operation_activate_a",
      method: "managedRuns.activate",
      params: {
        workspaceLeaseId: "workspace-lease_a",
        executionAttachmentId: "execution-attachment_a",
        attachmentTargetName: `attachment-${"a".repeat(32)}.sock`,
      },
    });
    peer.send({
      jsonrpc: "2.0",
      id: "operation_activate_a",
      result: {
        managedRunId: "managed-run_a",
        externalRunRef: "external-run_a",
        state: "active",
        activatedAtMs: NOW_MS,
      },
    });
    expect(await activation).toMatchObject({ ok: true, value: { state: "active" } });

    const terminalEvent = (host.created.value.control as unknown as {
      terminalEvent(command: Record<string, unknown>): Promise<unknown>;
    }).terminalEvent({
      operationId: "operation_terminal_created",
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      terminalSessionId: "terminal-session_a",
      transition: "created",
    });
    const terminalRequest = await peer.next();
    expect(terminalRequest).toMatchObject({
      bearer: BEARER,
      id: "operation_terminal_created",
      method: "managedRuns.terminalEvent",
      params: {
        operationId: "operation_terminal_created",
        managedRunId: "managed-run_a",
        workspaceLeaseId: "workspace-lease_a",
        terminalSessionId: "terminal-session_a",
        transition: "created",
      },
    });
    peer.send({
      jsonrpc: "2.0",
      id: "operation_terminal_created",
      result: {
        managedRunId: "managed-run_a",
        terminalSessionId: "terminal-session_a",
        transition: "created",
      },
    });
    expect(await terminalEvent).toMatchObject({
      ok: true,
      value: {
        managedRunId: "managed-run_a",
        terminalSessionId: "terminal-session_a",
        transition: "created",
      },
    });

    peer.send({
      bearer: BEARER,
      jsonrpc: "2.0",
      id: "operation_report_a",
      method: "managedRuns.report",
      params: {
        operationId: "operation_report_a",
        managedRunId: "managed-run_a",
        serviceReportId: "service-report_a",
        kind: "progress",
        summary: "Synthetic progress",
      },
    });
    expect(await peer.next()).toMatchObject({
      id: "operation_report_a",
      result: {
        managedRunId: "managed-run_a",
        serviceReportId: "service-report_a",
        acceptedSequence: 7,
        retainedUntilMs: NOW_MS + 60_000,
      },
    });
    expect(reportBridge.ingestReport).toHaveBeenCalledWith({
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      report: {
        serviceReportId: "service-report_a",
        kind: "progress",
        summary: "Synthetic progress",
      },
    });

    peer.send({
      bearer: BEARER,
      jsonrpc: "2.0",
      id: "operation_evidence_a",
      method: "managedRuns.putEvidence",
      params: {
        operationId: "operation_evidence_a",
        managedRunId: "managed-run_a",
        evidenceRef: "evidence_a",
        kind: "delivery_reference",
        subjectDigest: "e".repeat(64),
        observedAtMs: NOW_MS - 10,
        expiresAtMs: NOW_MS + 60_000,
        contentHash: evidenceHash,
        verificationLevel: "adapter_verified",
        bodyBase64: evidenceBody.toString("base64"),
        delivery: { kind: "reference" },
      },
    });
    expect(await peer.next()).toMatchObject({
      id: "operation_evidence_a",
      result: {
        managedRunId: "managed-run_a",
        evidenceRef: "evidence_a",
        contentHash: evidenceHash,
        verificationLevel: "adapter_verified",
        retainedUntilMs: NOW_MS + 60_000,
      },
    });
    expect(evidenceBridge.putEvidence).toHaveBeenCalledWith({
      operationId: "operation_evidence_a",
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      evidenceRef: "evidence_a",
      kind: "delivery_reference",
      subjectDigest: "e".repeat(64),
      observedAtMs: NOW_MS - 10,
      expiresAtMs: NOW_MS + 60_000,
      contentHash: evidenceHash,
      verificationLevel: "adapter_verified",
      bodyBase64: evidenceBody.toString("base64"),
      delivery: { kind: "reference" },
    });

    expect(await constructed.value.close()).toEqual({ ok: true, value: undefined });
  });

  it("rejects the wrong bearer without binding the service identity", async () => {
    const root = makeRoot();
    const host = makeHost(root.socketPath);
    if (!host.created.ok) throw host.created.error;
    const constructed = await host.created.value.activators[0]!.construct(makeInstance(root.socketPath));
    if (!constructed.ok) throw constructed.error;
    const started = constructed.value.start();
    const rejectedPeer = await connectPeer(root.socketPath);
    peers.push(rejectedPeer);
    rejectedPeer.send(handshake("wrong-synthetic-bearer"));
    expect(await rejectedPeer.next()).toMatchObject({
      id: null,
      error: { kind: "unauthorized_instance", retryable: false },
    });

    const acceptedPeer = await connectPeer(root.socketPath);
    peers.push(acceptedPeer);
    acceptedPeer.send(handshake(BEARER));
    expect(await acceptedPeer.next()).toHaveProperty("result");
    expect((await started).ok).toBe(true);
    expect(await constructed.value.close()).toEqual({ ok: true, value: undefined });
  });

  it("restores the connection binding when a successful handshake is replayed after reconnect", async () => {
    const root = makeRoot();
    const reportBridge: ManagedRunReportBridge = {
      ingestReport: vi.fn(async () => ok({
        kind: "accepted" as const,
        report: {
          schemaVersion: 1 as const,
          serviceInstanceId: "service-instance_a",
          managedRunId: "managed-run_a",
          serviceReportId: "service-report_reconnect",
          sequence: 1,
          kind: "progress" as const,
          contentRef: "service-report_reconnect",
          contentHash: "a".repeat(64),
          receivedAtMs: NOW_MS,
          retainedUntilMs: NOW_MS + 60_000,
        },
      })),
    };
    const host = makeHost(root.socketPath, reportBridge);
    if (!host.created.ok) throw host.created.error;
    const constructed = await host.created.value.activators[0]!.construct(makeInstance(root.socketPath));
    if (!constructed.ok) throw constructed.error;
    const started = constructed.value.start();
    const firstPeer = await connectPeer(root.socketPath);
    peers.push(firstPeer);
    firstPeer.send(handshake(BEARER));
    expect(await firstPeer.next()).toHaveProperty("result");
    expect((await started).ok).toBe(true);
    firstPeer.close();
    await waitForTurn();

    const reconnectedPeer = await connectPeer(root.socketPath);
    peers.push(reconnectedPeer);
    reconnectedPeer.send(handshake(BEARER));
    expect(await reconnectedPeer.next()).toHaveProperty("result");
    reconnectedPeer.send({
      bearer: BEARER,
      jsonrpc: "2.0",
      id: "operation_report_reconnect",
      method: "managedRuns.report",
      params: {
        operationId: "operation_report_reconnect",
        managedRunId: "managed-run_a",
        serviceReportId: "service-report_reconnect",
        kind: "progress",
        summary: "Synthetic reconnect progress",
      },
    });
    expect(await reconnectedPeer.next()).toMatchObject({
      id: "operation_report_reconnect",
      result: { acceptedSequence: 1 },
    });
    expect(reportBridge.ingestReport).toHaveBeenCalledOnce();
    expect(await constructed.value.close()).toEqual({ ok: true, value: undefined });
  });

  it("retries an exact durable ingress operation after a transient internal response", async () => {
    const root = makeRoot();
    const accepted = {
      kind: "accepted" as const,
      report: {
        schemaVersion: 1 as const,
        serviceInstanceId: "service-instance_a",
        managedRunId: "managed-run_a",
        serviceReportId: "service-report_retry",
        sequence: 1,
        kind: "progress" as const,
        contentRef: "service-report_retry",
        contentHash: "a".repeat(64),
        receivedAtMs: NOW_MS,
        retainedUntilMs: NOW_MS + 60_000,
      },
    };
    const ingestReport = vi.fn()
      .mockResolvedValueOnce(err(new Error("synthetic store interruption")))
      .mockResolvedValueOnce(ok(accepted));
    const host = makeHost(root.socketPath, { ingestReport });
    if (!host.created.ok) throw host.created.error;
    const constructed = await host.created.value.activators[0]!.construct(makeInstance(root.socketPath));
    if (!constructed.ok) throw constructed.error;
    const started = constructed.value.start();
    const peer = await connectPeer(root.socketPath);
    peers.push(peer);
    peer.send(handshake(BEARER));
    await peer.next();
    if (!(await started).ok) return;
    const request = {
      bearer: BEARER,
      jsonrpc: "2.0",
      id: "operation_report_retry",
      method: "managedRuns.report",
      params: {
        operationId: "operation_report_retry",
        managedRunId: "managed-run_a",
        serviceReportId: "service-report_retry",
        kind: "progress",
        summary: "Synthetic retry progress",
      },
    };

    peer.send(request);
    expect(await peer.next()).toMatchObject({ error: { kind: "internal_error", retryable: true } });
    peer.send(request);
    expect(await peer.next()).toMatchObject({ result: { acceptedSequence: 1 } });
    expect(ingestReport).toHaveBeenCalledTimes(2);
    expect(await constructed.value.close()).toEqual({ ok: true, value: undefined });
  });

  it("rejects an altered durable ingress retry after a transient internal response", async () => {
    const root = makeRoot();
    const ingestReport = vi.fn()
      .mockResolvedValueOnce(err(new Error("synthetic store interruption")))
      .mockResolvedValueOnce(ok({
        kind: "accepted" as const,
        report: {
          schemaVersion: 1 as const,
          serviceInstanceId: "service-instance_a",
          managedRunId: "managed-run_a",
          serviceReportId: "service-report_retry_conflict",
          sequence: 1,
          kind: "progress" as const,
          contentRef: "service-report_retry_conflict",
          contentHash: "a".repeat(64),
          receivedAtMs: NOW_MS,
          retainedUntilMs: NOW_MS + 60_000,
        },
      }));
    const host = makeHost(root.socketPath, { ingestReport });
    if (!host.created.ok) throw host.created.error;
    const constructed = await host.created.value.activators[0]!.construct(makeInstance(root.socketPath));
    if (!constructed.ok) throw constructed.error;
    const started = constructed.value.start();
    const peer = await connectPeer(root.socketPath);
    peers.push(peer);
    peer.send(handshake(BEARER));
    await peer.next();
    if (!(await started).ok) return;
    const request = {
      bearer: BEARER,
      jsonrpc: "2.0",
      id: "operation_report_retry_conflict",
      method: "managedRuns.report",
      params: {
        operationId: "operation_report_retry_conflict",
        managedRunId: "managed-run_a",
        serviceReportId: "service-report_retry_conflict",
        kind: "progress",
        summary: "Synthetic retry progress",
      },
    };

    peer.send(request);
    expect(await peer.next()).toMatchObject({ error: { kind: "internal_error", retryable: true } });
    peer.send({
      ...request,
      params: { ...request.params, summary: "Altered retry progress" },
    });
    expect(await peer.next()).toMatchObject({ error: { kind: "replay_conflict", retryable: false } });
    expect(ingestReport).toHaveBeenCalledOnce();
    expect(await constructed.value.close()).toEqual({ ok: true, value: undefined });
  });

  it("classifies a written control request deadline as an uncertain outcome", async () => {
    const root = makeRoot();
    const host = makeHost(root.socketPath);
    if (!host.created.ok) throw host.created.error;
    const constructed = await host.created.value.activators[0]!.construct(makeInstance(root.socketPath));
    if (!constructed.ok) throw constructed.error;
    const started = constructed.value.start();
    const peer = await connectPeer(root.socketPath);
    peers.push(peer);
    peer.send(handshake(BEARER));
    await peer.next();
    if (!(await started).ok) return;

    const activation = host.created.value.control.activate({
      operationId: "operation_timeout_a",
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      externalRunRef: "external-run_a",
      registrationNonce: "registration-nonce_a",
    });
    await peer.next();
    host.timers.advance(5_000);
    expect(await activation).toEqual({
      ok: false,
      error: { kind: "uncertain", reasonCode: "deadline_exceeded" },
    });
    expect(await constructed.value.close()).toEqual({ ok: true, value: undefined });
  });

  it("keeps timed-out mutations admitted until durable settlement", async () => {
    const root = makeRoot();
    let resolveReport!: (value: Awaited<ReturnType<ManagedRunReportBridge["ingestReport"]>>) => void;
    const pendingReport = new Promise<Awaited<ReturnType<ManagedRunReportBridge["ingestReport"]>>>((resolve) => {
      resolveReport = resolve;
    });
    const reportBridge: ManagedRunReportBridge = {
      ingestReport: vi.fn(() => pendingReport),
    };
    const host = makeHost(root.socketPath, reportBridge);
    if (!host.created.ok) throw host.created.error;
    const constructed = await host.created.value.activators[0]!.construct(makeInstance(root.socketPath));
    if (!constructed.ok) throw constructed.error;
    const started = constructed.value.start();
    const peer = await connectPeer(root.socketPath);
    peers.push(peer);
    peer.send(handshake(BEARER));
    await peer.next();
    if (!(await started).ok) return;

    const request = {
      bearer: BEARER,
      jsonrpc: "2.0",
      id: "operation_report_drain",
      method: "managedRuns.report",
      params: {
        operationId: "operation_report_drain",
        managedRunId: "managed-run_a",
        serviceReportId: "service-report_drain",
        kind: "progress",
        summary: "Synthetic progress",
      },
    };
    peer.send(request);
    await vi.waitFor(() => expect(reportBridge.ingestReport).toHaveBeenCalledOnce());
    host.timers.advance(5_000);
    expect(await peer.next()).toMatchObject({
      error: { kind: "deadline_exceeded", retryable: true },
    });
    peer.send(request);
    expect(await peer.next()).toMatchObject({
      error: { kind: "rate_limited", retryable: true },
    });
    expect(reportBridge.ingestReport).toHaveBeenCalledOnce();

    let closeSettled = false;
    const closing = constructed.value.close().then((result) => {
      closeSettled = true;
      return result;
    });
    await waitForTurn();
    expect(closeSettled).toBe(false);

    resolveReport(ok({
      kind: "accepted",
      report: {
        schemaVersion: 1,
        serviceInstanceId: "service-instance_a",
        managedRunId: "managed-run_a",
        serviceReportId: "service-report_drain",
        sequence: 1,
        kind: "progress",
        contentRef: "service-report_drain",
        contentHash: "a".repeat(64),
        receivedAtMs: NOW_MS,
        retainedUntilMs: NOW_MS + 60_000,
      },
    }));
    expect(await closing).toEqual({ ok: true, value: undefined });
  });

});
