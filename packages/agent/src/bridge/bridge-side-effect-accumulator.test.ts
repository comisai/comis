// SPDX-License-Identifier: Apache-2.0
import { beforeAll, describe, expect, it } from "vitest";
import { registerToolMetadata } from "@comis/core";
import {
  createBridgeSideEffectSummary,
  recordToolInvocationSideEffects,
} from "./bridge-side-effect-accumulator.js";

beforeAll(() => {
  registerToolMetadata("test_effect_outbound", {
    invocationSideEffects: { kind: "always", capabilities: ["outbound_delivery"] },
  });
  registerToolMetadata("test_effect_deferred", {
    invocationSideEffects: { kind: "always", capabilities: ["deferred_work"] },
  });
  registerToolMetadata("test_effect_none", {
    invocationSideEffects: { kind: "always", capabilities: [] },
  });
  registerToolMetadata("test_effect_by_action", {
    invocationSideEffects: {
      kind: "by_action",
      parameter: "action",
      actions: {
        add: ["scheduling"],
        send: ["outbound_delivery"],
        list: [],
      },
    },
  });
});

describe("bridge side-effect accumulation", () => {
  it("creates an all-false execution summary", () => {
    expect(createBridgeSideEffectSummary()).toEqual({
      schedulingCapabilityInvoked: false,
      outboundDeliveryCapabilityInvoked: false,
      deferredWorkCapabilityInvoked: false,
      unclassifiedInvocationObserved: false,
    });
  });

  it("records exact always and reviewed empty declarations", () => {
    const summary = createBridgeSideEffectSummary();
    recordToolInvocationSideEffects(summary, "test_effect_outbound", {});
    recordToolInvocationSideEffects(summary, "test_effect_none", { anything: true });

    expect(summary).toEqual({
      schedulingCapabilityInvoked: false,
      outboundDeliveryCapabilityInvoked: true,
      deferredWorkCapabilityInvoked: false,
      unclassifiedInvocationObserved: false,
    });
  });

  it("marks an unregistered emitted tool name as unclassified", () => {
    const summary = createBridgeSideEffectSummary();
    recordToolInvocationSideEffects(summary, "mcp__example--dynamic", { query: "weather" });

    expect(summary.unclassifiedInvocationObserved).toBe(true);
    expect(summary.schedulingCapabilityInvoked).toBe(false);
    expect(summary.outboundDeliveryCapabilityInvoked).toBe(false);
    expect(summary.deferredWorkCapabilityInvoked).toBe(false);
  });

  it("uses the exact action or the conservative declared union", () => {
    const exact = createBridgeSideEffectSummary();
    recordToolInvocationSideEffects(exact, "test_effect_by_action", { action: "list" });
    expect(exact).toEqual(createBridgeSideEffectSummary());

    for (const args of [{}, { action: 7 }, { action: "unknown" }]) {
      const conservative = createBridgeSideEffectSummary();
      recordToolInvocationSideEffects(conservative, "test_effect_by_action", args);
      expect(conservative).toMatchObject({
        schedulingCapabilityInvoked: true,
        outboundDeliveryCapabilityInvoked: true,
        deferredWorkCapabilityInvoked: false,
        unclassifiedInvocationObserved: false,
      });
    }
  });

  it("only ORs facts across repeated and mixed invocations", () => {
    const summary = createBridgeSideEffectSummary();
    recordToolInvocationSideEffects(summary, "test_effect_outbound", {});
    recordToolInvocationSideEffects(summary, "test_effect_deferred", {});
    recordToolInvocationSideEffects(summary, "test_effect_none", {});
    recordToolInvocationSideEffects(summary, "mcp__example--unknown", {});

    expect(summary).toEqual({
      schedulingCapabilityInvoked: false,
      outboundDeliveryCapabilityInvoked: true,
      deferredWorkCapabilityInvoked: true,
      unclassifiedInvocationObserved: true,
    });
  });
});
