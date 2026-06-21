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
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateLocalServerUrl } from "@comis/core";
import { startTestDaemon, type TestDaemonHandle } from "../../support/daemon-harness.js";
import { createTgEmulator, type TgEmulator, type ChatRef } from "../emulators/telegram/tg-emulator.js";
import { createSignalEmulator, type SignalEmulator } from "../emulators/signal/signal-emulator.js";
import type { ChannelEmulator } from "./channel-emulator.js";
import type { HttpBackend } from "./backends/http-backend.js";
import { registerControlApi, type ControlClient } from "./control-api.js";
// `RigHandle.waitForReply` is the GENERIC round-trip driver surface (Phase 209
// channel #2 reuses it), so it surfaces the channel-agnostic outbound subset
// lifted to harness/ (the foundation-fix, CHAN2-02) — NOT the telegram superset.
// It delegates to the generic control client, which returns this same subset.
import type { RecordedOutbound } from "./recorded-outbound.js";
// TEST-ONLY deep-dist imports. `setupMedia` + `MediaResult` and `fetchPinned` are
// NOT re-exported from the `@comis/daemon` / `@comis/skills` top barrels (and the
// vitest live-config alias maps each `@comis/*` to its `dist/index.js` FILE, so a
// subpath like `@comis/daemon/wiring` does not resolve through it). The override
// MUST delegate to the REAL `setupMedia` — `MediaResult` carries ~15 internally-
// constructed fields (linkRunner, mediaTempManager, visionRegistryHolder, …) that
// cannot be reconstructed by hand — so a relative `dist/` import is the sanctioned
// escape hatch (the SAME staleness contract as the alias: `pnpm build` first). This
// keeps the SSRF allowance entirely test-scoped — ZERO `packages/*/src/**` change
// (no barrel edit, no resolver/validateUrl edit). See 207-05-PLAN.md SEC-01 / I1.
import { setupMedia, type MediaResult } from "../../../packages/daemon/dist/wiring/index.js";
import { fetchPinned } from "../../../packages/skills/dist/tools/integrations/pinned-fetch.js";
import {
  writeHandle,
  readHandle,
  handlePath,
  probeHealth,
  type ChanliveHandle,
} from "./chanlive-handle.js";
import { createRigController, type RigController } from "./rig-control.js";
// `buildConfigYaml` + its constants live in their OWN `@comis/*`-free module so
// the DETACHED-subprocess rig (`rig-daemon.ts`, Plan 208-08) can import the SAME
// config writer under a bare `tsx` (where `rig.ts`'s `@comis/core` import does not
// resolve). Re-export `buildConfigYaml` below so `rig.ts`'s public surface (and
// `rig.test.ts`) is unchanged.
import {
  FAKE_BOT_TOKEN,
  MEMORY_DB_FILE,
  GATEWAY_TOKEN,
  buildConfigYaml,
  buildSignalConfigYaml,
} from "./rig-config.js";

export { buildConfigYaml, buildSignalConfigYaml } from "./rig-config.js";

/**
 * The FIXED test chat id the round-trip injects into. A fabricated id far from
 * any real operator chat (T-204-15 / I6) — the throwaway daemon never touches a
 * real Telegram account, but a fixed, unmistakable id keeps the oracle clear.
 */
const DEFAULT_CHAT_ID = 424242;

/** The (human) sender id the round-trip injects from. */
const DEFAULT_FROM_USER_ID = 100;

/**
 * The body-size cap the loopback SSRF fetcher enforces (MEDIA-02, a second-line
 * guard behind the resolver's pre-download `file_size > maxBytes` check). 50 MiB —
 * generous enough for any driver-injected fixture, far below an OOM risk; the
 * emulator only ever serves loopback fixtures the driver itself supplied (T-207-13).
 */
const RIG_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// CHAN2-01 + CHAN2-02 (Phase 209) — the channel→{emulator-factory, config-writer}
// dispatch MAP. THE foundation-fix: the telegram-first rig hard-coded the channel
// (a `"telegram"` literal type), THREW on any other channel, hard-constructed
// `createTgEmulator`, and hard-wrote `buildConfigYaml`. This map IS the
// generalization — and the registration point where "channel #2 is a one-line
// rig registration" actually lands: the `signal:` entry below.
//
// `buildRig`/`startStandaloneRig` look up `RIG_CHANNELS[opts.channel]` and call
// `.make(opts)` for the emulator + `.writeConfig(seamUrl, gatewayPort, model)` for
// the throwaway YAML. EVERYTHING ELSE — the daemon boot, the `mkdtemp` isolation,
// cleanup, `rebindDaemonHandle` — is channel-agnostic and reused UNCHANGED.
// ---------------------------------------------------------------------------

/** The channels the rig can emulate. Telegram (204/205) + Signal (209). */
export type RigChannel = "telegram" | "signal";

/**
 * The minimal emulator surface the rig drives, channel-agnostically: the
 * `ChannelEmulator` lifecycle (`start()`/`stop()`/`caps`) PLUS the shared
 * `http-backend` base the control API / SSRF routes register on. Both
 * `TgEmulator` and `SignalEmulator` satisfy this (each `extends ChannelEmulator`
 * and exposes `backend`).
 */
export type RigEmulator = ChannelEmulator & { readonly backend: HttpBackend };

