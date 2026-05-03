// SPDX-License-Identifier: Apache-2.0
/**
 * OAuth health check for `comis doctor` (Phase 10 SC-10-2 + SC-10-1 doctor sub-check).
 *
 * Per-profile diagnostics: JWT decode → expiry + numeric `secsUntilExpiry`;
 * flag profiles expiring < 7 days as warn, expired as fail; surface
 * schema-version mismatch from the file adapter's hard-fail (Phase 7 D-07
 * verbatim — `port.list()` returns `err()` whose message already contains
 * the version + remediation hint). Environmental sub-checks: ca-certificates
 * bundle existence with distro-aware install hint, HTTPS_PROXY env-var
 * heuristic (Phase 10 RESEARCH §Pitfall 1 — Node's built-in fetch ignores
 * HTTPS_PROXY by default), TLS preflight against `auth.openai.com`
 * (delegates to Plan 10-01's `runOAuthTlsPreflight`).
 *
 * Optional `--refresh-test` flag (default OFF per D-10-04-01): exercises
 * a real OAuth refresh against the provider; rotates the refresh token at
 * OpenAI's end as a side effect (D-10-04-02 warns operator in --help).
 * Doctor does NOT persist the new credentials (D-10-04-03 — Pitfall 3
 * Option A); the success suggestion warns the stored token is now stale.
 *
 * Storage mode handling (Phase 8 D-13): the CLI process cannot bootstrap
 * the encrypted secrets store without `SECRETS_MASTER_KEY`, so when
 * `appConfig.oauth.storage === "encrypted"` the per-profile sub-check
 * returns a single skip finding pointing the operator at the daemon host.
 *
 * NEVER prints `profile.access` or `profile.refresh` in any DoctorFinding
 * field — defense per RESEARCH §Pitfall 2 / T-10-03. Identity labels go
 * through `redactEmailForLog`. Test 4 in oauth-health.test.ts asserts no
 * `TEST_LEAK_SENTINEL` substring leakage.
 *
 * @module
 */

import { stat, readFile } from "node:fs/promises";
import {
  selectOAuthCredentialStore,
  redactEmailForLog,
  runOAuthTlsPreflight,
  rewriteOAuthError,
} from "@comis/agent";
import type {
  OAuthProfile,
  OAuthCredentialStorePort,
} from "@comis/core";
import type { DoctorCheck, DoctorContext, DoctorFinding } from "../types.js";
import { formatRelativeExpiry } from "../../output/relative-time.js";

const CATEGORY = "oauth";
const NEAR_EXPIRY_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_TEST_TIMEOUT_MS = 10_000;
const TLS_PREFLIGHT_TIMEOUT_MS = 5_000;

// Public OpenAI Codex client_id — same value pi-ai uses; using our own
// would fingerprint Comis traffic in OpenAI's logs (RESEARCH §Q6 T-10-01).
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";

const CA_BUNDLE_PATHS = [
  "/etc/ssl/certs/ca-certificates.crt", // Debian/Ubuntu
  "/etc/ssl/cert.pem", // Alpine, macOS, FreeBSD
  "/etc/pki/tls/certs/ca-bundle.crt", // RHEL/CentOS/Fedora
  "/etc/ssl/ca-bundle.pem", // openSUSE
];

/**
 * Doctor check: OAuth subsystem health.
 *
 * Returns 4 baseline sub-checks (per-profile expiry × N + ca-certificates +
 * HTTPS_PROXY + TLS preflight); +N when `context.refreshTest === true`.
 * Never throws — every failure path returns a finding.
 */
export const oauthHealthCheck: DoctorCheck = {
  id: "oauth-health",
  name: "OAuth",
  run: async (context) => {
    const findings: DoctorFinding[] = [];

    // Sub-check 1: schema integrity + per-profile expiry (uses port.list())
    findings.push(...(await checkProfiles(context)));

    // Sub-check 2: ca-certificates bundle on disk
    findings.push(await checkCaBundle());

    // Sub-check 3: HTTPS_PROXY env-var heuristic (RESEARCH §Pitfall 1)
    findings.push(checkHttpsProxyHeuristic());

    // Sub-check 4: TLS preflight against auth.openai.com (Plan 10-01 helper)
    findings.push(await checkTlsPreflight());

    return findings;
  },
};

