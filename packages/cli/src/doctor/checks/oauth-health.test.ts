// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth health check unit tests (Plan 10-04 — SC-10-2 + SC-10-1 doctor sub-check).
 *
 * Covers:
 *   - per-profile JWT-expiry sub-check (pass / warn @ <7d / fail when expired)
 *   - SC-10-2 literal `secsUntilExpiry` numeric field on every profile finding
 *   - schema-mismatch surfacing from `port.list()` (Phase 7 D-07 verbatim)
 *   - encrypted-mode skip (Phase 8 D-13 store-direct, no SecretManager bootstrap)
 *   - ca-certificates probe + distro-aware install hints (5-distro switch)
 *   - HTTPS_PROXY env-var heuristic (warn when set, pass when unset)
 *   - TLS preflight delegation to @comis/agent (pass / tls-cert fail / network warn)
 *   - --refresh-test default OFF (D-10-04-01) + opt-in success/failure paths
 *   - NO TOKEN LEAKAGE invariant (T-10-03 / RESEARCH §Pitfall 2)
 *
 * @module
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Result } from "@comis/shared";
import { ok, err } from "@comis/shared";
import type { OAuthProfile, OAuthCredentialStorePort } from "@comis/core";
import type { DoctorContext, DoctorFinding } from "../types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// node:fs/promises — stat (CA bundle paths) and readFile (/etc/os-release)
vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return { ...actual, stat: vi.fn(), readFile: vi.fn() };
});

// @comis/agent — selectOAuthCredentialStore (store IO) + runOAuthTlsPreflight
// (Plan 10-01 helper). decodeCodexJwtPayload, redactEmailForLog, and
// rewriteOAuthError pass through untouched.
vi.mock("@comis/agent", async () => {
  const actual =
    await vi.importActual<typeof import("@comis/agent")>("@comis/agent");
  return {
    ...actual,
    selectOAuthCredentialStore: vi.fn(),
    runOAuthTlsPreflight: vi.fn(),
  };
});

const fs = await import("node:fs/promises");
const agent = await import("@comis/agent");
const { oauthHealthCheck } = await import("./oauth-health.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseContext: DoctorContext = {
  configPaths: [],
  dataDir: "/tmp/test-comis",
  daemonPidFile: "/tmp/test-comis/daemon.pid",
};

function buildProfile(overrides: Partial<OAuthProfile> = {}): OAuthProfile {
  return {
    provider: "openai-codex",
    profileId: "openai-codex:user_a@example.com",
    access: "test-access-token",
    refresh: "test-refresh-token",
    expires: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days out
    accountId: "acct_test_a",
    email: "user_a@example.com",
    displayName: "User A",
    version: 1,
    ...overrides,
  };
}

interface FakeStoreOptions {
  list?: () => Promise<Result<OAuthProfile[], Error>>;
}

function buildStoreMock(opts: FakeStoreOptions = {}): OAuthCredentialStorePort {
  const list =
    opts.list ?? (async () => ok<OAuthProfile[], Error>([]));
  return {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(list),
    has: vi.fn(),
  } as unknown as OAuthCredentialStorePort;
}

function caBundlePresent(): void {
  // Default: first standard path resolves; make stat fulfill.
  vi.mocked(fs.stat).mockImplementation(async () =>
    ({} as unknown as Awaited<ReturnType<typeof fs.stat>>),
  );
}

function caBundleMissing(): void {
  vi.mocked(fs.stat).mockRejectedValue(
    Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
  );
}

function osReleaseDistro(text: string): void {
  vi.mocked(fs.readFile).mockResolvedValue(text);
}

function tlsPreflightOk(): void {
  vi.mocked(agent.runOAuthTlsPreflight).mockResolvedValue({ ok: true });
}

beforeEach(() => {
  vi.mocked(fs.stat).mockReset();
  vi.mocked(fs.readFile).mockReset();
  vi.mocked(agent.selectOAuthCredentialStore).mockReset();
  vi.mocked(agent.runOAuthTlsPreflight).mockReset();
  caBundlePresent();
  tlsPreflightOk();
  // Default store: empty list
  vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(buildStoreMock());
});

