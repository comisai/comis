// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { err, ok } from "@comis/shared";
import type { CapabilityServiceControlPort } from "@comis/core";

import { createManagedTerminalEventBridge } from "./capability-service-terminal-event.js";

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), audit: vi.fn(), child: vi.fn() };
}

describe("managed terminal event bridge", () => {
  it("sends only identifiers and the closed transition to the owning service instance", async () => {
    const terminalEvent = vi.fn(async (command) => ok({
      managedRunId: command.managedRunId,
      terminalSessionId: command.terminalSessionId,
      transition: command.transition,
    }));
    const control = { terminalEvent } as unknown as CapabilityServiceControlPort;
    const bridge = createManagedTerminalEventBridge({
      control,
      store: { releaseTerminal: vi.fn() } as never,
      logger: logger() as never,
      nowMs: () => 1700,
    });

    await bridge.publish({
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      serviceInstanceId: "service-instance_a",
      terminalSessionId: "terminal-session_a",
      transition: "input_needed",
    });

    expect(terminalEvent).toHaveBeenCalledWith({
      operationId: expect.stringMatching(/^operation-terminal-[a-f0-9]{32}$/u),
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      serviceInstanceId: "service-instance_a",
      terminalSessionId: "terminal-session_a",
      transition: "input_needed",
    });
    expect(Object.keys(terminalEvent.mock.calls[0]![0]).sort()).toEqual([
      "managedRunId", "operationId", "serviceInstanceId", "terminalSessionId", "transition", "workspaceLeaseId",
    ]);
  });

  it("durably retires exact exited and released terminal bindings only after service acknowledgement", async () => {
    const terminalEvent = vi.fn(async (command) => ok({
      managedRunId: command.managedRunId,
      terminalSessionId: command.terminalSessionId,
      transition: command.transition,
    }));
    const releaseTerminal = vi.fn(async () => ok({ kind: "released" as const }));
    const bridge = createManagedTerminalEventBridge({
      control: { terminalEvent } as unknown as CapabilityServiceControlPort,
      store: { releaseTerminal },
      logger: logger() as never,
      nowMs: () => 1700,
    });

    for (const transition of ["exited", "released"] as const) {
      await bridge.publish({
        managedRunId: "managed-run_a",
        workspaceLeaseId: "workspace-lease_a",
        serviceInstanceId: "service-instance_a",
        terminalSessionId: "terminal-session_a",
        transition,
      });
    }

    expect(releaseTerminal).toHaveBeenCalledTimes(2);
    expect(releaseTerminal).toHaveBeenNthCalledWith(
      1,
      { kind: "service", serviceInstanceId: "service-instance_a" },
      {
        managedRunId: "managed-run_a",
        workspaceLeaseId: "workspace-lease_a",
        terminalSessionId: "terminal-session_a",
        releasedAtMs: 1700,
      },
    );
  });

  it("records durable retirement even when the service endpoint is unavailable", async () => {
    const terminalEvent = vi.fn(async () => err({ kind: "unavailable" as const, reasonCode: "instance_not_connected" }));
    const releaseTerminal = vi.fn(async () => ok({ kind: "released" as const }));
    const log = logger();
    const bridge = createManagedTerminalEventBridge({
      control: { terminalEvent } as unknown as CapabilityServiceControlPort,
      store: { releaseTerminal } as never,
      logger: log as never,
      nowMs: () => 1700,
    });

    await expect(bridge.publish({
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      serviceInstanceId: "service-instance_a",
      terminalSessionId: "terminal-session_a",
      transition: "released",
    })).resolves.toBeUndefined();
    expect(terminalEvent).toHaveBeenCalledOnce();
    expect(releaseTerminal).toHaveBeenCalledWith(
      { kind: "service", serviceInstanceId: "service-instance_a" },
      {
        managedRunId: "managed-run_a",
        workspaceLeaseId: "workspace-lease_a",
        terminalSessionId: "terminal-session_a",
        releasedAtMs: 1700,
      },
    );
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
      errorKind: "dependency",
      hint: expect.stringContaining("capabilityServices"),
    }), expect.any(String));
    expect(Object.keys(bridge).sort()).toEqual(["publish", "retire"]);
  });

  it("returns a failed retirement barrier when the local store is unavailable", async () => {
    const terminalEvent = vi.fn(async (command) => ok({
      managedRunId: command.managedRunId,
      terminalSessionId: command.terminalSessionId,
      transition: command.transition,
    }));
    const bridge = createManagedTerminalEventBridge({
      control: { terminalEvent } as unknown as CapabilityServiceControlPort,
      store: { releaseTerminal: vi.fn(async () => err(new Error("store unavailable"))) },
      logger: logger() as never,
      nowMs: () => 1700,
    });

    const result = await bridge.retire?.({
      managedRunId: "managed-run_a",
      workspaceLeaseId: "workspace-lease_a",
      serviceInstanceId: "service-instance_a",
      terminalSessionId: "terminal-session_a",
      transition: "released",
    });

    expect(result).toEqual(err(new Error("store unavailable")));
    expect(terminalEvent).toHaveBeenCalledOnce();
  });
});
