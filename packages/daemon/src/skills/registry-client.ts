// SPDX-License-Identifier: Apache-2.0
/**
 * Pinned, bounded client for operator-configured skill registries.
 *
 * Configuration is selected before any network call. Registry claims are
 * mapped by the pure skills-package adapter and returned as evidence only.
 *
 * @module
 */

import {
  mapSkillRegistryResolution,
  parseSkillRegistryRef,
  resolveSkillRegistryVersion,
  type SkillRegistryResolution,
} from "@comis/skills";
import { systemSleep } from "@comis/core";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import {
  defaultSkillImportFetchDeps,
  fetchSkillImportResponse,
  readSkillImportText,
  type SkillImportFetchDeps,
  type SkillImportRequestInit,
} from "./import-fetch.js";

const MAX_REGISTRY_METADATA_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 15_000;

/** Config projection accepted from `skills.import.registries`. */
export interface SkillRegistryConfig {
  readonly id: string;
  readonly base: string;
  readonly kind: "wellknown" | "registry";
  readonly trust: "community" | "operator";
}

/** Injectable retry/fetch seams for deterministic tests. */
export interface RegistryClientDeps {
  readonly fetchDeps?: SkillImportFetchDeps;
  readonly sleep?: (delayMs: number) => Promise<void>;
}

/** Actionable error returned across the daemon import boundary. */
export interface RegistryClientError {
  readonly kind:
    | "registry_not_configured"
    | "invalid_registry_config"
    | "invalid_ref"
    | "request_failed"
    | "rate_limited"
    | "invalid_response"
    | "identity_mismatch";
  readonly message: string;
  readonly hint: string;
}

/** Metadata resolution plus the operator's explicit tier selection. */
export interface ResolvedRegistryMetadata {
  readonly resolution: SkillRegistryResolution;
  readonly registryTrust: "community" | "operator";
}

function makeError(
  kind: RegistryClientError["kind"],
  message: string,
  hint: string,
): RegistryClientError {
  return { kind, message, hint };
}

function retryDelayMs(rawValue: string | null, attempt: number): number {
  if (rawValue !== null) {
    const seconds = Number(rawValue.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
    }
  }
  return Math.min(attempt * 1000, MAX_RETRY_AFTER_MS);
}

async function requestRegistryJson(
  url: string,
  configId: string,
  deps: RegistryClientDeps,
  init: Omit<SkillImportRequestInit, "signal" | "redirect"> = {},
): Promise<Result<unknown, RegistryClientError>> {
  const fetchDeps = deps.fetchDeps ?? defaultSkillImportFetchDeps;
  const sleep = deps.sleep ?? systemSleep;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const fetched = await fetchSkillImportResponse(url, fetchDeps, init);
    if (!fetched.ok) {
      return err(
        makeError(
          "request_failed",
          `Registry ${configId} request failed: ${fetched.error.message}`,
          `Check skills.import.registries entry ${configId}, DNS, and outbound network access.`,
        ),
      );
    }

    const retryable = fetched.value.status === 429 || fetched.value.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS) {
      await sleep(retryDelayMs(fetched.value.headers.get("retry-after"), attempt));
      continue;
    }
    if (fetched.value.status === 429) {
      return err(
        makeError(
          "rate_limited",
          `Registry ${configId} remained rate limited after ${MAX_ATTEMPTS} attempts`,
          "Retry-After capped at 15000ms per attempt; retry later or choose another configured registry.",
        ),
      );
    }
    if (!fetched.value.ok) {
      return err(
        makeError(
          "request_failed",
          `Registry ${configId} returned ${fetched.value.status} ${fetched.value.statusText}`,
          `Check the registry base and reference in skills.import.registries entry ${configId}.`,
        ),
      );
    }

    const text = await readSkillImportText(
      fetched.value,
      MAX_REGISTRY_METADATA_BYTES,
      "skills.import.registryMetadataBytes",
    );
    if (!text.ok) {
      return err(
        makeError(
          "invalid_response",
          text.error.message,
          "The configured registry returned metadata above the 1048576-byte safety limit.",
        ),
      );
    }
    const parsed = tryCatch((): unknown => JSON.parse(text.value));
    if (!parsed.ok) {
      return err(
        makeError(
          "invalid_response",
          `Registry ${configId} returned invalid JSON: ${parsed.error.message}`,
          `Verify the API base in skills.import.registries entry ${configId}.`,
        ),
      );
    }
    return ok(parsed.value);
  }
  return err(
    makeError(
      "request_failed",
      `Registry ${configId} request ended unexpectedly`,
      `Verify skills.import.registries entry ${configId}.`,
    ),
  );
}

function registryUrl(base: URL, path: string): URL {
  const normalizedBase = base.toString().endsWith("/") ? base.toString() : `${base.toString()}/`;
  return new URL(path, normalizedBase);
}

/** Resolve one allowlisted registry reference without downloading its archive. */
export async function resolveRegistryMetadata(args: {
  readonly registryId: string;
  readonly ref: string;
  readonly registries: readonly SkillRegistryConfig[];
  readonly deps?: RegistryClientDeps;
}): Promise<Result<ResolvedRegistryMetadata, RegistryClientError>> {
  const config = args.registries.find(
    (candidate) => candidate.id === args.registryId && candidate.kind === "registry",
  );
  if (config === undefined) {
    return err(
      makeError(
        "registry_not_configured",
        `Registry ${args.registryId} is not configured for skill imports`,
        `Add a kind=registry entry for ${args.registryId} to skills.import.registries before retrying.`,
      ),
    );
  }

  const base = tryCatch(() => new URL(config.base));
  if (!base.ok || base.value.username !== "" || base.value.password !== "") {
    return err(
      makeError(
        "invalid_registry_config",
        `Registry ${config.id} has an invalid or credential-bearing base URL`,
        `Correct skills.import.registries entry ${config.id}; credentials are not allowed in registry URLs.`,
      ),
    );
  }
  const ref = parseSkillRegistryRef(args.ref);
  if (!ref.ok) {
    return err(makeError(ref.error.kind, ref.error.message, "Use a lowercase slug or slug@version."));
  }

  const deps = args.deps ?? {};
  const detailUrl = registryUrl(base.value, `skills/${encodeURIComponent(ref.value.slug)}`);
  const detail = await requestRegistryJson(detailUrl.toString(), config.id, deps);
  if (!detail.ok) return detail;
  const version = resolveSkillRegistryVersion(ref.value, detail.value);
  if (!version.ok) {
    return err(
      makeError(
        version.error.kind,
        version.error.message,
        `Registry ${config.id} returned an unexpected skill-detail shape; verify its API version.`,
      ),
    );
  }

  const verdictUrl = registryUrl(base.value, "skills/-/security-verdicts");
  const verdict = await requestRegistryJson(verdictUrl.toString(), config.id, deps, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items: [{ slug: ref.value.slug, version: version.value }] }),
  });
  if (!verdict.ok) return verdict;

  const downloadUrl = registryUrl(base.value, "download");
  downloadUrl.searchParams.set("slug", ref.value.slug);
  downloadUrl.searchParams.set("version", version.value);
  const resolution = mapSkillRegistryResolution({
    ref: { slug: ref.value.slug, version: version.value },
    detail: detail.value,
    verdict: verdict.value,
    downloadUrl: downloadUrl.toString(),
  });
  if (!resolution.ok) {
    return err(
      makeError(
        resolution.error.kind,
        resolution.error.message,
        `Registry ${config.id} returned mismatched metadata; do not import until its API response is corrected.`,
      ),
    );
  }
  return ok({ resolution: resolution.value, registryTrust: config.trust });
}