// HTTPS_PROXY may leak from the host shell — clear before each test, restore.
const ORIGINAL_HTTPS_PROXY = process.env["HTTPS_PROXY"];
const ORIGINAL_HTTPS_PROXY_LC = process.env["https_proxy"];
beforeEach(() => {
  delete process.env["HTTPS_PROXY"];
  delete process.env["https_proxy"];
});
afterEach(() => {
  if (ORIGINAL_HTTPS_PROXY === undefined) {
    delete process.env["HTTPS_PROXY"];
  } else {
    process.env["HTTPS_PROXY"] = ORIGINAL_HTTPS_PROXY;
  }
  if (ORIGINAL_HTTPS_PROXY_LC === undefined) {
    delete process.env["https_proxy"];
  } else {
    process.env["https_proxy"] = ORIGINAL_HTTPS_PROXY_LC;
  }
});

// Helper: pull profile-expiry findings out of the heterogeneous result list.
function findByCheckPrefix(
  findings: DoctorFinding[],
  prefix: string,
): DoctorFinding[] {
  return findings.filter((f) => f.check.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Profile-expiry sub-check
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — profile expiry", () => {
  it("Test 1 — pass when profile expires in 30 days, secsUntilExpiry numeric", async () => {
    const profile = buildProfile({
      expires: Date.now() + 30 * 24 * 60 * 60 * 1000,
    });
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([profile]) }),
    );
    const findings = await oauthHealthCheck.run(baseContext);
    const profileFindings = findByCheckPrefix(findings, "Profile openai-codex:");
    expect(profileFindings).toHaveLength(1);
    expect(profileFindings[0]!.status).toBe("pass");
    expect(typeof profileFindings[0]!.secsUntilExpiry).toBe("number");
    const expected = Math.floor(
      (profile.expires - Date.now()) / 1000,
    );
    expect(profileFindings[0]!.secsUntilExpiry!).toBeGreaterThan(expected - 5);
    expect(profileFindings[0]!.secsUntilExpiry!).toBeLessThan(expected + 5);
  });

  it("Test 2 — warn when profile expires in 3 days, secsUntilExpiry positive", async () => {
    const profile = buildProfile({
      expires: Date.now() + 3 * 24 * 60 * 60 * 1000,
    });
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([profile]) }),
    );
    const findings = await oauthHealthCheck.run(baseContext);
    const profileFindings = findByCheckPrefix(findings, "Profile openai-codex:");
    expect(profileFindings[0]!.status).toBe("warn");
    expect(profileFindings[0]!.suggestion).toContain("comis auth login");
    expect(profileFindings[0]!.secsUntilExpiry!).toBeGreaterThan(0);
    expect(profileFindings[0]!.secsUntilExpiry!).toBeLessThanOrEqual(
      3 * 86400 + 5,
    );
  });

  it("Test 3 — fail when profile expired 1 hour ago, secsUntilExpiry negative", async () => {
    const profile = buildProfile({
      expires: Date.now() - 60 * 60 * 1000,
    });
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([profile]) }),
    );
    const findings = await oauthHealthCheck.run(baseContext);
    const profileFindings = findByCheckPrefix(findings, "Profile openai-codex:");
    expect(profileFindings[0]!.status).toBe("fail");
    expect(profileFindings[0]!.suggestion).toContain("comis auth login");
    expect(profileFindings[0]!.secsUntilExpiry).toBeLessThan(0);
    expect(profileFindings[0]!.secsUntilExpiry!).toBeGreaterThan(-3600 - 60);
  });

  it("Test 4 — NO TOKEN LEAKAGE: TEST_LEAK_SENTINEL never appears in any finding", async () => {
    const profile = buildProfile({
      access: "TEST_LEAK_SENTINEL_ACCESS_xxxxxxxx",
      refresh: "TEST_LEAK_SENTINEL_REFRESH_yyyyyyyy",
    });
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([profile]) }),
    );
    const findings = await oauthHealthCheck.run(baseContext);
    for (const f of findings) {
      expect(f.message).not.toContain("TEST_LEAK_SENTINEL");
      expect(f.suggestion ?? "").not.toContain("TEST_LEAK_SENTINEL");
      expect(f.check).not.toContain("TEST_LEAK_SENTINEL");
    }
  });

  it("Test 18 — empty store yields a single skip", async () => {
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([]) }),
    );
    const findings = await oauthHealthCheck.run(baseContext);
    const inventory = findings.find(
      (f) => f.check === "Profile inventory" || f.message.includes("No OAuth profiles stored"),
    );
    expect(inventory).toBeDefined();
    expect(inventory!.status).toBe("skip");
    expect(inventory!.message).toContain("No OAuth profiles stored");
  });
});

