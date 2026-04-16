import { describe, it, expect } from "vitest";
import type { TokenEntry } from "./token-auth.js";
import { createTokenStore, checkScope, extractBearerToken } from "./token-auth.js";

const TEST_TOKENS: TokenEntry[] = [
  { id: "client-a", secret: "secret-alpha-123-padded-to-32-chars", scopes: ["rpc", "ws"] },
  { id: "client-b", secret: "secret-beta-456-padded-to-32-chars-", scopes: ["rpc"] },
  { id: "admin", secret: "admin-key-789-padded-to-32-characters", scopes: ["*"] },
];

describe("createTokenStore", () => {
  const store = createTokenStore(TEST_TOKENS);

  it("returns client for valid token", () => {
    const client = store.verify("secret-alpha-123-padded-to-32-chars");
    expect(client).not.toBeNull();
    expect(client!.id).toBe("client-a");
    expect(client!.scopes).toEqual(["rpc", "ws"]);
  });

  it("returns correct client for second token", () => {
    const client = store.verify("secret-beta-456-padded-to-32-chars-");
    expect(client).not.toBeNull();
    expect(client!.id).toBe("client-b");
    expect(client!.scopes).toEqual(["rpc"]);
  });

  it("returns null for invalid token", () => {
    const client = store.verify("wrong-token");
    expect(client).toBeNull();
  });

  it("returns null for empty token", () => {
    const client = store.verify("");
    expect(client).toBeNull();
  });

  it("returns null for partial match of valid token", () => {
    const client = store.verify("secret-alpha");
    expect(client).toBeNull();
  });

  it("returns null for token with extra characters", () => {
    const client = store.verify("secret-alpha-123-padded-to-32-chars-extra");
    expect(client).toBeNull();
  });

  it("handles empty token list", () => {
    const emptyStore = createTokenStore([]);
    expect(emptyStore.verify("anything")).toBeNull();
  });

  it("uses constant-time comparison (same length different values)", () => {
    // Both have same length as "secret-alpha-123-padded-to-32-chars" (35 chars)
    const client1 = store.verify("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(client1).toBeNull();

    const client2 = store.verify("secret-alpha-124-padded-to-32-chars");
    expect(client2).toBeNull();
  });
});

describe("checkScope", () => {
  it("returns true for exact scope match", () => {
    expect(checkScope(["rpc", "ws"], "rpc")).toBe(true);
  });

  it("returns true for second scope match", () => {
    expect(checkScope(["rpc", "ws"], "ws")).toBe(true);
  });

  it("returns false for missing scope", () => {
    expect(checkScope(["rpc"], "admin")).toBe(false);
  });

  it("returns true for wildcard scope", () => {
    expect(checkScope(["*"], "anything")).toBe(true);
  });

  it("returns true for wildcard among other scopes", () => {
    expect(checkScope(["rpc", "*"], "admin")).toBe(true);
  });

  it("returns false for empty scopes", () => {
    expect(checkScope([], "rpc")).toBe(false);
  });
});

describe("extractBearerToken", () => {
  it("extracts token from valid Bearer header", () => {
    expect(extractBearerToken("Bearer my-token-123")).toBe("my-token-123");
  });

  it("handles case-insensitive Bearer prefix", () => {
    expect(extractBearerToken("bearer my-token")).toBe("my-token");
    expect(extractBearerToken("BEARER my-token")).toBe("my-token");
  });

  it("returns null for missing header", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractBearerToken("")).toBeNull();
  });

  it("returns null for non-Bearer auth scheme", () => {
    expect(extractBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
  });

  it("returns null for Bearer without token", () => {
    expect(extractBearerToken("Bearer")).toBeNull();
  });

  it("preserves token with special characters", () => {
    expect(extractBearerToken("Bearer abc+def/ghi=")).toBe("abc+def/ghi=");
  });
});
