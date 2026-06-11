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

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
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
import { getFreePort } from "../../support/free-port.js";
import { EchoChannelAdapter } from "@comis/channels";
import { TypedEventBus } from "@comis/core";
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
  /**
   * Explicit gateway port to use for the test daemon. When omitted,
   * `init()` allocates a free port via `getFreePort()` so that parallel
   * vitest forks do not collide on the config-default port (4766).
   */
  gatewayPort?: number;
}

// ---------------------------------------------------------------------------
// Internal type helpers
// ---------------------------------------------------------------------------

type RpcEnvelope = {
  result?: { response?: string; error?: string; finishReason?: string };
  error?: { code: number; message: string };
};

/**
 * Parse an agent.execute RPC envelope into the agent's reply text.
 *
 * 260611 live-fire fix: the gateway's handleAgentRequest returns
 * `{ response, tokensUsed, finishReason }` (packages/gateway/src/rpc/
 * rpc-adapters.ts) — the driver previously read `result.reply`, a field that
 * has never existed, so EVERY live turn threw "returned no reply string" even
 * when the model answered. Handler-level failures also arrive as
 * `result.error` (a string), not as a JSON-RPC error object — both shapes now
 * fail honestly.
 *
 * Exported for unit tests (conversation.test.ts) — pure, no I/O.
 *
 * @throws on JSON-RPC error envelopes, handler `result.error`, or a missing
 *         response string. A degraded-but-honest reply (finishReason:"error"
 *         fallback text) is RETURNED, not thrown — scenario oracles judge it.
 */
