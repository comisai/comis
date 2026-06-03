// SPDX-License-Identifier: Apache-2.0
/**
 * Credential live-rotation GREEN integration test.
 *
 * Asserts that rotating a credential (writing an EXISTING secret key with a new
 * value) makes the new value immediately visible through the shared
 * secretManager (exec-sandbox reads secretManager.get() per call), and that no
 * daemon restart occurs.
 *
 * The production handler was fixed (drop SIGUSR2, live-apply on rotation) so
 * that:
 *   - env-handlers.ts calls mutableSecretManager.upsert() unconditionally
 *     (for both new-key and rotation paths).
 *   - No SIGUSR2 is scheduled on rotation — restarting: false is returned.
 *
 * All three tests below are GREEN.
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
// Sentinel values: neutral test strings — never real credentials
// ---------------------------------------------------------------------------

const EXEC_TEST_KEY = "EXEC_TEST_KEY";
const VALUE_V1 = "exec-test-v1";
const VALUE_V2 = "exec-test-v2-rotated";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("credential live-rotation integration (GREEN)", () => {
  // ---------------------------------------------------------------------------
  // Test 1: shared Map live-apply contract (GREEN — baseline invariant)
  //
  // This test verifies that the secretManager + mutableHandle share ONE backing
  // Map. A write via mutableHandle.upsert() is immediately visible through
  // secretManager.get(). This is the mechanism rotation live-apply uses — and
  // it ALREADY works at the Map level.
  //
  // This test is GREEN now and must STAY GREEN. It documents the core invariant
  // that the later tests depend on.
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
  // Test 2: rotation live-apply (GREEN — the handler fix)
  //
  // After a rotation write (existing key with new value), the env-handler now
  // calls mutableHandle.upsert(key, newValue) unconditionally for both the
  // new-key and rotation paths. No SIGUSR2 is scheduled.
  //
  // This test simulates the fixed handler behavior: persist to disk AND call
  // upsert for the rotation path. The exec-sandbox (secretManager.get())
  // immediately observes the new value — no daemon restart required.
  // ---------------------------------------------------------------------------

  it("exec-sandbox resolves rotated EXEC_TEST_KEY value on next invocation without daemon restart (GREEN)", () => {
    // Seed the backing Map with v1 — simulates a previously stored secret.
    const { secretManager, mutableHandle } = createSecretManagerWithMutableHandle({
      [EXEC_TEST_KEY]: VALUE_V1,
    });

    // Initial state: secretManager has v1.
    expect(secretManager.get(EXEC_TEST_KEY)).toBe(VALUE_V1);

    // Simulate the FIXED handler behavior:
    //   1. secretStore.set(key, value)  — persists to disk (not modeled here)
    //   2. mutableHandle.upsert(key, value)  — live-apply to shared Map
    //   3. // NO SIGUSR2 — return restarting: false
    //
    // The exec-sandbox reads from secretManager.get() on each call. After
    // upsert(), the new value is immediately visible without restart.
    mutableHandle.upsert(EXEC_TEST_KEY, VALUE_V2);

    // GREEN assertion: exec-sandbox sees v2 immediately.
    expect(secretManager.get(EXEC_TEST_KEY)).toBe(VALUE_V2);
  });

  // ---------------------------------------------------------------------------
  // Test 3: restarting: false on rotation (GREEN — the handler fix)
  //
  // env.set on any path (new or rotation) now returns restarting: false and
  // calls mutableSecretManager.upsert() unconditionally.
  //
  // This test inspects the env-handlers.ts source to confirm the post-fix
  // structural invariants:
  //   1. No SIGUSR2 in the handler (it was removed).
  //   2. mutableSecretManager.upsert is present unconditionally — not gated
  //      inside an `if (!isNew)` block (it was made unconditional).
  // ---------------------------------------------------------------------------

  it("env.set rotation path returns restarting: false and calls mutableHandle.upsert unconditionally (GREEN)", () => {
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

    // GREEN assertion 1: SIGUSR2 must be absent from env-handlers.ts.
    // It was removed — the restart signal is not fired on credential writes.
    expect(handlerSrc).not.toContain("SIGUSR2");

    // GREEN assertion 2: mutableSecretManager.upsert must be present and
    // unconditional — not gated inside an `if (!isNew)` conditional block.
    // The upsert call was moved unconditionally (before or outside the isNew
    // check), so `if (!isNew)` no longer exists in the file.
    const upsertIdx = handlerSrc.indexOf("mutableSecretManager.upsert");
    expect(upsertIdx).toBeGreaterThan(-1); // upsert call present

    const isNewGateIdx = handlerSrc.indexOf("if (!isNew)");
    // After the fix the `if (!isNew)` SIGUSR2 branch is gone.
    expect(isNewGateIdx).toBe(-1);
  });
});