// ---------------------------------------------------------------------------
// Sub-check: per-profile expiry + schema-mismatch surfacing
// ---------------------------------------------------------------------------

async function checkProfiles(
  context: DoctorContext,
): Promise<DoctorFinding[]> {
  const findings: DoctorFinding[] = [];

  const storage = (context.config?.oauth?.storage ?? "file") as
    | "file"
    | "encrypted";

  if (storage === "encrypted") {
    // Phase 8 D-13: CLI cannot bootstrap encrypted store without
    // SECRETS_MASTER_KEY. Surface as skip + operator hint (D-10-04-04 —
    // doctor reads only the active store, does not cross-check inactive).
    return [
      {
        category: CATEGORY,
        check: "Profile store",
        status: "skip",
        message:
          "OAuth storage mode is 'encrypted' — doctor cannot read profiles from CLI",
        suggestion:
          "Run doctor on the daemon host (with SECRETS_MASTER_KEY set), " +
          "or set oauth.storage to 'file' to use the plaintext file backend.",
        repairable: false,
      },
    ];
  }

  // Open the store using the same selector daemon + auth CLI use (Phase 8 D-13).
  let store: OAuthCredentialStorePort;
  try {
    store = selectOAuthCredentialStore({
      storage: "file",
      dataDir: context.dataDir,
    });
  } catch (e) {
    return [
      {
        category: CATEGORY,
        check: "Profile store",
        status: "fail",
        message: `Failed to open OAuth store: ${e instanceof Error ? e.message : String(e)}`,
        repairable: false,
      },
    ];
  }

  // Per Phase 7 D-07: port.list() returns err() with the version-mismatch
  // hint baked into the error message — surface verbatim. NO migration logic.
  const listResult = await store.list();
  if (!listResult.ok) {
    findings.push({
      category: CATEGORY,
      check: "Profile schema",
      status: "fail",
      message: listResult.error.message, // e.g. "version mismatch: ... Hint: delete X and re-run comis auth login"
      repairable: false,
    });
    return findings; // can't iterate profiles after schema-mismatch
  }

  if (listResult.value.length === 0) {
    findings.push({
      category: CATEGORY,
      check: "Profile inventory",
      status: "skip",
      message: "No OAuth profiles stored",
      repairable: false,
    });
    return findings;
  }

  // Per-profile expiry + identity reporting; +refresh-test when opted in.
  for (const profile of listResult.value) {
    findings.push(profileExpiryFinding(profile));
    if (context.refreshTest === true) {
      findings.push(await refreshTestFinding(profile));
    }
  }

  return findings;
}

/**
 * Build a DoctorFinding for a single profile's expiry status.
 *
 * Status ladder:
 *   - msUntilExpiry <= 0  → fail (re-login required)
 *   - msUntilExpiry < 7d  → warn (refresh proactively)
 *   - else                → pass
 *
 * Always populates the SC-10-2 literal numeric field `secsUntilExpiry`.
 * Sign is preserved (negative for already-expired) so consumers can
 * distinguish "expired 1h ago" from "expired 30d ago" without parsing
 * the human-readable message.
 */
