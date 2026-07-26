// SPDX-License-Identifier: Apache-2.0
/**
 * SSRF-safe fetch and validated-cache layer for well-known skill indexes.
 *
 * The cache stores only the validated index projection, is owner-only, and is
 * never a substitute for vetting fetched skill bytes. An expired entry may be
 * used when refreshing the index fails; every skill file is still fetched and
 * vetted normally.
 *
 * @module
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { safePath, systemNowMs } from "@comis/core";
import { ensureContainedDir, writeRegularFile } from "@comis/observability";
import {
  parseWellKnownIndex,
  resolveWellKnownSkill,
  type SkillBundleFile,
  type WellKnownIndex,
} from "@comis/skills";
import { err, ok, tryCatch, type Result } from "@comis/shared";
import {
  defaultSkillImportFetchDeps,
  fetchSkillImportResponse,
  readSkillImportText,
  type SkillImportFetchDeps,
} from "./import-fetch.js";

const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const CACHE_DIR_NAME = "skill-index-cache";

/** Configured remote base projection consumed by this source. */
export interface WellKnownRegistryConfig {
  readonly id: string;
  readonly base: string;
  readonly kind: "wellknown" | "registry";
  readonly trust: "community" | "operator";
}

/** Minimal structured logger contract. */
export interface WellKnownFetchLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

/** Inputs for one well-known source fetch. */
export interface FetchWellKnownSkillArgs {
  readonly ref: string;
  readonly dataDir: string;
  readonly registries: readonly WellKnownRegistryConfig[];
  readonly cacheTtlMs: number;
  readonly fetchDeps?: SkillImportFetchDeps;
  readonly nowMs?: () => number;
  readonly logger: WellKnownFetchLogger;
}

/** Successfully resolved file map plus explicit operator trust policy. */
export interface FetchedWellKnownSkill {
  readonly name: string;
  readonly files: readonly SkillBundleFile[];
  readonly ref: string;
  readonly registryTrust: "community" | "operator";
  readonly cache: "fresh" | "hit" | "stale";
}

interface ParsedWellKnownRef {
  readonly base: string;
  readonly name: string;
}

interface CachedIndex {
  readonly fetchedAtMs: number;
  readonly index: WellKnownIndex;
}

/** Parse `wellknown:<base>#<name>` without accepting credentials or an empty fragment. */
export function parseWellKnownRef(ref: string): Result<ParsedWellKnownRef, Error> {
  if (!ref.startsWith("wellknown:")) {
    return err(new Error("Well-known skill ref must use wellknown:<base>#<skill-name>"));
  }
  const raw = ref.slice("wellknown:".length);
  const hashIndex = raw.lastIndexOf("#");
  if (hashIndex <= 0 || hashIndex === raw.length - 1) {
    return err(new Error("Well-known skill ref must include #<skill-name>"));
  }
  const parsedUrl = tryCatch(() => new URL(raw.slice(0, hashIndex)));
  if (!parsedUrl.ok) return parsedUrl;
  if (parsedUrl.value.username !== "" || parsedUrl.value.password !== "") {
    return err(new Error("Well-known skill ref must not contain URL credentials"));
  }
  parsedUrl.value.hash = "";
  parsedUrl.value.search = "";
  const name = raw.slice(hashIndex + 1);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) || name.length > 64) {
    return err(new Error(`Invalid well-known skill name: ${name}`));
  }
  return ok({ base: parsedUrl.value.toString().replace(/\/$/, ""), name });
}

function normalizeConfiguredBase(base: string): string | undefined {
  const parsed = tryCatch(() => new URL(base));
  if (!parsed.ok || parsed.value.username !== "" || parsed.value.password !== "") return undefined;
  parsed.value.hash = "";
  parsed.value.search = "";
  return parsed.value.toString().replace(/\/$/, "");
}

function indexUrl(base: string): string {
  return new URL("/.well-known/skills/index.json", `${base}/`).toString();
}

function memberUrl(base: string, skillName: string, path: string): string {
  const relative = [skillName, ...path.split("/")].map(encodeURIComponent).join("/");
  return new URL(relative, `${base}/`).toString();
}

function cachePath(dataDir: string, url: string): { dir: string; file: string } {
  const key = createHash("sha256").update(url).digest("hex");
  const dir = safePath(dataDir, CACHE_DIR_NAME);
  return { dir, file: safePath(dir, `${key}.json`) };
}

function readCachedIndex(dataDir: string, url: string): CachedIndex | undefined {
  const { file } = cachePath(dataDir, url);
  if (!existsSync(file)) return undefined;
  const decoded = tryCatch(() => JSON.parse(readFileSync(file, "utf-8")) as unknown);
  if (!decoded.ok || decoded.value === null || typeof decoded.value !== "object") return undefined;
  const record = decoded.value as Record<string, unknown>;
  if (typeof record["fetchedAtMs"] !== "number") return undefined;
  const parsed = parseWellKnownIndex(record["index"]);
  if (!parsed.ok) return undefined;
  return { fetchedAtMs: record["fetchedAtMs"], index: parsed.value };
}

