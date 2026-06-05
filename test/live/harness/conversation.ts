// SPDX-License-Identifier: Apache-2.0
/**
 * ConversationDriver — reusable multi-turn daemon harness for LOOP scenarios.
 *
 * Wraps:
 *   - Daemon boot via startTestDaemon (test/support/daemon-harness.ts)
 *   - Echo channel adapter registration for delivery-side cross-check
 *   - agents.create RPC (idempotent, admin-scope)
 *   - agent.execute RPC per turn via authenticated WebSocket (sendJsonRpc)
 *   - Session-index JSONL reading for restart-survival assertions (LOOP-03)
 *   - Log capture + capturedLogLines() for log-oracle post-conditions
 *
 * Security notes:
 *   - authToken is passed only to the WebSocket URL query param (test-only JWT,
 *     scoped to isolated test daemon, never logged — T-136-01-04)
 *   - disableRedaction:true is forwarded so log-oracle can assert on raw payloads
 *     (internal to test process, never written to shared storage — T-136-01-01)
 *   - "already exists" swallowed; "admin access required" throws loudly (T-136-01-02)
 *
 * @module
 */

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startTestDaemon,
  type TestDaemonHandle,
  type TestDaemonOptions,
} from "../../support/daemon-harness.js";
import {
  openAuthenticatedWebSocket,
  sendJsonRpc,
} from "../../support/ws-helpers.js";
import { createLogCapture } from "../../support/log-verifier.js";
import { EchoChannelAdapter } from "@comis/channels";
import type { SessionIndexEvent } from "@comis/observability";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for ConversationDriver construction.
 * All fields are optional — defaults are suitable for loop scenario tests.
 */
export interface ConversationDriverOptions {
  /** Agent identifier (default: "loop-test-agent"). */
  agentId?: string;
  /** LLM provider (default: "anthropic"). */
  provider?: string;
  /** Per-turn sendTurn timeout in ms (default: 30_000). */
  timeoutMs?: number;
  /** Path to daemon config file (default: test/config/config.test.yaml). */
  configPath?: string;
}

// ---------------------------------------------------------------------------
// Internal type helpers
// ---------------------------------------------------------------------------

type RpcEnvelope = {
  result?: { reply?: string };
  error?: { code: number; message: string };
};

// ---------------------------------------------------------------------------
// ConversationDriver class
// ---------------------------------------------------------------------------

/**
 * Reusable multi-turn harness that drives LOOP scenario tests.
 *
 * Lifecycle:
 *   1. `new ConversationDriver(opts)` — sets up isolated temp dataDir.
 *   2. `await driver.init()` — boots daemon, registers echo adapter, creates agent.
 *   3. `await driver.sendTurn(text)` — drives one turn via agent.execute WS RPC.
 *   4. `await driver.restart(opts?)` — stops daemon, starts fresh on same dataDir.
 *   5. `await driver.close()` — graceful shutdown + env restore.
 */
export class ConversationDriver {
  /** Temp data dir for the isolated daemon instance (exposed for StubDriver override). */
  protected _dataDir: string;

  private _agentId: string;
  private _provider: string;
  private _timeoutMs: number;
  private _configPath: string | undefined;

  // Set by init()
  private _handle: TestDaemonHandle | undefined;
  private _echo: EchoChannelAdapter | undefined;
  private _logCapture: ReturnType<typeof createLogCapture> | undefined;

  // For COMIS_DATA_DIR env restore
  private _priorDataDir: string | undefined;
  private _hadDataDir: boolean;

  constructor(opts?: ConversationDriverOptions) {
    this._agentId = opts?.agentId ?? "loop-test-agent";
    this._provider = opts?.provider ?? "anthropic";
    this._timeoutMs = opts?.timeoutMs ?? 30_000;
    this._configPath = opts?.configPath;

    // Create isolated temp data dir — never pollutes ~/.comis
    this._dataDir = mkdtempSync(join(tmpdir(), "comis-live-loop-"));

    // Store prior COMIS_DATA_DIR for restore in close()
    this._hadDataDir = process.env["COMIS_DATA_DIR"] !== undefined;
    this._priorDataDir = process.env["COMIS_DATA_DIR"];

    // Set the isolated data dir for the daemon to use
    process.env["COMIS_DATA_DIR"] = this._dataDir;
  }

  // ---------------------------------------------------------------------------
  // init() — boot daemon, register echo adapter, create agent
  // ---------------------------------------------------------------------------

