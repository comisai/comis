// SPDX-License-Identifier: Apache-2.0
/**
 * Error-classification tests for the wizard's live channel validators.
 *
 * Verifies that validateTelegramLive (and peers) surface err.cause.code with
 * knob-naming hints instead of the generic "Could not reach X API" on every
 * network failure branch.
 *
 * Before the classified catch is applied in 06-channels.ts, the bare `catch {}`
 * always returns the generic string and these branch assertions fail; after
 * the patch they all pass.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @clack/prompts to prevent import errors (loaded transitively via barrel)
vi.mock("@clack/prompts", () => ({}));

// Import the test-only exports added for error-classification coverage
import {
  validateTelegramLive,
  validateDiscordLive,
  validateSlackLive,
  validateLineLive,
} from "./06-channels.js";

// ---------- Helpers ----------

/**
 * Build a fetch rejection Error with a shaped cause containing `code`.
 * Mirrors the undici TypeError wrapper Node 22 throws on network failure.
 */
function makeCauseError(code: string): Error {
  const cause = Object.assign(new Error(`system error: ${code}`), { code });
  return Object.assign(new Error("fetch failed"), { cause });
}

/**
 * Build a fetch rejection Error whose cause.message contains a TLS keyword.
 */
function makeTlsMessageError(causeMessage: string): Error {
  const cause = new Error(causeMessage);
  return Object.assign(new Error("fetch failed"), { cause });
}

/**
 * Build an AbortError (from AbortController signal).
 */
function makeAbortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

// ---------- validateTelegramLive — error branches ----------

describe("validateTelegramLive — error classification", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("ETIMEDOUT: error contains the code and HTTPS_PROXY hint", async () => {
    fetchSpy.mockRejectedValue(makeCauseError("ETIMEDOUT"));
    const token = "1234567890:AAFtest_token_not_real";
    const result = await validateTelegramLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/ETIMEDOUT/);
    expect(result.error).toMatch(/HTTPS_PROXY/);
    // Token must never appear in the error string
    expect(result.error).not.toContain(token);
  });

  it("ECONNREFUSED: error contains the code and HTTPS_PROXY hint", async () => {
    fetchSpy.mockRejectedValue(makeCauseError("ECONNREFUSED"));
    const token = "1234567890:AAFtest_token_not_real";
    const result = await validateTelegramLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
    expect(result.error).toMatch(/HTTPS_PROXY/);
    expect(result.error).not.toContain(token);
  });

  it("ENOTFOUND: error contains the code and NO_PROXY hint", async () => {
    fetchSpy.mockRejectedValue(makeCauseError("ENOTFOUND"));
    const token = "1234567890:AAFtest_token_not_real";
    const result = await validateTelegramLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/ENOTFOUND/);
    expect(result.error).toMatch(/NO_PROXY/);
    expect(result.error).not.toContain(token);
  });

  it("CERT_HAS_EXPIRED: error names proxy.tls.caFile", async () => {
    fetchSpy.mockRejectedValue(makeCauseError("CERT_HAS_EXPIRED"));
    const token = "1234567890:AAFtest_token_not_real";
    const result = await validateTelegramLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/proxy\.tls\.caFile/);
    expect(result.error).not.toContain(token);
  });

  it("TLS cause message (certificate): error names proxy.tls.caFile", async () => {
    fetchSpy.mockRejectedValue(makeTlsMessageError("unable to verify the first certificate"));
    const token = "1234567890:AAFtest_token_not_real";
    const result = await validateTelegramLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/proxy\.tls\.caFile/);
    expect(result.error).not.toContain(token);
  });

  it("AbortError: error mentions timeout and HTTPS_PROXY", async () => {
    fetchSpy.mockRejectedValue(makeAbortError());
    const token = "1234567890:AAFtest_token_not_real";
    const result = await validateTelegramLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/timeout|timed out/i);
    expect(result.error).toMatch(/HTTPS_PROXY/);
    expect(result.error).not.toContain(token);
  });
});