function writeCachedIndex(
  dataDir: string,
  url: string,
  cached: CachedIndex,
): Result<void, Error> {
  const { dir, file } = cachePath(dataDir, url);
  const ensured = ensureContainedDir({ dir, mode: 0o700, confinedBaseDir: dataDir });
  if (!ensured.ok) return err(ensured.error);
  const written = writeRegularFile({
    path: file,
    content: JSON.stringify(cached),
    confinedBaseDir: dataDir,
  });
  return written.ok ? ok(undefined) : err(written.error);
}

async function fetchValidatedIndex(
  url: string,
  fetchDeps: SkillImportFetchDeps,
): Promise<Result<WellKnownIndex, Error>> {
  const fetched = await fetchSkillImportResponse(url, fetchDeps, {
    headers: { Accept: "application/json" },
  });
  if (!fetched.ok) return fetched;
  if (!fetched.value.ok) {
    return err(new Error(`Well-known index request failed: ${fetched.value.status} ${fetched.value.statusText}`));
  }
  const text = await readSkillImportText(fetched.value, MAX_INDEX_BYTES, "skills.import.indexBytes");
  if (!text.ok) return text;
  const decoded = tryCatch(() => JSON.parse(text.value) as unknown);
  if (!decoded.ok) return decoded;
  const parsed = parseWellKnownIndex(decoded.value);
  return parsed.ok ? ok(parsed.value) : err(new Error(`Well-known index shape invalid: ${parsed.error.message}`));
}

/** Resolve, fetch, and return one well-known skill file map. */
export async function fetchWellKnownSkill(
  args: FetchWellKnownSkillArgs,
): Promise<Result<FetchedWellKnownSkill, Error>> {
  const parsedRef = parseWellKnownRef(args.ref);
  if (!parsedRef.ok) return parsedRef;
  const configured = args.registries.find(
    (entry) => entry.kind === "wellknown" && normalizeConfiguredBase(entry.base) === parsedRef.value.base,
  );
  if (configured === undefined) {
    return err(
      new Error(
        `Well-known base ${parsedRef.value.base} is not allowed by skills.import.registries`,
      ),
    );
  }

  const fetchDeps = args.fetchDeps ?? defaultSkillImportFetchDeps;
  const nowMs = (args.nowMs ?? systemNowMs)();
  const url = indexUrl(parsedRef.value.base);
  const cached = readCachedIndex(args.dataDir, url);
  let index: WellKnownIndex;
  let cache: FetchedWellKnownSkill["cache"];
  if (cached !== undefined && nowMs - cached.fetchedAtMs <= args.cacheTtlMs) {
    index = cached.index;
    cache = "hit";
  } else {
    const refreshed = await fetchValidatedIndex(url, fetchDeps);
    if (refreshed.ok) {
      index = refreshed.value;
      cache = "fresh";
      const written = writeCachedIndex(args.dataDir, url, { fetchedAtMs: nowMs, index });
      if (!written.ok) {
        args.logger.warn(
          {
            step: "cache",
            err: written.error.message,
            hint:
              "The import can continue, but the validated index cache was not saved; check skills data-directory ownership.",
            errorKind: "resource" as const,
          },
          "Well-known skill index cache write failed",
        );
      }
    } else if (cached !== undefined) {
      index = cached.index;
      cache = "stale";
      args.logger.warn(
        {
          step: "fetch",
          coverage: "stale_index_cache",
          err: refreshed.error.message,
          hint:
            "The validated cached index is being used because refresh failed; check the configured base and network, then retry the import.",
          errorKind: "dependency" as const,
        },
        "Well-known skill index refresh degraded to stale cache",
      );
    } else {
      return refreshed;
    }
  }

  const resolved = resolveWellKnownSkill(index, parsedRef.value.name);
  if (!resolved.ok) return err(new Error(resolved.error.message));
  const files: SkillBundleFile[] = [];
  let totalBytes = 0;
  for (const path of resolved.value.files) {
    const fetched = await fetchSkillImportResponse(
      memberUrl(parsedRef.value.base, resolved.value.name, path),
      fetchDeps,
    );
    if (!fetched.ok) return fetched;
    if (!fetched.value.ok) {
      return err(new Error(`Well-known skill member ${path} failed: ${fetched.value.status} ${fetched.value.statusText}`));
    }
    const content = await readSkillImportText(
      fetched.value,
      MAX_ENTRY_BYTES,
      "skills.installVetting.maxEntryBytes",
    );
    if (!content.ok) return content;
    totalBytes += new TextEncoder().encode(content.value).byteLength;
    if (totalBytes > MAX_BUNDLE_BYTES) {
      return err(
        new Error(
          `Well-known skill bytes ${totalBytes} exceed skills.installVetting.maxBundleBytes=${MAX_BUNDLE_BYTES}`,
        ),
      );
    }
    files.push({ path, content: content.value });
  }
  args.logger.debug(
    { step: "fetch", source: "wellknown", fileCount: files.length, cache },
    "Well-known skill files fetched",
  );
  return ok({
    name: resolved.value.name,
    files,
    ref: args.ref,
    registryTrust: configured.trust,
    cache,
  });
}

