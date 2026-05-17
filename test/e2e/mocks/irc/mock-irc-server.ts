// SPDX-License-Identifier: Apache-2.0
/**
 * Mock IRC server for E2E flow-matrix coverage.
 *
 * Wire surface: a minimal IRC server speaking enough of RFC 1459 to satisfy
 * the irc-framework client used by `packages/channels/src/irc/irc-adapter.ts`:
 *
 *   - 001 RPL_WELCOME on registration (after NICK + USER complete)
 *   - JOIN echo back to the client + 353 RPL_NAMREPLY + 366 RPL_ENDOFNAMES
 *   - PRIVMSG capture (bot outbound)
 *   - PING/PONG keepalive
 *   - injectInboundMessage writes `:from!from@host PRIVMSG <channel> :<content>\r\n`
 *     to the connected client socket so the adapter sees it as a normal inbound
 *
 * Security posture (T-MOCK-EXPOSED-PORT, mirrors mock-oauth-server.ts):
 * binds to loopback (127.0.0.1) only — never a wildcard host — so the mock
 * is unreachable from the LAN. Kernel allocates the port via
 * `server.listen(0)` to avoid port-collision races between parallel test runs.
 *
 * The irc adapter accepts `host`/`port` config keys verbatim (no env-var
 * redirection needed); an integration test wires `host: "127.0.0.1",
 * port: <mock>, tls: false` via the standard test config YAML.
 *
 * @module
 */

import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";

export interface CapturedIrcEvent {
  readonly type: "privmsg" | "join" | "part" | "nick" | "raw";
  readonly payload: {
    readonly source?: string;
    readonly target?: string;
    readonly text?: string;
    readonly raw: string;
  };
  readonly timestamp: number;
}

export interface MockIrcServer {
  /** Listen on 127.0.0.1 with a kernel-allocated port. Returns the bound address. */
  start(): Promise<{ port: number; host: string }>;
  /** Stop the server and release the port. Safe to call when not started. */
  stop(): Promise<void>;
  /** Total messages received, optionally filtered by event type. */
  getRequestCount(eventType?: CapturedIrcEvent["type"]): number;
  /** Captured client-originated IRC events in arrival order. */
  getCapturedEvents(): ReadonlyArray<CapturedIrcEvent>;
  /**
   * Inject an inbound PRIVMSG to the connected client. The mock writes
   * `:<from>!<from>@host PRIVMSG <channel> :<content>\r\n` to all currently
   * connected client sockets (typically just one — the irc adapter under
   * test). If no client is connected, the message is dropped (with a counter
   * bump on `dropped-inbound`).
   */
  injectInboundMessage(opts: { from: string; channel: string; content: string }): void;
  /** Reset counters and any queued state. Call between tests. */
  reset(): void;
}

/**
 * Create the mock IRC server.
 *
 * Parses one CRLF-terminated message per IRC convention. Multiple commands
 * may arrive in a single TCP recv — the line buffer below splits them
 * correctly.
 */
