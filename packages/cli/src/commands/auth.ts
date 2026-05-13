// SPDX-License-Identifier: Apache-2.0
/**
 * `comis auth` CLI command tree.
 *
 * Four subcommands with storage-mode-branching (Phase 31, MEM-CTX-PORTS-09):
 *
 * - `comis auth login`   — interactive OAuth login (browser + manual paste).
 *                          Runs locally for file-backed storage; encrypted
 *                          storage fails fast (daemon-assisted login is out
 *                          of scope for Phase 31 per design §8.2.7). Accepts
 *                          `--profile <id>` to override the storage key.
 * - `comis auth list`    — list stored profiles. File-mode reads the local
 *                          file store; encrypted-mode calls daemon RPC
 *                          `auth.list` (token-stripped projection).
 * - `comis auth logout`  — remove a profile by ID. File-mode deletes from
 *                          the local file store; encrypted-mode calls
 *                          daemon RPC `auth.logout`.
 * - `comis auth status`  — per-provider summary computed CLI-locally in
 *                          BOTH modes. File-mode reads the local file
 *                          store; encrypted-mode calls daemon RPC
 *                          `auth.list` and runs the same grouping +
 *                          `profileStatus(expires)` algorithm. The
 *                          OAuthCredentialStorePort surface has no "active
 *                          profile" concept — there is no `auth.status`
 *                          daemon RPC method.
 *
 * Storage-mode branching: every store-backed subcommand reads
 * `config.oauth.storage` via `loadOAuthStorageMode()` and either routes
 * through `withClient` (after `requireDaemonOrExit`) or uses the existing
 * `openOAuthStoreFromConfig` helper unchanged. The helper itself fails fast
 * on encrypted storage (defense-in-depth) — encrypted mode never reaches
 * `selectOAuthCredentialStore` from this file post-31-04.
 *
 * Only `--provider openai-codex` is supported for `auth login` today. Other
 * providers ship later. The `--provider` filter on `list` / `status` is
 * unconstrained because the filter is purely cosmetic.
 *
 * All commands run in the CLI process; the local OAuth callback server
 * (pi-ai's hardcoded localhost:1455) binds to the user's interactive
 * machine — daemon may be on a remote host.
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
  redactEmailForLog,
  type OAuthCredentialStorePort,
  type OAuthProfile,
} from "@comis/core";
import {
  selectOAuthCredentialStore,
  loginOpenAICodexOAuth,
  isRemoteEnvironment,
  // Phase 35 Plan 35-04 (D-01 #1/#2/#3): D-01 symbol groups all consumed
  // from @comis/core. createFileLock relocated from @comis/scheduler;
  // OAuth helpers relocated from @comis/agent. CLI no longer routes
  // through the @comis/agent barrel for any of these.
  createFileLock,
  // Phase 35 Plan 35-05 (WEB-CONTRACTS-03 / L12 closure): createConsoleLogger
  // is the Pino-free replacement for @comis/infra's createLogger (Plan 35-02
  // shipped the relocation). CLI no longer imports from @comis/infra.
  createConsoleLogger,
  type OAuthError,
} from "@comis/core";
// Phase 35 Wave C (Plan 35-07): auth.list / auth.logout RPC calls go
// through `callTyped(client, <Contract>, params)` so the typed RPC
// surface (D-10 LOCKED VALIDATE gate + bidirectional 1:1 architecture
// test) covers this file. The contracts mirror `auth-handlers.ts` —
// see `packages/core/src/api-contracts/auth.ts`.
import { AuthListContract, AuthLogoutContract } from "@comis/core";
import { error, info, success } from "../output/format.js";
import { renderTable } from "../output/table.js";
import { formatRelativeExpiry } from "../output/relative-time.js";
import { createClackAdapter } from "../wizard/clack-adapter.js";
import { callTyped, withClient } from "../client/rpc-client.js";
import { requireDaemonOrExit } from "../util/daemon-required.js";

const PROVIDER_OPENAI_CODEX = "openai-codex" as const;
const ACTIVE_THRESHOLD_MS = 5 * 60_000; // 5 minutes — match status logic

// ---------------------------------------------------------------------------
// OAuthError discrimination helpers.
//
// `exitOnOAuthError` translates a structured OAuthError into stderr output +
// exit code 1; `isOAuthError` is a defensive type guard so the catch blocks
// can route OAuthError values through the structured handler while letting
// generic JS errors fall through to the existing `Failed to ${verb}: ${msg}`
// pattern.
//
// Per CLAUDE.md "Logging" — CLI uses `format.ts` (stderr/stdout) NOT Pino;
// this is the documented exception. The literal "Re-authenticate with: comis
// auth login --provider <providerId>" line is the acceptance literal the
// integration test grep-asserts (test/integration/oauth-refresh-token-reused.test.ts).
// ---------------------------------------------------------------------------

/**
 * Translate a structured OAuthError into stderr output + exit code 1.
 *
 * When `errorKind === "refresh_token_reused"`, the CLI prints the canonical
 * re-login command with exit code 1. Other errorKinds (invalid_grant, etc.)
 * get tailored messages; unknown OAuthErrors fall through to the generic
 * shape.
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
 * Distinguishes the structured error from generic JS errors so the CLI can
 * route through `exitOnOAuthError` (above). Match against the 5 known
 * `OAuthError.code` values to avoid false positives on third-party errors
 * that happen to carry `code`/`providerId`/`message` keys.
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
// log call also sets `submodule: "auth-cli"` for filterability.
const logger = createConsoleLogger("info", { name: "auth-cli" });

// ---------------------------------------------------------------------------
// Internal: open the OAuth credential store using the same selector the
// daemon uses. Reads appConfig.oauth.storage from the user's config file
// with safe defaults when no config exists (e.g., daemon never set up).
//
// Both loadConfigFile and validateConfig are Result-typed (per @comis/core),
// so this function never throws — config errors fall through to the file
// adapter default, which is the safe operator-friendly behavior for a
// freshly-installed CLI.
// ---------------------------------------------------------------------------

/**
 * Resolves the current OAuth storage mode from config, with the same
 * fallback semantics as `openOAuthStoreFromConfig`: missing config defaults
 * to "file"; invalid config exits 1 with the same diagnostic.
 *
 * Used by the auth list/logout/status subcommands to decide whether to
 * route through daemon RPC (encrypted) or CLI-local (file).
 *
 * Returns synchronously today; declared async to leave headroom for a
 * future config-fetch-via-RPC path without breaking call sites.
 */
