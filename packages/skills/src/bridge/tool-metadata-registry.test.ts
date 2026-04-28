// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeAll, vi } from "vitest";
import { getAllToolMetadata, getToolMetadata, truncateContentBlocks, registerToolMetadata, TypedEventBus } from "@comis/core";
import type { EventMap } from "@comis/core";
import { Type } from "@sinclair/typebox";
import { registerAllToolMetadata } from "./tool-metadata-registry.js";
import { wrapWithMetadataEnforcement } from "./tool-metadata-enforcement.js";
import { wrapWithAudit } from "./tool-audit.js";
import { GATEWAY_ACTIONS } from "../builtin/platform/gateway-tool.js";

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
  it("registers exactly 51 unique tools (registry count assertion)", () => {
    const all = getAllToolMetadata();
    expect(all.size).toBe(51);
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
  const READ_ONLY_TOOLS = [
    "read", "grep", "find", "ls",
    "web_search", "web_fetch", "browser",
    "memory_search", "memory_get", "session_search",
    "sessions_list", "session_status", "sessions_history", "agents_list",
    "ctx_search", "ctx_inspect", "ctx_expand", "ctx_recall",
    "image_analyze", "describe_video", "extract_document", "transcribe_audio",
    "obs_query", "models_manage",
    "discover_tools",
  ];

  it("registers all 25 read-only tools with isReadOnly: true", () => {
    expect(READ_ONLY_TOOLS).toHaveLength(25);
    for (const name of READ_ONLY_TOOLS) {
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
  // Drift-regression guards (quick-260420-iv2)
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
    "subagents", "pipeline", "session_status", "session_search", "agents_list",
    "cron", "gateway", "image_analyze", "tts_synthesize",
    "transcribe_audio", "describe_video",
    "extract_document", "browser",
    "ctx_search", "ctx_inspect", "ctx_expand", "ctx_recall",
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
  it("all 51 TOOL_SUMMARIES tools have at least one metadata field", () => {
    const ALL_TOOLS = [
      "read", "edit", "write", "grep", "find", "ls", "apply_patch",
      "exec", "process",
      "web_search", "web_fetch",
      "memory_search", "memory_store", "memory_get",
      "message",
      "sessions_list", "sessions_history", "sessions_send", "sessions_spawn",
      "subagents", "pipeline", "session_status", "session_search", "agents_list",
      "cron", "gateway", "image_analyze", "tts_synthesize",
      "transcribe_audio", "describe_video", "extract_document", "browser",
      "discord_action", "telegram_action", "slack_action", "whatsapp_action",
      "ctx_search", "ctx_inspect", "ctx_expand", "ctx_recall",
      "agents_manage", "obs_query", "sessions_manage", "memory_manage",
      "channels_manage", "tokens_manage", "models_manage", "skills_manage",
      "mcp_manage", "heartbeat_manage",
      "discover_tools",
    ];

    expect(ALL_TOOLS.length).toBe(51);

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
// Co-discovery metadata (quick-260414-ppo)
// ===========================================================================

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
// Gateway validateInput -- patchable path hints (quick-260414-ppo)
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

    // Updated for quick-260425-t40: rejection now points to the dedicated
    // agents_manage tool with a parameter-correct example AND lists the
    // override paths for in-place updates of an existing agent.
    // Updated for 260428-oyc: discover_tools clause dropped from Recovery framing
    // (Anthropic Sonnet/Opus 4.x payloads no longer contain that tool).
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
