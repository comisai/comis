// SPDX-License-Identifier: Apache-2.0
/**
 * Echo activity renderer (the "TestSink" strategy).
 *
 * Echo is the thinnest channel: its renderer is the canonical-stream recorder.
 * It wraps `createTestSink()` verbatim — every `apply(frame)` is captured with
 * NO coalescing and `finalize(outcome)` is stored. There is no render-actions
 * adapter and zero platform I/O (`canEdit:false`, `canDelete:false`), so Echo
 * needs no `ChannelPort` and no `TimerPort`/`ClockPort`.
 *
 * This is the reference shape the 4 EditPlace channels build against:
 * a `create<Ch>ActivityRenderer()` factory that returns a `ChannelActivityRenderer`.
 */
import { createTestSink, type TestSinkRecorder } from "../shared/strategies/test-sink.js";

/**
 * Create the Echo activity renderer — a {@link createTestSink} recorder. The
 * returned recorder exposes `recorded.frames` / `recorded.outcome` so the Echo
 * golden fixtures can assert the captured canonical stream.
 */
export function createEchoActivityRenderer(): TestSinkRecorder {
  return createTestSink();
}
