// SPDX-License-Identifier: Apache-2.0
/**
 * `rig` — `startRig({ channel, model })`: the boot orchestration that wires the
 * `TgEmulator` to a REAL, isolated Comis daemon and returns the round-trip
 * driver handle (RIG-01 + RIG-02, Phase 204 — the phase KEYSTONE glue).
 *
 * This is the whole walking-skeleton integration in one function:
 *
 *   1. start the `TgEmulator` (Plan 03) → `{ apiRoot: "http://127.0.0.1:P", port }`;
 *   2. register the generic control API (Plan 04) on the emulator's SHARED
 *      http-backend base → the in-proc `ControlClient` (inject + reply-wait);
 *   3. pick a free gateway port G;
 *   4. write a THROWAWAY YAML config (the daemon resolves config ONLY from
 *      `COMIS_CONFIG_PATHS` — `DaemonOverrides` has NO config field; the emulator
 *      port is kernel-allocated at runtime so the config MUST be written AFTER the
 *      emulator starts) with `channels.telegram.apiRoot = http://127.0.0.1:P`
 *      (the redirect seam — the WHOLE integration, ZERO production code change),
 *      a keyless `ollama` provider ($0/offline), and a ≥32-char LITERAL gateway
 *      token (env-refs do NOT resolve for the test gateway);
 *   5. boot the daemon via `startTestDaemon({ configPath, gatewayPort })` — REUSED
 *      directly (A4) so the rig inherits its `process.exit`→throw guard, the
 *      `/health` poll, the double-start guard, and the per-fork data-dir isolation;
 *   6. return `{ emulator, controlClient, chat, gatewayUrl, authToken, send,
 *      waitForReply, cleanup }`.
 *
 * The `apiRoot` seam is verified end-to-end at HEAD
 * (`packages/daemon/src/wiring/setup-channels-adapters.ts:90-110`): setting
 * `channels.telegram.apiRoot` in the config is sufficient — the daemon passes it
 * to BOTH `validateBotToken` (the boot `getMe`) and `createTelegramPlugin` (the
 * runtime grammy client). So the real grammy adapter token-validates + long-polls
 * against the emulator with NO production code change. If any `packages` source-tree
 * edit ever seems required to make this work, STOP — it contradicts the milestone.
 *
 * Boot $0/offline: `models.defaultProvider: ollama` + a keyless provider entry
 * (ollama is in `KEYLESS_PROVIDER_TYPES`; the daemon registers the
 * `ollama-no-auth` sentinel) so the daemon never FATALs on a missing API key and
 * never makes a paid call. The agent-authored *content* reply still needs a
 * reachable model (a real ollama on `localhost:11434`) — that is the
 * `COMIS_LIVE` Stage-C leg of the scenario, NOT a CI dependency. The CI leg
 * asserts the round-trip STRUCTURE only (see `telegram-emulator.test.ts`).
 *
 * TEST-HARNESS — lives under `test/`, never `packages`; ZERO production code
 * change. `test/` is outside every `packages` source-tree ESLint/architecture
 * rule, so `mkdtempSync` / `writeFileSync` / raw `throw` are fine here. Build
 * first: this file boots `@comis/daemon` from `dist/` (a stale `dist/` silently
 * masks `src/`); the milestone changes no `packages/*` source, so `dist` stays
 * valid.
 *
 * @module
 */

import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { startTestDaemon, type TestDaemonHandle } from "../../support/daemon-harness.js";
import { createTgEmulator, type TgEmulator, type RecordedOutbound, type ChatRef } from "../emulators/telegram/tg-emulator.js";
import { registerControlApi, type ControlClient } from "./control-api.js";
import {
  writeHandle,
  readHandle,
  handlePath,
  probeHealth,
  type ChanliveHandle,
} from "./chanlive-handle.js";
import { createRigController, type RigController } from "./rig-control.js";

