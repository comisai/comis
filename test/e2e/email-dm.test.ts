// SPDX-License-Identifier: Apache-2.0
/**
 * E2E: Email × DM — SMTP wire roundtrip against the 127.0.0.1 mock.
 *
 * Scope: drives a real `nodemailer` SMTP transport (the same library
 * the production `EmailChannelAdapter` uses internally) against the
 * mock SMTP capture server. Asserts the full SMTP transaction
 * (HELO → MAIL FROM → RCPT TO → DATA → payload → QUIT) round-trips
 * end-to-end and the mock's captured-mail stream contains the bot's
 * outbound message with the correct envelope.
 *
 * What this proves: the production SMTP wire format (nodemailer's
 * envelope construction) is decoded by the mock and surfaces to test
 * assertions. The mock can therefore serve as a faithful capture
 * surface for higher-level adapter tests that need the same wire
 * coverage.
 *
 * What this does NOT prove: the EmailChannelAdapter's IMAP polling
 * for inbound mail (a separate fixture, file-based Maildir per
 * mock-smtp-server.ts:67-71 commentary) — the email adapter's
 * start() opens BOTH IMAP and SMTP and a partial-startup pattern is
 * not currently supported in the production factory.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMockSmtpServer, type MockSmtpServer } from "./mocks/email/mock-smtp-server.js";
import { createTransport, type Transporter } from "nodemailer";

describe("E2E: email × dm — SMTP wire roundtrip against the 127.0.0.1 mock", () => {
  let mock: MockSmtpServer;
  let transport: Transporter;

  beforeEach(async () => {
    mock = createMockSmtpServer();
    const handle = await mock.start();
    // Construct the same SMTP transporter the production email adapter
    // would build at start() — minus the IMAP half. secure:false ensures
    // plain SMTP without TLS handshake (the mock does not implement
    // STARTTLS).
    transport = createTransport({
      host: handle.host,
      port: handle.port,
      secure: false,
      // tls.rejectUnauthorized = false is NOT set — we want the connection
      // to refuse plain-text auth, which the mock does (no AUTH command).
      auth: undefined,
      // Disable nodemailer's per-message DNS lookup of the From header.
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

  it("captures bot outbound mail with correct envelope and body content on the mock", async () => {
    const info = await transport.sendMail({
      from: "bot@example.test",
      to: "user@example.test",
      subject: "E2E test subject",
      text: "Hello user from comis-bot.",
    });
    expect(info.accepted).toContain("user@example.test");

    expect(mock.getRequestCount("mail")).toBe(1);
    const events = mock.getCapturedEvents();
    expect(events.length).toBeGreaterThanOrEqual(1);
    const mail = events[0]!.payload;
    expect(mail.mailFrom).toBe("bot@example.test");
    expect(mail.rcptTo).toContain("user@example.test");
    expect(mail.data).toContain("Hello user from comis-bot.");
    expect(mail.data).toContain("Subject: E2E test subject");
  });

  it("captures multiple outbound mails in order on the mock when bot sends batched replies", async () => {
    await transport.sendMail({
      from: "bot@example.test",
      to: "user-a@example.test",
      subject: "Reply 1",
      text: "First reply body.",
    });
    await transport.sendMail({
      from: "bot@example.test",
      to: "user-b@example.test",
      subject: "Reply 2",
      text: "Second reply body.",
    });

    expect(mock.getRequestCount("mail")).toBe(2);
    const events = mock.getCapturedEvents();
    expect(events[0]!.payload.rcptTo).toContain("user-a@example.test");
    expect(events[0]!.payload.data).toContain("First reply body.");
    expect(events[1]!.payload.rcptTo).toContain("user-b@example.test");
    expect(events[1]!.payload.data).toContain("Second reply body.");
  });

  it("preserves the mock SMTP wire-greeting (220 ESMTP) for client compatibility", async () => {
    // Connection itself proves the 220 greeting was sent — nodemailer would
    // throw "Greeting never received" or "Connection closed" without it.
    // We also expect at least one connection-level counter bump on send.
    await transport.sendMail({
      from: "bot@example.test",
      to: "user@example.test",
      text: "Probe message.",
    });
    expect(mock.getRequestCount("connection")).toBeGreaterThanOrEqual(1);
  });
});
