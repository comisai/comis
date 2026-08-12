// SPDX-License-Identifier: Apache-2.0
/**
 * DELIV-02 — outbound ATTACHMENT mirroring end-to-end (the media half of the
 * delivery round-trip, which DELIV-01's text path structurally cannot reach:
 * `sendMessage` never carries a media URL).
 *
 * The scenario an operator actually cares about: the agent hands a screenshot
 * and a voice note to a Telegram chat. Two things must hold, and the runtime
 * only reconciles if BOTH oracles agree:
 *
 *   1. CHANNEL oracle — the user receives them. The REAL grammy adapter's
 *      `sendAttachment` reaches the Bot API as `sendPhoto` / `sendVoice`, which
 *      the emulator records on the chat.
 *   2. MIRROR oracle — the runtime knows it sent them. Each successful send
 *      publishes an `after_delivery` event whose `mediaUrls` carry the
 *      attachment, which the `comis:delivery-mirror` plugin persists as a
 *      `delivery_mirror` row. A media-only send has NO text, so the mirror must
 *      recognize it by its media rather than skipping it as an empty delivery.
 *
 * The dedupe interaction is the sharp edge: `delivery_mirror` inserts
 * OR IGNORE on a UNIQUE idempotency key of
 * `conversationRef:hash:one-second-bucket`. Two CAPTIONLESS attachments sent in
 * the same second share their (empty) text, so the key must be derived from the
 * media too — otherwise the second screenshot is silently swallowed by the
 * unique index and the runtime believes it delivered one file when the user got
 * two. This asserts the hash segment (bucket-independent, so no
 * second-boundary flake) differs per attachment.
 *
 * ── THE CI vs COMIS_LIVE SPLIT ──
 *
 *   • Stage-B (ALWAYS runs, in-process, NO COMIS_LIVE, NO credentials, NO
 *     network beyond loopback): the whole path is REAL — the grammy adapter
 *     from `@comis/channels` bound to the loopback emulator's `apiRoot`, the
 *     daemon's own `instrumentAttachmentDeliveries` + `setupDeliveryMirror`
 *     wiring, the core plugin registry + hook runner, and a file-backed SQLite
 *     db built by the production `initSchema`. Nothing about the delivery path
 *     is stubbed; only the Telegram server is local.
 *
 *   • There is no Stage-C leg here: the agent-authored version of this send is
 *     DELIV-01's job. What this file proves — the attachment→hook→mirror
 *     handoff — is fully determined once the adapter's send succeeds, so a live
 *     model would add cost without adding evidence.
 *
 * Run:
 *   pnpm vitest run -c test/live/vitest.config.ts test/live/scenarios/channels/telegram-attachment-mirror.test.ts
 *
 * (NB: a BARE `pnpm vitest run test/live/...` resolves the ROOT config, whose
 *  projects exclude test/live -> 0 files, exit 0 = false green. ALWAYS pass
 *  `-c test/live/vitest.config.ts`.)
 *
 * TEST-HARNESS — lives under `test/`, never the packages source-tree; ZERO
 * production code change.
 *
 * @module
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createTelegramPlugin } from "@comis/channels";
import { createHookRunner, createPluginRegistry, runWithContext, type ChannelPort } from "@comis/core";
import { initSchema, openSqliteDatabase } from "@comis/memory";
import { createTgEmulator, type ChatRef, type TgEmulator } from "../../emulators/telegram/tg-emulator.js";
import { createMockLogger } from "../../../support/mock-logger.js";

// The daemon's channel + delivery wiring is internal to @comis/daemon (not on
// its `exports` map), so the built modules are loaded by path — the same dist
// the daemon entrypoint runs.
const SETUP_DELIVERY_MODULE = new URL(
  "../../../../packages/daemon/dist/wiring/setup-delivery.js",
  import.meta.url,
).href;
const ATTACHMENT_HOOKS_MODULE = new URL(
  "../../../../packages/daemon/dist/wiring/setup-channels/attachment-delivery-hooks.js",
  import.meta.url,
).href;

/** The fixed test chat (a fabricated id, never a real operator chat). */
const TEST_CHAT: ChatRef = { chatId: 424242 };
const BOT_TOKEN = "12345:test";
const TENANT_ID = "default";
const AGENT_ID = "default";
const PRINCIPAL_ID = "user_a";

