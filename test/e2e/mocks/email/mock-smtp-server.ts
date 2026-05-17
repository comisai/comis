// SPDX-License-Identifier: Apache-2.0
/**
 * Mock SMTP capture server for E2E flow-matrix coverage.
 *
 * Wire surface: a minimal SMTP server speaking enough of RFC 5321 to capture
 * mail bodies sent by a nodemailer-style SMTP client. The implementation is
 * the simplest possible "Lookalike SMTP that the email adapter cannot tell
 * apart from a real relay" — greeting, HELO/EHLO, MAIL FROM, RCPT TO, DATA,
 * QUIT. Pipelining is not supported; each command is one CRLF-terminated line.
 *
 * Security posture (T-MOCK-EXPOSED-PORT, mirrors mock-oauth-server.ts):
 * binds to loopback (127.0.0.1) only — never a wildcard host — so the mock
 * is unreachable from the LAN. Kernel allocates the port via
 * `server.listen(0)` to avoid port-collision races between parallel test runs.
 *
 * The email adapter (`packages/channels/src/email/email-adapter.ts`) accepts
 * `smtpHost`/`smtpPort` config keys verbatim (no env-var redirection needed),
 * so an integration test can wire `smtpHost: "127.0.0.1", smtpPort: <mock>`
 * via the standard test config YAML.
 *
 * IMAP (inbound mail) is NOT in this file — the IMAP mock is a separate
 * concern (file-based Maildir polled by the adapter).
 *
 * @module
 */

import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

/**
 * One captured SMTP transaction: the parsed envelope plus the raw DATA payload.
 *
 * `data` is the verbatim bytes between `DATA\r\n` and the terminating
 * `\r\n.\r\n` sentinel, MINUS the dot-stuffing transform (RFC 5321 §4.5.2).
 * Callers can pass `data` to a MIME parser (e.g. mailparser) for further
 * assertion, or grep for substring matches at the test layer.
 */
export interface CapturedSmtpMail {
  readonly mailFrom: string;
  readonly rcptTo: ReadonlyArray<string>;
  readonly data: string;
  /** UNIX ms timestamp the DATA block terminated. */
  readonly timestamp: number;
}

export interface MockSmtpServer {
  /** Listen on 127.0.0.1 with a kernel-allocated port. Returns the bound URL. */
  start(): Promise<{ port: number; host: string }>;
  /** Stop the server and release the port. Safe to call when not started. */
  stop(): Promise<void>;
  /**
   * Total connections accepted (one transaction may use one connection or
   * many; SMTP clients vary). Optionally filtered by event type:
   *   - "connection" — TCP-level connects
   *   - "mail" — completed DATA blocks (RFC 5321 §4.1.1.4 success)
   *   - "rcpt-accept" — accepted RCPT TO commands
   */
  getRequestCount(eventType?: "connection" | "mail" | "rcpt-accept"): number;
  /** Captured mails in arrival order. */
  getCapturedEvents(): ReadonlyArray<{ type: "mail"; payload: CapturedSmtpMail; timestamp: number }>;
  /**
   * Inject an inbound mail. SMTP is one-way for capture purposes (the bot
   * sends outbound mail TO this mock); inbound IMAP-style delivery is mocked
   * via the file-based Maildir pattern (separate fixture). This method
   * exists for interface parity with the chat-mock contract but throws to
   * signal the deviation explicitly.
   */
  injectInboundMessage(opts: { from: string; channel: string; content: string }): void;
  /** Reset counters and any queued state. Call between tests. */
  reset(): void;
}

/**
 * Create the mock SMTP capture server.
 *
 * The server speaks just enough SMTP to satisfy the typical Node SMTP client
 * (nodemailer, mailparser, raw `net` + handcrafted commands). Each command is
 * one CRLF line. Pipelining and AUTH are NOT supported — callers must use
 * `secure: false` and no auth on the client side (which is how integration
 * tests SHOULD configure the mock; production must of course use TLS+AUTH).
 */
