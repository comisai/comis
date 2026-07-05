// SPDX-License-Identifier: Apache-2.0
/**
 * Stage-A unit tests for the Microsoft Teams wire emulator.
 *
 * Proves the emulator's three fake surfaces in isolation (no daemon):
 *   1. INBOUND AUTH FIDELITY — the emulator's signed Bearer is accepted by the
 *      adapter's OWN `createActivityJwtValidator` (from `@comis/channels`) when
 *      pointed at the emulator's `publicJwks()`, and REJECTED for a wrong audience
 *      / mismatched key. This is the load-bearing proof: the daemon's ingress uses
 *      exactly this validator, so a token the validator accepts here is a token
 *      the booted daemon accepts.
 *   2. CONNECTOR OUTBOUND ORACLE — a create/edit/delete/typing REST call to the
 *      fake Connector is recorded to the per-conversation oracle with the wire text.
 *   3. AAD TOKEN ENDPOINT — the client-credentials mint is answered + counted.
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/emulators/msteams/msteams-emulator.test.ts
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalJWKSet } from "jose";
import { createActivityJwtValidator } from "@comis/channels";
import {
  createMsTeamsEmulator,
  connectorRedirectFetch,
  registerMsTeamsDriveControl,
} from "./msteams-emulator.js";

let running: Awaited<ReturnType<ReturnType<typeof createMsTeamsEmulator>["start"]>> | undefined;
let active: ReturnType<typeof createMsTeamsEmulator> | undefined;

afterEach(async () => {
  if (active) await active.stop();
  active = undefined;
  running = undefined;
});

async function boot() {
  active = createMsTeamsEmulator();
  running = await active.start();
  return { emu: active, apiRoot: running.apiRoot };
}

/** Build the REAL adapter validator over the emulator's JWKS (what the daemon ingress uses). */
function validatorFor(emu: ReturnType<typeof createMsTeamsEmulator>) {
  return createActivityJwtValidator({
    // The emulator's public JWKS — structurally a JSONWebKeySet.
    jwks: createLocalJWKSet(
      emu.publicJwks() as unknown as Parameters<typeof createLocalJWKSet>[0],
    ),
  });
}

describe("msteams-emulator — boot + loopback bind", () => {
  it("boots on a loopback-only kernel-allocated port", async () => {
    const { apiRoot } = await boot();
    expect(apiRoot).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });
});

describe("msteams-emulator — inbound JWT fidelity (the REAL adapter validator)", () => {
  it("mints a Bearer the adapter's own validator ACCEPTS against publicJwks()", async () => {
    const { emu } = await boot();
    const validate = validatorFor(emu);
    const token = await emu.signInboundToken();
    const verdict = await validate(`Bearer ${token}`, emu.appId);
    expect(verdict.ok).toBe(true);
  });

  it("is REJECTED for a wrong audience (aud != configured appId)", async () => {
    const { emu } = await boot();
    const validate = validatorFor(emu);
    // A token this emulator signed for a DIFFERENT audience must not verify for appId.
    const forged = await emu.signInboundToken("some-other-app");
    const verdict = await validate(`Bearer ${forged}`, emu.appId);
    expect(verdict.ok).toBe(false);
  });

  it("is REJECTED when validated against a DIFFERENT emulator's JWKS (mismatched key)", async () => {
    const { emu } = await boot();
    const other = createMsTeamsEmulator();
    const validateWithWrongKeys = createActivityJwtValidator({
      jwks: createLocalJWKSet(
        other.publicJwks() as unknown as Parameters<typeof createLocalJWKSet>[0],
      ),
    });
    const token = await emu.signInboundToken();
    const verdict = await validateWithWrongKeys(`Bearer ${token}`, emu.appId);
    expect(verdict.ok).toBe(false);
  });

  it("exposes a JWKS with the signing kid/alg/use and persists it to disk", async () => {
    const { emu } = await boot();
    const jwks = emu.publicJwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ alg: "RS256", use: "sig" });
    expect(typeof (jwks.keys[0] as { kid?: string }).kid).toBe("string");
    const file = join(tmpdir(), `msteams-emu-jwks-${running!.port}.json`);
    emu.writeJwksFile(file);
    const onDisk = JSON.parse(readFileSync(file, "utf8")) as { keys: unknown[] };
    expect(onDisk.keys).toHaveLength(1);
  });
});

