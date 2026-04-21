// SPDX-License-Identifier: Apache-2.0
/**
 * Comprehensive tests for non-interactive mode.
 *
 * Covers:
 * - validateNonInteractiveOptions: all error conditions, field names, and valid paths
 * - buildNonInteractiveState: all defaults, overrides, flag combinations
 * - NonInteractivePrompter: all methods, quiet/non-quiet modes
 * - NonInteractiveError: class properties
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@comis/core", () => ({
  safePath: vi.fn((...parts: string[]) => parts.join("/")),
}));
vi.mock("node:os", () => ({ homedir: vi.fn(() => "/home/test") }));
vi.mock("node:crypto", () => ({
  randomBytes: vi.fn(() => ({ toString: () => "ab".repeat(24) })),
}));

import {
  validateNonInteractiveOptions,
  buildNonInteractiveState,
  NonInteractivePrompter,
  NonInteractiveError,
} from "./non-interactive.js";
import type { NonInteractiveOptions } from "./non-interactive.js";

// ---------- Helpers ----------

/** Build a minimal valid options set that passes validation. */
function validOpts(overrides?: Partial<NonInteractiveOptions>): NonInteractiveOptions {
  return {
    nonInteractive: true,
    acceptRisk: true,
    provider: "anthropic",
    apiKey: "sk-ant-test-key",
    ...overrides,
  };
}

// ==========================================================================
// validateNonInteractiveOptions
// ==========================================================================

describe("validateNonInteractiveOptions", () => {
  it("throws NonInteractiveError with field 'acceptRisk' when acceptRisk=false", () => {
    const opts = validOpts({ acceptRisk: false });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("acceptRisk");
    }
  });

  it("throws NonInteractiveError with field 'provider' when provider is missing", () => {
    const opts = validOpts({ provider: undefined });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("provider");
    }
  });

  it("throws NonInteractiveError with field 'provider' when provider is empty string", () => {
    const opts = validOpts({ provider: "" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("provider");
    }
  });

  it("throws NonInteractiveError with field 'gatewayPort' when port is invalid", () => {
    const opts = validOpts({ gatewayPort: 80 });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("gatewayPort");
    }
  });

  it("throws NonInteractiveError with field 'agentName' when agent name is invalid", () => {
    const opts = validOpts({ agentName: "-bad" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("agentName");
    }
  });

  it("throws NonInteractiveError with field 'gatewayPassword' when auth=password but no password", () => {
    const opts = validOpts({ gatewayAuth: "password" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("gatewayPassword");
    }
  });

  it("throws NonInteractiveError with field 'resetScope' when resetScope set without reset=true", () => {
    const opts = validOpts({ resetScope: "full" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("resetScope");
    }
  });

  it("throws NonInteractiveError for missing telegram token", () => {
    const opts = validOpts({ channels: ["telegram"] });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("telegramToken");
    }
  });

  it("throws NonInteractiveError for missing discord token", () => {
    const opts = validOpts({ channels: ["discord"] });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("discordToken");
    }
  });

  it("throws NonInteractiveError for missing slack bot token", () => {
    const opts = validOpts({ channels: ["slack"] });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("slackBotToken");
    }
  });

  it("throws NonInteractiveError for missing slack app token when bot token present", () => {
    const opts = validOpts({ channels: ["slack"], slackBotToken: "xoxb-test" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("slackAppToken");
    }
  });

  it("throws NonInteractiveError for missing line token", () => {
    const opts = validOpts({ channels: ["line"] });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("lineToken");
    }
  });

  it("throws NonInteractiveError for missing line secret when token present", () => {
    const opts = validOpts({ channels: ["line"], lineToken: "line-tok" });
    expect(() => validateNonInteractiveOptions(opts)).toThrow(NonInteractiveError);
    try {
      validateNonInteractiveOptions(opts);
    } catch (e) {
      expect((e as NonInteractiveError).field).toBe("lineSecret");
    }
  });

  it("does NOT throw for whatsapp, signal, or irc channels (no tokens needed)", () => {
    const opts = validOpts({ channels: ["whatsapp", "signal", "irc"] });
    expect(() => validateNonInteractiveOptions(opts)).not.toThrow();
  });

  it("does NOT throw when all required flags are valid", () => {
    const opts = validOpts({
      gatewayPort: 9443,
      agentName: "my-agent",
      channels: ["telegram"],
      telegramToken: "123:ABC",
    });
    expect(() => validateNonInteractiveOptions(opts)).not.toThrow();
  });

  it("does NOT throw for unknown provider (forward compatibility)", () => {
    const opts = validOpts({ provider: "future-provider-xyz" });
    expect(() => validateNonInteractiveOptions(opts)).not.toThrow();
  });
});

