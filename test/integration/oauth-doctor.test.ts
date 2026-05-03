// SPDX-License-Identifier: Apache-2.0
/**
 * Integration test for SC-10-2: `comis doctor` OAuth subsystem (Phase 10
 * plan 06 Task 3).
 *
 * Spawns the CLI as a child process, captures stdout (JSON via
 * `--format json`), asserts on the OAuth findings shape. Daemon is NOT
 * required (per Phase 8 D-13: doctor reads OAuth profiles directly via
 * selectOAuthCredentialStore).
 *
 * Test inventory (5 tests):
 *   1. Per-profile expiry — healthy + near-expiry warn (SC-10-2 main).
 *   2. Schema-version mismatch surfaces verbatim from the file adapter
 *      (Phase 7 D-07 verbatim hint contract preserved).
 *   3. --refresh-test default OFF — no `refresh test` findings without flag
 *      (D-10-04-01).
 *   4. TLS preflight finding present (status varies with network — assert
 *      only existence per D-10-04-04).
 *   5. No token leakage in JSON output (RESEARCH §Pitfall 2 / T-10-03 — the
 *      access-token sentinel must NEVER appear in stdout).
 *
 * Test isolation per `packages/cli/src/commands/doctor.ts:85`
 * (`config?.dataDir || os.homedir() + "/.comis"`): the doctor resolves
 * `dataDir` only from the loaded config or the user's home directory —
 * there is no dedicated env var for it. The ONLY mechanism for
 * redirecting `dataDir` is to write a temp YAML config containing
 * `dataDir: <tempDir>` and pass `COMIS_CONFIG_PATHS=<tempConfigYaml>`
 * to the spawned CLI.
 *
 * Per AGENTS.md §2.5: imports from dist/ — requires `pnpm build` first.
 *
 * Run with: `pnpm build && pnpm test:integration -- oauth-doctor`.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CLI_PATH = path.join(process.cwd(), "packages/cli/dist/cli.js");
const PROVIDER_ID = "openai-codex";
const PROFILE_A_ID = "openai-codex:user_a@example.com";
const PROFILE_B_ID = "openai-codex:user_b@example.com";
const SENTINEL_ACCESS_TOKEN = "TEST_LEAK_SENTINEL_ACCESS_xxxxxxxx";

// Expected shape of the JSON `--format json` doctor output (matches
// renderDoctorJson in packages/cli/src/doctor/output.ts).
interface DoctorJsonOutput {
  checksRun: number;
  summary: {
    pass: number;
    fail: number;
    warn: number;
    skip: number;
    repairable: number;
  };
  findings: Array<{
    category: string;
    check: string;
    status: "pass" | "fail" | "warn" | "skip";
    message: string;
    suggestion?: string;
    repairable: boolean;
    secsUntilExpiry?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DoctorRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn `node packages/cli/dist/cli.js doctor --format json [args]` with
 * the supplied env overrides. Resolves on child-process exit. Note:
 * exitCode may be non-zero when other doctor checks fail (daemon down,
 * config schema warnings) — the OAuth-finding assertions only inspect
 * `findings[]`, not the overall exit code.
 */
function runDoctor(
  envOverrides: Record<string, string>,
  extraArgs: string[] = [],
): Promise<DoctorRunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      [CLI_PATH, "doctor", "--format", "json", ...extraArgs],
      {
        env: { ...process.env, ...envOverrides },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer | string) => {
      stdout += typeof b === "string" ? b : b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer | string) => {
      stderr += typeof b === "string" ? b : b.toString("utf8");
    });
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

/**
 * Write the auth-profiles.json file directly into the temp dataDir. The
 * file adapter uses mode 0o600 — match it so doctor's checkProfiles path
 * can readlink without a permissions surprise.
 */
function seedProfilesFile(dataDir: string, profilesJson: object): void {
  const file = path.join(dataDir, "auth-profiles.json");
  writeFileSync(file, JSON.stringify(profilesJson), { mode: 0o600 });
}

/**
 * Write a minimal valid AppConfig YAML pointing the CLI's `dataDir` at
 * `<tempDir>`. This is the ONLY mechanism for isolating doctor from the
 * real `~/.comis` (per `packages/cli/src/commands/doctor.ts:85`
 * `config?.dataDir || os.homedir() + "/.comis"` — there is no dedicated
 * env var for `dataDir`; the field is read only from the loaded config).
 *
 * The YAML lives INSIDE `<tempDir>` so the per-test rmSync cleanup
 * sweeps it (no orphans across test runs).
 *
 * Returns the absolute path to the written YAML.
 */
