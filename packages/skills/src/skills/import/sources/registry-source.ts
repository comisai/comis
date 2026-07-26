// SPDX-License-Identifier: Apache-2.0
/**
 * Pure response mapping for operator-configured skill registries.
 *
 * Registry metadata is untrusted evidence. This module validates the remote
 * projection and binds it to the exact requested slug/version, but never turns
 * publisher or security claims into a Comis trust tier.
 *
 * @module
 */

import { systemDateFrom } from "@comis/core";
import { err, ok, type Result } from "@comis/shared";
import { z } from "zod";
import type { SkillBundleFile } from "../bundle-types.js";

const SLUG_PATTERN = /^[a-z0-9-]+$/;
const MAX_DATE_MS = 8_640_000_000_000_000;

const RegistryDetailSchema = z.object({
  skill: z.object({ slug: z.string().min(1).max(64) }),
  latestVersion: z.object({ version: z.string().min(1).max(128) }).nullable(),
});

const RegistryVerdictItemSchema = z.object({
  decision: z.string().min(1).max(64),
  requestedSlug: z.string().min(1).max(64),
  slug: z.string().min(1).max(64),
  requestedVersion: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  publisherHandle: z.string().min(1).max(256).nullable().optional(),
  publisherVerified: z.boolean().nullable().optional(),
  checkedAt: z
    .union([
      z.number().int().nonnegative().max(MAX_DATE_MS),
      z.string().datetime({ offset: true }),
    ])
    .nullable()
    .optional(),
  securityAuditUrl: z.url().nullable().optional(),
  security: z
    .object({
      status: z.string().min(1).max(64),
      passed: z.boolean(),
    })
    .nullable()
    .optional(),
});

const RegistryVerdictSchema = z.object({
  schema: z.string().min(1).optional(),
  items: z.array(RegistryVerdictItemSchema).length(1),
});

/** Exact registry reference after request parsing. */
export interface SkillRegistryRef {
  readonly slug: string;
  readonly version?: string;
}

/** Registry claims retained for operator inspection; never a trust grant. */
export interface SkillRegistryEvidence {
  readonly publisherHandle?: string;
  readonly publisherVerified?: boolean;
  readonly securityStatus?: string;
  readonly securityPassed?: boolean;
  readonly securityAuditUrl?: string;
  readonly checkedAt?: string;
  readonly registryDecision?: string;
}

/** Validated remote resolution ready for fetch and local vetting. */
export interface SkillRegistryResolution {
  readonly slug: string;
  readonly version: string;
  readonly download:
    | { readonly kind: "archive"; readonly url: string }
    | { readonly kind: "files"; readonly files: readonly SkillBundleFile[] };
  readonly evidence: SkillRegistryEvidence;
}

/** Closed registry error taxonomy for deterministic daemon hints. */
export type RegistryError =
  | { readonly kind: "invalid_ref"; readonly message: string }
  | { readonly kind: "invalid_response"; readonly message: string }
  | { readonly kind: "identity_mismatch"; readonly message: string };

/** Narrow adapter contract; concrete network behavior belongs in the daemon. */
export interface SkillRegistryAdapter {
  readonly id: string;
  resolve(ref: SkillRegistryRef): Promise<Result<SkillRegistryResolution, RegistryError>>;
}

function isValidVersion(version: string): boolean {
  return version.length > 0 && version.length <= 128 && !/[\s/\\]/.test(version);
}

/** Parse `slug` or `slug@version` without accepting path-like references. */
export function parseSkillRegistryRef(
  input: string,
): Result<SkillRegistryRef, RegistryError> {
  const normalized = input.trim();
  const separator = normalized.lastIndexOf("@");
  const slug = separator === -1 ? normalized : normalized.slice(0, separator);
  const version = separator === -1 ? undefined : normalized.slice(separator + 1);
  if (
    slug.length > 64 ||
    !SLUG_PATTERN.test(slug) ||
    slug.startsWith("-") ||
    slug.endsWith("-") ||
    slug.includes("--") ||
    (version !== undefined && !isValidVersion(version))
  ) {
    return err({
      kind: "invalid_ref",
      message: "Registry reference must be a lowercase skill slug with an optional @version",
    });
  }
  return ok({ slug, ...(version !== undefined && { version }) });
}

function normalizeCheckedAt(value: number | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return typeof value === "number" ? systemDateFrom(value).toISOString() : value;
}

/** Bind validated metadata and verdict evidence to the exact requested identity. */
export function mapSkillRegistryResolution(args: {
  readonly ref: SkillRegistryRef;
  readonly detail: unknown;
  readonly verdict: unknown;
  readonly downloadUrl: string;
}): Result<SkillRegistryResolution, RegistryError> {
  const detail = RegistryDetailSchema.safeParse(args.detail);
  if (!detail.success) {
    return err({ kind: "invalid_response", message: `Invalid registry detail: ${detail.error.message}` });
  }
  if (detail.data.skill.slug !== args.ref.slug) {
    return err({
      kind: "identity_mismatch",
      message: `Registry resolved ${args.ref.slug} as ${detail.data.skill.slug}`,
    });
  }
  const version = args.ref.version ?? detail.data.latestVersion?.version;
  if (version === undefined || !isValidVersion(version)) {
    return err({ kind: "invalid_response", message: "Registry detail omitted a valid version" });
  }

  const verdict = RegistryVerdictSchema.safeParse(args.verdict);
  if (!verdict.success) {
    return err({ kind: "invalid_response", message: `Invalid registry verdict: ${verdict.error.message}` });
  }
  const item = verdict.data.items[0];
  if (
    item.requestedSlug !== args.ref.slug ||
    item.slug !== args.ref.slug ||
    item.requestedVersion !== version ||
    item.version !== version
  ) {
    return err({
      kind: "identity_mismatch",
      message: `Registry verdict did not match ${args.ref.slug}@${version}`,
    });
  }

  const downloadUrl = z.url().safeParse(args.downloadUrl);
  if (!downloadUrl.success) {
    return err({ kind: "invalid_response", message: "Registry produced an invalid download URL" });
  }
  const checkedAt = normalizeCheckedAt(item.checkedAt);
  const evidence: SkillRegistryEvidence = {
    ...(item.publisherHandle !== undefined && item.publisherHandle !== null && {
      publisherHandle: item.publisherHandle,
    }),
    ...(item.publisherVerified !== undefined && item.publisherVerified !== null && {
      publisherVerified: item.publisherVerified,
    }),
    ...(item.security !== undefined && item.security !== null && {
      securityStatus: item.security.status,
      securityPassed: item.security.passed,
    }),
    ...(item.securityAuditUrl !== undefined && item.securityAuditUrl !== null && {
      securityAuditUrl: item.securityAuditUrl,
    }),
    ...(checkedAt !== undefined && { checkedAt }),
    registryDecision: item.decision,
  };
  return ok({
    slug: args.ref.slug,
    version,
    download: { kind: "archive", url: downloadUrl.data },
    evidence,
  });
}
