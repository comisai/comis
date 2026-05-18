// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: Email channel — SMTP wire roundtrip + sender allowlist.
 *
 * Covers the `@comis/channels` Email subpackage (validateEmailCredentials,
 * isAllowedSender, email-plugin) end-to-end against a mock SMTP server.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import {
  createMockSmtpServer,
  type MockSmtpServer,
} from "../e2e/mocks/email/mock-smtp-server.js";
import { isAllowedSender } from "@comis/channels";
import type { Transporter } from "nodemailer";

// nodemailer is a transitive dep of @comis/channels (the production adapter)
// and is not hoisted to the repo root under pnpm's isolated install, so this
// integration test can only run when nodemailer happens to be reachable from
// the repo root. Probe via createRequire so we can skip the suite cleanly on
// CI runners rather than crashing on a top-level `import` that cannot resolve.
const requireFromHere = createRequire(import.meta.url);
let nodemailer: typeof import("nodemailer") | null = null;
try {
  nodemailer = requireFromHere("nodemailer");
} catch {
  nodemailer = null;
}

describe.skipIf(nodemailer === null)("INTEGRATION: email channel — SMTP wire roundtrip + sender filter", () => {
  let mock: MockSmtpServer;
  let transport: Transporter;

  beforeEach(async () => {
    mock = createMockSmtpServer();
    const handle = await mock.start();
    transport = nodemailer!.createTransport({
      host: handle.host,
      port: handle.port,
      secure: false,
      auth: undefined,
      ignoreTLS: true,
    });
  });

  afterEach(async () => {
    if (transport) {
      transport.close();
    }
    if (mock) {
      await mock.stop();
    }
  });

  it("captures outbound SMTP envelope + body on the mock", async () => {
    const info = await transport.sendMail({
      from: "bot@example.test",
      to: "user@example.test",
      subject: "Integration test subject",
      text: "Integration test body.",
    });
    expect(info.accepted).toContain("user@example.test");

    expect(mock.getRequestCount("mail")).toBe(1);
    const events = mock.getCapturedEvents();
    const mail = events[0]!.payload;
    expect(mail.mailFrom).toBe("bot@example.test");
    expect(mail.rcptTo).toContain("user@example.test");
    expect(mail.data).toContain("Integration test body.");
  });

  it("isAllowedSender accepts senders in the explicit allowlist (allowlist mode)", () => {
    // isAllowedSender is the production helper imported by the email
    // adapter's IMAP inbound path.
    const result = isAllowedSender(
      "user@example.test",
      ["user@example.test", "other@example.test"],
      "allowlist",
    );
    expect(result).toBe(true);
  });

  it("isAllowedSender rejects senders not in the allowlist", () => {
    const result = isAllowedSender(
      "attacker@evil.test",
      ["user@example.test"],
      "allowlist",
    );
    expect(result).toBe(false);
  });

  it("isAllowedSender returns true for any sender in open mode", () => {
    const result = isAllowedSender("anyone@anywhere.test", [], "open");
    expect(result).toBe(true);
  });

  it("isAllowedSender returns false for empty allowlist in allowlist mode (default-closed)", () => {
    const result = isAllowedSender("user@example.test", [], "allowlist");
    expect(result).toBe(false);
  });
});
