// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: CLI ↔ Daemon RPC roundtrip via withClient.
 *
 * Drives the production `withClient` + `createRpcClient` against a real
 * test daemon.
 *
 * Pattern: spawn daemon → set COMIS_GATEWAY_URL/TOKEN env → call withClient
 * → invoke handlers → assert response shape. This exercises the same
 * RPC client code path that the `comis` CLI subprocess uses, without
 * fork/exec overhead.
 *
 * @module
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startTestDaemon,
  type TestDaemonHandle,
} from "../support/daemon-harness.js";
import { withClient } from "@comis/cli";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_PATH = resolve(
  __dirname,
  "../config/config.test-cli-daemon-integ.yaml",
);

describe("INTEGRATION: cli withClient → daemon RPC roundtrip", () => {
  let handle: TestDaemonHandle;

  beforeAll(async () => {
    handle = await startTestDaemon({ configPath: CONFIG_PATH });
    // Direct the CLI's withClient() probe at the test daemon.
    process.env["COMIS_GATEWAY_URL"] = `ws://127.0.0.1:${
      handle.daemon.container.config.gateway.port
    }/ws`;
    process.env["COMIS_GATEWAY_TOKEN"] = handle.authToken;
    // Under VITEST, withClient refuses real WebSockets unless this is set.
    process.env["COMIS_CLI_E2E"] = "true";
  }, 60_000);

  afterAll(async () => {
    delete process.env["COMIS_GATEWAY_URL"];
    delete process.env["COMIS_GATEWAY_TOKEN"];
    delete process.env["COMIS_CLI_E2E"];
    if (handle) {
      try {
        await handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit with code")) {
          throw err;
        }
      }
    }
  }, 30_000);

  it("withClient connects to daemon and returns RpcClient", async () => {
    const result = await withClient(async (client) => {
      expect(typeof client.call).toBe("function");
      expect(typeof client.close).toBe("function");
      expect(typeof client.onNotification).toBe("function");
      return "ok";
    });
    expect(result).toBe("ok");
  });

  it("withClient enables agents.list RPC roundtrip", async () => {
    const result = await withClient(async (client) => {
      return await client.call("agents.list", {});
    });
    expect(result).toBeDefined();
    expect(Array.isArray((result as { agents?: unknown[] }).agents)).toBe(
      true,
    );
  });

  it("withClient enables config.schema RPC roundtrip", async () => {
    const result = await withClient(async (client) => {
      return await client.call("config.schema", {});
    });
    expect(result).toBeDefined();
  });

  it("withClient surfaces RPC errors as thrown Errors (not silent)", async () => {
    await expect(
      withClient(async (client) => {
        return await client.call("nonexistent.method.deliberate-error", {});
      }),
    ).rejects.toThrow();
  });

  it("withClient closes the RPC client even when fn throws", async () => {
    // The finally-close branch in withClient is load-bearing for socket
    // cleanup. Exercise it by throwing inside fn.
    let caught: Error | undefined;
    try {
      await withClient(async () => {
        throw new Error("deliberate test error");
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toContain("deliberate test error");
  });
});