/**
 * The ≥32-char LITERAL gateway token the temp config carries.
 *
 * Pitfall 4 (RESEARCH / schema-gateway.ts:45 `z.string().min(32)`;
 * token-auth.ts `timingSafeEqual`): a literal must be ≥32 chars and an env-ref
 * does NOT resolve for the test gateway. This is the canonical 38-char
 * `config.test.yaml` literal — reused verbatim.
 */
const GATEWAY_TOKEN = "test-secret-key-for-integration-tests";

/**
 * The FIXED test chat id the round-trip injects into. A fabricated id far from
 * any real operator chat (T-204-15 / I6) — the throwaway daemon never touches a
 * real Telegram account, but a fixed, unmistakable id keeps the oracle clear.
 */
const DEFAULT_CHAT_ID = 424242;

/** The (human) sender id the round-trip injects from. */
const DEFAULT_FROM_USER_ID = 100;

/** The fake bot token grammy builds `/bot<token>/<method>` paths from (never hits real Telegram). */
const FAKE_BOT_TOKEN = "1234567:emulator-fake-token";

/**
 * The isolated `memory.db` file name the throwaway config writes (under the rig's
 * `COMIS_DATA_DIR`). Threaded into both {@link buildConfigYaml} and the
 * {@link BuiltRig.memoryDbPath} the controller's `resetDeep()` wipes, so the YAML
 * and the recorded path can never drift.
 */
const MEMORY_DB_FILE = "test-memory-channel-emu.db";

/** Options for {@link startRig}. */
export interface StartRigOptions {
  /** The channel to emulate. Phase 204 ships Telegram; channel #2 is Phase 209. */
  readonly channel: "telegram";
  /**
   * The model the booted daemon's agent runs. `"keyless"` → a keyless `ollama`
   * provider ($0/offline; the agent-content reply is the COMIS_LIVE leg). Any
   * other string is treated as the provider/model id verbatim (operator/live.env).
   */
  readonly model: "keyless" | string;
  /** Reserved for a future group/forum round-trip (Phase 206+); unused in 204. */
  readonly group?: boolean;
}

/**
 * The rig handle — the round-trip driver surface the scenario uses.
 *
 * `send`/`waitForReply` delegate to the in-proc `ControlClient` (inject + the
 * honest reply-wait). `cleanup()` tears down the daemon (via the
 * `startTestDaemon` cleanup), stops the emulator, and removes the throwaway
 * config + data dirs — order matters (daemon first so its grammy client stops
 * polling the emulator before the emulator closes).
 */
export interface RigHandle {
  /** The running Telegram emulator (the channel oracle: `outbound()` etc.). */
  readonly emulator: TgEmulator;
  /** The in-process control client (inject + reply-wait). */
  readonly controlClient: ControlClient;
  /** The fixed test chat the round-trip drives. */
  readonly chat: ChatRef;
  /** The booted daemon's gateway base URL (`http://127.0.0.1:<G>`). */
  readonly gatewayUrl: string;
  /** The gateway bearer token (the ≥32-char literal). */
  readonly authToken: string;
  /**
   * Inject an inbound text from the test user into the test chat (the in-proc
   * equivalent of a Telegram DM). Returns the minted inbound message id — the
   * `afterMessageId` watermark a subsequent `waitForReply` filters on.
   */
  send(text: string): Promise<number>;
  /**
   * Block up to `waitMs` for a NEW bot outbound after `afterMessageId`. Returns
   * the first new `RecordedOutbound`, or `undefined` on timeout — an HONEST
   * no-reply, NEVER a fabricated success (I5). The agent-authored reply needs a
   * reachable model (the COMIS_LIVE leg).
   */
  waitForReply(afterMessageId: number, waitMs?: number): Promise<RecordedOutbound | undefined>;
  /** Tear down: stop the daemon, stop the emulator, remove the throwaway temp dirs. */
  cleanup(): Promise<void>;
}