export function createMockIrcServer(): MockIrcServer {
  let server: Server | undefined;
  const captured: CapturedIrcEvent[] = [];
  const counters = new Map<string, number>();
  const openSockets = new Set<Socket>();

  function bump(key: string): void {
    counters.set(key, (counters.get(key) ?? 0) + 1);
  }

  function onConnection(socket: Socket): void {
    openSockets.add(socket);
    socket.once("close", () => openSockets.delete(socket));
    bump("connection");

    let nick = "";
    let user = "";
    let registered = false;
    let lineBuf = "";

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      lineBuf += text;
      // IRC framing: lines terminated by \r\n. Some clients use \n alone, but
      // RFC-compliant clients use \r\n; accept either to be lenient.
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() ?? ""; // Last fragment may be partial — keep it.
      for (const line of lines) {
        if (line.length === 0) continue;
        handleLine(line);
      }
    });

    socket.on("error", () => {
      // Suppress — tests may abort connections mid-stream.
    });

    function handleLine(line: string): void {
      // Strip optional source prefix (":<source> CMD args"). Adapter-side
      // never sets a source prefix; tolerate it anyway.
      const stripped = line.startsWith(":") ? line.slice(line.indexOf(" ") + 1) : line;
      const parts = stripped.split(" ");
      const cmd = parts[0]?.toUpperCase() ?? "";

      if (cmd === "PASS") {
        // PASS is silently accepted; per RFC it must come before NICK/USER.
        return;
      }
      if (cmd === "CAP") {
        // irc-framework requests capabilities (CAP LS, CAP REQ). Reply with
        // an empty capability list and ACK whatever was requested.
        const sub = parts[1]?.toUpperCase() ?? "";
        if (sub === "LS") {
          socket.write(":mock CAP * LS :\r\n");
        } else if (sub === "REQ") {
          const requested = stripped.match(/REQ\s*:?(.*)$/i)?.[1]?.trim() ?? "";
          socket.write(`:mock CAP * ACK :${requested}\r\n`);
        } else if (sub === "END") {
          // No-op; registration proceeds once NICK + USER have arrived.
        }
        return;
      }
      if (cmd === "NICK") {
        nick = parts[1] ?? "";
        maybeRegister();
        return;
      }
      if (cmd === "USER") {
        user = parts[1] ?? "";
        maybeRegister();
        return;
      }
      if (cmd === "JOIN") {
        const channel = parts[1] ?? "";
        captured.push({
          type: "join",
          payload: { source: nick, target: channel, raw: line },
          timestamp: Date.now(),
        });
        bump("join");
        // Echo JOIN back per RFC 2812 §3.2.1, then send NAMREPLY +
        // ENDOFNAMES so the client treats the channel as joined.
        socket.write(`:${nick}!${nick}@mock JOIN :${channel}\r\n`);
        socket.write(`:mock 353 ${nick} = ${channel} :${nick}\r\n`);
        socket.write(`:mock 366 ${nick} ${channel} :End of NAMES list\r\n`);
        return;
      }
      if (cmd === "PART") {
        const channel = parts[1] ?? "";
        captured.push({
          type: "part",
          payload: { source: nick, target: channel, raw: line },
          timestamp: Date.now(),
        });
        bump("part");
        return;
      }
      if (cmd === "PRIVMSG") {
        const target = parts[1] ?? "";
        const colonIdx = stripped.indexOf(" :");
        const text = colonIdx >= 0 ? stripped.slice(colonIdx + 2) : "";
        captured.push({
          type: "privmsg",
          payload: { source: nick, target, text, raw: line },
          timestamp: Date.now(),
        });
        bump("privmsg");
        return;
      }
      if (cmd === "PING") {
        // Reply with PONG using the same token.
        const token = parts[1] ?? "";
        socket.write(`:mock PONG mock :${token}\r\n`);
        return;
      }
      if (cmd === "QUIT") {
        socket.end();
        return;
      }
      // Unknown command — capture as raw for diagnostic only.
      captured.push({
        type: "raw",
        payload: { raw: line },
        timestamp: Date.now(),
      });
      bump("raw");
    }

    function maybeRegister(): void {
      if (registered) return;
      if (nick.length === 0 || user.length === 0) return;
      registered = true;
      // RPL_WELCOME (001) — irc-framework treats this as "registered" and
      // emits a `registered` event.
      socket.write(`:mock 001 ${nick} :Welcome to the mock IRC network ${nick}\r\n`);
      socket.write(`:mock 002 ${nick} :Your host is mock\r\n`);
      socket.write(`:mock 003 ${nick} :This server was created mock\r\n`);
      socket.write(`:mock 004 ${nick} mock mock-1.0 io o\r\n`);
    }
  }

  const api: MockIrcServer = {
    async start() {
      server = createServer(onConnection);
      await new Promise<void>((resolve) => {
        server!.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server.address() as AddressInfo;
      return { port: addr.port, host: "127.0.0.1" };
    },
    async stop() {
      if (!server) return;
      const local = server;
      server = undefined;
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
    injectInboundMessage(opts) {
      const wire = `:${opts.from}!${opts.from}@mock PRIVMSG ${opts.channel} :${opts.content}\r\n`;
      let delivered = 0;
      for (const s of openSockets) {
        if (!s.destroyed) {
          s.write(wire);
          delivered++;
        }
      }
      if (delivered === 0) {
        bump("dropped-inbound");
      }
    },
    reset() {
      captured.length = 0;
      counters.clear();
    },
  };

  return Object.freeze(api);
}