// ---------------------------------------------------------------------------
// Schema-mismatch sub-check
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — schema mismatch", () => {
  it("Test 5 — surfaces adapter hard-fail message verbatim", async () => {
    const adapterError = new Error(
      "OAuth profile store version mismatch: expected 1, got 99. " +
        "Hint: delete ~/.comis/auth-profiles.json and re-run comis auth login",
    );
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({
        list: async () => err<Error, OAuthProfile[]>(adapterError),
      }),
    );
    const findings = await oauthHealthCheck.run(baseContext);
    const schemaFinding = findings.find(
      (f) => f.check.toLowerCase().includes("schema") || f.message.includes("version mismatch"),
    );
    expect(schemaFinding).toBeDefined();
    expect(schemaFinding!.status).toBe("fail");
    expect(schemaFinding!.message).toContain("version mismatch");
    expect(schemaFinding!.message).toContain("Hint:");
  });
});

// ---------------------------------------------------------------------------
// Encrypted-mode skip
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — encrypted-mode skip", () => {
  it("Test 6 — encrypted storage yields one skip explaining CLI cannot read", async () => {
    const ctx: DoctorContext = {
      ...baseContext,
      // Minimal config shape that exposes oauth.storage; cast to avoid
      // building a full AppConfig.
      config: { oauth: { storage: "encrypted" } } as unknown as DoctorContext["config"],
    };
    const findings = await oauthHealthCheck.run(ctx);
    const skip = findings.find(
      (f) => f.status === "skip" && /encrypted/i.test(f.message),
    );
    expect(skip).toBeDefined();
    expect(skip!.suggestion ?? "").toContain("daemon host");
  });
});

// ---------------------------------------------------------------------------
// ca-certificates sub-check
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — ca-certificates", () => {
  it("Test 7 — pass when standard CA bundle path stat succeeds", async () => {
    caBundlePresent();
    const findings = await oauthHealthCheck.run(baseContext);
    const caFinding = findings.find((f) => f.check === "ca-certificates");
    expect(caFinding).toBeDefined();
    expect(caFinding!.status).toBe("pass");
    expect(caFinding!.message).toMatch(/\/etc\/ssl/);
  });

  it("Test 8 — fail with alpine hint when no bundle and ID=alpine", async () => {
    caBundleMissing();
    osReleaseDistro("ID=alpine\nID_LIKE=\n");
    const findings = await oauthHealthCheck.run(baseContext);
    const caFinding = findings.find((f) => f.check === "ca-certificates");
    expect(caFinding!.status).toBe("fail");
    expect(caFinding!.suggestion).toContain("apk add ca-certificates");
  });

  it("Test 9 — fail with debian/ubuntu hint when ID_LIKE=debian", async () => {
    caBundleMissing();
    osReleaseDistro('ID=ubuntu\nID_LIKE="debian"\n');
    const findings = await oauthHealthCheck.run(baseContext);
    const caFinding = findings.find((f) => f.check === "ca-certificates");
    expect(caFinding!.status).toBe("fail");
    expect(caFinding!.suggestion).toContain("apt-get install -y ca-certificates");
  });
});

