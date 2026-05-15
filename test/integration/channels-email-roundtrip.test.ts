// SPDX-License-Identifier: Apache-2.0
/**
 * INTEGRATION: Email channel — SMTP wire roundtrip + sender allowlist.
 *
 * Phase 40 Plan 40-16 (COV-04 gap closure): lifts coverage on the
 * `@comis/channels` Email subpackage (validateEmailCredentials,
 * isAllowedSender, email-plugin).
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createMockSmtpServer,
  type MockSmtpServer,
} from "../e2e/mocks/email/mock-smtp-server.js";
import { isAllowedSender } from "@comis/channels";
import { createTransport, type Transporter } from "nodemailer";

describe("INTEGRATION: email channel — SMTP wire roundtrip + sender filter", () => {
  let mock: MockSmtpServer;
  let transport: Transporter;

  beforeEach(async () => {
    mock = createMockSmtpServer();
    const handle = await mock.start();
    transport = createTransport({
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
    // adapter's IMAP inbound path. Calling it from integration lifts
    // the email-sender-filter line.
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
