// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, vi } from "vitest";
import { getAllToolMetadata, getToolMetadata, truncateContentBlocks, registerToolMetadata, TypedEventBus } from "@comis/core";
import type { EventMap } from "@comis/core";
import { Type } from "typebox";
import { registerAllToolMetadata } from "./tool-metadata-registry.js";
import { wrapWithMetadataEnforcement } from "./tool-metadata-enforcement.js";
import { wrapWithAudit } from "./tool-audit.js";
import { validateToolEntry } from "./schema-validator.js";
import { GATEWAY_ACTIONS } from "../../platform-tools/tools/gateway-tool.js";
import { createMemoryManageTool } from "../../platform-tools/tools/memory-manage-tool.js";

// ---------------------------------------------------------------------------
// Ensure metadata is registered before all tests
// ---------------------------------------------------------------------------

beforeAll(() => {
  registerAllToolMetadata();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockTool(name: string, executeFn?: (...args: any[]) => Promise<any>) {
  return {
    name,
    label: name,
    description: `A ${name} tool`,
    parameters: Type.Object({}),
    execute: executeFn ?? vi.fn().mockResolvedValue({
      content: [{ type: "text" as const, text: "ok" }],
      details: { result: "ok" },
    }),
  };
}

// ===========================================================================
// Registry Count Assertion
// ===========================================================================

describe("tool-metadata-registry -- registry count", () => {
  it("registers exactly 63 unique tools (registry count assertion)", () => {
    // The registry pins an exact tool count so an accidental add or removal is
    // caught. Notable entries: video_generate and video_status are EXPLICITLY
    // registered never-export (cost-bearing + outbound delivery); video_status
    // is reserved so its policy is pinned before the tool exists. image_generate
    // is NOT registered here — it rides the default-deny safety net.
    // obs_system_health and obs_explain are slim, READ-ONLY, permission-gated MCP
    // tools surfacing the obs.system.health SystemHealthReport and the obs.explain
    // IncidentReport respectively. The three ctx_* in-session expansion tools
    // (ctx_search / ctx_inspect / ctx_expand) are the governed TOOL surface over
    // the LCD store.
    const all = getAllToolMetadata();
    expect(all.size).toBe(64);
  });
});

// ===========================================================================
// memory_manage schema↔metadata parity
//
// The metadata-registry entry (validActions/validKeys/requiredByAction) is a SECOND
// source of truth, consumed by schema-validator.validateToolEntry BEFORE the tool's
// own execute() runs. memory_manage's entry drifted from the tool's TypeBox schema:
// it listed only the pre-#163 5 actions (stats/browse/delete/flush/export — NO
// pin/unpin) and omitted the `id` key. Live shape: the admin agent's
// `memory_manage({action:"pin", id})` was rejected
//   "[invalid_value] invalid action 'pin'. valid actions: stats, browse, delete,
//    flush, export. unknown key 'id' -- did you mean 'ids'?"
// BEFORE execute() — even though the tool's schema, VALID_ACTIONS, and the memory.pin
// RPC fully support pin/unpin/id (proven live: direct memory.pin → {pinned,found}).
// These guards tie the metadata back to the schema so the drift can't recur.
// ===========================================================================

describe("tool-metadata-registry -- memory_manage schema↔metadata parity", () => {
  it("metadata validActions == the tool's actual schema action enum (no drift)", () => {
    const tool = createMemoryManageTool((() => {}) as never);
    // memory_manage's `action` is a Type.Union([Type.Literal(...)]) → schema.anyOf[].const.
    const actionSchema = (tool.parameters as unknown as { properties: { action: { anyOf?: { const: string }[] } } })
      .properties.action;
    const schemaActions = (actionSchema.anyOf ?? []).map((s) => s.const).sort();
    expect(schemaActions.length).toBeGreaterThan(0); // guard the extraction itself
    const meta = getToolMetadata("memory_manage");
    expect([...(meta?.validActions ?? [])].sort()).toEqual(schemaActions);
  });

  it("metadata covers the pin/unpin actions, the id key, and their required field", () => {
    const meta = getToolMetadata("memory_manage");
    expect(meta?.validActions).toEqual(expect.arrayContaining(["pin", "unpin"]));
    expect(meta?.validKeys).toContain("id");
    expect(meta?.requiredByAction?.pin).toEqual(["id"]);
    expect(meta?.requiredByAction?.unpin).toEqual(["id"]);
  });
});

// ===========================================================================
// Sleep primitive — read-only + concurrency-safe + never-export
// ===========================================================================

describe("tool-metadata-registry -- sleep primitive", () => {
  // The sleep builtin paces the model between turns; it mutates NO state, so it
  // must register read-only + concurrency-safe: the read-only detection and the
  // tool serializer rely on these flags to let it overlap concurrency-safe reads
  // instead of serializing them behind it. The mcp-export-policy.test.ts AST
  // gate additionally requires every registered name to carry an explicit policy;
  // sleep is an internal loop-pacing primitive inside Comis's trust boundary, so
  // it is never-export (like ctx_* / terminal_*).
  it("registers sleep as isReadOnly + isConcurrencySafe (it mutates no state)", () => {
    const meta = getToolMetadata("sleep");
    expect(meta, "sleep must be registered").toBeDefined();
    expect(meta!.isReadOnly).toBe(true);
    expect(meta!.isConcurrencySafe).toBe(true);
  });

  it("registers sleep as mcpExportPolicy 'never-export' (internal pacing primitive)", () => {
    expect(getToolMetadata("sleep")!.mcpExportPolicy).toBe("never-export");
  });
});

// ===========================================================================
// Context expansion — all three ctx_* tools never-export + read-only
// ===========================================================================

describe("tool-metadata-registry -- context expansion governance", () => {
  // The three in-session expansion tools. All MUST be
  // never-export: they live inside Comis's trust boundary over the LCD store
  // and must never reach the MCP-exported set. They only READ the store, so
  // they are also isReadOnly. The mcp-export-policy.test.ts AST gate
  // additionally requires every registered name to carry an explicit policy.
  const CTX_TOOLS = ["ctx_search", "ctx_inspect", "ctx_expand"] as const;

  it.each(CTX_TOOLS)("%s resolves to mcpExportPolicy 'never-export'", (name) => {
    const meta = getToolMetadata(name);
    expect(meta, `${name} must be registered`).toBeDefined();
    expect(meta!.mcpExportPolicy).toBe("never-export");
  });

  it.each(CTX_TOOLS)("%s resolves to isReadOnly true", (name) => {
    expect(getToolMetadata(name)!.isReadOnly).toBe(true);
  });
});

// ===========================================================================
// Terminal driver — all nine tools never-export
// ===========================================================================

describe("tool-metadata-registry -- terminal driver never-export", () => {
  // The canonical nine terminal-driver tools. All MUST be never-export: they
  // live inside Comis's trust boundary and must never reach the MCP-exported
  // set, even the six registered as stubs ahead of their implementation. The
  // mcp-export-policy.test.ts AST gate additionally requires every registered
  // name to carry an explicit policy.
  const TERMINAL_TOOLS = [
    "terminal_session_create",
    "terminal_session_list",
    "terminal_session_read",
    "terminal_session_send_text",
    "terminal_session_send_key",
    "terminal_session_wait",
    "terminal_session_status",
    "terminal_session_resize",
    "terminal_session_kill",
  ] as const;

  it.each(TERMINAL_TOOLS)("%s resolves to mcpExportPolicy 'never-export'", (name) => {
    const meta = getToolMetadata(name);
    expect(meta, `${name} must be registered`).toBeDefined();
    expect(meta!.mcpExportPolicy).toBe("never-export");
  });

  // The perception tools surface the DRIVEN session's exitCode → flagged so the bridge's
  // exit-code failure heuristic never misreads a non-zero driven exit as a TOOL failure
  // (real-VPS 2026-06-16: a bash `exit 1` misclassified a successful terminal_session_status).
  it.each(["terminal_session_read", "terminal_session_wait", "terminal_session_status"] as const)(
    "%s is flagged exitCodeIsDrivenSession (non-zero driven exit is not a tool failure)",
    (name) => {
      expect(getToolMetadata(name)!.exitCodeIsDrivenSession).toBe(true);
    },
  );

  it.each(["terminal_session_send_text", "terminal_session_create", "terminal_session_kill"] as const)(
    "%s does NOT set exitCodeIsDrivenSession (its result carries no driven exitCode)",
    (name) => {
      expect(getToolMetadata(name)!.exitCodeIsDrivenSession).toBeUndefined();
    },
  );

  it("registers exactly nine terminal_session_* names", () => {
    const all = getAllToolMetadata();
    const terminalNames = [...all.keys()].filter((k) => k.startsWith("terminal_session_"));
    expect(terminalNames.sort()).toEqual([...TERMINAL_TOOLS].sort());
  });
});

// ===========================================================================
// Video synthesis — video_generate + video_status never-export
// ===========================================================================

describe("tool-metadata-registry -- video synthesis never-export", () => {
  // Both cost-bearing/outbound video tools MUST be never-export: a generated
  // video is delivered to a channel and bills the agent's provider, so it must
  // never reach the MCP-exported set. video_status is reserved here so its
  // policy is pinned before the tool exists. The
  // mcp-export-policy.test.ts AST gate additionally requires every registered
  // name to carry an explicit policy. This block is mutation-proven RED: flip
  // either registration to "permission-gated"/"public" and it fails.
  const VIDEO_TOOLS = ["video_generate", "video_status"] as const;

  it.each(VIDEO_TOOLS)("%s resolves to mcpExportPolicy 'never-export'", (name) => {
    const meta = getToolMetadata(name);
    expect(meta, `${name} must be registered`).toBeDefined();
    expect(meta!.mcpExportPolicy).toBe("never-export");
  });
});

// ===========================================================================
// Voice tool export policy regression
// ===========================================================================

describe("tool-metadata-registry -- voice tool export policy regression", () => {
  // The two voice tools' export policies are deliberately DIFFERENT — do NOT
  // "fix" them to match. transcribe_audio is READ-ONLY (it turns inbound audio
  // into text; isReadOnly:true) so it is permission-gated — usable by an MCP
  // client only behind an explicit grant. tts_synthesize is OUTBOUND (it
  // produces audio delivered to a channel) so it is never-export — it must never
  // reach the MCP-exported set at all. This block is mutation-proven RED:
  // flipping EITHER registration in tool-metadata-registry.ts (e.g.
  // transcribe_audio → never-export/safe, or tts_synthesize → permission-gated)
  // fails the matching assertion. The mcp-export-policy.test.ts AST gate
  // additionally requires every registered name to carry an explicit policy.
  it("transcribe_audio stays permission-gated (read-only, gated — NOT never-export, NOT safe)", () => {
    const meta = getToolMetadata("transcribe_audio");
    expect(meta, "transcribe_audio must be registered").toBeDefined();
    expect(meta!.mcpExportPolicy).toBe("permission-gated");
  });

  it("tts_synthesize stays never-export (outbound audio delivery — never MCP-exported)", () => {
    const meta = getToolMetadata("tts_synthesize");
    expect(meta, "tts_synthesize must be registered").toBeDefined();
    expect(meta!.mcpExportPolicy).toBe("never-export");
  });
});

// ===========================================================================
// Result Size Caps
// ===========================================================================

describe("tool-metadata-registry -- result size caps", () => {
  const EXPECTED_CAPS: Record<string, number> = {
    grep: 100_000,
    read: 200_000,
    exec: 100_000,
    find: 50_000,
    ls: 20_000,
    web_fetch: 150_000,
    web_search: 50_000,
    sessions_history: 100_000,
    obs_query: 100_000,
    memory_search: 50_000,
  };

  for (const [toolName, expectedCap] of Object.entries(EXPECTED_CAPS)) {
    it(`registers ${toolName} with maxResultSizeChars = ${expectedCap}`, () => {
      const meta = getToolMetadata(toolName);
      expect(meta).toBeDefined();
      expect(meta!.maxResultSizeChars).toBe(expectedCap);
    });
  }

  it("does not register caps for tools not in the list", () => {
    for (const name of ["write", "edit", "memory_store", "message", "apply_patch"]) {
      const meta = getToolMetadata(name);
      expect(meta?.maxResultSizeChars).toBeUndefined();
    }
  });

  it("enforcement truncates grep result exceeding 100K chars", () => {
    const meta = getToolMetadata("grep");
    expect(meta).toBeDefined();
    expect(meta!.maxResultSizeChars).toBe(100_000);

    const content = [{ type: "text", text: "x".repeat(500_000) }];
    const capped = truncateContentBlocks(content, meta!.maxResultSizeChars!);

    expect(capped).not.toBe(content);
    expect(capped[0].text!.length).toBeLessThan(500_000);
    expect(capped[0].text).toContain("chars truncated");
  });
});

// ===========================================================================
// Parallelism Metadata
// ===========================================================================

describe("tool-metadata-registry -- parallelism read-only tools", () => {
  const readOnlyToolNames = [
    "read", "grep", "find", "ls",
    "web_search", "web_fetch", "browser",
    "memory_search", "memory_get", "session_search",
    "sessions_list", "session_status", "sessions_history",
    "image_analyze", "describe_video", "extract_document", "transcribe_audio",
    "obs_query", "models_manage",
    "discover_tools",
  ];

  it("registers all 20 read-only tools with isReadOnly: true", () => {
    expect(readOnlyToolNames).toHaveLength(20);
    for (const name of readOnlyToolNames) {
      const meta = getToolMetadata(name);
      expect(meta, `${name} should have metadata`).toBeDefined();
      expect(meta!.isReadOnly, `${name} should be read-only`).toBe(true);
    }
  });
});

describe("tool-metadata-registry -- parallelism mutating tools", () => {
  const MUTATING_TOOLS = [
    "edit", "write", "apply_patch",
    "exec", "process",
    "memory_store", "memory_manage",
    "sessions_manage", "sessions_send", "sessions_spawn", "subagents",
    "pipeline", "cron", "gateway", "heartbeat_manage",
    "channels_manage", "tokens_manage", "skills_manage", "mcp_manage", "agents_manage",
    "whatsapp_action", "discord_action", "telegram_action", "slack_action",
    "tts_synthesize",
  ];

  it("registers all 25 mutating tools with isReadOnly: false", () => {
    expect(MUTATING_TOOLS).toHaveLength(25);
    for (const name of MUTATING_TOOLS) {
      const meta = getToolMetadata(name);
      expect(meta, `${name} should have metadata`).toBeDefined();
      expect(meta!.isReadOnly, `${name} should be mutating`).toBe(false);
    }
  });
});

describe("tool-metadata-registry -- concurrency-safe mutating", () => {
  it("registers message as mutating AND concurrency-safe", () => {
    const meta = getToolMetadata("message");
    expect(meta).toBeDefined();
    expect(meta!.isReadOnly).toBe(false);
    expect(meta!.isConcurrencySafe).toBe(true);
  });
});

describe("tool-metadata-registry -- merge preservation", () => {
  it("preserves maxResultSizeChars after parallelism registration", () => {
    const grep = getToolMetadata("grep");
    expect(grep).toBeDefined();
    expect(grep!.maxResultSizeChars).toBe(100_000);
    expect(grep!.isReadOnly).toBe(true);

    const exec = getToolMetadata("exec");
    expect(exec).toBeDefined();
    expect(exec!.maxResultSizeChars).toBe(100_000);
    expect(exec!.isReadOnly).toBe(false);

    const read = getToolMetadata("read");
    expect(read).toBeDefined();
    expect(read!.maxResultSizeChars).toBe(200_000);
    expect(read!.isReadOnly).toBe(true);
  });

  it("read-only tools do not have isConcurrencySafe set", () => {
    for (const name of ["grep", "web_search", "memory_search", "discover_tools"]) {
      const meta = getToolMetadata(name);
      expect(meta, `${name} should have metadata`).toBeDefined();
      expect(meta!.isReadOnly).toBe(true);
      expect(meta!.isConcurrencySafe, `${name} should not have isConcurrencySafe`).toBeUndefined();
    }
  });
});

// ===========================================================================
// Input Validators
// ===========================================================================

describe("tool-metadata-registry -- exec validator", () => {
  const getExecValidator = () => getToolMetadata("exec")?.validateInput;

  it("rejects missing command", async () => {
    const validate = getExecValidator()!;
    const result = await validate({});
    expect(result).toContain("command");
  });

  it("rejects empty command", async () => {
    const validate = getExecValidator()!;
    const result = await validate({ command: "" });
    expect(result).toContain("command");
  });

  it("rejects whitespace-only command", async () => {
    const validate = getExecValidator()!;
    const result = await validate({ command: "   " });
    expect(result).toContain("command");
  });

  it("rejects dangerous command", async () => {
    const validate = getExecValidator()!;
    const result = await validate({ command: "rm -rf /" });
    expect(result).toContain("blocked");
  });

  it("rejects dangerous env var", async () => {
    const validate = getExecValidator()!;
    const result = await validate({ command: "echo hi", env: { LD_PRELOAD: "/evil.so" } });
    expect(result).toContain("not in the allowed list");
  });

  it("rejects dangerous env var with DYLD_ prefix", async () => {
    const validate = getExecValidator()!;
    const result = await validate({ command: "echo hi", env: { DYLD_INSERT_LIBRARIES: "/evil.so" } });
    expect(result).toContain("not in the allowed list");
  });

  it("accepts valid command", async () => {
    const validate = getExecValidator()!;
    const result = await validate({ command: "echo hello" });
    expect(result).toBeUndefined();
  });

  it("accepts valid command with safe env", async () => {
    const validate = getExecValidator()!;
    const result = await validate({ command: "echo hi", env: { NODE_ENV: "test" } });
    expect(result).toBeUndefined();
  });
});

describe("tool-metadata-registry -- cron validator", () => {
  const getCronValidator = () => getToolMetadata("cron")?.validateInput;

  it("rejects missing action", async () => {
    const validate = getCronValidator()!;
    const result = await validate({});
    expect(result).toContain("action");
  });

  it("rejects invalid action", async () => {
    const validate = getCronValidator()!;
    const result = await validate({ action: "bogus" });
    expect(result).toContain("Valid:");
  });

  it("rejects add without payload_kind", async () => {
    const validate = getCronValidator()!;
    const result = await validate({ action: "add", payload_text: "x" });
    expect(result).toContain("payload_kind");
  });

  it("rejects add without payload_text", async () => {
    const validate = getCronValidator()!;
    const result = await validate({ action: "add", payload_kind: "text" });
    expect(result).toContain("payload_text");
  });

  it("rejects add with invalid schedule_kind", async () => {
    const validate = getCronValidator()!;
    const result = await validate({ action: "add", payload_kind: "text", payload_text: "hello", schedule_kind: "bogus" });
    expect(result).toContain("schedule_kind");
  });

  it("rejects remove without job_name", async () => {
    const validate = getCronValidator()!;
    const result = await validate({ action: "remove" });
    expect(result).toContain("job_name");
  });

  it("rejects update without job_name", async () => {
    const validate = getCronValidator()!;
    const result = await validate({ action: "update" });
    expect(result).toContain("job_name");
  });

  it("rejects run without job_name", async () => {
    const validate = getCronValidator()!;
    const result = await validate({ action: "run" });
    expect(result).toContain("job_name");
  });

  it("accepts list with no extra params", async () => {
    const validate = getCronValidator()!;
    const result = await validate({ action: "list" });
    expect(result).toBeUndefined();
  });

  it("accepts add with all required params", async () => {
    const validate = getCronValidator()!;
    const result = await validate({ action: "add", payload_kind: "text", payload_text: "hello" });
    expect(result).toBeUndefined();
  });

  it("accepts add with valid schedule_kind", async () => {
    const validate = getCronValidator()!;
    const result = await validate({ action: "add", payload_kind: "text", payload_text: "hello", schedule_kind: "cron" });
    expect(result).toBeUndefined();
  });

  // Live regression: the model correctly emitted schedule_kind:"in"
  // for "remind me in 2 minutes" but this validator rejected it ("Valid: cron,
  // every, at"), forcing a fallback to the timezone-error-prone "at" path.
  it("accepts add with schedule_kind=in + positive schedule_in_seconds", async () => {
    const validate = getCronValidator()!;
    const result = await validate({ action: "add", payload_kind: "text", payload_text: "stretch", schedule_kind: "in", schedule_in_seconds: 120 });
    expect(result).toBeUndefined();
  });

  it("rejects schedule_kind=in without a positive schedule_in_seconds (names the param)", async () => {
    const validate = getCronValidator()!;
    const missing = await validate({ action: "add", payload_kind: "text", payload_text: "stretch", schedule_kind: "in" });
    expect(missing).toContain("schedule_in_seconds");
    const nonPositive = await validate({ action: "add", payload_kind: "text", payload_text: "stretch", schedule_kind: "in", schedule_in_seconds: 0 });
    expect(nonPositive).toContain("schedule_in_seconds");
  });
});

describe("tool-metadata-registry -- message validator", () => {
  const getMessageValidator = () => getToolMetadata("message")?.validateInput;

  it("rejects missing action", async () => {
    const validate = getMessageValidator()!;
    const result = await validate({});
    expect(result).toContain("action");
  });

  it("rejects invalid action", async () => {
    const validate = getMessageValidator()!;
    const result = await validate({ action: "invalid_action" });
    expect(result).toContain("Valid:");
  });

  it("rejects missing channel_type", async () => {
    const validate = getMessageValidator()!;
    const result = await validate({ action: "send", channel_id: "123" });
    expect(result).toContain("channel_type");
  });

  it("rejects missing channel_id", async () => {
    const validate = getMessageValidator()!;
    const result = await validate({ action: "send", channel_type: "discord" });
    expect(result).toContain("channel_id");
  });

  it("accepts valid params", async () => {
    const validate = getMessageValidator()!;
    const result = await validate({ action: "send", channel_type: "discord", channel_id: "123" });
    expect(result).toBeUndefined();
  });
});

describe("tool-metadata-registry -- gateway validator", () => {
  const getGatewayValidator = () => getToolMetadata("gateway")?.validateInput;

  it("rejects missing action", async () => {
    const validate = getGatewayValidator()!;
    const result = await validate({});
    expect(result).toContain("action");
  });

  it("rejects invalid action", async () => {
    const validate = getGatewayValidator()!;
    const result = await validate({ action: "destroy" });
    expect(result).toContain("Valid:");
  });

  it("rejects patch on immutable path (security section)", async () => {
    const validate = getGatewayValidator()!;
    const result = await validate({ action: "patch", section: "security", key: "audit.enabled" });
    expect(result).toContain("immutable");
  });

  it("rejects patch on immutable path (gateway.tls)", async () => {
    const validate = getGatewayValidator()!;
    const result = await validate({ action: "patch", section: "gateway", key: "tls.certPath" });
    expect(result).toContain("immutable");
  });

  it("allows read on immutable path", async () => {
    const validate = getGatewayValidator()!;
    const result = await validate({ action: "read", section: "security" });
    expect(result).toBeUndefined();
  });

  it("allows patch on mutable path", async () => {
    const validate = getGatewayValidator()!;
    const result = await validate({ action: "patch", section: "models", key: "aliases" });
    expect(result).toBeUndefined();
  });

  it("accepts status with no extra params", async () => {
    const validate = getGatewayValidator()!;
    const result = await validate({ action: "status" });
    expect(result).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Drift-regression guards
  //
  // These three tests would have failed before the schema-derived whitelist
  // fix, when the bridge shadowed the handler with a hardcoded 10-item list
  // that silently dropped env_list. They enforce that the bridge validator
  // and the tool's GATEWAY_ACTIONS tuple are the same set.
  // -------------------------------------------------------------------------

  it("accepts env_list (drift-regression guard -- would fail before schema-derived whitelist)", async () => {
    const validate = getGatewayValidator()!;
    const result = await validate({ action: "env_list", filter: "GEMINI*" });
    expect(result).toBeUndefined();
  });

  it("accepts every action declared in GATEWAY_ACTIONS", async () => {
    const validate = getGatewayValidator()!;
    for (const action of GATEWAY_ACTIONS) {
      // patch needs a mutable path so the immutability branch returns
      // undefined; env_set needs key/value shape (the validator only
      // gates on action enum + patch immutability -- other shape checks
      // happen in the handler, not the bridge).
      const params =
        action === "patch"
          ? { action, section: "models", key: "aliases" }
          : action === "env_set"
          ? { action, env_key: "TEST_KEY", env_value: "v" }
          : { action };
      const result = await validate(params);
      expect(
        result,
        `action "${action}" should be accepted by bridge validator`,
      ).toBeUndefined();
    }
  });

  it("rejects actions not in GATEWAY_ACTIONS", async () => {
    const validate = getGatewayValidator()!;
    for (const bogus of ["destroy", "env_delete", "wipe", ""]) {
      const result = await validate({ action: bogus });
      expect(
        result,
        `action "${bogus}" should be rejected`,
      ).toMatch(/Invalid action|Missing|action/i);
    }
  });
});

describe("tool-metadata-registry -- errorKind propagation", () => {
  it("emits tool:executed with errorKind=validation on validation failure", async () => {
    registerToolMetadata("val_errorkind_test", { validateInput: () => "bad input" });

    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool("val_errorkind_test");
    const enforced = wrapWithMetadataEnforcement(tool);
    const audited = wrapWithAudit(enforced, eventBus);

    await expect(audited.execute("call-1", {})).rejects.toThrow("[invalid_value] bad input");

    expect(events).toHaveLength(1);
    expect(events[0]!.success).toBe(false);
    expect(events[0]!.errorKind).toBe("validation");
    expect(events[0]!.errorMessage).toContain("bad input");
  });

  it("preserves errorKind=internal for non-validation errors", async () => {
    const eventBus = new TypedEventBus();
    const events: EventMap["tool:executed"][] = [];
    eventBus.on("tool:executed", (payload) => events.push(payload));

    const tool = createMockTool(
      "val_errorkind_internal",
      vi.fn().mockRejectedValue(new Error("runtime crash")),
    );
    const enforced = wrapWithMetadataEnforcement(tool);
    const audited = wrapWithAudit(enforced, eventBus);

    await expect(audited.execute("call-1", {})).rejects.toThrow("runtime crash");

    expect(events).toHaveLength(1);
    expect(events[0]!.errorKind).toBe("internal");
  });
});

describe("tool-metadata-registry -- async validator support", () => {
  it("properly awaits async validator that returns error", async () => {
    registerToolMetadata("val_async_test", {
      validateInput: async () => "async fail",
    });

    const tool = createMockTool("val_async_test");
    const wrapped = wrapWithMetadataEnforcement(tool);

    await expect(wrapped.execute("call-1", {})).rejects.toThrow("[invalid_value] async fail");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("properly awaits async validator that returns undefined (pass)", async () => {
    registerToolMetadata("val_async_pass", {
      validateInput: async () => undefined,
    });

    const tool = createMockTool("val_async_pass");
    const wrapped = wrapWithMetadataEnforcement(tool);

    const result = await wrapped.execute("call-1", {});
    expect(result.content[0].text).toBe("ok");
  });
});

// ===========================================================================
// Output Schemas
// ===========================================================================

describe("tool-metadata-registry -- output schemas", () => {
  const SCHEMA_TOOLS = [
    "grep",
    "find",
    "exec",
    "memory_search",
    "web_search",
    "sessions_list",
  ];

  for (const toolName of SCHEMA_TOOLS) {
    it(`registers outputSchema for ${toolName}`, () => {
      const meta = getToolMetadata(toolName);
      expect(meta).toBeDefined();
      expect(meta!.outputSchema).toBeDefined();
    });
  }

  it("grep schema has type: string (text output, not JSON)", () => {
    const schema = getToolMetadata("grep")!.outputSchema!;
    expect(schema.type).toBe("string");
  });

  it("find schema has type: string (text output, not JSON)", () => {
    const schema = getToolMetadata("find")!.outputSchema!;
    expect(schema.type).toBe("string");
  });

  const JSON_TOOLS = ["exec", "memory_search", "web_search", "sessions_list"];

  for (const toolName of JSON_TOOLS) {
    it(`${toolName} schema has type: object (JSON output)`, () => {
      const schema = getToolMetadata(toolName)!.outputSchema!;
      expect(schema.type).toBe("object");
    });
  }

  for (const toolName of SCHEMA_TOOLS) {
    it(`${toolName} schema has a non-empty description`, () => {
      const schema = getToolMetadata(toolName)!.outputSchema!;
      expect(typeof schema.description).toBe("string");
      expect((schema.description as string).length).toBeGreaterThan(0);
    });
  }

  it("does not register outputSchema for tools not in the priority list", () => {
    for (const name of ["write", "edit"]) {
      const meta = getToolMetadata(name);
      expect(meta?.outputSchema).toBeUndefined();
    }
  });
});

// ===========================================================================
// Search Hints
// ===========================================================================

describe("tool-metadata-registry -- search hints", () => {
  const DEFERRABLE_TOOLS = [
    "sessions_list", "sessions_history", "sessions_send", "sessions_spawn",
    "subagents", "pipeline", "session_status", "session_search",
    "cron", "gateway", "image_analyze", "tts_synthesize",
    "transcribe_audio", "describe_video",
    "extract_document", "browser",
    "discord_action", "telegram_action", "slack_action", "whatsapp_action",
    "agents_manage", "obs_query", "sessions_manage", "memory_manage",
    "channels_manage", "tokens_manage", "models_manage", "skills_manage",
    "mcp_manage", "heartbeat_manage",
  ];

  for (const toolName of DEFERRABLE_TOOLS) {
    it(`registers searchHint for ${toolName}`, () => {
      const meta = getToolMetadata(toolName);
      expect(meta).toBeDefined();
      expect(meta!.searchHint).toBeDefined();
      expect(typeof meta!.searchHint).toBe("string");
      expect(meta!.searchHint!.length).toBeGreaterThan(0);
    });
  }

  for (const toolName of DEFERRABLE_TOOLS) {
    it(`${toolName} searchHint is max 80 chars`, () => {
      const hint = getToolMetadata(toolName)!.searchHint!;
      expect(hint.length).toBeLessThanOrEqual(80);
    });
  }

  for (const toolName of DEFERRABLE_TOOLS) {
    it(`${toolName} searchHint is lowercase`, () => {
      const hint = getToolMetadata(toolName)!.searchHint!;
      expect(hint).toBe(hint.toLowerCase());
    });
  }

  it("cron hint contains schedule-related synonyms", () => {
    const hint = getToolMetadata("cron")!.searchHint!;
    expect(hint).toContain("schedule");
    expect(hint).toContain("crontab");
    expect(hint).toContain("recurring");
  });

  it("browser hint contains chrome/headless synonyms", () => {
    const hint = getToolMetadata("browser")!.searchHint!;
    expect(hint).toContain("chrome");
    expect(hint).toContain("headless");
    expect(hint).toContain("screenshot");
  });

  it("obs_query hint contains diagnostics/monitoring synonyms", () => {
    const hint = getToolMetadata("obs_query")!.searchHint!;
    expect(hint).toContain("diagnostics");
    expect(hint).toContain("monitoring");
    expect(hint).toContain("metrics");
  });

  it("pipeline hint contains workflow/orchestrate synonyms", () => {
    const hint = getToolMetadata("pipeline")!.searchHint!;
    expect(hint).toContain("workflow");
    expect(hint).toContain("orchestrate");
  });

  it("tokens_manage hint contains auth/credential synonyms", () => {
    const hint = getToolMetadata("tokens_manage")!.searchHint!;
    expect(hint).toContain("token");
    expect(hint).toContain("credential");
  });

  it("searchHint does not overwrite existing isReadOnly metadata", () => {
    const cronMeta = getToolMetadata("cron")!;
    expect(cronMeta.searchHint).toBeDefined();
    expect(cronMeta.isReadOnly).toBe(false);

    const browserMeta = getToolMetadata("browser")!;
    expect(browserMeta.searchHint).toBeDefined();
    expect(browserMeta.isReadOnly).toBe(true);
  });

  it("searchHint does not overwrite existing maxResultSizeChars metadata", () => {
    const obsMeta = getToolMetadata("obs_query")!;
    expect(obsMeta.searchHint).toBeDefined();
    expect(obsMeta.maxResultSizeChars).toBe(100_000);
  });

  const CORE_TOOLS_NO_HINT = [
    "read", "edit", "write", "find", "ls", "apply_patch",
    "exec", "process", "message", "memory_search", "memory_store",
    "memory_get", "web_search", "web_fetch",
  ];

  for (const toolName of CORE_TOOLS_NO_HINT) {
    it(`CORE_TOOL ${toolName} does NOT have searchHint`, () => {
      const meta = getToolMetadata(toolName);
      expect(meta?.searchHint).toBeUndefined();
    });
  }

  it("at least 15 tools have searchHint registered", () => {
    const withHints = DEFERRABLE_TOOLS.filter(
      name => getToolMetadata(name)?.searchHint,
    );
    expect(withHints.length).toBeGreaterThanOrEqual(15);
  });
});

// ===========================================================================
// All 51 built-in tools have at least one metadata field
// ===========================================================================

describe("tool-metadata-registry -- completeness", () => {
  it("all 47 TOOL_SUMMARIES tools have at least one metadata field", () => {
    const ALL_TOOLS = [
      "read", "edit", "write", "grep", "find", "ls", "apply_patch",
      "exec", "process",
      "web_search", "web_fetch",
      "memory_search", "memory_store", "memory_get",
      "message",
      "sessions_list", "sessions_history", "sessions_send", "sessions_spawn",
      "subagents", "pipeline", "session_status", "session_search",
      "cron", "gateway", "image_analyze", "tts_synthesize",
      "transcribe_audio", "describe_video", "extract_document", "browser",
      "discord_action", "telegram_action", "slack_action", "whatsapp_action",
      "agents_manage", "obs_query", "sessions_manage", "memory_manage",
      "channels_manage", "tokens_manage", "models_manage", "skills_manage",
      "mcp_manage", "heartbeat_manage", "providers_manage",
      "discover_tools",
    ];

    expect(ALL_TOOLS.length).toBe(47);

    const missing: string[] = [];
    for (const tool of ALL_TOOLS) {
      const meta = getToolMetadata(tool);
      if (!meta) {
        missing.push(tool);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ===========================================================================
// Tool-Entry Schema metadata
// ===========================================================================

describe("tool-metadata-registry -- tool-entry schema metadata", () => {
  it.each([
    ["mcp_manage",       ["list", "status", "connect", "disconnect", "reconnect"], 9],
    ["agents_manage",    ["create", "get", "update", "delete", "suspend", "resume", "list"], 3],
    ["tokens_manage",    ["list", "create", "revoke", "rotate"], 3],
    ["providers_manage", ["list", "get", "create", "update", "delete", "enable", "disable"], 3],
    ["channels_manage",  ["list", "get", "enable", "disable", "restart", "configure"], 4],
    ["sessions_manage",  ["delete", "reset", "export", "compact"], 3],
    ["skills_manage",    ["list", "import", "delete", "create", "update"], 6],
    ["memory_manage",    ["stats", "browse", "delete", "flush", "export", "pin", "unpin"], 11],
    ["models_manage",    ["list", "test", "list_providers"], 3],
    ["heartbeat_manage", ["get", "update", "status", "trigger"], 21],
  ] as const)(
    "registers entry-shape metadata for %s",
    (name, validActions, validKeysCount) => {
      const meta = getToolMetadata(name);
      expect(meta?.validActions).toEqual(validActions);
      expect(meta?.validKeys).toBeDefined();
      expect(meta?.validKeys).toHaveLength(validKeysCount);
      expect(meta?.requiredByAction).toBeDefined();
    },
  );

  it("mcp_manage requiredByAction matches the connect / status / disconnect / reconnect spec", () => {
    const meta = getToolMetadata("mcp_manage");
    // `transport` is NOT unconditionally required at the pre-flight gate — it is
    // inferable (stdio from `command`, http from `url`) and the "command OR url"
    // requirement is transport-conditional, which a flat required-list cannot
    // express. Both are validated downstream by the handler's
    // validateConnectParams + transport inference. The gate enforces only the
    // unconditional field (server_name). See the comis-daniel 2026-07-09 incident:
    // a valid `connect(server_name, command:"npx", args:[...])` HARD-FAILED the
    // gate with "missing … transport" before the handler could infer stdio.
    expect(meta?.requiredByAction).toEqual({
      status: ["server_name"],
      connect: ["server_name"],
      disconnect: ["server_name"],
      reconnect: ["server_name"],
    });
  });

  it("pre-flight gate accepts a stdio connect with command but no explicit transport (comis-daniel 2026-07-09)", () => {
    const meta = getToolMetadata("mcp_manage");
    // Daniel's exact first attempt — valid, transport inferable as stdio.
    const result = validateToolEntry(
      { action: "connect", server_name: "weather", command: "npx", args: ["-y", "weather-mcp"] },
      meta,
    );
    expect(result).toBeUndefined(); // gate passes → handler infers transport=stdio
  });

  // Bridge-layer gate must accept the `auth` field that
  // the Type.Optional schema in mcp-manage-tool.ts:62 advertises and that
  // the tool-guide instructs agents to use for OAuth-required MCP servers
  // (commit 907014f). Without "auth" in validKeys the schema-validator
  // rejects every mcp_manage(auth:"oauth") call with `unknown key 'auth'`
  // before execute() runs — observed 2026-05-28 in daemon.1.log:393.
  it("mcp_manage validKeys includes 'auth' so OAuth-aware connects reach the daemon", () => {
    const meta = getToolMetadata("mcp_manage");
    expect(meta?.validKeys).toContain("auth");
  });

  it("validateToolEntry accepts mcp_manage(connect, auth:'oauth') against the live registry", () => {
    const meta = getToolMetadata("mcp_manage");
    const params = {
      action: "connect",
      server_name: "higgsfield",
      transport: "http",
      url: "https://mcp.higgsfield.ai/mcp",
      auth: "oauth",
    };
    expect(validateToolEntry(params, meta)).toBeUndefined();
  });

  it("heartbeat_manage registers an empty requiredByAction (every action's params are optional)", () => {
    const meta = getToolMetadata("heartbeat_manage");
    expect(meta?.requiredByAction).toEqual({});
  });

  it("memory_manage requires ids for delete and id for pin/unpin (scope filters have defaults)", () => {
    const meta = getToolMetadata("memory_manage");
    expect(meta?.requiredByAction).toEqual({ delete: ["ids"], pin: ["id"], unpin: ["id"] });
  });

  it("registry's validKeys covers every field listed in managed-sections schemaFragment.requiredByAction", async () => {
    // Cross-consistency parity: MANAGED_SECTIONS is on the public
    // @comis/core export, so we can assert that every field a managed-section
    // marks as required-for-this-redirect is at least a VALID key on the
    // registry's runtime gate.
    //
    // Why validKeys (not requiredByAction): managed-section schemaFragments
    // intentionally describe a single transport-specific happy path (e.g.
    // mcp_manage.connect lists [name, transport, command] for stdio; sse|http
    // would substitute `url` for `command`). The registry's requiredByAction
    // captures only the universal requirements; transport-specific handling
    // stays in the per-tool handler. The weaker but always-true invariant is:
    // every redirect-hint field is at least a recognized top-level key.
    const { MANAGED_SECTIONS } = await import("@comis/core");
    const sections = MANAGED_SECTIONS.filter((s) => s.schemaFragment?.requiredByAction);
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      const meta = getToolMetadata(section.tool);
      const validKeys = meta?.validKeys;
      const ms = section.schemaFragment!.requiredByAction!;
      expect(
        validKeys,
        `${section.tool}: validKeys missing on registry`,
      ).toBeDefined();
      for (const [action, fields] of Object.entries(ms)) {
        // Action must be in validActions if registered.
        if (meta?.validActions !== undefined) {
          expect(
            meta.validActions,
            `${section.tool}: managed-section action '${action}' not in registry's validActions`,
          ).toContain(action);
        }
        for (const f of fields) {
          expect(
            validKeys,
            `${section.tool}.${action}: managed-section field '${f}' is not a valid registry key`,
          ).toContain(f);
        }
      }
    }
  });
});

// ===========================================================================
// Co-discovery metadata
// ===========================================================================

// ===========================================================================
// Failure Detectors
//
// Per-tool failureDetector bodies registered (via spread-merge) on
// web_search + web_fetch. They are consulted in pi-event-bridge.ts BEFORE
// the tool:executed emit, over the RAW result — flagging a logically-failed
// result the SDK reported as success (isError:false). Each non-false return
// MUST carry a member of the closed 10-member ErrorKind union and the body
// MUST never throw.
// ===========================================================================

describe("tool-metadata-registry -- failure detectors", () => {
  // The closed 10-member ErrorKind union (log-fields.ts:56-66). A detector
  // returning anything outside this set (e.g. "rate_limited") fails the
  // valid-ErrorKind assertions below.
  const ERROR_KINDS = new Set<string>([
    "config", "network", "auth", "validation", "precondition",
    "timeout", "resource", "dependency", "internal", "platform",
  ]);

  const webSearchDetector = () => getToolMetadata("web_search")?.failureDetector;
  const webFetchDetector = () => getToolMetadata("web_fetch")?.failureDetector;

  it("registers a failureDetector on web_search and web_fetch", () => {
    expect(webSearchDetector()).toBeTypeOf("function");
    expect(webFetchDetector()).toBeTypeOf("function");
  });

  // -------------------------------------------------------------------------
  // web_search detector
  // -------------------------------------------------------------------------

  // A real web_search failure carries a top-level `error` MACHINE CODE plus a descriptive
  // `message`/`failures` — the human-readable reason (rate limit / blocked) lives in
  // message+failures, NOT in the stable `error` code. Detectors classify off those structured
  // fields, never the per-result snippets.
  it("web_search flags a rate-limit failure (structured error/message/failures) as a resource failure with provenance", () => {
    const detect = webSearchDetector()!;
    // Enriched verdict (P2/D2a): the rate-limit branch attributes the verdict to the
    // `message` field and reports the literal rule it matched — NOT a serialized RegExp.
    expect(
      detect(
        {
          error: "all_providers_failed",
          message: "All web_search providers failed: brave: Rate limit exceeded, retry later",
          failures: ["brave: rate limit exceeded"],
        },
        false,
      ),
    ).toEqual({
      errorKind: "resource",
      classifiedField: "message",
      matchedRule: "/rate limit|quota exceeded|too many requests/",
    });
    expect(
      detect(
        {
          error: "all_providers_failed",
          message: "All web_search providers failed: brave: quota exceeded for this key",
          failures: ["brave: quota exceeded for this key"],
        },
        false,
      ),
    ).toEqual({
      errorKind: "resource",
      classifiedField: "message",
      matchedRule: "/rate limit|quota exceeded|too many requests/",
    });
    expect(
      detect(
        {
          error: "all_providers_failed",
          message: "All web_search providers failed: brave: Too Many Requests",
          failures: ["brave: too many requests"],
        },
        false,
      ),
    ).toEqual({
      errorKind: "resource",
      classifiedField: "message",
      matchedRule: "/rate limit|quota exceeded|too many requests/",
    });
  });

  it("web_search flags a blocked/forbidden failure (structured fields) as a dependency failure attributed to error", () => {
    const detect = webSearchDetector()!;
    // The catch-all branch (top-level `error` present, no rate-limit token) attributes the
    // verdict to the structured `error` field. No `matchedRule`/`matchedToken` — it is the
    // default-once-`error`-is-present path, not a specific token/rule match.
    expect(
      detect(
        {
          error: "all_providers_failed",
          message: "All web_search providers failed: brave: blocked by provider",
          failures: ["brave: blocked by provider"],
        },
        false,
      ),
    ).toEqual({ errorKind: "dependency", classifiedField: "error" });
    expect(
      detect(
        { error: "all_providers_failed", message: "All web_search providers failed: brave: Forbidden" },
        false,
      ),
    ).toEqual({ errorKind: "dependency", classifiedField: "error" });
    expect(
      detect(
        { error: "all_providers_failed", message: "All web_search providers failed: brave: provider error: upstream down" },
        false,
      ),
    ).toEqual({ errorKind: "dependency", classifiedField: "error" });
    // A genuine top-level error with an unrecognised reason is STILL a real failure → dependency.
    expect(detect({ error: "invalid_provider", message: 'Invalid provider "x". Valid options: brave' }, false)).toEqual({
      errorKind: "dependency",
      classifiedField: "error",
    });
  });

  // REGRESSION (production session 678314278): a SUCCESSFUL web_search (results present, NO
  // top-level `error`) whose snippets contain "rate limit"/"blocked"/"forbidden" as legitimate
  // content must NOT be flagged. This FAILS on the body-substring detector.
  it("web_search does NOT flag a successful results body whose snippet contains rate-limit/blocked/forbidden text", () => {
    const detect = webSearchDetector()!;
    expect(
      detect(
        {
          provider: "brave",
          query: "q",
          results: [
            { title: "t", url: "https://e.com", snippet: "explains rate limit and blocked and forbidden behavior" },
          ],
          count: 1,
        },
        false,
      ),
    ).toBe(false);
  });

  it("web_search returns false for a normal results body and when isError is already set", () => {
    const detect = webSearchDetector()!;
    expect(detect({ results: [{ title: "x", url: "https://example.com" }] }, false)).toBe(false);
    // SDK already flagged it — the detector defers (returns false, no double-flag).
    expect(
      detect(
        { error: "all_providers_failed", message: "All web_search providers failed: brave: rate limit exceeded" },
        true,
      ),
    ).toBe(false);
  });

  it("web_search returns only valid closed-union ErrorKind members (never rate_limited)", () => {
    const detect = webSearchDetector()!;
    for (const reason of ["rate limit exceeded", "too many requests", "blocked", "provider error"]) {
      const out = detect(
        { error: "all_providers_failed", message: `All web_search providers failed: brave: ${reason}`, failures: [`brave: ${reason}`] },
        false,
      );
      expect(out).not.toBe(false);
      const kind = (out as { errorKind: string }).errorKind;
      expect(ERROR_KINDS.has(kind), `errorKind "${kind}" must be a closed-union member`).toBe(true);
      expect(kind).not.toBe("rate_limited");
    }
  });

  // -------------------------------------------------------------------------
  // web_fetch detector
  // -------------------------------------------------------------------------

  // A real web_fetch failure sets `error` (a descriptive string) and/or a numeric `status` >= 400.
  // Timeout text lives in the `error` string; the HTTP code is in `status`.
  it("web_fetch flags a timeout error string as a timeout failure attributed to error+rule", () => {
    const detect = webFetchDetector()!;
    // The error string is checked FIRST (before status). A timeout token in the error
    // attributes the verdict to the `error` field + the literal timeout rule.
    expect(detect({ url: "https://e.com", error: "Fetch failed: request timed out after 30s" }, false)).toEqual({
      errorKind: "timeout",
      classifiedField: "error",
      matchedRule: "/timed out|timeout/",
    });
    expect(detect({ url: "https://e.com", error: "Fetch failed: connection timeout" }, false)).toEqual({
      errorKind: "timeout",
      classifiedField: "error",
      matchedRule: "/timed out|timeout/",
    });
  });

  it("web_fetch flags a 408/504 status (no error string) as a timeout failure attributed to status+token", () => {
    const detect = webFetchDetector()!;
    // No `error` key → the status branch drives the verdict; the concrete HTTP code is
    // the matched token (P2/D2a: "504 returns classifiedField:'status', matchedToken:'504'").
    expect(detect({ url: "https://e.com", status: 504 }, false)).toEqual({
      errorKind: "timeout",
      classifiedField: "status",
      matchedToken: "504",
    });
    expect(detect({ url: "https://e.com", status: 408 }, false)).toEqual({
      errorKind: "timeout",
      classifiedField: "status",
      matchedToken: "408",
    });
  });

  it("web_fetch flags an error-string dependency failure attributed to error (no rule/token)", () => {
    const detect = webFetchDetector()!;
    // Non-timeout error string → dependency, attributed to the `error` field. No matchedRule
    // (it is the catch-all once `error` is a string and the timeout rule did not match).
    expect(detect({ url: "https://e.com", error: "SSRF blocked: private address" }, false)).toEqual({
      errorKind: "dependency",
      classifiedField: "error",
    });
    expect(detect({ url: "https://e.com", error: "Fetch failed: connection refused" }, false)).toEqual({
      errorKind: "dependency",
      classifiedField: "error",
    });
  });

  it("web_fetch flags a status-only dependency failure attributed to status+token (503/403/500)", () => {
    const detect = webFetchDetector()!;
    // No `error` key → status branch; the HTTP code is the matched token (P2/D2a:
    // "503 returns classifiedField:'status', matchedToken:'503'").
    expect(detect({ url: "https://e.com", status: 503 }, false)).toEqual({
      errorKind: "dependency",
      classifiedField: "status",
      matchedToken: "503",
    });
    expect(detect({ url: "https://e.com", status: 403 }, false)).toEqual({
      errorKind: "dependency",
      classifiedField: "status",
      matchedToken: "403",
    });
    // A 4xx/5xx status with no descriptive error is still a real failure.
    expect(detect({ url: "https://e.com", status: 500 }, false)).toEqual({
      errorKind: "dependency",
      classifiedField: "status",
      matchedToken: "500",
    });
  });

  // REGRESSION (production session 678314278): a SUCCESSFUL HTTP-200 fetch whose body text
  // contains a price like "403.92..." or the words blocked/forbidden/timeout/connection refused
  // as legitimate page CONTENT must NOT be flagged. These FAIL on the body-substring detector
  // (the IBM share price 403.92999267578 contains "403" → mis-flagged dependency).
  it("web_fetch does NOT flag a successful 200 body whose text contains a price like 403.92", () => {
    const detect = webFetchDetector()!;
    expect(
      detect(
        {
          url: "https://finance.yahoo.com/quote/IBM",
          status: 200,
          extractor: "readability",
          title: "IBM Stock Price",
          length: 51234,
          text: "MSFT ... IBM 403.92999267578 ... last close",
        },
        false,
      ),
    ).toBe(false);
  });

  it("web_fetch does NOT flag successful 200 bodies whose text contains blocked/forbidden/timeout/connection-refused as content", () => {
    const detect = webFetchDetector()!;
    for (const text of [
      "This article explains how requests get blocked by firewalls.",
      "HTTP 403 Forbidden errors and how to fix them — a tutorial.",
      "When a request timed out, here is what happens next.",
      "Troubleshooting a connection refused error in production.",
    ]) {
      expect(detect({ url: "https://e.com", status: 200, extractor: "readability", text }, false)).toBe(false);
    }
  });

  it("web_fetch returns false for a normal HTML body and when isError is already set", () => {
    const detect = webFetchDetector()!;
    expect(detect({ url: "https://e.com", status: 200, text: "<html><body>Hello world</body></html>" }, false)).toBe(false);
    expect(detect({ url: "https://e.com", status: 200, text: "plain text content with no failure signal" }, false)).toBe(false);
    expect(detect({ url: "https://e.com", error: "Fetch failed: request timed out" }, true)).toBe(false);
  });

  it("web_fetch returns only valid closed-union ErrorKind members", () => {
    const detect = webFetchDetector()!;
    for (const error of [
      "Fetch failed: timed out",
      "HTTP 403: forbidden",
      "Fetch failed: connection refused",
      "SSRF blocked: private address",
    ]) {
      const out = detect({ url: "https://e.com", error }, false);
      expect(out).not.toBe(false);
      const kind = (out as { errorKind: string }).errorKind;
      expect(ERROR_KINDS.has(kind), `errorKind "${kind}" must be a closed-union member`).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // Purity / no-throw: malformed results must not crash.
  // -------------------------------------------------------------------------

  it("both detectors are pure and never throw on malformed results", () => {
    for (const detect of [webSearchDetector()!, webFetchDetector()!]) {
      for (const malformed of [undefined, null, 42, true, { nested: { deep: 1 } }, []]) {
        let out: boolean | { errorKind: string } = false;
        expect(() => { out = detect(malformed, false) as typeof out; }, `threw on ${String(malformed)}`).not.toThrow();
        const isValid = out === false || (typeof out === "object" && out !== null && "errorKind" in out);
        expect(isValid, `detector returned a non-contract value for ${String(malformed)}`).toBe(true);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Spread-merge guardrails: count unchanged + sibling fields preserved.
  // -------------------------------------------------------------------------

  it("attaches detectors to pre-existing tool names without introducing new ones", () => {
    // The detectors spread-merge onto web_search / web_fetch, which are ALREADY
    // registered (see the read-only + MCP-export-policy sections). They must NOT
    // create a new tool name — the canonical "registers exactly 51 unique tools"
    // assertion (this file, first describe) is the absolute-count guardrail.
    // Asserting an absolute size HERE is fragile: validator/errorKind tests
    // earlier in this file pollute the module-level singleton with synthetic
    // tool names. The merge-not-create invariant is the load-bearing claim, so
    // assert THAT directly: every detector target is one of the 47 canonical
    // production tool names.
    const CANONICAL_TOOL_NAMES = new Set([
      "read", "edit", "write", "grep", "find", "ls", "apply_patch",
      "exec", "process",
      "web_search", "web_fetch",
      "memory_search", "memory_store", "memory_get",
      "message",
      "sessions_list", "sessions_history", "sessions_send", "sessions_spawn",
      "subagents", "pipeline", "session_status", "session_search",
      "cron", "gateway", "image_analyze", "tts_synthesize",
      "transcribe_audio", "describe_video", "extract_document", "browser",
      "discord_action", "telegram_action", "slack_action", "whatsapp_action",
      "agents_manage", "obs_query", "sessions_manage", "memory_manage",
      "channels_manage", "tokens_manage", "models_manage", "skills_manage",
      "mcp_manage", "heartbeat_manage", "providers_manage",
      "discover_tools",
    ]);
    expect(CANONICAL_TOOL_NAMES.size).toBe(47);
    for (const target of ["web_search", "web_fetch"]) {
      expect(
        CANONICAL_TOOL_NAMES.has(target),
        `detector target "${target}" must be a pre-existing canonical tool name`,
      ).toBe(true);
      expect(getToolMetadata(target)?.failureDetector).toBeTypeOf("function");
    }
  });

  it("preserves web_search sibling fields (isReadOnly + mcpExportPolicy) alongside the new detector", () => {
    const meta = getToolMetadata("web_search");
    expect(meta).toBeDefined();
    expect(meta!.isReadOnly).toBe(true);
    expect(meta!.mcpExportPolicy).toBe("safe");
    expect(meta!.maxResultSizeChars).toBe(50_000);
    expect(meta!.failureDetector).toBeTypeOf("function");
  });

  it("preserves web_fetch sibling fields (isReadOnly + mcpExportPolicy) alongside the new detector", () => {
    const meta = getToolMetadata("web_fetch");
    expect(meta).toBeDefined();
    expect(meta!.isReadOnly).toBe(true);
    expect(meta!.mcpExportPolicy).toBe("safe");
    expect(meta!.maxResultSizeChars).toBe(150_000);
    expect(meta!.failureDetector).toBeTypeOf("function");
  });
});

describe("tool-metadata-registry -- co-discovery metadata", () => {
  it("models_manage has coDiscoverWith pointing to agents_manage", () => {
    const meta = getToolMetadata("models_manage");
    expect(meta).toBeDefined();
    expect(meta!.coDiscoverWith).toContain("agents_manage");
  });

  it("agents_manage has coDiscoverWith pointing to models_manage", () => {
    const meta = getToolMetadata("agents_manage");
    expect(meta).toBeDefined();
    expect(meta!.coDiscoverWith).toContain("models_manage");
  });
});

// ===========================================================================
// Gateway validateInput -- patchable path hints
// ===========================================================================

describe("tool-metadata-registry -- gateway validateInput patchable path hints", () => {
  it("redirects to agents_manage and includes patchable paths when rejecting immutable agents path", async () => {
    const meta = getToolMetadata("gateway");
    expect(meta?.validateInput).toBeDefined();

    const error = await meta!.validateInput!({
      action: "patch",
      section: "agents",
      key: "default",
    });

    // Rejection points to the dedicated agents_manage tool with a
    // parameter-correct example AND lists the override paths for in-place
    // updates of an existing agent. discover_tools clause dropped from
    // Recovery framing (Anthropic Sonnet/Opus 4.x payloads no longer
    // contain that tool).
    expect(error).toBeDefined();
    expect(error).toContain("Cannot patch immutable config path");
    expect(error).toContain('Use the "agents_manage" tool');
    expect(error).toContain("Recovery: call agents_manage(");
    expect(error).not.toContain("discover_tools");
    expect(error).toContain("agents.default.model");
    expect(error).toContain("agents.default.provider");
  });

  it("returns no redirect or patchable hint for sections without managed tool or overrides", async () => {
    const meta = getToolMetadata("gateway");
    const error = await meta!.validateInput!({
      action: "patch",
      section: "security",
      key: "audit.enabled",
    });

    expect(error).toBeDefined();
    expect(error).toContain("Cannot patch immutable config path");
    expect(error).not.toContain("Patchable:");
    expect(error).not.toContain("Use the");
  });

  it("allows patch on mutable override path (no validation error)", async () => {
    const meta = getToolMetadata("gateway");
    const error = await meta!.validateInput!({
      action: "patch",
      section: "agents",
      key: "default.model",
    });

    // Should pass validation -- model is now a mutable override
    expect(error).toBeUndefined();
  });
});

describe("tool-metadata-registry -- mcp_manage env parity", () => {
  // The registry validKeys is a SECOND source of truth beside McpManageToolParams; when the
  // tool schema gained `env` (so a stdio server can receive credentials), this list must too —
  // else the bridge validator rejects `env` with "[invalid_value] unknown key 'env'" BEFORE
  // execute() runs, and a credentialed stdio MCP (e.g. example-mcp) can never be installed.
  it("mcp_manage validKeys includes env", () => {
    expect(getToolMetadata("mcp_manage")?.validKeys).toContain("env");
  });

  it("validateToolEntry accepts a connect carrying env (no 'unknown key env' rejection)", () => {
    const meta = getToolMetadata("mcp_manage")!;
    const error = validateToolEntry(
      {
        action: "connect",
        server_name: "svc-mcp",
        transport: "stdio",
        command: "npx",
        args: ["-y", "example-mcp"],
        env: { SERVICE_PASSWORD: "${SERVICE_PASSWORD}" },
      },
      meta,
    );
    expect(error).toBeUndefined();
  });
});