  /**
   * Boot the daemon, register the EchoChannelAdapter, and create the agent
   * (idempotent — "already exists" is silently swallowed).
   *
   * Must be called before sendTurn().
   */
  async init(): Promise<void> {
    // Log capture with raw payloads for log-oracle assertions (T-136-01-01)
    this._logCapture = createLogCapture();

    // Boot the in-process daemon with log tee + raw payloads
    this._handle = await startTestDaemon({
      logStream: this._logCapture.stream,
      disableRedaction: true,
      ...(this._configPath ? { configPath: this._configPath } : {}),
    });

    // Register EchoChannelAdapter on both maps so the daemon can receive
    // and deliver messages via the echo channel (delivery-side cross-check)
    this._echo = new EchoChannelAdapter({
      channelId: "echo-live",
      channelType: "echo",
    });
    this._handle.daemon.adapterRegistry.set("echo", this._echo);
    this._handle.daemon.deliveryAdapters.set("echo", this._echo);

    // Create the agent via agents.create WS RPC (admin-scope required).
    // Swallow "already exists" (idempotent across test runs on shared DB).
    // Throw loudly on "admin access required" (test misconfigured) and any
    // other unexpected error (T-136-01-02).
    const setupWs = await openAuthenticatedWebSocket(
      this._handle.gatewayUrl,
      this._handle.authToken,
    );
    try {
      const resp = await sendJsonRpc(
        setupWs,
        "agents.create",
        { agentId: this._agentId, config: { provider: this._provider } },
        Date.now(),
        { timeoutMs: 10_000 },
      );
      const errMsg = (resp as { error?: { message?: string } }).error?.message;
      if (errMsg) {
        if (/already exists/i.test(errMsg)) {
          // Idempotent — acceptable
        } else if (/admin access required/i.test(errMsg)) {
          throw new Error(
            `Test daemon's gateway token lacks admin scope. ` +
              `Verify gateway.tokens[0].scopes includes "admin". ` +
              `Original error: ${errMsg}`,
          );
        } else {
          throw new Error(`agents.create failed: ${errMsg}`);
        }
      }
    } finally {
      setupWs.close();
    }
  }

  // ---------------------------------------------------------------------------
  // sendTurn() — drive one turn via agent.execute WS RPC
  // ---------------------------------------------------------------------------

  /**
   * Drive one conversation turn via the agent.execute WebSocket JSON-RPC path.
   *
   * IMPORTANT: this uses the RPC surface (not echo.injectMessage — that fires
   * zero pipeline handlers for a post-boot adapter).
   *
   * With dummy API keys (no COMIS_LIVE), the LLM provider call will fail and
   * the RPC returns an error envelope — sendTurn THROWS in that case. This is
   * intentional: the driver never returns empty silently (T-136-01 contract).
   *
   * After a successful turn, echo.reset() is called so the next turn starts
   * with a clean message buffer.
   *
   * @param text - The user message to send to the agent.
   * @returns The agent's reply string.
   * @throws If the RPC returns an error, the reply is missing, or timeout expires.
   */
  async sendTurn(text: string): Promise<string> {
    const handle = this._requireHandle();
    const echo = this._requireEcho();

    const ws = await openAuthenticatedWebSocket(
      handle.gatewayUrl,
      handle.authToken,
    );
    try {
      const resp = await sendJsonRpc(
        ws,
        "agent.execute",
        { agentId: this._agentId, message: text },
        Date.now(),
        { timeoutMs: this._timeoutMs },
      );
      const envelope = resp as RpcEnvelope;

      if (envelope.error) {
        throw new Error(
          `agent.execute RPC error ${envelope.error.code}: ${envelope.error.message}`,
        );
      }

      const reply = envelope.result?.reply;
      if (typeof reply !== "string") {
        throw new Error(
          `agent.execute returned no reply string (result: ${JSON.stringify(envelope.result)})`,
        );
      }

      // Reset echo buffer so the next turn starts fresh
      echo.reset();
      return reply;
    } finally {
      ws.close();
    }
  }

  // ---------------------------------------------------------------------------
  // restart() — stop + re-boot daemon on same dataDir
  // ---------------------------------------------------------------------------

