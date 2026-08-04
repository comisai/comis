// SPDX-License-Identifier: Apache-2.0
/**
 * A reply is anchored to the message it answers only in group chats — in a 1:1 chat every reply
 * obviously answers the last message, so anchoring would be visual noise.
 *
 * That premise fails when replies do NOT arrive in request order. A turn held at an approval gate
 * can sit for the whole approval timeout; when the gate finally expires, that turn resumes and
 * delivers its outcome AFTER a later turn has already answered. Live: a DM received, in order,
 * "the pipeline is running" → "the pipeline did NOT run, the approval expired" → a full report
 * with real per-node results. The middle message was true of an EARLIER attempt whose approval
 * had expired minutes before; ground truth confirms the pipeline the user was reading about had
 * completed. Read top to bottom, the user is told the work both did and did not happen.
 *
 * This tracker supplies the missing fact — "a newer turn in this session has already
 * delivered" — so the out-of-order reply can be anchored to its own request while ordinary DM
 * replies stay unanchored.
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createTurnOrderTracker } from "./turn-order-tracker.js";

describe("turn order tracker", () => {
  it("reports a turn as current while it is the newest in its session", () => {
    const tracker = createTurnOrderTracker();
    const seq = tracker.noteTurnStarted("s1");

    expect(tracker.isSuperseded("s1", seq)).toBe(false);
  });

  it("reports the earlier turn as superseded once a later one starts", () => {
    const tracker = createTurnOrderTracker();
    const first = tracker.noteTurnStarted("s1");
    tracker.noteTurnStarted("s1");

    // The blocked-on-approval turn: still in flight, but no longer the turn the user is reading.
    expect(tracker.isSuperseded("s1", first)).toBe(true);
  });

  it("keeps the newest turn current even after several turns start", () => {
    const tracker = createTurnOrderTracker();
    tracker.noteTurnStarted("s1");
    tracker.noteTurnStarted("s1");
    const latest = tracker.noteTurnStarted("s1");

    expect(tracker.isSuperseded("s1", latest)).toBe(false);
  });

  it("scopes ordering per session so unrelated conversations never interfere", () => {
    const tracker = createTurnOrderTracker();
    const inA = tracker.noteTurnStarted("a");
    tracker.noteTurnStarted("b");
    tracker.noteTurnStarted("b");

    // Two turns ran in session b; session a's only turn is still its newest.
    expect(tracker.isSuperseded("a", inA)).toBe(false);
    expect(tracker.isSuperseded("b", inA)).toBe(true);
  });

  it("treats an unknown session as not superseded", () => {
    const tracker = createTurnOrderTracker();

    // Fail-open: without evidence that a newer turn ran, do not anchor. Anchoring a reply that is
    // actually in order would put reply quoting on every DM message, which is the noise the
    // group-only rule exists to avoid.
    expect(tracker.isSuperseded("never-seen", 1)).toBe(false);
  });

  it("evicts the oldest sessions past its cap so a long-lived daemon cannot grow without bound", () => {
    const tracker = createTurnOrderTracker({ maxSessions: 2 });
    const inA = tracker.noteTurnStarted("a");
    tracker.noteTurnStarted("b");
    tracker.noteTurnStarted("c");

    // "a" was evicted, so it reads as not-superseded — the same fail-open as an unknown session.
    // Bounded memory is worth more than perfect recall for a turn already older than the cap.
    expect(tracker.isSuperseded("a", inA)).toBe(false);
    expect(tracker.trackedSessionCount()).toBe(2);
  });

  it("refreshes a session's recency on each new turn so an active chat is not evicted", () => {
    const tracker = createTurnOrderTracker({ maxSessions: 2 });
    const inA = tracker.noteTurnStarted("a");
    tracker.noteTurnStarted("b");
    // "a" is used again — it must outlive "b" when "c" forces an eviction.
    tracker.noteTurnStarted("a");
    tracker.noteTurnStarted("c");

    expect(tracker.isSuperseded("a", inA)).toBe(true);
    expect(tracker.trackedSessionCount()).toBe(2);
  });
});
