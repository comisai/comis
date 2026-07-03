// SPDX-License-Identifier: Apache-2.0
/**
 * withDedup behavior contract.
 *
 * withDedup wraps a ComisLogger so repeated log lines keyed by the same dedup
 * key fire the underlying logger exactly once. The dedup key is derived from a
 * caller-supplied `dedupKey` object field (else the message string) and hashed
 * via the shared fingerprint(). It is the shared per-site dedup primitive
 * (consumers: tool-result-size-bouncer +
 * oauth-token-manager); it lives in @comis/core (NOT @comis/infra) because its
 * consumers are in @comis/agent (agent↛infra).
 *
 * @module
 */
import { describe, it, expect, vi } from "vitest";
import type { ComisLogger } from "./log-fields.js";
import { withDedup } from "./dedup-logger.js";

/**
 * A fake ComisLogger with a vi.fn() per level method, a writable `level`, and a
 * `child()` that returns a fresh fake (so we can prove withDedup re-wraps the
 * child rather than handing back the bare inner child).
 */
function makeFakeLogger(): ComisLogger & {
  trace: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  fatal: ReturnType<typeof vi.fn>;
  audit: ReturnType<typeof vi.fn>;
} {
  let level = "info";
  return {
    get level(): string {
      return level;
    },
    set level(l: string) {
      level = l;
    },
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    audit: vi.fn(),
    child: vi.fn(makeFakeLogger),
  } as never;
}

describe("withDedup", () => {
  it("fires the underlying logger ONCE for 3 identical dedup keys", () => {
    const inner = makeFakeLogger();
    const log = withDedup(inner);

    log.warn({ dedupKey: "tool:abc" }, "Tool result truncated");
    log.warn({ dedupKey: "tool:abc" }, "Tool result truncated");
    log.warn({ dedupKey: "tool:abc" }, "Tool result truncated");

    expect(inner.warn).toHaveBeenCalledTimes(1);
  });

  it("fires AGAIN for a NEW dedup key (distinct entry)", () => {
    const inner = makeFakeLogger();
    const log = withDedup(inner);

    log.warn({ dedupKey: "tool:abc" }, "msg");
    log.warn({ dedupKey: "tool:xyz" }, "msg"); // different key → emits

    expect(inner.warn).toHaveBeenCalledTimes(2);
  });

  it("passes the FIRST occurrence through with the original args unchanged", () => {
    const inner = makeFakeLogger();
    const log = withDedup(inner);

    const obj = { dedupKey: "k1", provider: "anthropic", profileId: "p1" };
    log.info(obj, "OAuth profile resolved via agent config");

    expect(inner.info).toHaveBeenCalledTimes(1);
    expect(inner.info).toHaveBeenCalledWith(obj, "OAuth profile resolved via agent config");
  });

  it("falls back to the MESSAGE STRING as the dedup key when no dedupKey field is present", () => {
    const inner = makeFakeLogger();
    const log = withDedup(inner);

    log.warn({ toolName: "bash" }, "same message");
    log.warn({ toolName: "bash" }, "same message"); // same msg string → suppressed
    log.warn({ toolName: "bash" }, "different message"); // new msg → emits

    expect(inner.warn).toHaveBeenCalledTimes(2);
  });

  it("dedups PER LEVEL — the same key on a different level is a distinct entry", () => {
    const inner = makeFakeLogger();
    const log = withDedup(inner);

    log.warn({ dedupKey: "k" }, "m");
    log.info({ dedupKey: "k" }, "m"); // same key, different level → emits

    expect(inner.warn).toHaveBeenCalledTimes(1);
    expect(inner.info).toHaveBeenCalledTimes(1);
  });

  it("is assignable to ComisLogger (structural: level + 7 methods + child)", () => {
    const inner = makeFakeLogger();
    // Structural assignment assertion: if withDedup's return is not assignable
    // to ComisLogger, this line fails to type-check (and the build/RED fails).
    const log: ComisLogger = withDedup(inner);
    expect(typeof log.level).toBe("string");
    expect(typeof log.trace).toBe("function");
    expect(typeof log.debug).toBe("function");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.fatal).toBe("function");
    expect(typeof log.audit).toBe("function");
    expect(typeof log.child).toBe("function");
  });

  it("exposes a readable AND writable level proxied to the inner logger", () => {
    const inner = makeFakeLogger();
    const log = withDedup(inner);

    expect(log.level).toBe("info");
    log.level = "debug";
    expect(log.level).toBe("debug");
    expect(inner.level).toBe("debug"); // write proxied through
  });

  it("child() returns a withDedup-wrapped child (a deduping logger, NOT the bare inner child)", () => {
    const inner = makeFakeLogger();
    const log = withDedup(inner);

    const child = log.child({ submodule: "x" });
    // The inner child is the fake returned by inner.child — it must NOT be
    // handed back directly; the wrapper re-wraps it so dedup state composes.
    const bareInnerChild = (inner.child as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value as ComisLogger;
    expect(child).not.toBe(bareInnerChild);

    // And the child still suppresses repeats by key.
    child.warn({ dedupKey: "ck" }, "m");
    child.warn({ dedupKey: "ck" }, "m");
    expect((bareInnerChild.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
  });

  it("default (no opts) is process-lifetime — a repeat is NEVER re-emitted within the process", () => {
    const inner = makeFakeLogger();
    const log = withDedup(inner); // no ttlMs

    for (let i = 0; i < 100; i++) {
      log.warn({ dedupKey: "forever" }, "security-relevant warn");
    }
    // First line always fires; all repeats collapsed for the whole process.
    expect(inner.warn).toHaveBeenCalledTimes(1);
  });

  it("with ttlMs: re-emits a repeat after the TTL window elapses (fake clock)", () => {
    vi.useFakeTimers();
    try {
      // systemNowMs reads Date.now(); fake timers control it.
      vi.setSystemTime(0);
      const inner = makeFakeLogger();
      const log = withDedup(inner, { ttlMs: 1000 });

      log.warn({ dedupKey: "ttl" }, "m"); // t=0 → emit
      vi.setSystemTime(500);
      log.warn({ dedupKey: "ttl" }, "m"); // within TTL → suppressed
      expect(inner.warn).toHaveBeenCalledTimes(1);

      vi.setSystemTime(1000);
      log.warn({ dedupKey: "ttl" }, "m"); // TTL elapsed (>=) → re-emit
      expect(inner.warn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
