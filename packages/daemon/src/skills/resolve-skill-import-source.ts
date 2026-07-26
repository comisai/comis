// SPDX-License-Identifier: Apache-2.0
/** Resolve skill-import request variants into one vetted-file-map input shape. */

import {
  parseSkillBundleManifest,
  unpackSkillArchive,
  type SkillBundleFile,
  type SkillRegistryEvidence,
} from "@comis/skills";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import type { ErrorKind } from "@comis/core";
import type { WorkspaceApiDeps } from "../api/types.js";
import { fetchGitHubDir } from "../api/github-skill-fetch.js";
import { readVettingLimits } from "./vet-install-gate.js";
import {
  defaultSkillImportFetchDeps,
  fetchSkillImportResponse,
  readSkillImportBytes,
} from "./import-fetch.js";
import { fetchWellKnownSkill } from "./wellknown-skill-fetch.js";
import { fetchRegistrySkillBundle } from "./registry-client.js";
import type { RegistryClientError } from "./registry-client.js";

/** Import stages surfaced to logs and the request trajectory. */
export type SkillImportFailureStage =
  | "fetch"
  | "preflight"
  | "unpack"
  | "vet"
  | "write"
  | "bundle";

/** Config key responsible for an import refusal, when one exists. */
export type SkillImportPolicyKey =
  | "skills.import.registries"
  | "skills.import.maxArchiveBytes"
  | "skills.import.maxCompressionRatio"
  | "skills.installVetting.maxEntries"
  | "skills.installVetting.maxEntryBytes"
  | "skills.installVetting.maxBundleBytes"
  | "skills.installVetting.maxPathDepth";

/** Structured source-resolution failure used by boundary diagnostics. */
export class SkillImportResolutionError extends Error {
  readonly source: ResolvedSkillImportSource["source"];
  readonly stage: SkillImportFailureStage;
  readonly code: string;
  readonly errorKind: ErrorKind;
  readonly hint: string;
  readonly policyKey: SkillImportPolicyKey | undefined;
  readonly skillName: string | undefined;

  constructor(input: {
    readonly message: string;
    readonly source: ResolvedSkillImportSource["source"];
    readonly stage: SkillImportFailureStage;
    readonly code: string;
    readonly errorKind: ErrorKind;
    readonly hint: string;
    readonly policyKey?: SkillImportPolicyKey;
    readonly skillName?: string;
  }) {
    super(input.message);
    this.name = "SkillImportResolutionError";
    this.source = input.source;
    this.stage = input.stage;
    this.code = input.code;
    this.errorKind = input.errorKind;
    this.hint = input.hint;
    this.policyKey = input.policyKey;
    this.skillName = input.skillName;
  }
}

function resolutionError(
  error: Error,
  metadata: Omit<ConstructorParameters<typeof SkillImportResolutionError>[0], "message">,
): SkillImportResolutionError {
  if (error instanceof SkillImportResolutionError) return error;
  return new SkillImportResolutionError({ ...metadata, message: error.message });
}

const ARCHIVE_RESOURCE_CODES = new Set([
  "archive_size_exceeded",
  "archive_entry_count_exceeded",
  "archive_entry_size_exceeded",
  "archive_total_size_exceeded",
  "archive_ratio_exceeded",
]);

function archivePolicyKey(code: string, message: string): SkillImportPolicyKey | undefined {
  if (code === "archive_size_exceeded" || message.includes("maxArchiveBytes")) {
    return "skills.import.maxArchiveBytes";
  }
  if (code === "archive_ratio_exceeded") return "skills.import.maxCompressionRatio";
  if (code === "archive_entry_count_exceeded") return "skills.installVetting.maxEntries";
  if (code === "archive_entry_size_exceeded") return "skills.installVetting.maxEntryBytes";
  if (code === "archive_total_size_exceeded") return "skills.installVetting.maxBundleBytes";
  return undefined;
}

