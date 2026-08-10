// SPDX-License-Identifier: Apache-2.0
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
import { ok } from "@comis/shared";
import type { ManagedRunReportBridge } from "./managed-run-report-bridge.js";
import { createUnixCapabilityServiceHostRuntime } from "./capability-service-unix-host.js";

const NOW_MS = 1_800_000_000_000;
const BUNDLE_DIGEST = "ffbe9fe2b15f0dfdda280705d5a3d5cf5787f4be74a2fe4341b3839d0f12d5b1";
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

function makeDefinition(): PlannedCapabilityServiceDefinition {
  return {
    contributionId: "example.service",
    serviceDefinitionId: "example.service-definition",
    protocolId: "comis.capability-service/1",
    mcpServerName: "example-service",
    managedToolBindings: [],
    requestedScopes: ["health", "report"],
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

function handshake(bearer: string): unknown {
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
      requestedScopes: ["health", "report"],
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

  function makeHost(socketPath: string, reportBridge?: ManagedRunReportBridge) {
    const clock = createFakeClock(NOW_MS);
    const timers = createFakeTimers(NOW_MS);
    return {
      clock,
      timers,
      created: createUnixCapabilityServiceHostRuntime({
        definitions: [makeDefinition()],
        instances: [makeInstance(socketPath)],
        credentials: new Map([["service-instance_a", () => BEARER]]),
        bundleDigest: BUNDLE_DIGEST,
        socketRoot: dirname(socketPath),
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
        requestDeadlineMs: 5_000,
        clock,
        timers,
        logger: makeLogger(),
      }),
    };
  }

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
    const host = makeHost(root.socketPath, reportBridge);
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
        activeScopes: ["health", "report"],
      },
    });
    expect(await started).toEqual({
      ok: true,
      value: {
        protocolId: "comis.capability-service/1",
        serviceInstanceId: "service-instance_a",
        activeScopes: ["health", "report"],
      },
    });

    const activation = host.created.value.control.activate({
      operationId: "operation_activate_a",
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      externalRunRef: "external-run_a",
      registrationNonce: "registration-nonce_a",
    });
    const activationRequest = await peer.next();
    expect(activationRequest).toMatchObject({
      bearer: BEARER,
      id: "operation_activate_a",
      method: "managedRuns.activate",
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

  it("drains an accepted report mutation before closing its socket", async () => {
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

    peer.send({
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
    });
    await vi.waitFor(() => expect(reportBridge.ingestReport).toHaveBeenCalledOnce());

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