/**
 * One channel's rig registration: the emulator FACTORY + the config WRITER. The
 * factory mints the per-channel wire emulator (Telegram needs `{ botToken }`;
 * Signal needs no token); the writer renders the throwaway YAML wiring the
 * channel's REDIRECT SEAM to the started emulator's loopback `apiRoot` (Telegram
 * → `channels.telegram.apiRoot`; Signal → `channels.signal.baseUrl`). The
 * `seamUrl` is ALWAYS the emulator's `apiRoot` — the channel decides which config
 * key it lands under.
 */
export interface ChannelRigEntry {
  /** Mint the per-channel wire emulator (started by the rig). */
  readonly make: (opts: { readonly channel: RigChannel; readonly model: string }) => RigEmulator;
  /** Render the throwaway YAML wiring `seamUrl` (the emulator apiRoot) to the channel's config key. */
  readonly writeConfig: (seamUrl: string, gatewayPort: number, model: string) => string;
}

/**
 * The channel→{factory, config-writer} dispatch MAP (the foundation-fix
 * registration point). The `signal:` entry is the ONE-LINE registration
 * (CHAN2-01): `createSignalEmulator` + `buildSignalConfigYaml`. The `telegram:`
 * entry MUST produce the byte-identical `createTgEmulator` + `buildConfigYaml`
 * output (the public surface is inviolate, 205-04).
 *
 * EXPORTED so the Task-2 dispatch tests assert the registration + the per-channel
 * factory/writer wiring deterministically (no daemon).
 */
export const RIG_CHANNELS: Record<RigChannel, ChannelRigEntry> = {
  telegram: {
    // Telegram keeps its fake bot token (grammy builds /bot<token>/<method> paths
    // from it; apiRoot redirects every call to the emulator).
    make: () => createTgEmulator({ botToken: FAKE_BOT_TOKEN }),
    // The telegram seam: channels.telegram.apiRoot = the emulator apiRoot.
    writeConfig: (seamUrl, gatewayPort, model) => buildConfigYaml(seamUrl, gatewayPort, model),
  },
  signal: {
    // The ONE-LINE signal registration — Signal needs no bot token (signal-cli
    // is account-less at boot; the rig writes no `account` → the GET /api/v1/check
    // health-check is the whole boot).
    make: () => createSignalEmulator(),
    // The signal seam: channels.signal.baseUrl = the emulator apiRoot.
    writeConfig: (seamUrl, gatewayPort, model) => buildSignalConfigYaml(seamUrl, gatewayPort, model),
  },
};

/**
 * Wire the in-process {@link ControlClient} for a rig's emulator. The control API
 * (`/control/*`) is the channel-AGNOSTIC driver surface, but its handlers expect
 * the Telegram emulator's numeric-`chatId` `ControlEmulator` shape. A
 * `ControlEmulator` (the Telegram emulator) gets the REAL `registerControlApi`
 * client; a non-control emulator (the Signal emulator, whose chat is a STRING)
 * gets a thin client backed by the emulator's OWN inject/outbound verbs for the
 * round-trip (`injectMessage`/`waitForReply`), with the Telegram-only verbs
 * (media/location/callback/edit/fault) throwing an honest `unsupported_on_channel`
 * rather than a silent no-op (§3A.4 / I5).
 *
 * The Signal round-trip wiring is exercised by the 209-06/07 scenario; this plan
 * proves the DISPATCH (a Signal rig boots + the seam wires). The Signal control
 * client keys on a fixed Signal chat string (the rig's `chat`), so `send` injects
 * an inbound the booted daemon's real Signal adapter pulls from the SSE stream.
 */

/**
 * Is `emulator` the Telegram emulator (the one native `ControlEmulator`)? It is
 * the only emulator carrying the Bot-API fault verbs (`fail`/`clearFaults`) the
 * generic control API requires, so this is the honest structural discriminator
 * between the two channels — a Signal emulator (no fault surface) falls through to
 * the {@link adaptSignalToControlEmulator} path.
 */
function isTelegramControlEmulator(emulator: RigEmulator): emulator is RigEmulator & TgEmulator {
  return (
    typeof (emulator as Partial<TgEmulator>).fail === "function" &&
    typeof (emulator as Partial<TgEmulator>).clearFaults === "function"
  );
}

/**
 * The fixed Signal chat string a Signal rig's round-trip drives. A Signal "chat"
 * is a STRING (a bare recipient / uuid), unlike Telegram's numeric `chatId` — the
 * `/control/*` driver surface is numeric-keyed (the Telegram-first shape), so the
 * Signal control adapter maps the rig's single fixed chat to this string. The
 * booted daemon's real Signal adapter pulls the injected inbound off the SSE
 * stream and replies; the emulator records the outbound under this same key.
 */
export const SIGNAL_RIG_CHAT = "+15555550199";

/**
 * Adapt a {@link SignalEmulator} (string-keyed chat, no Bot-API faults) to the
 * channel-AGNOSTIC `ControlEmulator` the generic `registerControlApi` drives, so
 * the SAME control surface (`/control/*` + the in-proc `ControlClient`) gives the
 * Signal rig its inject + reply-wait round-trip WITHOUT editing `control-api.ts`
 * (a zero-change file). The rig drives ONE fixed chat ({@link SIGNAL_RIG_CHAT}),
 * so the numeric `chatId` the control API passes is mapped to that one Signal
 * string; `from.firstName` carries the Signal sender identifier.
 *
 * Exported (test visibility) so the 209-07 foundation-proof scenario can drive
 * the REAL adapter inject path deterministically (the Stage-C round-trip
 * keystone) without booting a daemon.
 *
 * The CORE round-trip verbs (`injectMessage`/`injectReaction`/`outbound`) delegate
 * to the emulator's own string-keyed verbs. The Telegram-ONLY verbs
 * (`injectMedia`/`injectLocation`/`injectCallback`/`injectEdit`/`fail`/
 * `clearFaults`) throw an honest `unsupported_on_channel` — NEVER a silent no-op
 * (§3A.4 / I5). Signal's media/edit/fault round-trips are NOT part of this
 * foundation-fix; the 209-06/07 scenario exercises the Signal send/react path.
 */
