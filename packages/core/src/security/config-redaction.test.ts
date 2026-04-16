import { describe, it, expect } from "vitest";
import { redactConfigSecrets } from "./config-redaction.js";

describe("redactConfigSecrets", () => {
  it("redacts top-level secret field", () => {
    const config = { name: "comis", secret: "super-secret-value" };
    const result = redactConfigSecrets(config);
    expect(result.secret).toBe("[REDACTED]");
    expect(result.name).toBe("comis");
  });

  it("redacts nested gateway.tokens[0].secret", () => {
    const config = {
      gateway: {
        tokens: [
          { id: "cli", secret: "tok-abc-123", scopes: ["rpc"] },
          { id: "admin", secret: "tok-xyz-789", scopes: ["admin"] },
        ],
      },
    };
    const result = redactConfigSecrets(config);
    expect(result.gateway.tokens[0].secret).toBe("[REDACTED]");
    expect(result.gateway.tokens[1].secret).toBe("[REDACTED]");
    expect(result.gateway.tokens[0].id).toBe("cli");
    expect(result.gateway.tokens[0].scopes).toEqual(["rpc"]);
  });

  it("redacts channels.telegram.botToken", () => {
    const config = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123456:ABC-DEF",
        },
      },
    };
    const result = redactConfigSecrets(config);
    expect(result.channels.telegram.botToken).toBe("[REDACTED]");
    expect(result.channels.telegram.enabled).toBe(true);
  });

  it("redacts webhooks.token (matches *token pattern)", () => {
    const config = {
      webhooks: {
        enabled: true,
        token: "hmac-secret-token-value",
      },
    };
    const result = redactConfigSecrets(config);
    expect(result.webhooks.token).toBe("[REDACTED]");
    expect(result.webhooks.enabled).toBe(true);
  });

  it("redacts channels.discord.appSecret", () => {
    const config = {
      channels: {
        discord: {
          enabled: false,
          appSecret: "discord-app-secret-value",
        },
      },
    };
    const result = redactConfigSecrets(config);
    expect(result.channels.discord.appSecret).toBe("[REDACTED]");
    expect(result.channels.discord.enabled).toBe(false);
  });

  it("does NOT redact non-secret fields", () => {
    const config = {
      name: "comis",
      host: "0.0.0.0",
      port: 4766,
      enabled: true,
      gateway: { host: "localhost", port: 4766 },
    };
    const result = redactConfigSecrets(config);
    expect(result.name).toBe("comis");
    expect(result.host).toBe("0.0.0.0");
    expect(result.port).toBe(4766);
    expect(result.enabled).toBe(true);
    expect(result.gateway.host).toBe("localhost");
    expect(result.gateway.port).toBe(4766);
  });

  it("does not mutate the input object", () => {
    const config = {
      gateway: {
        tokens: [{ id: "cli", secret: "original-secret" }],
      },
    };
    const result = redactConfigSecrets(config);
    expect(result.gateway.tokens[0].secret).toBe("[REDACTED]");
    expect(config.gateway.tokens[0].secret).toBe("original-secret");
  });

  it("handles null and undefined values without throwing", () => {
    const config = {
      name: "test",
      secret: null as unknown as string,
      nested: { token: undefined as unknown as string, other: "ok" },
    };
    // Should not throw
    const result = redactConfigSecrets(config);
    // null secret is not a string, so it stays as null
    expect(result.secret).toBeNull();
    // undefined token is not a string, so it stays as undefined
    expect(result.nested.token).toBeUndefined();
    expect(result.nested.other).toBe("ok");
  });

  it("handles empty objects and arrays", () => {
    expect(redactConfigSecrets({})).toEqual({});
    expect(redactConfigSecrets({ items: [] })).toEqual({ items: [] });
    expect(redactConfigSecrets({ nested: {} })).toEqual({ nested: {} });
  });
});
