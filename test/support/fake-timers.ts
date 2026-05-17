// SPDX-License-Identifier: Apache-2.0
/**
 * FakeTimers: a per-test TimerPort with deterministic advance(ms) and
 * unref() recording for shutdown assertions.
 *
 * Records every scheduled timer entry so the daemon-shutdown integration
 * test can assert "every long-running interval registered before bootstrap
 * shutdown was either cancelled or unref'd".
 *
 * Mirrors the createSystemTimers cancel-safety contract:
 *   - unref() on cancelled = no-op
 *   - unref() twice = no-op
 *   - cancel() twice = no-op
 *
 * @module
 */
import type { TimerPort, TimerHandle } from "@comis/core";

export interface FakeTimerEntry {
  readonly id: number;
  readonly kind: "timeout" | "interval";
  readonly delay: number;
  readonly cancelled: boolean;
  readonly unrefCalled: boolean;
  readonly registeredAt: number;
}

export interface FakeTimers extends TimerPort {
  /** Move synthetic time forward, firing scheduled callbacks whose deadline passed. */
  advance(ms: number): void;
  /** Snapshot of all scheduled entries with cancel/unref state. */
  unrefRecord(): ReadonlyArray<FakeTimerEntry>;
}

interface InternalEntry {
  id: number;
  kind: "timeout" | "interval";
  delay: number;
  fireAt: number;
  callback: () => void;
  cancelled: boolean;
  unrefCalled: boolean;
  registeredAt: number;
}

export function createFakeTimers(initialMs = 0): FakeTimers {
  let now = initialMs;
  let nextId = 1;
  const entries: InternalEntry[] = [];

  function makeHandle(entry: InternalEntry): TimerHandle {
    return {
      get cancelled() {
        return entry.cancelled;
      },
      cancel() {
        if (entry.cancelled) return;
        entry.cancelled = true;
      },
      unref() {
        if (entry.cancelled || entry.unrefCalled) return;
        entry.unrefCalled = true;
      },
    };
  }

  function setTimeout_(cb: () => void, ms: number): TimerHandle {
    const entry: InternalEntry = {
      id: nextId++,
      kind: "timeout",
      delay: ms,
      fireAt: now + ms,
      callback: cb,
      cancelled: false,
      unrefCalled: false,
      registeredAt: now,
    };
    entries.push(entry);
    return makeHandle(entry);
  }

  function setInterval_(cb: () => void, ms: number): TimerHandle {
    const entry: InternalEntry = {
      id: nextId++,
      kind: "interval",
      delay: ms,
      fireAt: now + ms,
      callback: cb,
      cancelled: false,
      unrefCalled: false,
      registeredAt: now,
    };
    entries.push(entry);
    return makeHandle(entry);
  }

  function advance(ms: number): void {
    const target = now + ms;
    // Loop because interval re-arms may add fires within the advance window.
    let safety = 0;
    while (safety++ < 10_000) {
      const next = entries
        .filter((e) => !e.cancelled && e.fireAt <= target)
        .sort((a, b) => a.fireAt - b.fireAt)[0];
      if (!next) break;
      now = next.fireAt;
      // Re-arm interval before firing so a cancel() inside the callback wins.
      if (next.kind === "interval") {
        next.fireAt = now + next.delay;
      } else {
        next.cancelled = true; // one-shot
      }
      try {
        next.callback();
      } catch {
        // swallow — production code is expected to not throw out of timer callbacks
      }
    }
    now = target;
  }

  function unrefRecord(): ReadonlyArray<FakeTimerEntry> {
    return entries.map((e) => ({
      id: e.id,
      kind: e.kind,
      delay: e.delay,
      cancelled: e.cancelled,
      unrefCalled: e.unrefCalled,
      registeredAt: e.registeredAt,
    }));
  }

  return {
    setTimeout: setTimeout_,
    setInterval: setInterval_,
    advance,
    unrefRecord,
  };
}
