// SPDX-License-Identifier: Apache-2.0
/**
 * Boot-time OAuth TLS preflight wiring.
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
 *      and surfaces the result via Pino:
 *        - `kind: "tls-cert"` → exactly one WARN with module + errorKind +
 *          distro-aware install hint + recognized OpenSSL `code`.
 *        - `kind: "network"` → a single DEBUG (no WARN — transient failures
 *          should not pollute the boot path).
 *        - `{ ok: true }` → silent (operators do not want noise on boot).
 *
 * The 4000 ms timeout is intentionally tighter than the CLI doctor variant's
 * 5000 ms so this optional network probe cannot delay startup diagnostics.
 *
 * Distro detection (`/etc/os-release` parser + 5-distro install-hint switch)
 * is duplicated inline from `packages/cli/src/doctor/checks/oauth-health.ts`.
 * Two callers do not yet justify a shared helper (rule of three). If a third
 * caller appears, extract the pair to
 * `packages/agent/src/model/oauth-os-release.ts`.
 *
 * The logger is injected — no `@comis/infra` import.
 *
 * @module
 */
import { readFile } from "node:fs/promises";
import { runOAuthTlsPreflight } from "@comis/core";
import { getOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { ComisLogger } from "@comis/infra";
import type { PerAgentConfig } from "@comis/core";

/** Bounded timeout for the optional boot-time network probe. */
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
 * Verbatim duplication from `oauth-health.ts` — see module JSDoc for the
 * rule-of-three deferral rationale.
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
 * Verbatim duplication from `oauth-health.ts` — see module JSDoc for the
 * rule-of-three deferral rationale.
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
 * Caller invokes this fire-and-forget (`void`) after the
 * `"Comis daemon started"` banner so it never blocks gateway startup.
 */
export async function emitOAuthTlsPreflightWarn(logger: ComisLogger): Promise<void> {
  const result = await runOAuthTlsPreflight({ timeoutMs: PREFLIGHT_TIMEOUT_MS });
  if (result.ok) return;
  if (result.kind === "tls-cert") {
    const os = await readOsRelease();
    const hint = caCertificatesInstallHint(os);
    logger.warn(
      {
        submodule: MODULE_NAME,
        errorKind: "network" as const,
        hint,
        code: result.code,
      },
      "OAuth TLS preflight failed: system CA bundle cannot validate auth.openai.com",
    );
    return;
  }
  // kind === "network" — transient outage / DNS / firewall. DEBUG only.
  logger.debug(
    {
      submodule: MODULE_NAME,
      errorKind: "network" as const,
      reason: result.reason,
    },
    "OAuth TLS preflight network failure (skipping WARN — likely transient)",
  );
}
