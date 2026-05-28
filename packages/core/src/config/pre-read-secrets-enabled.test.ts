// SPDX-License-Identifier: Apache-2.0
/**
 * Tests for `preReadSecretsEnabled` — the daemon-boot pre-read of
 * `security.secrets.enabled` from YAML config files.
 *
 * The daemon needs this answer BEFORE `writeMasterKeyIfAbsent` and the
 * encrypted-store bootstrap (full config parsing happens later, after
 * mergedEnv is built). The pre-read is a lightweight YAML scan that
 * honors the layered-config precedence rule "later files win" and falls
 * back to `true` (the schema default) when no file mentions the field.
 *
 * Tests do not exercise env-substitution or include resolution —
 * `security.secrets.enabled` is a boolean, neither path is relevant.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { preReadSecretsEnabled } from "./pre-read-secrets-enabled.js";

describe("preReadSecretsEnabled", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "comis-pre-read-secrets-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeYaml(name: string, body: string): string {
    const path = resolve(tmpDir, name);
    writeFileSync(path, body, { mode: 0o600 });
    return path;
  }

  it("returns true when no config paths are provided (schema-default fallback)", () => {
    expect(preReadSecretsEnabled([])).toBe(true);
  });

  it("returns true when none of the config paths exist on disk", () => {
    const missing = resolve(tmpDir, "does-not-exist.yaml");
    expect(preReadSecretsEnabled([missing])).toBe(true);
  });

  it("returns true when YAML omits the security.secrets block entirely", () => {
    const path = writeYaml(
      "config.yaml",
      "logLevel: debug\nsecurity:\n  logRedaction: true\n",
    );
    expect(preReadSecretsEnabled([path])).toBe(true);
  });

  it("returns true when security.secrets exists but enabled is unset", () => {
    const path = writeYaml(
      "config.yaml",
      "security:\n  secrets:\n    dbPath: secrets.db\n",
    );
    expect(preReadSecretsEnabled([path])).toBe(true);
  });

  it("returns false when YAML explicitly sets security.secrets.enabled to false", () => {
    const path = writeYaml(
      "config.yaml",
      "security:\n  secrets:\n    enabled: false\n",
    );
    expect(preReadSecretsEnabled([path])).toBe(false);
  });

  it("returns true when YAML explicitly sets security.secrets.enabled to true", () => {
    const path = writeYaml(
      "config.yaml",
      "security:\n  secrets:\n    enabled: true\n",
    );
    expect(preReadSecretsEnabled([path])).toBe(true);
  });

  it("honors later-files-win precedence when multiple paths set the field", () => {
    const base = writeYaml(
      "config.yaml",
      "security:\n  secrets:\n    enabled: false\n",
    );
    const overlay = writeYaml(
      "config.local.yaml",
      "security:\n  secrets:\n    enabled: true\n",
    );
    expect(preReadSecretsEnabled([base, overlay])).toBe(true);
  });

  it("honors later-files-win precedence when overlay disables an enabled base", () => {
    const base = writeYaml(
      "config.yaml",
      "security:\n  secrets:\n    enabled: true\n",
    );
    const overlay = writeYaml(
      "config.local.yaml",
      "security:\n  secrets:\n    enabled: false\n",
    );
    expect(preReadSecretsEnabled([base, overlay])).toBe(false);
  });

  it("falls back to true when a path contains malformed YAML (full bootstrap reports the error)", () => {
    const path = writeYaml("config.yaml", "::: not valid yaml :::\n");
    expect(preReadSecretsEnabled([path])).toBe(true);
  });

  it("ignores non-boolean enabled values (schema validation rejects them downstream)", () => {
    const path = writeYaml(
      "config.yaml",
      "security:\n  secrets:\n    enabled: \"false\"\n",
    );
    expect(preReadSecretsEnabled([path])).toBe(true);
  });
});