function classifyArchiveError(error: Error): SkillImportResolutionError {
  if (error instanceof SkillImportResolutionError) return error;
  const archiveCode = /^([a-z_]+):/.exec(error.message)?.[1];
  const code =
    archiveCode?.startsWith("archive_") === true
      ? archiveCode
      : error.message.includes("maxArchiveBytes")
        ? "archive_size_exceeded"
        : error.message.includes("base64")
          ? "archive_encoding_invalid"
          : "archive_fetch_failed";
  const policyKey = archivePolicyKey(code, error.message);
  const isArchivePreflight = code.startsWith("archive_") && code !== "archive_fetch_failed";
  return resolutionError(error, {
    source: "archive",
    stage: isArchivePreflight ? "preflight" : "fetch",
    code,
    errorKind: ARCHIVE_RESOURCE_CODES.has(code) || policyKey === "skills.import.maxArchiveBytes"
      ? "resource"
      : code === "archive_fetch_failed"
        ? "dependency"
        : "validation",
    hint:
      policyKey === undefined
        ? "Use one bounded, unencrypted ZIP archive with a single prompt-skill root."
        : `Review the archive, then change ${policyKey} only when the additional resource use is expected.`,
    ...(policyKey !== undefined && { policyKey }),
  });
}

function classifyWellKnownError(error: Error, skillName?: string): SkillImportResolutionError {
  if (error instanceof SkillImportResolutionError) return error;
  const notAllowlisted = error.message.includes("skills.import.registries");
  const entryCap = error.message.includes("skills.installVetting.maxEntryBytes");
  const bundleCap = error.message.includes("skills.installVetting.maxBundleBytes");
  const invalidRef = error.message.startsWith("Well-known skill ref");
  const policyKey = notAllowlisted
    ? "skills.import.registries"
    : entryCap
      ? "skills.installVetting.maxEntryBytes"
      : bundleCap
        ? "skills.installVetting.maxBundleBytes"
        : undefined;
  return resolutionError(error, {
    source: "wellknown",
    stage: "fetch",
    code: notAllowlisted
      ? "source_not_allowlisted"
      : entryCap || bundleCap
        ? "source_size_exceeded"
        : invalidRef
          ? "source_ref_invalid"
          : "source_fetch_failed",
    errorKind: notAllowlisted ? "config" : entryCap || bundleCap ? "resource" : invalidRef ? "validation" : "dependency",
    hint: notAllowlisted
      ? "Add the reviewed base to skills.import.registries for this agent, then retry."
      : policyKey !== undefined
        ? `Review the fetched bundle, then change ${policyKey} only when the additional resource use is expected.`
        : "Check the well-known reference, validated index shape, and outbound network access.",
    ...(policyKey !== undefined && { policyKey }),
    ...(skillName !== undefined && { skillName }),
  });
}

function classifyRegistryError(error: RegistryClientError, skillName?: string): SkillImportResolutionError {
  const configFailure =
    error.kind === "registry_not_configured" || error.kind === "invalid_registry_config";
  const validationFailure =
    error.kind === "invalid_ref" || error.kind === "invalid_response" || error.kind === "identity_mismatch";
  const archiveCode = /^([a-z_]+):/.exec(error.message)?.[1];
  const code = archiveCode?.startsWith("archive_") === true ? archiveCode : error.kind;
  const policyKey =
    configFailure
      ? "skills.import.registries"
      : error.message.includes("maxArchiveBytes")
        ? "skills.import.maxArchiveBytes"
        : archivePolicyKey(code, error.message);
  return new SkillImportResolutionError({
    message: `${error.kind}: ${error.message}. ${error.hint}`,
    source: "registry",
    stage: error.kind === "invalid_archive" ? "preflight" : error.kind === "identity_mismatch" ? "vet" : "fetch",
    code,
    errorKind: configFailure
      ? "config"
      : ARCHIVE_RESOURCE_CODES.has(code) || policyKey === "skills.import.maxArchiveBytes"
        ? "resource"
        : validationFailure || error.kind === "invalid_archive"
          ? "validation"
          : "dependency",
    hint: error.hint,
    ...(policyKey !== undefined && { policyKey }),
    ...(skillName !== undefined && { skillName }),
  });
}

function sourceIdentityError(
  source: "github" | "wellknown",
  error: Error,
  skillName: string,
): SkillImportResolutionError {
  return resolutionError(error, {
    source,
    stage: "vet",
    code: "source_identity_mismatch",
    errorKind: "validation",
    hint: "Make the source name and the SKILL.md manifest name identical, then retry.",
    skillName,
  });
}

