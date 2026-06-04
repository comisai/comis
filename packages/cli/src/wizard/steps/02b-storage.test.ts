// SPDX-License-Identifier: Apache-2.0
/**
 * Unit tests for the credential-storage step (step 02b).
 *
 * Verifies the three branches:
 *   - fresh data dir + encrypted (default) -> master key written + backup warning
 *   - existing key OR existing secrets.db -> writeMasterKeyIfAbsent NOT called
 *   - plaintext chosen -> no keygen, storageMode "file"
 *
 * Mocks @comis/core (writeMasterKeyIfAbsent, systemGetEnv, loadConfigFile,
 * validateConfig) and node:fs (existsSync) so the step's detection logic is
 * fully driven by the test without touching the real ~/.comis.
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WizardPrompter, Spinner } from "../prompter.js";
import type { WizardState } from "../types.js";
import { INITIAL_STATE } from "../types.js";

// Mock @clack/prompts to prevent import errors (loaded transitively via barrel)
vi.mock("@clack/prompts", () => ({}));

// Module-level toggle for the mocked systemGetEnv("SECRETS_MASTER_KEY").
// When truthy, a master key is "present" (loadWizardStorageMode resolves
// "encrypted" when config is absent). COMIS_CONFIG_PATHS / COMIS_DATA_DIR
// always resolve undefined so the standard ~/.comis paths apply.
let masterKeyState: string | undefined;

vi.mock("@comis/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@comis/core")>();
  return {
    ...actual,
    writeMasterKeyIfAbsent: vi.fn(() => ({
      written: true,
      path: "/home/test/.comis/.env",
      keyHex: "f".repeat(64),
    })),
    systemGetEnv: vi.fn((key: string) =>
      key === "SECRETS_MASTER_KEY" ? masterKeyState : undefined,
    ),
    loadEnvFile: vi.fn(),
    loadConfigFile: vi
      .fn()
      .mockReturnValue({ ok: false, error: new Error("no config") }),
    validateConfig: vi.fn().mockImplementation((raw: unknown) => ({
      ok: true,
      value: raw,
    })),
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
}));

vi.mock("node:os", () => {
  const homedir = vi.fn(() => "/home/test");
  return { homedir, default: { homedir } };
});

import { storageStep } from "./02b-storage.js";
import {
  writeMasterKeyIfAbsent,
  loadConfigFile,
} from "@comis/core";
import { existsSync } from "node:fs";

// ---------- Mock Prompter ----------

function createMockPrompter(
  selectResult: "encrypted" | "file" = "encrypted",
): WizardPrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn().mockResolvedValue(selectResult),
    multiselect: vi.fn().mockResolvedValue([]),
    text: vi.fn().mockResolvedValue(""),
    password: vi.fn().mockResolvedValue(""),
    confirm: vi.fn().mockResolvedValue(true),
    spinner: vi.fn(
      (): Spinner => ({
        start: vi.fn(),
        update: vi.fn(),
        stop: vi.fn(),
      }),
    ),
    group: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
  };
}

// ---------- Tests ----------

describe("storageStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    masterKeyState = undefined;
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(loadConfigFile).mockReturnValue({
      ok: false,
      error: new Error("no config"),
    });
    vi.mocked(writeMasterKeyIfAbsent).mockReturnValue({
      written: true,
      path: "/home/test/.comis/.env",
      keyHex: "f".repeat(64),
    });
  });

  afterEach(() => {
    masterKeyState = undefined;
  });

  it("has the correct step id and label", () => {
    expect(storageStep.id).toBe("storage");
    expect(storageStep.label).toBeTruthy();
  });

  it("fresh data dir + accept encrypted default: provisions key + backup warning + storageMode encrypted", async () => {
    // No master key, no secrets.db -> fresh.
    const prompter = createMockPrompter("encrypted");

    const result = await storageStep.execute(INITIAL_STATE, prompter);

    // The select prompt offered encrypted as the default with two options.
    expect(prompter.select).toHaveBeenCalledTimes(1);
    const selectArg = vi.mocked(prompter.select).mock.calls[0][0];
    expect(selectArg.initialValue).toBe("encrypted");
    expect(selectArg.options.map((o) => o.value)).toEqual([
      "encrypted",
      "file",
    ]);

    // Master key provisioned.
    expect(writeMasterKeyIfAbsent).toHaveBeenCalledTimes(1);
    const dataDirArg = vi.mocked(writeMasterKeyIfAbsent).mock.calls[0][0];
    expect(dataDirArg).toContain(".comis");

    // Backup warning emitted (path only, never the key value).
    const warnCalls = vi.mocked(prompter.log.warn).mock.calls.map(([m]) =>
      String(m),
    );
    const backupWarn = warnCalls.find((m) =>
      m.toLowerCase().includes("back this up"),
    );
    expect(backupWarn).toBeDefined();
    expect(backupWarn).toContain("~/.comis/.env");
    expect(backupWarn).not.toContain("f".repeat(64));

    expect(result.storageMode).toBe("encrypted");
  });

  it("existing master key + encrypted chosen: does NOT call writeMasterKeyIfAbsent, no backup warning", async () => {
    masterKeyState = "a".repeat(64); // key already present
    const prompter = createMockPrompter("encrypted");

    const result = await storageStep.execute(INITIAL_STATE, prompter);

    expect(writeMasterKeyIfAbsent).not.toHaveBeenCalled();
    const warnCalls = vi.mocked(prompter.log.warn).mock.calls.map(([m]) =>
      String(m),
    );
    expect(warnCalls.some((m) => m.toLowerCase().includes("back this up"))).toBe(
      false,
    );
    expect(result.storageMode).toBe("encrypted");
  });

  it("existing secrets.db + encrypted chosen: does NOT call writeMasterKeyIfAbsent", async () => {
    // No master key but secrets.db exists on disk.
    vi.mocked(existsSync).mockReturnValue(true);
    const prompter = createMockPrompter("encrypted");

    const result = await storageStep.execute(INITIAL_STATE, prompter);

    expect(writeMasterKeyIfAbsent).not.toHaveBeenCalled();
    expect(result.storageMode).toBe("encrypted");
  });

  it("plaintext chosen: no keygen, no backup warning, storageMode file", async () => {
    const prompter = createMockPrompter("file");

    const result = await storageStep.execute(INITIAL_STATE, prompter);

    expect(writeMasterKeyIfAbsent).not.toHaveBeenCalled();
    const warnCalls = vi.mocked(prompter.log.warn).mock.calls.map(([m]) =>
      String(m),
    );
    expect(warnCalls.some((m) => m.toLowerCase().includes("back this up"))).toBe(
      false,
    );
    expect(result.storageMode).toBe("file");
  });

  it("does not emit a backup warning when writeMasterKeyIfAbsent reports written:false", async () => {
    // Fresh detection passes (no key, no db) so the call IS made, but the
    // writer is idempotent and reports nothing was written.
    vi.mocked(writeMasterKeyIfAbsent).mockReturnValue({
      written: false,
      path: "/home/test/.comis/.env",
    });
    const prompter = createMockPrompter("encrypted");

    await storageStep.execute(INITIAL_STATE, prompter);

    expect(writeMasterKeyIfAbsent).toHaveBeenCalledTimes(1);
    const warnCalls = vi.mocked(prompter.log.warn).mock.calls.map(([m]) =>
      String(m),
    );
    expect(warnCalls.some((m) => m.toLowerCase().includes("back this up"))).toBe(
      false,
    );
  });

  it("default initialValue is 'file' when no master key and config absent", async () => {
    // loadWizardStorageMode -> "file" (no key, no config) -> initialValue file.
    masterKeyState = undefined;
    const prompter = createMockPrompter("file");

    await storageStep.execute(INITIAL_STATE, prompter);

    const selectArg = vi.mocked(prompter.select).mock.calls[0][0];
    expect(selectArg.initialValue).toBe("file");
  });

  it("never logs the freshly generated key value", async () => {
    const prompter = createMockPrompter("encrypted");

    await storageStep.execute(INITIAL_STATE, prompter);

    const allLogs = [
      ...vi.mocked(prompter.log.info).mock.calls,
      ...vi.mocked(prompter.log.warn).mock.calls,
      ...vi.mocked(prompter.log.error).mock.calls,
      ...vi.mocked(prompter.log.success).mock.calls,
      ...vi.mocked(prompter.note).mock.calls,
    ].map((c) => String(c[0]));
    for (const line of allLogs) {
      expect(line).not.toContain("f".repeat(64));
    }
  });
});
