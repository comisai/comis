// SPDX-License-Identifier: Apache-2.0
/**
 * RED-first tests for {@link wrapOutwardSend} — the three-state outward-send
 * ledger wrapper (Phase 216, ONCE-01/02/04).
 *
 * The wrap sits AFTER enforceOutwardQuota at the message.send/reply/react site
 * and turns an irreversible platform call into an exactly-once side effect:
 *   begin (send_attempt_started) → markUnknown (unknown_after_send) → doSend →
 *   commit(platformMessageId).
 *
 * These tests assert the call ORDER, the committed-replay no-op (ONCE-02), the
 * begin-collision "already in flight" (no double send), the permanent-error
 * markFailed-without-retry (ONCE-04), the transient leave-unknown-for-recovery,
 * the content-free digest (no body reaches the ledger, T-216-03), and the two
 * pass-through guards (no rootRunId; no outwardStepIndex — HIGH-1: never default
 * a missing index to 0).
 *
 * @module
 */

import { describe, it, expect, vi } from "vitest";
import { ok, err, type Result } from "@comis/shared";
import type {
  OutwardSendLedgerPort,
  OutwardSendRecord,
  OutwardSendBeginInput,
} from "@comis/core";
import { wrapOutwardSend } from "./outward-ledger-wrap.js";

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
  }> = {},
): { ledger: OutwardSendLedgerPort; calls: string[]; readonly beginInput: OutwardSendBeginInput | undefined } {
  const calls: string[] = [];
  const state = { beginInput: undefined as OutwardSendBeginInput | undefined };
  const ledger: OutwardSendLedgerPort = {
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
      return ok(undefined);
    }),
    commit: vi.fn(async () => {
      calls.push("commit");
      return ok(undefined);
    }),
    markFailed: vi.fn(async () => {
      calls.push("markFailed");
      return ok(undefined);
    }),
    resolveReconcile: vi.fn(async () => ok(undefined)),
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
  text: "hello world",
};

function committedRow(platformMessageId: string | undefined): OutwardSendRecord {
  return {
    id: "root-1:0",
    rootRunId: "root-1",
    stepIndex: 0,
    agentId: "agent-1",
    channelType: "telegram",
    channelId: "chat-1",
    state: "committed",
    platformMessageId,
    contentDigest: "deadbeef",
    attemptCount: 1,
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
    // begin BEFORE markUnknown BEFORE doSend BEFORE commit (ONCE-01 ordering).
    expect(calls).toEqual(["lookup", "begin", "markUnknown", "doSend", "commit"]);
    expect(doSend).toHaveBeenCalledTimes(1);
  });

  it("ONCE-02 committed replay → no-op: doSend is NEVER called and the prior platformMessageId is returned", async () => {
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

  it("ONCE-02 begin-collision (UNIQUE) → already-in-flight: doSend is NOT called (no double send)", async () => {
    const { ledger, calls } = makeStubLedger({
      lookupResult: ok(undefined),
      beginResult: err(new Error("UNIQUE constraint failed: outward_send_ledger.root_run_id")),
    });
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return ok({ messageId: "SHOULD-NOT-HAPPEN" });
    });

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    // A concurrent/duplicate begin means another attempt owns this send — treat
    // as already-in-flight, return ok WITHOUT issuing a second platform call.
    expect(result.ok).toBe(true);
    expect(doSend).not.toHaveBeenCalled();
    expect(calls).toEqual(["lookup", "begin"]); // begin attempted, then bail — no doSend
    expect(ledger.markUnknown).not.toHaveBeenCalled();
  });

  it("ONCE-04 permanent error → markFailed and NO retry (the wrap does not loop)", async () => {
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

  it("transient error → row stays unknown_after_send (NOT committed, NOT failed) for recovery to reconcile", async () => {
    const { ledger, calls } = makeStubLedger();
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => {
      calls.push("doSend");
      return err(new Error("ETIMEDOUT: socket hang up"));
    });

    const result = await wrapOutwardSend({ ledger, ...BASE, doSend, logger: makeLogger() });

    expect(result.ok).toBe(false);
    // The row is left in unknown_after_send: recovery (Plan 04) reconciles it.
    expect(ledger.commit).not.toHaveBeenCalled();
    expect(ledger.markFailed).not.toHaveBeenCalled();
    expect(calls).toEqual(["lookup", "begin", "markUnknown", "doSend"]);
  });

  it("content-free: the contentDigest is the sha256 slice of the text and the raw text is NEVER passed to any ledger method (T-216-03)", async () => {
    const stub = makeStubLedger();
    const text = "secret message body that must not be persisted";
    const doSend = vi.fn(async (): Promise<Result<{ messageId: string }, Error>> => ok({ messageId: "m1" }));

    await wrapOutwardSend({ ledger: stub.ledger, ...BASE, text, doSend, logger: makeLogger() });

    // The digest is a sha256 16-char hex slice, not the body.
    const input = stub.beginInput;
    expect(input).toBeDefined();
    expect(input!.contentDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(input!.contentDigest).not.toContain("secret");
    // No begin input field carries the raw text/body.
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain("secret message body");
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

  it("no outwardStepIndex → pass-through (HIGH-1): doSend once, ledger untouched — it does NOT default to index 0", async () => {
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
});
