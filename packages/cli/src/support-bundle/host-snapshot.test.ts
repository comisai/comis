// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from "vitest";
import { collectHostSnapshot } from "./host-snapshot.js";
import { HostSnapshotSchema } from "./types.js";
import { readCliVersion } from "../util/cli-version.js";
import type { RpcClient } from "../client/rpc-client.js";

/**
 * The complete set of keys a content-free HostSnapshot may carry. Anything
 * outside this set — a hostname, an environment value, a git field — is a
 * host-enumeration leak the bundle must never introduce (T-3: omission beats
 * hashing).
 */
const ALLOWED_HOST_KEYS = new Set([
  "cliVersion",
  "daemonVersion",
  "nodeVersion",
  "platform",
  "arch",
]);

/** A stub that reports the daemon as down so the content-free path never probes. */
const daemonDown = { isDaemonRunning: async (): Promise<boolean> => false };

describe("collectHostSnapshot content-free fields", () => {
  it("reports cliVersion from the shared reader and node/platform/arch from process", async () => {
    const snapshot = await collectHostSnapshot(daemonDown);

    expect(snapshot.cliVersion).toBe(readCliVersion());
    expect(snapshot.nodeVersion).toBe(process.version);
    expect(snapshot.platform).toBe(process.platform);
    expect(snapshot.arch).toBe(process.arch);
  });

  it("carries only the allowed host keys — no hostname, environment, or git fields", async () => {
    const snapshot = await collectHostSnapshot(daemonDown);

    for (const key of Object.keys(snapshot)) {
      expect(ALLOWED_HOST_KEYS.has(key)).toBe(true);
    }
    expect("hostname" in snapshot).toBe(false);
    expect("env" in snapshot).toBe(false);
    expect("git" in snapshot).toBe(false);

    // strictObject rejects any unknown key, so a content-free snapshot
    // round-trips through the schema — a host-enumerating field would fail here.
    expect(HostSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
});

/** The shape of the injectable `withClient` hook. */
type WithClientStub = <T>(fn: (client: RpcClient) => Promise<T>) => Promise<T>;

/**
 * A valid `gateway.status` wire payload. The real `callTyped` parses the raw
 * value against `GatewayStatusContract.response`, so every required field must
 * be present; `version` is optional and overridable per test.
 */
function makeStatusResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 4321,
    uptime: 100,
    memoryUsage: 1_000_000,
    nodeVersion: "v22.0.0",
    configPaths: [],
    sections: [],
    secretsStoreAvailable: false,
    version: "1.2.3",
    ...overrides,
  };
}

/** A `withClient` stub whose one fake client returns the given raw status payload. */
function withClientReturning(status: unknown): WithClientStub {
  return <T>(fn: (client: RpcClient) => Promise<T>): Promise<T> => {
    const fakeClient = { call: async (): Promise<unknown> => status } as unknown as RpcClient;
    return fn(fakeClient);
  };
}

describe("collectHostSnapshot best-effort daemonVersion", () => {
  it("reports the gateway.status version when the daemon is up", async () => {
    const snapshot = await collectHostSnapshot({
      isDaemonRunning: async () => true,
      withClient: withClientReturning(makeStatusResponse({ version: "1.2.3" })),
    });

    expect(snapshot.daemonVersion).toBe("1.2.3");
  });

  it("omits daemonVersion and opens no client when the daemon is down", async () => {
    let probes = 0;
    const snapshot = await collectHostSnapshot({
      isDaemonRunning: async () => false,
      withClient: <T>(fn: (client: RpcClient) => Promise<T>): Promise<T> => {
        probes += 1;
        const fakeClient = {
          call: async (): Promise<unknown> => makeStatusResponse(),
        } as unknown as RpcClient;
        return fn(fakeClient);
      },
    });

    expect(snapshot.daemonVersion).toBeUndefined();
    expect(probes).toBe(0);
  });

  it("swallows an auth/transport rejection to an absent daemonVersion", async () => {
    const snapshot = await collectHostSnapshot({
      isDaemonRunning: async () => true,
      withClient: <T>(): Promise<T> =>
        Promise.reject(new Error("Gateway rejected the token (WS close 4001 Unauthorized)")),
    });

    expect(snapshot.daemonVersion).toBeUndefined();
  });

  it("omits daemonVersion when the daemon reports no version field", async () => {
    const noVersion = makeStatusResponse();
    delete noVersion.version;

    const snapshot = await collectHostSnapshot({
      isDaemonRunning: async () => true,
      withClient: withClientReturning(noVersion),
    });

    expect(snapshot.daemonVersion).toBeUndefined();
  });
});
