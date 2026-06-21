// SPDX-License-Identifier: Apache-2.0
/**
 * CHAN2-02 — THE FOUNDATION-PROOF (Phase 209, Plan 07 — the milestone's
 * foundation capstone).
 *
 * The load-bearing claim of this milestone is that the telegram-first
 * channel-emulation harness GENERALIZES: a SECOND channel (Signal, channel #2)
 * drives the SAME `chan send`/`react`/`explain` flow green, the SAME HARD
 * dual-oracle cross-check holds, and — the strongest evidence — the EXPENSIVE
 * parts of the foundation (`assert/channel-trace.ts` the dual oracle +
 * `harness/chanlive-handle.ts` the per-channel handle) needed ZERO change. This
 * scenario IS that proof.
 *
 * It mirrors `telegram-delivery-roundtrip.test.ts`'s Stage-B / Stage-C split
 * VERBATIM (the 204/205 lineage):
 *
 *   - Stage-B (ALWAYS runs, in-process, NO COMIS_LIVE, NO real model): proves
 *     the wiring STRUCTURE deterministically —
 *       (a) the HARD dual-oracle cross-check (`assertChannelTrace`, 205-01)
 *           PASSES on wire==`delivery_mirror.text` and THROWS on a deliberate
 *           mismatch, using the REAL `createSignalEmulator()` as the channel
 *           oracle (it satisfies the structural `{ lastBotReply(chat): text? }`
 *           subset the dual oracle reads — the FOUNDATION-PROOF PASS: the
 *           highest-value HARD assertion is REUSED UNCHANGED, channel-agnostic);
 *       (b) the section-3A.4 caps contract — `signalCaps` reconciles against the
 *           REAL Signal adapter `CAPABILITIES` (`buttons:false` / `reactions:true`);
 *       (c) the honest `tap`-degrade — `chan --channel signal tap` exits a
 *           DISTINCT non-zero (`unsupported_on_channel`) BEFORE any POST (the
 *           section-3A.4 / I5 leg, via the 209-06 caps gate), `react` is NOT
 *           gated (Signal supports reactions);
 *       (d) the `injectReaction` wire-effect — a `SignalEnvelope` reaction frame
 *           is emitted on the SSE stream (the react FLOW has a real wire effect).
 *
 *   - Stage-C (describe.skipIf(!isLive), COMIS_LIVE, a reachable keyless model)
 *     is the agent-authored round-trip (added in Task 2): `startRig({channel:
 *     "signal"})` boots an isolated daemon pointed at the SignalEmulator (via
 *     `channels.signal.baseUrl`), `chan --channel signal send` round-trips, and
 *     `chan --channel signal explain` works. SKIPPED (skip != fail) without
 *     COMIS_LIVE.
 *
 * Run:
 *   CI (Stage-B only, offline, deterministic):
 *     pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/signal-foundation-proof.test.ts
 *   Stage-C (the agent round-trip, operator / a reachable keyless model):
 *     COMIS_LIVE=1 pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/signal-foundation-proof.test.ts
 *
 * (NB: a BARE `pnpm vitest run test/live/...` resolves the ROOT config, whose
 *  projects exclude test/live -> 0 files, exit 0 = false green. ALWAYS pass
 *  `-c test/live/vitest.config.ts`.)
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree.
 *
 * @module
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertChannelTrace, readMirrorText } from "../../assert/channel-trace.js";
import { createSignalEmulator, type SignalEmulator } from "../../emulators/signal/signal-emulator.js";
import { signalCaps, SIGNAL_MAX_MESSAGE_CHARS } from "../../emulators/signal/signal-caps.js";
import { makeMessageEnvelope } from "../../emulators/signal/signal-payloads.js";
import { mapSignalToNormalized, type SignalEnvelope } from "@comis/channels";
import { adaptSignalToControlEmulator, SIGNAL_RIG_CHAT } from "../../harness/rig.js";
import {
  parseArgs,
  contextFromParsed,
  runVerb,
  exitCodeFor,
  VerbFailure,
  type ChanliveHandle,
  type VerbContext,
} from "../../bin/chan.js";
import type { RigHandle } from "../../harness/rig.js";

const isLive = !!process.env["COMIS_LIVE"];

/**
 * The Signal chat the emulator keys on (a bare recipient — the DM form). The
 * SignalEmulator's per-chat oracle keys on this STRING (vs Telegram's numeric
 * chatId). The dual oracle's `chat: { chatId }` is the channel-agnostic numeric
 * identifier; the closure in {@link asChannelOracle} binds this string so the
 * SignalEmulator's recorded outbound is what the cross-check reads.
 */