/** The delivery-mirror row shape this scenario reads back (the persisted contract). */
interface MirrorRow {
  readonly text: string;
  readonly media_urls: string;
  readonly channel_type: string;
  readonly channel_id: string;
  readonly origin: string;
  readonly idempotency_key: string;
}

/**
 * The bucket-independent segment of `conversationRef:hash:secondBucket`. The
 * conversationRef is base64url (no colons), so the hash is the second-to-last
 * segment. Comparing hashes rather than whole keys means a send that straddles
 * a one-second boundary cannot make the distinctness assertion pass for the
 * wrong reason.
 */
function idempotencyHash(key: string): string {
  const parts = key.split(":");
  return parts[parts.length - 2] ?? "";
}

interface Wiring {
  readonly emulator: TgEmulator;
  readonly adapter: ChannelPort;
  readonly dbPath: string;
  readonly dir: string;
  readonly shutdownMirror: () => void;
  readonly db: Database.Database;
}

const wirings: Wiring[] = [];

afterEach(async () => {
  for (const w of wirings) {
    await w.adapter.stop().catch(() => undefined);
    await w.emulator.stop().catch(() => undefined);
    w.shutdownMirror();
    w.db.close();
    rmSync(w.dir, { recursive: true, force: true });
  }
  wirings.length = 0;
});

/**
 * Assemble the REAL outbound path: grammy adapter -> emulator, and
 * adapter.sendAttachment -> after_delivery hook -> the delivery-mirror plugin
 * -> a production-schema SQLite db.
 */
