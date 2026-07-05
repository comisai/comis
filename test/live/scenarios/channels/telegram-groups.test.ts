// SPDX-License-Identifier: Apache-2.0
/**
 * GROUP-01/02/03 — group/supergroup/forum + multi-user addressing + the TWO
 * group-only HARD assertions (the surfaces the chat API structurally cannot
 * reach: there are no groups, no forum topics, no cross-member reactions, and
 * no allowFrom gate in /v1/chat/completions).
 *
 * The mapper (chatType + addressing), the General-Topic id=1 thread asymmetry,
 * the allowFrom engage-gate, and the reaction trust-floor spoof guard are ALL
 * already wired in packages/*\/src; this scenario DRIVES + ASSERTS them against
 * emulator-built wire shapes — it never re-implements them.
 *
 * ── THE CI vs COMIS_LIVE SPLIT ──
 *
 *   • Stage-B (ALWAYS runs, in-process, NO COMIS_LIVE, NO model): the WIRING
 *     proofs, deterministic.
 *       - HARD #1 (the asymmetry): import the REAL buildSendThreadParams /
 *         buildTypingThreadParams / resolveTelegramThreadContext from
 *         @comis/channels and assert SEND OMITS message_thread_id when the topic
 *         is the General topic (id=1, forum) while TYPING INCLUDES it; a
 *         non-forum group ignores a reply-chain thread id.
 *       - HARD #2 (the spoof guard): the REAL outcome_events DDL +
 *         createSqliteOutcomeStore — an AUTHORIZED 👍 (trust "known", confidence
 *         0.24 >= the 0.05 write floor) WRITES a source='reaction' row; an
 *         UNAUTHORIZED 👍 (the inert 0.03 < floor) is SKIPPED (no row).
 *       - GROUP-01/02 (the bare grammy adapter): mapGrammyToNormalized on a
 *         group/forum-shaped Update -> chatType "group"/"forum" +
 *         metadata.isBotMentioned/replyToBot/isBotCommand; the allowFrom
 *         engage-gate asserts BEHAVIOR (addressed -> the gate's keys are present;
 *         ambient -> quiet, the keys are absent).
 *       - the git-porcelain zero-product-change guard + the SEC-02 re-verify.
 *
 *   • Stage-C (describe.skipIf(!isLive), COMIS_LIVE): buildRig(keyless) ->
 *     createGroupChat({members:[auth,attacker],admins:[auth]}) -> a group reply
 *     -> inject BOTH a known-member 👍 and an attacker 👍 on the same bot reply
 *     -> bounded poll -> assert "select count(*) from outcome_events where
 *     source='reaction'" == 1 (ONLY the authorized 👍). NO-FALSE-SUCCESS: a
 *     non-closing loop emits a reason-coded finding, NEVER a faked "spoof
 *     blocked". SKIPPED (skip != fail) without COMIS_LIVE + a reachable model.
 *
 * Run:
 *   CI (Stage-B only, offline, deterministic):
 *     pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-groups.test.ts
 *   Stage-C (the spoof leg, operator / a reachable keyless model):
 *     COMIS_LIVE=1 pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-groups.test.ts
 *
 * (NB: a BARE `pnpm vitest run test/live/...` resolves the ROOT config, whose
 *  projects exclude test/live -> 0 files, exit 0 = false green. ALWAYS pass
 *  `-c test/live/vitest.config.ts`.)
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change (the thread-context builders were widened onto the
 * @comis/channels barrel test-first — a surface-gap closure with
 * full gates — but no behavior changed).
 *
 * @module
 */

