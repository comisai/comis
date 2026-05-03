// SPDX-License-Identifier: Apache-2.0
/**
 * Boot-time OAuth TLS preflight wiring (Phase 10 SC-10-1).
 *
 * Two helpers exposed for the daemon entry point:
 *
 *   1. `hasAnyOAuthAgent(agents)` — runtime gate. Returns `true` iff at least
 *      one entry in the per-agent map declares a `provider` value that
 *      pi-ai's `getOAuthProvider` recognises as an OAuth provider. Used to
 *      skip the entire preflight (and any outbound network probe) when no
 *      OAuth-using agent is configured.
 *
 *   2. `emitOAuthTlsPreflightWarn(logger)` — fire-and-forget. Calls
 *      `runOAuthTlsPreflight({ timeoutMs: 4000 })` from `@comis/agent`
 *      (Phase 10 R10-01) and surfaces the result via Pino:
 *        - `kind: "tls-cert"` → exactly one WARN with module + errorKind +
 *          distro-aware install hint + OpenSSL `code` + raw `message`.
 *        - `kind: "network"` → a single DEBUG (no WARN — transient failures
 *          should not pollute the boot path; see RESEARCH §Pitfall 4).
 *        - `{ ok: true }` → silent (operators do not want noise on boot).
 *
 * The 4000 ms timeout is intentionally tighter than the CLI doctor variant's
 * 5000 ms (RESEARCH §Pitfall 4) — boot must stay under PM2 / systemd
 * watchdog windows even on the worst case.
 *
 * Distro detection (`/etc/os-release` parser + 5-distro install-hint switch)
 * is duplicated inline from `packages/cli/src/doctor/checks/oauth-health.ts`.
 * Per AGENTS.md §2.3 rule of three, two callers do not yet justify a shared
 * helper. If a third caller appears, extract the pair to
 * `packages/agent/src/model/oauth-os-release.ts`.
 *
 * Per AGENTS.md §2.4 the logger is injected — no `@comis/infra` import.
 *
 * @module
 */
import { readFile } from "node:fs/promises";
import { runOAuthTlsPreflight } from "@comis/agent";
import { getOAuthProvider } from "@mariozechner/pi-ai/oauth";
import type { ComisLogger } from "@comis/infra";
import type { PerAgentConfig } from "@comis/core";

/** Boot-tighter timeout — keeps the preflight inside PM2/systemd watchdog windows. */
const PREFLIGHT_TIMEOUT_MS = 4000;

/** Pino `module` field — operators grep on this to isolate preflight logs. */
const MODULE_NAME = "oauth-tls-preflight";

/**
 * Returns `true` iff at least one agent's `provider` is recognised by pi-ai's
 * `getOAuthProvider` as an OAuth-using provider.
 *
 * Single-source-of-truth check — avoids drift with pi-ai's provider catalogue.
 * When this returns `false`, the daemon skips the preflight entirely (zero
 * outbound probes during boot for OAuth-less deployments).
 */
export function hasAnyOAuthAgent(agents: Record<string, PerAgentConfig>): boolean {
  return Object.values(agents).some((agent) => Boolean(getOAuthProvider(agent.provider)));
}

interface OsRelease {
  id: string;
  idLike: string[];
}

/**
 * Parses `/etc/os-release` into `{ id, idLike }`. Returns `null` on read
 * error (missing file, permission denied, malformed contents).
 *
 * Verbatim duplication from Plan 10-04's `oauth-health.ts` — see module
 * JSDoc for the AGENTS.md §2.3 deferral rationale.
 */
async function readOsRelease(path = "/etc/os-release"): Promise<OsRelease | null> {
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

/**
 * Produces a distro-aware install command for the system CA bundle.
 *
 * Verbatim duplication from Plan 10-04's `oauth-health.ts` — see module
 * JSDoc for the AGENTS.md §2.3 deferral rationale.
 */
function caCertificatesInstallHint(os: OsRelease | null): string {
  if (!os) return "Install ca-certificates via your distro's package manager and retry";
  const idChain = [os.id, ...os.idLike];
  if (idChain.includes("alpine")) return "apk add ca-certificates && update-ca-certificates";
  if (idChain.includes("debian") || idChain.includes("ubuntu")) {
    return "sudo apt-get install -y ca-certificates && sudo update-ca-certificates";
  }
  if (idChain.includes("fedora") || idChain.includes("rhel") || idChain.includes("centos")) {
    return "sudo dnf install -y ca-certificates && sudo update-ca-trust";
  }
  if (idChain.includes("arch")) return "sudo pacman -S ca-certificates && sudo trust extract-compat";
  if (idChain.includes("suse") || idChain.includes("opensuse")) {
    return "sudo zypper install ca-certificates && sudo update-ca-certificates";
  }
  return "Install ca-certificates via your distro's package manager and retry";
}

/**
 * Run the OAuth TLS preflight and emit a single structured log line if it
 * fails. Never throws — `runOAuthTlsPreflight` returns a discriminated union
 * and this function only reads-and-logs.
 *
 * Caller is expected to invoke this fire-and-forget (`void`) AFTER the
 * `"Comis daemon started"` banner so the daemon already counts as healthy
 * to PM2/systemd by the time the probe resolves.
 */
export async function emitOAuthTlsPreflightWarn(logger: ComisLogger): Promise<void> {
  const result = await runOAuthTlsPreflight({ timeoutMs: PREFLIGHT_TIMEOUT_MS });
  if (result.ok) return;
  if (result.kind === "tls-cert") {
    const os = await readOsRelease();
    const hint = caCertificatesInstallHint(os);
    logger.warn(
      {
        module: MODULE_NAME,
        errorKind: "oauth_tls_cert",
        hint,
        code: result.code,
        message: result.message,
      },
      "OAuth TLS preflight failed: system CA bundle cannot validate auth.openai.com",
    );
    return;
  }
  // kind === "network" — transient outage / DNS / firewall. DEBUG only.
  logger.debug(
    {
      module: MODULE_NAME,
      errorKind: "oauth_tls_network",
      message: result.message,
    },
    "OAuth TLS preflight network failure (skipping WARN — likely transient)",
  );
}
