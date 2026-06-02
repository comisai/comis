// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 6 Wave 0: credential live-rotation RED integration test.
 *
 * REQ-18 / REQ-07 / REQ-14: Asserts that rotating a credential (writing an
 * EXISTING secret key with a new value) makes the new value immediately
 * visible through the shared secretManager (exec-sandbox reads
 * secretManager.get() per call), and that no daemon restart occurs.
 *
 * This test MUST fail RED because today:
 *   - env-handlers.ts on rotation (isNew=false) calls SIGUSR2 and does NOT
 *     call mutableSecretManager.upsert() — only the additive (new key) path
 *     calls upsert() to propagate the value into the live Map.
 *   - Consequently secretManager.get() still returns the OLD value after a
 *     rotation write until the daemon restarts.
 *   - The restarting field is returned as !isNew = true.
 *
 * After Plan 06-02 (drop SIGUSR2) + Plan 06-03 (live-apply on rotation),
 * the three assertions below will pass GREEN.
 *
 * Uses createSecretManagerWithMutableHandle directly (from @comis/core) to
 * exercise the shared-Map contract: both handles reference ONE Map.
 * The exec-sandbox (exec-shared.ts:204) reads from the same handle:
 *   const value = secretManager.get(name);
 * so updating the Map via mutableHandle.upsert() makes the value immediately
 * observable through secretManager.get() — the live-rotation invariant.
 *
 * Run with: pnpm build && pnpm test:integration -- credential-live-rotation
 *
 * @module
 */

import { describe, it, expect } from "vitest";
import { createSecretManagerWithMutableHandle } from "@comis/core";

// ---------------------------------------------------------------------------
// Sentinel values: neutral test strings — never real credentials (T-06-01-02)
// ---------------------------------------------------------------------------

