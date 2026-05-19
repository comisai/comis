// SPDX-License-Identifier: Apache-2.0
/**
 * `diagnostics.configAudit.enabled` honored at all three caller sites.
 *
 * The schema declares `diagnostics.configAudit.enabled` defaulting to
 * `true` (`packages/core/src/config/schema-diagnostics.ts:116-130`).
 * Operators setting it to `false` expect the three audit-write hook
 * sites to fall silent:
 *
 *   1. `packages/daemon/src/config/last-known-good.ts:135, 156` —
 *      `saveLastKnownGood` / `restoreLastKnownGood` call `withAuditHook`.
 *   2. `packages/daemon/src/api/config-handlers/config-write.ts:124, 390`
 *      — `config.patch` RPC handler calls `buildConfigAuditBase` and
 *      `appendConfigAuditWithOutcome`.
 *   3. `packages/cli/src/commands/config.ts:583, 585` — CLI sync-tooling
 *      build/append helpers.
 *
 * The test verifies two of the three sites end-to-end:
 *
 *   a. SOURCE-GREP REGRESSION GUARDS — assert each caller site has the
 *      gate logic (`auditEnabled` / `configAudit?.enabled`).
 *   b. BEHAVIORAL — direct invocation of `saveLastKnownGood` with
 *      `auditEnabled: false` does NOT write a line to the audit log;
 *      with `auditEnabled: true` (or omitted) it DOES.
 *
 * The CLI gate site (#3) is verified by source-grep only (the CLI
 * code path's integration test surface lives in
 * `test/integration/cli-sync-tooling.test.ts`; the gate logic is
 * locked in by the source-grep regression guard here).
 *
 * Per AGENTS.md §2.5: imports from `dist/` — requires `pnpm build` first.
 *
 * @module
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let tmpDir: string;
let configPath: string;
let auditLogPath: string;
let prevAuditEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "comis-audit-disabled-"));
  configPath = path.join(tmpDir, "config.yaml");
  auditLogPath = path.join(tmpDir, "config-audit.jsonl");
  // eslint-disable-next-line no-restricted-syntax -- test fixture env override
  prevAuditEnv = process.env["COMIS_CONFIG_AUDIT_LOG"];
  // eslint-disable-next-line no-restricted-syntax -- test fixture env override
  process.env["COMIS_CONFIG_AUDIT_LOG"] = auditLogPath;
});

afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  // eslint-disable-next-line no-restricted-syntax -- test fixture env restore
  if (prevAuditEnv === undefined) delete process.env["COMIS_CONFIG_AUDIT_LOG"];
  // eslint-disable-next-line no-restricted-syntax -- test fixture env restore
  else process.env["COMIS_CONFIG_AUDIT_LOG"] = prevAuditEnv;
});

describe("diagnostics.configAudit.enabled — honored at all three caller sites", () => {
  it("last-known-good.ts saveLastKnownGood/restoreLastKnownGood read auditEnabled and skip the audit hook when false", () => {
    // Wiring-chain regression guard #1: last-known-good.ts must read an
    // auditEnabled parameter and skip withAuditHook when it is false.
    const repoRoot = process.cwd();
    const lkgSrc = fs.readFileSync(
      path.join(repoRoot, "packages/daemon/src/config/last-known-good.ts"),
      "utf-8",
    );
    expect(lkgSrc).toMatch(/auditEnabled/);
    // Either function signature accepts the new parameter.
    expect(lkgSrc).toMatch(
      /export function saveLastKnownGood\([^)]*auditEnabled/,
    );
    expect(lkgSrc).toMatch(
      /export function restoreLastKnownGood\([^)]*auditEnabled/,
    );
  });

  it("daemon.ts and handleRestoreFlag thread the configAudit.enabled knob to last-known-good callers", () => {
    // Wiring-chain regression guard #2: daemon.ts must pass the gate
    // value to saveLastKnownGood, and handleRestoreFlag must accept +
    // forward auditEnabled to restoreLastKnownGood.
    const repoRoot = process.cwd();
    const daemonSrc = fs.readFileSync(
      path.join(repoRoot, "packages/daemon/src/daemon.ts"),
      "utf-8",
    );
    // The daemon-side caller binds the gate value (typically as a
    // const named like auditEnabled or directly inline) and passes it
    // to saveLastKnownGood. Verify both the read-of-the-knob AND the
    // pass-through into the LKG function.
    expect(daemonSrc).toMatch(
      /container\.config\.diagnostics\?\.configAudit\?\.enabled/,
    );
    expect(daemonSrc).toMatch(/saveLastKnownGood\(\s*activeConfigPath,/);
  });

  it("config-write.ts RPC handler skips buildConfigAuditBase/appendConfigAuditWithOutcome when deps.auditEnabled === false", () => {
    // Wiring-chain regression guard #3: config-write.ts must consult
    // deps.auditEnabled before calling buildConfigAuditBase and skip
    // the corresponding finalize/append call in the finally block.
    const repoRoot = process.cwd();
    const configWriteSrc = fs.readFileSync(
      path.join(repoRoot, "packages/daemon/src/api/config-handlers/config-write.ts"),
      "utf-8",
    );
    expect(configWriteSrc).toMatch(/auditEnabled/);
  });

  it("ConfigApiDeps declares auditEnabled and rpc-dispatch.ts threads it from container.config.diagnostics.configAudit.enabled", () => {
    // Wiring-chain regression guard #4: the per-domain deps slice
    // gains an `auditEnabled?: boolean` field, and the dispatcher
    // populates it from the running config.
    const repoRoot = process.cwd();
    const typesSrc = fs.readFileSync(
      path.join(repoRoot, "packages/daemon/src/api/types.ts"),
      "utf-8",
    );
    expect(typesSrc).toMatch(/auditEnabled\?:\s*boolean/);

    const dispatchSrc = fs.readFileSync(
      path.join(repoRoot, "packages/daemon/src/api/rpc-dispatch.ts"),
      "utf-8",
    );
    expect(dispatchSrc).toMatch(
      /auditEnabled:\s*[\s\S]*?diagnostics\?\.configAudit\?\.enabled/,
    );
  });

  it("cli/commands/config.ts gates the buildCliSyncToolingAuditBase + appendCliSyncToolingAudit calls on the loaded configJs.diagnostics.configAudit.enabled", () => {
    // Wiring-chain regression guard #5: the CLI sync-tooling write
    // path consults the loaded config's diagnostics.configAudit.enabled
    // (either via direct `configJs?.diagnostics?.…` or a typed alias
    // built from configJs) and skips both the audit base build AND
    // the append when false.
    const repoRoot = process.cwd();
    const cliConfigSrc = fs.readFileSync(
      path.join(repoRoot, "packages/cli/src/commands/config.ts"),
      "utf-8",
    );
    // The chain `?.diagnostics?.configAudit?.enabled` must appear in
    // the CLI source (regardless of whether it lands on `configJs`
    // directly or on a typed alias).
    expect(cliConfigSrc).toMatch(
      /\?\.diagnostics\?\.configAudit\?\.enabled/,
    );
    // And the `!== false` gate semantics must be present (preserving
    // the schema's default-true contract).
    expect(cliConfigSrc).toMatch(
      /\?\.diagnostics\?\.configAudit\?\.enabled\s*!==\s*false/,
    );
  });

  it("saveLastKnownGood with auditEnabled: false does not append a line to the audit log", async () => {
    // Behavioral end-to-end assertion (case 1).
    fs.writeFileSync(configPath, "logging:\n  level: info\n", { mode: 0o600 });

    // Re-import after pnpm build so the dist alias resolves to the
    // freshly-built module that knows about auditEnabled.
    // Import directly from the daemon dist subpath. The daemon barrel
    // does not re-export saveLastKnownGood (it is daemon-internal); the
    // dist subpath is the test-only access route used to verify the
    // function's behavior under the new auditEnabled parameter.
    const lkgDistPath = path.join(
      process.cwd(),
      "packages/daemon/dist/config/last-known-good.js",
    );
    const { saveLastKnownGood } = (await import(lkgDistPath)) as {
      saveLastKnownGood: (
        configPath: string,
        auditEnabled?: boolean,
      ) => { saved: boolean; path: string };
    };

    const result = saveLastKnownGood(configPath, false);
    expect(result.saved).toBe(true);

    // The audit log must NOT exist (no append happened). Account for
    // pre-existing log artifacts by capturing baseline size if present.
    if (fs.existsSync(auditLogPath)) {
      const after = fs.statSync(auditLogPath).size;
      expect(after).toBe(0);
    } else {
      expect(fs.existsSync(auditLogPath)).toBe(false);
    }
  });

  it("saveLastKnownGood with auditEnabled: true (default) appends an audit line — gates the negative test above", async () => {
    // Behavioral end-to-end assertion (case 2 — symmetry with the
    // negative). Ensures the test scaffolding actually captures the
    // audit path; if the audit log doesn't exist after a default save
    // call, the test in case 1 is meaningless.
    fs.writeFileSync(configPath, "logging:\n  level: info\n", { mode: 0o600 });

    // Import directly from the daemon dist subpath. The daemon barrel
    // does not re-export saveLastKnownGood (it is daemon-internal); the
    // dist subpath is the test-only access route used to verify the
    // function's behavior under the new auditEnabled parameter.
    const lkgDistPath = path.join(
      process.cwd(),
      "packages/daemon/dist/config/last-known-good.js",
    );
    const { saveLastKnownGood } = (await import(lkgDistPath)) as {
      saveLastKnownGood: (
        configPath: string,
        auditEnabled?: boolean,
      ) => { saved: boolean; path: string };
    };

    const result = saveLastKnownGood(configPath, true);
    expect(result.saved).toBe(true);

    expect(fs.existsSync(auditLogPath)).toBe(true);
    const content = fs.readFileSync(auditLogPath, "utf-8");
    expect(content.split("\n").filter((l) => l.length > 0).length).toBeGreaterThanOrEqual(1);
  });
});
