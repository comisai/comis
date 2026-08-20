// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import type { ClockPort, ComisLogger } from "@comis/core";
import { ok } from "@comis/shared";
import { forwardGroupAbandon, forwardGroupActivate } from "./capability-service-group-control.js";

function makeLogger(): ComisLogger {
  return {
    level: "debug",
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
    error: vi.fn(), fatal: vi.fn(), audit: vi.fn(),
    child: vi.fn(function child() { return this; }),
  } as unknown as ComisLogger;
}

const clock = { now: vi.fn(() => 1_800_000_000_000) } as unknown as ClockPort;

describe("capability-service group control forwarding", () => {
  it("forwards one group activation and records its completion", async () => {
    const activateGroup = vi.fn(async (command) => ok({
      managedRunGroupId: command.managedRunGroupId,
      members: [{ managedRunId: "managed-run_a", outcome: "completed" as const }],
      activatedAtMs: 1_800_000_000_000,
    }));
    const logger = makeLogger();

    const result = await forwardGroupActivate({
      command: {
        operationId: "operation_a",
        serviceInstanceId: "service-instance_a",
        managedRunGroupId: "managed-run-group_a",
        registrationNonce: "group-registration-nonce_a",
        members: [{
          managedRunId: "managed-run_a",
          externalRunRef: "external-run_a",
          registrationNonce: "member-registration-nonce_a",
        }],
      },
      endpoint: { activateGroup, abandonGroup: vi.fn() },
      clock,
      logger,
      onFailure: vi.fn(),
    });

    expect(result.ok).toBe(true);
    expect(activateGroup).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      managedRunGroupId: "managed-run-group_a",
      memberCount: 1,
      durationMs: 0,
    }), "Capability-service group activation call completed");
  });

  it("fails closed when a group abandon has no connected endpoint", async () => {
    const result = await forwardGroupAbandon({
      command: {
        operationId: "operation_a",
        serviceInstanceId: "service-instance_a",
        managedRunGroupId: "managed-run-group_a",
        registrationNonce: "group-registration-nonce_a",
        members: [{
          managedRunId: "managed-run_a",
          externalRunRef: "external-run_a",
          registrationNonce: "member-registration-nonce_a",
        }],
        reason: "activation_rejected",
        disposition: "reap_safe",
      },
      endpoint: undefined,
      clock,
      logger: makeLogger(),
      onFailure: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      error: { kind: "unavailable", reasonCode: "instance_not_connected" },
    });
  });
});
