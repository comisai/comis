// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams emulator — the offline round-trip proof (the Teams analog of
 * `telegram-emulator.test.ts` / `signal-foundation-proof.test.ts`).
 *
 * STAGE-B (always runs; no `COMIS_LIVE`, no model, no daemon): the whole Teams
 * wire stack is exercised in-process by constructing the REAL production pieces
 * directly and injecting the emulator's DI seams — exactly the seams the
 * factories already expose, so NO product wiring is needed for this proof:
 *
 *   signed Activity ──▶ createMsTeamsIngress (REAL BF-JWT gate, local JWKS)
 *                  ──▶ adapter.handleWebhookEvents (REAL mapper + allowlist)
 *                  ──▶ onMessage handler replies
 *                  ──▶ adapter.sendMessage (REAL connector + isSafeServiceUrl gate)
 *                  ──▶ fetchImpl = connectorRedirectFetch ──▶ the emulator's fake
 *                      Connector oracle.
 *
 * This is the drift tripwire + the security proof in one: a real inbound token
 * the ingress accepts, the real default-deny allowlist, the real
 * `isSafeServiceUrl` host gate (which still REJECTS a non-Connector host even in
 * the emulator setup), and the real Connector REST shape — all offline.
 *
 * Unlike the Telegram/Signal emulators, the Teams channel required two documented
 * OFF-BY-DEFAULT daemon seams (a local-JWKS validator + a Connector-host redirect
 * fetch) to round-trip a FULL booted daemon — those are unit-proven in
 * `packages/daemon/src/wiring/msteams-test-seams.test.ts` and exercised by the
 * COMIS_LIVE rig leg. So this file deliberately carries NO "zero product change"
 * git-porcelain guard (the branch legitimately adds those seams); the Stage-B
 * proof here needs none of them because it constructs the pieces directly.
 *
 * Run under the LIVE vitest config (the bare root config excludes `test/live`):
 *   pnpm vitest run -c test/live/vitest.config.ts \
 *     test/live/scenarios/channels/msteams-emulator.test.ts
 *
 * @module
 */

import { afterEach, describe, expect, it } from "vitest";
import { createLocalJWKSet } from "jose";
import {
  createMsTeamsPlugin,
  createActivityJwtValidator,
  type MsTeamsAdapterHandle,
  type TeamsActivity,
} from "@comis/channels";
import { createMsTeamsIngress } from "@comis/gateway";
import type {
  ComisLogger,
  MsTeamsConversationStorePort,
  NormalizedMessage,
  NormalizedReaction,
} from "@comis/core";
import { ok, type Result } from "@comis/shared";
import { createMockLogger } from "../../../support/mock-logger.js";
import {
  createMsTeamsEmulator,
  connectorRedirectFetch,
  type MsTeamsEmulator,
} from "../../emulators/msteams/msteams-emulator.js";
import {
  makeMessageActivity,
  makeReactionActivity,
  makeCardActionInvoke,
} from "../../emulators/msteams/msteams-payloads.js";

/** A trivial in-memory conversation-reference store (the proactive-send seam). */
function createMemoryConversationStore(): MsTeamsConversationStorePort & {
  readonly size: () => number;
} {
  type Ref = Parameters<MsTeamsConversationStorePort["capture"]>[0];
  const map = new Map<string, Ref>();
  return {
    async capture(reference): Promise<Result<void, Error>> {
      map.set(reference.conversationId, reference);
      return ok(undefined);
    },
    async get(conversationId): Promise<Result<Ref | undefined, Error>> {
      return ok(map.get(conversationId));
    },
    size: () => map.size,
  };
}

interface Stack {
  emu: MsTeamsEmulator;
  adapter: MsTeamsAdapterHandle;
  ingress: ReturnType<typeof createMsTeamsIngress>;
  messages: NormalizedMessage[];
  reactions: NormalizedReaction[];
  store: ReturnType<typeof createMemoryConversationStore>;
}

const stacks: MsTeamsEmulator[] = [];
afterEach(async () => {
  while (stacks.length > 0) await stacks.pop()!.stop();
});

/**
 * Build a full offline Teams stack: the emulator + the REAL adapter (fetchImpl =
 * the emulator redirect) + the REAL ingress (validator over the emulator JWKS).
 * An `onMessage` handler auto-replies "echo: <text>" via the inbound serviceUrl
 * (the 228 reply path). `allowMode` defaults to "open".
 */
