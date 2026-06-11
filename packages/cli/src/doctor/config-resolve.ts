// SPDX-License-Identifier: Apache-2.0
/**
 * Store-aware config resolution shared by every doctor check.
 *
 * `comis doctor` used to load the config twice: config-health resolved
 * `${VAR}` references from env before validating, while buildDoctorContext
 * validated the RAW file. On an encrypted-store deployment the raw
 * `${COMIS_GATEWAY_TOKEN}` placeholder fails the >=32-char token gate, the
 * context silently dropped the config, and the gateway/channel checks
 * reported "No gateway URL configured" / "No channels configured" against a
 * live, fully configured daemon (2026-06-12 C1 live finding).
 *
 * This module is the single resolution path. `${VAR}` references resolve
 * the way daemon boot does: process env first, then `~/.comis/.env`, then
 * the encrypted secret store (offline read — the same seam `comis secrets
 * get --offline` uses). References nothing resolves stay as literals and
 * are reported by config path + var name so the operator is pointed at the
 * exact knob.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";
import {
  AppConfigSchema,
  findUnresolvedEnvRefs,
  loadEnvFile,
  safePath,
  systemGetEnv,
} from "@comis/core";
import { offlineSecretGet } from "../util/offline-secrets-store.js";
import type { DoctorConfigResolution } from "./types.js";

/** `${VAR_NAME}` reference — local instance so `.replace` never shares lastIndex state. */
const ENV_REF_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/** Injectable seams for tests; production callers pass nothing. */
export interface ResolveDoctorConfigDeps {
  readonly readFile?: (path: string) => string;
  readonly getEnv?: (key: string) => string | undefined;
  readonly getStoreSecret?: (key: string) => string | undefined;
}

/**
 * Build the secret-lookup chain: process env -> ~/.comis/.env -> encrypted
 * secret store. Store reads are lazy and per-name memoized; store errors
 * (no master key, no secrets.db) degrade to "not found" — the unresolved-ref
 * report then names the reference rather than this helper throwing.
 */
function buildSecretChain(deps: ResolveDoctorConfigDeps): (key: string) => string | undefined {
  const getEnv = deps.getEnv ?? systemGetEnv;

  let dotEnv: Record<string, string | undefined> | undefined;
  const dataDir = safePath(os.homedir(), ".comis");
  const envFilePath = safePath(dataDir, ".env");

  const loadDotEnv = (): Record<string, string | undefined> => {
    if (dotEnv === undefined) {
      dotEnv = {};
      try {
        loadEnvFile(envFilePath, dotEnv);
      } catch {
        // Missing or unreadable .env file: chain continues to the store.
      }
    }
    return dotEnv;
  };

  const storeCache = new Map<string, string | undefined>();
  const getStoreSecret =
    deps.getStoreSecret ??
    ((key: string): string | undefined => {
      if (!storeCache.has(key)) {
        const result = offlineSecretGet({ name: key, dataDir, envFilePath });
        storeCache.set(key, result.ok ? result.value : undefined);
      }
      return storeCache.get(key);
    });

  if (deps.getEnv !== undefined || deps.getStoreSecret !== undefined) {
    // Test seam: keep the chain to exactly the injected lookups so tests
    // are hermetic from the machine's real env/.env/store.
    return (key) => deps.getEnv?.(key) ?? deps.getStoreSecret?.(key);
  }

  return (key) => getEnv(key) ?? loadDotEnv()[key] ?? getStoreSecret(key);
}

/** Deep-copy `value`, replacing `${VAR}` refs the chain resolves; misses stay literal. */
function substituteLeavingUnresolved(
  value: unknown,
  getSecret: (key: string) => string | undefined,
): unknown {
  if (typeof value === "string") {
    return value.replace(ENV_REF_RE, (match, varName: string) => getSecret(varName) ?? match);
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteLeavingUnresolved(item, getSecret));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = substituteLeavingUnresolved(child, getSecret);
    }
    return out;
  }
  return value;
}

/**
 * Resolve the doctor's view of the config: locate, parse, substitute
 * `${VAR}` references (env -> .env -> encrypted store), then validate.
 *
 * Never throws; every failure mode is a typed field on the result so checks
 * can degrade honestly.
 */
export function resolveDoctorConfig(
  configPaths: readonly string[],
  deps: ResolveDoctorConfigDeps = {},
): DoctorConfigResolution {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf-8"));

  let raw: string | undefined;
  let foundPath: string | undefined;
  for (const candidate of configPaths) {
    try {
      raw = readFile(candidate);
      foundPath = candidate;
      break;
    } catch {
      // Try next path.
    }
  }
  if (raw === undefined || foundPath === undefined) {
    return {
      loadError: { kind: "missing", message: "No config file found at any configured path" },
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return {
      foundPath,
      loadError: { kind: "unparseable", message: `Config file is corrupt: ${foundPath}` },
    };
  }
  if (parsed === null || parsed === undefined) {
    parsed = {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      foundPath,
      loadError: { kind: "not-object", message: "Config file does not contain a valid object" },
    };
  }

  const getSecret = buildSecretChain(deps);
  const substituted = substituteLeavingUnresolved(parsed, getSecret);
  const unresolved = findUnresolvedEnvRefs(parsed, getSecret);

  const result = AppConfigSchema.safeParse(substituted);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    return {
      foundPath,
      validationIssues: issues,
      ...(unresolved.length > 0 && { unresolvedRefs: unresolved }),
    };
  }

  return {
    config: result.data,
    foundPath,
    ...(unresolved.length > 0 && { unresolvedRefs: unresolved }),
  };
}

/**
 * One-line, knob-naming explanation of WHY the resolution has no config —
 * or `undefined` when it resolved fine (callers then keep their own
 * "nothing configured" wording for the genuinely-unconfigured case).
 */
export function describeConfigUnavailable(
  resolution: DoctorConfigResolution | undefined,
): string | undefined {
  if (resolution === undefined) {
    return undefined;
  }
  if (resolution.loadError !== undefined) {
    return resolution.loadError.message;
  }
  if (resolution.validationIssues !== undefined && resolution.validationIssues.length > 0) {
    const refs =
      resolution.unresolvedRefs !== undefined && resolution.unresolvedRefs.length > 0
        ? ` — unresolved secret ref(s): ${resolution.unresolvedRefs
            .map((ref) => `\${${ref.varName}} at ${ref.path}`)
            .join(", ")} (not in env, ~/.comis/.env, or the encrypted secret store)`
        : "";
    return `config failed validation: ${resolution.validationIssues[0]}${refs}`;
  }
  return undefined;
}
