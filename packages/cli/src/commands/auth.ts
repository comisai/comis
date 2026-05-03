// SPDX-License-Identifier: Apache-2.0
/**
 * `comis auth` CLI command tree (Phase 8 D-13 + R4/R5; Phase 9 R4/R5/R6).
 *
 * Four subcommands operating directly against the OAuthCredentialStorePort
 * (no daemon RPC — store is the IPC primitive between CLI and daemon, with
 * the daemon picking up changes via the chokidar watcher in plan 05):
 *
 * - `comis auth login`   — interactive OAuth login (browser + manual paste).
 *                          Accepts `--profile <id>` to override the storage
 *                          key (Phase 9 R4); the user-supplied id replaces
 *                          the JWT-derived `<provider>:<email>` while the
 *                          identity fields on the persisted profile remain
 *                          JWT-derived. Provider portion of `--profile` must
 *                          equal `--provider` or the command exits 2.
 * - `comis auth list`    — list stored profiles in a 5-column table; supports
 *                          `--provider <id>` filter (Phase 9 R5) — pure
 *                          client-side string match, no validation against
 *                          pi-ai's known list.
 * - `comis auth logout`  — remove a profile by ID
 * - `comis auth status`  — per-provider summary (count + nextExpiry); supports
 *                          `--provider <id>` filter (Phase 9 R6) with the
 *                          same semantics as `auth list`.
 *
 * Phase 8 only supports `--provider openai-codex` for `auth login`. Other
 * providers ship in later phases (D-15 + SPEC R4 negative test). The
 * `--provider` filter on `list` / `status` is unconstrained because the
 * filter is purely cosmetic.
 *
 * All commands run in the CLI process; the local OAuth callback server
 * (pi-ai's hardcoded localhost:1455) binds to the user's interactive
 * machine — daemon may be on a remote host (SPEC.md constraints line 112).
 *
 * @module
 */

import { homedir } from "node:os";
import type { Command } from "commander";
import open from "open";
import {
  loadConfigFile,
  validateConfig,
  safePath,
  validateProfileId,
  type OAuthCredentialStorePort,
  type OAuthProfile,
} from "@comis/core";
import {
  selectOAuthCredentialStore,
  loginOpenAICodexOAuth,
  isRemoteEnvironment,
  redactEmailForLog,
  type OAuthError,
} from "@comis/agent";
import { createLogger } from "@comis/infra";
import { error, info, success } from "../output/format.js";
import { renderTable } from "../output/table.js";
import { formatRelativeExpiry } from "../output/relative-time.js";
import { createClackAdapter } from "../wizard/clack-adapter.js";

const PROVIDER_OPENAI_CODEX = "openai-codex" as const;
const ACTIVE_THRESHOLD_MS = 5 * 60_000; // 5 minutes — match D-16 status logic

// ---------------------------------------------------------------------------
// Phase 10 SC-10-4: OAuthError discrimination helpers (Plan 10-06).
//
// `exitOnOAuthError` translates a structured OAuthError into stderr output +
// exit code 1; `isOAuthError` is a defensive type guard so the catch blocks
// can route OAuthError values through the structured handler while letting
// generic JS errors fall through to the existing `Failed to ${verb}: ${msg}`
// pattern.
//
// Per CLAUDE.md "Logging" — CLI uses `format.ts` (stderr/stdout) NOT Pino;
// this is the documented exception. The literal "Re-authenticate with: comis
// auth login --provider <providerId>" line is the SC-10-4 acceptance literal
// the integration test grep-asserts (test/integration/oauth-refresh-token-reused.test.ts).
// ---------------------------------------------------------------------------

/**
 * Translate a structured OAuthError into stderr output + exit code 1.
 *
 * Phase 10 SC-10-4: when `errorKind === "refresh_token_reused"`, the CLI
 * prints the canonical re-login command with exit code 1. Other errorKinds
 * (invalid_grant, etc.) get tailored messages; unknown OAuthErrors fall
 * through to the generic shape.
 *
 * Returns `never` — always exits the process.
 */
function exitOnOAuthError(err: OAuthError): never {
  if (err.errorKind === "refresh_token_reused") {
    error(
      "Refresh token was reused. The OpenAI account has been auto-locked for security.",
    );
    info(`Re-authenticate with: comis auth login --provider ${err.providerId}`);
    process.exit(1);
  }
  if (err.errorKind === "invalid_grant") {
    const profileSlug = err.profileId ?? "unknown";
    error(
      `Refresh token was rejected by OpenAI (invalid_grant) for profile "${profileSlug}".`,
    );
    info(`Re-authenticate with: comis auth login --provider ${err.providerId}`);
    process.exit(1);
  }
  error(`OAuthError (${err.code}): ${err.message}`);
  if (err.hint) info(err.hint);
  process.exit(1);
}

