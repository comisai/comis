// SPDX-License-Identifier: Apache-2.0
/**
 * Per-contract test for the MCP-OAuth domain contracts.
 *
 * Mirrors the structure of `packages/core/src/api-contracts/mcp.test.ts`
 * (closest analog by admin-only + login/logout admin lifecycle methods).
 *
 * Focus of this file: the {@link McpOauthLoginContract.response} Zod schema
 * MUST mirror {@link OAuthLoginResult} from `@comis/skills` 1:1. Both are
 * extended in lockstep so the agent can surface the
 * `verificationUri` + `userCode` + `expiresIn` fields via the `message` tool
 * after a successful `device_code_pending` dispatch. The PKCE path stays
 * clean (the 3 new fields land as `undefined`).
 *
 * @module
 */
import { describe, it, expect } from "vitest";

import {
  McpOauthLoginContract,
  McpOauthLogoutContract,
  MCP_OAUTH_CONTRACTS,
} from "./mcp-oauth.js";

describe("mcp-oauth domain contracts", () => {
  it("MCP_OAUTH_CONTRACTS has exactly 2 entries (oauth_login + oauth_logout)", () => {
    expect(MCP_OAUTH_CONTRACTS.length).toBe(2);
  });

  it("mcp.oauth_login: method name is correct", () => {
    expect(McpOauthLoginContract.method).toBe("mcp.oauth_login");
  });

  it("mcp.oauth_logout: method name is correct", () => {
    expect(McpOauthLogoutContract.method).toBe("mcp.oauth_logout");
  });

  it("both contracts are admin-scoped (login + logout create / destroy credentials)", () => {
    expect(McpOauthLoginContract.scopes).toEqual(["admin"]);
    expect(McpOauthLogoutContract.scopes).toEqual(["admin"]);
  });

  // -------------------------------------------------------------------------
  // Response schema mirrors the extended OAuthLoginResult.
  // -------------------------------------------------------------------------

  it("McpOauthLoginContract.response accepts status device_code_pending with verificationUri userCode and expiresIn", () => {
    const parsed = McpOauthLoginContract.response.safeParse({
      server_name: "higgsfield",
      status: "device_code_pending",
      verificationUri: "https://example.com/device",
      userCode: "WDJB-MJHT",
      expiresIn: 600,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("device_code_pending");
      expect(parsed.data.verificationUri).toBe("https://example.com/device");
      expect(parsed.data.userCode).toBe("WDJB-MJHT");
      expect(parsed.data.expiresIn).toBe(600);
    }
  });

  it("McpOauthLoginContract.response rejects device_code_pending when expiresIn is non-positive", () => {
    const parsed = McpOauthLoginContract.response.safeParse({
      server_name: "higgsfield",
      status: "device_code_pending",
      verificationUri: "https://example.com/device",
      userCode: "WDJB-MJHT",
      expiresIn: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it("McpOauthLoginContract.response leaves verificationUri userCode and expiresIn undefined on authorized PKCE result", () => {
    const parsed = McpOauthLoginContract.response.safeParse({
      server_name: "notion",
      status: "authorized",
      authUrl: "https://example.com/auth",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.status).toBe("authorized");
      expect(parsed.data.verificationUri).toBeUndefined();
      expect(parsed.data.userCode).toBeUndefined();
      expect(parsed.data.expiresIn).toBeUndefined();
    }
  });
});
