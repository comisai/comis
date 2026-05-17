// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import type { ReactiveControllerHost } from "lit";
import { createMockRpcClient } from "../test-support/mock-rpc-client.js";
import { createObserveViewController } from "./observe-view-controller.js";

function makeHost(): ReactiveControllerHost & { _updates: number } {
  return {
    _updates: 0,
    addController: vi.fn(),
    removeController: vi.fn(),
    requestUpdate(): void {
      (this as { _updates: number })._updates += 1;
    },
    updateComplete: Promise.resolve(true),
  } as unknown as ReactiveControllerHost & { _updates: number };
}

describe("ObserveViewController", () => {
  it("resetObservability: invokes obs.reset RPC", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createObserveViewController(host, rpc);
    await controller.resetObservability();
    expect(seen.length).toBe(1);
    expect((seen[0] as unknown[])[0]).toBe("obs.reset");
  });

  it("resetObservability: forwards no payload (obs.reset takes no params)", async () => {
    const host = makeHost();
    const seen: unknown[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      seen.push(args);
      return {};
    });
    const controller = createObserveViewController(host, rpc);
    await controller.resetObservability();
    expect((seen[0] as unknown[]).length).toBe(1);
  });

  it("resetObservability: RPC error propagates to caller (fail-closed)", async () => {
    const host = makeHost();
    const rpc = createMockRpcClient(async () => {
      throw new Error("daemon unreachable");
    });
    const controller = createObserveViewController(host, rpc);
    await expect(controller.resetObservability()).rejects.toThrow(
      "daemon unreachable",
    );
  });

  it("hostConnected / hostDisconnected: are no-ops (view drives lifecycle)", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    const controller = createObserveViewController(host, rpc);
    expect(() => controller.hostConnected()).not.toThrow();
    expect(() => controller.hostDisconnected()).not.toThrow();
  });

  it("addController: registers on host at construction time", () => {
    const host = makeHost();
    const rpc = createMockRpcClient();
    createObserveViewController(host, rpc);
    expect(host.addController).toHaveBeenCalledTimes(1);
  });

  it("multiple resetObservability calls each issue a fresh obs.reset RPC", async () => {
    const host = makeHost();
    const calls: string[] = [];
    const rpc = createMockRpcClient(async (...args: unknown[]) => {
      calls.push(args[0] as string);
      return {};
    });
    const controller = createObserveViewController(host, rpc);
    await controller.resetObservability();
    await controller.resetObservability();
    await controller.resetObservability();
    expect(calls).toEqual(["obs.reset", "obs.reset", "obs.reset"]);
  });
});
