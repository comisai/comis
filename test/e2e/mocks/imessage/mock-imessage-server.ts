// SPDX-License-Identifier: Apache-2.0
/**
 * Mock iMessage bridge for E2E flow-matrix coverage.
 *
 * Phase 40 / Phase C §6.5 / COV-15 (Plan 40-09).
 *
 * Wire surface: this mock is NOT a network server (unlike its siblings).
 * The iMessage adapter spawns an `imsg` CLI subprocess and talks JSON-RPC
 * to it over stdin/stdout. The mock provides a SHELL-SCRIPT bridge that
 * emulates the imsg binary's behavior using a pair of temp files for
 * inbound and outbound messages.
 *
 * Pattern:
 *   - On `start()`: mkdtemp a unique directory `<tempdir>` and write an
 *     executable shim at `<tempdir>/imsg` that reads JSON-RPC from stdin,
 *     dispatches to handlers (send → write to <tempdir>/outbox.jsonl;
 *     subscribe → tail <tempdir>/inbox.jsonl), and prints JSON-RPC
 *     responses to stdout.
 *   - Tests set `channels.imessage.binaryPath = <tempdir>/imsg` to wire
 *     the daemon's iMessage adapter against this shim.
 *   - `injectInboundMessage` appends a JSON line to `<tempdir>/inbox.jsonl`
 *     which the shim's subscribe loop will read and emit as a JSON-RPC
 *     notification on stdout.
 *   - `getCapturedEvents` reads `<tempdir>/outbox.jsonl` and parses each
 *     line as a captured outbound message.
 *   - `stop()` `rm -rf` the temp directory.
 *
 * Security posture (T-MOCK-EXPOSED-PORT does not apply — no network):
 *   - Temp dir uses `os.tmpdir()` (per-user, per-OS) via `mkdtempSync`.
 *   - Shim script is 0o755 owned by the running user.
 *   - Cleanup on stop() removes all temp artifacts.
 *
 * Cross-platform note: the shim is a POSIX shell script and requires
 * `/bin/sh` (Linux + macOS). Windows is not supported by the production
 * iMessage adapter either (macOS-only per IMessageChannelEntrySchema).
 *
 * @module
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { sep } from "node:path";

export interface CapturedIMessageEvent {
  readonly type: "send" | "subscribe" | "pending-inbound";
  readonly payload: {
    readonly chatId?: string;
    readonly text?: string;
    readonly from?: string;
    readonly channel?: string;
    readonly content?: string;
    readonly rawJsonRpc?: string;
  };
  readonly timestamp: number;
}

export interface MockIMessageServer {
  /**
   * Set up the temp dir + shim script. Returns the path to the
   * shim binary — set this as `channels.imessage.binaryPath` in the
   * daemon's test config.
   */
  start(): Promise<{ binaryPath: string; tempDir: string }>;
  stop(): Promise<void>;
  getRequestCount(eventType?: CapturedIMessageEvent["type"]): number;
  getCapturedEvents(): ReadonlyArray<CapturedIMessageEvent>;
  injectInboundMessage(opts: { from: string; channel: string; content: string }): void;
  reset(): void;
}

