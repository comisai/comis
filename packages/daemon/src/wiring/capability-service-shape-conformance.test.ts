// SPDX-License-Identifier: Apache-2.0
/**
 * Composable-shape conformance for the capability-service platform.
 *
 * The platform is not proven by one vertical working. A service that needs
 * records, evidence, and questions must not inherit workspace, terminal, or
 * attachment authority, and a service that only contributes tools must not have
 * to configure executor plumbing it never uses. Without a fixture for each
 * shape, the only consumer defines the platform, and the absent scopes are
 * "untested" rather than "proven absent".
 *
 * These fixtures are deliberately neutral: they carry no consumer's domain
 * nouns, so nothing here can quietly become a second definition of the runtime.
 *
 * @module
 */
import net from "node:net";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY_SERVICE_BUNDLE_DIGEST } from "@comis/capability-service-sdk";
import {
  TypedEventBus,
  createSecretManager,
  type CapabilityServiceContributionRegistration,
  type CapabilityServiceScope,
  type CapabilityServicesConfig,
  type ComisLogger,
} from "@comis/core";
import { initSchema } from "@comis/memory";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { setupCapabilityServices } from "./setup-capability-services.js";

const NOW_MS = 1_800_000_000_000;
const BEARER = "shape-conformance-bearer";

/** The two composable shapes this platform claims to support without an executor. */
const TOOL_ONLY_SCOPES: readonly CapabilityServiceScope[] = ["health"];
const MANAGED_RECORD_SCOPES: readonly CapabilityServiceScope[] = [
  "health",
  "report",
  "evidence",
  "attention_response",
];
/** Scopes only a managed executor may hold. No fixture here requests one. */
const EXECUTOR_SCOPES: readonly CapabilityServiceScope[] = [
  "workspace_lease",
  "terminal_events",
  "execution_attachment",
];

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), fatal: vi.fn(), audit: vi.fn(),
    child: vi.fn(function child() { return this; }),
  } as unknown as ComisLogger;
}

interface LinePeer {
  send(value: unknown): void;
  next(): Promise<Record<string, unknown>>;
  close(): void;
}

