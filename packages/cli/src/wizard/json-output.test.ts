import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:os", () => ({
  homedir: () => "/mock/home",
}));

vi.mock("@comis/core", () => ({
  safePath: (...parts: string[]) => parts.join("/"),
}));

// Import after mocks are set up
const { buildJsonOutput, buildJsonError } = await import("./json-output.js");

import type { WizardState, GatewayConfig } from "./types.js";
import { INITIAL_STATE } from "./types.js";

function makeState(overrides: Partial<WizardState> = {}): WizardState {
  return { ...INITIAL_STATE, ...overrides };
}

describe("buildJsonOutput", () => {
  it("returns status 'success'", () => {
    const result = buildJsonOutput(makeState());
    expect(result.status).toBe("success");
  });

  it("includes configPath and envPath derived from homedir", () => {
    const result = buildJsonOutput(makeState());
    expect(result.configPath).toBe("/mock/home/.comis/config.yaml");
    expect(result.envPath).toBe("/mock/home/.comis/.env");
  });

  it("uses agent name and model from state", () => {
    const state = makeState({
      agentName: "my-bot",
      model: "claude-opus-4-20250514",
    });
    const result = buildJsonOutput(state);

    expect(result.agent?.name).toBe("my-bot");
    expect(result.agent?.model).toBe("claude-opus-4-20250514");
  });

  it("defaults agent name to 'comis-agent' and model to 'default'", () => {
    const result = buildJsonOutput(makeState());

    expect(result.agent?.name).toBe("comis-agent");
    expect(result.agent?.model).toBe("default");
  });

  describe("gateway URL", () => {
    it("computes loopback URL as ws://127.0.0.1:PORT", () => {
      const state = makeState({
        gateway: {
          port: 4766,
          bindMode: "loopback",
          authMethod: "token",
        },
      });
      const result = buildJsonOutput(state);
      expect(result.gateway?.url).toBe("ws://127.0.0.1:4766");
    });

    it("computes lan URL as ws://0.0.0.0:PORT", () => {
      const state = makeState({
        gateway: {
          port: 9000,
          bindMode: "lan",
          authMethod: "token",
        },
      });
      const result = buildJsonOutput(state);
      expect(result.gateway?.url).toBe("ws://0.0.0.0:9000");
    });

    it("computes custom URL as ws://CUSTOM_IP:PORT", () => {
      const state = makeState({
        gateway: {
          port: 3000,
          bindMode: "custom",
          customIp: "192.168.1.50",
          authMethod: "token",
        },
      });
      const result = buildJsonOutput(state);
      expect(result.gateway?.url).toBe("ws://192.168.1.50:3000");
    });

    it("falls back to 127.0.0.1 for custom without customIp", () => {
      const state = makeState({
        gateway: {
          port: 3000,
          bindMode: "custom",
          authMethod: "token",
        },
      });
      const result = buildJsonOutput(state);
      expect(result.gateway?.url).toBe("ws://127.0.0.1:3000");
    });

    it("defaults port to 4766 when not specified", () => {
      const state = makeState({
        gateway: {
          bindMode: "loopback",
          authMethod: "token",
        } as GatewayConfig,
      });
      const result = buildJsonOutput(state);
      expect(result.gateway?.url).toBe("ws://127.0.0.1:4766");
    });
  });

  describe("gateway token", () => {
    it("includes token when authMethod is 'token'", () => {
      const state = makeState({
        gateway: {
          port: 4766,
          bindMode: "loopback",
          authMethod: "token",
          token: "my-secret-token",
        },
      });
      const result = buildJsonOutput(state);
      expect(result.gateway?.token).toBe("my-secret-token");
    });

    it("omits token when authMethod is 'password'", () => {
      const state = makeState({
        gateway: {
          port: 4766,
          bindMode: "loopback",
          authMethod: "password",
          password: "my-password",
          token: "should-not-appear",
        },
      });
      const result = buildJsonOutput(state);
      expect(result.gateway?.token).toBeUndefined();
    });

    it("omits token when authMethod is 'token' but no token value", () => {
      const state = makeState({
        gateway: {
          port: 4766,
          bindMode: "loopback",
          authMethod: "token",
        },
      });
      const result = buildJsonOutput(state);
      expect(result.gateway?.token).toBeUndefined();
    });
  });

  describe("channels", () => {
    it("returns channel type strings", () => {
      const state = makeState({
        channels: [{ type: "telegram" }, { type: "discord" }, { type: "slack" }],
      });
      const result = buildJsonOutput(state);
      expect(result.channels).toEqual(["telegram", "discord", "slack"]);
    });

    it("returns empty array when no channels", () => {
      const result = buildJsonOutput(makeState());
      expect(result.channels).toEqual([]);
    });
  });

  describe("daemon and health", () => {
    it("daemon is undefined initially", () => {
      const result = buildJsonOutput(makeState());
      expect(result.daemon).toBeUndefined();
    });

    it("health is undefined initially", () => {
      const result = buildJsonOutput(makeState());
      expect(result.health).toBeUndefined();
    });
  });

  describe("gateway is undefined when not configured", () => {
    it("returns undefined gateway when no gateway in state", () => {
      const result = buildJsonOutput(makeState());
      expect(result.gateway).toBeUndefined();
    });
  });

  describe("configDir override", () => {
    it("uses custom configDir for paths", () => {
      const result = buildJsonOutput(makeState(), {
        configDir: "/custom/path",
      });
      expect(result.configPath).toBe("/custom/path/config.yaml");
      expect(result.envPath).toBe("/custom/path/.env");
    });
  });
});

describe("buildJsonError", () => {
  it("returns status 'error' with message", () => {
    const result = buildJsonError("Something failed");
    expect(result.status).toBe("error");
    expect(result.error?.message).toBe("Something failed");
  });

  it("includes field when provided", () => {
    const result = buildJsonError("Bad port", "port");
    expect(result.error?.field).toBe("port");
  });

  it("omits field when not provided", () => {
    const result = buildJsonError("General error");
    expect(result.error?.field).toBeUndefined();
  });
});