export function adaptSignalToControlEmulator(
  emulator: SignalEmulator,
): import("./control-api.js").ControlEmulator {
  const unsupported = (verb: string): never => {
    throw new Error(`unsupported_on_channel: Signal does not support the control verb "${verb}" (CHAN2 honest-degrade)`);
  };
  return {
    injectMessage(_chat, from, text) {
      // The numeric control-chat maps to the single fixed Signal chat string; the
      // Signal sender identifier rides on `from.firstName` (the control API mints
      // `user_<id>` when absent — for Signal the rig passes the recipient).
      return emulator.injectMessage(SIGNAL_RIG_CHAT, from.firstName, text);
    },
    injectReaction(_chat, from, botMessageId, emoji) {
      // A Signal reaction targets the bot reply's `timestamp` (botMessageId).
      emulator.injectReaction(SIGNAL_RIG_CHAT, from.firstName, botMessageId, emoji);
    },
    outbound(_chat) {
      return emulator.outbound(SIGNAL_RIG_CHAT);
    },
    injectMedia: () => unsupported("injectMedia"),
    injectLocation: () => unsupported("injectLocation"),
    injectCallback: () => unsupported("injectCallback"),
    injectEdit: () => unsupported("injectEdit"),
    fail: () => unsupported("fail"),
    clearFaults: () => unsupported("clearFaults"),
  };
}