async function connectPeer(socketPath: string): Promise<LinePeer> {
  for (let attempt = 0; attempt < 200 && !existsSync(socketPath); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
    send: (value) => socket.write(`${JSON.stringify(value)}\n`),
    next: () => {
      const ready = values.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => socket.destroy(),
  };
}

describe("capability-service shape conformance", () => {
  const directories: string[] = [];
  const peers: LinePeer[] = [];
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const peer of peers.splice(0)) peer.close();
    for (const db of databases.splice(0)) if (db.open) db.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function runtimeFor(scopes: readonly CapabilityServiceScope[]) {
    const dataDir = realpathSync(mkdtempSync("/tmp/cpshape-"));
    directories.push(dataDir);
    chmodSync(dataDir, 0o700);
    const socketPath = join(dataDir, "capability-services", "shape-fixture.sock");
    const db = new Database(join(dataDir, "shape.db"));
    databases.push(db);
    initSchema(db, 4);
    const contribution: CapabilityServiceContributionRegistration = {
      contributionId: "shape.fixture",
      configSections: [],
      serviceDefinitions: [{
        serviceDefinitionId: "shape.fixture-definition",
        protocolId: "comis.capability-service/1",
        mcpServerName: "shape-fixture",
        managedToolBindings: [],
        requestedScopes: [...scopes],
        evidencePolicies: [],
        dependsOn: [],
      }],
    };
    const config: CapabilityServicesConfig = {
      instances: [{
        serviceInstanceId: "service-instance_shape",
        serviceDefinitionId: "shape.fixture-definition",
        enabled: true,
        mcpServerName: "shape-fixture",
        control: {
          transport: "unix",
          socketPath,
          credentialRef: "secret://capability-services/service-instance_shape",
        },
        allowedAgents: ["agent_a"],
        // Deliberately empty. A record-only or tool-only service must activate
        // with no executor roots configured at all; requiring a placeholder
        // would make every consumer look like an executor.
        allowedWorkspaceRoots: [],
        allowedRuntimeRoots: [],
      }],
      privateContentDirectory: "managed-runs/private",
      reportRetentionMs: 2_592_000_000,
      maxObservedClockSkewMs: 300_000,
      recoveryBatchSize: 256,
      requestDeadlineMs: 5_000,
    };
    return {
      dataDir, socketPath, db, config, contribution,
      logger: makeLogger(),
      clock: createFakeClock(NOW_MS),
      secretManager: createSecretManager({
        "capability-services/service-instance_shape": BEARER,
      } as never),
    };
  }

  async function activate(scopes: readonly CapabilityServiceScope[], handshakeScopes = scopes) {
    const runtime = runtimeFor(scopes);
    const pending = setupCapabilityServices({
      contributions: [runtime.contribution],
      config: runtime.config,
      db: runtime.db,
      dataDir: runtime.dataDir,
      secretManager: runtime.secretManager,
      eventBus: new TypedEventBus(),
      logger: runtime.logger,
      clock: runtime.clock,
      timers: createFakeTimers(NOW_MS),
    });
    const peer = await connectPeer(runtime.socketPath);
    peers.push(peer);
    peer.send({
      bearer: BEARER,
      jsonrpc: "2.0",
      id: "operation_handshake_shape",
      method: "capabilityServices.handshake",
      params: {
        protocolId: "comis.capability-service/1",
        bundleDigest: CAPABILITY_SERVICE_BUNDLE_DIGEST,
        operationId: "operation_handshake_shape",
        serviceInstanceId: "service-instance_shape",
        requestedScopes: [...handshakeScopes],
      },
    });
    const handshake = await peer.next();
    // The setup promise is returned unresolved on purpose: a refused handshake
    // never completes activation, so awaiting it here would hang the one test
    // whose whole point is that the refusal happened.
    return { handshake, pending };
  }

  it("activates a tool-only service with no executor scope or root", async () => {
    const { handshake, pending } = await activate(TOOL_ONLY_SCOPES);
    const setup = await pending;

    expect(handshake).toHaveProperty("result");
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    const instance = setup.value.runtime.getActiveView().instances[0];
    expect(instance?.state).toBe("active");
    expect(instance?.activeScopes).toEqual(["health"]);
    // The absent scopes are proven absent, not merely untested.
    for (const scope of EXECUTOR_SCOPES) {
      expect(instance?.activeScopes).not.toContain(scope);
    }
    expect(instance?.allowedWorkspaceRoots).toEqual([]);
    expect(instance?.allowedRuntimeRoots).toEqual([]);
    await setup.value.shutdown();
  });

  it("activates a record-only service without workspace, terminal, or attachment authority", async () => {
    const { handshake, pending } = await activate(MANAGED_RECORD_SCOPES);
    const setup = await pending;

    expect(handshake).toHaveProperty("result");
    expect(setup.ok).toBe(true);
    if (!setup.ok) return;
    const instance = setup.value.runtime.getActiveView().instances[0];
    expect(instance?.state).toBe("active");
    expect([...(instance?.activeScopes ?? [])].sort()).toEqual(
      [...MANAGED_RECORD_SCOPES].sort(),
    );
    for (const scope of EXECUTOR_SCOPES) {
      expect(instance?.activeScopes).not.toContain(scope);
    }
    await setup.value.shutdown();
  });

  it("refuses a handshake that claims a scope its definition never declared", async () => {
    // Metadata cannot grant authority. A record-only service that asks for a
    // workspace lease at handshake time is refused rather than upgraded.
    const { handshake, pending } = await activate(MANAGED_RECORD_SCOPES, [
      ...MANAGED_RECORD_SCOPES,
      "workspace_lease",
    ]);

    expect(handshake).toHaveProperty("error");
    expect(handshake).not.toHaveProperty("result");
    // Activation is left unresolved by the refusal; drop it so the suite does
    // not carry an unhandled rejection past this test.
    void pending.catch(() => undefined);
  });
});
