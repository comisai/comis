// SPDX-License-Identifier: Apache-2.0
/**
 * Store-aware config resolution shared by every doctor check.
 *
 * Without a shared resolution path, `comis doctor` would load the config
 * twice: config-health resolving `${VAR}` references before validating, while
 * the command context validates the raw file independently. On an
 * encrypted-store deployment the raw `${COMIS_GATEWAY_TOKEN}` placeholder
 * then fails the >=32-char token gate, the context silently drops the
 * config, and the gateway/channel checks report "No gateway URL configured"
 * / "No channels configured" against a live, fully configured daemon.
 *
 * This module is the single resolution path. It pre-reads `security.storage`
 * exactly as daemon startup does, then resolves `${VAR}` references from the
 * selected backend. File/encrypted store values win over shadowed process/.env
 * values; env mode uses the process and active data-dir `.env`. References
 * nothing resolves are reported by config path and variable name so the
 * operator is pointed at the exact knob.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";
import {
  AppConfigSchema,
  buildGatewayEnvLayer,
  deepMerge,
  findConfigUnresolvedEnvRefs,
  loadEnvFile,
  preReadStorageMode,
  safePath,
  substituteConfigEnvVars,
  systemGetEnv,
} from "@comis/core";
import { offlineSecretGetForMode } from "../util/offline-secrets-store.js";
import type { DoctorConfigResolution } from "./types.js";

/** Injectable seams for tests; production callers pass nothing. */
export interface ResolveDoctorConfigDeps {
  readonly readFile?: (path: string) => string;
  readonly getEnv?: (key: string) => string | undefined;
  readonly getStoreSecret?: (key: string) => string | undefined;
  readonly defaultDataDir?: string;
}

/**
 * Build the effective secret lookup used by daemon boot. The selected file or
 * encrypted store wins over a shadowed process/.env value; process env wins
 * over `.env` because `loadEnvFile` never overwrites an existing value. Store
 * reads are lazy and per-name memoized; backend errors degrade to "not found"
 * so the unresolved-ref report names the reference rather than throwing.
 */
function buildSecretChain(
  deps: ResolveDoctorConfigDeps,
  storageMode: "encrypted" | "file" | "env",
): (key: string) => string | undefined {
  const getEnv = deps.getEnv ?? systemGetEnv;

  let dotEnv: Record<string, string | undefined> | undefined;
  const dataDir =
    getEnv("COMIS_DATA_DIR") ?? deps.defaultDataDir ?? safePath(os.homedir(), ".comis");
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
        const result = offlineSecretGetForMode({
          name: key,
          mode: storageMode,
          dataDir,
          envFilePath,
        });
        storeCache.set(key, result.ok ? result.value : undefined);
      }
      return storeCache.get(key);
    });

  if (deps.getEnv !== undefined || deps.getStoreSecret !== undefined) {
    // Test seam: keep the lookup to exactly the injected sources so tests
    // are hermetic from the machine's real env/.env/store.
    return (key) => deps.getStoreSecret?.(key) ?? deps.getEnv?.(key);
  }

  return (key) => getStoreSecret(key) ?? getEnv(key) ?? loadDotEnv()[key];
}

/**
 * Resolve the doctor's view of the config: locate every readable layer,
 * substitute each layer exactly as bootstrap does, merge left-to-right above
 * the operational env layer, then validate.
 *
 * Never throws; every failure mode is a typed field on the result so checks
 * can degrade honestly.
 */
export function resolveDoctorConfig(
  configPaths: readonly string[],
  deps: ResolveDoctorConfigDeps = {},
): DoctorConfigResolution {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf-8"));

  const storageMode = preReadStorageMode(configPaths, { readFile });
  const getSecret = buildSecretChain(deps, storageMode);
  const operationalGetEnv =
    deps.getEnv ?? (deps.getStoreSecret !== undefined ? () => undefined : systemGetEnv);
  let merged = buildGatewayEnvLayer({
    COMIS_GATEWAY_HOST: operationalGetEnv("COMIS_GATEWAY_HOST"),
    COMIS_GATEWAY_PORT: operationalGetEnv("COMIS_GATEWAY_PORT"),
    COMIS_TRAJECTORY_DIR: operationalGetEnv("COMIS_TRAJECTORY_DIR"),
  });
  let rawMerged: Record<string, unknown> = {};
  let foundPath: string | undefined;
  let readableLayers = 0;

  for (const candidate of configPaths) {
    let raw: string;
    try {
      raw = readFile(candidate);
    } catch {
      // Daemon startup filters missing paths before layered loading.
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      return {
        foundPath: candidate,
        loadError: { kind: "unparseable", message: `Config file is corrupt: ${candidate}` },
      };
    }
    if (parsed === null || parsed === undefined) parsed = {};
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        foundPath: candidate,
        loadError: {
          kind: "not-object",
          message: `Config file does not contain a valid object: ${candidate}`,
        },
      };
    }
    const rawLayer = parsed as Record<string, unknown>;
    rawMerged = deepMerge(rawMerged, rawLayer);
    foundPath = candidate;
    readableLayers++;

    // Bootstrap substitutes each file before merging it. An unresolved ref in
    // an earlier layer is therefore a boot failure even if a later array/object
    // replacement would otherwise hide it.
    const substituted = substituteConfigEnvVars(rawLayer, getSecret, candidate);
    if (!substituted.ok) {
      const unresolved = findConfigUnresolvedEnvRefs(rawLayer, getSecret);
      return {
        foundPath,
        rawTopLevelKeys: Object.keys(rawMerged),
        validationIssues: [substituted.error.message],
        ...(unresolved.length > 0 ? { unresolvedRefs: unresolved } : {}),
      };
    }
    merged = deepMerge(merged, substituted.value);
  }

  if (readableLayers === 0) {
    return {
      loadError: { kind: "missing", message: "No config file found at any configured path" },
    };
  }

  // Raw top-level keys BEFORE schema defaults, after applying the same layered
  // precedence as daemon startup.
  const rawTopLevelKeys = Object.keys(rawMerged);

  const result = AppConfigSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    return {
      foundPath,
      rawTopLevelKeys,
      validationIssues: issues,
    };
  }

  return {
    config: result.data,
    foundPath,
    rawTopLevelKeys,
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
            .join(", ")} (not in the process environment, active data-dir .env, or ` +
          "configured secret store)"
        : "";
    return `config failed validation: ${resolution.validationIssues[0]}${refs}`;
  }
  return undefined;
}
