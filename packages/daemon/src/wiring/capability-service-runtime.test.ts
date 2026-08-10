// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  CAPABILITY_SERVICE_CONTROL_PROTOCOL,
  TypedEventBus,
  buildCapabilityServiceActivationPlan,
  type CapabilityServiceActivationPlan,
  type CapabilityServiceContributionRegistration,
  type CapabilityServiceInstanceConfig,
  type ComisLogger,
} from "@comis/core";
import { err, ok } from "@comis/shared";
import {
  createCapabilityServiceRuntime,
  type CapabilityServiceRuntimeActivator,
  type CapabilityServiceRuntimeHandle,
} from "./capability-service-runtime.js";

function makeContribution(
  contributionId: string,
  definitionId: string,
  mcpServerName: string,
  dependsOn: readonly string[] = [],
): CapabilityServiceContributionRegistration {
  return {
    contributionId,
    configSections: [],
    serviceDefinitions: [{
      serviceDefinitionId: definitionId,
      protocolId: CAPABILITY_SERVICE_CONTROL_PROTOCOL,
      mcpServerName,
      managedToolBindings: [{
        toolName: "prepare_work",
        behavior: "prepare_run",
        actionClassification: "mutate",
        invocationSideEffects: ["deferred_work"],
      }],
      requestedScopes: ["health", "report"],
      dependsOn: [...dependsOn],
    }],
  };
}

function makeInstance(
  serviceInstanceId: string,
  serviceDefinitionId: string,
  mcpServerName: string,
): CapabilityServiceInstanceConfig {
  return {
    serviceInstanceId,
    serviceDefinitionId,
    enabled: true,
    mcpServerName,
    control: {
      transport: "unix",
      socketPath: `/tmp/${serviceInstanceId}.sock`,
      credentialRef: `secret://capability-services/${serviceInstanceId}`,
    },
    allowedAgents: ["agent_a"],
    allowedWorkspaceRoots: [],
    allowedRuntimeRoots: [],
  };
}