describe("msteams-emulator — fake AAD token endpoint", () => {
  it("answers the client-credentials mint and counts it", async () => {
    const { emu, apiRoot } = await boot();
    expect(emu.tokenMintCount()).toBe(0);
    const res = await fetch(
      `${apiRoot}/${emu.appId}-tenant/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      },
    );
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    expect(res.status).toBe(200);
    expect(body.access_token).toBeTruthy();
    expect(body.expires_in).toBeGreaterThan(0);
    expect(emu.tokenMintCount()).toBe(1);
  });
});

describe("msteams-emulator — fake Connector outbound oracle", () => {
  const CONV = "a:dm-conv-emu";

  async function postActivityBody(apiRoot: string, body: unknown, method = "POST", activityId?: string) {
    const suffix = activityId ? `/${encodeURIComponent(activityId)}` : "";
    const url = `${apiRoot}/v3/conversations/${encodeURIComponent(CONV)}/activities${suffix}`;
    return fetch(url, {
      method,
      headers: { authorization: "Bearer emulator-token", "content-type": "application/json" },
      ...(method === "DELETE" ? {} : { body: JSON.stringify(body) }),
    });
  }

  it("records a create-activity send with the wire text + returns a string id", async () => {
    const { emu, apiRoot } = await boot();
    const res = await postActivityBody(apiRoot, { type: "message", text: "bot reply" });
    const json = (await res.json()) as { id?: string };
    expect(res.status).toBe(200);
    expect(typeof json.id).toBe("string");
    const out = emu.outbound(CONV);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ op: "send", text: "bot reply", activityType: "message" });
    expect(emu.lastBotReply(CONV)?.text).toBe("bot reply");
  });

  it("records a typing keepalive distinctly from a message send", async () => {
    const { emu, apiRoot } = await boot();
    await postActivityBody(apiRoot, { type: "typing" });
    const out = emu.outbound(CONV);
    expect(out).toHaveLength(1);
    expect(out[0]?.op).toBe("typing");
  });

  it("records an edit (PUT) and a delete (DELETE) keyed by the activity id", async () => {
    const { emu, apiRoot } = await boot();
    await postActivityBody(apiRoot, { type: "message", text: "v2" }, "PUT", "5001");
    await postActivityBody(apiRoot, {}, "DELETE", "5001");
    const ops = emu.outbound(CONV).map((o) => o.op);
    expect(ops).toEqual(["edit", "delete"]);
    expect(emu.outbound(CONV)[0]?.text).toBe("v2");
  });

  it("classifies an Adaptive Card + an inline image attachment", async () => {
    const { emu, apiRoot } = await boot();
    await postActivityBody(apiRoot, {
      type: "message",
      text: "approve?",
      attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: {} }],
    });
    await postActivityBody(apiRoot, {
      type: "message",
      attachments: [{ contentType: "image/png", contentUrl: "data:image/png;base64,AAAA" }],
    });
    const out = emu.outbound(CONV);
    expect(out[0]?.hasCard).toBe(true);
    expect(out[1]?.hasImageAttachment).toBe(true);
  });

  it("isolates conversations and resets a conversation's oracle", async () => {
    const { emu, apiRoot } = await boot();
    await postActivityBody(apiRoot, { type: "message", text: "x" });
    expect(emu.outbound(CONV)).toHaveLength(1);
    // An unseen conversation is an honest empty (never a cross-conversation leak).
    expect(emu.outbound("a:other")).toHaveLength(0);
    emu.resetChat(CONV);
    expect(emu.outbound(CONV)).toHaveLength(0);
  });
});

describe("msteams-emulator — out-of-process drive-control surface", () => {
  it("signs an inbound token the REAL validator accepts, over /emu/sign-token", async () => {
    const { emu, apiRoot } = await boot();
    registerMsTeamsDriveControl(emu);
    const res = await fetch(`${apiRoot}/emu/sign-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token } = (await res.json()) as { token: string };
    expect(typeof token).toBe("string");
    // The out-of-process-obtained token verifies against the emulator's own JWKS.
    const validate = validatorFor(emu);
    expect((await validate(`Bearer ${token}`, emu.appId)).ok).toBe(true);
  });

  it("reads the Connector outbound oracle over /emu/outbound (with an afterCount cursor)", async () => {
    const { emu, apiRoot } = await boot();
    registerMsTeamsDriveControl(emu);
    const CONV = "a:drive-read";
    await fetch(
      `${apiRoot}/v3/conversations/${encodeURIComponent(CONV)}/activities`,
      {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ type: "message", text: "reply one" }),
      },
    );
    const res = await fetch(
      `${apiRoot}/emu/outbound?conversationId=${encodeURIComponent(CONV)}&afterCount=0`,
    );
    const body = (await res.json()) as { outbound: Array<{ text?: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.outbound[0]?.text).toBe("reply one");
    // The afterCount cursor returns only NEW records past the watermark.
    const res2 = await fetch(
      `${apiRoot}/emu/outbound?conversationId=${encodeURIComponent(CONV)}&afterCount=1`,
    );
    const body2 = (await res2.json()) as { outbound: unknown[] };
    expect(body2.outbound).toHaveLength(0);
  });
});

describe("msteams-emulator — connectorRedirectFetch", () => {
  it("rewrites the Connector + AAD hosts to loopback and passes other hosts through", async () => {
    const { emu, apiRoot } = await boot();
    const redirect = connectorRedirectFetch(apiRoot);
    // A Connector create to the REAL host is redirected to the loopback emulator.
    const res = await redirect(
      `https://smba.trafficmanager.net/v3/conversations/${encodeURIComponent("a:redir")}/activities`,
      {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ type: "message", text: "via redirect" }),
      },
    );
    expect(res.status).toBe(200);
    expect(emu.lastBotReply("a:redir")?.text).toBe("via redirect");
    // The AAD token host is redirected too (so the client-credentials mint lands).
    const tok = await redirect(
      "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
      { method: "POST", body: "grant_type=client_credentials" },
    );
    expect(tok.status).toBe(200);
    expect(emu.tokenMintCount()).toBe(1);
  });
});
