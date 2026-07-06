// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the Google Chat wire emulator.
 *
 * Proves the emulator's fake surfaces in isolation (no adapter, no daemon):
 *   1. OUTBOUND TOKEN FIDELITY — the emulator's fake service-account key JSON is
 *      minted into an access token by the adapter's OWN
 *      `createGoogleChatTokenProvider` (from `@comis/channels`) when its `tokenUrl`
 *      is pointed at the emulator. This is the load-bearing outbound proof: the
 *      real send path mints exactly this way, so a key + token endpoint that
 *      satisfy the real provider here satisfy the booted adapter.
 *   2. CHAT REST ORACLE — a create/edit/delete REST call to the fake Chat API is
 *      recorded to the per-space oracle with the wire text.
 *   3. PUB/SUB PULL/ACK — an injected inbound event is served (base64) on `:pull`
 *      and removed on `:acknowledge` (the ack contract).
 *   4. INBOUND JWT SIGNER — the emulator's signed Bearer is accepted by the
 *      adapter's OWN local-JWKS inbound verifier and rejected for a wrong audience
 *      / mismatched key (the webhook-mode trust anchor).
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/googlechat/googlechat-emulator.test.ts
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGoogleChatTokenProvider,
  createLocalGoogleChatInboundVerifier,
  CHAT_SCOPE,
} from "@comis/channels";
import { createMockLogger } from "../../../support/mock-logger.js";
import {
  createGoogleChatEmulator,
  registerGoogleChatDriveControl,
} from "./googlechat-emulator.js";

let active: ReturnType<typeof createGoogleChatEmulator> | undefined;
let running: Awaited<ReturnType<ReturnType<typeof createGoogleChatEmulator>["start"]>> | undefined;

afterEach(async () => {
  if (active) await active.stop();
  active = undefined;
  running = undefined;
});

async function boot() {
  active = createGoogleChatEmulator();
  running = await active.start();
  return { emu: active, apiRoot: running.apiRoot };
}

/** Build the REAL local-JWKS inbound verifier over the emulator's publicJwks(). */
function verifierFor(emu: ReturnType<typeof createGoogleChatEmulator>) {
  return createLocalGoogleChatInboundVerifier(
    emu.publicJwks() as unknown as Parameters<
      typeof createLocalGoogleChatInboundVerifier
    >[0],
    { audienceType: "project-number", audience: emu.projectNumber },
  );
}