const SIGNAL_CHAT = "+15555550111";

// Tmp dirs created per DB-using Stage-B test — cleaned up after each.
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** Allocate a fresh tmp dir + file DB path (registered for cleanup). */
function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "signal-fp-"));
  tmpDirs.push(dir);
  return join(dir, "memory.db");
}

/**
 * Create the delivery_mirror table with the REAL schema (the Comis half of the
 * dual oracle — `readMirrorText` reads `delivery_mirror.text WHERE session_key`),
 * channel-neutral: the `channel_type` column carries `signal` here but the
 * cross-check reads it the same for any channel (`channel-trace.ts:76`).
 */
function freshMirrorDb(): string {
  const dbPath = freshDbPath();
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE delivery_mirror (
      id TEXT PRIMARY KEY,
      session_key TEXT NOT NULL,
      text TEXT NOT NULL,
      media_urls TEXT NOT NULL DEFAULT '[]',
      channel_type TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'agent',
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'acknowledged')),
      created_at INTEGER NOT NULL,
      acknowledged_at INTEGER
    );
    CREATE UNIQUE INDEX idx_dm_idempotency ON delivery_mirror(idempotency_key);
  `);
  db.close();
  return dbPath;
}

/**
 * INSERT a delivery_mirror fixture row for `signal` (the MIRROR half — the Comis
 * oracle the cross-check compares the wire against). `readMirrorText` keys on
 * `session_key` only (the dual oracle is channel-agnostic by design).
 */
function insertSignalMirrorRow(
  dbPath: string,
  row: { id: string; sessionKey: string; text: string; idempotencyKey: string },
): void {
  const db = new Database(dbPath);
  try {
    db.prepare(
      `INSERT INTO delivery_mirror
         (id, session_key, text, media_urls, channel_type, channel_id, origin, idempotency_key, status, created_at)
       VALUES (?, ?, ?, '[]', 'signal', ?, 'agent', ?, 'acknowledged', ?)`,
    ).run(row.id, row.sessionKey, row.text, SIGNAL_CHAT, row.idempotencyKey, 1000);
  } finally {
    db.close();
  }
}

/**
 * Adapt the REAL `SignalEmulator` (string-keyed `lastBotReply(chat: string)`) to
 * the dual oracle's structural subset (`lastBotReply(chat: { chatId }): text?`).
 * The cross-check is channel-agnostic — it reads ONLY `.text` off whatever
 * `lastBotReply` returns; this thin closure binds the fixed Signal chat string
 * so the SignalEmulator's recorded outbound is what the cross-check sees. This
 * is the FOUNDATION-PROOF PASS in action: the dual oracle needs NO Signal-
 * specific edit — a structural adapter at the call site suffices.
 */
function asChannelOracle(emulator: {
  lastBotReply(chat: string): { text?: string } | undefined;
}): { lastBotReply(chat: { chatId: number }): { text?: string } | undefined } {
  return { lastBotReply: () => emulator.lastBotReply(SIGNAL_CHAT) };
}

/**
 * Record a `send` outbound on the running SignalEmulator by POSTing the EXACT
 * JSON-RPC `send` the real adapter sends to the loopback `/api/v1/rpc`
 * (`signalRpcRequest("send", { recipient:[chat], message })`,
 * signal-adapter.ts:237). The emulator records a `RecordedOutbound { method:
 * "send", messageId:<timestamp>, text }` the dual oracle reads as
 * `lastBotReply(chat).text`. The SAME wire path the live adapter drives — no
 * daemon, no product change. Awaits the POST so the oracle is seeded before the
 * cross-check.
 */
async function recordSendOnEmulator(apiRoot: string, chat: string, text: string): Promise<void> {
  const res = await fetch(`${apiRoot}/api/v1/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "send",
      params: { recipient: [chat], message: text },
    }),
  });
  if (!res.ok) {
    throw new Error(`emulator /api/v1/rpc send returned ${res.status} — the outbound was not recorded`);
  }
}

/** A recording fake fetch for the caps-gate / react units (the 207 shape). */
function recordingFetch(script: (url: string) => { status?: number; body?: unknown } = () => ({})): {
  fetch: typeof fetch;
  calls: Array<{ method: string; url: string; body: unknown }>;
} {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    let parsedBody: unknown;
    if (typeof init?.body === "string" && init.body.length > 0) {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ method, url, body: parsedBody });
    const { status = 200, body = { ok: true } } = script(url);
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** A fake Signal handle (no real rig) for the caps-gate / react dispatch units. */
function fakeSignalHandle(over: Partial<ChanliveHandle> = {}): ChanliveHandle {
  return {
    channel: "signal",
    controlEndpoint: "http://127.0.0.1:1",
    rigControlEndpoint: "http://127.0.0.1:1",
    gatewayUrl: "http://127.0.0.1:1",
    gatewayToken: "test-token-0000000000000000000000000000",
    chatId: 424242,
    dataDir: "/tmp/does-not-exist",
    memoryDbPath: "/tmp/does-not-exist/memory.db",
    ...over,
  };
}