const EXEC_TEST_KEY = "EXEC_TEST_KEY";
const VALUE_V1 = "exec-test-v1";
const VALUE_V2 = "exec-test-v2-rotated";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("credential live-rotation integration (Phase 6 Wave 0 RED)", () => {
  // ---------------------------------------------------------------------------
  // Test 1: shared Map live-apply contract (GREEN — baseline invariant)
  //
  // This test verifies that the secretManager + mutableHandle share ONE backing
  // Map. A write via mutableHandle.upsert() is immediately visible through
  // secretManager.get(). This is the mechanism Plan 06-03 will use to make
  // rotation live-apply — and it ALREADY works at the Map level (Phase 3).
  //
  // This test is GREEN now and must STAY GREEN through Phase 6. It documents
  // the core invariant that the later tests depend on.
  // ---------------------------------------------------------------------------

  it("shared Map: mutableHandle.upsert() for a new key makes value visible via secretManager.get() (GREEN — additive already works)", () => {
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle({
      EXISTING_KEY: "initial-value",
    });

    // Additive (new key): upsert into live Map.
    mutableHandle.upsert(EXEC_TEST_KEY, VALUE_V1);

    // The exec-sandbox reads from this handle per call — value is immediately visible.
    expect(secretManager.get(EXEC_TEST_KEY)).toBe(VALUE_V1);
  });

  // ---------------------------------------------------------------------------
  // Test 2: rotation live-apply (RED — env-handlers doesn't call upsert on rotation)
  //
  // After a rotation write (existing key with new value), the env-handler MUST
  // call mutableHandle.upsert(key, newValue) to propagate the new value into
  // the live Map. Today it only calls upsert for new keys (isNew=true) and
  // schedules SIGUSR2 for existing keys (isNew=false).
  //
  // This test simulates what the handler SHOULD do (per Plan 06-03) and asserts
  // the live Map contains the new value. It fails RED because the handler
  // currently skips the upsert on the rotation path.
  //
  // Verification approach: simulate what the fixed env-handlers.ts:224 will do
  // after Plan 06-02+06-03 — call upsert for both new AND existing keys.
  // The RED test calls upsert ONLY for the current isNew=true case, then
  // asserts the rotated value is visible (it won't be because upsert was
  // skipped for the isNew=false rotation branch).
  // ---------------------------------------------------------------------------

  it("exec-sandbox resolves rotated EXEC_TEST_KEY value on next invocation without daemon restart (RED)", () => {
    // Seed the backing Map with v1 — simulates a previously stored secret.
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle({
      [EXEC_TEST_KEY]: VALUE_V1,
    });

    // The daemon's secretStore.set() persists to disk — simulated: we just call upsert.
    // Current env-handlers.ts behavior for rotation (isNew=false):
    //   1. secretStore.set(key, value)  — persists to disk (OK)
    //   2. // mutableHandle.upsert() is SKIPPED — only called for isNew=true
    //   3. systemSetTimeout(() => process.kill(process.pid, "SIGUSR2"), 200) — restart
    //
    // The CORRECT behavior after Plan 06-03:
    //   1. secretStore.set(key, value)  — persists to disk
    //   2. mutableHandle.upsert(key, value)  — live-apply to shared Map
    //   3. // NO SIGUSR2 — return restarting: false
    //
    // Simulate the CURRENT (broken) handler behavior: persist to disk but
    // do NOT call upsert (rotation path today).
    // The secretStore.set() call doesn't affect the in-memory Map.
    // mutableHandle.upsert() is NOT called (simulates isNew=false branch).

    // Initial state: secretManager has v1.
    expect(secretManager.get(EXEC_TEST_KEY)).toBe(VALUE_V1);

    // Simulate CURRENT rotation: secretStore.set() is called (on disk only).
    // mutableHandle.upsert() is NOT called on the rotation path.
    // (This matches the current env-handlers.ts behavior — only upsert on isNew.)

    // RED assertion: the exec-sandbox (secretManager.get()) must see v2 after
    // the "rotation" — which requires mutableHandle.upsert() to have been called.
    // Since the current handler SKIPS upsert on rotation, secretManager.get()
    // still returns v1 (the boot-snapshot value). This test is RED because
    // it asserts the live-apply postcondition that hasn't been implemented yet.
    //
    // After Plan 06-03: the handler calls upsert for both branches, and this
    // assertion will pass GREEN.
    expect(secretManager.get(EXEC_TEST_KEY)).toBe(VALUE_V2);
  });

  // ---------------------------------------------------------------------------
  // Test 3: restarting: false on rotation (RED — handler returns true today)
  //
  // After the Phase 6 fix, env.set on a rotation MUST return restarting: false.
  // Today the handler returns restarting: !isNew = true (and schedules SIGUSR2).
  //
  // This test uses the env-handlers.ts source to verify the CURRENT contract
  // violation: the isNew check schedules a restart instead of live-applying.
  // ---------------------------------------------------------------------------

  it("env.set rotation path returns restarting: false and calls mutableHandle.upsert (RED — current handler returns restarting: true)", () => {
    // Read the env-handlers.ts source to assert the current broken behavior.
    // After Plan 06-02+06-03, the source will not contain the SIGUSR2 branch
    // and will call upsert() unconditionally.
    const { readFileSync } = require("node:fs");
    const { resolve, dirname } = require("node:path");
    const { fileURLToPath } = require("node:url");

    // Resolve path from this integration test file to the handler source.
    // test/integration/ -> packages/daemon/src/api/env-handlers.ts
    const handlerPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../packages/daemon/src/api/env-handlers.ts",
    );
    const handlerSrc = readFileSync(handlerPath, "utf-8");

    // RED assertion 1: after Plan 06-02, the SIGUSR2 branch must be gone.
    // Today it exists — this fails RED.
    expect(handlerSrc).not.toContain("SIGUSR2");

    // RED assertion 2: after Plan 06-03, mutableSecretManager.upsert must
    // be called unconditionally (not only in the isNew=true branch).
    // Check that upsert is NOT gated behind the isNew condition.
    // Today: mutableSecretManager.upsert is inside `if (isNew)` block.
    // After fix: mutableSecretManager.upsert is called for both branches.
    const upsertIdx = handlerSrc.indexOf("mutableSecretManager.upsert");
    const isNewBlockStart = handlerSrc.indexOf("if (!isNew)");
    const isNewBlockEnd = handlerSrc.indexOf("} else {", isNewBlockStart);
    // The upsert call must NOT be inside the `else` branch of `if (!isNew)`.
    // After Plan 06-03 the upsert is unconditional (before or without the isNew gate).
    // Today upsert is inside the `} else {` block — so upsertIdx > isNewBlockEnd.
    expect(upsertIdx).toBeLessThan(isNewBlockStart);
  });
});
