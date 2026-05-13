// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract test for the daemon-domain Wave C contracts.
 *
 * NOTE: The plan's <interfaces> block enumerated 5 methods but
 * `packages/daemon/src/api/daemon-handlers.ts` currently only exposes 2
 * methods — `system.ping` and `daemon.setLogLevel`. The other 3 methods
 * the plan cited (`gateway.status`, `gateway.restart`, `obs.diagnostics`)
 * live in different handler factory files (`config-handlers.ts`,
 * `obs-handlers.ts`) which are out of scope for plan 35-06's
 * `files_modified` list. Per D-08 (one contract file per handler factory
 * file), those methods will land in their own Wave C plans (35-07+).
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import {
  DaemonSetLogLevelContract,
  SystemPingContract,
  DAEMON_CONTRACTS,
} from "./daemon.js";

describe("daemon-domain contracts", () => {
  it("DAEMON_CONTRACTS has exactly 2 entries (the 2 methods in daemon-handlers.ts)", () => {
    expect(DAEMON_CONTRACTS.length).toBe(2);
  });

  it("daemon.setLogLevel: method name is correct", () => {
    expect(DaemonSetLogLevelContract.method).toBe("daemon.setLogLevel");
  });

  it("system.ping: method name is correct", () => {
    expect(SystemPingContract.method).toBe("system.ping");
  });

  it("daemon.setLogLevel: accepts valid level + rejects invalid", () => {
    expect(() =>
      DaemonSetLogLevelContract.request.parse({ level: "debug" }),
    ).not.toThrow();
    expect(() =>
      DaemonSetLogLevelContract.request.parse({ level: "xyz" }),
    ).toThrow();
  });

  it("daemon.setLogLevel: accepts optional module", () => {
    expect(() =>
      DaemonSetLogLevelContract.request.parse({ level: "info", module: "agent" }),
    ).not.toThrow();
  });

  it("daemon.setLogLevel: rejects 'silent' level (intentionally excluded — see handler)", () => {
    expect(() =>
      DaemonSetLogLevelContract.request.parse({ level: "silent" }),
    ).toThrow();
  });

  it("daemon.setLogLevel: response shape global scope variant", () => {
    expect(() =>
      DaemonSetLogLevelContract.response.parse({
        updated: true,
        level: "info",
        scope: "global",
        persistent: false,
      }),
    ).not.toThrow();
  });

  it("daemon.setLogLevel: response shape per-module scope variant", () => {
    expect(() =>
      DaemonSetLogLevelContract.response.parse({
        updated: true,
        module: "agent",
        level: "info",
        scope: "module",
        persistent: false,
      }),
    ).not.toThrow();
  });

  it("system.ping: response shape requires { pong: true, ts: number }", () => {
    expect(() =>
      SystemPingContract.response.parse({ pong: true, ts: 123 }),
    ).not.toThrow();
    // pong: false is rejected (z.literal(true))
    expect(() =>
      SystemPingContract.response.parse({ pong: false, ts: 0 }),
    ).toThrow();
  });

  it("system.ping: empty request object is valid", () => {
    expect(() => SystemPingContract.request.parse({})).not.toThrow();
  });

  it("scopes are correct", () => {
    expect(SystemPingContract.scopes).toEqual(["rpc"]);
    expect(DaemonSetLogLevelContract.scopes).toEqual(["admin"]);
  });
});