// ---------------------------------------------------------------------------
// HTTPS_PROXY heuristic
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — HTTPS_PROXY heuristic", () => {
  it("Test 10 — pass when env vars unset", async () => {
    const findings = await oauthHealthCheck.run(baseContext);
    const proxyFinding = findings.find((f) => f.check === "HTTPS_PROXY");
    expect(proxyFinding).toBeDefined();
    expect(proxyFinding!.status).toBe("pass");
  });

  it("Test 11 — warn when HTTPS_PROXY is set", async () => {
    process.env["HTTPS_PROXY"] = "http://proxy.example.com:3128";
    const findings = await oauthHealthCheck.run(baseContext);
    const proxyFinding = findings.find((f) => f.check === "HTTPS_PROXY");
    expect(proxyFinding!.status).toBe("warn");
    expect(proxyFinding!.message).toContain("ignores it by default");
  });
});

// ---------------------------------------------------------------------------
// TLS preflight sub-check
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — TLS preflight", () => {
  it("Test 12 — pass when preflight ok", async () => {
    vi.mocked(agent.runOAuthTlsPreflight).mockResolvedValue({ ok: true });
    const findings = await oauthHealthCheck.run(baseContext);
    const tlsFinding = findings.find((f) => f.check === "TLS preflight");
    expect(tlsFinding!.status).toBe("pass");
    expect(tlsFinding!.message).toContain("auth.openai.com");
  });

  it("Test 13 — fail with distro hint on tls-cert failure (ubuntu)", async () => {
    vi.mocked(agent.runOAuthTlsPreflight).mockResolvedValue({
      ok: false,
      kind: "tls-cert",
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      message: "unable to get local issuer certificate",
    });
    osReleaseDistro('ID=ubuntu\nID_LIKE="debian"\n');
    const findings = await oauthHealthCheck.run(baseContext);
    const tlsFinding = findings.find((f) => f.check === "TLS preflight");
    expect(tlsFinding!.status).toBe("fail");
    expect(tlsFinding!.suggestion).toContain("apt-get install");
  });

  it("Test 14 — warn on network failure with firewall/DNS hint", async () => {
    vi.mocked(agent.runOAuthTlsPreflight).mockResolvedValue({
      ok: false,
      kind: "network",
      message: "ECONNREFUSED",
    });
    const findings = await oauthHealthCheck.run(baseContext);
    const tlsFinding = findings.find((f) => f.check === "TLS preflight");
    expect(tlsFinding!.status).toBe("warn");
    expect(
      tlsFinding!.suggestion!.toLowerCase().includes("firewall") ||
        tlsFinding!.suggestion!.toLowerCase().includes("dns"),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// --refresh-test branch (D-10-04-01: default OFF)
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — --refresh-test (D-10-04-01 default OFF)", () => {
  it("Test 15 — default OFF: NO refresh-test findings", async () => {
    const profile = buildProfile();
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([profile]) }),
    );
    const findings = await oauthHealthCheck.run(baseContext); // refreshTest unset
    const refreshFindings = findings.filter((f) => f.check.includes("refresh test"));
    expect(refreshFindings).toHaveLength(0);
  });

  it("Test 16 — opt-in success: WARNING about token rotation in suggestion", async () => {
    const profile = buildProfile();
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([profile]) }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    try {
      const findings = await oauthHealthCheck.run({
        ...baseContext,
        refreshTest: true,
      });
      const refreshFinding = findings.find((f) => f.check.includes("refresh test"));
      expect(refreshFinding).toBeDefined();
      expect(refreshFinding!.status).toBe("pass");
      expect(refreshFinding!.suggestion).toContain(
        "WARNING: refresh token at OpenAI was rotated",
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("Test 17 — opt-in failure (refresh_token_reused) → fail with re-login command", async () => {
    const profile = buildProfile();
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([profile]) }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "refresh_token_reused",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    try {
      const findings = await oauthHealthCheck.run({
        ...baseContext,
        refreshTest: true,
      });
      const refreshFinding = findings.find((f) => f.check.includes("refresh test"));
      expect(refreshFinding).toBeDefined();
      expect(refreshFinding!.status).toBe("fail");
      expect(refreshFinding!.message).toContain(
        "comis auth login --provider openai-codex",
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