export function parseAgentExecuteResult(envelope: RpcEnvelope): string {
  if (envelope.error) {
    throw new Error(
      `agent.execute RPC error ${envelope.error.code}: ${envelope.error.message}`,
    );
  }
  const result = envelope.result;
  if (result?.error) {
    throw new Error(`agent.execute handler error: ${result.error}`);
  }
  const response = result?.response;
  if (typeof response !== "string" || response.length === 0) {
    throw new Error(
      `agent.execute returned no response string (result: ${JSON.stringify(result)})`,
    );
  }
  return response;
}

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
  private _explicitGatewayPort: number | undefined;

  // Allocated once in init() and reused for restart() so the daemon always
  // re-binds the same port (restart survival semantics).
  private _gatewayPort: number | undefined;

  // Set by init()
  private _handle: TestDaemonHandle | undefined;
  private _echo: EchoChannelAdapter | undefined;
  private _logCapture: ReturnType<typeof createLogCapture> | undefined;

  /**
   * Captured EventBus events from the daemon, accumulated since init() (or last restart()).
   * Populated by _subscribeToEventBus() which subscribes to the context:* event keys
   * on the daemon's TypedEventBus (handle.daemon.container.eventBus).
   *
   * TypedEventBus has no wildcard .on("*") — we subscribe to each context:* key
   * individually. This covers the events needed for CTX-01/CTX-03 and later phases
   * (e.g. 141 ORCH graph:state_changed can add subscriptions here as needed).
   *
   * T-138-02-01: event payloads contain only metadata (IDs, counts, durations) per
   * events-messaging.ts — never message content. capturedEvents() is safe to call
   * from live test assertions (log-oracle FND-10 covers the log stream separately).
   */
  private _capturedEvents: Array<{ name: string; payload: unknown }> = [];

  // For COMIS_DATA_DIR env restore
  private _priorDataDir: string | undefined;
  private _hadDataDir: boolean;

  constructor(opts?: ConversationDriverOptions) {
    this._agentId = opts?.agentId ?? "loop-test-agent";
    this._provider = opts?.provider ?? "anthropic";
    this._timeoutMs = opts?.timeoutMs ?? 30_000;
    this._configPath = opts?.configPath;
    this._explicitGatewayPort = opts?.gatewayPort;

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
    // Allocate a unique gateway port for this driver instance so that
    // parallel vitest forks do not collide on the config-default port (4766).
    // An explicit port from options takes priority; otherwise ask the OS for
    // a free ephemeral port. The port is stored on the instance so restart()
    // re-binds the same port (restart survival semantics — T-136-01).
    if (this._gatewayPort === undefined) {
      this._gatewayPort = this._explicitGatewayPort ?? await getFreePort();
    }

    // Write a per-driver temp config with the unique port substituted.
    // The daemon reads its listen port from the YAML config — gatewayPort on
    // TestDaemonOptions only controls the URL the harness connects to, not the
    // actual bind port. By rewriting the config we guarantee the daemon and
    // the harness agree on the same port (T-136-01, parallel-fork collision fix).
    const resolvedConfigPath = this._buildPortedConfigPath(this._gatewayPort);

    // Log capture with raw payloads for log-oracle assertions (T-136-01-01)
    this._logCapture = createLogCapture();

    // Boot the in-process daemon with log tee + raw payloads.
    // Pass gatewayPort so the harness builds gatewayUrl from the same port
    // the config tells the daemon to bind.
    this._handle = await startTestDaemon({
      logStream: this._logCapture.stream,
      disableRedaction: true,
      configPath: resolvedConfigPath,
      gatewayPort: this._gatewayPort,
    });

    // Subscribe to context:* events on the daemon's TypedEventBus so that
    // capturedEvents() can return them for CTX-01/CTX-03 scenario assertions.
    // TypedEventBus has no wildcard .on("*") — subscribe to each key individually.
    this._capturedEvents = [];
    this._subscribeToEventBus(this._handle.daemon.container.eventBus);

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
   * The echo adapter's sentMessages buffer is NOT cleared after a turn — callers
   * can read getEcho().getSentMessages() after sendTurn() returns to inspect
   * delivery (rung-1 world-state). Call echo.reset() explicitly between turns
   * only when a clean buffer is required for the next turn's assertions.
   *
   * @param text - The user message to send to the agent.
   * @returns The agent's reply string.
   * @throws If the RPC returns an error, the reply is missing, or timeout expires.
   */
  async sendTurn(text: string): Promise<string> {
    const handle = this._requireHandle();

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
      return parseAgentExecuteResult(resp as RpcEnvelope);
    } finally {
      ws.close();
    }
  }

  /**
   * Inject an inbound voice-note NormalizedMessage via the echo adapter (MEDIA-01).
   *
   * Use base64-encoded audio bytes; mimeType defaults to "audio/ogg". The message
   * carries a single audio attachment with isVoiceNote:true so the inbound pipeline's
   * media handler attempts STT transcription before the agent loop.
   *
   * Unlike sendTurn (which uses the agent.execute RPC — text only), this goes
   * through injectMessage so voice/audio attachments are exercised. Real STT then
   * requires COMIS_LIVE + provider keys (Stage-C); keyless runs assert pipeline
   * routing / fallback behavior from the structured logs.
   *
   * @param audioBase64 - base64-encoded audio bytes (test payloads only).
   * @param mimeType - audio MIME type (default "audio/ogg").
   */
  async sendVoice(audioBase64: string, mimeType = "audio/ogg"): Promise<void> {
    const url = `data:${mimeType};base64,${audioBase64}`;
    await this._requireEcho().injectMessage({
      id: randomUUID(),
      channelId: "echo-live",
      channelType: "echo",
      senderId: "test-user",
      text: "",
      timestamp: Date.now(),
      attachments: [{ type: "audio" as const, url, mimeType, isVoiceNote: true }],
      metadata: {},
    });
  }

  /**
   * Inject an inbound image NormalizedMessage via the echo adapter (MEDIA-03).
   *
   * Use base64-encoded image bytes; mimeType defaults to "image/jpeg". The message
   * carries a single image attachment so the inbound pipeline's media handler
   * attempts vision analysis. Real analysis requires COMIS_LIVE + provider keys
   * (Stage-C); keyless runs assert capability-routing decisions.
   *
   * @param imageBase64 - base64-encoded image bytes (test payloads only).
   * @param mimeType - image MIME type (default "image/jpeg").
   */
  async sendImage(imageBase64: string, mimeType = "image/jpeg"): Promise<void> {
    const url = `data:${mimeType};base64,${imageBase64}`;
    await this._requireEcho().injectMessage({
      id: randomUUID(),
      channelId: "echo-live",
      channelType: "echo",
      senderId: "test-user",
      text: "",
      timestamp: Date.now(),
      attachments: [{ type: "image" as const, url, mimeType }],
      metadata: {},
    });
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

    // Boot fresh daemon on same dataDir (SQLite state persists).
    // Pass the same config (with the same unique port) that was used in init()
    // so the restarted daemon binds the same port (restart survival semantics —
    // T-136-01). Caller-supplied opts can override, but should rarely need to.
    const resolvedConfigPath = this._gatewayPort !== undefined
      ? this._buildPortedConfigPath(this._gatewayPort)
      : undefined;
    this._handle = await startTestDaemon({
      logStream: this._logCapture.stream,
      disableRedaction: true,
      ...(resolvedConfigPath ? { configPath: resolvedConfigPath, gatewayPort: this._gatewayPort } : {}),
      ...opts,
    });

    // Reset event capture and re-subscribe on the new daemon instance.
    // The prior daemon's eventBus is gone after cleanup(); re-subscribing
    // ensures capturedEvents() reflects only this daemon session's events.
    this._capturedEvents = [];
    this._subscribeToEventBus(this._handle.daemon.container.eventBus);

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
  // capturedEvents() — return daemon EventBus events captured since init()
  // ---------------------------------------------------------------------------

  /**
   * Return all EventBus events captured since the last init() or restart() call.
   *
   * Events are recorded by subscribing to specific context:* keys on
   * handle.daemon.container.eventBus (a TypedEventBus — no wildcard .on("*")).
   * The subscribed events cover the CTX-01/CTX-03 observable set plus MEM-08:
   *   context:dag_compacted, context:dag_expanded, context:dag_degraded,
   *   context:evicted, context:masked, context:mode_switched,
   *   compaction:started, compaction:flush, context:compacted,
   *   memory:injected (MEM-08 recall injection count)
   *
   * Returns a COPY of the internal array — mutations do not affect captured state.
   *
   * Used by assertP1HonestPresentation and assertP2UncertaintyClauses in
   * dag-invariants.test.ts Stage-C (CTX-03). Safe: per T-138-02-01, event
   * payloads carry only identifiers + counts + durations — never message content.
   */
  capturedEvents(): Array<{ name: string; payload: unknown }> {
    return [...this._capturedEvents];
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  /** Returns the isolated temp data dir for this driver instance. */
  getDataDir(): string {
    return this._dataDir;
  }

  /**
   * Resolve the ACTUAL memory DB path from the booted daemon's own config —
   * `resolve(config.dataDir, config.memory.dbPath)` (absolute dbPath returned
   * unchanged). Requires init().
   *
   * 260611 live-fire fix: scenario files previously hand-built
   * `join(getDataDir(), "memory.db")`, which never matched the test config's
   * `memory.dbPath: "test-memory-default.db"` — so every
   * `if (existsSync(dbPath))`-guarded db-oracle silently skipped and ground
   * truth was never checked (the §2.10 hand-built-path bug class). This
   * accessor is the single source of truth: the path comes from the live
   * daemon's resolved config, not a guess.
   */
  getMemoryDbPath(): string {
    const handle = this._requireHandle();
    const cfg = (
      handle.daemon as unknown as {
        container: { config: { dataDir?: string; memory: { dbPath?: string } } };
      }
    ).container.config;
    const dbPath = cfg.memory.dbPath || "memory.db";
    if (isAbsolute(dbPath)) return dbPath;
    return resolve(cfg.dataDir || this._dataDir, dbPath);
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
    try {
      if (this._handle) {
        try {
          await this._handle.cleanup();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("Daemon exit")) throw err;
        }
        this._handle = undefined;
      }
    } finally {
      // Restore COMIS_DATA_DIR unconditionally — must run even on cleanup() error.
      if (this._hadDataDir && this._priorDataDir !== undefined) {
        process.env["COMIS_DATA_DIR"] = this._priorDataDir;
      } else {
        delete process.env["COMIS_DATA_DIR"];
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to specific context:* event keys on the given TypedEventBus.
   * TypedEventBus wraps Node.js EventEmitter and has NO wildcard .on("*") —
   * each event key is subscribed individually.
   *
   * Extracted as a named method so restart() and tests (via StubDriverWithBus)
   * can re-wire the subscription on a fresh bus instance.
   *
   * Events subscribed:
   *   - context:dag_compacted (CTX-03 P1/P2 — honest presentation)
   *   - context:dag_expanded  (DAG expansion tool use)
   *   - context:dag_degraded  (DAG robustness signal)
   *   - context:evicted       (O1 — DAG activity metrics)
   *   - context:masked        (observation masker applied)
   *   - context:mode_switched (engine mode change)
   *   - context:compacted     (pipeline-mode compaction)
   *   - compaction:started    (compaction trigger point)
   *   - compaction:flush      (pre-compaction flush)
   *   - memory:injected       (MEM-08 recall injection count)
   *   - graph:node_updated    (ORCH-01 — DAG node state change)
   *   - graph:started         (ORCH-01 — DAG execution started)
   *   - graph:completed       (ORCH-01 — DAG execution completed)
   *   - graph:driver_lifecycle (ORCH-01 — DAG driver lifecycle event)
   *   - session:sub_agent_spawned      (ORCH-02 — sub-agent spawn success)
   *   - session:sub_agent_completed    (ORCH-02 — sub-agent completion)
   *   - session:sub_agent_spawn_rejected (ORCH-02 — hop-cap / limit rejection)
   */
  protected _subscribeToEventBus(bus: TypedEventBus): void {
    const capture = (name: string) => (payload: unknown) => {
      this._capturedEvents.push({ name, payload });
    };

    bus.on("context:dag_compacted",  capture("context:dag_compacted") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("context:dag_expanded",   capture("context:dag_expanded") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("context:dag_degraded",   capture("context:dag_degraded") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("context:evicted",        capture("context:evicted") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("context:masked",         capture("context:masked") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("context:mode_switched",  capture("context:mode_switched") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("context:compacted",      capture("context:compacted") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("compaction:started",     capture("compaction:started") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("compaction:flush",       capture("compaction:flush") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("memory:injected",        capture("memory:injected") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("graph:node_updated",             capture("graph:node_updated") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("graph:started",                  capture("graph:started") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("graph:completed",                capture("graph:completed") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("graph:driver_lifecycle",         capture("graph:driver_lifecycle") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("session:sub_agent_spawned",      capture("session:sub_agent_spawned") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("session:sub_agent_completed",    capture("session:sub_agent_completed") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("session:sub_agent_spawn_rejected", capture("session:sub_agent_spawn_rejected") as Parameters<TypedEventBus["on"]>[1]);
    // Media events (Phase 142) — ONLY the media:* keys that exist in the @comis/core
    // TypedEventBus EventMap. media:file_extracted / media:file_persisted are the ONLY
    // media:* events (verified via `grep -rn '"media:' packages/core/src/event-bus/`).
    // There is NO tts_synthesized / voice_sent / transcription_done / image_analyzed /
    // image_generated event — bus.on() on those would be a TypeScript compile error.
    // The Wave-2 media scenarios assert on product-function return values + structured
    // loggers, NOT on media:* events, so no further event capture is required here.
    bus.on("media:file_extracted",   capture("media:file_extracted") as Parameters<TypedEventBus["on"]>[1]);
    bus.on("media:file_persisted",   capture("media:file_persisted") as Parameters<TypedEventBus["on"]>[1]);
  }

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

  /**
   * Build (or reuse) a per-driver temp config file with `gateway.port` set to
   * the given port. The daemon reads the bind port from YAML — `gatewayPort`
   * on TestDaemonOptions only controls the URL string the harness connects to,
   * not the actual port the server listens on. Writing a per-driver config file
   * ensures the daemon and the harness agree on the same port.
   *
   * If the caller provided an explicit `configPath` in options, we patch that
   * file's port; otherwise we patch the default config.test.yaml.
   *
   * The temp file is written into the OS temp dir alongside the data dir and
   * is not cleaned up explicitly — OS temp cleanup handles it.
   */
  private _buildPortedConfigPath(port: number): string {
    // Resolve the base config path (caller-supplied or the standard default)
    const here = dirname(fileURLToPath(import.meta.url));
    const baseConfig = this._configPath
      ?? resolve(here, "../../config/config.test.yaml");

    const content = readFileSync(baseConfig, "utf-8");
    // Replace the gateway port line robustly: locate the gateway: block and
    // patch only the first "port:" line within that block's indented region.
    // A cross-block regex can silently patch a different section's port: key
    // when the gateway block has no inline port: or the config is non-standard.
    const gatewayIdx = content.indexOf("\ngateway:");
    if (gatewayIdx === -1) {
      throw new Error(
        `_buildPortedConfigPath: 'gateway:' block not found in ${baseConfig}`,
      );
    }
    const before = content.slice(0, gatewayIdx);
    const afterGateway = content.slice(gatewayIdx);
    // Only patch the first "port:" that appears inside the gateway block
    // (indented lines — before the next top-level YAML key).
    const patchedBlock = afterGateway.replace(/(\n\s+port:\s*)\d+/, `$1${port}`);
    if (patchedBlock === afterGateway) {
      throw new Error(
        `_buildPortedConfigPath: no 'port:' found inside 'gateway:' block in ${baseConfig}`,
      );
    }
    const patched = before + patchedBlock;
    // Write to the same temp dir as the data dir so they share a lifetime.
    const tempConfigPath = join(this._dataDir, "config.test.patched.yaml");
    writeFileSync(tempConfigPath, patched, "utf-8");
    return tempConfigPath;
  }
}

// ---------------------------------------------------------------------------
// flushDaemonLogs — shared flush-sentinel helper (extracted from afterEach hooks)
// ---------------------------------------------------------------------------

/**
 * Write a unique flush-sentinel log line to the daemon and poll until it
 * appears in the driver's captured log entries.
 *
 * Required before log-oracle snapshots (T-134-flush): Pino's async worker
 * may not have flushed the last 1–2 lines by the time an assertion runs.
 * Writing a sentinel and waiting for it ensures the buffer is drained.
 *
 * @param driver - The ConversationDriver whose daemon logger to write to.
 * @param budgetMs - Maximum wait time in milliseconds (default: 2000).
 */
export async function flushDaemonLogs(
  driver: ConversationDriver,
  budgetMs = 2000,
): Promise<void> {
  const handle = driver.getHandle();
  const sentinelKey = `end-${randomUUID()}`;
  handle.daemon.logger.debug({ sentinel: sentinelKey }, "flush-sentinel");
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (driver.capturedLogLines().includes(sentinelKey)) break;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
}
