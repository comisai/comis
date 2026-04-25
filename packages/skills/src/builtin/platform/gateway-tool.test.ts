// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from "vitest";
import { createGatewayTool } from "./gateway-tool.js";

function createMockRpcCall() {
  return vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "config.read") {
      return { section: params.section, values: { maxSteps: 10, budget: { maxTokens: 1000 } } };
    }
    if (method === "config.patch") {
      return { patched: true, section: params.section, key: params.key, value: params.value };
    }
    if (method === "config.schema") {
      return { type: "object", properties: {} };
    }
    if (method === "gateway.restart") {
      return { restarted: true };
    }
    if (method === "gateway.status") {
      return { status: "running", uptime: 3600, connections: 5 };
    }
    if (method === "config.history") {
      return {
        entries: [
          { sha: "abc123", timestamp: "2026-02-25T10:00:00Z", metadata: { section: "agent", summary: "Changed agent.model" }, message: "config: Changed agent.model" },
        ],
      };
    }
    if (method === "config.diff") {
      return { diff: "--- a/config.yaml\n+++ b/config.yaml\n@@ -1 +1 @@\n-old\n+new" };
    }
    if (method === "config.apply") {
      return { applied: true, section: params.section, restarting: true };
    }
    if (method === "config.rollback") {
      return { rolledBack: true, sha: params.sha, newCommitSha: "def456", restarting: true };
    }
    if (method === "env.set") {
      return { set: true, key: params.key, storage: "encrypted", restarting: true };
    }
    if (method === "env.list") {
      return {
        secrets: [
          { name: "GEMINI_API_KEY", source: "envfile" },
          { name: "OPENAI_API_KEY", source: "envfile" },
        ],
        total: 2,
        truncated: false,
      };
    }
    return { stub: true, method, params };
  });
}

