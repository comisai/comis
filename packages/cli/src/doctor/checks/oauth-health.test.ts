// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth health check unit tests.
 *
 * Covers:
 *   - per-profile JWT-expiry sub-check (pass / warn @ <7d / fail when expired)
 *   - literal `secsUntilExpiry` numeric field on every profile finding
 *   - schema-mismatch surfacing from `port.list()` verbatim
 *   - encrypted-mode skip (store-direct, no SecretManager bootstrap)
 *   - ca-certificates probe + distro-aware install hints (5-distro switch)
 *   - HTTPS_PROXY env-var heuristic (warn when set, pass when unset)
 *   - TLS preflight delegation to @comis/agent (pass / tls-cert fail / network warn)
 *   - --refresh-test default OFF + opt-in success/failure paths
 *   - NO TOKEN LEAKAGE invariant
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

vi.mock("@comis/core", async () => {
  const actual =
    await vi.importActual<typeof import("@comis/core")>("@comis/core");
  return {
    ...actual,
    selectOAuthCredentialStore: vi.fn(),
    runOAuthTlsPreflight: vi.fn(),
  };
});

// OBS-4: encrypted-mode oauth check routes through the daemon auth.list RPC.
vi.mock("../../sync-tooling/daemon-guard.js", () => ({
  isDaemonRunning: vi.fn(async () => false),
}));
vi.mock("../../client/rpc-client.js", () => ({
  withClient: vi.fn(async (fn: (c: unknown) => unknown) => fn({})),
  callTyped: vi.fn(async () => ({ profiles: [] })),
}));