describe("googlechat-emulator — boot + loopback bind", () => {
  it("boots on a loopback-only kernel-allocated port", async () => {
    const { apiRoot } = await boot();
    expect(apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("googlechat-emulator — outbound token fidelity (the REAL token provider)", () => {
  it("mints a fake SA key the adapter's OWN token provider exchanges for an access token", async () => {
    const { emu, apiRoot } = await boot();
    // The fake SA key parses as a service-account key JSON.
    const keyJson = JSON.parse(emu.fakeServiceAccountKeyJson()) as {
      client_email?: string;
      private_key?: string;
    };
    expect(typeof keyJson.client_email).toBe("string");
    expect(keyJson.private_key).toMatch(/BEGIN PRIVATE KEY/);

    // The REAL token provider imports the key, signs an assertion, and exchanges
    // it at the emulator's token endpoint — the exact outbound-auth path.
    const provider = createGoogleChatTokenProvider({
      serviceAccountKey: emu.fakeServiceAccountKeyJson(),
      logger: createMockLogger(),
      tokenUrl: `${apiRoot}/token`,
    });
    expect(emu.tokenMintCount()).toBe(0);
    const tok = await provider.getToken(CHAT_SCOPE);
    expect(tok.ok).toBe(true);
    expect(emu.tokenMintCount()).toBe(1);
  });
});

describe("googlechat-emulator — fake Chat REST outbound oracle", () => {
  const SPACE = "spaces/AAAA";

  async function chatFetch(
    apiRoot: string,
    resource: string,
    method: string,
    body?: unknown,
  ) {
    return fetch(`${apiRoot}/${resource}`, {
      method,
      headers: {
        authorization: "Bearer emulator-token",
        "content-type": "application/json",
      },
      ...(method === "DELETE" ? {} : { body: JSON.stringify(body ?? {}) }),
    });
  }

  it("records a messages.create send with the wire text + returns a message name", async () => {
    const { emu, apiRoot } = await boot();
    const res = await chatFetch(apiRoot, `${SPACE}/messages`, "POST", {
      text: "bot reply",
    });
    const json = (await res.json()) as { name?: string };
    expect(res.status).toBe(200);
    expect(json.name).toMatch(/^spaces\/AAAA\/messages\//);
    const out = emu.outbound(SPACE);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ op: "send", text: "bot reply" });
    expect(emu.lastBotReply(SPACE)?.text).toBe("bot reply");
  });

  it("flags a cardsV2 body on the recorded send", async () => {
    const { emu, apiRoot } = await boot();
    await chatFetch(apiRoot, `${SPACE}/messages`, "POST", {
      text: "approve?",
      cardsV2: [{ cardId: "c1", card: { sections: [] } }],
    });
    expect(emu.lastBotReply(SPACE)?.hasCards).toBe(true);
  });

  it("records an edit (PATCH) and a delete (DELETE) keyed by the space", async () => {
    const { emu, apiRoot } = await boot();
    await chatFetch(apiRoot, `${SPACE}/messages/5001?updateMask=text`, "PATCH", {
      text: "v2",
    });
    await chatFetch(apiRoot, `${SPACE}/messages/5001`, "DELETE");
    const ops = emu.outbound(SPACE).map((o) => o.op);
    expect(ops).toEqual(["edit", "delete"]);
    expect(emu.outbound(SPACE)[0]?.text).toBe("v2");
  });

  it("isolates spaces and resets a space's oracle", async () => {
    const { emu, apiRoot } = await boot();
    await chatFetch(apiRoot, `${SPACE}/messages`, "POST", { text: "x" });
    expect(emu.outbound(SPACE)).toHaveLength(1);
    // An unseen space is an honest empty (never a cross-space leak).
    expect(emu.outbound("spaces/other")).toHaveLength(0);
    emu.resetChat(SPACE);
    expect(emu.outbound(SPACE)).toHaveLength(0);
  });
});

describe("googlechat-emulator — fake Pub/Sub pull + acknowledge", () => {
  it("serves an injected inbound event on :pull as a base64 receivedMessage, then acks it", async () => {
    const { emu, apiRoot } = await boot();
    const SUB = "projects/test-project/subscriptions/comis-inbound";
    const event = { type: "MESSAGE", message: { name: "spaces/AAAA/messages/1" } };
    emu.injectInbound(event);
    expect(emu.pendingCount()).toBe(1);

    const pullRes = await fetch(`${apiRoot}/${SUB}:pull`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ maxMessages: 10 }),
    });
    const pullBody = (await pullRes.json()) as {
      receivedMessages?: Array<{ ackId?: string; message?: { data?: string } }>;
    };
    expect(pullRes.status).toBe(200);
    expect(pullBody.receivedMessages).toHaveLength(1);
    const rm = pullBody.receivedMessages![0]!;
    // STANDARD base64 decode round-trips to the injected event (the loop's decode).
    const decoded = JSON.parse(
      Buffer.from(rm.message!.data!, "base64").toString("utf8"),
    ) as { type?: string };
    expect(decoded.type).toBe("MESSAGE");

    // Acknowledge removes it (the ack contract) — a re-pull is then empty.
    expect(emu.ackedCount()).toBe(0);
    await fetch(`${apiRoot}/${SUB}:acknowledge`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ ackIds: [rm.ackId] }),
    });
    expect(emu.ackedCount()).toBe(1);
    expect(emu.pendingCount()).toBe(0);
  });
});