// ---------- validateDiscordLive — error branches ----------

describe("validateDiscordLive — error classification", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("ETIMEDOUT: error contains the code and HTTPS_PROXY hint", async () => {
    fetchSpy.mockRejectedValue(makeCauseError("ETIMEDOUT"));
    const token = "Bot.test_discord_token_not_real";
    const result = await validateDiscordLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/ETIMEDOUT/);
    expect(result.error).toMatch(/HTTPS_PROXY/);
    expect(result.error).not.toContain(token);
  });

  it("ENOTFOUND: error contains the code and NO_PROXY hint", async () => {
    fetchSpy.mockRejectedValue(makeCauseError("ENOTFOUND"));
    const token = "Bot.test_discord_token_not_real";
    const result = await validateDiscordLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/ENOTFOUND/);
    expect(result.error).toMatch(/NO_PROXY/);
    expect(result.error).not.toContain(token);
  });

  it("AbortError: error mentions timeout and HTTPS_PROXY", async () => {
    fetchSpy.mockRejectedValue(makeAbortError());
    const token = "Bot.test_discord_token_not_real";
    const result = await validateDiscordLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/timeout|timed out/i);
    expect(result.error).toMatch(/HTTPS_PROXY/);
    expect(result.error).not.toContain(token);
  });
});

// ---------- validateSlackLive — error branches ----------

describe("validateSlackLive — error classification", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("ETIMEDOUT: error contains the code and HTTPS_PROXY hint", async () => {
    fetchSpy.mockRejectedValue(makeCauseError("ETIMEDOUT"));
    const token = "xoxb-test-slack-bot-token-not-real";
    const result = await validateSlackLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/ETIMEDOUT/);
    expect(result.error).toMatch(/HTTPS_PROXY/);
    expect(result.error).not.toContain(token);
  });

  it("CERT_*: error names proxy.tls.caFile", async () => {
    fetchSpy.mockRejectedValue(makeCauseError("CERT_UNTRUSTED"));
    const token = "xoxb-test-slack-bot-token-not-real";
    const result = await validateSlackLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/proxy\.tls\.caFile/);
    expect(result.error).not.toContain(token);
  });

  it("AbortError: error mentions timeout and HTTPS_PROXY", async () => {
    fetchSpy.mockRejectedValue(makeAbortError());
    const token = "xoxb-test-slack-bot-token-not-real";
    const result = await validateSlackLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/timeout|timed out/i);
    expect(result.error).toMatch(/HTTPS_PROXY/);
    expect(result.error).not.toContain(token);
  });
});

// ---------- validateLineLive — error branches ----------

describe("validateLineLive — error classification", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("ETIMEDOUT: error contains the code and HTTPS_PROXY hint", async () => {
    fetchSpy.mockRejectedValue(makeCauseError("ETIMEDOUT"));
    const token = "line-channel-access-token-not-real";
    const result = await validateLineLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/ETIMEDOUT/);
    expect(result.error).toMatch(/HTTPS_PROXY/);
    expect(result.error).not.toContain(token);
  });

  it("ENOTFOUND: error contains the code and NO_PROXY hint", async () => {
    fetchSpy.mockRejectedValue(makeCauseError("ENOTFOUND"));
    const token = "line-channel-access-token-not-real";
    const result = await validateLineLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/ENOTFOUND/);
    expect(result.error).toMatch(/NO_PROXY/);
    expect(result.error).not.toContain(token);
  });

  it("AbortError: error mentions timeout and HTTPS_PROXY", async () => {
    fetchSpy.mockRejectedValue(makeAbortError());
    const token = "line-channel-access-token-not-real";
    const result = await validateLineLive(token);

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/timeout|timed out/i);
    expect(result.error).toMatch(/HTTPS_PROXY/);
    expect(result.error).not.toContain(token);
  });
});