/** Current RPC request variants. */
export type SkillImportSourceRequest =
  | {
      readonly source?: "github";
      readonly url: string;
    }
  | {
      readonly source: "wellknown";
      readonly ref: string;
    }
  | {
      readonly source: "archive";
      readonly archiveBase64: string;
    }
  | {
      readonly source: "archive";
      readonly archiveUrl: string;
    }
  | {
      readonly source: "registry";
      readonly registry: string;
      readonly ref: string;
    };

/** Common output consumed by the one write/vet/install path. */
export interface ResolvedSkillImportSource {
  readonly name: string;
  readonly files: readonly SkillBundleFile[];
  readonly source: "github" | "archive" | "wellknown" | "registry";
  readonly ref: string;
  readonly registryTrust?: "community" | "operator";
  readonly evidence?: SkillRegistryEvidence;
}

function parseGitHubDirUrl(
  url: string,
): { owner: string; repo: string; branch: string; path: string } | undefined {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/(.+)$/);
  if (match === null) return undefined;
  return {
    owner: match[1]!,
    repo: match[2]!,
    branch: match[3]!,
    path: match[4]!.replace(/\/$/, ""),
  };
}

function validSkillName(name: string | undefined): name is string {
  return (
    name !== undefined &&
    name.length <= 64 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name) &&
    !name.includes("--")
  );
}

function requireMatchingManifestName(
  files: readonly SkillBundleFile[],
  expectedName: string,
): Result<void, Error> {
  const parsed = parseSkillBundleManifest(files);
  if (!parsed.ok) {
    return parsed.error.kind === "missing"
      ? err(new Error(parsed.error.message))
      : ok(undefined);
  }
  if (parsed.value.manifest.name !== expectedName) {
    return err(
      new Error(
        `Skill manifest name ${parsed.value.manifest.name} does not match source name ${expectedName}`,
      ),
    );
  }
  return ok(undefined);
}

function decodeArchiveBase64(
  encoded: string,
  maxArchiveBytes: number,
): Result<Uint8Array, Error> {
  const maxEncodedLength = Math.ceil(maxArchiveBytes / 3) * 4;
  if (encoded.length > maxEncodedLength) {
    return err(
      new Error(
        `Archive encoded bytes ${encoded.length} exceed skills.import.maxArchiveBytes=${maxArchiveBytes}`,
      ),
    );
  }
  if (encoded.length % 4 !== 0) return err(new Error("Archive base64 is not canonical"));
  const paddingIndex = encoded.indexOf("=");
  const contentEnd = paddingIndex === -1 ? encoded.length : paddingIndex;
  if (paddingIndex !== -1) {
    const padding = encoded.length - paddingIndex;
    if (padding > 2 || !encoded.slice(paddingIndex).split("").every((char) => char === "=")) {
      return err(new Error("Archive base64 has invalid padding"));
    }
  }
  for (let index = 0; index < contentEnd; index++) {
    const code = encoded.charCodeAt(index);
    const allowed =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!allowed) return err(new Error("Archive base64 contains an invalid character"));
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) {
    return err(new Error("Archive base64 is not canonical"));
  }
  if (decoded.byteLength > maxArchiveBytes) {
    return err(
      new Error(
        `Archive bytes ${decoded.byteLength} exceed skills.import.maxArchiveBytes=${maxArchiveBytes}`,
      ),
    );
  }
  return ok(Uint8Array.from(decoded));
}

