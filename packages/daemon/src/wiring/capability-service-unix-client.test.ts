// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ComisLogger,
  type PlannedCapabilityServiceDefinition,
  type PlannedCapabilityServiceInstance,
} from "@comis/core";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import { createCapabilityServiceProtocolFixtureServer } from "../__tests__/capability-service-protocol-fixture-server.js";
import { createUnixCapabilityServiceClientRuntime } from "./capability-service-unix-client.js";

const BUNDLE_DIGEST = "e87e69511ea9e01ea2383cd211f9946233fdbe1ce8edf016e76ce55eae683297";
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
  };
}

describe("capability-service Unix client runtime", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function startFixture() {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "cpc-")));
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o700);
    const server = createCapabilityServiceProtocolFixtureServer({
      activeScopes: ["health", "report"],
      bundleDigest: BUNDLE_DIGEST,
      clock: createFakeClock(1_800_000_000_000),
      directoryPath: directory,
      expectedBearer: BEARER,
      requestDeadlineMs: 5_000,
      serviceInstanceId: "service-instance_a",
    });
    const started = await server.start();
    if (!started.ok) throw started.error;
    return { server, socketPath: started.value.socketPath };
  }

  it("performs a real exact handshake and instance-scoped control calls", async () => {
    const fixture = await startFixture();
    const instance = makeInstance(fixture.socketPath);
    const created = createUnixCapabilityServiceClientRuntime({
      definitions: [makeDefinition()],
      instances: [instance],
      credentials: new Map([["service-instance_a", BEARER]]),
      bundleDigest: BUNDLE_DIGEST,
      requestDeadlineMs: 5_000,
      nowMs: () => 1_800_000_000_000,
      logger: makeLogger(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const activator = created.value.activators[0];
    expect(activator).toBeDefined();
    const constructed = await activator!.construct(instance);
    expect(constructed.ok).toBe(true);
    if (!constructed.ok) return;

    expect(await constructed.value.start()).toEqual({
      ok: true,
      value: {
        protocolId: "comis.capability-service/1",
        serviceInstanceId: "service-instance_a",
        activeScopes: ["health", "report"],
      },
    });
    expect(await created.value.control.activate({
      operationId: "operation_activate_a",
      serviceInstanceId: "service-instance_a",
      managedRunId: "managed-run_a",
      externalRunRef: "external-run_a",
      registrationNonce: "registration-nonce_a",
    })).toMatchObject({
      ok: true,
      value: { managedRunId: "managed-run_a", state: "active" },
    });
    expect(await created.value.control.abandon({
      operationId: "operation_abandon_a",
      serviceInstanceId: "service-instance_a",
      externalRunRef: "external-run_b",
      registrationNonce: "registration-nonce_b",
      reason: "owner_cancelled",
    })).toEqual({
      ok: true,
      value: { externalRunRef: "external-run_b", state: "abandoned" },
    });
    expect(await constructed.value.close()).toEqual({ ok: true, value: undefined });
    await fixture.server.close();
  });

  it("fails closed on the wrong credential without exposing it in logs", async () => {
    const fixture = await startFixture();
    const instance = makeInstance(fixture.socketPath);
    const logger = makeLogger();
    const created = createUnixCapabilityServiceClientRuntime({
      definitions: [makeDefinition()],
      instances: [instance],
      credentials: new Map([["service-instance_a", "wrong-synthetic-bearer"]]),
      bundleDigest: BUNDLE_DIGEST,
      requestDeadlineMs: 5_000,
      nowMs: () => 1_800_000_000_000,
      logger,
    });
    if (!created.ok) throw created.error;
    const constructed = await created.value.activators[0]!.construct(instance);
    if (!constructed.ok) throw constructed.error;

    expect((await constructed.value.start()).ok).toBe(false);
    expect(JSON.stringify((logger.debug as ReturnType<typeof vi.fn>).mock.calls))
      .not.toContain("wrong-synthetic-bearer");
    await fixture.server.close();
  });

  it("returns explicit unavailability for an unconfigured instance", async () => {
    const created = createUnixCapabilityServiceClientRuntime({
      definitions: [makeDefinition()],
      instances: [],
      credentials: new Map(),
      bundleDigest: BUNDLE_DIGEST,
      requestDeadlineMs: 5_000,
      nowMs: () => 1_800_000_000_000,
      logger: makeLogger(),
    });
    if (!created.ok) throw created.error;

    expect(await created.value.control.activate({
      operationId: "operation_missing",
      serviceInstanceId: "service-instance_missing",
      managedRunId: "managed-run_missing",
      externalRunRef: "external-run_missing",
      registrationNonce: "registration-nonce_missing",
    })).toEqual({
      ok: false,
      error: { kind: "unavailable", reasonCode: "instance_not_configured" },
    });
  });
});