export function createMockIMessageServer(): MockIMessageServer {
  let tempDir: string | undefined;
  let binaryPath: string | undefined;
  let inboxPath: string | undefined;
  let outboxPath: string | undefined;
  const captured: CapturedIMessageEvent[] = [];
  const counters = new Map<string, number>();

  function bump(key: string): void {
    counters.set(key, (counters.get(key) ?? 0) + 1);
  }

  function refreshCapturedFromOutbox(): void {
    if (!outboxPath || !existsSync(outboxPath)) return;
    const content = readFileSync(outboxPath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    // Reset and rebuild captured (idempotent) — keeps callers' read consistent.
    const sendEvents = captured.filter((e) => e.type !== "send");
    captured.length = 0;
    captured.push(...sendEvents);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as { method?: string; params?: Record<string, unknown>; rawJsonRpc?: string };
        if (parsed.method === "send") {
          captured.push({
            type: "send",
            payload: {
              chatId: (parsed.params?.["chatId"] as string | undefined) ?? "",
              text: (parsed.params?.["text"] as string | undefined) ?? "",
              rawJsonRpc: line,
            },
            timestamp: Date.now(),
          });
        }
      } catch {
        // Skip malformed lines.
      }
    }
  }

  const api: MockIMessageServer = {
    async start() {
      tempDir = mkdtempSync(`${tmpdir()}${sep}mock-imessage-`);
      inboxPath = `${tempDir}${sep}inbox.jsonl`;
      outboxPath = `${tempDir}${sep}outbox.jsonl`;
      writeFileSync(inboxPath, "", { mode: 0o600 });
      writeFileSync(outboxPath, "", { mode: 0o600 });

      binaryPath = `${tempDir}${sep}imsg`;
      // POSIX shell shim that reads JSON-RPC from stdin and dispatches:
      //   - method "send" → append the line to outbox.jsonl, print
      //                     {"jsonrpc":"2.0","id":<id>,"result":{"ok":true}}
      //   - method "subscribe" → tail -f inbox.jsonl; for each new line,
      //                          print {"jsonrpc":"2.0","method":"message",
      //                          "params":<parsed>}
      // The shim is deliberately minimal — it does NOT validate the JSON.
      const shim = `#!/bin/sh
# Mock imsg shim for E2E tests — Phase 40 / Plan 40-09 / COV-15.
TEMPDIR='${tempDir}'
OUTBOX="$TEMPDIR/outbox.jsonl"
INBOX="$TEMPDIR/inbox.jsonl"

# Start the subscribe tail in the background so notifications stream.
( tail -n +1 -F "$INBOX" 2>/dev/null | while IFS= read -r line; do
    [ -z "$line" ] && continue
    printf '{"jsonrpc":"2.0","method":"message","params":%s}\\n' "$line"
done ) &
TAIL_PID=$!

# Trap to cleanup the tail on exit.
trap 'kill $TAIL_PID 2>/dev/null' EXIT INT TERM

# Read JSON-RPC requests from stdin, line by line.
while IFS= read -r request; do
  [ -z "$request" ] && continue
  printf '%s\\n' "$request" >> "$OUTBOX"
  # Extract id from the request (rough sed — accepts integer ids).
  REQ_ID=$(printf '%s' "$request" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\\([0-9]*\\).*/\\1/p')
  REQ_ID="\${REQ_ID:-1}"
  # Reply with a generic success envelope.
  printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true}}\\n' "$REQ_ID"
done
`;
      writeFileSync(binaryPath, shim, { mode: 0o755 });
      // chmodSync to be explicit even on filesystems that ignore the mode arg.
      chmodSync(binaryPath, 0o755);

      return { binaryPath, tempDir };
    },
    async stop() {
      if (!tempDir) return;
      const dir = tempDir;
      tempDir = undefined;
      binaryPath = undefined;
      inboxPath = undefined;
      outboxPath = undefined;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Swallow — temp dir may already be partially removed.
      }
    },
    getRequestCount(eventType) {
      refreshCapturedFromOutbox();
      // Re-derive counters from the up-to-date captured list (idempotent).
      counters.clear();
      for (const ev of captured) {
        counters.set(ev.type, (counters.get(ev.type) ?? 0) + 1);
      }
      if (eventType !== undefined) {
        return counters.get(eventType) ?? 0;
      }
      let total = 0;
      for (const c of counters.values()) total += c;
      return total;
    },
    getCapturedEvents() {
      refreshCapturedFromOutbox();
      return captured;
    },
    injectInboundMessage(opts) {
      if (!inboxPath) {
        throw new Error("Mock iMessage server not started — call start() first");
      }
      const event = {
        chatId: opts.channel,
        senderId: opts.from,
        text: opts.content,
        timestamp: Date.now(),
      };
      // Append as a single line so `tail -F` emits it as one event.
      appendFileSync(inboxPath, `${JSON.stringify(event)}\n`);
      bump("pending-inbound");
      captured.push({
        type: "pending-inbound",
        payload: {
          from: opts.from,
          channel: opts.channel,
          content: opts.content,
        },
        timestamp: Date.now(),
      });
    },
    reset() {
      captured.length = 0;
      counters.clear();
      // Truncate the outbox so getCapturedEvents() reflects post-reset
      // state. inbox is the test's responsibility (injectInboundMessage
      // appends; tests typically call reset() once before each it block).
      if (outboxPath && existsSync(outboxPath)) {
        writeFileSync(outboxPath, "", { mode: 0o600 });
      }
      if (inboxPath && existsSync(inboxPath)) {
        writeFileSync(inboxPath, "", { mode: 0o600 });
      }
    },
  };

  return Object.freeze(api);
}