const fs = await import("node:fs/promises");
const agent = await import("@comis/core");
const daemonGuard = await import("../../sync-tooling/daemon-guard.js");
const rpcClient = await import("../../client/rpc-client.js");
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
  it("pass when profile expires in 30 days, secsUntilExpiry numeric", async () => {
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

  it("warn when profile expires in 3 days, secsUntilExpiry positive", async () => {
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

  it("fail when profile expired 1 hour ago, secsUntilExpiry negative", async () => {
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

  it("NO TOKEN LEAKAGE: TEST_LEAK_SENTINEL never appears in any finding", async () => {
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

  it("empty store yields a single skip", async () => {
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
  it("surfaces adapter hard-fail message verbatim", async () => {
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

describe("oauthHealthCheck — encrypted mode (OBS-4: route through daemon RPC)", () => {
  const encryptedCtx: DoctorContext = {
    ...baseContext,
    config: { security: { storage: "encrypted" } } as unknown as DoctorContext["config"],
  };

  it("daemon DOWN: skips with a daemon-not-running hint (cannot read from CLI)", async () => {
    vi.mocked(daemonGuard.isDaemonRunning).mockResolvedValue(false);
    const findings = await oauthHealthCheck.run(encryptedCtx);
    const skip = findings.find(
      (f) => f.status === "skip" && /encrypted/i.test(f.message),
    );
    expect(skip).toBeDefined();
    expect(skip!.message).toMatch(/daemon is not running/i);
  });

  it("daemon UP: reads profiles via auth.list RPC and reports per-profile expiry (NOT a skip)", async () => {
    // Pre-OBS-4 this ALWAYS returned a single skip regardless of the daemon.
    vi.mocked(daemonGuard.isDaemonRunning).mockResolvedValue(true);
    vi.mocked(rpcClient.callTyped).mockResolvedValue({
      profiles: [
        {
          provider: "openai-codex",
          profileId: "openai-codex:user@example.com",
          expires: Date.now() + 9 * 24 * 60 * 60 * 1000, // 9d out → pass
          email: "user@example.com",
        },
      ],
    });
    const findings = await oauthHealthCheck.run(encryptedCtx);
    const profileFinding = findings.find((f) =>
      f.check.startsWith("Profile openai-codex:"),
    );
    expect(profileFinding).toBeDefined();
    expect(profileFinding!.status).toBe("pass");
    // And it must NOT be the old unconditional encrypted skip.
    expect(
      findings.some((f) => /doctor cannot read profiles from CLI/i.test(f.message)),
    ).toBe(false);
  });

  it("daemon UP but no profiles: honest 'No OAuth profiles stored' skip", async () => {
    vi.mocked(daemonGuard.isDaemonRunning).mockResolvedValue(true);
    vi.mocked(rpcClient.callTyped).mockResolvedValue({ profiles: [] });
    const findings = await oauthHealthCheck.run(encryptedCtx);
    expect(findings.some((f) => /No OAuth profiles stored/i.test(f.message))).toBe(true);
  });
  // (Token-leakage invariant is covered by the dedicated suite below + the
  // RedactedOAuthProfile RPC projection, which carries no access/refresh fields.)
});

// ---------------------------------------------------------------------------
// ca-certificates sub-check
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — ca-certificates", () => {
  it("pass when standard CA bundle path stat succeeds", async () => {
    caBundlePresent();
    const findings = await oauthHealthCheck.run(baseContext);
    const caFinding = findings.find((f) => f.check === "ca-certificates");
    expect(caFinding).toBeDefined();
    expect(caFinding!.status).toBe("pass");
    expect(caFinding!.message).toMatch(/\/etc\/ssl/);
  });

  it("fail with alpine hint when no bundle and ID=alpine", async () => {
    caBundleMissing();
    osReleaseDistro("ID=alpine\nID_LIKE=\n");
    const findings = await oauthHealthCheck.run(baseContext);
    const caFinding = findings.find((f) => f.check === "ca-certificates");
    expect(caFinding!.status).toBe("fail");
    expect(caFinding!.suggestion).toContain("apk add ca-certificates");
  });

  it("fail with debian/ubuntu hint when ID_LIKE=debian", async () => {
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
  it("pass when env vars unset", async () => {
    const findings = await oauthHealthCheck.run(baseContext);
    const proxyFinding = findings.find((f) => f.check === "HTTPS_PROXY");
    expect(proxyFinding).toBeDefined();
    expect(proxyFinding!.status).toBe("pass");
  });

  it("warn when HTTPS_PROXY is set", async () => {
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
  it("pass when preflight ok", async () => {
    vi.mocked(agent.runOAuthTlsPreflight).mockResolvedValue({ ok: true });
    const findings = await oauthHealthCheck.run(baseContext);
    const tlsFinding = findings.find((f) => f.check === "TLS preflight");
    expect(tlsFinding!.status).toBe("pass");
    expect(tlsFinding!.message).toContain("auth.openai.com");
  });

  it("fail with distro hint on tls-cert failure (ubuntu)", async () => {
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

  it("warn on network failure with firewall/DNS hint", async () => {
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
// Env-mode skip
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — env-mode skip", () => {
  it("env storage returns exactly one skip with check 'Profile store' and message containing 'env'", async () => {
    const ctx: DoctorContext = {
      ...baseContext,
      config: { security: { storage: "env" } } as unknown as DoctorContext["config"],
    };
    const findings = await oauthHealthCheck.run(ctx);
    const profileStoreFindings = findings.filter((f) => f.check === "Profile store");
    expect(profileStoreFindings).toHaveLength(1);
    expect(profileStoreFindings[0]!.status).toBe("skip");
    expect(profileStoreFindings[0]!.message).toContain("env");
  });

  it("env storage does NOT call selectOAuthCredentialStore (no store opened)", async () => {
    const ctx: DoctorContext = {
      ...baseContext,
      config: { security: { storage: "env" } } as unknown as DoctorContext["config"],
    };
    await oauthHealthCheck.run(ctx);
    expect(agent.selectOAuthCredentialStore).not.toHaveBeenCalled();
  });

  it("env storage skip has a suggestion pointing to file or encrypted", async () => {
    const ctx: DoctorContext = {
      ...baseContext,
      config: { security: { storage: "env" } } as unknown as DoctorContext["config"],
    };
    const findings = await oauthHealthCheck.run(ctx);
    const profileStoreSkip = findings.find((f) => f.check === "Profile store");
    expect(profileStoreSkip!.suggestion).toBeDefined();
    expect(profileStoreSkip!.suggestion!.toLowerCase()).toMatch(/file|encrypted/);
  });
});

// ---------------------------------------------------------------------------
// --refresh-test branch (default OFF)
// ---------------------------------------------------------------------------

describe("oauthHealthCheck — --refresh-test default OFF", () => {
  it("default OFF: NO refresh-test findings", async () => {
    const profile = buildProfile();
    vi.mocked(agent.selectOAuthCredentialStore).mockReturnValue(
      buildStoreMock({ list: async () => ok([profile]) }),
    );
    const findings = await oauthHealthCheck.run(baseContext); // refreshTest unset
    const refreshFindings = findings.filter((f) => f.check.includes("refresh test"));
    expect(refreshFindings).toHaveLength(0);
  });

  it("opt-in success: WARNING about token rotation in suggestion", async () => {
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

  it("opt-in failure (refresh_token_reused) → fail with re-login command", async () => {
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