async function loadOAuthStorageMode(): Promise<"file" | "encrypted"> {
  // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
  const envPaths = process.env.COMIS_CONFIG_PATHS;
  const configPath =
    envPaths?.split(",")[0] ?? safePath(homedir(), ".comis", "config.yaml");
  const loadResult = loadConfigFile(configPath);
  if (!loadResult.ok) {
    // No config file -> default to file storage (matches
    // openOAuthStoreFromConfig's fallback path).
    return "file";
  }
  const validateResult = validateConfig(loadResult.value);
  if (!validateResult.ok) {
    error(
      `Failed to load config: ${validateResult.error.message}. ` +
        "Hint: run `comis configure` or fix the YAML at " +
        `${configPath} before retrying.`,
    );
    process.exit(1);
  }
  return validateResult.value.oauth.storage;
}

function openOAuthStoreFromConfig(): OAuthCredentialStorePort {
  const dataDir = safePath(homedir(), ".comis");
  // CLI composition root: construct the FileLockPort adapter here so agent's
  // selectOAuthCredentialStore can stay scheduler-free. Single instance per
  // CLI invocation — short-lived and stateless (per Phase 32 commit 12).
  const fileLock = createFileLock();
  // eslint-disable-next-line no-restricted-syntax -- CLI bootstrap before SecretManager
  const envPaths = process.env.COMIS_CONFIG_PATHS;
  const configPath =
    envPaths?.split(",")[0] ?? safePath(homedir(), ".comis", "config.yaml");

  const loadResult = loadConfigFile(configPath);
  if (!loadResult.ok) {
    // No config file → default to file storage (the file adapter creates
    // ~/.comis/auth-profiles.json on first set).
    return selectOAuthCredentialStore({ storage: "file", dataDir, fileLock });
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
    // Encrypted-mode bootstrap from CLI requires SECRETS_MASTER_KEY + the
    // secrets DB. The CLI does NOT spin up the SecretsCrypto/secretsDb
    // here — surface a fail-fast error pointing at the daemon's
    // encrypted-mode path. Operators with encrypted storage must run
    // `comis auth login` from the daemon host (where SECRETS_MASTER_KEY
    // is exported), or switch to file storage.
    error(
      "OAuth storage mode is 'encrypted' but the CLI cannot bootstrap the encrypted store. " +
        "Hint: Either (1) export SECRETS_MASTER_KEY in this shell and rerun, or (2) change " +
        "appConfig.oauth.storage to 'file' for `comis auth login` flows.",
    );
    process.exit(1);
  }

  return selectOAuthCredentialStore({ storage: "file", dataDir, fileLock });
}

// ---------------------------------------------------------------------------
// Internal: build a status string from an absolute expiry timestamp.
// ---------------------------------------------------------------------------

