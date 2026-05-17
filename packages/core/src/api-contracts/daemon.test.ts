// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract test for the daemon-domain contracts.
 *
 * NOTE: `packages/daemon/src/api/daemon-handlers.ts` currently exposes 2
 * methods — `system.ping` and `daemon.setLogLevel`. Other methods such as
 * `gateway.status`, `gateway.restart`, and `obs.diagnostics` live in
 * different handler factory files (`config-handlers.ts`,
 * `obs-handlers.ts`). The invariant is one contract file per handler
 * factory file.
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

  it("declares the expected scopes on each contract", () => {
    expect(SystemPingContract.scopes).toEqual(["rpc"]);
    expect(DaemonSetLogLevelContract.scopes).toEqual(["admin"]);
  });
});