// ==========================================================================
// buildNonInteractiveState
// ==========================================================================

describe("buildNonInteractiveState", () => {
  it("returns state with flow='advanced' by default", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.flow).toBe("advanced");
  });

  it("returns state with flow='quickstart' when quick=true", () => {
    const state = buildNonInteractiveState(validOpts({ quick: true }));
    expect(state.flow).toBe("quickstart");
  });

  it("builds provider config with id and apiKey", () => {
    const state = buildNonInteractiveState(validOpts({ provider: "openai", apiKey: "sk-test" }));
    expect(state.provider).toBeDefined();
    expect(state.provider!.id).toBe("openai");
    expect(state.provider!.apiKey).toBe("sk-test");
  });

  it("uses default agent name 'comis-agent' when not specified", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.agentName).toBe("comis-agent");
  });

  it("uses custom agent name when provided", () => {
    const state = buildNonInteractiveState(validOpts({ agentName: "my-bot" }));
    expect(state.agentName).toBe("my-bot");
  });

  it("uses RECOMMENDED_MODELS entry for provider when model not specified", () => {
    const state = buildNonInteractiveState(validOpts({ provider: "anthropic" }));
    expect(state.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("uses RECOMMENDED_MODELS for openai provider", () => {
    const state = buildNonInteractiveState(validOpts({ provider: "openai" }));
    expect(state.model).toBe("gpt-4o");
  });

  it("uses custom model when opts.model is provided", () => {
    const state = buildNonInteractiveState(validOpts({ model: "custom-model-v2" }));
    expect(state.model).toBe("custom-model-v2");
  });

  it("defaults model to 'default' for unknown provider without model flag", () => {
    const state = buildNonInteractiveState(validOpts({ provider: "unknown-provider" }));
    expect(state.model).toBe("default");
  });

  it("uses gateway defaults: port=4766, bindMode='loopback', authMethod='token'", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.gateway).toBeDefined();
    expect(state.gateway!.port).toBe(4766);
    expect(state.gateway!.bindMode).toBe("loopback");
    expect(state.gateway!.authMethod).toBe("token");
  });

  it("auto-generates token (48 hex chars) when no gatewayToken provided", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.gateway!.token).toBe("ab".repeat(24));
  });

  it("uses explicit gatewayToken when provided", () => {
    const state = buildNonInteractiveState(validOpts({ gatewayToken: "my-explicit-token" }));
    expect(state.gateway!.token).toBe("my-explicit-token");
  });

  it("sets password on gateway config when password auth", () => {
    const state = buildNonInteractiveState(
      validOpts({ gatewayAuth: "password", gatewayPassword: "secret123" }),
    );
    expect(state.gateway!.authMethod).toBe("password");
    expect(state.gateway!.password).toBe("secret123");
    expect(state.gateway!.token).toBeUndefined();
  });

  it("builds channels from opts.channels with correct types and tokens", () => {
    const state = buildNonInteractiveState(
      validOpts({
        channels: ["telegram", "discord"],
        telegramToken: "tg-tok",
        discordToken: "dc-tok",
      }),
    );
    expect(state.channels).toHaveLength(2);
    expect(state.channels![0]).toEqual({
      type: "telegram",
      botToken: "tg-tok",
      validated: false,
    });
    expect(state.channels![1]).toEqual({
      type: "discord",
      botToken: "dc-tok",
      validated: false,
    });
  });

  it("builds slack channel with both bot and app tokens", () => {
    const state = buildNonInteractiveState(
      validOpts({
        channels: ["slack"],
        slackBotToken: "xoxb-tok",
        slackAppToken: "xapp-tok",
      }),
    );
    expect(state.channels![0]).toEqual({
      type: "slack",
      botToken: "xoxb-tok",
      appToken: "xapp-tok",
      validated: false,
    });
  });

  it("builds line channel with token and secret", () => {
    const state = buildNonInteractiveState(
      validOpts({
        channels: ["line"],
        lineToken: "line-tok",
        lineSecret: "line-sec",
      }),
    );
    expect(state.channels![0]).toEqual({
      type: "line",
      botToken: "line-tok",
      channelSecret: "line-sec",
      validated: false,
    });
  });

  it("builds tokenless channels (whatsapp, signal, irc) correctly", () => {
    const state = buildNonInteractiveState(
      validOpts({ channels: ["whatsapp", "signal", "irc"] }),
    );
    expect(state.channels).toHaveLength(3);
    expect(state.channels![0]).toEqual({ type: "whatsapp", validated: false });
    expect(state.channels![1]).toEqual({ type: "signal", validated: false });
    expect(state.channels![2]).toEqual({ type: "irc", validated: false });
  });

  it("defaults dataDir to homedir/.comis/data", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.dataDir).toBe("/home/test/.comis/data");
  });

  it("uses custom dataDir when provided", () => {
    const state = buildNonInteractiveState(validOpts({ dataDir: "/custom/data" }));
    expect(state.dataDir).toBe("/custom/data");
  });

  it("includes all 10 interactive steps in completedSteps", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.completedSteps).toEqual([
      "welcome",
      "detect-existing",
      "flow-select",
      "provider",
      "credentials",
      "agent",
      "channels",
      "gateway",
      "workspace",
      "review",
    ]);
  });

  it("sets skipHealth from opts", () => {
    const stateWithSkip = buildNonInteractiveState(validOpts({ skipHealth: true }));
    expect(stateWithSkip.skipHealth).toBe(true);

    const stateWithoutSkip = buildNonInteractiveState(validOpts({ skipHealth: false }));
    expect(stateWithoutSkip.skipHealth).toBe(false);
  });

  it("sets existingConfigAction='fresh' and resetScope when reset=true", () => {
    const state = buildNonInteractiveState(
      validOpts({ reset: true, resetScope: "full" }),
    );
    expect(state.existingConfigAction).toBe("fresh");
    expect(state.resetScope).toBe("full");
  });

  it("defaults resetScope to 'config' when reset=true without explicit scope", () => {
    const state = buildNonInteractiveState(validOpts({ reset: true }));
    expect(state.resetScope).toBe("config");
  });

  it("sets existingConfigAction=undefined when reset is false", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.existingConfigAction).toBeUndefined();
    expect(state.resetScope).toBeUndefined();
  });

  it("sets riskAccepted=true", () => {
    const state = buildNonInteractiveState(validOpts());
    expect(state.riskAccepted).toBe(true);
  });

  it("sets provider validated based on skipValidation", () => {
    const stateSkipped = buildNonInteractiveState(validOpts({ skipValidation: true }));
    expect(stateSkipped.provider!.validated).toBe(true);

    const stateNotSkipped = buildNonInteractiveState(validOpts({ skipValidation: false }));
    expect(stateNotSkipped.provider!.validated).toBe(false);
  });
});