/**
 * {@link RigHandle} PLUS the rig INTERNALS the standalone launcher
 * ({@link startStandaloneRig}) and the rig-control owner (`rig-control.ts`) need
 * but which the public `RigHandle` deliberately hides: the throwaway data /
 * config dirs, the config path + gateway port (for the `restart()` re-boot), the
 * live `TestDaemonHandle`, and the isolated `memory.db` path (for `resetDeep()`).
 *
 * `buildRig` returns this superset; the public {@link startRig} projects only the
 * `RigHandle` fields so its existing surface (and `telegram-emulator.test.ts`) is
 * unchanged.
 */
export interface BuiltRig extends RigHandle {
  /** The emulator's loopback base (`http://127.0.0.1:P`) — the `/control/*` endpoint the handle records. */
  readonly controlEndpoint: string;
  /** The throwaway `COMIS_DATA_DIR` this rig pinned (the dir `resetDeep()` wipes UNDER, never `~/.comis`). */
  readonly dataDir: string;
  /** The throwaway config dir (removed at cleanup). */
  readonly configDir: string;
  /** The throwaway YAML config path (re-passed to `startTestDaemon` on `restart()`). */
  readonly configPath: string;
  /** The gateway port the daemon binds (kept fixed across `restart()` so the handle URL is stable). */
  readonly gatewayPort: number;
  /** The live test-daemon handle (its `cleanup()` clears the `activeHandle` double-start guard — Pitfall 1). */
  readonly daemonHandle: TestDaemonHandle;
  /** `<dataDir>/<memory.dbPath>` — the isolated `memory.db` `resetDeep()` replaces + the oracles read. */
  readonly memoryDbPath: string;
  /**
   * Point this rig's `cleanup()` at a NEW `TestDaemonHandle` after a re-boot. The
   * rig-control owner calls this on every `restart()`/`resetDeep()` so a later
   * `cleanup()` tears down the CURRENT daemon, never the stale pre-restart one.
   */
  rebindDaemonHandle(next: TestDaemonHandle): void;
}

/**
 * Pick a free TCP port on loopback by opening a transient `listen(0)` server,
 * reading the kernel-allocated port, then closing it. There is a tiny
 * race-to-rebind window, but `startTestDaemon`'s own `waitForPortFree` guards the
 * gateway bind, so this only needs a plausibly-free starting port.
 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close(() => reject(new Error("could not resolve a free gateway port")));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Build the throwaway daemon YAML. Modeled on
 * `test/config/config.qwen36-local.test.yaml` (the canonical keyless-ollama
 * config) + a `channels.telegram` block carrying the dynamic `apiRoot` seam.
 *
 * - `channels.telegram.apiRoot = http://127.0.0.1:P` — THE integration (zero code
 *   change); `allowFrom: []` allows all senders; a fake `botToken` never reaches
 *   real Telegram.
 * - keyless `ollama` provider — `$0`/offline; the `/v1` suffix is required (pi-ai
 *   posts to `${baseUrl}/chat/completions`; bare ollama 404s without it). No
 *   secret entry (ollama is keyless → the daemon uses the `ollama-no-auth`
 *   sentinel; omitting the key avoids a "Missing env var" FATAL at boot).
 * - `gateway.tokens[0].secret` is the ≥32-char LITERAL (Pitfall 4).
 * - `dataDir: ""` resolves to `COMIS_DATA_DIR` (set per-rig below).
 */