/** Options for {@link startRig}. */
export interface StartRigOptions {
  /** The channel to emulate. Telegram (204/205) or Signal (209). */
  readonly channel: RigChannel;
  /**
   * The model the booted daemon's agent runs. `"keyless"` → a keyless `ollama`
   * provider ($0/offline; the agent-content reply is the COMIS_LIVE leg). Any
   * other string is treated as the provider/model id verbatim (operator/live.env).
   */
  readonly model: "keyless" | string;
  /** Reserved for a future group/forum round-trip (Phase 206+); unused in 204. */
  readonly group?: boolean;
  /**
   * MEDIA-02 / SEC-01 (Plan 207-05): opt into the test-scoped SSRF-loopback
   * allowance — the daemon boots with a {@link buildLoopbackMediaOverride}
   * `setupMedia` override so the real SSRF-guarded byte download reaches the
   * loopback emulator (the Stage-C byte-download leg). DEFAULT falsy → NO
   * `setupMedia` override (a standard rig boot is byte-identical; production
   * `validateUrl` posture is untouched). Loopback-ONLY, never a production change.
   */
  readonly mediaLoopbackOverride?: boolean;
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
export interface RigHandle<E extends RigEmulator = TgEmulator> {
  /**
   * The running channel emulator (the channel oracle: `outbound()` etc.).
   * Generic over the emulator type, defaulting to `TgEmulator` so every existing
   * Telegram caller keeps the full Telegram surface unchanged (205-04); a
   * `{channel:"signal"}` rig is `RigHandle<SignalEmulator>`.
   */
  readonly emulator: E;
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
export interface BuiltRig<E extends RigEmulator = TgEmulator> extends RigHandle<E> {
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

// ---------------------------------------------------------------------------
// MEDIA-02 / SEC-01 — the test-scoped SSRF-loopback allowance (Plan 207-05).
//
// The Telegram byte-download has TWO INDEPENDENT blocks (Pitfall 1), and BOTH
// must be addressed for the real SSRF-guarded download to reach the loopback
// emulator:
//   #1 the resolver's download URL is HARDCODED to
//      `https://api.telegram.org/file/bot<tok>/<path>` (telegram-resolver.ts:95) —
//      it does NOT derive from apiRoot, so getFile reaches the emulator but the
//      byte download targets the real (public) Telegram host;
//   #2 the injected `ssrfFetcher` runs production `validateUrl` (ssrf-fetcher.ts)
//      whose `BLOCKED_RANGES` includes "loopback" → a 127.0.0.1 download is denied.
//
// The override is a THIN wrapper (decision A2): call the REAL `setupMedia(deps)`,
// then return `{ ...result, ssrfFetcher: <loopbackFetcher> }`. `ssrfFetcher` is the
// ONLY download dependency the Telegram resolver receives
// (setup-channels-media.ts:221 `tgPlugin.createResolver({ ssrfFetcher })`), so the
// single swap addresses both blocks: the loopback fetcher (a) HOST-REWRITES the
// hardcoded `api.telegram.org` origin → the emulator host (#1), then (b) validates
// via `validateLocalServerUrl(rewritten, [host])` — the INVERSE primitive that
// ALLOWS loopback while KEEPING the cloud-metadata DENY (#2) — and downloads via
// the SAME DNS-pinned `fetchPinned` production uses.
//
// SECURITY (SEC-01 / I1 / T-207-11): this is TEST-SCOPED. Production `validateUrl`,
// `setupMedia`, and the hardcoded resolver URL are NOT edited (the hardcoded URL is
// correct for production where Telegram serves from api.telegram.org). The override
// is OPT-IN (`mediaLoopbackOverride`), OFF by default, and the loopback fetcher
// allows loopback ONLY — a non-loopback / non-allowlisted host (incl. a cloud-
// metadata IP) STILL fails (T-207-12). The Plan-05 rig.test.ts no-widening assertion
// HARD-proves production `validateUrl(loopbackUrl)` still returns `!ok`.
// ---------------------------------------------------------------------------

/** Args for {@link buildLoopbackSsrfFetcher} / {@link buildLoopbackMediaOverride}. */
export interface LoopbackMediaOverrideOptions {
  /**
   * The emulator's loopback host as `host:port` (e.g. `127.0.0.1:54321`, from
   * `new URL(apiRoot).host`). Block #1 rewrites the hardcoded
   * `https://api.telegram.org` origin → `http://<emulatorHost>`; block #2 derives
   * the allowlist HOSTNAME (the bare `127.0.0.1`, matched against the URL's literal
   * `hostname` per validateLocalServerUrl's IN-01 contract — though a loopback IP
   * already passes via the isLoopback branch, so the allowlist is belt-and-braces).
   */
  readonly emulatorHost: string;
  /** Max download size — mirrors the production fetcher's body cap (Content-Length + streamed). */
  readonly maxBytes: number;
}

/** The hardcoded origin (telegram-resolver.ts:95) the loopback fetcher rewrites — block #1. */
const TELEGRAM_FILE_ORIGIN = "https://api.telegram.org";

/**
 * Build the loopback-permitting `SsrfGuardedFetcher` the {@link
 * buildLoopbackMediaOverride} swaps in (MEDIA-02 / SEC-01). It mirrors the
 * production `createSsrfGuardedFetcher` post-validate fetch shape EXACTLY
 * (`fetch(url) → Result<{ buffer, mimeType, sizeBytes, resolvedIp }, Error>`) but:
 *   1. HOST-REWRITES a `https://api.telegram.org/...` URL → `http://<host>/...`
 *      (block #1 — the resolver URL is hardcoded, so the redirect happens here);
 *   2. validates the rewritten URL with `validateLocalServerUrl(url, [hostname])`
 *      (block #2 — ALLOWS loopback, KEEPS the cloud-metadata DENY) instead of the
 *      production `validateUrl` (which blocks loopback);
 *   3. downloads via the SAME DNS-pinned `fetchPinned(url, validated.ip)` the
 *      production fetcher uses (no DNS-rebind window).
 *
 * A URL whose host is NOT `api.telegram.org` is left un-rewritten and then must
 * pass `validateLocalServerUrl` on its OWN merits — so a public/private host that
 * is neither loopback nor the allowlisted emulator host STILL fails (loopback-only,
 * not an arbitrary-URL hole — T-207-12).
 *
 * EXPORTED so the Plan-05 rig.test.ts can drive the fetcher directly (the rewrite +
 * validate + loopback-download proof) without a daemon.
 */
export function buildLoopbackSsrfFetcher(
  opts: LoopbackMediaOverrideOptions,
): MediaResult["ssrfFetcher"] {
  const { emulatorHost, maxBytes } = opts;
  // The allowlist matches the URL's literal `hostname` (IN-01), so strip the port.
  const allowedHostname = emulatorHost.split(":")[0] ?? emulatorHost;
  return {
    async fetch(url: string) {
      try {
        // Block #1 — rewrite the hardcoded api.telegram.org origin to the emulator
        // host (a surgical origin-prefix replace; a non-telegram URL is untouched).
        const rewritten = url.startsWith(`${TELEGRAM_FILE_ORIGIN}/`)
          ? `http://${emulatorHost}${url.slice(TELEGRAM_FILE_ORIGIN.length)}`
          : url;

        // Block #2 — the INVERSE SSRF guard: ALLOWS loopback (+ the allowlisted
        // host), DENIES every other range and the cloud-metadata IPs. This is the
        // ONLY relaxation vs production, and it is loopback-scoped.
        const validated = await validateLocalServerUrl(rewritten, [allowedHostname]);
        if (!validated.ok) {
          return { ok: false as const, error: validated.error };
        }

        // Download via the SAME DNS-pinned primitive production uses (TOCTOU-safe).
        const response = await fetchPinned(rewritten, validated.value.ip, {
          signal: AbortSignal.timeout(30_000),
          redirect: "error",
        });
        if (!response.ok) {
          return { ok: false as const, error: new Error(`HTTP ${response.status} fetching ${rewritten}`) };
        }

        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.length > maxBytes) {
          return {
            ok: false as const,
            error: new Error(`Response body exceeded limit of ${maxBytes} bytes (read ${buffer.length})`),
          };
        }
        const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
        return {
          ok: true as const,
          value: { buffer, mimeType, sizeBytes: buffer.length, resolvedIp: validated.value.ip },
        };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
  };
}

/**
 * Build the OPT-IN `DaemonOverrides.setupMedia` wrapper (MEDIA-02 / SEC-01). It is a
 * `typeof setupMedia` function the daemon awaits at boot
 * (`_setupMedia = overrides.setupMedia ?? setupMedia`, daemon.ts:1742,2004): it
 * delegates to the REAL `setupMedia(deps)` then returns `{ ...result, ssrfFetcher }`
 * with the swapped {@link buildLoopbackSsrfFetcher} — addressing BOTH SSRF blocks
 * via the single dependency the resolver consumes. Every other MediaResult field
 * (transcriber, fileExtractor, linkRunner, …) is the real one, so the rest of the
 * media stack is byte-identical to production.
 */
export function buildLoopbackMediaOverride(opts: LoopbackMediaOverrideOptions): typeof setupMedia {
  const loopbackFetcher = buildLoopbackSsrfFetcher(opts);
  return async (deps) => {
    const result = await setupMedia(deps);
    return { ...result, ssrfFetcher: loopbackFetcher };
  };
}

/** Args for {@link buildMediaOverrides} — the opt-in flag + the loopback override inputs. */
export interface MediaOverridesOptions extends LoopbackMediaOverrideOptions {
  /**
   * Opt into the test-scoped SSRF-loopback allowance (the Stage-C byte-download
   * leg). DEFAULT falsy → an EMPTY overrides bag (a standard rig boot is byte-
   * identical; the override is OFF by default).
   */
  readonly mediaLoopbackOverride?: boolean;
}

/**
 * Compute the `startTestDaemon({ overrides })` bag for the media-loopback allowance.
 * When `mediaLoopbackOverride` is set → `{ setupMedia: <override> }`; otherwise →
 * `{}` (NO `setupMedia` key, so the daemon falls back to production `setupMedia` and
 * the boot is unchanged). Pure + EXPORTED so the off-by-default threading is
 * deterministically testable without booting a daemon.
 */
export function buildMediaOverrides(opts: MediaOverridesOptions): { setupMedia?: typeof setupMedia } {
  if (!opts.mediaLoopbackOverride) return {};
  return { setupMedia: buildLoopbackMediaOverride({ emulatorHost: opts.emulatorHost, maxBytes: opts.maxBytes }) };
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
export function buildRig(opts: StartRigOptions & { channel: "telegram" }): Promise<BuiltRig<TgEmulator>>;
export function buildRig(opts: StartRigOptions & { channel: "signal" }): Promise<BuiltRig<SignalEmulator>>;
export function buildRig(opts: StartRigOptions): Promise<BuiltRig<RigEmulator>>;
export async function buildRig(opts: StartRigOptions): Promise<BuiltRig<RigEmulator>> {
  // CHAN2-02: dispatch by channel through the factory+config-writer MAP — NO
  // `channel:"telegram"` throw, NO hard-coded createTgEmulator/buildConfigYaml.
  const entry = RIG_CHANNELS[opts.channel];

  // 1. Start the channel's emulator → the dynamic loopback apiRoot.
  const emulator: RigEmulator = entry.make({ channel: opts.channel, model: opts.model });
  const { apiRoot } = await emulator.start();

  // 2. Register the control API on the emulator's SHARED http-backend base so
  //    /control/* and the wire surface share ONE loopback port (SEC-01). The
  //    control API is numeric-chatId-keyed (the Telegram-first shape): the
  //    Telegram emulator IS a `ControlEmulator`; the Signal emulator (string-keyed
  //    chat) is adapted to that shape (the core inject/outbound verbs delegate;
  //    the Telegram-only verbs honest-degrade) — registerControlApi unchanged.
  const controlEmulator = isTelegramControlEmulator(emulator)
    ? emulator
    : adaptSignalToControlEmulator(emulator as SignalEmulator);
  const controlClient = registerControlApi(emulator.backend, controlEmulator);

  // The fixed test chat. Telegram is numeric; the Signal control adapter maps this
  // numeric chat to its single fixed Signal chat string (SIGNAL_RIG_CHAT).
  const chat: ChatRef = { chatId: DEFAULT_CHAT_ID };

  // 3. Pick a free gateway port (startTestDaemon's waitForPortFree double-checks it).
  const gatewayPort = await pickFreePort();

  // 4. Write the throwaway config (AFTER the emulator started, so apiRoot is real)
  //    via the CHANNEL's config writer — Telegram → channels.telegram.apiRoot;
  //    Signal → channels.signal.baseUrl (the redirect seam, dispatched by channel)
  //    + a fresh per-rig COMIS_DATA_DIR (D14 .daemon.lock isolation; per-fork in
  //    daemon-harness, but the rig pins its OWN so each rig is fully isolated).
  const configDir = mkdtempSync(join(tmpdir(), "comis-rig-cfg-"));
  const configPath = join(configDir, "config.rig.yaml");
  writeFileSync(configPath, entry.writeConfig(apiRoot, gatewayPort, opts.model), "utf-8");

  const dataDir = mkdtempSync(join(tmpdir(), "comis-rig-data-"));
  // startTestDaemon only fills COMIS_DATA_DIR when unset, and restores it after
  // boot — pinning ours here gives this rig its own throwaway data dir (the
  // mkdtemp per-rig isolation the plan calls for).
  const hadDataDirEnv = process.env["COMIS_DATA_DIR"] !== undefined;
  const priorDataDir = process.env["COMIS_DATA_DIR"];
  process.env["COMIS_DATA_DIR"] = dataDir;

  // 5. Boot the daemon (REUSED directly — A4: inherits process.exit→throw, the
  //    /health poll, the double-start guard, and per-fork isolation).
  //
  //    MEDIA-02 / SEC-01: when `mediaLoopbackOverride` is set, thread the
  //    test-scoped SSRF-loopback `setupMedia` override into `startTestDaemon`'s
  //    `overrides` bag (which daemon-harness.ts:286-287 spreads into `main()`).
  //    `buildMediaOverrides` returns `{}` when the flag is off, so a standard boot
  //    passes NO `setupMedia` override (byte-identical; production posture intact).
  const emulatorHost = new URL(apiRoot).host; // 127.0.0.1:<port> — the rewrite target + allowlist source.
  const mediaOverrides = buildMediaOverrides({
    ...(opts.mediaLoopbackOverride !== undefined ? { mediaLoopbackOverride: opts.mediaLoopbackOverride } : {}),
    emulatorHost,
    maxBytes: RIG_MEDIA_MAX_BYTES,
  });
  let daemonHandle: TestDaemonHandle;
  try {
    daemonHandle = await startTestDaemon({ configPath, gatewayPort, overrides: mediaOverrides });
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
export function startRig(opts: StartRigOptions & { channel: "telegram" }): Promise<RigHandle<TgEmulator>>;
export function startRig(opts: StartRigOptions & { channel: "signal" }): Promise<RigHandle<SignalEmulator>>;
export function startRig(opts: StartRigOptions): Promise<RigHandle<RigEmulator>>;
export async function startRig(opts: StartRigOptions): Promise<RigHandle<RigEmulator>> {
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
  /** The channel to emulate. Telegram (204/205) or Signal (209). */
  readonly channel: RigChannel;
  /** The model the booted daemon's agent runs (`"keyless"` → keyless ollama; else the provider/model id). */
  readonly model: "keyless" | string;
  /** Reserved for a future group/forum rig (Phase 206+). */
  readonly group?: boolean;
  /**
   * The handle-file base dir (default `~/.comis-chanlive`). Injected by the unit
   * tests so the operator's real handle dir is never touched.
   */
  readonly baseDir?: string;
  /**
   * DETACHED mode (Plan 208-08, Option A — the cold-shell stretch). When `true`,
   * spawn a DETACHED subprocess rig (`rig-daemon.ts`) that OUTLIVES this process,
   * recording a handle with a real `pid` + a dedicated rig-control HTTP
   * `rigControlEndpoint` (≠ gateway) — so a SEPARATE-process `tg send`/`tg down`
   * can drive it. DEFAULT falsy → the in-process rig (the daemon dies with this
   * process; `rigControlEndpoint` = the gateway anchor). The in-process spine is
   * the certified autonomy path; detached is the optional headline stretch.
   */
  readonly detached?: boolean;
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

/**
 * The result of {@link spawnDetachedRig} — a live DETACHED-subprocess rig (Plan
 * 208-08, Option A). Unlike {@link BuiltRig} (an in-process rig), this carries a
 * cross-process `pid` + the dedicated rig-control HTTP `rigControlEndpoint`; the
 * daemon lives in a SEPARATE process tree (the subprocess + its daemon grandchild)
 * that OUTLIVES the launcher. `cleanup()` SIGTERMs the subprocess (which reaps its
 * daemon grandchild + wipes its throwaway dirs) and waits for the gateway port to
 * free (the authoritative no-leak oracle).
 */
export interface DetachedRigHandle {
  /** The detached subprocess's OS pid (the cold-shell `tg down`/`restart` signal target). */
  readonly pid: number;
  /** The daemon gateway base URL (`http://127.0.0.1:<G>`). */
  readonly gatewayUrl: string;
  /** The gateway bearer token (the ≥32-char literal). */
  readonly gatewayToken: string;
  /** The emulator `/control/*` base (`http://127.0.0.1:<P>`). */
  readonly controlEndpoint: string;
  /** The DEDICATED rig-control HTTP base (`http://127.0.0.1:<R>`, ≠ gateway) the cold-shell verbs POST. */
  readonly rigControlEndpoint: string;
  /** The fixed test chat id. */
  readonly chatId: number;
  /** The subprocess's throwaway `COMIS_DATA_DIR` (the oracles read it). */
  readonly dataDir: string;
  /** `<dataDir>/<memory.dbPath>` — the isolated `memory.db`. */
  readonly memoryDbPath: string;
  /** SIGTERM the subprocess (it reaps its daemon + wipes its dirs) + wait for the port to free. */
  cleanup(): Promise<void>;
}

/** Injectable seams for {@link startStandaloneRig} — defaults wire the real probe + spawn. */
export interface StandaloneRigDeps {
  /** The health probe (default {@link probeHealth}) — the discover signal. */
  readonly probeFn?: (gatewayUrl: string) => Promise<boolean>;
  /** The rig spawner (default {@link buildRig}) — booted only when no healthy rig is discovered. */
  readonly spawnFn?: typeof buildRig;
  /**
   * The DETACHED-subprocess spawner (default {@link spawnDetachedRig}) — used only
   * when `opts.detached` is set. Injected by the deterministic unit test so the
   * detached DECISION + the handle SHAPE are proven with no real subprocess.
   */
  readonly spawnDetachedFn?: (opts: StandaloneRigOptions) => Promise<DetachedRigHandle>;
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
  const spawnDetachedFn = deps.spawnDetachedFn ?? spawnDetachedRig;

  // DISCOVER — reuse a healthy recorded rig (never spawn a second daemon over it).
  const existing = readHandle(opts.channel, opts.baseDir);
  if (existing && (await probeFn(existing.gatewayUrl))) {
    return { reused: true, handle: existing };
  }

  // DETACHED SPAWN (Plan 208-08, Option A) — boot a SEPARATE-process rig that
  // OUTLIVES this launcher, record a handle with a real pid + the dedicated
  // rig-control HTTP endpoint (≠ gateway). The detached subprocess writes its OWN
  // handle (it knows its pid + rig-control port), so here we just project the
  // StandaloneRig over it; `cleanup()` SIGTERMs the subprocess (which reaps its
  // daemon + wipes its dirs + removes the handle).
  if (opts.detached === true) {
    const detached = await spawnDetachedFn(opts);
    const handle: ChanliveHandle = {
      channel: opts.channel,
      controlEndpoint: detached.controlEndpoint,
      rigControlEndpoint: detached.rigControlEndpoint,
      gatewayUrl: detached.gatewayUrl,
      gatewayToken: detached.gatewayToken,
      chatId: detached.chatId,
      dataDir: detached.dataDir,
      memoryDbPath: detached.memoryDbPath,
      pid: detached.pid,
    };
    // The subprocess wrote a handle on boot, but re-write it here too so an
    // INJECTED test seam (which does not actually spawn a subprocess) still
    // produces the recorded handle — the real subprocess write is idempotent.
    writeHandle(handle, opts.baseDir);
    const cleanup = async (): Promise<void> => {
      try {
        await detached.cleanup();
      } finally {
        const path = handlePath(opts.channel, opts.baseDir);
        if (existsSync(path)) rmSync(path, { force: true });
      }
    };
    return { reused: false, handle, cleanup };
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

  // Wrap the lifecycle controller (restart / reset-deep / reconfigure).
  // onDaemonHandle keeps the rig's cleanup() pointed at the post-restart daemon
  // (never a stale one). configYamlFor wires AUTO-04's Track-K model sweep: it
  // closes over the CHANNEL's config writer + the rig's apiRoot (controlEndpoint) +
  // gatewayPort so reconfigure can rewrite a new `agents.default.model` (the only
  // --set key the sweep needs) while keeping the exact channel schema keys + the
  // ≥32-char literal gateway token stable. An override-less call re-derives the
  // rig's original model (the writer is the SINGLE override→YAML mapping;
  // rig-control never imports the writer — that would be a circular value import).
  // CHAN2-02: dispatch the config writer by channel (a detached Signal rig
  // re-writes channels.signal, NOT channels.telegram).
  const writeChannelConfig = RIG_CHANNELS[opts.channel].writeConfig;
  // rig-control's `createRigController` is typed against `TgEmulator` (a zero-change
  // file) but only ever calls `emulator.resetChat(chat)` — which BOTH emulators
  // implement. A Signal rig passes its `SignalEmulator` through this structural
  // bridge (the controller resets the channel-side oracle identically).
  const controller = createRigController({
    emulator: built.emulator as unknown as TgEmulator,
    daemonHandle: built.daemonHandle,
    dataDir: built.dataDir,
    configPath: built.configPath,
    gatewayPort: built.gatewayPort,
    gatewayUrl: built.gatewayUrl,
    chat: built.chat,
    memoryDbPath: built.memoryDbPath,
    onDaemonHandle: built.rebindDaemonHandle,
    configYamlFor: (overrides) =>
      writeChannelConfig(
        built.controlEndpoint,
        built.gatewayPort,
        overrides["agents.default.model"] ?? opts.model,
      ),
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

// ---------------------------------------------------------------------------
// DETACHED-subprocess rig (Plan 208-08, Option A — the cold-shell stretch).
// ---------------------------------------------------------------------------

/** The `rig-daemon.ts` entrypoint, resolved relative to THIS file. */
const RIG_DAEMON_ENTRY = fileURLToPath(new URL("./rig-daemon.ts", import.meta.url));

/** How long to wait for the detached subprocess's `/health` (the daemon grandchild boots inside it). */
const DETACHED_HEALTH_WAIT_MS = 40_000;
/** Poll cadence + per-probe timeout for the detached `/health` wait (ms). */
const DETACHED_PROBE_MS = 250;
/** Grace after SIGTERM for the subprocess to reap its daemon + free the gateway port (ms). */
const DETACHED_REAP_GRACE_MS = 20_000;

/** Pick a free loopback port via a transient `listen(0)` (shares the rig's {@link pickFreePort}). */
async function pickFreeRigPort(): Promise<number> {
  return pickFreePort();
}

/** A bounded GET `<url>/health` → true on 200 (the subprocess's rig-control health). */
async function probeRigControlHealth(rigControlEndpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${rigControlEndpoint}/health`, {
      signal: AbortSignal.timeout(DETACHED_PROBE_MS * 4),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Is `pid` alive? `kill(pid, 0)` throws when not (POSIX liveness). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signal the process GROUP led by `pid` (negative pid — reaps the rig-daemon AND
 * its daemon grandchild in the same detached group), falling back to the single
 * `pid` if the group signal is unsupported / the group is already gone. Swallows
 * ESRCH (already-reaped) — an honest no-op, never a throw.
 */
function signalGroupOrPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // negative pid → the whole process group
    return;
  } catch {
    // group gone / unsupported — try the single pid below.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone — honest no-op.
  }
}

/** Can we bind `port` on loopback? true = FREE (the no-leak oracle). */
function isGatewayPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Spawn the DETACHED subprocess rig (`rig-daemon.ts` under `tsx`, `{ detached:
 * true, stdio: "ignore" }` + `child.unref()`) and wait for its rig-control
 * `/health` (the daemon grandchild boots inside it). Returns a
 * {@link DetachedRigHandle} whose `cleanup()` SIGTERMs the subprocess (which reaps
 * its daemon grandchild + wipes its throwaway dirs + removes the handle) and waits
 * for the gateway port to free — the authoritative no-leak oracle.
 *
 * The launcher PRE-ALLOCATES the gateway + rig-control ports so the handle URLs are
 * known up-front (the subprocess binds them); the subprocess writes its OWN handle
 * (it knows its pid). On a boot-health failure, SIGTERM the subprocess + throw (no
 * half-alive rig).
 */
export async function spawnDetachedRig(opts: StandaloneRigOptions): Promise<DetachedRigHandle> {
  // Resolve the handle dir consistently with chanlive-handle's defaultBaseDir:
  // explicit opts.baseDir › the COMIS_CHANLIVE_DIR env (the cross-process isolation
  // seam the cold-shell test sets) › ~/.comis-chanlive. Threaded to the subprocess
  // as COMIS_RIG_BASE_DIR so it writes its handle to the SAME dir the launcher reads.
  const baseDir =
    opts.baseDir ?? process.env["COMIS_CHANLIVE_DIR"] ?? join(homedir(), ".comis-chanlive");
  const gatewayPort = await pickFreeRigPort();
  const rigControlPort = await pickFreeRigPort();
  const rigControlEndpoint = `http://127.0.0.1:${rigControlPort}`;
  const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;

  // Spawn `node --import tsx rig-daemon.ts` (NOT the `tsx` shim binary). WHY: the
  // `tsx` shim DOUBLE-FORKS (`child.pid` = the shim, ≠ the inner node process that
  // runs the rig) — a PID-identity hazard where a SIGTERM to `child.pid` orphans
  // the inner rig + its daemon grandchild. `node --import tsx` SINGLE-forks, so
  // `child.pid` IS the rig-daemon process (its `process.pid` matches the handle).
  // `detached: true` ALSO makes `child.pid` the leader of a NEW process group, so
  // a group-kill `kill(-child.pid)` reaps the rig-daemon AND its daemon grandchild
  // (which inherits the group) in one shot — belt-and-braces orphan reaping.
  const child = spawn(process.execPath, ["--import", "tsx", RIG_DAEMON_ENTRY], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      COMIS_RIG_CHANNEL: opts.channel,
      COMIS_RIG_MODEL: opts.model,
      COMIS_RIG_BASE_DIR: baseDir,
      COMIS_RIG_GATEWAY_PORT: String(gatewayPort),
      COMIS_RIG_CONTROL_PORT: String(rigControlPort),
      COMIS_RIG_PARENT_PID: String(process.pid),
    },
  });
  child.unref();
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("spawnDetachedRig: failed to spawn the detached subprocess (no pid)");
  }

  // Wait for the subprocess's rig-control /health (its daemon grandchild is up).
  const deadline = Date.now() + DETACHED_HEALTH_WAIT_MS;
  let healthy = false;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) break; // the subprocess died during boot — stop waiting.
    if (await probeRigControlHealth(rigControlEndpoint)) {
      healthy = true;
      break;
    }
    await new Promise((r) => setTimeout(r, DETACHED_PROBE_MS));
  }

  // The subprocess wrote its own handle on a healthy boot; read it back for the
  // exact endpoints (controlEndpoint/dataDir/memoryDbPath it minted). Fall back to
  // the pre-allocated values if the read races the write.
  const recorded = readHandle(opts.channel, baseDir);

  const reapSubprocess = async (): Promise<void> => {
    // SIGTERM the whole process GROUP (negative pid) so the rig-daemon AND its
    // daemon grandchild (which shares the group) both receive it — no orphan.
    signalGroupOrPid(pid, "SIGTERM");
    // The "no leak" condition is BOTH: the rig-daemon process is GONE (the group
    // leader dead ⇒ the whole group reaped) AND the gateway port is FREE (a
    // SO_REUSEADDR bind can succeed while a socket lingers, so the port alone is
    // not sufficient — the process-dead check is the primary oracle). Poll both;
    // escalate to a group SIGKILL if graceful shutdown overruns the grace window.
    const reaped = async (): Promise<boolean> => !isPidAlive(pid) && (await isGatewayPortFree(gatewayPort));
    const reapDeadline = Date.now() + DETACHED_REAP_GRACE_MS;
    while (Date.now() < reapDeadline) {
      if (await reaped()) return;
      await new Promise((r) => setTimeout(r, DETACHED_PROBE_MS));
    }
    signalGroupOrPid(pid, "SIGKILL");
    const killDeadline = Date.now() + DETACHED_REAP_GRACE_MS;
    while (Date.now() < killDeadline) {
      if (await reaped()) return;
      await new Promise((r) => setTimeout(r, DETACHED_PROBE_MS));
    }
  };

  if (!healthy) {
    // No half-alive rig — reap the subprocess and fail honestly.
    await reapSubprocess();
    throw new Error(
      `spawnDetachedRig: the detached subprocess never reported healthy within ${DETACHED_HEALTH_WAIT_MS}ms ` +
        `(pid ${pid}, rig-control ${rigControlEndpoint}, gateway ${gatewayUrl})`,
    );
  }

  return {
    pid,
    gatewayUrl,
    gatewayToken: recorded?.gatewayToken ?? GATEWAY_TOKEN,
    controlEndpoint: recorded?.controlEndpoint ?? "",
    rigControlEndpoint,
    chatId: recorded?.chatId ?? DEFAULT_CHAT_ID,
    dataDir: recorded?.dataDir ?? "",
    memoryDbPath: recorded?.memoryDbPath ?? "",
    cleanup: reapSubprocess,
  };
}