function writeTempConfig(dataDir: string): string {
  const yamlPath = path.join(dataDir, "config.yaml");
  // Minimal AppConfig — only `dataDir` is meaningful; AppConfigSchema
  // defaults the other fields. We omit `agents` entirely so the schema
  // produces its default `{ default: PerAgentConfigSchema.parse({}) }`,
  // which satisfies the loadConfigFile/validateConfig path.
  writeFileSync(yamlPath, `dataDir: ${dataDir}\n`, { mode: 0o600 });
  return yamlPath;
}

/**
 * Build a non-base64-validated JWT-shaped string that contains the supplied
 * access-token sentinel verbatim in the payload. Used by Test 5 to verify
 * the access value never appears in doctor's JSON output.
 */
function makeSentinelJwt(payloadOverrides: Record<string, unknown> = {}): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const fullPayload = {
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    "https://api.openai.com/profile": { email: "user_a@example.com" },
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_test_001" },
    ...payloadOverrides,
  };
  const payloadB64 = Buffer.from(JSON.stringify(fullPayload)).toString(
    "base64url",
  );
  return `${header}.${payloadB64}.fake-signature`;
}

/**
 * Parse the doctor's stdout as DoctorJsonOutput. The CLI may print
 * additional non-JSON status lines (e.g. spinner output) before the JSON
 * payload; defensively extract the first balanced JSON object so the
 * assertion failure messages stay informative when the shape drifts.
 */