export function createMockSmtpServer(): MockSmtpServer {
  let server: Server | undefined;
  const captured: Array<{ type: "mail"; payload: CapturedSmtpMail; timestamp: number }> = [];
  const counters = new Map<string, number>();
  // Track open sockets so stop() can force-close them. Without this, a leaked
  // client connection holds the server open past `close()`'s callback.
  const openSockets = new Set<Socket>();

  function bump(key: string): void {
    counters.set(key, (counters.get(key) ?? 0) + 1);
  }

  function onConnection(socket: Socket): void {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    bump("connection");

    // Per-connection session state.
    let mailFrom = "";
    const rcptTo: string[] = [];
    let inData = false;
    let dataBuf = "";
    let lineBuf = "";

    // Initial 220 greeting (RFC 5321 §4.3.1).
    socket.write("220 mock.smtp ESMTP\r\n");

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      // Accumulate into the line buffer; SMTP commands are CRLF-terminated.
      for (const ch of text) {
        if (inData) {
          dataBuf += ch;
          // DATA terminator: `\r\n.\r\n`. Check for end-of-data sentinel.
          // We track it via a rolling 5-char suffix match for simplicity.
          if (dataBuf.endsWith("\r\n.\r\n")) {
            // Strip the terminator and apply RFC 5321 §4.5.2 dot-stuffing
            // reversal: each line beginning with ".." becomes ".".
            const body = dataBuf
              .slice(0, -"\r\n.\r\n".length)
              .replace(/(^|\r\n)\.\./g, "$1.");
            captured.push({
              type: "mail",
              payload: {
                mailFrom,
                rcptTo: [...rcptTo],
                data: body,
                timestamp: Date.now(),
              },
              timestamp: Date.now(),
            });
            bump("mail");
            socket.write("250 OK message accepted\r\n");
            // Reset transaction state but keep connection open per
            // RFC 5321 §3.3 (client may start a new MAIL FROM after).
            inData = false;
            dataBuf = "";
            mailFrom = "";
            rcptTo.length = 0;
          }
          continue;
        }
        lineBuf += ch;
        if (lineBuf.endsWith("\r\n")) {
          const line = lineBuf.slice(0, -2);
          lineBuf = "";
          handleCommand(line);
        }
      }
    });

    socket.on("error", () => {
      // Swallow socket errors — they're expected when tests abort mid-flight.
    });

    function handleCommand(line: string): void {
      const verb = line.split(" ")[0]?.toUpperCase() ?? "";
      if (verb === "HELO" || verb === "EHLO") {
        // Reply per RFC 5321 §4.1.1.1. For EHLO, no extension keywords are
        // advertised — the mock is intentionally minimal.
        socket.write("250 mock.smtp\r\n");
        return;
      }
      if (verb === "MAIL") {
        // MAIL FROM:<addr>
        const m = line.match(/^MAIL\s+FROM:\s*<?([^>\s]*)>?/i);
        mailFrom = m?.[1] ?? "";
        socket.write("250 OK\r\n");
        return;
      }
      if (verb === "RCPT") {
        const m = line.match(/^RCPT\s+TO:\s*<?([^>\s]*)>?/i);
        if (m?.[1]) {
          rcptTo.push(m[1]);
          bump("rcpt-accept");
        }
        socket.write("250 OK\r\n");
        return;
      }
      if (verb === "DATA") {
        inData = true;
        socket.write("354 Start mail input; end with <CRLF>.<CRLF>\r\n");
        return;
      }
      if (verb === "RSET") {
        mailFrom = "";
        rcptTo.length = 0;
        socket.write("250 OK\r\n");
        return;
      }
      if (verb === "NOOP") {
        socket.write("250 OK\r\n");
        return;
      }
      if (verb === "QUIT") {
        socket.write("221 Bye\r\n");
        socket.end();
        return;
      }
      // Unknown command — reply 502.
      socket.write("502 Command not implemented\r\n");
    }
  }

  const api: MockSmtpServer = {
    async start() {
      server = createServer(onConnection);
      await new Promise<void>((resolve) => {
        // listen(0, "127.0.0.1") for kernel-allocated ephemeral port on
        // loopback only — never a wildcard host (T-MOCK-EXPOSED-PORT).
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server.address() as AddressInfo;
      return { port: addr.port, host: "127.0.0.1" };
    },
    async stop() {
      if (!server) return;
      const local = server;
      server = undefined;
      // Force-close any lingering sockets so close() actually completes.
      for (const s of openSockets) {
        s.destroy();
      }
      openSockets.clear();
      await new Promise<void>((resolve, reject) => {
        local.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
    getRequestCount(eventType) {
      if (eventType !== undefined) {
        return counters.get(eventType) ?? 0;
      }
      let total = 0;
      for (const c of counters.values()) total += c;
      return total;
    },
    getCapturedEvents() {
      return captured;
    },
    injectInboundMessage() {
      // SMTP is outbound-only for the bot. Inbound mail is delivered via IMAP,
      // which the email adapter polls from a separate fixture (file-based
      // Maildir). Throwing here makes the deviation explicit at call sites.
      throw new Error(
        "Mock SMTP server does not accept inbound injection — use the IMAP/Maildir fixture for inbound mail",
      );
    },
    reset() {
      captured.length = 0;
      counters.clear();
    },
  };

  return Object.freeze(api);
}