function profileStatus(expiresAtMs: number): "active" | "expired" {
  return expiresAtMs - Date.now() > ACTIVE_THRESHOLD_MS ? "active" : "expired";
}

// ---------------------------------------------------------------------------
// Internal: render the 5-column profile table used by `auth list` in both
// file and encrypted modes. Profiles are typed as the token-free shape
// returned by daemon RPC `auth.list` -- the file branch's OAuthProfile[] is
// assignable structurally (it has all the same fields plus extras).
// ---------------------------------------------------------------------------

interface DisplayProfile {
  provider: string;
  profileId: string;
  expires: number;
  email?: string;
  displayName?: string;
}

function renderAuthProfileTable(
  profiles: DisplayProfile[],
  providerFilter?: string,
): void {
  if (profiles.length === 0) {
    if (providerFilter) {
      info(`No OAuth profiles stored for provider "${providerFilter}".`);
    } else {
      info("No OAuth profiles stored.");
    }
    return;
  }
  renderTable(
    ["Provider", "ProfileId", "Identity", "ExpiresIn", "Status"],
    profiles.map((p) => [
      p.provider,
      p.profileId,
      p.email ?? p.profileId.split(":")[1] ?? "—",
      formatRelativeExpiry(p.expires),
      profileStatus(p.expires),
    ]),
  );
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
    .description(
      "Log in to an OAuth-enabled provider. Runs locally for file-backed storage. Daemon-assisted login for encrypted storage is not yet supported.",
    )
    .requiredOption(
      "--provider <id>",
      "OAuth provider id (must be 'openai-codex')",
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
        // Provider must be openai-codex.
        if (opts.provider !== PROVIDER_OPENAI_CODEX) {
          error(
            "--provider must be 'openai-codex' (other providers ship later)",
          );
          process.exit(2);
        }
        // Validate --profile override when supplied.
        // The user-supplied id becomes the storage key; the provider portion
        // MUST match --provider (defense against accidentally writing an
        // anthropic profile under an openai-codex login flow).
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

        // Validate --method flag.
        // Defense-in-depth: any value other than "device-code" silently
        // maps to "browser" — the CLI never crashes on an unknown method,
        // it falls back to the safe default.
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
          // When --profile is set, override the storage key.
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

          // Silent overwrite policy; INFO-log records every login write.
          logger.info(
            {
              provider: PROVIDER_OPENAI_CODEX,
              profileId: finalProfileId,
              identity:
                redactEmailForLog(v.email) ?? `id-${v.accountId ?? "<unknown>"}`,
              action: "login",
              submodule: "auth-cli",
            },
            "OAuth profile written by CLI",
          );

          success(
            `Logged in as ${v.email ?? v.displayName ?? v.profileId} (profile: ${finalProfileId})`,
          );
        } catch (err) {
          // Structured OAuthError values route through `exitOnOAuthError`
          // for the canonical re-login hint; generic errors fall through to
          // the existing pattern.
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
    .description(
      "List stored OAuth profiles. Requires the comis daemon to be running when oauth.storage is 'encrypted'.",
    )
    .option("--provider <id>", "Filter to one provider")
    .action(async (opts: { provider?: string }) => {
      const storage = await loadOAuthStorageMode();
      // ----- Encrypted branch: daemon RPC ----------------------------------
      if (storage === "encrypted") {
        await requireDaemonOrExit();
        try {
          // callTyped enforces the AuthListContract request/response
          // schemas under the D-10 VALIDATE gate (dev or
          // COMIS_CLI_VALIDATE=1). Production skips the parse for
          // cold-start budget compliance — the daemon side always parses.
          const result = await withClient(async (client) =>
            callTyped(
              client,
              AuthListContract,
              opts.provider ? { provider: opts.provider } : {},
            ),
          );
          renderAuthProfileTable(result.profiles, opts.provider);
        } catch (err) {
          if (isOAuthError(err)) exitOnOAuthError(err);
          const msg = err instanceof Error ? err.message : String(err);
          error(`Failed to list profiles: ${msg}`);
          process.exit(1);
        }
        return;
      }
      // ----- File branch: existing CLI-local helper ------------------------
      try {
        const store = openOAuthStoreFromConfig();
        const listResult = await store.list();
        if (!listResult.ok) {
          error(`Failed to list OAuth profiles: ${listResult.error.message}`);
          process.exit(1);
        }
        const profiles = listResult.value;
        // Client-side string-match filter; we explicitly opt OUT of
        // validating the provider value against pi-ai's known list (the
        // filter is purely an in-memory display sieve).
        const filtered = opts.provider
          ? profiles.filter((p) => p.provider === opts.provider)
          : profiles;
        renderAuthProfileTable(filtered, opts.provider);
      } catch (err) {
        // Structured OAuthError gets the re-login hint.
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
    .description(
      "Remove a stored OAuth profile. Requires the comis daemon to be running when oauth.storage is 'encrypted'.",
    )
    .requiredOption(
      "--profile <id>",
      "Profile ID to remove (e.g., openai-codex:user@example.com)",
    )
    .action(async (opts: { profile: string }) => {
      const storage = await loadOAuthStorageMode();
      // ----- Encrypted branch: daemon RPC ----------------------------------
      if (storage === "encrypted") {
        await requireDaemonOrExit();
        try {
          // callTyped enforces AuthLogoutContract under the D-10 gate.
          const result = await withClient(async (client) =>
            callTyped(client, AuthLogoutContract, {
              profileId: opts.profile,
            }),
          );
          if (result.deleted) {
            logger.info(
              {
                profileId: opts.profile,
                action: "logout",
                submodule: "auth-cli",
              },
              "OAuth profile removed via daemon RPC",
            );
            success(`Logged out of ${result.profileId}`);
          } else {
            error(`profile ${opts.profile} not found`);
            process.exit(1);
          }
        } catch (err) {
          if (isOAuthError(err)) exitOnOAuthError(err);
          const msg = err instanceof Error ? err.message : String(err);
          error(`Failed to log out: ${msg}`);
          process.exit(1);
        }
        return;
      }
      // ----- File branch: existing CLI-local helper ------------------------
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
            submodule: "auth-cli",
          },
          "OAuth profile removed by CLI",
        );
        success(`Logged out of ${opts.profile}`);
      } catch (err) {
        // Structured OAuthError gets the re-login hint.
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
    .description(
      "Show per-provider OAuth status. Requires the comis daemon to be running when oauth.storage is 'encrypted'.",
    )
    .option("--provider <id>", "Filter to one provider")
    .action(async (opts: { provider?: string }) => {
      // BOTH branches compute status CLI-locally. There is no auth.status
      // daemon RPC method because the OAuthCredentialStorePort surface has
      // no "active profile" concept -- status is just `profileStatus(expires)`
      // applied to each row of the profile list.
      let profiles: DisplayProfile[];
      const storage = await loadOAuthStorageMode();
      if (storage === "encrypted") {
        await requireDaemonOrExit();
        try {
          // callTyped enforces AuthListContract under the D-10 gate.
          // The contract response shape (RedactedOAuthProfileSchema) is
          // assignable to DisplayProfile (same fields plus structural
          // optionality on email + displayName).
          const result = await withClient(async (client) =>
            callTyped(client, AuthListContract, {}),
          );
          profiles = result.profiles;
        } catch (err) {
          if (isOAuthError(err)) exitOnOAuthError(err);
          const msg = err instanceof Error ? err.message : String(err);
          error(`Failed to check OAuth status: ${msg}`);
          process.exit(1);
          return; // unreachable; exit above
        }
      } else {
        try {
          const store = openOAuthStoreFromConfig();
          const listResult = await store.list();
          if (!listResult.ok) {
            error(`Failed to read OAuth status: ${listResult.error.message}`);
            process.exit(1);
          }
          profiles = listResult.value.map((p) => ({
            provider: p.provider,
            profileId: p.profileId,
            expires: p.expires,
            email: p.email,
            displayName: p.displayName,
          }));
        } catch (err) {
          if (isOAuthError(err)) exitOnOAuthError(err);
          const msg = err instanceof Error ? err.message : String(err);
          error(`Failed to check OAuth status: ${msg}`);
          process.exit(1);
          return; // unreachable
        }
      }

      // From here down: BYTE-IDENTICAL to the pre-migration auth status
      // grouping. The encrypted-branch profile rows have the same shape
      // (provider/profileId/expires/email?/displayName?) as the file-branch
      // projection, so a single grouping algorithm handles both.
      if (profiles.length === 0) {
        if (opts.provider) {
          info(`No OAuth profiles stored for provider "${opts.provider}".`);
        } else {
          info("No OAuth profiles stored.");
        }
        return;
      }
      const byProvider = new Map<string, DisplayProfile[]>();
      for (const p of profiles) {
        const arr = byProvider.get(p.provider) ?? [];
        arr.push(p);
        byProvider.set(p.provider, arr);
      }
      if (opts.provider && !byProvider.has(opts.provider)) {
        info(`No OAuth profiles stored for provider "${opts.provider}".`);
        return;
      }
      for (const [provider, group] of byProvider) {
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
    });
}