// ==========================================================================
// NonInteractivePrompter
// ==========================================================================

describe("NonInteractivePrompter", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it("intro(), outro(), note() are no-ops (do not throw)", () => {
    const p = new NonInteractivePrompter(validOpts());
    expect(() => p.intro("test")).not.toThrow();
    expect(() => p.outro("test")).not.toThrow();
    expect(() => p.note("test", "title")).not.toThrow();
  });

  describe("select()", () => {
    it("returns 'yes' option when startDaemon=true for daemon start message", async () => {
      const p = new NonInteractivePrompter(validOpts({ startDaemon: true }));
      const result = await p.select({
        message: "Start the Comis daemon now?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      });
      expect(result).toBe("yes");
    });

    it("returns 'no' option when startDaemon=false for daemon start message", async () => {
      const p = new NonInteractivePrompter(validOpts({ startDaemon: false }));
      const result = await p.select({
        message: "Start the Comis daemon now?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "no", label: "No" },
        ],
      });
      expect(result).toBe("no");
    });

    it("returns initialValue if set for other prompts", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.select({
        message: "Choose something",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
        initialValue: "b",
      });
      expect(result).toBe("b");
    });

    it("returns first option when no initialValue for other prompts", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.select({
        message: "Choose something",
        options: [
          { value: "first", label: "First" },
          { value: "second", label: "Second" },
        ],
      });
      expect(result).toBe("first");
    });
  });

  describe("multiselect()", () => {
    it("returns initialValues if set", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.multiselect({
        message: "Select items",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
          { value: "c", label: "C" },
        ],
        initialValues: ["a", "c"],
      });
      expect(result).toEqual(["a", "c"]);
    });

    it("returns all options when no initialValues", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.multiselect({
        message: "Select items",
        options: [
          { value: "x", label: "X" },
          { value: "y", label: "Y" },
        ],
      });
      expect(result).toEqual(["x", "y"]);
    });
  });

  describe("text()", () => {
    it("returns defaultValue when available", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.text({
        message: "Enter something",
        defaultValue: "my-default",
      });
      expect(result).toBe("my-default");
    });

    it("throws NonInteractiveError when no default", async () => {
      const p = new NonInteractivePrompter(validOpts());
      await expect(p.text({ message: "Enter something" })).rejects.toThrow(
        NonInteractiveError,
      );
    });
  });

  describe("password()", () => {
    it("always throws NonInteractiveError", async () => {
      const p = new NonInteractivePrompter(validOpts());
      await expect(p.password({ message: "Enter password" })).rejects.toThrow(
        NonInteractiveError,
      );
    });
  });

  describe("confirm()", () => {
    it("returns true for risk-related messages", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.confirm({ message: "Do you acknowledge the risk?" });
      expect(result).toBe(true);
    });

    it("returns false for shell completion messages", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.confirm({ message: "Enable shell completion?" });
      expect(result).toBe(false);
    });

    it("returns initialValue for other prompts when set", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.confirm({ message: "Some question?", initialValue: true });
      expect(result).toBe(true);
    });

    it("returns false for other prompts when no initialValue", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.confirm({ message: "Some question?" });
      expect(result).toBe(false);
    });
  });

  describe("spinner()", () => {
    it("returns no-op spinner in quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), true);
      const s = p.spinner();
      expect(() => s.start("test")).not.toThrow();
      expect(() => s.update("test")).not.toThrow();
      expect(() => s.stop("test")).not.toThrow();
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("writes to stderr in non-quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), false);
      const s = p.spinner();
      s.start("starting...");
      expect(stderrSpy).toHaveBeenCalledWith("  starting...\n");
      s.update("updating...");
      expect(stderrSpy).toHaveBeenCalledWith("  updating...\n");
      s.stop("done");
      expect(stderrSpy).toHaveBeenCalledWith("  done\n");
    });
  });

  describe("group()", () => {
    it("executes thunks sequentially and returns results", async () => {
      const p = new NonInteractivePrompter(validOpts());
      const result = await p.group({
        name: async () => "Alice",
        age: async () => 30,
      });
      expect(result).toEqual({ name: "Alice", age: 30 });
    });
  });

  describe("log", () => {
    it("error always writes to stderr even in quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), true);
      p.log.error("something broke");
      expect(stderrSpy).toHaveBeenCalledWith("  ERROR: something broke\n");
    });

    it("info is a no-op in quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), true);
      p.log.info("info message");
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("warn is a no-op in quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), true);
      p.log.warn("warning");
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("success is a no-op in quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), true);
      p.log.success("done");
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("info writes to stderr in non-quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), false);
      p.log.info("some info");
      expect(stderrSpy).toHaveBeenCalledWith("  some info\n");
    });

    it("warn writes to stderr in non-quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), false);
      p.log.warn("a warning");
      expect(stderrSpy).toHaveBeenCalledWith("  WARN: a warning\n");
    });

    it("success writes to stderr in non-quiet mode", () => {
      const p = new NonInteractivePrompter(validOpts(), false);
      p.log.success("yay");
      expect(stderrSpy).toHaveBeenCalledWith("  yay\n");
    });
  });
});

// ==========================================================================
// NonInteractiveError
// ==========================================================================

describe("NonInteractiveError", () => {
  it("has correct name 'NonInteractiveError'", () => {
    const err = new NonInteractiveError("test message", "testField");
    expect(err.name).toBe("NonInteractiveError");
  });

  it("has field property set", () => {
    const err = new NonInteractiveError("test", "myField");
    expect(err.field).toBe("myField");
  });

  it("has correct message", () => {
    const err = new NonInteractiveError("something went wrong", "x");
    expect(err.message).toBe("something went wrong");
  });

  it("is an instance of Error", () => {
    const err = new NonInteractiveError("test", "field");
    expect(err).toBeInstanceOf(Error);
  });
});
