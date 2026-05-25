// SPDX-License-Identifier: Apache-2.0
/**
 * Admin leaf tests for trust-level derivation, `/config` chat command trust
 * gates, the redacted execution-request log-field builder, and the
 * destroySession source guard (the gateway adapter's session:expired emission
 * with "gateway-reset" reason).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildExecutionRequestedLogFields,
  deriveTrustLevel,
  handleConfigChatCommand,
} from "./setup-gateway-admin.js";

describe("deriveTrustLevel", () => {
  it('returns "admin" for admin scope', () => {
    expect(deriveTrustLevel(["rpc", "admin"])).toBe("admin");
  });

  it('returns "admin" for wildcard scope', () => {
    expect(deriveTrustLevel(["*"])).toBe("admin");
  });

  it('returns "admin" when admin is the only scope', () => {
    expect(deriveTrustLevel(["admin"])).toBe("admin");
  });

  it('returns "user" for non-admin scopes (fail-closed)', () => {
    expect(deriveTrustLevel(["rpc", "ws"])).toBe("user");
  });

  it('returns "user" for empty scopes', () => {
    expect(deriveTrustLevel([])).toBe("user");
  });

  it('returns "user" for undefined scopes', () => {
    expect(deriveTrustLevel(undefined)).toBe("user");
  });
});

describe("handleConfigChatCommand scope enforcement", () => {
  it("rejects /config show with non-admin scopes", async () => {
    const rpcCall = vi.fn();
    const result = await handleConfigChatCommand(["show"], rpcCall, ["rpc"]);
    expect(result.handled).toBe(true);
    expect(result.response).toContain("admin trust");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("rejects /config show with empty scopes", async () => {
    const rpcCall = vi.fn();
    const result = await handleConfigChatCommand(["show"], rpcCall, []);
    expect(result.handled).toBe(true);
    expect(result.response).toContain("admin trust");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("rejects /config show with undefined scopes", async () => {
    const rpcCall = vi.fn();
    const result = await handleConfigChatCommand(["show"], rpcCall, undefined);
    expect(result.handled).toBe(true);
    expect(result.response).toContain("admin trust");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("rejects /config history with non-admin scopes", async () => {
    const rpcCall = vi.fn();
    const result = await handleConfigChatCommand(["history"], rpcCall, ["rpc"]);
    expect(result.handled).toBe(true);
    expect(result.response).toContain("admin trust");
    expect(rpcCall).not.toHaveBeenCalled();
  });

  it("allows /config show with admin scope", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ config: {}, sections: [] });
    const result = await handleConfigChatCommand(["show"], rpcCall, ["admin"]);
    expect(result.handled).toBe(true);
    expect(rpcCall).toHaveBeenCalledWith("config.read", { section: undefined });
  });

  it("allows /config show with wildcard scope", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ config: {}, sections: [] });
    const result = await handleConfigChatCommand(["show"], rpcCall, ["*"]);
    expect(result.handled).toBe(true);
    expect(rpcCall).toHaveBeenCalled();
  });

  it("allows /config history with admin scope", async () => {
    const rpcCall = vi.fn().mockResolvedValue({ entries: [] });
    const result = await handleConfigChatCommand(["history"], rpcCall, ["admin"]);
    expect(result.handled).toBe(true);
    expect(rpcCall).toHaveBeenCalledWith("config.history", { limit: 5 });
  });

  it("does not gate /config set (has its own check)", async () => {
    const rpcCall = vi.fn();
    const result = await handleConfigChatCommand(["set"], rpcCall, ["rpc"]);
    expect(result.handled).toBe(true);
    // set with rpc scope should hit the existing set trust gate, NOT the new show/history gate
    expect(result.response).toContain("admin trust");
  });
});

describe("buildExecutionRequestedLogFields", () => {
  it("returns only agentId + messageLen on empty message", () => {
    const fields = buildExecutionRequestedLogFields({
      agentId: "agent-a",
      message: "",
      connectionId: undefined,
    });
    expect(fields).toEqual({ agentId: "agent-a", messageLen: 0 });
    expect(Object.hasOwn(fields, "messageHash")).toBe(false);
    expect(Object.hasOwn(fields, "connectionId")).toBe(false);
    expect(Object.hasOwn(fields, "message")).toBe(false);
  });

  it("treats undefined message as empty", () => {
    const fields = buildExecutionRequestedLogFields({
      agentId: "agent-a",
      message: undefined,
      connectionId: undefined,
    });
    expect(fields).toEqual({ agentId: "agent-a", messageLen: 0 });
    expect(Object.hasOwn(fields, "messageHash")).toBe(false);
  });

  it("emits 12-char hex hash for non-empty messages, deterministic per content", () => {
    const fields1 = buildExecutionRequestedLogFields({
      agentId: "agent-a",
      message: "hello world",
      connectionId: undefined,
    });
    const fields2 = buildExecutionRequestedLogFields({
      agentId: "agent-a",
      message: "hello world",
      connectionId: undefined,
    });
    expect(fields1.messageLen).toBe("hello world".length);
    expect(fields1.messageHash).toMatch(/^[0-9a-f]{12}$/);
    expect(fields1.messageHash).toBe(fields2.messageHash); // deterministic
  });

  it("never echoes secret content from the message body", () => {
    const message =
      "My password is hunter2-secret-x and my API key is sk-very-fake-FAKE-99887. Please ignore them.";
    const fields = buildExecutionRequestedLogFields({
      agentId: "agent-a",
      message,
      connectionId: undefined,
    });
    const serialized = JSON.stringify(fields);
    expect(serialized).not.toContain("hunter2-secret-x");
    expect(serialized).not.toContain("sk-very-fake-FAKE-99887");
    expect(Object.hasOwn(fields, "message")).toBe(false);
    expect(fields.messageLen).toBe(message.length);
    expect(fields.messageHash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("includes connectionId when provided, omits the key when undefined", () => {
    const withConn = buildExecutionRequestedLogFields({
      agentId: "agent-a",
      message: "x",
      connectionId: "conn-42",
    });
    expect(withConn.connectionId).toBe("conn-42");

    const withoutConn = buildExecutionRequestedLogFields({
      agentId: "agent-a",
      message: "x",
      connectionId: undefined,
    });
    expect(Object.hasOwn(withoutConn, "connectionId")).toBe(false);
  });
});

describe("buildSlashCommandDeps destroySession emits session:expired", () => {
  it("source contains session:expired emission with gateway-reset reason", async () => {
    // The gateway destroySession callback is deeply nested inside the
    // setupGateway-built CommandHandlerDeps adapter; it lives in
    // setup-gateway-admin.ts (buildSlashCommandDeps). This structural test
    // verifies the source contains the expected emission so regressions
    // surface without a full gateway-server harness.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./setup-gateway-admin.ts", import.meta.url).pathname,
      "utf-8",
    );
    expect(source).toContain('container.eventBus.emit("session:expired"');
    expect(source).toContain('"gateway-reset"');
  });
});