function buildConfigYaml(apiRoot: string, gatewayPort: number, model: string): string {
  // The keyless leg uses ollama; an explicit non-keyless model string is passed
  // through as the provider model id (operator/live.env path).
  const providerModelId = model === "keyless" ? "qwen3.6:35b" : model;
  return `# THROWAWAY config — Phase 204 channel-emulation walking skeleton (rig.ts).
# Written AFTER the emulator starts so channels.telegram.apiRoot carries the
# kernel-allocated emulator port. The daemon reads this via COMIS_CONFIG_PATHS.
tenantId: "test"
logLevel: "debug"
dataDir: "" # Resolves to COMIS_DATA_DIR at runtime (set per-rig by the rig).

channels:
  telegram:
    enabled: true
    # A fake token — grammy builds /bot<token>/<method> paths from it but it
    # never reaches real Telegram (apiRoot redirects every call to the emulator).
    botToken: "${FAKE_BOT_TOKEN}"
    # THE redirect seam — the whole integration, zero production code change
    # (setup-channels-adapters.ts:90-110 passes this to validateBotToken + createTelegramPlugin).
    apiRoot: "${apiRoot}"
    allowFrom: [] # [] = allow all senders.

providers:
  entries:
    keyless-local:
      type: ollama
      # /v1 suffix required: pi-ai registers type=ollama as openai-completions and
      # posts to \`\${baseUrl}/chat/completions\` — bare Ollama 404s without /v1.
      baseUrl: "http://localhost:11434/v1"
      # Keyless — ollama is in KEYLESS_PROVIDER_TYPES; no secret entry needed; the
      # daemon registers the ollama-no-auth sentinel (omitting avoids a boot FATAL).
      models:
        - id: "${providerModelId}"
          input: ["text", "image"]
          contextWindow: 131072
          reasoning: true
          maxTokens: 2048

models:
  # defaultProvider keeps the agent on the keyless local provider ($0/offline).
  defaultProvider: ollama
  # defaultModel lets an ad-hoc agent resolve the custom-provider model.
  defaultModel: "keyless-local:${providerModelId}"

agents:
  default:
    name: "ChannelEmuTestAgent"
    provider: keyless-local
    model: "${providerModelId}"
    maxSteps: 6
    budgets:
      perExecution: 500000
      perHour: 5000000
      perDay: 50000000
    circuitBreaker:
      failureThreshold: 100
      resetTimeoutMs: 1000
    rag:
      enabled: false

gateway:
  enabled: true
  host: "127.0.0.1"
  port: ${gatewayPort}
  tokens:
    - id: "tg-live"
      # ≥32-char LITERAL (38 chars) — env-refs do NOT resolve for the test gateway
      # (schema-gateway.ts:45 z.string().min(32); token-auth.ts timingSafeEqual).
      secret: "${GATEWAY_TOKEN}"
      scopes: ["rpc", "ws", "admin"]
  rateLimit:
    windowMs: 60000
    maxRequests: 10000
  maxBatchSize: 50
  wsHeartbeatMs: 30000

memory:
  dbPath: "${MEMORY_DB_FILE}"

security:
  agentToAgent:
    enabled: true

monitoring:
  disk:
    enabled: false
  resources:
    enabled: false
  systemd:
    enabled: false
  securityUpdates:
    enabled: false
  git:
    enabled: false
`;
}

/**
 * Build the walking-skeleton rig and return the FULL {@link BuiltRig} (the public
 * round-trip driver PLUS the internals the standalone launcher / rig-control owner
 * need). This is the body the public {@link startRig} delegates to; it boots the
 * emulator, writes the temp config with the dynamic `apiRoot` seam + a keyless
 * model + the ≥32-char gateway token, boots an isolated daemon via
 * `startTestDaemon`, and returns the round-trip driver + `{ dataDir, configDir,
 * configPath, gatewayPort, daemonHandle, memoryDbPath }`.
 *
 * The daemon's real grammy adapter token-validates (`getMe`) + registers commands
 * (`setMyCommands`) + long-polls (`getUpdates`) against the emulator at boot; the
 * gateway `/health` is awaited inside `startTestDaemon`. `cleanup()` MUST be
 * called (afterEach/afterAll) to release the daemon, the emulator port, and the
 * throwaway temp dirs.
 */
