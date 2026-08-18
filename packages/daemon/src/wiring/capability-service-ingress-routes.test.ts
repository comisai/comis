// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { CapabilityReportRequestSchema } from "@comis/capability-service-sdk";
import type { ComisLogger } from "@comis/core";
import { ok } from "@comis/shared";
import { createFakeTimers } from "../../../../test/support/fake-timers.js";
import { createFakeClock } from "../../../../test/support/fake-clock.js";
import {
  routeManagedRunReportIngress,
  type CapabilityServiceIngressRouteDeps,
} from "./capability-service-ingress-routes.js";
import type { ManagedRunReportIngressOutcome } from "./managed-run-report-bridge.js";

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

function makeReportRequest(): z.infer<typeof CapabilityReportRequestSchema> {
  return {
    params: {
      managedRunId: "managed-run_a",
      serviceReportId: "service-report_a",
      kind: "progress",
      summary: "progress",
    },
  } as z.infer<typeof CapabilityReportRequestSchema>;
}

function makeDeps(outcome: ManagedRunReportIngressOutcome): CapabilityServiceIngressRouteDeps {
  return {
    reportBridge: { ingestReport: async () => ok(outcome) },
    evidenceBridge: {} as never,
    attentionResponseBridge: {} as never,
    livenessBridge: {} as never,
    releaseCoordinator: {} as never,
    requestDeadlineMs: 5_000,
    clock: createFakeClock(1_800_000_000_000),
    timers: createFakeTimers(0),
    logger: makeLogger(),
  };
}

describe("capability-service report ingress error mapping", () => {
  it("maps a rate-limited rejection to the retryable rate_limited wire error", async () => {
    const result = await routeManagedRunReportIngress(
      "service-instance_a",
      makeReportRequest(),
      makeDeps({ kind: "rejected", reasonCode: "rate_limited" }),
    );
    await result.settlement;
    expect(result.response).toBeUndefined();
    expect(result.errorKind).toBe("rate_limited");
  });

  it("maps an invalid report to invalid_params and a state mismatch to precondition_failed", async () => {
    const invalid = await routeManagedRunReportIngress(
      "service-instance_a",
      makeReportRequest(),
      makeDeps({ kind: "rejected", reasonCode: "invalid_report" }),
    );
    await invalid.settlement;
    expect(invalid.errorKind).toBe("invalid_params");

    const stateMismatch = await routeManagedRunReportIngress(
      "service-instance_a",
      makeReportRequest(),
      makeDeps({ kind: "rejected", reasonCode: "state_mismatch" }),
    );
    await stateMismatch.settlement;
    expect(stateMismatch.errorKind).toBe("precondition_failed");
  });
});