function makePlan(
  contributions: readonly CapabilityServiceContributionRegistration[],
  instances: readonly CapabilityServiceInstanceConfig[],
): CapabilityServiceActivationPlan {
  const result = buildCapabilityServiceActivationPlan(contributions, instances);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
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

function makeActivator(
  serviceDefinitionId: string,
  handles: Map<string, CapabilityServiceRuntimeHandle>,
  calls: string[],
): CapabilityServiceRuntimeActivator {
  return {
    serviceDefinitionId,
    construct: async (instance) => {
      calls.push(`construct:${instance.serviceInstanceId}`);
      const handle = handles.get(instance.serviceInstanceId);
      return handle === undefined ? err(new Error("synthetic construction failure")) : ok(handle);
    },
  };
}

function makeHandle(
  serviceInstanceId: string,
  calls: string[],
  overrides: Partial<CapabilityServiceRuntimeHandle> = {},
): CapabilityServiceRuntimeHandle {
  return {
    start: async () => {
      calls.push(`start:${serviceInstanceId}`);
      return ok({
        protocolId: CAPABILITY_SERVICE_CONTROL_PROTOCOL,
        serviceInstanceId,
        activeScopes: ["health", "report"],
      });
    },
    close: async () => {
      calls.push(`close:${serviceInstanceId}`);
      return ok(undefined);
    },
    ...overrides,
  };
}

describe("capability-service runtime publication", () => {
  it("publishes one deeply immutable active view after dependency-ordered health handshakes", async () => {
    const calls: string[] = [];
    const contributions = [
      makeContribution("example.worker", "example.worker-service", "worker", ["example.base-service"]),
      makeContribution("example.base", "example.base-service", "base"),
    ];
    const instances = [
      makeInstance("worker-local", "example.worker-service", "worker"),
      makeInstance("base-local", "example.base-service", "base"),
    ];
    const handles = new Map([
      ["base-local", makeHandle("base-local", calls)],
      ["worker-local", makeHandle("worker-local", calls)],
    ]);
    const eventBus = new TypedEventBus();
    const completed = vi.fn();
    eventBus.on("capability_service:activation_completed", completed);
    const runtime = createCapabilityServiceRuntime({
      activators: [
        makeActivator("example.base-service", handles, calls),
        makeActivator("example.worker-service", handles, calls),
      ],
      eventBus,
      logger: makeLogger(),
      nowMs: () => 1_800_000_000_000,
    });

    const result = await runtime.replace(makePlan(contributions, instances));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toEqual([
      "construct:base-local",
      "construct:worker-local",
      "start:base-local",
      "start:worker-local",
    ]);
    expect(result.value).toBe(runtime.getActiveView());
    expect(result.value.instances.map((instance) => instance.state)).toEqual(["active", "active"]);
    expect(result.value.viewHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.instances)).toBe(true);
    expect(Object.isFrozen(result.value.instances[0]?.activeScopes)).toBe(true);
    expect(result.value.definitions[0]?.managedToolBindings).toEqual([{
      toolName: "prepare_work",
      behavior: "prepare_run",
      actionClassification: "mutate",
      invocationSideEffects: ["deferred_work"],
    }]);
    expect(Object.isFrozen(result.value.definitions[0]?.managedToolBindings)).toBe(true);
    expect(Object.isFrozen(
      result.value.definitions[0]?.managedToolBindings[0]?.invocationSideEffects,
    )).toBe(true);
    expect(JSON.stringify(result.value)).not.toContain("credentialRef");
    expect(JSON.stringify(result.value)).not.toContain("/tmp/");
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({
      revision: 1,
      activeCount: 2,
      failedCount: 0,
      durationMs: 0,
    }));
  });

  it("publishes a leaf start failure as health-visible state and closes its partial handle", async () => {
    const calls: string[] = [];
    const logger = makeLogger();
    const eventBus = new TypedEventBus();
    const failed = vi.fn();
    eventBus.on("capability_service:instance_failed", failed);
    const handles = new Map<string, CapabilityServiceRuntimeHandle>([
      ["base-local", makeHandle("base-local", calls)],
      ["worker-local", makeHandle("worker-local", calls, {
        start: async () => err(new Error("synthetic service unavailable")),
      })],
    ]);
    const runtime = createCapabilityServiceRuntime({
      activators: [
        makeActivator("example.base-service", handles, calls),
        makeActivator("example.worker-service", handles, calls),
      ],
      eventBus,
      logger,
      nowMs: () => 1_800_000_000_000,
    });
    const plan = makePlan([
      makeContribution("example.base", "example.base-service", "base"),
      makeContribution("example.worker", "example.worker-service", "worker"),
    ], [
      makeInstance("base-local", "example.base-service", "base"),
      makeInstance("worker-local", "example.worker-service", "worker"),
    ]);

    const result = await runtime.replace(plan);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instances).toEqual(expect.arrayContaining([
      expect.objectContaining({ serviceInstanceId: "base-local", state: "active" }),
      expect.objectContaining({
        serviceInstanceId: "worker-local",
        state: "failed",
        reasonCode: "start_failed",
      }),
    ]));
    expect(calls).toContain("close:worker-local");
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({
      serviceInstanceId: "worker-local",
      reasonCode: "start_failed",
    }));
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      errorKind: "dependency",
      hint: expect.any(String),
    }), "Capability-service instance failed to start");
  });

  it("keeps the published view unchanged when an activator is missing", async () => {
    const runtime = createCapabilityServiceRuntime({
      activators: [],
      eventBus: new TypedEventBus(),
      logger: makeLogger(),
      nowMs: () => 1_800_000_000_000,
    });
    const original = runtime.getActiveView();
    const plan = makePlan(
      [makeContribution("example.base", "example.base-service", "base")],
      [makeInstance("base-local", "example.base-service", "base")],
    );

    const result = await runtime.replace(plan);

    expect(result).toMatchObject({ ok: false, error: { kind: "missing_activator" } });
    expect(runtime.getActiveView()).toBe(original);
  });

  it("rolls back constructed candidate handles in reverse order when construction fails", async () => {
    const calls: string[] = [];
    const handles = new Map<string, CapabilityServiceRuntimeHandle>([
      ["base-local", makeHandle("base-local", calls, {
        close: async () => {
          calls.push("close:base-local");
          return err(new Error("synthetic cleanup failure"));
        },
      })],
    ]);
    const eventBus = new TypedEventBus();
    const activationFailed = vi.fn();
    eventBus.on("capability_service:activation_failed", activationFailed);
    const runtime = createCapabilityServiceRuntime({
      activators: [
        makeActivator("example.base-service", handles, calls),
        makeActivator("example.worker-service", handles, calls),
      ],
      eventBus,
      logger: makeLogger(),
      nowMs: () => 1_800_000_000_000,
    });
    const original = runtime.getActiveView();
    const plan = makePlan([
      makeContribution("example.base", "example.base-service", "base"),
      makeContribution("example.worker", "example.worker-service", "worker"),
    ], [
      makeInstance("base-local", "example.base-service", "base"),
      makeInstance("worker-local", "example.worker-service", "worker"),
    ]);

    const result = await runtime.replace(plan);

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "construction_failed",
        serviceInstanceId: "worker-local",
        cleanupFailures: [{ serviceInstanceId: "base-local" }],
      },
    });
    expect(calls).toEqual([
      "construct:base-local",
      "construct:worker-local",
      "close:base-local",
    ]);
    expect(runtime.getActiveView()).toBe(original);
    expect(activationFailed).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: "construction_failed",
      cleanupFailureCount: 1,
    }));
  });

  it("turns a mismatched health handshake into a closed failed-instance reason", async () => {
    const calls: string[] = [];
    const handle = makeHandle("base-local", calls, {
      start: async () => ok({
        protocolId: CAPABILITY_SERVICE_CONTROL_PROTOCOL,
        serviceInstanceId: "forged-instance",
        activeScopes: ["health", "report"],
      }),
    });
    const runtime = createCapabilityServiceRuntime({
      activators: [makeActivator("example.base-service", new Map([["base-local", handle]]), calls)],
      eventBus: new TypedEventBus(),
      logger: makeLogger(),
      nowMs: () => 1_800_000_000_000,
    });

    const result = await runtime.replace(makePlan(
      [makeContribution("example.base", "example.base-service", "base")],
      [makeInstance("base-local", "example.base-service", "base")],
    ));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.instances[0]).toMatchObject({
      state: "failed",
      reasonCode: "health_mismatch",
    });
    expect(calls).toContain("close:base-local");
  });

  it("publishes the candidate before retiring prior handles in reverse order", async () => {
    const calls: string[] = [];
    let runtime: ReturnType<typeof createCapabilityServiceRuntime>;
    const firstHandles = new Map<string, CapabilityServiceRuntimeHandle>();
    for (const id of ["base-a", "base-z"]) {
      firstHandles.set(id, makeHandle(id, calls, {
        close: async () => {
          calls.push(`close:${id}:revision-${runtime.getActiveView().revision}`);
          return ok(undefined);
        },
      }));
    }
    const secondHandle = makeHandle("base-new", calls);
    const handles = new Map([...firstHandles, ["base-new", secondHandle]]);
    runtime = createCapabilityServiceRuntime({
      activators: [makeActivator("example.base-service", handles, calls)],
      eventBus: new TypedEventBus(),
      logger: makeLogger(),
      nowMs: () => 1_800_000_000_000,
    });
    const contribution = makeContribution("example.base", "example.base-service", "base");
    await runtime.replace(makePlan([contribution], [
      makeInstance("base-a", "example.base-service", "base"),
      makeInstance("base-z", "example.base-service", "base"),
    ]));
    calls.length = 0;

    const result = await runtime.replace(makePlan(
      [contribution],
      [makeInstance("base-new", "example.base-service", "base")],
    ));

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "construct:base-new",
      "start:base-new",
      "close:base-z:revision-2",
      "close:base-a:revision-2",
    ]);
  });

  it("shuts down active handles in reverse activation order and publishes the empty view", async () => {
    const calls: string[] = [];
    const handles = new Map([
      ["base-a", makeHandle("base-a", calls)],
      ["base-z", makeHandle("base-z", calls)],
    ]);
    const runtime = createCapabilityServiceRuntime({
      activators: [makeActivator("example.base-service", handles, calls)],
      eventBus: new TypedEventBus(),
      logger: makeLogger(),
      nowMs: () => 1_800_000_000_000,
    });
    const contribution = makeContribution("example.base", "example.base-service", "base");
    await runtime.replace(makePlan([contribution], [
      makeInstance("base-a", "example.base-service", "base"),
      makeInstance("base-z", "example.base-service", "base"),
    ]));
    calls.length = 0;

    const result = await runtime.shutdown();

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["close:base-z", "close:base-a"]);
    expect(runtime.getActiveView()).toMatchObject({ revision: 2, definitions: [], instances: [] });
  });
});