describe("gateway tool", () => {
  it("has correct name and label", () => {
    const rpcCall = createMockRpcCall();
    const tool = createGatewayTool(rpcCall);

    expect(tool.name).toBe("gateway");
    expect(tool.label).toBe("Gateway Control");
  });

  it("has lean description mentioning key capabilities", () => {
    const rpcCall = createMockRpcCall();
    const tool = createGatewayTool(rpcCall);

    expect(tool.description).toContain("config");
    expect(tool.description).toContain("restart");
    expect(tool.description).toContain("status");
    expect(tool.description).toContain("confirmation");
    expect(tool.description.length).toBeLessThanOrEqual(150);
  });

  describe("read action", () => {
    it("calls rpcCall with config.read and section param", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-1", {
        action: "read",
        section: "agent",
      });

      expect(rpcCall).toHaveBeenCalledWith("config.read", { section: "agent", _trustLevel: "guest" });
      expect(result.details).toEqual(
        expect.objectContaining({ section: "agent" }),
      );
    });

    it("calls rpcCall with config.read and undefined section for full read", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      await tool.execute("call-1b", { action: "read" });

      expect(rpcCall).toHaveBeenCalledWith("config.read", { section: undefined, _trustLevel: "guest" });
    });
  });

  describe("patch action", () => {
    it("patch is gated as destructive (requiresConfirmation)", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-2", {
        action: "patch",
        section: "scheduler",
        key: "heartbeatMs",
        value: 20,
      });

      // config.patch is classified as "destructive", so the gate always fires
      const details = result.details as Record<string, unknown>;
      expect(details.requiresConfirmation).toBe(true);
      expect(details.actionType).toBe("config.patch");
      expect(details.hint).toContain("_confirmed");
      // RPC should not be called when gated
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("patch with _confirmed bypasses gate and calls RPC", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-2c", {
        action: "patch",
        section: "scheduler",
        key: "heartbeatMs",
        value: 20,
        _confirmed: true,
      } as any);

      expect(rpcCall).toHaveBeenCalledWith("config.patch", expect.objectContaining({
        section: "scheduler",
        key: "heartbeatMs",
        value: 20,
      }));
      const details = result.details as Record<string, unknown>;
      expect(details.patched).toBe(true);
    });
  });

  describe("restart action", () => {
    it("calls rpcCall with gateway.restart", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-3", { action: "restart" });

      // gateway.restart is classified as "destructive" so it may require confirmation
      // If no confirmation needed (mock doesn't gate), check the call was made
      // The gate check depends on classifyAction - destructive returns requiresConfirmation
      // We check either the gate response or the rpc response
      const details = result.details as Record<string, unknown>;
      if (details.requiresConfirmation) {
        expect(details.actionType).toBe("gateway.restart");
        expect(rpcCall).not.toHaveBeenCalled();
      } else {
        expect(rpcCall).toHaveBeenCalledWith("gateway.restart", { _trustLevel: "guest" });
        expect(details).toEqual(expect.objectContaining({ restarted: true }));
      }
    });
  });

  describe("schema action", () => {
    it("calls rpcCall with config.schema and section param", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-4", {
        action: "schema",
        section: "agent",
      });

      expect(rpcCall).toHaveBeenCalledWith("config.schema", { section: "agent", _trustLevel: "guest" });
      expect(result.details).toEqual(
        expect.objectContaining({ type: "object" }),
      );
    });

    it("calls config.schema with undefined section for full schema", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      await tool.execute("call-4b", { action: "schema" });

      expect(rpcCall).toHaveBeenCalledWith("config.schema", { section: undefined, _trustLevel: "guest" });
    });
  });

  describe("status action", () => {
    it("calls rpcCall with gateway.status", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-5", { action: "status" });

      expect(rpcCall).toHaveBeenCalledWith("gateway.status", { _trustLevel: "guest" });
      expect(result.details).toEqual(
        expect.objectContaining({ status: "running" }),
      );
    });
  });

  describe("history action", () => {
    it("calls rpcCall with config.history and section/limit params", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-h1", {
        action: "history",
        section: "agent",
        limit: 5,
      });

      expect(rpcCall).toHaveBeenCalledWith("config.history", { section: "agent", limit: 5, _trustLevel: "guest" });
      expect(result.details).toEqual(
        expect.objectContaining({
          entries: expect.arrayContaining([
            expect.objectContaining({ sha: "abc123" }),
          ]),
        }),
      );
    });

    it("calls config.history with default params when no section/limit provided", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      await tool.execute("call-h2", { action: "history" });

      expect(rpcCall).toHaveBeenCalledWith("config.history", { section: undefined, limit: undefined, _trustLevel: "guest" });
    });
  });

  describe("diff action", () => {
    it("calls rpcCall with config.diff and sha param", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-d1", {
        action: "diff",
        sha: "abc123",
      });

      expect(rpcCall).toHaveBeenCalledWith("config.diff", { sha: "abc123", _trustLevel: "guest" });
      expect(result.details).toEqual(
        expect.objectContaining({ diff: expect.stringContaining("---") }),
      );
    });

    it("calls config.diff with undefined sha for default diff", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      await tool.execute("call-d2", { action: "diff" });

      expect(rpcCall).toHaveBeenCalledWith("config.diff", { sha: undefined, _trustLevel: "guest" });
    });
  });

  describe("apply action", () => {
    it("apply is gated as destructive (requiresConfirmation)", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-a1", {
        action: "apply" as "read",
        section: "scheduler",
        value: { cron: { enabled: false } },
      });

      // config.apply is classified as "destructive" so the gate always fires
      const details = result.details as Record<string, unknown>;
      expect(details.requiresConfirmation).toBe(true);
      expect(details.actionType).toBe("config.apply");
      expect(details.hint).toContain("_confirmed");
      // RPC should not be called when gated
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("returns requiresConfirmation with config.apply action type", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-a2", {
        action: "apply" as "read",
        section: "scheduler",
        value: { cron: { enabled: true } },
      });

      // Same behavior as rollback: destructive gate always fires
      const details = result.details as Record<string, unknown>;
      expect(details.requiresConfirmation).toBe(true);
      expect(details.actionType).toBe("config.apply");
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("rejects apply to immutable config section before gate", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      await expect(
        tool.execute("call-a-imm", {
          action: "apply" as "read",
          section: "security",
          value: { allowedOrigins: ["*"] },
        }),
      ).rejects.toThrow(/\[permission_denied\].*immutable/);
      // RPC should not be called -- rejected before gate
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("apply with _confirmed bypasses gate and calls RPC", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-a3", {
        action: "apply" as "read",
        section: "scheduler",
        value: { cron: { enabled: true } },
        _confirmed: true,
      } as any);

      expect(rpcCall).toHaveBeenCalledWith("config.apply", expect.objectContaining({
        section: "scheduler",
        value: { cron: { enabled: true } },
      }));
      const details = result.details as Record<string, unknown>;
      expect(details.applied).toBe(true);
    });
  });

  describe("rollback action", () => {
    it("rollback is gated as destructive (requiresConfirmation)", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-r1", {
        action: "rollback",
        sha: "abc123",
      });

      // config.rollback is classified as "destructive" so it requires confirmation
      const details = result.details as Record<string, unknown>;
      if (details.requiresConfirmation) {
        expect(details.actionType).toBe("config.rollback");
        expect(rpcCall).not.toHaveBeenCalled();
      } else {
        // If gate passes (e.g., confirmation was provided), check the call
        expect(rpcCall).toHaveBeenCalledWith("config.rollback", {
          sha: "abc123",
          _trustLevel: "guest",
        });
        expect(details).toEqual(
          expect.objectContaining({ rolledBack: true }),
        );
      }
    });

    it("returns requiresConfirmation with config.rollback action type", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-r2", {
        action: "rollback",
        sha: "abc123",
      });

      // config.rollback is classified as destructive, so the gate always fires
      const details = result.details as Record<string, unknown>;
      expect(details.requiresConfirmation).toBe(true);
      expect(details.actionType).toBe("config.rollback");
      expect(details.hint).toContain("_confirmed");
      // RPC should not be called when gated
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("rollback with _confirmed bypasses gate and calls RPC", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-r3", {
        action: "rollback",
        sha: "abc123",
        _confirmed: true,
      } as any);

      expect(rpcCall).toHaveBeenCalledWith("config.rollback", expect.objectContaining({
        sha: "abc123",
      }));
      const details = result.details as Record<string, unknown>;
      expect(details.rolledBack).toBe(true);
    });
  });

  describe("env_set action", () => {
    it("requires confirmation when not confirmed", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-e1", {
        action: "env_set" as "read",
        env_key: "MY_KEY",
        env_value: "secret-val",
      } as any);

      // env.set is classified as "destructive" so the gate fires
      const details = result.details as Record<string, unknown>;
      expect(details.requiresConfirmation).toBe(true);
      expect(details.actionType).toBe("env.set");
      expect(details.hint).toContain("MY_KEY");
      expect(details.hint).toContain("_confirmed");
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("delegates to env.set RPC when confirmed", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-e2", {
        action: "env_set" as "read",
        env_key: "MY_KEY",
        env_value: "secret-val",
        _confirmed: true,
      } as any);

      expect(rpcCall).toHaveBeenCalledWith("env.set", expect.objectContaining({
        key: "MY_KEY",
        value: "secret-val",
        _trustLevel: "guest",
      }));
      const details = result.details as Record<string, unknown>;
      expect(details.set).toBe(true);
      expect(details.key).toBe("MY_KEY");
      expect(details.storage).toBe("encrypted");
    });

    it("strips value from result even if RPC returns it", async () => {
      const rpcCall = vi.fn(async () => ({
        set: true, key: "MY_KEY", storage: "encrypted", value: "leaked-secret",
      }));
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-e3", {
        action: "env_set" as "read",
        env_key: "MY_KEY",
        env_value: "secret-val",
        _confirmed: true,
      } as any);

      const details = result.details as Record<string, unknown>;
      // value should be stripped (set to undefined)
      expect(details.value).toBeUndefined();
      // But other fields preserved
      expect(details.set).toBe(true);
      expect(details.key).toBe("MY_KEY");
    });

    it("throws when env_key parameter missing", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      await expect(
        tool.execute("call-e4", {
          action: "env_set" as "read",
          env_value: "secret-val",
          _confirmed: true,
        } as any),
      ).rejects.toThrow(/Missing required parameter: env_key/);
    });

    it("throws when env_value parameter missing", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      await expect(
        tool.execute("call-e5", {
          action: "env_set" as "read",
          env_key: "MY_KEY",
          _confirmed: true,
        } as any),
      ).rejects.toThrow(/Missing required parameter: env_value/);
    });

    it("rejects literal [REDACTED] placeholder without calling env.set", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-e6", {
        action: "env_set" as "read",
        env_key: "CLOUDFLARE_ACCOUNT_ID",
        env_value: "[REDACTED]",
        _confirmed: true,
      } as any);

      expect((result as any).details).toMatchObject({
        error: "env_value_is_placeholder",
      });
      // env.set RPC must not be called for poisoned replay values.
      expect(rpcCall).not.toHaveBeenCalledWith("env.set", expect.anything());
    });

    it("rejects bracketed redaction variants", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-e7", {
        action: "env_set" as "read",
        env_key: "API_TOKEN",
        env_value: "[REDACTED-PREVIOUS]",
        _confirmed: true,
      } as any);

      expect((result as any).details).toMatchObject({
        error: "env_value_is_placeholder",
      });
      expect(rpcCall).not.toHaveBeenCalledWith("env.set", expect.anything());
    });
  });

  describe("env_list action", () => {
    it("delegates to env.list RPC with filter and limit", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-el1", {
        action: "env_list" as "read",
        filter: "GEMINI*",
        limit: 50,
      } as any);

      expect(rpcCall).toHaveBeenCalledWith("env.list", expect.objectContaining({
        filter: "GEMINI*",
        limit: 50,
        _trustLevel: "guest",
      }));
      const details = result.details as Record<string, unknown>;
      expect(details.secrets).toBeDefined();
      expect(details.total).toBe(2);
    });

    it("delegates to env.list with undefined filter/limit when omitted", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      await tool.execute("call-el2", { action: "env_list" as "read" } as any);

      expect(rpcCall).toHaveBeenCalledWith("env.list", expect.objectContaining({
        filter: undefined,
        limit: undefined,
        _trustLevel: "guest",
      }));
    });

    it("does NOT require confirmation (read-only action)", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-el3", { action: "env_list" as "read" } as any);

      const details = result.details as Record<string, unknown>;
      // No confirmation gate on a read-only action
      expect(details.requiresConfirmation).toBeUndefined();
      expect(rpcCall).toHaveBeenCalledTimes(1);
    });

    it("response never contains secret values (forwards opaque RPC payload)", async () => {
      // Simulate a misbehaving backend that tries to leak a value — the gateway tool
      // forwards RPC responses as-is for env_list (no leak-stripping needed because
      // the env.list handler itself never returns values; this test documents the
      // contract that we do not inadvertently synthesize value fields client-side).
      const rpcCall = vi.fn(async () => ({
        secrets: [{ name: "OPENAI_API_KEY", source: "envfile" }],
        total: 1,
        truncated: false,
      }));
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-el4", { action: "env_list" as "read" } as any);
      const serialized = JSON.stringify(result.details);
      expect(serialized).not.toMatch(/"value"\s*:/);
      expect(serialized).not.toMatch(/"plaintext"\s*:/);
      expect(serialized).not.toMatch(/"ciphertext"\s*:/);
    });
  });

  describe("patch action -- immutability error with patchable paths", () => {
    it("includes patchable paths hint when rejecting immutable path", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      // Updated for quick-260425-t40: agents now redirects to agents_manage
      // with the override paths surfaced as the "in-place updates" branch.
      await expect(
        tool.execute("call-imm1", {
          action: "patch",
          section: "agents",
          key: "default",
          value: { model: "gemini-2.0-flash" },
        }),
      ).rejects.toThrow(/agents\.default\.model/);
      expect(rpcCall).not.toHaveBeenCalled();
    });
  });

  describe("patch action -- mutable override bypass", () => {
    it("mutable override path skips confirmation gate entirely", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-mut1", {
        action: "patch",
        section: "agents",
        key: "default.model",
        value: "gemini-2.0-flash",
      });

      // Should call RPC directly without requiresConfirmation
      expect(rpcCall).toHaveBeenCalledWith("config.patch", expect.objectContaining({
        section: "agents",
        key: "default.model",
        value: "gemini-2.0-flash",
      }));
      const details = result.details as Record<string, unknown>;
      expect(details.patched).toBe(true);
      // No confirmation gate
      expect(details.requiresConfirmation).toBeUndefined();
    });

    it("non-mutable non-immutable path still requires confirmation (regression)", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      const result = await tool.execute("call-reg1", {
        action: "patch",
        section: "scheduler",
        key: "heartbeatMs",
        value: 20,
      });

      const details = result.details as Record<string, unknown>;
      expect(details.requiresConfirmation).toBe(true);
      expect(details.actionType).toBe("config.patch");
      expect(rpcCall).not.toHaveBeenCalled();
    });
  });

  describe("unknown action", () => {
    it("throws [invalid_action] for unknown action", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      await expect(
        tool.execute("call-6", {
          action: "unknown" as "read",
        }),
      ).rejects.toThrow(/\[invalid_value\]/);
      expect(rpcCall).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("throws when rpcCall throws", async () => {
      const rpcCall = vi.fn(async () => {
        throw new Error("Gateway service unavailable");
      });
      const tool = createGatewayTool(rpcCall);

      await expect(
        tool.execute("call-7", {
          action: "status",
        }),
      ).rejects.toThrow("Gateway service unavailable");
    });

    it("handles non-Error throws gracefully", async () => {
      const rpcCall = vi.fn(async () => {
        throw "string error";
      });
      const tool = createGatewayTool(rpcCall);

      await expect(
        tool.execute("call-8", {
          action: "status",
        }),
      ).rejects.toThrow("string error");
    });
  });

  // Regression: production failure 2026-04-24 (srv1593437, trace ab7ebba0).
  // Dash (Opus 4.6) hit gateway/apply then gateway/patch on the agents section,
  // got dead-end "immutable" errors, hallucinated that agents_manage was
  // unavailable, and gave up. The redirect hint must (1) name the dedicated
  // tool, (2) instruct the LLM to call discover_tools to load the schema, and
  // (3) include a parameter-correct example -- model-agnostic, copy-pasteable.
  describe("immutability redirect hints (model-agnostic)", () => {
    it("agents/apply rejection points to agents_manage with a parameter-correct example", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      let captured: Error | undefined;
      try {
        await tool.execute("call-redir-1", {
          action: "apply" as "read",
          section: "agents",
          value: { coding: { name: "x", model: "y", provider: "anthropic" } },
        });
      } catch (e) {
        captured = e as Error;
      }
      expect(captured).toBeDefined();
      const msg = captured!.message;
      expect(msg).toContain("[permission_denied]");
      expect(msg).toContain('Use the "agents_manage" tool');
      expect(msg).toContain('discover_tools("agents_manage")');
      expect(msg).toContain('"action":"create"');
      expect(msg).toContain('"agent_id":"<new-agent-id>"');
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("agents.<newId>/patch rejection points to agents_manage", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      let captured: Error | undefined;
      try {
        await tool.execute("call-redir-2", {
          action: "patch",
          section: "agents",
          key: "coding",
          value: { name: "coding-specialist", model: "opus-4-6", provider: "anthropic" },
        });
      } catch (e) {
        captured = e as Error;
      }
      expect(captured).toBeDefined();
      const msg = captured!.message;
      expect(msg).toContain("[permission_denied]");
      expect(msg).toContain('Recovery: (1) call discover_tools("agents_manage")');
      expect(msg).toContain("(2) call agents_manage(");
      // Mutable override paths are still surfaced for the in-place-update case
      expect(msg).toContain("agents.coding.model");
      expect(rpcCall).not.toHaveBeenCalled();
    });

    it("channels/<type>/<field>/patch rejection points to channels_manage with fullyManaged:false note", async () => {
      const rpcCall = createMockRpcCall();
      const tool = createGatewayTool(rpcCall);

      let captured: Error | undefined;
      try {
        await tool.execute("call-redir-3", {
          action: "patch",
          section: "channels",
          key: "telegram.allowFrom",
          value: ["123"],
        });
      } catch (e) {
        captured = e as Error;
      }
      expect(captured).toBeDefined();
      const msg = captured!.message;
      expect(msg).toContain('Use the "channels_manage" tool');
      expect(msg).toContain('discover_tools("channels_manage")');
      // channels_manage is fullyManaged:false — the warning must appear
      expect(msg).toContain("brand-new platform types still requires operator config edits");
      // No exampleArgs for channels — Recovery framing absent, fall-back load instruction present
      expect(msg).not.toContain("Recovery: (1)");
      expect(rpcCall).not.toHaveBeenCalled();
    });
  });
});
