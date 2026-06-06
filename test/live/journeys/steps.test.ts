// SPDX-License-Identifier: Apache-2.0
/**
 * E2E-02 Stage-A — step-vocabulary interpreter mapping (no daemon).
 *
 * Asserts every verb maps to the correct backing call on a STUB driver (vi.fn
 * spies). The daemon-bearing echo round-trip is exercised by journey-runner.test.ts
 * (Stage-B). Here we prove the MAPPING is total + correct + tolerant of dummy-key
 * provider errors (skip ≠ fail).
 *
 * TDD: fails until steps.ts exists.
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import { interpretStep, type StepContext, type ConversationDriverLike } from "./steps.js";
import { buildCredentialRegistry } from "../credentials.js";

// ---------------------------------------------------------------------------
// A stub driver implementing only the ConversationDriverLike surface, with spies.
// ---------------------------------------------------------------------------

function makeStubDriver(over?: Partial<Record<keyof ConversationDriverLike, unknown>>): {
  driver: ConversationDriverLike;
  spies: Record<string, ReturnType<typeof vi.fn>>;
} {
  const sentMessages: Array<{ id: string; channelId: string; text: string; timestamp: number }> = [];
  const captured: Array<{ name: string; payload: unknown }> = [];
  const echo = {
    getSentMessages: vi.fn(() => sentMessages),
    injectMessage: vi.fn(async () => {}),
    reset: vi.fn(),
  };
  const spies = {
    sendTurn: vi.fn(async (_t: string) => "stub-reply"),
    sendVoice: vi.fn(async () => {}),
    sendImage: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    capturedEvents: vi.fn(() => captured),
    getEcho: vi.fn(() => echo),
    getDataDir: vi.fn(() => "/tmp/__stub__"),
    ...over,
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;
  const driver = {
    sendTurn: spies.sendTurn,
    sendVoice: spies.sendVoice,
    sendImage: spies.sendImage,
    restart: spies.restart,
    capturedEvents: spies.capturedEvents,
    getEcho: spies.getEcho,
    getDataDir: spies.getDataDir,
  } as unknown as ConversationDriverLike;
  // expose the echo spies for delivery assertions
  (spies as Record<string, unknown>)["echoGetSentMessages"] = echo.getSentMessages;
  (spies as Record<string, unknown>)["echoInjectMessage"] = echo.injectMessage;
  (spies as Record<string, unknown>)["_sentMessages"] = sentMessages as unknown as ReturnType<typeof vi.fn>;
  (spies as Record<string, unknown>)["_captured"] = captured as unknown as ReturnType<typeof vi.fn>;
  return { driver, spies };
}

function makeCtx(driver: ConversationDriverLike): StepContext {
  return {
    driver,
    creds: buildCredentialRegistry(),
    collected: [],
    rubricAnswers: [],
  };
}

describe("interpretStep — input verbs map to driver calls", () => {
  it("send_text → driver.sendTurn(text), records the reply", async () => {
    const { driver, spies } = makeStubDriver();
    const ctx = makeCtx(driver);
    await interpretStep({ verb: "send_text", text: "hello" }, ctx);
    expect(spies.sendTurn).toHaveBeenCalledWith("hello");
    expect(ctx.lastReply).toBe("stub-reply");
    expect(ctx.collected.at(-1)?.status).toBe("ok");
  });

  it("send_text tolerates a thrown provider error (dummy-key Stage-B) — records, does not throw", async () => {
    const { driver, spies } = makeStubDriver({
      sendTurn: vi.fn(async () => {
        throw new Error("agent.execute RPC error 500: provider failed (dummy key)");
      }),
    });
    const ctx = makeCtx(driver);
    await expect(interpretStep({ verb: "send_text", text: "hi" }, ctx)).resolves.toBeUndefined();
    expect(spies.sendTurn).toHaveBeenCalled();
    // tolerated → recorded as a skip-note, NOT a failure
    expect(ctx.collected.at(-1)?.status).toBe("skipped");
  });

  it("new_session → driver.restart()", async () => {
    const { driver, spies } = makeStubDriver();
    await interpretStep({ verb: "new_session" }, makeCtx(driver));
    expect(spies.restart).toHaveBeenCalledOnce();
  });

  it("send_voice → driver.sendVoice(audioBase64, mimeType?)", async () => {
    const { driver, spies } = makeStubDriver();
    await interpretStep({ verb: "send_voice", audioBase64: "AAA", mimeType: "audio/ogg" }, makeCtx(driver));
    expect(spies.sendVoice).toHaveBeenCalledWith("AAA", "audio/ogg");
  });

  it("send_image → driver.sendImage(imageBase64, mimeType?)", async () => {
    const { driver, spies } = makeStubDriver();
    await interpretStep({ verb: "send_image", imageBase64: "BBB" }, makeCtx(driver));
    expect(spies.sendImage).toHaveBeenCalledWith("BBB", undefined);
  });

  it("upload_doc → driver.getEcho().injectMessage with a type:'file' attachment (no sendDoc method invented)", async () => {
    const { driver, spies } = makeStubDriver();
    await interpretStep(
      { verb: "upload_doc", docBase64: "CCC", mimeType: "application/pdf", filename: "a.pdf" },
      makeCtx(driver),
    );
    const inject = (spies as Record<string, unknown>)["echoInjectMessage"] as ReturnType<typeof vi.fn>;
    expect(inject).toHaveBeenCalledOnce();
    const msg = inject.mock.calls[0][0] as { attachments: Array<{ type: string }> };
    expect(msg.attachments[0].type).toBe("file");
  });
});

describe("interpretStep — expect verbs assert against captured state", () => {
  it("expect_event PASSES when the event is present", async () => {
    const { driver, spies } = makeStubDriver();
    const captured = (spies as Record<string, unknown>)["_captured"] as unknown as Array<{ name: string; payload: unknown }>;
    captured.push({ name: "graph:completed", payload: { graphId: "g1" } });
    await expect(
      interpretStep({ verb: "expect_event", name: "graph:completed" }, makeCtx(driver)),
    ).resolves.toBeUndefined();
  });

  it("expect_event FAILS (records a failed step) when the event is absent — a real assertion, not a no-op", async () => {
    const { driver } = makeStubDriver();
    const ctx = makeCtx(driver);
    await interpretStep({ verb: "expect_event", name: "graph:completed" }, ctx);
    expect(ctx.collected.at(-1)?.status).toBe("failed");
  });

  it("expect_delivered PASSES when a message was delivered", async () => {
    const { driver, spies } = makeStubDriver();
    const sent = (spies as Record<string, unknown>)["_sentMessages"] as unknown as Array<{ id: string; channelId: string; text: string; timestamp: number }>;
    sent.push({ id: "m1", channelId: "echo", text: "done", timestamp: Date.now() });
    const ctx = makeCtx(driver);
    await interpretStep({ verb: "expect_delivered" }, ctx);
    expect(ctx.collected.at(-1)?.status).toBe("ok");
  });

  it("expect_delivered FAILS (records a failed step) when nothing was delivered", async () => {
    const { driver } = makeStubDriver();
    const ctx = makeCtx(driver);
    await interpretStep({ verb: "expect_delivered" }, ctx);
    expect(ctx.collected.at(-1)?.status).toBe("failed");
  });
});

describe("interpretStep — judge + Stage-D-gated verbs skip (never fail) in sandbox", () => {
  it("judge → judgeAnswer; a keyless skip is recorded as 'skipped', not a failure", async () => {
    const { driver } = makeStubDriver();
    const ctx = makeCtx(driver);
    ctx.lastReply = "some answer";
    await expect(
      interpretStep({ verb: "judge", rubric: "the goal was achieved" }, ctx),
    ).resolves.toBeUndefined();
    // keyless → judgeAnswer returns {verdict:"skip"} → step recorded skipped
    expect(ctx.collected.at(-1)?.status).toBe("skipped");
  });

  it("expect_memory_recalled is Stage-D-gated → skip note in sandbox (no live recall)", async () => {
    const { driver } = makeStubDriver();
    const ctx = makeCtx(driver);
    await interpretStep({ verb: "expect_memory_recalled", query: "what about X", mustRecall: ["X"] }, ctx);
    expect(ctx.collected.at(-1)?.status).toBe("skipped");
  });

  it("expect_image is Stage-D world-state → skip note in sandbox", async () => {
    const { driver } = makeStubDriver();
    const ctx = makeCtx(driver);
    await interpretStep({ verb: "expect_image" }, ctx);
    expect(ctx.collected.at(-1)?.status).toBe("skipped");
  });

  it("wait_reply records ok when a reply is present", async () => {
    const { driver } = makeStubDriver();
    const ctx = makeCtx(driver);
    ctx.lastReply = "a reply";
    await interpretStep({ verb: "wait_reply" }, ctx);
    expect(ctx.collected.at(-1)?.status).toBe("ok");
  });
});
