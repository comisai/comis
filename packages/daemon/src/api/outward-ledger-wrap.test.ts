// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for {@link wrapOutwardSend} — the closed five-state outward-send
 * ledger wrapper.
 *
 * The wrap sits AFTER enforceOutwardQuota at the message.send/reply/react site
 * and records the committed branch around one irreversible platform call:
 *   begin (send_attempt_started) → markUnknown (unknown_after_send) → doSend →
 *   commit(platformMessageId).
 *
 * These tests assert the call order, the committed-operation short-circuit, the
 * begin-collision "already in flight" block, the permanent-error
 * markFailed-without-retry, the transient uncertainty park,
 * the content-free digest (no body reaches the ledger), and the two
 * pass-through guards (no rootRunId; no outwardStepIndex — never default
 * a missing index to 0).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import { ok, err, type Result } from "@comis/shared";
import type {
  OutwardSendLedgerPort,
  OutwardSendRecord,
  OutwardSendBeginInput,
} from "@comis/core";
import {
  wrapOutwardSend,
  __setOutwardSendCrashHookForTest,
  OUTWARD_SEND_CRASH_SENTINEL,
  type WrapOutwardSendArgs,
} from "./outward-ledger-wrap.js";

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** A no-op logger that records nothing — the wrap must not throw on logging. */
function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => makeLogger()),
  } as unknown as Parameters<typeof wrapOutwardSend>[0]["logger"];
}

/**
 * A stub ledger that records every method call (name) in `calls` so a test can
 * assert call ORDER. Per-method outcomes are overridable. The begin input is
 * captured so the content-free assertion can inspect it.
 */
function makeStubLedger(
  overrides: Partial<{
    lookupResult: Result<OutwardSendRecord | undefined, Error>;
    beginResult: Result<void, Error>;
    markUnknownResult: Result<void, Error>;
    commitResult: Result<void, Error>;
    markFailedResult: Result<void, Error>;
    parkResult: Result<boolean, Error>;
  }> = {},
): { ledger: OutwardSendLedgerPort; calls: string[]; readonly beginInput: OutwardSendBeginInput | undefined } {
  const calls: string[] = [];
  const state = { beginInput: undefined as OutwardSendBeginInput | undefined };
  const ledger: OutwardSendLedgerPort = {
    allocateStep: vi.fn(async () => ok(0)),
    lookup: vi.fn(async () => {
      calls.push("lookup");
      return overrides.lookupResult ?? ok(undefined);
    }),
    begin: vi.fn(async (input: OutwardSendBeginInput) => {
      calls.push("begin");
      state.beginInput = input;
      return overrides.beginResult ?? ok(undefined);
    }),
    markUnknown: vi.fn(async () => {
      calls.push("markUnknown");
      return overrides.markUnknownResult ?? ok(undefined);
    }),
    reclaimPreSend: vi.fn(async () => ok(true)),
    commit: vi.fn(async () => {
      calls.push("commit");
      return overrides.commitResult ?? ok(undefined);
    }),
    markFailed: vi.fn(async () => {
      calls.push("markFailed");
      return overrides.markFailedResult ?? ok(undefined);
    }),
    parkUncertain: vi.fn(async () => {
      calls.push("parkUncertain");
      return overrides.parkResult ?? ok(true);
    }),
    hasUncertainty: vi.fn(async () => ok(false)),
    listUnreconciled: vi.fn(async () => ok([])),
  };
  return {
    ledger,
    calls,
    get beginInput() {
      return state.beginInput;
    },
  };
}

