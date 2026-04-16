import { vi } from "vitest";
import type { RpcClient } from "../api/rpc-client.js";

/**
 * Minimal RpcClient mock for web view and state tests.
 * call() resolves to empty object by default.
 * Tests customize via mockResolvedValue or callImpl.
 */
export function createMockRpcClient(
  callImpl?: (...args: unknown[]) => unknown,
  overrides?: Partial<RpcClient>,
): RpcClient {
  return {
    call: callImpl ? vi.fn(callImpl) : vi.fn().mockResolvedValue({}),
    connect: vi.fn(),
    disconnect: vi.fn(),
    onStatusChange: vi.fn(() => () => {}),
    onNotification: vi.fn(() => () => {}),
    get status() {
      return "connected" as const;
    },
    ...overrides,
  } as RpcClient;
}