  /**
   * Stop the current daemon (triggers session_ended + WAL checkpoint), then
   * start a fresh daemon on the same dataDir. Re-registers the EchoChannelAdapter
   * and re-issues agents.create (idempotent).
   *
   * Useful for LOOP-03 restart-survival assertions.
   */
  async restart(opts?: TestDaemonOptions): Promise<void> {
    if (this._handle) {
      try {
        await this._handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit")) throw err;
      }
      this._handle = undefined;
    }

    // Ensure COMIS_DATA_DIR is still set to the same temp dir (it's set in
    // the constructor and may have been cleared by daemon-harness cleanup)
    process.env["COMIS_DATA_DIR"] = this._dataDir;

    // Create a fresh log capture for the new daemon instance
    this._logCapture = createLogCapture();

    // Boot fresh daemon on same dataDir (SQLite state persists)
    this._handle = await startTestDaemon({
      logStream: this._logCapture.stream,
      disableRedaction: true,
      ...opts,
    });

    // Re-register echo adapter on the new daemon instance
    this._echo = new EchoChannelAdapter({
      channelId: "echo-live",
      channelType: "echo",
    });
    this._handle.daemon.adapterRegistry.set("echo", this._echo);
    this._handle.daemon.deliveryAdapters.set("echo", this._echo);

    // Re-create the agent (idempotent — "already exists" swallowed)
    const setupWs = await openAuthenticatedWebSocket(
      this._handle.gatewayUrl,
      this._handle.authToken,
    );
    try {
      const resp = await sendJsonRpc(
        setupWs,
        "agents.create",
        { agentId: this._agentId, config: { provider: this._provider } },
        Date.now(),
        { timeoutMs: 10_000 },
      );
      const errMsg = (resp as { error?: { message?: string } }).error?.message;
      if (errMsg && !/already exists/i.test(errMsg)) {
        throw new Error(`agents.create failed on restart: ${errMsg}`);
      }
    } finally {
      setupWs.close();
    }
  }

  // ---------------------------------------------------------------------------
  // getSessionIndexEvents() — read session-index JSONL
  // ---------------------------------------------------------------------------

  /**
   * Read the session-index JSONL for today and parse each line as a
   * SessionIndexEvent. Returns [] if the file does not exist.
   *
   * Used for LOOP-03 restart-survival assertions (turnCount, totalTokens)
   * and LOOP-04 streaming assertions (durationMs in turn_completed events).
   */
  async getSessionIndexEvents(): Promise<SessionIndexEvent[]> {
    const today = new Date().toISOString().slice(0, 10);
    const indexPath = join(
      this._dataDir,
      "logs",
      `session-index.${today}.jsonl`,
    );

    if (!existsSync(indexPath)) {
      return [];
    }

    const content = readFileSync(indexPath, "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SessionIndexEvent);
  }

  // ---------------------------------------------------------------------------
  // capturedLogLines() — return log entries as newline-joined JSON strings
  // ---------------------------------------------------------------------------

  /**
   * Return all captured Pino log entries as a newline-separated NDJSON string,
   * ready to pass to runLogOracle().
   *
   * Note: StubDriver overrides this to return "" (no daemon, no logs in unit tests).
   */
  capturedLogLines(): string {
    if (!this._logCapture) return "";
    return this._logCapture
      .getEntries()
      .map((e) => JSON.stringify(e))
      .join("\n");
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** Returns the isolated temp data dir for this driver instance. */
  getDataDir(): string {
    return this._dataDir;
  }

  /** Returns the EchoChannelAdapter instance for direct getSentMessages() assertions. */
  getEcho(): EchoChannelAdapter {
    return this._requireEcho();
  }

  /** Returns the current TestDaemonHandle. */
  getHandle(): TestDaemonHandle {
    return this._requireHandle();
  }

  // ---------------------------------------------------------------------------
  // close() — graceful shutdown + env restore
  // ---------------------------------------------------------------------------

  /**
   * Gracefully shut down the daemon and restore COMIS_DATA_DIR to its
   * pre-constructor value.
   */
  async close(): Promise<void> {
    if (this._handle) {
      try {
        await this._handle.cleanup();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("Daemon exit")) throw err;
      }
      this._handle = undefined;
    }

    // Restore COMIS_DATA_DIR to its prior state
    if (this._hadDataDir && this._priorDataDir !== undefined) {
      process.env["COMIS_DATA_DIR"] = this._priorDataDir;
    } else {
      delete process.env["COMIS_DATA_DIR"];
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _requireHandle(): TestDaemonHandle {
    if (!this._handle) {
      throw new Error(
        "ConversationDriver: init() must be called before using daemon-dependent methods",
      );
    }
    return this._handle;
  }

  private _requireEcho(): EchoChannelAdapter {
    if (!this._echo) {
      throw new Error(
        "ConversationDriver: init() must be called before using echo-dependent methods",
      );
    }
    return this._echo;
  }
}