/**
 * Type guard: detect an OAuthError shape on a caught unknown value.
 * Distinguishes the structured Phase 7+ error from generic JS errors so the
 * CLI can route through `exitOnOAuthError` (above). Match against the 5
 * known `OAuthError.code` values to avoid false positives on third-party
 * errors that happen to carry `code`/`providerId`/`message` keys.
 */
function isOAuthError(value: unknown): value is OAuthError {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.code === "string" &&
    typeof v.message === "string" &&
    typeof v.providerId === "string" &&
    [
      "NO_PROVIDER",
      "NO_CREDENTIALS",
      "REFRESH_FAILED",
      "STORE_FAILED",
      "PROFILE_NOT_FOUND",
    ].includes(v.code)
  );
}

// Module-scoped logger. The CLI process runs short-lived commands; one
// logger instance is shared across all 4 subcommands. Per CLAUDE.md, every
// log call also sets `module: "auth-cli"` for filterability. The plan body
// referenced `logLevelManager.getLogger(...)` — that helper does not exist
// in @comis/infra (only `createLogger` is exported); auto-fix per Rule 3.
const logger = createLogger({ name: "auth-cli" });

// ---------------------------------------------------------------------------
// Internal: open the OAuth credential store using the same selector the
// daemon uses (D-13). Reads appConfig.oauth.storage from the user's config
// file with safe defaults when no config exists (e.g., daemon never set up).
//
// Both loadConfigFile and validateConfig are Result-typed (per @comis/core),
// so this function never throws — config errors fall through to the file
// adapter default, which is the safe operator-friendly behavior for a
// freshly-installed CLI.
// ---------------------------------------------------------------------------

function openOAuthStoreFromConfig(): OAuthCredentialStorePort {
  const dataDir = safePath(homedir(), ".comis");
  // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
  const envPaths = process.env.COMIS_CONFIG_PATHS;
  const configPath =
    envPaths?.split(",")[0] ?? safePath(homedir(), ".comis", "config.yaml");

  const loadResult = loadConfigFile(configPath);
  if (!loadResult.ok) {
    // No config file → default to file storage (the file adapter creates
    // ~/.comis/auth-profiles.json on first set).
    return selectOAuthCredentialStore({ storage: "file", dataDir });
  }

  const validateResult = validateConfig(loadResult.value);
  if (!validateResult.ok) {
    // Invalid config — fail fast with a clear hint pointing at the daemon
    // bootstrap message that surfaces the same Zod issue.
    error(
      `Failed to load config: ${validateResult.error.message}. ` +
        "Hint: run `comis configure` or fix the YAML at " +
        `${configPath} before retrying.`,
    );
    process.exit(1);
  }

  const storage = validateResult.value.oauth.storage;

  if (storage === "encrypted") {
    // Per RESEARCH §Security T-08-OAUTH-ENCRYPTED-NO-KEY: encrypted-mode
    // bootstrap from CLI requires SECRETS_MASTER_KEY + the secrets DB.
    // The CLI does NOT spin up the SecretsCrypto/secretsDb here — for Phase 8
    // we surface a fail-fast error pointing at the daemon's encrypted-mode
    // path. Operators with encrypted storage must run `comis auth login`
    // from the daemon host (where SECRETS_MASTER_KEY is exported), or
    // switch to file storage.
    error(
      "OAuth storage mode is 'encrypted' but the CLI cannot bootstrap the encrypted store. " +
        "Hint: Either (1) export SECRETS_MASTER_KEY in this shell and rerun, or (2) change " +
        "appConfig.oauth.storage to 'file' for `comis auth login` flows.",
    );
    process.exit(1);
  }

  return selectOAuthCredentialStore({ storage: "file", dataDir });
}

// ---------------------------------------------------------------------------
// Internal: build a status string from an absolute expiry timestamp.
// ---------------------------------------------------------------------------

function profileStatus(expiresAtMs: number): "active" | "expired" {
  return expiresAtMs - Date.now() > ACTIVE_THRESHOLD_MS ? "active" : "expired";
}

// ---------------------------------------------------------------------------
// Public boundary
// ---------------------------------------------------------------------------

/**
 * Register the `auth` command group on the program.
 */