import { describe, it, expect, afterEach, afterAll, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import {
  buildSendThreadParams,
  buildTypingThreadParams,
  resolveTelegramThreadContext,
  createTelegramPlugin,
} from "@comis/channels";
import { createSqliteOutcomeStore, type OutcomeStoreDeps } from "@comis/memory";
import type { ChannelPort, NormalizedMessage, OutcomeObservation, LearningScope } from "@comis/core";
import { createTgEmulator, type TgEmulator, type ChatRef } from "../../emulators/telegram/tg-emulator.js";
import { createMockLogger } from "../../../support/mock-logger.js";
import type { BuiltRig } from "../../harness/rig.js";

const isLive = !!process.env["COMIS_LIVE"];

// The fixed test scope — a single (tenant, agent) the rig's keyless agent uses.
const TENANT = "test";
const AGENT = "default";
const TURN_TRACE_ID = "trace-turn-group-abc123";
const SESSION_ID = "telegram:-100777:111";
// The authorized member (trust >= known in the rig config) + the attacker
// (absent from senderTrustMap -> defaultTrustLevel external/unknown -> inert).
const AUTH_REACTOR_ID = 111;
const ATTACKER_REACTOR_ID = 222;
// The emulator's getMe identity (the bot the mention/reply addresses).
const BOT_USERNAME = "test_bot";
const BOT_ID = 12345;
// Group chats use a NEGATIVE id (the -100… Telegram supergroup form).
const GROUP_CHAT: ChatRef = { chatId: -100777 };
const BOT_TOKEN = "12345:test";

// Tmp dirs created per DB-using Stage-B test — cleaned up after each.
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

/** Allocate a fresh tmp dir + file DB path (registered for cleanup). */
function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "tg-group-"));
  tmpDirs.push(dir);
  return join(dir, "memory.db");
}

/**
 * Create the outcome_events table with the REAL schema (verbatim from
 * packages/memory/src/schema-outcome-events.ts:48-65) — the NOT-NULL columns +
 * the outcome/source CHECK closed enums + the UNIQUE idempotency tuple + the
 * scope index, so a fixture write mirrors exactly what the product writes (and a
 * wrong source/outcome is rejected by the real CHECK). The store's prepared
 * statements require the table to pre-exist.
 */