function profileExpiryFinding(profile: OAuthProfile): DoctorFinding {
  const msUntilExpiry = profile.expires - Date.now();
  const secsUntilExpiry = Math.floor(msUntilExpiry / 1000);
  const identityLabel = redactEmailForLog(profile.email) ?? profile.profileId;
  // CRITICAL (RESEARCH §Pitfall 2 / T-10-03): NEVER include profile.access
  // or profile.refresh in any DoctorFinding field. Use only profileId,
  // redacted email, and the expiry timestamp.

  if (msUntilExpiry <= 0) {
    return {
      category: CATEGORY,
      check: `Profile ${profile.profileId}`,
      status: "fail",
      message: `Profile ${profile.profileId} (${identityLabel}) expired ${formatRelativeExpiry(profile.expires)}`,
      suggestion: `Re-authenticate: comis auth login --provider ${profile.provider}`,
      repairable: false,
      secsUntilExpiry,
    };
  }

  if (msUntilExpiry < NEAR_EXPIRY_THRESHOLD_MS) {
    return {
      category: CATEGORY,
      check: `Profile ${profile.profileId}`,
      status: "warn",
      message: `Profile ${profile.profileId} (${identityLabel}) expires in ${formatRelativeExpiry(profile.expires)}`,
      suggestion: `Refresh proactively: comis auth login --provider ${profile.provider}`,
      repairable: false,
      secsUntilExpiry,
    };
  }

  return {
    category: CATEGORY,
    check: `Profile ${profile.profileId}`,
    status: "pass",
    message: `Profile ${profile.profileId} (${identityLabel}) expires in ${formatRelativeExpiry(profile.expires)}`,
    repairable: false,
    secsUntilExpiry,
  };
}

/**
 * Run a real OAuth refresh against `auth.openai.com` per profile.
 *
 * D-10-04-01: opt-in only (gated by `--refresh-test` flag).
 * D-10-04-02: --help text in `commands/doctor.ts` warns operator.
 * D-10-04-03: doctor does NOT persist the new tokens. Subsequent LLM
 * calls will hit refresh_token_reused on the stored (now-stale) token.
 *
 * Duplicates ~30 LoC of refresh-POST machinery from Plan 10-03's
 * `refreshOpenAICodexTokenLocal`. Per AGENTS.md §2.3 rule of three, two
 * call-sites is below the extraction threshold — duplicate over premature
 * abstraction.
 *
 * NEVER prints `profile.refresh` in any returned finding.
 */
async function refreshTestFinding(
  profile: OAuthProfile,
): Promise<DoctorFinding> {
  const identityLabel = redactEmailForLog(profile.email) ?? profile.profileId;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: profile.refresh,
    client_id: OPENAI_CODEX_CLIENT_ID,
  });
  try {
    const response = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(REFRESH_TEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let parsed: { error?: string; error_description?: string } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        // Body wasn't JSON — fall back to status code.
      }
      const classifyMessage =
        parsed.error_description ?? parsed.error ?? `HTTP ${response.status}`;
      const rewritten = rewriteOAuthError(new Error(classifyMessage));
      return {
        category: CATEGORY,
        check: `Profile ${profile.profileId} refresh test`,
        status: "fail",
        message: `Refresh test for ${identityLabel} failed (${rewritten.errorKind}): ${rewritten.userMessage}`,
        suggestion: rewritten.hint,
        repairable: false,
      };
    }
    // Success: token rotated at OpenAI's end. We are NOT persisting
    // (D-10-04-03) — surface the side effect explicitly.
    return {
      category: CATEGORY,
      check: `Profile ${profile.profileId} refresh test`,
      status: "pass",
      message: `Refresh test for ${identityLabel} succeeded`,
      suggestion:
        "WARNING: refresh token at OpenAI was rotated. The stored token " +
        "is now stale; the next LLM call will trigger a real refresh.",
      repairable: false,
    };
  } catch (e) {
    return {
      category: CATEGORY,
      check: `Profile ${profile.profileId} refresh test`,
      status: "fail",
      message: `Refresh test for ${identityLabel} threw: ${e instanceof Error ? e.message : String(e)}`,
      suggestion:
        "Check network reachability to auth.openai.com and retry without " +
        "--refresh-test for a pure-local check.",
      repairable: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Sub-check: ca-certificates bundle existence + distro-aware install hint
// ---------------------------------------------------------------------------

async function checkCaBundle(): Promise<DoctorFinding> {
  for (const p of CA_BUNDLE_PATHS) {
    try {
      await stat(p);
      return {
        category: CATEGORY,
        check: "ca-certificates",
        status: "pass",
        message: `CA bundle present at ${p}`,
        repairable: false,
      };
    } catch {
      // Try next path
    }
  }
  const os = await readOsRelease();
  return {
    category: CATEGORY,
    check: "ca-certificates",
    status: "fail",
    message:
      "No system CA bundle found at any standard location -- TLS verification will fail",
    suggestion: caCertificatesInstallHint(os),
    repairable: false,
  };
}

interface OsRelease {
  id: string;
  idLike: string[];
}

async function readOsRelease(
  path = "/etc/os-release",
): Promise<OsRelease | null> {
  try {
    const text = await readFile(path, "utf-8");
    const map = new Map<string, string>();
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) map.set(m[1]!, m[2]!.replace(/^"|"$/g, ""));
    }
    const id = map.get("ID") ?? "";
    const idLike = (map.get("ID_LIKE") ?? "").split(/\s+/).filter(Boolean);
    return { id, idLike };
  } catch {
    return null;
  }
}