async function buildStack(opts?: {
  allowMode?: "allowlist" | "open";
  allowFrom?: string[];
  autoReply?: boolean;
}): Promise<Stack> {
  const emu = createMsTeamsEmulator();
  const { apiRoot } = await emu.start();
  stacks.push(emu);

  const logger: ComisLogger = createMockLogger();
  const store = createMemoryConversationStore();
  const messages: NormalizedMessage[] = [];
  const reactions: NormalizedReaction[] = [];

  const plugin = createMsTeamsPlugin({
    appId: emu.appId,
    appPassword: "emulator-secret",
    tenantId: "00000000-0000-0000-0000-000000000001",
    allowFrom: opts?.allowFrom ?? [],
    allowMode: opts?.allowMode ?? "open",
    logger,
    conversationStore: store,
    // The load-bearing DI: outbound Connector + token calls are redirected to the
    // loopback emulator (isSafeServiceUrl still runs on the real host first).
    fetchImpl: connectorRedirectFetch(apiRoot),
  });
  const adapter = plugin.adapter as MsTeamsAdapterHandle;
  await adapter.start();

  adapter.onMessage(async (msg) => {
    messages.push(msg);
    if (opts?.autoReply !== false) {
      // Reply on the inbound serviceUrl (the real reply path threads it in extra).
      const serviceUrl = msg.metadata.serviceUrl as string | undefined;
      await adapter.sendMessage(msg.channelId, `echo: ${msg.text}`, {
        extra: serviceUrl !== undefined ? { serviceUrl } : {},
      });
    }
  });
  adapter.onReaction((r) => {
    reactions.push(r);
  });

  const validate = createActivityJwtValidator({
    jwks: createLocalJWKSet(
      emu.publicJwks() as unknown as Parameters<typeof createLocalJWKSet>[0],
    ),
  });
  const ingress = createMsTeamsIngress({
    validateActivityJwt: (authHeader) => validate(authHeader, emu.appId),
    handleWebhookEvents: (activities) =>
      adapter.handleWebhookEvents(activities as TeamsActivity[]),
    logger,
  });

  return { emu, adapter, ingress, messages, reactions, store };
}

/** POST a signed activity to the ingress Hono app (the inbound push). */
async function pushSigned(
  stack: Stack,
  activity: unknown,
  opts?: { tokenOverride?: string; omitAuth?: boolean },
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts?.omitAuth !== true) {
    const token = opts?.tokenOverride ?? (await stack.emu.signInboundToken());
    headers.authorization = `Bearer ${token}`;
  }
  return stack.ingress.request("/api/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(activity),
  });
}

/** Poll the emulator's Connector oracle until an outbound lands (or timeout). */
async function waitForOutbound(
  emu: MsTeamsEmulator,
  conversationId: string,
  timeoutMs = 4000,
): Promise<ReturnType<MsTeamsEmulator["outbound"]>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = emu.outbound(conversationId);
    if (out.length > 0) return out;
    await new Promise((r) => setTimeout(r, 20));
  }
  return emu.outbound(conversationId);
}