function parseDoctorJson(stdout: string): DoctorJsonOutput {
  // Greedy match the outermost JSON object — renderDoctorJson uses
  // JSON.stringify(..., null, 2) so it occupies a single contiguous block.
  const firstBrace = stdout.indexOf("{");
  const lastBrace = stdout.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    throw new Error(
      `Doctor stdout did not contain a JSON object; got: ${stdout.slice(0, 500)}`,
    );
  }
  return JSON.parse(stdout.slice(firstBrace, lastBrace + 1)) as DoctorJsonOutput;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SC-10-2 — comis doctor OAuth health (integration)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "comis-10-06-doctor-"));
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (tmpDir) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });

  it("Test 1: reports per-profile expiry — healthy + near-expiry warn", async () => {
    const now = Date.now();
    seedProfilesFile(tmpDir, {
      version: 1,
      profiles: {
        [PROFILE_A_ID]: {
          provider: PROVIDER_ID,
          profileId: PROFILE_A_ID,
          access: makeSentinelJwt({ "https://api.openai.com/profile": { email: "user_a@example.com" } }),
          refresh: "refresh_a",
          expires: now + 30 * 24 * 60 * 60 * 1000, // 30 days → pass
          accountId: "acct_test_001",
          email: "user_a@example.com",
          version: 1,
        },
        [PROFILE_B_ID]: {
          provider: PROVIDER_ID,
          profileId: PROFILE_B_ID,
          access: makeSentinelJwt({ "https://api.openai.com/profile": { email: "user_b@example.com" } }),
          refresh: "refresh_b",
          expires: now + 3 * 24 * 60 * 60 * 1000, // 3 days → warn (<7d)
          accountId: "acct_test_002",
          email: "user_b@example.com",
          version: 1,
        },
      },
    });
    const tempConfigYaml = writeTempConfig(tmpDir);

    const { stdout } = await runDoctor({
      COMIS_CONFIG_PATHS: tempConfigYaml,
    });
    const json = parseDoctorJson(stdout);
    const oauthFindings = json.findings.filter((f) => f.category === "oauth");
    // 2 profile findings + ca-certificates + HTTPS_PROXY + TLS preflight = ≥5
    expect(oauthFindings.length).toBeGreaterThanOrEqual(2);

    const profileA = oauthFindings.find((f) =>
      f.check.includes(PROFILE_A_ID),
    );
    const profileB = oauthFindings.find((f) =>
      f.check.includes(PROFILE_B_ID),
    );
    expect(profileA, "expected profile A finding").toBeDefined();
    expect(profileB, "expected profile B finding").toBeDefined();
    expect(profileA!.status).toBe("pass");
    expect(profileB!.status).toBe("warn");
    expect(profileB!.suggestion).toContain("comis auth login");

    // SC-10-2 contract: profile findings carry numeric `secsUntilExpiry`.
    expect(typeof profileA!.secsUntilExpiry).toBe("number");
    expect(typeof profileB!.secsUntilExpiry).toBe("number");
    // 3 days < secsUntilExpiry < 30 days for the near-expiry profile.
    expect(profileB!.secsUntilExpiry!).toBeGreaterThan(0);
    expect(profileB!.secsUntilExpiry!).toBeLessThan(7 * 24 * 60 * 60);
  });

  it("Test 2: surfaces schema-version mismatch verbatim from adapter", async () => {
    // Adapter throws a hard-fail Error with 'version mismatch' substring
    // (oauth-credential-store-file.ts:177) — doctor surfaces it verbatim
    // through a fail finding (per Phase 7 D-07 hint-preservation contract).
    seedProfilesFile(tmpDir, { version: 99, profiles: {} });
    const tempConfigYaml = writeTempConfig(tmpDir);

    const { stdout } = await runDoctor({
      COMIS_CONFIG_PATHS: tempConfigYaml,
    });
    const json = parseDoctorJson(stdout);
    const oauthFindings = json.findings.filter((f) => f.category === "oauth");
    const failFinding = oauthFindings.find((f) => f.status === "fail");
    expect(failFinding, "expected schema-mismatch fail finding").toBeDefined();
    expect(failFinding!.message).toContain("version mismatch");
  });

  it("Test 3: --refresh-test default OFF — no refresh-test findings without flag", async () => {
    seedProfilesFile(tmpDir, {
      version: 1,
      profiles: {
        [PROFILE_A_ID]: {
          provider: PROVIDER_ID,
          profileId: PROFILE_A_ID,
          access: makeSentinelJwt(),
          refresh: "refresh_a",
          expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
          accountId: "acct_test_001",
          email: "user_a@example.com",
          version: 1,
        },
      },
    });
    const tempConfigYaml = writeTempConfig(tmpDir);

    // Note: no --refresh-test arg — D-10-04-01 default OFF.
    const { stdout } = await runDoctor({
      COMIS_CONFIG_PATHS: tempConfigYaml,
    });
    const json = parseDoctorJson(stdout);
    const refreshTestFindings = json.findings.filter(
      (f) =>
        f.category === "oauth" &&
        f.check.toLowerCase().includes("refresh test"),
    );
    expect(refreshTestFindings).toHaveLength(0);
  });

  it("Test 4: TLS preflight finding emitted (status varies with network)", async () => {
    // Empty store but valid schema — the TLS preflight + ca-certificates +
    // HTTPS_PROXY env-checks still run.
    seedProfilesFile(tmpDir, { version: 1, profiles: {} });
    const tempConfigYaml = writeTempConfig(tmpDir);

    const { stdout } = await runDoctor({
      COMIS_CONFIG_PATHS: tempConfigYaml,
    });
    const json = parseDoctorJson(stdout);
    const tlsFinding = json.findings.find(
      (f) => f.category === "oauth" && f.check === "TLS preflight",
    );
    // Asserting only EXISTENCE — status varies with network reachability
    // to auth.openai.com (D-10-04-04 acceptable indeterminism).
    expect(tlsFinding, "expected TLS preflight finding").toBeDefined();
  });

  it("Test 5: no token leakage in JSON output (T-10-03)", async () => {
    seedProfilesFile(tmpDir, {
      version: 1,
      profiles: {
        [PROFILE_A_ID]: {
          provider: PROVIDER_ID,
          profileId: PROFILE_A_ID,
          // CRITICAL: the access token contains the sentinel literal
          // verbatim. The doctor MUST NOT include any access/refresh field
          // in any DoctorFinding. This test pins the contract end-to-end.
          access: SENTINEL_ACCESS_TOKEN,
          refresh: "refresh_a_with_TEST_LEAK_SENTINEL_REFRESH",
          expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
          accountId: "acct_test_001",
          email: "user_a@example.com",
          version: 1,
        },
      },
    });
    const tempConfigYaml = writeTempConfig(tmpDir);

    const { stdout } = await runDoctor({
      COMIS_CONFIG_PATHS: tempConfigYaml,
    });
    // Falsifiable: any leakage of `profile.access` or `profile.refresh`
    // through the doctor's JSON output would surface via this assertion.
    expect(stdout).not.toContain(SENTINEL_ACCESS_TOKEN);
    expect(stdout).not.toContain("TEST_LEAK_SENTINEL_REFRESH");
  });
});