function caCertificatesInstallHint(os: OsRelease | null): string {
  if (!os) {
    return "Install ca-certificates via your distro's package manager and retry";
  }
  const idChain = [os.id, ...os.idLike];
  if (idChain.includes("alpine")) {
    return "apk add ca-certificates && update-ca-certificates";
  }
  if (idChain.includes("debian") || idChain.includes("ubuntu")) {
    return "sudo apt-get install -y ca-certificates && sudo update-ca-certificates";
  }
  if (
    idChain.includes("fedora") ||
    idChain.includes("rhel") ||
    idChain.includes("centos")
  ) {
    return "sudo dnf install -y ca-certificates && sudo update-ca-trust";
  }
  if (idChain.includes("arch")) {
    return "sudo pacman -S ca-certificates && sudo trust extract-compat";
  }
  if (idChain.includes("suse") || idChain.includes("opensuse")) {
    return "sudo zypper install ca-certificates && sudo update-ca-certificates";
  }
  return "Install ca-certificates via your distro's package manager and retry";
}

// ---------------------------------------------------------------------------
// Sub-check: HTTPS_PROXY env-var heuristic
// ---------------------------------------------------------------------------

function checkHttpsProxyHeuristic(): DoctorFinding {
  // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
  const httpsProxy = process.env["HTTPS_PROXY"] ?? process.env["https_proxy"];
  if (!httpsProxy) {
    return {
      category: CATEGORY,
      check: "HTTPS_PROXY",
      status: "pass",
      message: "HTTPS_PROXY not set (no proxy expected)",
      repairable: false,
    };
  }
  return {
    category: CATEGORY,
    check: "HTTPS_PROXY",
    status: "warn",
    message: `HTTPS_PROXY is set (${httpsProxy}) but Node's built-in fetch ignores it by default`,
    suggestion:
      "Either install undici and call setGlobalDispatcher(new EnvHttpProxyAgent()) at startup, " +
      "or rely on a system-wide proxy. See docs/operations/proxy.md (Phase 12).",
    repairable: false,
  };
}

// ---------------------------------------------------------------------------
// Sub-check: TLS preflight (delegates to Plan 10-01 helper)
// ---------------------------------------------------------------------------

async function checkTlsPreflight(): Promise<DoctorFinding> {
  const result = await runOAuthTlsPreflight({
    timeoutMs: TLS_PREFLIGHT_TIMEOUT_MS,
  });
  if (result.ok) {
    return {
      category: CATEGORY,
      check: "TLS preflight",
      status: "pass",
      message: "TLS handshake to auth.openai.com succeeded",
      repairable: false,
    };
  }
  if (result.kind === "tls-cert") {
    return {
      category: CATEGORY,
      check: "TLS preflight",
      status: "fail",
      message: `TLS certificate validation failed: ${result.code ?? "unknown"} (${result.message})`,
      suggestion: caCertificatesInstallHint(await readOsRelease()),
      repairable: false,
    };
  }
  return {
    category: CATEGORY,
    check: "TLS preflight",
    status: "warn",
    message: `Network probe to auth.openai.com failed: ${result.message}`,
    suggestion:
      "Verify DNS, firewall, and proxy settings. Doctor cannot distinguish " +
      "transient outages from persistent network failures.",
    repairable: false,
  };
}