const BASE = {
  rootRunId: "root-1" as string | undefined,
  outwardStepIndex: 0 as number | undefined,
  agentId: "agent-1",
  channelType: "telegram",
  channelId: "chat-1",
  operationKind: "message_send" as const,
  text: "hello world",
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

type FingerprintArgs = Pick<
  WrapOutwardSendArgs,
  | "operationKind"
  | "channelType"
  | "channelId"
  | "targetMessageId"
  | "text"
  | "operationOptions"
>;

function operationFingerprint(overrides: Partial<FingerprintArgs> = {}): string {
  const args = { ...BASE, ...overrides };
  return createHash("sha256")
    .update(JSON.stringify(stableValue({
      kind: args.operationKind,
      channelType: args.channelType,
      channelId: args.channelId,
      targetMessageId: args.targetMessageId ?? null,
      text: args.text,
      options: args.operationOptions ?? null,
    })))
    .digest("hex");
}

function committedRow(
  platformMessageId: string | undefined,
  overrides: Partial<FingerprintArgs> = {},
): OutwardSendRecord {
  const args = { ...BASE, ...overrides };
  return {
    id: "root-1:0",
    rootRunId: "root-1",
    stepIndex: 0,
    agentId: "agent-1",
    channelType: args.channelType,
    channelId: args.channelId,
    state: "committed",
    platformMessageId,
    operationKind: args.operationKind,
    operationFingerprint: operationFingerprint(overrides),
    contentDigest: createHash("sha256").update(args.text).digest("hex"),
    attemptCount: 1,
    attemptedAtMs: 1_000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wrapOutwardSend", () => {
  it("happy path: calls begin → markUnknown → doSend → commit IN THAT ORDER and returns the messageId", async () => {
    const { ledger, calls } = makeStubLedger();
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return ok({ messageId: "platform-msg-99" });
    });

    const result = await wrapOutwardSend({
      ledger,
      ...BASE,
      doSend,
      logger: makeLogger(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messageId).toBe("platform-msg-99");
    // begin BEFORE markUnknown BEFORE doSend BEFORE commit (the required ordering).
    expect(calls).toEqual([
      "lookup",
      "begin",
      "markUnknown",
      "doSend",
      "commit",
    ]);
    expect(doSend).toHaveBeenCalledTimes(1);
  });

  it("a repeated committed operation returns its receipt without another platform call", async () => {
    const { ledger, calls } = makeStubLedger({ lookupResult: ok(committedRow("prior-msg-7")) });
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return ok({ messageId: "SHOULD-NOT-HAPPEN" });
    });

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messageId).toBe("prior-msg-7");
    expect(doSend).not.toHaveBeenCalled();
    expect(calls).toEqual(["lookup"]); // short-circuit: no begin/markUnknown/commit
    expect(ledger.begin).not.toHaveBeenCalled();
  });

  it.each<Array<{ name: string; request: Partial<FingerprintArgs> }>>([
    { name: "changed text", request: { text: "changed" } },
    { name: "changed channel", request: { channelId: "chat-2" } },
    { name: "cross-kind reuse", request: { operationKind: "message_react" } },
  ])("rejects $name under a committed operation identity", async ({ request }) => {
    const { ledger } = makeStubLedger({ lookupResult: ok(committedRow("prior-msg-7")) });
    const doSend = vi.fn(async () => ok({ messageId: "must-not-send" }));

    const result = await wrapOutwardSend({
      ledger,
      ...BASE,
      ...request,
      doSend,
      logger: makeLogger(),
    });

    expect(result.ok).toBe(false);
    expect(doSend).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "reply target",
      request: { targetMessageId: "target-2" },
    },
    {
      name: "rich options",
      request: { operationOptions: { buttons: [{ id: "different" }] } },
    },
  ])("rejects a changed $name under the same reply operation identity", async ({ request }) => {
    const original: Partial<FingerprintArgs> = {
      operationKind: "message_reply",
      targetMessageId: "target-1",
      text: "reply body",
      operationOptions: { buttons: [{ id: "original" }] },
    };
    const { ledger } = makeStubLedger({
      lookupResult: ok(committedRow("reply-1", original)),
    });
    const doSend = vi.fn(async () => ok({ messageId: "must-not-send" }));

    const result = await wrapOutwardSend({
      ledger,
      ...BASE,
      ...original,
      ...request,
      doSend,
      logger: makeLogger(),
    });

    expect(result.ok).toBe(false);
    expect(doSend).not.toHaveBeenCalled();
  });

  it("rejects a corrupt committed row without a real platform receipt", async () => {
    const { ledger } = makeStubLedger({ lookupResult: ok(committedRow(undefined)) });
    const doSend = vi.fn(async () => ok({ messageId: "must-not-send" }));

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    expect(result.ok).toBe(false);
    expect(doSend).not.toHaveBeenCalled();
  });

  it("a begin collision blocks the competing call before it reaches the platform", async () => {
    const { ledger, calls } = makeStubLedger({
      lookupResult: ok(undefined),
      beginResult: err(new Error("UNIQUE constraint failed: outward_send_ledger.root_run_id")),
    });
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return ok({ messageId: "SHOULD-NOT-HAPPEN" });
    });

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    // A failed begin means this process did not durably record ownership. It must
    // not send and must not fabricate an "in-flight" success response.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/UNIQUE constraint failed/);
    expect(doSend).not.toHaveBeenCalled();
    expect(calls).toEqual(["lookup", "begin"]); // begin attempted, then bail — no doSend
    expect(ledger.markUnknown).not.toHaveBeenCalled();
  });

  it("lookup failure blocks the platform call and returns the ledger failure", async () => {
    const lookupError = new Error("sqlite lookup unavailable");
    const { ledger, calls } = makeStubLedger({ lookupResult: err(lookupError) });
    const doSend = vi.fn(async () => ok({ messageId: "must-not-send" }));

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    expect(result).toEqual(err(lookupError));
    expect(doSend).not.toHaveBeenCalled();
    expect(calls).toEqual(["lookup"]);
  });

  it("ledger failures never copy arbitrary error content into logs", async () => {
    const { ledger } = makeStubLedger({
      lookupResult: err(new Error("private-value from a persisted payload")),
    });
    const logger = makeLogger();

    await wrapOutwardSend({
      ledger,
      ...BASE,
      doSend: vi.fn(async () => ok({ messageId: "must-not-send" })),
      logger,
    });

    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("private-value");
  });

  it("markUnknown failure blocks the platform call because the uncertain window was not recorded", async () => {
    const markError = new Error("sqlite markUnknown unavailable");
    const { ledger, calls } = makeStubLedger({ markUnknownResult: err(markError) });
    const doSend = vi.fn(async () => ok({ messageId: "must-not-send" }));

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    expect(result).toEqual(err(markError));
    expect(doSend).not.toHaveBeenCalled();
    expect(calls).toEqual(["lookup", "begin", "markUnknown"]);
  });

  it("commit failure returns uncertainty after the platform succeeded instead of reporting success", async () => {
    const commitError = new Error("sqlite commit unavailable");
    const { ledger, calls } = makeStubLedger({ commitResult: err(commitError) });
    const doSend = vi.fn(async () => {
      calls.push("doSend");
      return ok({ messageId: "platform-sent-1" });
    });

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    expect(result).toEqual(err(commitError));
    expect(doSend).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      "lookup",
      "begin",
      "markUnknown",
      "doSend",
      "commit",
      "parkUncertain",
    ]);
  });

  it("markFailed persistence failure is surfaced instead of hiding an unrecorded terminal state", async () => {
    const ledgerError = new Error("sqlite markFailed unavailable");
    const { ledger, calls } = makeStubLedger({ markFailedResult: err(ledgerError) });
    const doSend = vi.fn(async () => {
      calls.push("doSend");
      return err(new Error("Bad Request: chat not found"));
    });

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    expect(result).toEqual(err(ledgerError));
    expect(calls).toEqual([
      "lookup",
      "begin",
      "markUnknown",
      "doSend",
      "markFailed",
      "parkUncertain",
    ]);
  });

  it("permanent error → markFailed and NO retry (the wrap does not loop)", async () => {
    const { ledger, calls } = makeStubLedger();
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return err(new Error("Bad Request: chat not found"));
    });

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    expect(result.ok).toBe(false);
    expect(ledger.markFailed).toHaveBeenCalledTimes(1);
    expect(ledger.commit).not.toHaveBeenCalled();
    // doSend called exactly once — no retry loop.
    expect(doSend).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["lookup", "begin", "markUnknown", "doSend", "markFailed"]);
  });

  it("transient error → row is atomically parked unresolved for manual verification", async () => {
    const { ledger, calls } = makeStubLedger();
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return err(new Error("ETIMEDOUT: socket hang up"));
    });

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    expect(result.ok).toBe(false);
    expect(ledger.commit).not.toHaveBeenCalled();
    expect(ledger.markFailed).not.toHaveBeenCalled();
    expect(ledger.parkUncertain).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["lookup", "begin", "markUnknown", "doSend", "parkUncertain"]);
  });

  it("content-free: the contentDigest is the full SHA-256 of the text and the raw text is NEVER passed to any ledger method", async () => {
    const stub = makeStubLedger();
    const text = "secret message body that must not be persisted";
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => ok({ messageId: "m1" }));

    await wrapOutwardSend({ ledger: stub.ledger, ...BASE, text, doSend, logger: makeLogger() });

    // The digest is the full 64-hex SHA-256, not a collision-prone slice.
    const input = stub.beginInput;
    expect(input).toBeDefined();
    expect(input!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(input!.contentDigest).toBe(createHash("sha256").update(text).digest("hex"));
    expect(input!.contentDigest).not.toContain("secret");
    expect(input!.operationKind).toBe("message_send");
    expect(input!.operationFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // No begin input field carries the raw text/body.
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("secret message body");
  });

  it("uses distinct full-length operation and content digests for distinct messages", async () => {
    const first = makeStubLedger();
    const second = makeStubLedger();
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> =>
      ok({ messageId: "m1" }),
    );

    await wrapOutwardSend({ ledger: first.ledger, ...BASE, text: "message-a", doSend, logger: makeLogger() });
    await wrapOutwardSend({ ledger: second.ledger, ...BASE, text: "message-b", doSend, logger: makeLogger() });

    expect(first.beginInput?.contentDigest).toHaveLength(64);
    expect(second.beginInput?.contentDigest).toHaveLength(64);
    expect(first.beginInput?.contentDigest).not.toBe(second.beginInput?.contentDigest);
    expect(first.beginInput?.operationFingerprint).not.toBe(
      second.beginInput?.operationFingerprint,
    );
  });

  it("parks a successful call that returned no real platform receipt", async () => {
    const { ledger, calls } = makeStubLedger();
    const doSend = vi.fn(async () => {
      calls.push("doSend");
      return ok({ messageId: "" });
    });

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    expect(result.ok).toBe(false);
    expect(ledger.commit).not.toHaveBeenCalled();
    expect(ledger.parkUncertain).toHaveBeenCalledTimes(1);
  });

  it("no rootRunId → pass-through: doSend is called directly and the ledger is touched ZERO times", async () => {
    const { ledger, calls } = makeStubLedger();
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return ok({ messageId: "direct-1" });
    });

    const result = await wrapOutwardSend({
      ledger,
      ...BASE,
      rootRunId: undefined,
      doSend,
      logger: makeLogger(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messageId).toBe("direct-1");
    expect(doSend).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["doSend"]); // ledger NEVER consulted
    expect(ledger.lookup).not.toHaveBeenCalled();
    expect(ledger.begin).not.toHaveBeenCalled();
  });

  it("no outwardStepIndex → pass-through: doSend once, ledger untouched — it does NOT default to index 0", async () => {
    const { ledger, calls } = makeStubLedger();
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return ok({ messageId: "direct-2" });
    });

    const result = await wrapOutwardSend({
      ledger,
      ...BASE,
      outwardStepIndex: undefined, // absent index — MUST be a pass-through, NOT stepIndex 0
      doSend,
      logger: makeLogger(),
    });

    expect(result.ok).toBe(true);
    expect(doSend).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["doSend"]); // never reached lookup/begin at index 0
    expect(ledger.lookup).not.toHaveBeenCalled();
    expect(ledger.begin).not.toHaveBeenCalled();
  });

  it("ledger undefined → pass-through: doSend is called directly (older/non-autonomy daemon)", async () => {
    const calls: string[] = [];
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return ok({ messageId: "direct-3" });
    });

    const result = await wrapOutwardSend({
      ledger: undefined,
      ...BASE,
      doSend,
      logger: makeLogger(),
    });

    expect(result.ok).toBe(true);
    expect(doSend).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["doSend"]);
  });

  // -------------------------------------------------------------------------
  // Test-only crash hook: the uncertainty-recovery chaos test arms this seam in
  // the crash window (between markUnknown and commit), leaving a real
  // unknown_after_send row from the production path.
  // -------------------------------------------------------------------------

  it("crash hook 'before_send' leaves unknown_after_send without calling the platform", async () => {
    const { ledger, calls } = makeStubLedger();
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return ok({ messageId: "SHOULD-NOT-HAPPEN" });
    });
    __setOutwardSendCrashHookForTest("before_send");
    try {
      await expect(
        wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() }),
      ).rejects.toThrow(OUTWARD_SEND_CRASH_SENTINEL);
    } finally {
      __setOutwardSendCrashHookForTest(undefined);
    }
    // markUnknown ran (the durable row exists) but doSend never fired (the
    // platform never recorded it) and commit was never reached.
    expect(calls).toEqual(["lookup", "begin", "markUnknown"]);
    expect(doSend).not.toHaveBeenCalled();
    expect(ledger.commit).not.toHaveBeenCalled();
  });

  it("crash hook 'after_send' leaves unknown_after_send after the platform call but before commit", async () => {
    const { ledger, calls } = makeStubLedger();
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return ok({ messageId: "platform-recorded-it" });
    });
    __setOutwardSendCrashHookForTest("after_send");
    try {
      await expect(
        wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() }),
      ).rejects.toThrow(OUTWARD_SEND_CRASH_SENTINEL);
    } finally {
      __setOutwardSendCrashHookForTest(undefined);
    }
    // The platform call DID happen (Echo would have recorded it) but commit was
    // never reached — recovery must park this exact crash window as unresolved.
    expect(calls).toEqual(["lookup", "begin", "markUnknown", "doSend"]);
    expect(doSend).toHaveBeenCalledTimes(1);
    expect(ledger.commit).not.toHaveBeenCalled();
  });

  it("crash hook disarmed (undefined) → normal commit path (the production default, INERT)", async () => {
    __setOutwardSendCrashHookForTest(undefined);
    const { ledger, calls } = makeStubLedger();
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return ok({ messageId: "normal-99" });
    });

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.messageId).toBe("normal-99");
    expect(calls).toEqual(["lookup", "begin", "markUnknown", "doSend", "commit"]);
  });
});
