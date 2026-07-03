// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `preReadStorageMode` — the daemon-boot pre-read of
 * `security.storage` from YAML config files.
 *
 * The daemon needs this answer BEFORE `writeMasterKeyIfAbsent` so that
 * file/env mode first boots do not create key material. The pre-read is
 * a lightweight YAML scan that honors the layered-config precedence rule
 * "later files win" and defaults to "encrypted" (schema default) when no
 * file explicitly sets the field.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { preReadStorageMode } from "./pre-read-storage-mode.js";

describe("preReadStorageMode", () => {
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
});