describe("msteams-emulator scenario — offline inbound→agent→outbound round-trip", () => {
  it("a signed DM activity round-trips to the emulator's Connector oracle (echo reply)", async () => {
    const stack = await buildStack();
    const CONV = "a:dm-roundtrip";
    const res = await pushSigned(
      stack,
      makeMessageActivity({
        fromAadObjectId: "aad-user-1",
        conversationId: CONV,
        text: "hello teams",
      }),
    );
    // A message activity gets the bare 202 fast-ack.
    expect(res.status).toBe(202);
    // The inbound reached the real adapter's normalized pipeline.
    const out = await waitForOutbound(stack.emu, CONV);
    expect(stack.messages).toHaveLength(1);
    expect(stack.messages[0]?.text).toBe("hello teams");
    // The agent's reply landed on the fake Connector with the exact wire text.
    expect(out).toHaveLength(1);
    expect(out[0]?.op).toBe("send");
    expect(out[0]?.text).toBe("echo: hello teams");
    // The client-credentials token mint ran (proves the full outbound auth path).
    expect(stack.emu.tokenMintCount()).toBeGreaterThan(0);
    // The inbound capture populated the conversation store (proactive-send seam).
    expect(stack.store.size()).toBe(1);
  });

  it("captures the reference so a PROACTIVE send (no inbound serviceUrl) resolves from the store", async () => {
    const stack = await buildStack({ autoReply: false });
    const CONV = "a:dm-proactive";
    await pushSigned(
      stack,
      makeMessageActivity({
        fromAadObjectId: "aad-user-1",
        conversationId: CONV,
        text: "capture me",
      }),
    );
    // Wait for the inbound to be captured.
    const deadline = Date.now() + 2000;
    while (stack.store.size() === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // A proactive send with NO extra.serviceUrl recovers the stored reference.
    const sent = await stack.adapter.sendMessage(CONV, "proactive ping");
    expect(sent.ok).toBe(true);
    const out = stack.emu.outbound(CONV);
    expect(out.some((o) => o.text === "proactive ping")).toBe(true);
  });

  it("delivers an inbound reaction to the reaction handler", async () => {
    const stack = await buildStack();
    const CONV = "a:dm-reaction";
    const res = await pushSigned(
      stack,
      makeReactionActivity({
        fromAadObjectId: "aad-user-1",
        conversationId: CONV,
        reactionType: "like",
        targetActivityId: "bot-activity-1",
      }),
    );
    expect(res.status).toBe(202);
    const deadline = Date.now() + 2000;
    while (stack.reactions.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(stack.reactions).toHaveLength(1);
    expect(stack.reactions[0]?.emoji).toBe("👍");
  });
});

describe("msteams-emulator scenario — security gates (unchanged in the emulator setup)", () => {
  it("rejects an inbound activity with NO bearer token (401, no dispatch)", async () => {
    const stack = await buildStack();
    const res = await pushSigned(
      stack,
      makeMessageActivity({ fromAadObjectId: "u", conversationId: "a:noauth", text: "x" }),
      { omitAuth: true },
    );
    expect(res.status).toBe(401);
    expect(stack.messages).toHaveLength(0);
  });

  it("rejects an inbound activity with a FORGED/garbage bearer token (401)", async () => {
    const stack = await buildStack();
    const res = await pushSigned(
      stack,
      makeMessageActivity({ fromAadObjectId: "u", conversationId: "a:forged", text: "x" }),
      { tokenOverride: "not-a-real-jwt" },
    );
    expect(res.status).toBe(401);
    expect(stack.messages).toHaveLength(0);
  });

  it("drops a non-allowlisted sender in allowMode:allowlist (no outbound)", async () => {
    const stack = await buildStack({ allowMode: "allowlist", allowFrom: ["someone-else"] });
    const CONV = "a:dm-drop";
    const res = await pushSigned(
      stack,
      makeMessageActivity({
        fromAadObjectId: "not-allowlisted",
        conversationId: CONV,
        text: "let me in",
      }),
    );
    // The ingress still acks (auth passed); the adapter drops at the allowlist gate.
    expect(res.status).toBe(202);
    // Give any async dispatch a beat, then assert nothing was delivered or sent.
    await new Promise((r) => setTimeout(r, 200));
    expect(stack.messages).toHaveLength(0);
    expect(stack.emu.outbound(CONV)).toHaveLength(0);
  });

  it("isSafeServiceUrl still REJECTS a non-Connector host (the SSRF gate is intact)", async () => {
    const stack = await buildStack();
    // A reply targeting a hostile serviceUrl must be blocked BEFORE any token mint
    // or fetch — the emulator setup does not relax the host allowlist.
    const sent = await stack.adapter.sendMessage("a:evil", "leak", {
      extra: { serviceUrl: "https://evil.example/" },
    });
    expect(sent.ok).toBe(false);
    expect(stack.emu.outbound("a:evil")).toHaveLength(0);
  });

  it("acks a lone card-action invoke with a 200 InvokeResponse and default-denies an arbitrary verb", async () => {
    const stack = await buildStack();
    const res = await pushSigned(
      stack,
      makeCardActionInvoke({
        fromAadObjectId: "aad-approver",
        conversationId: "a:invoke",
        // An arbitrary verb the bot never rendered — the default-deny drop path.
        verb: "attacker.arbitrary.verb",
      }),
    );
    // The ingress returns the synchronous 200 AdaptiveCardInvokeResponse for a lone invoke.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type?: string };
    expect(body.type).toBe("application/vnd.microsoft.activity.message");
    // The arbitrary verb is not in the rendered set → the card action is dropped
    // (default-deny), so nothing reaches onMessage and nothing is sent.
    await new Promise((r) => setTimeout(r, 150));
    expect(stack.messages).toHaveLength(0);
    expect(stack.emu.outbound("a:invoke")).toHaveLength(0);
  });
});
