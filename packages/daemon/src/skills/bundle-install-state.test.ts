// SPDX-License-Identifier: Apache-2.0
/**
 * Phase 68 CR-01 — daemon-private installed-bundles state file tests.
 *
 * The state file is the TRUST ROOT for "did WE install this MCP entry as a
 * bundle?". It MUST live OUTSIDE config.yaml so a hand-edit of config.yaml
 * cannot spoof bundle provenance via `_bundleSource`.
 *
 * Test matrix:
 *   1. readBundleInstallState — fresh dataDir (no file) returns empty state.
 *   2. recordBundleEntries — writes JSON + sets mode 0o600.
 *   3. recordBundleEntries — round-trip: write then read returns equal state.
 *   4. recordBundleEntries — replaces prior entries for the same skillId.
 *   5. forgetBundle — removes recorded entries for a skillId.
 *   6. computeEntryFingerprint — deterministic across runs / equal entries.
 *   7. computeEntryFingerprint — differs across DIFFERENT entries.
 *   8. hasBundleRecord — true only when (skillId, serverName) recorded.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  readBundleInstallState,
  recordBundleEntries,
  forgetBundle,
  computeEntryFingerprint,
  hasBundleRecord,
} from "./bundle-install-state.js";
import type { McpServerEntry } from "@comis/core";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), `bundle-install-state-${randomUUID().slice(0, 8)}-`));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(name: string, overrides: Partial<McpServerEntry> = {}): McpServerEntry {
  return {
    name,
    transport: "stdio",
    command: "npx",
    args: ["pkg"],
    enabled: true,
    idleTtlMs: 0,
    ...overrides,
  } as McpServerEntry;
}

describe("bundle-install-state — CR-01 trust-root state file", () => {
  it("readBundleInstallState on a fresh dataDir (no file) returns an empty state object", () => {
    const state = readBundleInstallState(tmpDir);
    expect(state).toEqual({});
  });

  it("recordBundleEntries writes the state file with mode 0o600 and contains the fingerprint", () => {
    const entry = makeEntry("alpha");
    recordBundleEntries(tmpDir, "skill-x", [entry]);

    const filePath = join(tmpDir, "installed-bundles.json");
    expect(existsSync(filePath)).toBe(true);
    const st = statSync(filePath);
    // mode 0o600 — file is owner-only readable/writable.
    expect((st.mode & 0o777)).toBe(0o600);

    const state = readBundleInstallState(tmpDir);
    expect(state["skill-x"]).toBeDefined();
    expect(state["skill-x"]?.["alpha"]).toBeTypeOf("string");
    expect(state["skill-x"]?.["alpha"]!.length).toBeGreaterThan(0);
  });

  it("recordBundleEntries round-trip: writing then reading returns equal state", () => {
    const entry1 = makeEntry("alpha");
    const entry2 = makeEntry("bravo", { args: ["pkg-b"] });
    recordBundleEntries(tmpDir, "skill-x", [entry1, entry2]);

    const state = readBundleInstallState(tmpDir);
    expect(Object.keys(state["skill-x"] ?? {}).sort()).toEqual(["alpha", "bravo"]);
  });

  it("recordBundleEntries replaces prior entries for the same skillId atomically", () => {
    recordBundleEntries(tmpDir, "skill-x", [makeEntry("alpha"), makeEntry("bravo")]);
    // Re-install with a different set of entries (alpha removed, charlie added).
    recordBundleEntries(tmpDir, "skill-x", [makeEntry("bravo"), makeEntry("charlie")]);

    const state = readBundleInstallState(tmpDir);
    expect(Object.keys(state["skill-x"] ?? {}).sort()).toEqual(["bravo", "charlie"]);
    expect(state["skill-x"]?.["alpha"]).toBeUndefined();
  });

  it("recordBundleEntries preserves entries for OTHER skillIds when one skill is updated", () => {
    recordBundleEntries(tmpDir, "skill-x", [makeEntry("alpha")]);
    recordBundleEntries(tmpDir, "skill-y", [makeEntry("beta")]);

    const state = readBundleInstallState(tmpDir);
    expect(state["skill-x"]?.["alpha"]).toBeDefined();
    expect(state["skill-y"]?.["beta"]).toBeDefined();
  });

  it("forgetBundle removes a skill's entries while preserving others", () => {
    recordBundleEntries(tmpDir, "skill-x", [makeEntry("alpha")]);
    recordBundleEntries(tmpDir, "skill-y", [makeEntry("beta")]);
    forgetBundle(tmpDir, "skill-x");

    const state = readBundleInstallState(tmpDir);
    expect(state["skill-x"]).toBeUndefined();
    expect(state["skill-y"]?.["beta"]).toBeDefined();
  });

  it("computeEntryFingerprint is deterministic across equal entries (same transport/command/args)", () => {
    const a = makeEntry("alpha");
    const b = makeEntry("alpha");
    expect(computeEntryFingerprint(a)).toBe(computeEntryFingerprint(b));
  });

  it("computeEntryFingerprint differs across entries with different commands or args", () => {
    const a = makeEntry("alpha", { args: ["pkg-a"] });
    const b = makeEntry("alpha", { args: ["pkg-b"] });
    expect(computeEntryFingerprint(a)).not.toBe(computeEntryFingerprint(b));
  });

  it("hasBundleRecord returns true only when both skillId and serverName are recorded", () => {
    recordBundleEntries(tmpDir, "skill-x", [makeEntry("alpha")]);
    const state = readBundleInstallState(tmpDir);
    expect(hasBundleRecord(state, "skill-x", "alpha")).toBe(true);
    expect(hasBundleRecord(state, "skill-x", "bravo")).toBe(false);
    expect(hasBundleRecord(state, "skill-y", "alpha")).toBe(false);
  });
});