async function buildWiring(): Promise<Wiring> {
  const { setupDeliveryMirror } = await import(SETUP_DELIVERY_MODULE) as {
    setupDeliveryMirror: (deps: Record<string, unknown>) => Promise<{ shutdown: () => void }>;
  };
  const { instrumentAttachmentDeliveries } = await import(ATTACHMENT_HOOKS_MODULE) as {
    instrumentAttachmentDeliveries: (
      adapters: Map<string, ChannelPort>,
      deps: Record<string, unknown>,
    ) => void;
  };

  const dir = mkdtempSync(join(tmpdir(), "tg-attach-mirror-"));
  const dbPath = join(dir, "memory.db");
  // The PRODUCTION schema — delivery_mirror's columns, CHECK constraints and
  // the UNIQUE idempotency index all come from packages/memory, not a fixture.
  const db = openSqliteDatabase({
    dbPath,
    initSchema: (handle: Database.Database) => { initSchema(handle, 1536); },
  });

  const pluginRegistry = createPluginRegistry();
  const logger = createMockLogger();
  const mirror = await setupDeliveryMirror({
    db,
    config: {
      deliveryMirror: {
        enabled: true,
        retentionMs: 86_400_000,
        pruneIntervalMs: 300_000,
        maxEntriesPerInjection: 10,
        maxCharsPerInjection: 4000,
      },
    },
    pluginRegistry,
    logger,
  });
  // catchErrors:false so a hook failure surfaces as a test failure instead of a
  // silently empty mirror.
  const hookRunner = createHookRunner(pluginRegistry, { catchErrors: false });

  const emulator = createTgEmulator({ botToken: BOT_TOKEN });
  const handle = await emulator.start();
  expect(handle.apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

  const adapter = createTelegramPlugin({
    getBotToken: () => BOT_TOKEN,
    apiRoot: handle.apiRoot,
    logger: createMockLogger(),
  }).adapter;
  const started = await adapter.start();
  if (!started.ok) throw started.error;

  instrumentAttachmentDeliveries(new Map([["telegram", adapter]]), {
    hookRunner,
    logger,
    clock: { now: () => Date.now() },
  });

  const wiring: Wiring = {
    emulator,
    adapter,
    dbPath,
    dir,
    db,
    shutdownMirror: mirror.shutdown,
  };
  wirings.push(wiring);
  return wiring;
}

/** Run `fn` inside the turn scope a resolved inbound Telegram message establishes. */
async function inTurnScope<T>(adapter: ChannelPort, fn: () => Promise<T>): Promise<T> {
  const endpoint = {
    channelType: "telegram",
    channelInstanceId: adapter.channelId,
    conversationId: String(TEST_CHAT.chatId),
    conversationKind: "direct" as const,
  };
  return runWithContext({
    tenantId: TENANT_ID,
    userId: PRINCIPAL_ID,
    sessionKey: `${TENANT_ID}:agent:${AGENT_ID}:${PRINCIPAL_ID}:telegram:peer:${PRINCIPAL_ID}`,
    agentId: AGENT_ID,
    turnScope: {
      conversation: {
        tenantId: TENANT_ID,
        agentId: AGENT_ID,
        partition: {
          kind: "endpoint-conversation-principal",
          endpoint,
          principalId: PRINCIPAL_ID,
        },
      },
      principal: { principalId: PRINCIPAL_ID },
      endpoint,
    },
    traceId: "550e8400-e29b-41d4-a716-446655440000",
    startedAt: Date.now(),
    trustLevel: "admin",
  }, fn);
}

function readMirrorRows(dbPath: string): MirrorRow[] {
  const reader = new Database(dbPath, { readonly: true });
  try {
    return reader
      .prepare("SELECT * FROM delivery_mirror ORDER BY created_at ASC, rowid ASC")
      .all() as MirrorRow[];
  } finally {
    reader.close();
  }
}

describe("DELIV-02 Stage-B — outbound attachments reach the chat AND the delivery mirror", () => {
  it("mirrors a captionless screenshot and voice note the user received, without deduping one away", async () => {
    const { adapter, emulator, dir, dbPath } = await buildWiring();

    // Two DISTINCT captionless files — the shape that collides on a text-only
    // idempotency key.
    const screenshot = join(dir, "screenshot.png");
    const voiceNote = join(dir, "briefing.ogg");
    writeFileSync(screenshot, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    writeFileSync(voiceNote, Buffer.from("4f676753000200000000000000000000", "hex"));

    const sends = await inTurnScope(adapter, async () => [
      await adapter.sendAttachment!(String(TEST_CHAT.chatId), {
        type: "image",
        url: screenshot,
      }),
      await adapter.sendAttachment!(String(TEST_CHAT.chatId), {
        type: "audio",
        url: voiceNote,
        isVoiceNote: true,
        durationSecs: 3,
      }),
    ]);

    // --- Both sends succeeded on the real adapter ---
    expect(sends.map((s) => s.ok)).toEqual([true, true]);

    // --- CHANNEL oracle: what the Telegram user actually received ---
    const delivered = emulator.outbound(TEST_CHAT);
    expect(delivered.map((o) => o.method)).toEqual(
      expect.arrayContaining(["sendPhoto", "sendVoice"]),
    );
    expect(
      delivered.filter((o) => o.mediaKind === "photo" || o.mediaKind === "voice"),
    ).toHaveLength(2);

    // --- MIRROR oracle: what the runtime recorded about that delivery ---
    const rows = readMirrorRows(dbPath);
    expect(rows).toHaveLength(2);

    // A media-only send is recognized BY ITS MEDIA: no text, but a real row
    // carrying the file the user got, attributed to the attachment path.
    expect(rows.map((r) => r.text)).toEqual(["", ""]);
    expect(rows.map((r) => JSON.parse(r.media_urls) as string[])).toEqual([
      [screenshot],
      [voiceNote],
    ]);
    for (const row of rows) {
      expect(row.origin).toBe("channel:attachment");
      expect(row.channel_type).toBe("telegram");
      expect(row.channel_id).toBe(String(TEST_CHAT.chatId));
    }

    // --- The dedupe edge: same (empty) text, same second, DIFFERENT media ---
    // The bucket-independent hash segment must differ, or INSERT OR IGNORE
    // drops the second file and the mirror under-reports the delivery.
    const [firstKey, secondKey] = rows.map((r) => r.idempotency_key);
    expect(idempotencyHash(firstKey!)).not.toBe(idempotencyHash(secondKey!));
  });

  it("records nothing when the attachment never reached the chat", async () => {
    const { adapter, emulator, dir, dbPath } = await buildWiring();

    // The emulator rejects the send; the mirror must not claim a delivery the
    // user never received.
    emulator.fail("sendPhoto", { error_code: 400, description: "Bad Request: chat not found" });

    const missing = join(dir, "never-sent.png");
    writeFileSync(missing, Buffer.from("89504e470d0a1a0a", "hex"));

    const result = await inTurnScope(adapter, () => adapter.sendAttachment!(
      String(TEST_CHAT.chatId),
      { type: "image", url: missing },
    ));

    expect(result.ok).toBe(false);
    expect(readMirrorRows(dbPath)).toHaveLength(0);
  });
});