/** A parsed SSE envelope (the reaction-frame shape the wire-effect test reads). */
interface SseEnvelope {
  dataMessage?: {
    reaction?: { emoji?: string; targetSentTimestamp?: number };
    message?: string;
  };
}

/**
 * Open the SSE `/api/v1/events` stream, run `inject` (which emits frames), and
 * collect the parsed `event: receive` envelopes for a brief bounded window (so
 * the test never hangs).
 */
async function collectSseFrames(url: string, inject: () => void): Promise<SseEnvelope[]> {
  const frames: SseEnvelope[] = [];
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body?.getReader();
  if (!reader) return frames;
  const decoder = new TextDecoder();
  // Inject AFTER the stream is open so the frames are emitted (not queued).
  inject();
  const start = Date.now();
  let buffer = "";
  while (Date.now() - start < 1500) {
    const readPromise = reader.read();
    const timeout = new Promise<{ done: true; value: undefined }>((resolve) =>
      setTimeout(() => resolve({ done: true, value: undefined }), 300),
    );
    const { done, value } = await Promise.race([readPromise, timeout]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const block of buffer.split("\n\n")) {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (dataLine) {
        try {
          frames.push(JSON.parse(dataLine.slice("data: ".length)) as SseEnvelope);
        } catch {
          // ignore non-JSON keep-alive frames
        }
      }
    }
    buffer = "";
    if (frames.length >= 2) break;
  }
  controller.abort();
  return frames;
}

/**
 * Drive the REAL rig Signal control adapter's inject path deterministically (no
 * daemon) and return the `SignalEnvelope` it causes the emulator to build. A
 * capturing fake `SignalEmulator` (whose `injectMessage` builds the envelope the
 * SAME way the real emulator does — `makeMessageEnvelope` from the adapter's
 * (chat, from, text, opts)) is passed to the REAL `adaptSignalToControlEmulator`;
 * invoking the adapter's `injectMessage` then captures EXACTLY the inbound the
 * rig injects — so a missing sender-identity opt (the round-trip-keystone bug) is
 * caught here, deterministically, without booting the daemon.
 */
function injectViaRigSignalAdapter(text: string): SignalEnvelope {
  let captured: SignalEnvelope | undefined;
  // A minimal capturing SignalEmulator: only `injectMessage` is exercised by the
  // adapter's injectMessage; it builds the envelope the real emulator builds
  // (signal-emulator.ts injectMessage -> makeMessageEnvelope) and captures it.
  const capturingEmulator = {
    injectMessage(chat: string, from: string, content: string, opts?: { sourceUuid?: string; sourceName?: string }) {
      captured = makeMessageEnvelope({
        from,
        content,
        channel: chat,
        ...(opts?.sourceUuid !== undefined ? { sourceUuid: opts.sourceUuid } : {}),
        ...(opts?.sourceName !== undefined ? { sourceName: opts.sourceName } : {}),
      });
      return captured.timestamp as number;
    },
  } as unknown as SignalEmulator;

  const adapter = adaptSignalToControlEmulator(capturingEmulator);
  // The control API passes a chat { chatId } + a `from` whose firstName carries
  // the sender identity (the rig's send() path); drive that EXACT call.
  adapter.injectMessage({ chatId: 424242 }, { id: 111, firstName: "user_111" }, text);
  if (captured === undefined) {
    throw new Error("the rig Signal adapter did not inject a message envelope");
  }
  return captured;
}

// ---------------------------------------------------------------------------
// Stage-B — the foundation-proof STRUCTURE (deterministic, no daemon/model)
// ---------------------------------------------------------------------------