async function resolveArchive(
  request: Extract<SkillImportSourceRequest, { source: "archive" }>,
  deps: WorkspaceApiDeps,
  callingAgentId: string,
): Promise<Result<ResolvedSkillImportSource, Error>> {
  const importConfig = deps.agents[callingAgentId]?.skills?.import;
  const vettingLimits = readVettingLimits(deps, callingAgentId);
  const maxArchiveBytes = importConfig?.maxArchiveBytes ?? 8 * 1024 * 1024;
  let bytes: Uint8Array;
  let ref: string;
  if ("archiveBase64" in request) {
    const decoded = decodeArchiveBase64(request.archiveBase64, maxArchiveBytes);
    if (!decoded.ok) return decoded;
    bytes = decoded.value;
    ref = "uploaded";
  } else {
    const parsedUrl = tryCatch(() => new URL(request.archiveUrl.trim()));
    if (!parsedUrl.ok) return parsedUrl;
    if (parsedUrl.value.username !== "" || parsedUrl.value.password !== "") {
      return err(new Error("Archive URL must not contain credentials"));
    }
    const fetched = await fetchSkillImportResponse(
      parsedUrl.value.toString(),
      deps.skillImportFetchDeps ?? defaultSkillImportFetchDeps,
    );
    if (!fetched.ok) return fetched;
    if (!fetched.value.ok) {
      return err(
        new Error(
          `Archive request failed: ${fetched.value.status} ${fetched.value.statusText}`,
        ),
      );
    }
    const read = await readSkillImportBytes(
      fetched.value,
      maxArchiveBytes,
      "skills.import.maxArchiveBytes",
    );
    if (!read.ok) return read;
    bytes = read.value;
    parsedUrl.value.search = "";
    parsedUrl.value.hash = "";
    ref = parsedUrl.value.toString();
  }
  deps.logger.debug(
    { method: "skills.import", source: "archive", step: "preflight", archiveBytes: bytes.byteLength },
    "Skill archive preflight started",
  );
  const unpacked = unpackSkillArchive(bytes, {
    maxArchiveBytes,
    maxCompressionRatio: importConfig?.maxCompressionRatio ?? 100,
    maxEntries: vettingLimits?.maxEntries ?? 200,
    maxEntryBytes: vettingLimits?.maxEntryBytes ?? 4 * 1024 * 1024,
    maxBundleBytes: vettingLimits?.maxBundleBytes ?? 32 * 1024 * 1024,
    maxPathDepth: vettingLimits?.maxPathDepth ?? 10,
  });
  if (!unpacked.ok) {
    return err(new Error(`${unpacked.error.code}: ${unpacked.error.message}`));
  }
  deps.logger.debug(
    { method: "skills.import", source: "archive", step: "unpack", fileCount: unpacked.value.length },
    "Skill archive unpacked",
  );
  const parsedManifest = parseSkillBundleManifest(unpacked.value);
  if (!parsedManifest.ok) {
    return err(
      new SkillImportResolutionError({
        message: parsedManifest.error.message,
        source: "archive",
        stage: "vet",
        code:
          parsedManifest.error.kind === "missing"
            ? "BUNDLE_MANIFEST_MISSING"
            : parsedManifest.error.kind === "not_prompt"
              ? "BUNDLE_MANIFEST_NOT_PROMPT"
              : "BUNDLE_MANIFEST_UNPARSEABLE",
        errorKind: "validation",
        hint: "Provide one valid prompt-skill manifest at the archive root, then retry.",
      }),
    );
  }
  return ok({
    name: parsedManifest.value.manifest.name,
    files: unpacked.value,
    source: "archive",
    ref,
  });
}

