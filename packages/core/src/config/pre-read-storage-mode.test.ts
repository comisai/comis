// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `preReadStorageMode` — the daemon-boot pre-read of
 * `security.storage` from YAML config files (REQ-17).
 *
 * The daemon needs this answer BEFORE `writeMasterKeyIfAbsent` so that
 * file/env mode first boots do not create key material. The pre-read is
 * a lightweight YAML scan that honors the layered-config precedence rule
 * "later files win" and defaults to "encrypted" (schema default) when no
 * file explicitly sets the field.
 *
 * RED+GREEN committed together per AGENTS.md §2.10:
 * The test file imports `preReadStorageMode` from `pre-read-storage-mode.ts`,
 * which did not exist before this commit. A RED-only commit cannot compile.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { preReadStorageMode } from "./pre-read-storage-mode.js";

describe("preReadStorageMode (REQ-17)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "comis-pre-read-storage-mode-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(name: string, body: string): string {
    const filePath = resolve(tmpDir, name);
    writeFileSync(filePath, body, { mode: 0o600 });
    return filePath;
  }

  // ------------------------------------------------------------------
  // Default behavior (no config or absent field)
  // ------------------------------------------------------------------

  it("returns encrypted when no config paths are provided (schema-default)", () => {
    expect(preReadStorageMode([])).toBe("encrypted");
  });

  it("returns encrypted when none of the config paths exist on disk", () => {
    const missing = resolve(tmpDir, "does-not-exist.yaml");
    expect(preReadStorageMode([missing])).toBe("encrypted");
  });

  it("returns encrypted when YAML omits security.storage entirely", () => {
    const filePath = writeYaml(
      "config.yaml",
      "logLevel: debug\nsecurity:\n  logRedaction: true\n",
    );
    expect(preReadStorageMode([filePath])).toBe("encrypted");
  });

  it("returns encrypted when security section is absent entirely", () => {
    const filePath = writeYaml(
      "config.yaml",
      "daemon:\n  logLevels: {}\n",
    );
    expect(preReadStorageMode([filePath])).toBe("encrypted");
  });

  // ------------------------------------------------------------------
  // Explicit storage modes
  // ------------------------------------------------------------------

  it("returns file when security.storage: file in YAML", () => {
    const filePath = writeYaml(
      "config.yaml",
      "security:\n  storage: file\n",
    );
    expect(preReadStorageMode([filePath])).toBe("file");
  });

  it("returns env when security.storage: env in YAML", () => {
    const filePath = writeYaml(
      "config.yaml",
      "security:\n  storage: env\n",
    );
    expect(preReadStorageMode([filePath])).toBe("env");
  });

  it("returns encrypted when security.storage: encrypted in YAML", () => {
    const filePath = writeYaml(
      "config.yaml",
      "security:\n  storage: encrypted\n",
    );
    expect(preReadStorageMode([filePath])).toBe("encrypted");
  });

  // ------------------------------------------------------------------
  // Legacy key detection
  // ------------------------------------------------------------------

  it("returns legacy when security.secrets.enabled: false is present", () => {
    const filePath = writeYaml(
      "config.yaml",
      "security:\n  secrets:\n    enabled: false\n",
    );
    expect(preReadStorageMode([filePath])).toBe("legacy");
  });

  it("returns legacy when security.secrets.enabled: true is present", () => {
    const filePath = writeYaml(
      "config.yaml",
      "security:\n  secrets:\n    enabled: true\n",
    );
    expect(preReadStorageMode([filePath])).toBe("legacy");
  });

  it("returns legacy when oauth.storage is present at root level", () => {
    const filePath = writeYaml(
      "config.yaml",
      "oauth:\n  storage: file\n",
    );
    expect(preReadStorageMode([filePath])).toBe("legacy");
  });

  it("returns legacy when oauth.storage: encrypted is present", () => {
    const filePath = writeYaml(
      "config.yaml",
      "oauth:\n  storage: encrypted\n",
    );
    expect(preReadStorageMode([filePath])).toBe("legacy");
  });

  // ------------------------------------------------------------------
  // Last-wins layered override
  // ------------------------------------------------------------------

  it("honors later-files-win precedence: second file overrides first", () => {
    const base = writeYaml(
      "config.yaml",
      "security:\n  storage: file\n",
    );
    const overlay = writeYaml(
      "config.local.yaml",
      "security:\n  storage: env\n",
    );
    expect(preReadStorageMode([base, overlay])).toBe("env");
  });

  it("honors later-files-win: first file sets encrypted, overlay sets file", () => {
    const base = writeYaml(
      "config.yaml",
      "security:\n  storage: encrypted\n",
    );
    const overlay = writeYaml(
      "config.local.yaml",
      "security:\n  storage: file\n",
    );
    expect(preReadStorageMode([base, overlay])).toBe("file");
  });

  // ------------------------------------------------------------------
  // Legacy sentinel is STICKY/TERMINAL across layers (CR-01, REQ-17/REQ-02)
  //
  // A legacy key in ANY layer must win over a valid `security.storage` in a
  // later layer. Otherwise a base config carrying a removed legacy key plus an
  // overlay with `security.storage: encrypted` would pre-read as "encrypted" —
  // and the daemon boot gate would write SECRETS_MASTER_KEY/secrets.db BEFORE
  // the migration guard fails the boot, violating REQ-17 ("legacy config fails
  // cleanly WITHOUT writing key material").
  // ------------------------------------------------------------------

  it("returns legacy when a legacy oauth.storage in the base is overlaid by a valid security.storage", () => {
    const base = writeYaml("config.yaml", "oauth:\n  storage: file\n");
    const overlay = writeYaml(
      "config.local.yaml",
      "security:\n  storage: file\n",
    );
    expect(preReadStorageMode([base, overlay])).toBe("legacy");
  });

  it("returns legacy (no key-material) when legacy secrets.enabled in base is overlaid by security.storage: encrypted", () => {
    const base = writeYaml(
      "config.yaml",
      "security:\n  secrets:\n    enabled: false\n",
    );
    const overlay = writeYaml(
      "config.local.yaml",
      "security:\n  storage: encrypted\n",
    );
    // Must NOT return "encrypted" — that would trigger key-material creation
    // for a config that must fail boot cleanly (REQ-17).
    expect(preReadStorageMode([base, overlay])).toBe("legacy");
  });

  it("skips missing paths in the middle of the list", () => {
    const base = writeYaml(
      "config.yaml",
      "security:\n  storage: file\n",
    );
    const missing = resolve(tmpDir, "does-not-exist.yaml");
    const overlay = writeYaml(
      "config.local.yaml",
      "security:\n  storage: env\n",
    );
    expect(preReadStorageMode([base, missing, overlay])).toBe("env");
  });

  // ------------------------------------------------------------------
  // Error resilience
  // ------------------------------------------------------------------

  it("falls back to encrypted when a path contains malformed YAML", () => {
    const filePath = writeYaml("config.yaml", "::: not valid yaml :::\n");
    expect(preReadStorageMode([filePath])).toBe("encrypted");
  });

  it("ignores non-string security.storage values", () => {
    const filePath = writeYaml(
      "config.yaml",
      // invalid value — schema validation catches downstream; pre-read ignores
      "security:\n  storage: 42\n",
    );
    expect(preReadStorageMode([filePath])).toBe("encrypted");
  });

  it("ignores unknown security.storage values (only encrypted/file/env are valid)", () => {
    const filePath = writeYaml(
      "config.yaml",
      "security:\n  storage: \"somethingUnknown\"\n",
    );
    expect(preReadStorageMode([filePath])).toBe("encrypted");
  });

  it("ignores security.secrets when enabled is not a boolean", () => {
    const filePath = writeYaml(
      "config.yaml",
      "security:\n  secrets:\n    enabled: \"false\"\n",
    );
    // Not a boolean — migration guard ignores; no legacy detected
    expect(preReadStorageMode([filePath])).toBe("encrypted");
  });
});