describe("CHAN2-02 Stage-B — the Signal foundation-proof structure (no COMIS_LIVE)", () => {
  it("the HARD dual-oracle cross-check (assertChannelTrace) PASSES on wire==mirror and THROWS on a mismatch — REUSED UNCHANGED on the SignalEmulator (the foundation-proof PASS)", async () => {
    const dbPath = freshMirrorDb();
    const emulator = createSignalEmulator();
    const { apiRoot } = await emulator.start();
    try {
      // Record a `send` outbound on the REAL SignalEmulator (the channel oracle)
      // via the EXACT JSON-RPC `send` wire path the live adapter drives.
      const wireText = "the Signal reply on the wire";
      await recordSendOnEmulator(apiRoot, SIGNAL_CHAT, wireText);

      // Seed the matching delivery_mirror row (the Comis oracle).
      insertSignalMirrorRow(dbPath, {
        id: "m1",
        sessionKey: "s",
        text: wireText,
        idempotencyKey: "s:hash:1",
      });

      // Agreement -> resolves (the SignalEmulator's wire bytes == delivery_mirror.text).
      await expect(
        assertChannelTrace({
          emulator: asChannelOracle(emulator),
          chat: { chatId: 424242 },
          memoryDbPath: dbPath,
          sessionKey: "s",
        }),
      ).resolves.toBeUndefined();

      // Disagreement -> a HARD throw (Comis thinks it sent X but the wire shows Y).
      insertSignalMirrorRow(dbPath, {
        id: "m2",
        sessionKey: "s2",
        text: "a DIFFERENT Comis-recorded reply",
        idempotencyKey: "s2:hash:1",
      });
      await expect(
        assertChannelTrace({
          emulator: asChannelOracle(emulator), // wire is still `wireText`
          chat: { chatId: 424242 },
          memoryDbPath: dbPath,
          sessionKey: "s2",
        }),
      ).rejects.toThrow(/dual-oracle/);

      // readMirrorText is the Comis half the live cross-check reads (channel-neutral).
      expect(readMirrorText(dbPath, "s")).toBe(wireText);
    } finally {
      await emulator.stop();
    }
  });

  it("the section-3A.4 caps contract holds: signalCaps reconciles against the REAL Signal adapter CAPABILITIES (buttons:false / reactions:true)", async () => {
    // Import the adapter's REAL declared capabilities (the reconciliation TARGET)
    // — the lazy factory reads the module-local CAPABILITIES with no network.
    const { createSignalPlugin } = await import("@comis/channels");
    const { createMockLogger } = await import("../../../support/mock-logger.js");
    const caps = createSignalPlugin({ baseUrl: "http://127.0.0.1:8080", logger: createMockLogger() })
      .capabilities;

    // The emulator's flat outbound flags reconcile field-by-field with the
    // adapter's nested features — buttons:false is THE honest-degrade trigger.
    expect(signalCaps.outbound.buttons).toBe(false);
    expect(caps.features.buttons).toBe("none");
    expect(signalCaps.outbound.buttons).toBe(caps.features.buttons === "none" ? false : true);
    // reactions:true is the WS1-relevant verb Signal DOES support (chan react works).
    expect(signalCaps.outbound.reactions).toBe(true);
    expect(signalCaps.outbound.reactions).toBe(caps.features.reactions);
    // edits:false — honest degradation (Signal can't edit), reconciled.
    expect(signalCaps.outbound.edits).toBe(false);
    expect(signalCaps.outbound.edits).toBe(caps.features.editMessages);
    // The reconciled message-length limit.
    expect(SIGNAL_MAX_MESSAGE_CHARS).toBe(caps.limits.maxMessageChars);
  });

  it("chan --channel signal tap honest-degrades: a DISTINCT non-zero exit + unsupported_on_channel BEFORE any POST (the section-3A.4 / I5 leg)", async () => {
    const rec = recordingFetch();
    // The threaded channel is signal (the 209-06 caps gate keys on ctx.channel).
    const parsed = parseArgs(["--channel", "signal", "tap", "42", "page=2"]);
    const ctx: VerbContext = {
      ...contextFromParsed(parsed, fakeSignalHandle()),
      controlFetch: rec.fetch,
    };
    const err = await runVerb(parsed.verb as string, parsed.args, ctx).catch((e: unknown) => e);
    // An honest, reason-coded VerbFailure — NOT a success shape ({ tapped }).
    expect(err).toBeInstanceOf(VerbFailure);
    expect((err as VerbFailure).kind).toBe("unsupported_on_channel");
    // Not mislabeled as a dead_handle / no_reply — a caps-gated honest skip.
    expect((err as VerbFailure).kind).not.toBe("dead_handle");
    expect((err as VerbFailure).kind).not.toBe("no_reply");
    // The --json body names the channel + the verb + the missing cap.
    const body = (err as VerbFailure).body;
    expect(body["error"]).toBe("unsupported_on_channel");
    expect(JSON.stringify(body)).toContain("signal");
    expect(JSON.stringify(body)).toMatch(/buttons/);
    // The gate fired BEFORE the POST — NO control fetch was made (not a silent
    // no-op POST, not a fabricated success). The callbacks route was never touched.
    expect(rec.calls).toHaveLength(0);
    // A DISTINCT, non-zero exit code (distinct from dead_handle/no_reply/not-impl).
    expect((err as VerbFailure).exitCode).toBeGreaterThan(0);
    expect((err as VerbFailure).exitCode).not.toBe(exitCodeFor("dead_handle"));
    expect((err as VerbFailure).exitCode).not.toBe(exitCodeFor("no_reply"));
    expect((err as VerbFailure).exitCode).not.toBe(6);
  });

  it("chan --channel signal react is NOT gated (Signal supports reactions) — the verb POSTs the reaction (the react FLOW is unaffected)", async () => {
    const rec = recordingFetch((url) => {
      if (url.includes("/reactions")) return { status: 200, body: { ok: true } };
      return { status: 200, body: [] };
    });
    const parsed = parseArgs(["--channel", "signal", "react", "42", "👍"]);
    const ctx: VerbContext = {
      ...contextFromParsed(parsed, fakeSignalHandle()),
      controlFetch: rec.fetch,
    };
    const result = (await runVerb(parsed.verb as string, parsed.args, ctx)) as Record<string, unknown>;
    // Signal supports reactions -> react works unchanged (the POST happened, honest success).
    expect(result).toEqual({ reacted: { botReplyId: 42, emoji: "👍" } });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.url.endsWith("/reactions")).toBe(true);
  });

  it("injectReaction on the SignalEmulator emits a SignalEnvelope reaction frame on the SSE stream (the react FLOW has a real wire effect)", async () => {
    const emulator = createSignalEmulator();
    const { apiRoot } = await emulator.start();
    try {
      // Open the SSE inbound stream and collect frames (the adapter's pull path).
      const frames = await collectSseFrames(`${apiRoot}/api/v1/events`, () => {
        // First inject a message (mint a target timestamp), then react to it.
        const targetTs = emulator.injectMessage(SIGNAL_CHAT, SIGNAL_CHAT, "hello");
        emulator.injectReaction(SIGNAL_CHAT, SIGNAL_CHAT, targetTs, "👍");
      });
      // The reaction frame carries dataMessage.reaction { emoji, targetSentTimestamp }
      // — the EXACT shape the real mapper classifies as a reaction (the wire effect).
      const reactionFrame = frames.find((f) => f?.dataMessage?.reaction?.emoji === "👍");
      expect(reactionFrame, "a reaction envelope was emitted on the SSE stream").toBeDefined();
      expect(typeof reactionFrame?.dataMessage?.reaction?.targetSentTimestamp).toBe("number");
    } finally {
      await emulator.stop();
    }
  });

  it("the round-trip CLOSES: an inbound injected via the rig's Signal control adapter resolves (via the REAL mapper) to channelId == the chat key the reply lands under (the Stage-C round-trip keystone, deterministic)", () => {
    // THE ROUND-TRIP KEYSTONE (the deterministic guard for the live Stage-C
    // round-trip): the rig's Signal control adapter injects an inbound for its
    // single fixed Signal chat (rig.ts SIGNAL_RIG_CHAT) and later polls
    // emulator.outbound(SIGNAL_RIG_CHAT) for the reply. For the round-trip to
    // CLOSE, the agent must reply to a channelId the emulator records the outbound
    // under as SIGNAL_RIG_CHAT. The real Signal adapter resolves the DM channelId
    // = senderId = (sourceUuid ?? sourceNumber ?? source) (message-mapper.ts:31,34)
    // and replies there; resolveChatKey records the outbound under that recipient.
    // So the inbound the rig injects MUST resolve channelId == SIGNAL_RIG_CHAT —
    // else the reply lands under a DIFFERENT key (the all-zero placeholder uuid
    // sourceUuid defaults to) and waitForReply times out (the Stage-C no-reply).
    // Drive the REAL rig adapter's inject path: capture the envelope the rig's
    // adaptSignalToControlEmulator causes the emulator to emit when the rig sends.
    const envelope = injectViaRigSignalAdapter("hello from the round-trip");
    // baseUrl is the attachment-fetch base — irrelevant to the senderId/channelId
    // resolution this guards; a loopback placeholder suffices.
    const normalized = mapSignalToNormalized(envelope, "http://127.0.0.1:8080") as {
      channelId?: string;
      senderId?: string;
    };
    // The agent replies to channelId; the emulator records the reply under it;
    // waitForReply polls outbound(SIGNAL_RIG_CHAT). They MUST be the same key.
    expect(
      normalized.channelId,
      "the rig-injected inbound must resolve channelId to the chat key the reply " +
        "lands under (else the Stage-C round-trip cannot close — waitForReply times out)",
    ).toBe(SIGNAL_RIG_CHAT);
    expect(normalized.senderId).toBe(SIGNAL_RIG_CHAT);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — THE ZERO-CHANGE PROOF (the load-bearing CHAN2-02 evidence) + the
// zero-production-change proof + the SEC-02 re-verify.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");

/** Run a git command in the repo root and return trimmed stdout. */
function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8" }).trim();
}

/**
 * The Phase-209 BASE commit (the parent of the EARLIEST commit whose subject
 * names a 209-NN plan), computed from `git log` so the proof does NOT depend on a
 * hard-coded SHA. The whole-phase diff (`<base>..HEAD`) is what the zero-change /
 * zero-production-change proofs assert against — exactly the surface this phase
 * added.
 */
function phaseBase(): string {
  const log = git(["log", "--reverse", "--format=%H %s"]);
  const first = log
    .split("\n")
    .find((line) => /\(209-\d+\)/.test(line));
  if (first === undefined) {
    throw new Error("could not locate the earliest 209-NN commit to derive the phase base");
  }
  const sha = first.split(" ")[0]!;
  return git(["rev-parse", `${sha}^`]);
}

/**
 * The whole-phase diff name list. Uses `git diff <base>` (NO `..HEAD`) so it
 * compares the phase base to the WORKING TREE — catching BOTH committed phase
 * changes AND any uncommitted edit to a tracked file (so a PASS file edited but
 * not yet committed during the phase is still caught — the proof has teeth on
 * the live working tree, not just the committed history).
 */
function phaseDiffFiles(): string[] {
  return git(["diff", "--name-only", phaseBase()])
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe("CHAN2-02 Stage-B — THE ZERO-CHANGE PROOF + zero-production-change + SEC-02 (no COMIS_LIVE)", () => {
  it("the foundation-proof PASS: assert/channel-trace.ts AND harness/chanlive-handle.ts are UNCHANGED across the whole phase diff (the expensive parts already generalized)", () => {
    // The strongest CHAN2-02 evidence: the EXPENSIVE parts of the foundation —
    // the channel-agnostic dual oracle (assert/channel-trace.ts) and the
    // per-channel handle (harness/chanlive-handle.ts) — needed ZERO change to
    // accept a SECOND channel. They are NOT in the phase diff.
    const diff = phaseDiffFiles();
    const zeroChangeTargets = diff.filter(
      (f) =>
        f.endsWith("test/live/assert/channel-trace.ts") ||
        f.endsWith("test/live/harness/chanlive-handle.ts"),
    );
    expect(
      zeroChangeTargets,
      `the foundation-proof PASS files were edited this phase: ${zeroChangeTargets.join(", ")} — ` +
        "the dual oracle + the handle were supposed to generalize with ZERO change.",
    ).toEqual([]);

    // And they DO carry the channel-agnostic surface the proof rests on (a
    // content check that they hold the structural subset + the per-channel key,
    // i.e. they did NOT need a signal-specific edit).
    const dualOracle = readFileSync(
      resolve(REPO_ROOT, "test/live/assert/channel-trace.ts"),
      "utf-8",
    );
    // The structural subset the dual oracle accepts (channel-agnostic, not bound
    // to TgEmulator) — `lastBotReply(chat): { text? }`.
    expect(dualOracle).toMatch(/lastBotReply\(chat:\s*\{\s*chatId:\s*number\s*\}\)/);
    // The channel-neutral delivery_mirror read (keyed on session_key only).
    expect(dualOracle).toMatch(/SELECT text FROM delivery_mirror WHERE session_key/);

    const handle = readFileSync(
      resolve(REPO_ROOT, "test/live/harness/chanlive-handle.ts"),
      "utf-8",
    );
    // The per-channel key (`<channel>.json`) — already channel-keyed (no edit needed).
    expect(handle).toMatch(/readonly channel:\s*string/);
    expect(handle).toMatch(/\$\{channel\}\.json/);
  });

  it("the zero-production-change proof: the whole phase diff is test/-only EXCEPT the documented I1 type-only @comis/channels barrel re-export", () => {
    // The milestone premise: the redirect seam is config-only, so a SECOND
    // channel reaches the daemon with NO product behavior change. The ONLY
    // permitted production-source touch is the documented I1 type-only barrel
    // re-export (packages/channels/src/index.ts) + its test (a test file, stripped
    // from the published tarball). Anything else under packages/*/src is a STOP.
    const productSrc = phaseDiffFiles().filter((f) => /(^|\/)packages\/[^/]+\/src\//.test(f));
    const I1_BARREL = "packages/channels/src/index.ts";
    const I1_BARREL_TEST = "packages/channels/src/index.test.ts";
    const offending = productSrc.filter(
      (f) => !f.endsWith(I1_BARREL) && !f.endsWith(I1_BARREL_TEST),
    );
    expect(
      offending,
      `unexpected production source changed this phase (only the I1 type-only barrel ` +
        `re-export is allowed): ${offending.join(", ")}`,
    ).toEqual([]);

    // And the I1 barrel change is a TYPE-ONLY re-export (erased at build — no
    // runtime @comis/* edge into the never-published harness), not a behavior
    // change: the diff hunk for index.ts adds an `export type { ... }` line only.
    if (productSrc.some((f) => f.endsWith(I1_BARREL))) {
      const barrelDiff = git(["diff", `${phaseBase()}..HEAD`, "--", I1_BARREL]);
      // Every ADDED non-comment, non-context code line must be an `export type` re-export.
      const addedCode = barrelDiff
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .map((l) => l.slice(1).trim())
        .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
      expect(addedCode.length, "the I1 barrel hunk added at least one line").toBeGreaterThan(0);
      for (const line of addedCode) {
        expect(
          line,
          `the I1 barrel must add TYPE-ONLY re-exports (erased at build); found a non-type line: ${line}`,
        ).toMatch(/^export type \{/);
      }
      // Specifically the SignalEnvelope/SignalAttachment wire types (the I4 seam).
      expect(barrelDiff).toMatch(/export type \{ SignalEnvelope, SignalAttachment \}/);
    }
  });

  it("SEC-02 re-verify: the harness-never-published guard passes with the new Signal files present (no @comis/* runtime edge, no package.json under test/live, no comis subcommand)", () => {
    // The SEC-02 guard runs under the ARCHITECTURE vitest project (pure
    // filesystem + string assertions, no daemon) — it is invoked as a phase-gate
    // run here (it cannot run under the live config). This test re-asserts the
    // load-bearing SEC-02 invariants directly against the published surface with
    // the new emulators/signal/* + harness/* files present, so the scenario
    // itself proves the boundary holds (the full guard is run at the phase gate:
    // `pnpm vitest run test/architecture/harness-never-published.test.ts`).

    // (1) No package.json under any harness dir (a workspace member would publish).
    for (const dir of ["test/live/harness", "test/live/emulators", "test/live/scenarios"]) {
      const found = git(["ls-files", `${dir}/**/package.json`]);
      expect(found, `a package.json under ${dir} would make the harness publishable`).toBe("");
    }

    // (2) The new Signal emulator imports @comis/channels TYPE-ONLY (erased — no
    // runtime edge into the never-published harness).
    const sigEmu = readFileSync(
      resolve(REPO_ROOT, "test/live/emulators/signal/signal-emulator.ts"),
      "utf-8",
    );
    // The only @comis/* import is `import type { SignalEnvelope } from "@comis/channels"`.
    const comisImports = sigEmu
      .split("\n")
      .filter((l) => /from\s+["']@comis\//.test(l));
    for (const imp of comisImports) {
      expect(imp, `the Signal emulator must import @comis/* TYPE-ONLY: ${imp}`).toMatch(
        /import\s+type\s/,
      );
    }

    // (3) No comis subcommand for the harness CLI (chan/tg live under test/live/bin).
    const cliEntry = readFileSync(resolve(REPO_ROOT, "packages/cli/src/cli.ts"), "utf-8");
    expect(cliEntry).not.toMatch(/\.command\(\s*["'`](chan|tg)[\s"'`]/);
    expect(cliEntry).not.toMatch(/register(Chan|Tg)Command\b/);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — the AGENT-AUTHORED Signal round-trip via the full daemon (COMIS_LIVE)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("CHAN2-02 Stage-C — the Signal agent round-trip + explain (COMIS_LIVE)", () => {
  // RigHandle<SignalEmulator> — a {channel:"signal"} rig is generic over the
  // SignalEmulator (vs the TgEmulator default); the emulator field exposes the
  // Signal oracle the cross-check reads (205-05 made RigHandle generic).
  let rig: RigHandle<SignalEmulator> | undefined;
  // buildRig exposes memoryDbPath (the RigHandle projection hides it); the
  // round-trip surface (send/waitForReply/emulator/chat) is identical.
  let memoryDbPath: string | undefined;

  beforeAll(async () => {
    // PRECONDITION: `pnpm build` first — the live alias reads dist/; a stale
    // dist/ masks src/. buildRig({channel:"signal"}) boots an isolated daemon
    // pointed at the SignalEmulator via channels.signal.baseUrl (the 209-05
    // dispatch map + the verified config-only redirect seam).
    const { buildRig } = await import("../../harness/rig.js");
    const built = await buildRig({ channel: "signal", model: "keyless" });
    memoryDbPath = built.memoryDbPath;
    rig = {
      emulator: built.emulator,
      controlClient: built.controlClient,
      chat: built.chat,
      gatewayUrl: built.gatewayUrl,
      authToken: built.authToken,
      send: built.send.bind(built),
      waitForReply: built.waitForReply.bind(built),
      cleanup: built.cleanup.bind(built),
    };
  });

  afterAll(async () => {
    if (rig) await rig.cleanup();
    rig = undefined;
    memoryDbPath = undefined;
  });

  /** Bounded poll for the single delivery_mirror.session_key (the after_delivery hook is async). */
  async function pollForSessionKey(dbPath: string, timeoutMs = 5000): Promise<string | undefined> {
    const start = Date.now();
    const read = (): string | undefined => {
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db
          .prepare("SELECT session_key FROM delivery_mirror ORDER BY created_at DESC LIMIT 1")
          .get() as { session_key?: string } | undefined;
        return row?.session_key;
      } finally {
        db.close();
      }
    };
    let key = read();
    while (key === undefined && Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
      key = read();
    }
    return key;
  }

  it(
    "a send round-trips through the real Signal adapter, the dual-oracle cross-check holds (wire==mirror.text), and explain works channel-agnostically",
    async () => {
      const r = rig;
      const dbPath = memoryDbPath;
      expect(r, "Signal rig booted").toBeDefined();
      expect(dbPath, "memoryDbPath resolved").toBeDefined();
      if (r === undefined || dbPath === undefined) return;

      // Drive a real inbound -> the agent authors a reply -> the REAL Signal
      // adapter -> delivery path writes the mirror. waitForReply is the SYNC POINT
      // (read the mirror only AFTER the outbound landed).
      const inboundId = await r.send("hello from the Signal foundation-proof");
      const reply = await r.waitForReply(inboundId, 45_000);
      // Honest no-reply -> undefined (never fabricated). Needs a reachable keyless model.
      expect(
        reply,
        "no agent reply within 45s — is a keyless model reachable (ollama on localhost:11434 / live.env)? (honest no-reply, never fabricated)",
      ).toBeDefined();
      if (reply === undefined) return;

      // Resolve the session key from the single mirror row (bounded poll).
      const sessionKey = await pollForSessionKey(dbPath);
      expect(
        sessionKey,
        "a delivery_mirror row was written for the session (the after_delivery hook fired on the Signal path)",
      ).toBeDefined();
      if (sessionKey === undefined) return;

      // THE HARD dual-oracle cross-check on Signal: the SignalEmulator's recorded
      // wire text == delivery_mirror.text for the session (assertChannelTrace, a
      // HARD throw on mismatch). REUSED UNCHANGED — the foundation-proof PASS,
      // now against the LIVE Signal writer. The rig's control adapter records all
      // outbound under its single fixed Signal chat string (rig.ts SIGNAL_RIG_CHAT
      // = "+15555550199"); the SignalEmulator is string-keyed, so we bind that
      // string into the channel-agnostic `{ lastBotReply(chat): { text? } }` subset
      // the dual oracle reads (the foundation-proof PASS: the oracle needs NO
      // Signal-specific edit — a structural adapter at the call site suffices).
      const RIG_SIGNAL_CHAT = "+15555550199"; // mirrors rig.ts SIGNAL_RIG_CHAT
      await assertChannelTrace({
        emulator: { lastBotReply: () => r.emulator.lastBotReply(RIG_SIGNAL_CHAT) },
        chat: r.chat,
        memoryDbPath: dbPath,
        sessionKey,
      });

      // explain works channel-agnostically over the FIXED rpc-over-WS (205-07):
      // a known sessionKey returns an IncidentReport. (Driven via the chan CLI's
      // explain verb against the rig's gateway — channel-agnostic obs.)
      const { runVerb: liveRunVerb } = await import("../../bin/chan.js");
      const explainHandle: ChanliveHandle = {
        channel: "signal",
        controlEndpoint: r.gatewayUrl,
        rigControlEndpoint: r.gatewayUrl,
        gatewayUrl: r.gatewayUrl,
        gatewayToken: r.authToken,
        chatId: r.chat.chatId,
        dataDir: dirname(dbPath),
        memoryDbPath: dbPath,
      };
      const report = (await liveRunVerb("explain", [sessionKey], {
        handle: explainHandle,
      })) as Record<string, unknown>;
      // A channel-agnostic IncidentReport came back (not an error shape).
      expect(report).toBeDefined();
      expect(typeof report).toBe("object");
    },
    180_000,
  );
});