/** Resolve one request without writing any live skill file. */
export async function resolveSkillImportSource(
  request: SkillImportSourceRequest,
  deps: WorkspaceApiDeps,
  callingAgentId: string,
): Promise<Result<ResolvedSkillImportSource, Error>> {
  if (request.source === "archive") {
    const resolved = await resolveArchive(request, deps, callingAgentId);
    return resolved.ok ? resolved : err(classifyArchiveError(resolved.error));
  }
  if (request.source === "wellknown") {
    const importConfig = deps.agents[callingAgentId]?.skills?.import;
    const vettingLimits = readVettingLimits(deps, callingAgentId);
    const fetched = await fetchWellKnownSkill({
      ref: request.ref,
      dataDir: deps.container.config.dataDir || ".",
      registries: importConfig?.registries ?? [],
      cacheTtlMs: importConfig?.indexCacheTtlMs ?? 3_600_000,
      ...(vettingLimits?.maxEntryBytes !== undefined && {
        maxEntryBytes: vettingLimits.maxEntryBytes,
      }),
      ...(vettingLimits?.maxBundleBytes !== undefined && {
        maxBundleBytes: vettingLimits.maxBundleBytes,
      }),
      ...(deps.skillImportFetchDeps !== undefined && { fetchDeps: deps.skillImportFetchDeps }),
      logger: deps.logger,
    });
    if (!fetched.ok) {
      return err(classifyWellKnownError(fetched.error));
    }
    const identity = requireMatchingManifestName(fetched.value.files, fetched.value.name);
    if (!identity.ok) {
      return err(sourceIdentityError("wellknown", identity.error, fetched.value.name));
    }
    return ok({
      name: fetched.value.name,
      files: fetched.value.files,
      source: "wellknown",
      ref: fetched.value.ref,
      registryTrust: fetched.value.registryTrust,
    });
  }
  if (request.source === "registry") {
    const importConfig = deps.agents[callingAgentId]?.skills?.import;
    const vettingLimits = readVettingLimits(deps, callingAgentId);
    const fetched = await fetchRegistrySkillBundle({
      registryId: request.registry,
      ref: request.ref,
      registries: importConfig?.registries ?? [],
      limits: {
        maxArchiveBytes: importConfig?.maxArchiveBytes ?? 8 * 1024 * 1024,
        maxCompressionRatio: importConfig?.maxCompressionRatio ?? 100,
        maxEntries: vettingLimits?.maxEntries ?? 200,
        maxEntryBytes: vettingLimits?.maxEntryBytes ?? 4 * 1024 * 1024,
        maxBundleBytes: vettingLimits?.maxBundleBytes ?? 32 * 1024 * 1024,
        maxPathDepth: vettingLimits?.maxPathDepth ?? 10,
      },
      ...(deps.skillImportFetchDeps !== undefined && {
        deps: { fetchDeps: deps.skillImportFetchDeps },
      }),
    });
    if (!fetched.ok) {
      return err(classifyRegistryError(fetched.error));
    }
    return ok({
      name: fetched.value.name,
      files: fetched.value.files,
      source: "registry",
      ref: fetched.value.ref,
      registryTrust: fetched.value.registryTrust,
      evidence: fetched.value.evidence,
    });
  }

  const url = request.url.trim();
  if (url.length === 0) {
    return err(
      new SkillImportResolutionError({
        message: "URL is required",
        source: "github",
        stage: "fetch",
        code: "source_ref_invalid",
        errorKind: "validation",
        hint: "Provide one GitHub directory URL, then retry.",
      }),
    );
  }
  const parsed = parseGitHubDirUrl(url);
  if (parsed === undefined) {
    return err(
      new SkillImportResolutionError({
        message: "Invalid GitHub URL. Expected: https://github.com/{owner}/{repo}/tree/{branch}/{path}",
        source: "github",
        stage: "fetch",
        code: "source_ref_invalid",
        errorKind: "validation",
        hint: "Provide one GitHub directory URL in the documented tree form, then retry.",
      }),
    );
  }
  const segments = parsed.path.split("/").filter(Boolean);
  const name = segments[segments.length - 1];
  if (!validSkillName(name)) {
    return err(
      new SkillImportResolutionError({
        message: `Invalid skill name derived from URL: "${name}". Must be lowercase alphanumeric with hyphens.`,
        source: "github",
        stage: "fetch",
        code: "source_identity_invalid",
        errorKind: "validation",
        hint: "Rename the source directory to a valid skill identifier, then retry.",
      }),
    );
  }
  const fetched = await fromPromise(
    fetchGitHubDir(
      parsed.owner,
      parsed.repo,
      parsed.path,
      parsed.branch,
      deps.skillImportFetchDeps,
    ),
  );
  if (!fetched.ok) {
    const resourceFailure = fetched.error.message.includes("exceed");
    const policyKey = fetched.error.message.includes("maxEntryBytes")
      ? "skills.installVetting.maxEntryBytes"
      : fetched.error.message.includes("maxBundleBytes")
        ? "skills.installVetting.maxBundleBytes"
        : undefined;
    return err(
      resolutionError(fetched.error, {
        source: "github",
        stage: "fetch",
        code: resourceFailure ? "source_size_exceeded" : "source_fetch_failed",
        errorKind: resourceFailure ? "resource" : "dependency",
        hint:
          policyKey === undefined
            ? "Check the repository URL and outbound network access, then retry."
            : `Review the fetched bundle, then change ${policyKey} only when the additional resource use is expected.`,
        ...(policyKey !== undefined && { policyKey }),
        skillName: name,
      }),
    );
  }
  if (fetched.value.length === 0) {
    return err(
      new SkillImportResolutionError({
        message: "No files found at the given URL",
        source: "github",
        stage: "fetch",
        code: "source_empty",
        errorKind: "validation",
        hint: "Point the import at a non-empty skill directory, then retry.",
        skillName: name,
      }),
    );
  }
  const identity = requireMatchingManifestName(fetched.value, name);
  if (!identity.ok) return err(sourceIdentityError("github", identity.error, name));
  return ok({ name, files: fetched.value, source: "github", ref: url });
}
