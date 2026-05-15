// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `setupBackgroundTasks` wiring factory.
 *
 * Asserts deterministic factory output, port-injection contract, and
 * shutdown-handle behavior. Phase 40 / Phase C §6.3.3.
 *
 * Use-case design (§3.3 / COV-10): every `it("...")` description names a
 * use case >=20 chars ending in a recognizable shape.
 *
 * @module
 */

import { describe, it } from "vitest";

// RED: test bodies are intentionally unimplemented (.todo) so the per-commit
// gate (`pnpm build && pnpm test && pnpm lint:security`) stays green while
// the use-case names are pinned. Bodies land in the GREEN commit.

describe("setupBackgroundTasks -- daemon wiring", () => {
  it.todo("creates BackgroundTaskManager with file-based persistence under dataDir/tasks");
  it.todo("registers each background task exactly once (no duplicate on re-call)");
  it.todo("shutdown handle cancels every scheduled timer via TimerHandle.cancel()");
  it.todo("startup recovery is intentionally deferred to the daemon.ts caller (not run here)");
  it.todo("hourly cleanup timer fires under createFakeTimers.advance(3_600_000)");
  it.todo("preserves TimerHandle.unref() semantics on every long-running interval");
});