export async function buildRig(opts: StartRigOptions): Promise<BuiltRig> {
  if (opts.channel !== "telegram") {
    throw new Error(`buildRig: unsupported channel "${opts.channel}" (Phase 204 ships telegram only)`);
  }

  // 1. Start the emulator → the dynamic loopback apiRoot.
  const emulator = createTgEmulator({ botToken: FAKE_BOT_TOKEN });
  const { apiRoot } = await emulator.start();

  // 2. Register the control API on the emulator's SHARED http-backend base so
  //    /control/* and the Bot API share ONE loopback port (SEC-01).
  const controlClient = registerControlApi(emulator.backend, emulator);

  const chat: ChatRef = { chatId: DEFAULT_CHAT_ID };

  // 3. Pick a free gateway port (startTestDaemon's waitForPortFree double-checks it).
  const gatewayPort = await pickFreePort();

  // 4. Write the throwaway config (AFTER the emulator started, so apiRoot is real)
  //    + a fresh per-rig COMIS_DATA_DIR (D14 .daemon.lock isolation; per-fork in
  //    daemon-harness, but the rig pins its OWN so each rig is fully isolated).
  const configDir = mkdtempSync(join(tmpdir(), "comis-rig-cfg-"));
  const configPath = join(configDir, "config.rig.yaml");
  writeFileSync(configPath, buildConfigYaml(apiRoot, gatewayPort, opts.model), "utf-8");

  const dataDir = mkdtempSync(join(tmpdir(), "comis-rig-data-"));
  // startTestDaemon only fills COMIS_DATA_DIR when unset, and restores it after
  // boot — pinning ours here gives this rig its own throwaway data dir (the
  // mkdtemp per-rig isolation the plan calls for).
  const hadDataDirEnv = process.env["COMIS_DATA_DIR"] !== undefined;
  const priorDataDir = process.env["COMIS_DATA_DIR"];
  process.env["COMIS_DATA_DIR"] = dataDir;

  // 5. Boot the daemon (REUSED directly — A4: inherits process.exit→throw, the
  //    /health poll, the double-start guard, and per-fork isolation).
  let daemonHandle: TestDaemonHandle;
  try {
    daemonHandle = await startTestDaemon({ configPath, gatewayPort });
  } catch (err) {
    // Boot failed — restore the env + remove the throwaway dirs before rethrowing.
    if (hadDataDirEnv) process.env["COMIS_DATA_DIR"] = priorDataDir;
    else delete process.env["COMIS_DATA_DIR"];
    await emulator.stop().catch(() => undefined);
    rmSync(configDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
    throw err;
  }

  // Restore COMIS_DATA_DIR to its prior state — the daemon read it once at boot;
  // leaving it set would leak into sibling daemons / CLI subprocesses.
  if (hadDataDirEnv) process.env["COMIS_DATA_DIR"] = priorDataDir;
  else delete process.env["COMIS_DATA_DIR"];

  const { gatewayUrl, authToken } = daemonHandle;
  const memoryDbPath = join(dataDir, MEMORY_DB_FILE);

  // The LIVE daemon handle behind a mutable holder so `cleanup()` always tears
  // down the CURRENT daemon — `restart()`/`resetDeep()` (rig-control.ts) re-boot
  // the daemon and call `rebindDaemonHandle(newHandle)`, so a post-restart
  // `cleanup()` does NOT release a stale, already-cleaned handle (the restart bug
  // class). The controller is wired to this via `RigControlState.onDaemonHandle`.
  let activeDaemon = daemonHandle;
  const rebindDaemonHandle = (next: TestDaemonHandle): void => {
    activeDaemon = next;
  };

  const cleanup = async (): Promise<void> => {
    // Daemon FIRST (stops the grammy client polling the emulator), then the
    // emulator, then the throwaway temp dirs. Reads the CURRENT (possibly
    // post-restart) daemon from the holder.
    try {
      await activeDaemon.cleanup();
    } finally {
      await emulator.stop().catch(() => undefined);
      rmSync(configDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  };

  return {
    emulator,
    controlClient,
    chat,
    gatewayUrl,
    authToken,
    controlEndpoint: apiRoot,
    dataDir,
    configDir,
    configPath,
    gatewayPort,
    daemonHandle,
    memoryDbPath,
    rebindDaemonHandle,
    send(text: string): Promise<number> {
      return controlClient.injectMessage({
        chatId: chat.chatId,
        fromUserId: DEFAULT_FROM_USER_ID,
        text,
      });
    },
    waitForReply(afterMessageId: number, waitMs = 30_000): Promise<RecordedOutbound | undefined> {
      return controlClient.waitForReply({ chatId: chat.chatId, afterMessageId, waitMs });
    },
    cleanup,
  };
}

/**
 * Start the walking-skeleton rig and return the public {@link RigHandle} (the
 * round-trip driver surface the scenarios use). A thin projection over
 * {@link buildRig} — it builds the full rig and returns ONLY the public fields, so
 * the existing `RigHandle` surface (and `telegram-emulator.test.ts`) is unchanged
 * while the standalone launcher / rig-control owner reach the internals via
 * `buildRig`.
 *
 * `cleanup()` MUST be called (afterEach/afterAll) to release the daemon, the
 * emulator port, and the throwaway temp dirs.
 */
export async function startRig(opts: StartRigOptions): Promise<RigHandle> {
  const built = await buildRig(opts);
  // Project the public RigHandle fields only — the internals (dataDir, configPath,
  // daemonHandle, …) stay hidden from the public surface.
  return {
    emulator: built.emulator,
    controlClient: built.controlClient,
    chat: built.chat,
    gatewayUrl: built.gatewayUrl,
    authToken: built.authToken,
    send: built.send.bind(built),
    waitForReply: built.waitForReply.bind(built),
    cleanup: built.cleanup.bind(built),
  };
}

/** Options for {@link startStandaloneRig}. */
export interface StandaloneRigOptions {
  /** The channel to emulate. Phase 204/205 ship Telegram. */
  readonly channel: "telegram";
  /** The model the booted daemon's agent runs (`"keyless"` → keyless ollama; else the provider/model id). */
  readonly model: "keyless" | string;
  /** Reserved for a future group/forum rig (Phase 206+). */
  readonly group?: boolean;
  /**
   * The handle-file base dir (default `~/.comis-chanlive`). Injected by the unit
   * tests so the operator's real handle dir is never touched.
   */
  readonly baseDir?: string;
}

/**
 * The result of {@link startStandaloneRig} — the discover-or-spawn outcome.
 *
 * - `reused: true` → a HEALTHY recorded rig was discovered; `handle` is its
 *   recorded handle, and there is NO `controller`/`cleanup` (we do NOT own a rig
 *   we merely reused — tearing it down is the owner's job, T-205-12).
 * - `reused: false` → a fresh rig was SPAWNED; `controller` drives its lifecycle
 *   (restart / reset-deep) and `cleanup()` tears the rig down AND removes the
 *   handle file.
 *
 * W1 HONESTY (cross-process scope): `controller` is an IN-PROCESS owner — it dies
 * with the launching process. The recorded `handle.rigControlEndpoint` is set to
 * the gateway URL as the discover-or-spawn ANCHOR (the health signal a later
 * `tg up` probes), NOT a cross-process rig-control HTTP surface. A true cold-shell
 * `tg restart` (a SEPARATE process driving the rig) needs a DETACHED subprocess
 * rig, which is NOT built here (deferred to Phase 208). This handle never claims
 * otherwise: it only advertises the gateway anchor it can honestly serve.
 */
export interface StandaloneRig {
  /** Was a healthy recorded rig REUSED (true), or a fresh one SPAWNED (false)? */
  readonly reused: boolean;
  /** The recorded (reused) or freshly-written (spawned) handle. */
  readonly handle: ChanliveHandle;
  /** The in-process lifecycle controller — ONLY on a spawn (we own the rig we spawned). */
  readonly controller?: RigController;
  /** Tear the SPAWNED rig down AND remove the handle file — ONLY on a spawn. */
  cleanup?(): Promise<void>;
}

/** Injectable seams for {@link startStandaloneRig} — defaults wire the real probe + spawn. */
export interface StandaloneRigDeps {
  /** The health probe (default {@link probeHealth}) — the discover signal. */
  readonly probeFn?: (gatewayUrl: string) => Promise<boolean>;
  /** The rig spawner (default {@link buildRig}) — booted only when no healthy rig is discovered. */
  readonly spawnFn?: typeof buildRig;
}

/**
 * The CLI-01 discover-or-spawn launcher (`tg up`): reuse a HEALTHY recorded rig,
 * else spawn a fresh one and write its `0600` handle file.
 *
 * Discover: `readHandle(channel)` → if present AND `probeFn(gatewayUrl)` is true,
 * return `{ reused: true, handle }` WITHOUT spawning (never a second daemon over a
 * healthy one — T-205-12). Spawn: `buildRig(opts)` → assemble the
 * {@link ChanliveHandle} from its internals → `writeHandle` (`0600`) → wrap a
 * {@link createRigController} → return `{ reused: false, handle, controller,
 * cleanup }` where `cleanup` tears the rig down AND removes the handle file.
 */
export async function startStandaloneRig(
  opts: StandaloneRigOptions,
  deps: StandaloneRigDeps = {},
): Promise<StandaloneRig> {
  const probeFn = deps.probeFn ?? probeHealth;
  const spawnFn = deps.spawnFn ?? buildRig;

  // DISCOVER — reuse a healthy recorded rig (never spawn a second daemon over it).
  const existing = readHandle(opts.channel, opts.baseDir);
  if (existing && (await probeFn(existing.gatewayUrl))) {
    return { reused: true, handle: existing };
  }

  // SPAWN — no healthy rig; boot a fresh one and record its handle. Include
  // `group` only when set (exactOptionalPropertyTypes: an absent optional ≠ undefined).
  const built = await spawnFn({
    channel: opts.channel,
    model: opts.model,
    ...(opts.group !== undefined ? { group: opts.group } : {}),
  });

  // Assemble the handle from the spawned rig's internals. W1: rigControlEndpoint =
  // the gateway URL (the discover-or-spawn anchor — what a later `tg up` probes),
  // NOT a cross-process rig-control HTTP surface (the in-proc controller can't be
  // driven cross-process; a detached-subprocess rig is Phase 208).
  const handle: ChanliveHandle = {
    channel: opts.channel,
    controlEndpoint: built.controlEndpoint,
    rigControlEndpoint: built.gatewayUrl,
    gatewayUrl: built.gatewayUrl,
    gatewayToken: built.authToken,
    chatId: built.chat.chatId,
    dataDir: built.dataDir,
    memoryDbPath: built.memoryDbPath,
  };
  writeHandle(handle, opts.baseDir);

  // Wrap the lifecycle controller (restart / reset-deep). onDaemonHandle keeps the
  // rig's cleanup() pointed at the post-restart daemon (never a stale one).
  const controller = createRigController({
    emulator: built.emulator,
    daemonHandle: built.daemonHandle,
    dataDir: built.dataDir,
    configPath: built.configPath,
    gatewayPort: built.gatewayPort,
    gatewayUrl: built.gatewayUrl,
    chat: built.chat,
    memoryDbPath: built.memoryDbPath,
    onDaemonHandle: built.rebindDaemonHandle,
  });

  const cleanup = async (): Promise<void> => {
    // Tear the rig down (daemon → emulator → temp dirs) AND remove the handle file
    // so a later discover does not resolve a dead handle.
    try {
      await built.cleanup();
    } finally {
      const path = handlePath(opts.channel, opts.baseDir);
      if (existsSync(path)) rmSync(path, { force: true });
    }
  };

  return { reused: false, handle, controller, cleanup };
}