export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("OAuth authentication management");

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------
  auth
    .command("login")
    .description("Log in to an OAuth-enabled provider")
    .requiredOption(
      "--provider <id>",
      "OAuth provider id (must be 'openai-codex' for Phase 8)",
    )
    .option("--remote", "Force remote/headless mode (no browser)")
    .option("--local", "Force local/desktop mode (try to open browser)")
    .option(
      "--profile <id>",
      "Override the auto-derived profile ID (provider portion must match --provider)",
    )
    .option(
      "--method <method>",
      "Login method: 'browser' (default) or 'device-code' (SSH/no-clipboard)",
    )
    .action(
      async (opts: {
        provider: string;
        remote?: boolean;
        local?: boolean;
        profile?: string;
        method?: string;
      }) => {
        // D-15 + SPEC R4 negative — provider must be openai-codex.
        if (opts.provider !== PROVIDER_OPENAI_CODEX) {
          error(
            "--provider must be 'openai-codex' (other providers ship in later phases)",
          );
          process.exit(2);
        }
        // Phase 9 R4 — validate --profile override when supplied.
        // The user-supplied id becomes the storage key; the provider portion
        // MUST match --provider (defense against accidentally writing an
        // anthropic profile under an openai-codex login flow — T-09-V5).
        if (opts.profile) {
          const validated = validateProfileId(opts.profile);
          if (!validated.ok) {
            error(
              `Invalid --profile value: ${validated.error.message}. Expected format: <provider>:<identity>.`,
            );
            process.exit(2);
          }
          if (validated.value.provider !== opts.provider) {
            error(
              `--profile provider portion ("${validated.value.provider}") must match --provider value ("${opts.provider}") — provider mismatch.`,
            );
            process.exit(2);
          }
        }

        // Phase 11 SC11-1: validate --method flag.
        // Defense-in-depth (T-11-04-01): any value other than "device-code"
        // silently maps to "browser" — the CLI never crashes on an unknown
        // method, it falls back to the safe default.
        const method: "browser" | "device-code" =
          opts.method === "device-code" ? "device-code" : "browser";
        if (method === "device-code" && opts.provider !== PROVIDER_OPENAI_CODEX) {
          error(
            "--method device-code is only supported with --provider openai-codex " +
              "(other providers do not support device-code today)",
          );
          process.exit(2);
        }

        try {
          const store = openOAuthStoreFromConfig();
          const isRemote = isRemoteEnvironment({
            env: process.env,
            force: opts.remote ? "remote" : opts.local ? "local" : undefined,
          });
          const prompter = createClackAdapter();

          const result = await loginOpenAICodexOAuth({
            prompter,
            isRemote,
            openUrl: open,
            logger,
            method,
          });

          if (!result.ok) {
            error(result.error.message);
            if (result.error.hint) info(result.error.hint);
            process.exit(1);
          }

          const v = result.value;
          // Phase 9 R4 — when --profile is set, override the storage key.
          // email/accountId/displayName remain JWT-derived (preserved on the
          // profile object) so the operator can still identify which upstream
          // account backs the alias.
          const finalProfileId = opts.profile ?? v.profileId;
          const profile: OAuthProfile = {
            provider: PROVIDER_OPENAI_CODEX,
            profileId: finalProfileId,
            access: v.access,
            refresh: v.refresh,
            expires: v.expires,
            accountId: v.accountId,
            email: v.email,
            displayName: v.displayName,
            version: 1,
          };

          const writeResult = await store.set(finalProfileId, profile);
          if (!writeResult.ok) {
            error(`Failed to persist OAuth profile: ${writeResult.error.message}`);
            process.exit(1);
          }

          // D-14 — silent overwrite policy; INFO-log records every login write.
          logger.info(
            {
              provider: PROVIDER_OPENAI_CODEX,
              profileId: finalProfileId,
              identity:
                redactEmailForLog(v.email) ?? `id-${v.accountId ?? "<unknown>"}`,
              action: "login",
              module: "auth-cli",
            },
            "OAuth profile written by CLI",
          );

          success(
            `Logged in as ${v.email ?? v.displayName ?? v.profileId} (profile: ${finalProfileId})`,
          );
        } catch (err) {
          // Phase 10 SC-10-4 (Plan 10-06): structured OAuthError values
          // route through `exitOnOAuthError` for the canonical re-login hint;
          // generic errors fall through to the existing pattern.
          if (isOAuthError(err)) {
            exitOnOAuthError(err);
          }
          const msg = err instanceof Error ? err.message : String(err);
          error(`Failed to log in: ${msg}`);
          process.exit(1);
        }
      },
    );

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------
  auth
    .command("list")
    .description("List stored OAuth profiles")
    .option("--provider <id>", "Filter to one provider")
    .action(async (opts: { provider?: string }) => {
      try {
        const store = openOAuthStoreFromConfig();
        const listResult = await store.list();
        if (!listResult.ok) {
          error(`Failed to list OAuth profiles: ${listResult.error.message}`);
          process.exit(1);
        }
        const profiles = listResult.value;
        // Phase 9 R5 — client-side string-match filter; SPEC explicitly opts
        // OUT of validating the provider value against pi-ai's known list
        // (the filter is purely an in-memory display sieve).
        const filtered = opts.provider
          ? profiles.filter((p) => p.provider === opts.provider)
          : profiles;
        if (filtered.length === 0) {
          if (opts.provider) {
            info(`No OAuth profiles stored for provider "${opts.provider}".`);
          } else {
            info("No OAuth profiles stored.");
          }
          return;
        }
        renderTable(
          ["Provider", "ProfileId", "Identity", "ExpiresIn", "Status"],
          filtered.map((p) => [
            p.provider,
            p.profileId,
            p.email ?? p.profileId.split(":")[1] ?? "—",
            formatRelativeExpiry(p.expires),
            profileStatus(p.expires),
          ]),
        );
      } catch (err) {
        // Phase 10 SC-10-4 — structured OAuthError gets the re-login hint.
        if (isOAuthError(err)) {
          exitOnOAuthError(err);
        }
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to list profiles: ${msg}`);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // logout
  // -------------------------------------------------------------------------
  auth
    .command("logout")
    .description("Remove a stored OAuth profile")
    .requiredOption(
      "--profile <id>",
      "Profile ID to remove (e.g., openai-codex:user@example.com)",
    )
    .action(async (opts: { profile: string }) => {
      try {
        const store = openOAuthStoreFromConfig();
        const has = await store.has(opts.profile);
        if (!has.ok) {
          error(`Failed to check profile existence: ${has.error.message}`);
          process.exit(1);
        }
        if (!has.value) {
          error(`profile ${opts.profile} not found`);
          process.exit(1);
        }
        const delResult = await store.delete(opts.profile);
        if (!delResult.ok) {
          error(`Failed to remove profile: ${delResult.error.message}`);
          process.exit(1);
        }
        logger.info(
          {
            profileId: opts.profile,
            action: "logout",
            module: "auth-cli",
          },
          "OAuth profile removed by CLI",
        );
        success(`Logged out of ${opts.profile}`);
      } catch (err) {
        // Phase 10 SC-10-4 — structured OAuthError gets the re-login hint.
        if (isOAuthError(err)) {
          exitOnOAuthError(err);
        }
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to log out: ${msg}`);
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------
  auth
    .command("status")
    .description("Show per-provider OAuth status")
    .option("--provider <id>", "Filter to one provider")
    .action(async (opts: { provider?: string }) => {
      try {
        const store = openOAuthStoreFromConfig();
        const listResult = await store.list();
        if (!listResult.ok) {
          error(`Failed to read OAuth status: ${listResult.error.message}`);
          process.exit(1);
        }
        const profiles = listResult.value;
        if (profiles.length === 0) {
          // Empty store — even with --provider filter, the operator's
          // intended diagnostic is the same: nothing here, optionally for
          // the named provider.
          if (opts.provider) {
            info(`No OAuth profiles stored for provider "${opts.provider}".`);
          } else {
            info("No OAuth profiles stored.");
          }
          return;
        }
        // Group by provider.
        const byProvider = new Map<string, OAuthProfile[]>();
        for (const p of profiles) {
          const arr = byProvider.get(p.provider) ?? [];
          arr.push(p);
          byProvider.set(p.provider, arr);
        }
        // Phase 9 R6 — empty filter case: store has profiles, but none for
        // the requested provider. Print provider-specific empty-state per
        // SPEC line 53 wording and exit 0 (the standard `return` here, since
        // a missing provider in a populated store is not an error).
        if (opts.provider && !byProvider.has(opts.provider)) {
          info(`No OAuth profiles stored for provider "${opts.provider}".`);
          return;
        }
        for (const [provider, group] of byProvider) {
          // Phase 9 R6 — skip non-matching groups when filter is set.
          if (opts.provider && provider !== opts.provider) continue;
          info(
            `${provider} (${group.length} profile${group.length !== 1 ? "s" : ""})`,
          );
          for (const p of group) {
            const identity = p.email ?? p.profileId.split(":")[1] ?? "—";
            info(
              `  ${p.profileId} — expires in ${formatRelativeExpiry(p.expires)} (${profileStatus(p.expires)}) — identity: ${identity}`,
            );
          }
        }
      } catch (err) {
        // Phase 10 SC-10-4 — structured OAuthError gets the re-login hint.
        if (isOAuthError(err)) {
          exitOnOAuthError(err);
        }
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to check OAuth status: ${msg}`);
        process.exit(1);
      }
    });
}
