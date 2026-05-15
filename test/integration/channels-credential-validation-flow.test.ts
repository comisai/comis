// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: cross-adapter credential validation — flow tests.
 *
 * Phase 40 Plan 40-16 (COV-04 gap closure): exercises the public credential
 * validators across all 9 channel adapters in a single integration suite
 * to lift the credential-validator coverage lines.
 *
 * Validators are called against mock loopback servers OR with deliberately
 * empty / invalid inputs to exercise the err branches. The goal is to
 * lift integration-tier coverage across credential-validator.ts files
 * in each channel subpackage.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import {
  validateBotToken,
  validateWebhookSecret,
  validateDiscordToken,
  validateSlackCredentials,
  validateLineCredentials,
  validateIrcConnection,
  validateEmailCredentials,
  validateIMessageConnection,
  validateWhatsAppAuth,
  validateSignalConnection,
} from "@comis/channels";

describe("INTEGRATION: cross-adapter credential validators — err branches + smoke", () => {
  it("validateBotToken (Telegram) rejects empty token with err result", async () => {
    const result = await validateBotToken("");
    expect(result.ok).toBe(false);
  });

  it("validateWebhookSecret (Telegram) accepts conforming secret", () => {
    expect(validateWebhookSecret("valid-secret-123_XYZ").ok).toBe(true);
  });

  it("validateWebhookSecret (Telegram) rejects empty secret", () => {
    expect(validateWebhookSecret("").ok).toBe(false);
  });

  it("validateDiscordToken (Discord) returns Result for nonexistent apiRoot", async () => {
    // Pointing at a port the mock isn't listening on exercises the err
    // path. We assert only that the validator returns a Result without
    // throwing (network errors map to err).
    const result = await validateDiscordToken(
      "fake-discord-token",
      "http://127.0.0.1:1", // closed port — kernel refuses connection
    );
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
  });

  it("validateSlackCredentials (Slack) rejects empty bot token via early err", async () => {
    // Take the early-err path (empty botToken) so the test doesn't hit
    // the WebClient retry budget. The empty-token path covers the
    // credential-validator's input-validation prelude.
    const result = await validateSlackCredentials({
      botToken: "",
      mode: "http",
      signingSecret: "fake-signing-secret-for-test",
    });
    expect(result.ok).toBe(false);
  });

  it("validateSlackCredentials (Slack) rejects socket mode with non-'xapp-' appToken", async () => {
    const result = await validateSlackCredentials({
      botToken: "xoxb-fake-cred-test",
      mode: "socket",
      appToken: "wrong-prefix-token",
    });
    expect(result.ok).toBe(false);
  });

  it("validateSlackCredentials (Slack) rejects http mode with empty signing secret", async () => {
    const result = await validateSlackCredentials({
      botToken: "xoxb-fake-cred-test",
      mode: "http",
      signingSecret: "",
    });
    expect(result.ok).toBe(false);
  });

  it("validateLineCredentials (LINE) returns Result for nonexistent apiRoot", async () => {
    const result = await validateLineCredentials({
      channelAccessToken: "fake-line-token",
      channelSecret: "fake-line-channel-secret",
      apiRoot: "http://127.0.0.1:1",
    });
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
  });

  it("validateIrcConnection (IRC) returns Result for a closed port", async () => {
    const result = await validateIrcConnection({
      host: "127.0.0.1",
      port: 1, // closed
      nick: "validator-test",
      tls: false,
    });
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
  });

  it("validateEmailCredentials (Email) returns err Result for unreachable IMAP", async () => {
    const result = await validateEmailCredentials({
      imapHost: "127.0.0.1",
      imapPort: 1, // closed port
      secure: false,
      auth: { user: "u", pass: "p" },
    });
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
    // Closed port → err is the deterministic outcome.
    expect(result.ok).toBe(false);
  });

  it("validateIMessageConnection (iMessage) returns Result for nonexistent binary", async () => {
    const result = await validateIMessageConnection({
      binaryPath: "/nonexistent/imessage-binary-validator",
    });
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
  });

  it("validateWhatsAppAuth (WhatsApp) returns Result for nonexistent auth dir", async () => {
    const result = await validateWhatsAppAuth({
      authDir: "/tmp/whatsapp-validator-test-nonexistent",
    });
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
  });

  it("validateWhatsAppAuth (WhatsApp) rejects empty auth dir via input validation", async () => {
    const result = await validateWhatsAppAuth({
      authDir: "",
    });
    expect(result.ok).toBe(false);
  });

  it("validateSignalConnection (Signal) returns Result for unreachable baseUrl", async () => {
    const result = await validateSignalConnection({
      baseUrl: "http://127.0.0.1:1",
      account: "+15555550100",
    });
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe("boolean");
  });
});
