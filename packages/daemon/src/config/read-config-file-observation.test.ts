// SPDX-License-Identifier: Apache-2.0
/**
 * `readConfigFileObservation` behavior tests.
 *
 * Four cases:
 *   - existing_config_file_returns_snapshot_with_stat_fields
 *   - missing_config_file_returns_snapshot_null_exists_false
 *   - existing_lkg_sibling_populates_lkg_snapshot
 *   - missing_lkg_sibling_returns_lkg_null
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readConfigFileObservation } from "./read-config-file-observation.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "comis-read-cfg-obs-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("readConfigFileObservation -- target file presence", () => {
  it("existing_config_file_returns_snapshot_with_stat_fields", () => {
    const cfg = join(tmpDir, "config.yaml");
    writeFileSync(cfg, "logging:\n  level: info\n", { mode: 0o600 });

    const obs = readConfigFileObservation(cfg);
    expect(obs.configPath).toBe(cfg);
    expect(obs.exists).toBe(true);
    expect(obs.snapshot).not.toBeNull();
    expect(obs.snapshot!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(obs.snapshot!.bytes).toBeGreaterThan(0);
    expect(typeof obs.snapshot!.dev).toBe("string");
    expect(typeof obs.snapshot!.ino).toBe("string");
  });

  it("missing_config_file_returns_snapshot_null_exists_false", () => {
    const missing = join(tmpDir, "does-not-exist.yaml");
    const obs = readConfigFileObservation(missing);
    expect(obs.configPath).toBe(missing);
    expect(obs.exists).toBe(false);
    expect(obs.snapshot).toBeNull();
    expect(obs.lkg).toBeNull();
    expect(obs.backup).toBeNull();
  });
});

describe("readConfigFileObservation -- LKG sibling", () => {
  it("existing_lkg_sibling_populates_lkg_snapshot when <base>.last-good.yaml is on disk", () => {
    const cfg = join(tmpDir, "config.yaml");
    const lkg = join(tmpDir, "config.last-good.yaml");
    writeFileSync(cfg, "k: v\n", { mode: 0o600 });
    writeFileSync(lkg, "k: v-old\n", { mode: 0o600 });

    const obs = readConfigFileObservation(cfg);
    expect(obs.exists).toBe(true);
    expect(obs.snapshot).not.toBeNull();
    expect(obs.lkg).not.toBeNull();
    expect(obs.lkg!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(obs.lkg!.bytes).toBe(Buffer.byteLength("k: v-old\n"));
    // LKG snapshot is independent of target snapshot — different hashes
    // for different content.
    expect(obs.lkg!.hash).not.toBe(obs.snapshot!.hash);
  });

  it("missing_lkg_sibling_returns_lkg_null", () => {
    const cfg = join(tmpDir, "config.yaml");
    writeFileSync(cfg, "k: v\n", { mode: 0o600 });

    const obs = readConfigFileObservation(cfg);
    expect(obs.exists).toBe(true);
    expect(obs.snapshot).not.toBeNull();
    expect(obs.lkg).toBeNull();
  });
});

describe("readConfigFileObservation -- backup sibling", () => {
  it("existing_backup_sibling_populates_backup_snapshot when <base>.bak.yaml is on disk", () => {
    const cfg = join(tmpDir, "config.yaml");
    const bak = join(tmpDir, "config.bak.yaml");
    writeFileSync(cfg, "k: v\n", { mode: 0o600 });
    writeFileSync(bak, "k: v-bak\n", { mode: 0o600 });

    const obs = readConfigFileObservation(cfg);
    expect(obs.backup).not.toBeNull();
    expect(obs.backup!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(obs.backup!.bytes).toBe(Buffer.byteLength("k: v-bak\n"));
  });
});