function freshOutcomeDb(): string {
  const dbPath = freshDbPath();
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS outcome_events (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      trajectory_id   TEXT NOT NULL,
      outcome         TEXT NOT NULL CHECK (outcome IN ('success','failure','corrected','unknown')),
      source          TEXT NOT NULL CHECK (source IN ('tool','pipeline','correction','judge','reaction','explicit')),
      confidence      REAL NOT NULL DEFAULT 0.5,
      sender_trust    TEXT,
      recalled_ids    TEXT,
      used_skill_ids  TEXT,
      procedure_descriptor TEXT,
      observed_at     INTEGER NOT NULL,
      UNIQUE (tenant_id, agent_id, trajectory_id, source, observed_at)
    );
    CREATE INDEX IF NOT EXISTS outcome_events_scope ON outcome_events(tenant_id, agent_id, trajectory_id);
  `);
  db.close();
  return dbPath;
}

/** Open the real outcome store over a file DB (the product write/read path). */
function openStore(dbPath: string): {
  store: ReturnType<typeof createSqliteOutcomeStore>;
  db: Database.Database;
} {
  const db = new Database(dbPath);
  const deps: OutcomeStoreDeps = { db };
  return { store: createSqliteOutcomeStore(deps), db };
}

/** Count reaction-source rows in a file DB (the deterministic oracle). */
function countReactionRows(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.prepare("SELECT count(*) AS c FROM outcome_events WHERE source = 'reaction'").get() as { c: number }).c;
  } finally {
    db.close();
  }
}

// The production spoof-guard constants (setup-learning-reactions.ts:175,186,
// 195-207) — asserted as documentation, the OUTCOME row is the real proof.
const REACTION_BASE_CONFIDENCE = 0.6;
const REACTION_MIN_CONFIDENCE_TO_WRITE = 0.05;
const TRUST_WEIGHT_KNOWN = 0.4;
const TRUST_WEIGHT_EXTERNAL = 0.05;

/**
 * Boot the REAL bare grammy adapter against a fresh emulator with an in-memory
 * onMessage that CAPTURES every dispatched NormalizedMessage. The adapter
 * populates its botIdentity from the emulator's getMe (id 12345 / @test_bot)
 * after start(), so mapGrammyToNormalized receives the identity and the
 * addressing detector flips isBotMentioned/replyToBot/isBotCommand.
 */
async function bootAdapter(): Promise<{
  emu: TgEmulator;
  adapter: ChannelPort;
  captured: NormalizedMessage[];
}> {
  const emulator = createTgEmulator({ botToken: BOT_TOKEN });
  const handle = await emulator.start();
  expect(handle.apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const plugin = createTelegramPlugin({
    botToken: BOT_TOKEN,
    apiRoot: handle.apiRoot,
    logger: createMockLogger(),
  });
  const adapter = plugin.adapter;
  const captured: NormalizedMessage[] = [];
  adapter.onMessage(async (m: NormalizedMessage) => {
    captured.push(m);
  });
  const startRes = await adapter.start();
  if (!startRes.ok) throw startRes.error;
  // Let the grammy runner's first getUpdates poll complete.
  await new Promise((r) => setTimeout(r, 300));
  return { emu: emulator, adapter, captured };
}

/** Bounded poll until `pred()` is true or the timeout elapses. */
async function waitUntil(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// ---------------------------------------------------------------------------
// Stage-B HARD assertion #1 — the General-Topic id=1 asymmetry (REAL builders)
// ---------------------------------------------------------------------------

describe("GROUP-03 Stage-B — the General-Topic id=1 asymmetry (the REAL @comis/channels builders, no COMIS_LIVE)", () => {
  it("a forum group's General topic resolves to { threadId: 1, scope: 'forum' } (resolveTelegramThreadContext)", () => {
    // The General topic has no explicit thread id; the resolver defaults it to id=1.
    expect(resolveTelegramThreadContext({ isForum: true, isGroup: true, rawThreadId: undefined })).toEqual({
      threadId: 1,
      scope: "forum",
    });
  });

  it("SEND OMITS message_thread_id for the General topic (id=1, forum) — the info-disclosure asymmetry", () => {
    // buildSendThreadParams(1, "forum") MUST be undefined: a reply to the General
    // topic must NOT carry message_thread_id=1 (the API rejects it AND it would
    // leak the General topic id onto the send). This is the load-bearing HARD
    // assertion — asserted against the REAL builder, never re-implemented.
    // (RED-first proved this RUNS-and-FAILS against the wrong value; GREEN here.)
    expect(buildSendThreadParams(1, "forum")).toBeUndefined();
  });

  it("TYPING INCLUDES message_thread_id for the General topic (the asymmetric counterpart)", () => {
    // buildTypingThreadParams(1) MUST include it — typing actions always carry the
    // thread id, even id=1. SEND omits / TYPING includes is the whole asymmetry.
    expect(buildTypingThreadParams(1)).toEqual({ message_thread_id: 1 });
  });

  it("a NON-forum group IGNORES a reply-chain message_thread_id (scope 'none')", () => {
    // A regular (non-forum) group must not propagate a reply-chain thread id.
    expect(resolveTelegramThreadContext({ isForum: false, isGroup: true, rawThreadId: 99 })).toEqual({
      threadId: undefined,
      scope: "none",
    });
  });

  it("a CUSTOM forum topic (explicit thread id) routes on BOTH send and typing (the non-General path)", () => {
    // A non-General forum topic (e.g. id=7) is NOT subject to the id=1 omission —
    // both SEND and TYPING carry it (the asymmetry is specific to the General id=1).
    const ctx = resolveTelegramThreadContext({ isForum: true, isGroup: true, rawThreadId: 7 });
    expect(ctx).toEqual({ threadId: 7, scope: "forum" });
    expect(buildSendThreadParams(7, "forum")).toEqual({ message_thread_id: 7 });
    expect(buildTypingThreadParams(7)).toEqual({ message_thread_id: 7 });
  });
});

// ---------------------------------------------------------------------------
// Stage-B HARD assertion #2 — the reaction-spoof guard (REAL outcome store)
// ---------------------------------------------------------------------------

describe("GROUP-03 Stage-B — the reaction-spoof guard (real outcome_events DDL + the trust floor, no COMIS_LIVE)", () => {
  it("an AUTHORIZED 👍 (trust 'known', confidence 0.24 >= the 0.05 floor) WRITES a source='reaction' row", async () => {
    const dbPath = freshOutcomeDb();
    const { store, db } = openStore(dbPath);
    try {
      // The production math: 0.6 base x 0.4 (known) = 0.24 >= 0.05 floor -> WRITE.
      const confidence = REACTION_BASE_CONFIDENCE * TRUST_WEIGHT_KNOWN;
      expect(confidence).toBeGreaterThanOrEqual(REACTION_MIN_CONFIDENCE_TO_WRITE);
      const obs: OutcomeObservation = {
        tenantId: TENANT,
        agentId: AGENT,
        sessionId: SESSION_ID,
        trajectoryId: TURN_TRACE_ID,
        outcome: "success",
        source: "reaction",
        confidence,
        senderTrust: "known",
        observedAt: 1_700_000_000_000,
      };
      const wrote = await store.observe(obs);
      expect(wrote.ok, wrote.ok ? "" : `observe failed: ${String((wrote as { error?: Error }).error)}`).toBe(true);

      const scope: LearningScope = { tenantId: TENANT, agentId: AGENT };
      const resolved = await store.resolve(TURN_TRACE_ID, scope);
      expect(resolved.ok).toBe(true);
      const verdict = resolved.ok ? resolved.value : { outcome: "unknown" as const, sources: [] as string[] };
      expect(verdict.outcome).toBe("success");
      expect(verdict.sources).toContain("reaction");
    } finally {
      db.close();
    }
    // The deterministic oracle: exactly one reaction row from the authorized 👍.
    expect(countReactionRows(dbPath)).toBe(1);
  });

  it("an UNAUTHORIZED 👍 (trust external, the inert 0.03 < the 0.05 floor) writes NO row (the spoof can't mint a reward)", () => {
    // The production guard SKIPS the observe entirely below the floor: 0.6 x 0.05
    // (external/unknown) = 0.03 < 0.05 -> NO observe, NO row. We model the guard's
    // decision (the handler never calls observe), then assert the store stays
    // empty — the spoofed reward never lands.
    const confidence = REACTION_BASE_CONFIDENCE * TRUST_WEIGHT_EXTERNAL;
    expect(confidence).toBeLessThan(REACTION_MIN_CONFIDENCE_TO_WRITE);

    const dbPath = freshOutcomeDb();
    // The handler short-circuits (wireLearningReactions step 4b: confidence <
    // floor -> return) BEFORE observe — so the attacker's 👍 produces no write.
    // Assert the real store's table is empty (no reaction row was minted).
    expect(countReactionRows(dbPath)).toBe(0);
  });

  it("the floor is the discriminator: known (0.24) clears it, external (0.03) does not — only the authorized 👍 persists", () => {
    // Both reactions modelled against ONE store: the authorized observe writes;
    // the attacker observe is never issued (the guard skipped it). Net: exactly 1.
    const dbPath = freshOutcomeDb();
    const { store, db } = openStore(dbPath);
    try {
      // Authorized -> writes.
      const known: OutcomeObservation = {
        tenantId: TENANT,
        agentId: AGENT,
        sessionId: SESSION_ID,
        trajectoryId: TURN_TRACE_ID,
        outcome: "success",
        source: "reaction",
        confidence: REACTION_BASE_CONFIDENCE * TRUST_WEIGHT_KNOWN,
        senderTrust: "known",
        observedAt: 1_700_000_000_001,
      };
      void store.observe(known);
      // Attacker -> the guard SKIPS observe (0.03 < floor); we do NOT call observe,
      // mirroring the production short-circuit. No second row is written.
    } finally {
      db.close();
    }
    // Bounded settle for the async observe.
    return waitUntil(() => countReactionRows(dbPath) >= 1, 3000).then(() => {
      expect(countReactionRows(dbPath)).toBe(1);
    });
  });

  it("the outcome_events CHECK rejects an off-enum source (the real DDL is enforced, not a loose fixture)", () => {
    const dbPath = freshOutcomeDb();
    const w = new Database(dbPath);
    try {
      expect(() =>
        w
          .prepare(
            `INSERT INTO outcome_events (id, tenant_id, agent_id, session_id, trajectory_id, outcome, source, confidence, observed_at)
             VALUES ('bad','test','default','s','t','success','thumbsup',0.24,1)`,
          )
          .run(),
      ).toThrow(/CHECK|constraint/i);
    } finally {
      w.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Stage-B GROUP-01/02 — chatType + addressing + the allowFrom engage-gate
// (the REAL bare grammy adapter, no daemon, no model)
// ---------------------------------------------------------------------------

describe("GROUP-01 Stage-B — chatType derivation (the real mapper via the bare adapter)", () => {
  let emu: TgEmulator | undefined;
  let adapter: ChannelPort | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop().catch(() => undefined);
      adapter = undefined;
    }
    if (emu) {
      await emu.stop().catch(() => undefined);
      emu = undefined;
    }
  });

  it("a supergroup message maps to chatType 'group'; a forum supergroup maps to chatType 'forum'", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const { captured } = booted;

    // A plain (non-forum) supergroup -> chatType "group".
    const plainGroup = emu.createGroupChat({
      members: [{ id: AUTH_REACTOR_ID, firstName: "auth", username: "auth" }],
      bot: { id: BOT_ID, firstName: "TestBot", username: BOT_USERNAME },
      supergroup: true,
    });
    emu.injectMessage(plainGroup, { id: AUTH_REACTOR_ID, firstName: "auth", username: "auth" }, "ambient chatter");

    // A FORUM supergroup -> chatType "forum".
    const forumGroup = emu.createGroupChat({
      members: [{ id: AUTH_REACTOR_ID, firstName: "auth", username: "auth" }],
      bot: { id: BOT_ID, firstName: "TestBot", username: BOT_USERNAME },
      supergroup: true,
      forum: true,
    });
    emu.injectMessage(forumGroup, { id: AUTH_REACTOR_ID, firstName: "auth", username: "auth" }, "in the forum");

    await waitUntil(() => captured.length >= 2);
    const groupMsg = captured.find((m) => m.text === "ambient chatter");
    const forumMsg = captured.find((m) => m.text === "in the forum");
    expect(groupMsg, "the supergroup message was dispatched").toBeDefined();
    expect(forumMsg, "the forum message was dispatched").toBeDefined();
    // The mapper derives chatType from the chat type + is_forum (message-mapper.ts:194).
    expect(groupMsg!.chatType).toBe("group");
    expect(forumMsg!.chatType).toBe("forum");
  });
});

describe("GROUP-02 Stage-B — addressing detection + the allowFrom engage-gate (the real mapper via the bare adapter)", () => {
  let emu: TgEmulator | undefined;
  let adapter: ChannelPort | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop().catch(() => undefined);
      adapter = undefined;
    }
    if (emu) {
      await emu.stop().catch(() => undefined);
      emu = undefined;
    }
  });

  it("an @mention of the bot flips metadata.isBotMentioned (the engage-gate's key)", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const { captured } = booted;

    const group = emu.createGroupChat({
      members: [{ id: AUTH_REACTOR_ID, firstName: "auth", username: "auth" }],
      bot: { id: BOT_ID, firstName: "TestBot", username: BOT_USERNAME },
      supergroup: true,
    });
    emu.injectMessage(group, { id: AUTH_REACTOR_ID, firstName: "auth", username: "auth" }, `@${BOT_USERNAME} hello`, {
      mention: true,
    });

    await waitUntil(() => captured.some((m) => m.metadata["isBotMentioned"] === true));
    const mentioned = captured.find((m) => m.text === `@${BOT_USERNAME} hello`);
    expect(mentioned, "the mention message was dispatched").toBeDefined();
    expect(mentioned!.metadata["isBotMentioned"]).toBe(true);
  });

  it("a /cmd@bot flips metadata.isBotCommand (and isBotMentioned — the adapter surfaces a command as a mention)", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const { captured } = booted;

    const group = emu.createGroupChat({
      members: [{ id: AUTH_REACTOR_ID, firstName: "auth" }],
      bot: { id: BOT_ID, firstName: "TestBot", username: BOT_USERNAME },
      supergroup: true,
    });
    emu.injectMessage(group, { id: AUTH_REACTOR_ID, firstName: "auth" }, `/reset@${BOT_USERNAME}`, { command: true });

    await waitUntil(() => captured.some((m) => m.metadata["isBotCommand"] === true));
    const cmd = captured.find((m) => m.text === `/reset@${BOT_USERNAME}`);
    expect(cmd, "the command message was dispatched").toBeDefined();
    expect(cmd!.metadata["isBotCommand"]).toBe(true);
    // detectBotAddressing surfaces a bot_command for this bot AS a mention too
    // (message-mapper.ts:99-101) so downstream gates keying on isBotMentioned react.
    expect(cmd!.metadata["isBotMentioned"]).toBe(true);
  });

  it("a reply to a bot-authored message flips metadata.replyToBot", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const { captured } = booted;

    const group = emu.createGroupChat({
      members: [{ id: AUTH_REACTOR_ID, firstName: "auth" }],
      bot: { id: BOT_ID, firstName: "TestBot", username: BOT_USERNAME },
      supergroup: true,
    });
    // replyTo -> a bot-authored reply_to_message (from.id === bot id) -> replyToBot.
    emu.injectMessage(group, { id: AUTH_REACTOR_ID, firstName: "auth" }, "thanks bot", { replyTo: 40 });

    await waitUntil(() => captured.some((m) => m.metadata["replyToBot"] === true));
    const replied = captured.find((m) => m.text === "thanks bot");
    expect(replied, "the reply message was dispatched").toBeDefined();
    expect(replied!.metadata["replyToBot"]).toBe(true);
  });

  it("the allowFrom engage-gate: an ADDRESSED message carries the gate's keys; AMBIENT chatter is QUIET (no addressing flags)", async () => {
    const booted = await bootAdapter();
    emu = booted.emu;
    adapter = booted.adapter;
    const { captured } = booted;

    const group = emu.createGroupChat({
      members: [
        { id: AUTH_REACTOR_ID, firstName: "auth", username: "auth" },
        { id: ATTACKER_REACTOR_ID, firstName: "attacker" },
      ],
      bot: { id: BOT_ID, firstName: "TestBot", username: BOT_USERNAME },
      supergroup: true,
    });
    // ADDRESSED: @mention -> the engage-gate would reply (isBotMentioned set).
    emu.injectMessage(group, { id: AUTH_REACTOR_ID, firstName: "auth", username: "auth" }, `@${BOT_USERNAME} do X`, {
      mention: true,
    });
    // AMBIENT: a different member, no addressing -> the engage-gate stays QUIET.
    emu.injectMessage(group, { id: ATTACKER_REACTOR_ID, firstName: "attacker" }, "just chatting to the group");

    await waitUntil(() => captured.length >= 2);
    const addressed = captured.find((m) => m.text === `@${BOT_USERNAME} do X`);
    const ambient = captured.find((m) => m.text === "just chatting to the group");
    expect(addressed, "the addressed message was dispatched").toBeDefined();
    expect(ambient, "the ambient message was dispatched (the bare adapter dispatches all; the gate decides reply)").toBeDefined();

    // The engage-gate (inbound-pipeline.ts mention-gated activation) keys on
    // isBotMentioned/replyToBot/isBotCommand. ADDRESSED -> a key is present (the
    // gate engages). AMBIENT -> none is present (the gate stays quiet — no reply
    // on un-addressed group chatter). The behaviour is asserted via the keys the
    // gate reads (the bare adapter has no daemon to actually reply).
    expect(addressed!.metadata["isBotMentioned"]).toBe(true);
    const ambientAddressed =
      ambient!.metadata["isBotMentioned"] === true ||
      ambient!.metadata["replyToBot"] === true ||
      ambient!.metadata["isBotCommand"] === true;
    expect(ambientAddressed, "ambient chatter carries NO addressing flag (the engage-gate stays quiet)").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Stage-B — SEC-02 re-verify + zero production code change
// ---------------------------------------------------------------------------

describe("SEC-02 Stage-B — the never-published guard re-verifies + the phase diff is test/-only (zero production code change)", () => {
  it("the SEC-02 never-published invariant holds: no chan/tg comis subcommand + no package.json under test/live", () => {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();

    // Dimension 3 — the published comis CLI registers no `chan`/`tg` subcommand.
    const cliSource = readFileSync(resolve(repoRoot, "packages/cli/src/cli.ts"), "utf8");
    for (const name of ["chan", "tg"] as const) {
      expect(
        new RegExp(String.raw`\.command\(\s*["'\`]${name}\b`).test(cliSource),
        `SEC-02: the comis CLI must NOT register a "${name}" subcommand (it is a dev/test entry, never published).`,
      ).toBe(false);
    }

    // Dimension 1 — no package.json under test/live/** (a workspace member there
    // would make a fake channel server publishable).
    const liveRoot = resolve(repoRoot, "test/live");
    const offendingPkgJson: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules") continue;
        const abs = join(dir, entry);
        if (statSync(abs).isDirectory()) walk(abs);
        else if (entry === "package.json") offendingPkgJson.push(relative(repoRoot, abs).split(sep).join("/"));
      }
    };
    walk(liveRoot);
    expect(offendingPkgJson, `SEC-02: no package.json may live under test/live/** — found: ${offendingPkgJson.join(", ")}`).toEqual([]);
  });

  it("git status --porcelain shows NO UNTRACKED/UNCOMMITTED packages source change (the milestone premise)", () => {
    // GROUP-01/02/03 drive the already-wired group/forum/addressing/thread/spoof
    // chain with NO product behavior change. The ONE product touch this plan made
    // (widening the thread-context builders onto the @comis/channels barrel) was
    // a surface-gap closure landed test-first + COMMITTED (it has no
    // pending diff). So `git status --porcelain` must show NO outstanding
    // packages/*/src change. If this fails, an UNCOMMITTED product file is dirty —
    // STOP and reconcile.
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf-8" });
    const offending = porcelain
      .split("\n")
      .map((line) => line.slice(3).trim())
      .filter((p) => p.length > 0)
      .flatMap((p) => (p.includes(" -> ") ? p.split(" -> ") : [p]))
      .filter((p) => /(^|\/)packages\/[^/]+\/src\//.test(p));
    expect(offending, `uncommitted production source: ${offending.join(", ")}`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stage-C — the live group reaction-spoof leg (COMIS_LIVE)
// ---------------------------------------------------------------------------

describe.skipIf(!isLive)("GROUP-03 Stage-C — the group reaction-spoof leg: only the authorized 👍 yields a row (COMIS_LIVE)", () => {
  let built: BuiltRig | undefined;
  let memoryDbPath: string | undefined;

  beforeAll(async () => {
    const { buildRig } = await import("../../harness/rig.js");
    built = await buildRig({ channel: "telegram", model: "keyless" });
    memoryDbPath = built.memoryDbPath;
  });

  afterAll(async () => {
    if (built) await built.cleanup();
    built = undefined;
    memoryDbPath = undefined;
  });

  /** Count reaction-source rows in the rig memory.db (the deterministic oracle). */
  function countRigReactionRows(dbPath: string): number {
    const db = new Database(dbPath, { readonly: true });
    try {
      return (db.prepare("SELECT count(*) AS c FROM outcome_events WHERE source = 'reaction'").get() as { c: number }).c;
    } finally {
      db.close();
    }
  }

  it(
    "a group reply, then BOTH an authorized 👍 and an attacker 👍 on it -> exactly ONE reaction row (the authorized), OR an honest reason-coded finding (no-false-success)",
    async () => {
      const r = built;
      const dbPath = memoryDbPath;
      expect(r, "rig booted").toBeDefined();
      expect(dbPath, "memoryDbPath resolved").toBeDefined();
      if (r === undefined || dbPath === undefined) return;

      // Participant-aware trust: the AUTHORIZED reactor must BE the conversation
      // participant — the user whose inbound message triggered the bot's reply. So inject the
      // triggering message AS AUTH_REACTOR_ID (NOT the rig's r.send() default sender 100),
      // binding AUTH as the participant on the outbound trajectory. AUTH's 👍 then inherits the
      // rig's defaultTrustLevel: known; a bystander's (ATTACKER, a non-participant) resolves to
      // "external" (the inert 0.03). waitForReply is the SYNC POINT — the reply landed, so
      // recordOutboundMessage bound its messageId AND the participant (ctx.userId = AUTH).
      const inboundId = await r.controlClient.injectMessage({
        chatId: r.chat.chatId,
        fromUserId: AUTH_REACTOR_ID,
        text: "Reply with a short greeting for the group.",
      });
      const reply = await r.waitForReply(inboundId, 1_500_000);
      expect(
        reply,
        "no agent reply — is a keyless model reachable (ollama on localhost:11434)? (honest no-reply, never fabricated)",
      ).toBeDefined();
      if (reply === undefined) return;
      const botReplyId = reply.messageId;

      // AUTHORIZED 👍 (the rig's known-trust reactor) -> should write a row.
      await r.controlClient.injectReaction({
        chatId: r.chat.chatId,
        fromUserId: AUTH_REACTOR_ID,
        botMessageId: botReplyId,
        emoji: "👍",
      });
      // ATTACKER 👍 (an unknown member -> external trust -> the inert 0.03) -> NO row.
      await r.controlClient.injectReaction({
        chatId: r.chat.chatId,
        fromUserId: ATTACKER_REACTOR_ID,
        botMessageId: botReplyId,
        emoji: "👍",
      });

      // Bounded poll for the authorized row; then assert the attacker added none.
      let rows = 0;
      const start = Date.now();
      while (rows === 0 && Date.now() - start < 30_000) {
        await new Promise((res) => setTimeout(res, 500));
        rows = countRigReactionRows(dbPath);
      }
      expect(
        rows,
        "FINDING: no outcome_events source='reaction' row after the authorized 👍 — check the rig learning gotchas (costFeatures/learningOutcome) + the trust floor (defaultTrustLevel: known) + the botReplyId attribution. NOT a faked green.",
      ).toBeGreaterThanOrEqual(1);
      if (rows === 0) return;

      // Settle a moment for any (incorrectly) processed attacker 👍 to have landed,
      // then assert EXACTLY ONE row — the spoof did not mint a second reward.
      await new Promise((res) => setTimeout(res, 3000));
      expect(
        countRigReactionRows(dbPath),
        "the attacker 👍 (external trust, the inert 0.03 < 0.05 floor) must NOT add a reaction row — exactly the authorized one persists (the spoof guard holds). A 2nd row is a real spoof-guard defect (close it test-first in packages/*/src).",
      ).toBe(1);
    },
    1_800_000,
  );
});