describe("googlechat-emulator — inbound JWT signer (the REAL local-JWKS verifier)", () => {
  it("mints a Bearer the adapter's OWN local verifier ACCEPTS against publicJwks()", async () => {
    const { emu } = await boot();
    const verify = verifierFor(emu);
    const token = await emu.signInboundToken();
    expect((await verify(`Bearer ${token}`)).ok).toBe(true);
  });

  it("is REJECTED for a wrong audience (aud != configured project number)", async () => {
    const { emu } = await boot();
    const verify = verifierFor(emu);
    const forged = await emu.signInboundToken({ audience: "999999999999" });
    expect((await verify(`Bearer ${forged}`)).ok).toBe(false);
  });

  it("is REJECTED when verified against a DIFFERENT emulator's JWKS (mismatched key)", async () => {
    const { emu } = await boot();
    const other = createGoogleChatEmulator();
    const verifyWrong = createLocalGoogleChatInboundVerifier(
      other.publicJwks() as unknown as Parameters<
        typeof createLocalGoogleChatInboundVerifier
      >[0],
      { audienceType: "project-number", audience: emu.projectNumber },
    );
    const token = await emu.signInboundToken();
    expect((await verifyWrong(`Bearer ${token}`)).ok).toBe(false);
  });

  it("exposes a JWKS with the signing kid/alg/use and persists it to disk", async () => {
    const { emu } = await boot();
    const jwks = emu.publicJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ alg: "RS256", use: "sig" });
    expect(typeof (jwks.keys[0] as { kid?: string }).kid).toBe("string");
    const file = join(tmpdir(), `googlechat-emu-jwks-${running!.port}.json`);
    emu.writeJwksFile(file);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { keys: unknown[] };
    expect(onDisk.keys).toHaveLength(1);
  });
});

describe("googlechat-emulator — out-of-process drive-control surface", () => {
  it("injects an inbound event over /emu/pubsub-inject and reads it back on :pull", async () => {
    const { emu, apiRoot } = await boot();
    registerGoogleChatDriveControl(emu);
    const SUB = "projects/test-project/subscriptions/comis-inbound";
    const res = await fetch(`${apiRoot}/emu/pubsub-inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "MESSAGE", message: { name: "spaces/AAAA/messages/9" } }),
    });
    expect(res.status).toBe(200);
    expect(emu.pendingCount()).toBe(1);
    const pull = await fetch(`${apiRoot}/${SUB}:pull`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ maxMessages: 10 }),
    });
    const body = (await pull.json()) as { receivedMessages?: unknown[] };
    expect(body.receivedMessages).toHaveLength(1);
  });

  it("signs an inbound token the REAL verifier accepts, over /emu/sign-token", async () => {
    const { emu, apiRoot } = await boot();
    registerGoogleChatDriveControl(emu);
    const res = await fetch(`${apiRoot}/emu/sign-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token } = (await res.json()) as { token: string };
    expect(typeof token).toBe("string");
    expect((await verifierFor(emu)(`Bearer ${token}`)).ok).toBe(true);
  });

  it("reads the Chat outbound oracle over /emu/outbound (with an afterCount cursor)", async () => {
    const { emu, apiRoot } = await boot();
    registerGoogleChatDriveControl(emu);
    const SPACE = "spaces/drive-read";
    await fetch(`${apiRoot}/${SPACE}/messages`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ text: "reply one" }),
    });
    const res = await fetch(
      `${apiRoot}/emu/outbound?space=${encodeURIComponent(SPACE)}&afterCount=0`,
    );
    const body = (await res.json()) as {
      outbound: Array<{ text?: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.outbound[0]?.text).toBe("reply one");
    const res2 = await fetch(
      `${apiRoot}/emu/outbound?space=${encodeURIComponent(SPACE)}&afterCount=1`,
    );
    const body2 = (await res2.json()) as { outbound: unknown[] };
    expect(body2.outbound).toHaveLength(0);
  });
});
