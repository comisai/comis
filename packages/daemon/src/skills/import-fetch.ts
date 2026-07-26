// SPDX-License-Identifier: Apache-2.0
/**
 * Shared remote-fetch substrate for skill imports.
 *
 * Every request is URL-validated, connected through the validator's pinned IP,
 * and issued with manual redirects so each redirect target is independently
 * validated. Response bodies are consumed through a separate bounded reader
 * that checks both Content-Length and the bytes actually streamed.
 *
 * @module
 */

import { validateUrl, type ValidatedUrl } from "@comis/core";
import { fetchPinned as pinnedFetch } from "@comis/skills/tools";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

/** Minimal response surface shared by undici and test fixtures. */
export interface SkillImportResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: { get(name: string): string | null };
  readonly body: AsyncIterable<Uint8Array> | null;
}

/** Request options accepted by the pinned-fetch seam. */
export interface SkillImportRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly redirect?: "manual";
}

/** Injectable security seams; production uses {@link defaultSkillImportFetchDeps}. */
export interface SkillImportFetchDeps {
  readonly validate: (url: string) => Promise<Result<ValidatedUrl, Error>>;
  readonly fetchPinned: (
    url: string,
    pinnedIp: string,
    init: SkillImportRequestInit,
  ) => Promise<SkillImportResponse>;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

/** Production dependencies: public SSRF validator plus DNS-pinned undici fetch. */
export const defaultSkillImportFetchDeps: SkillImportFetchDeps = {
  validate: validateUrl,
  fetchPinned: (url, pinnedIp, init) =>
    pinnedFetch(url, pinnedIp, init as Parameters<typeof pinnedFetch>[2]),
  timeoutMs: 10_000,
  maxRedirects: 3,
};

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Fetch one response after SSRF validation, following only revalidated redirects. */
export async function fetchSkillImportResponse(
  initialUrl: string,
  deps: SkillImportFetchDeps = defaultSkillImportFetchDeps,
  init: Omit<SkillImportRequestInit, "signal" | "redirect"> = {},
): Promise<Result<SkillImportResponse, Error>> {
  const maxRedirects = deps.maxRedirects ?? 3;
  const timeoutMs = deps.timeoutMs ?? 10_000;
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const validated = await deps.validate(currentUrl);
    if (!validated.ok) return validated;

    const fetched = await fromPromise(
      deps.fetchPinned(validated.value.url.toString(), validated.value.ip, {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    if (!fetched.ok) return fetched;
    if (!REDIRECT_STATUSES.has(fetched.value.status)) return fetched;

    if (redirectCount === maxRedirects) {
      return err(new Error(`Skill import redirect count exceeds limit ${maxRedirects}`));
    }
    const location = fetched.value.headers.get("location");
    if (location === null) {
      return err(new Error(`Skill import redirect ${fetched.value.status} omitted Location`));
    }
    const resolved = tryCatch(() => new URL(location, validated.value.url).toString());
    if (!resolved.ok) return resolved;
    currentUrl = resolved.value;
  }

  return err(new Error("Skill import redirect loop ended unexpectedly"));
}

/** Read a response body without ever accumulating more than `maxBytes`. */
export async function readSkillImportBytes(
  response: SkillImportResponse,
  maxBytes: number,
  configKey: string,
): Promise<Result<Uint8Array, Error>> {
  const declaredRaw = response.headers.get("content-length");
  if (declaredRaw !== null) {
    const declared = Number(declaredRaw);
    if (Number.isFinite(declared) && declared > maxBytes) {
      return err(
        new Error(`Skill import declared bytes ${declared} exceed ${configKey}=${maxBytes}`),
      );
    }
  }
  if (response.body === null) return ok(new Uint8Array());

  return fromPromise(
    (async () => {
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of response.body!) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          throw new Error(`Skill import actual bytes ${total} exceed ${configKey}=${maxBytes}`);
        }
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    })(),
  );
}

/** Read bounded UTF-8 text through the same byte cap. */
export async function readSkillImportText(
  response: SkillImportResponse,
  maxBytes: number,
  configKey: string,
): Promise<Result<string, Error>> {
  const bytes = await readSkillImportBytes(response, maxBytes, configKey);
  if (!bytes.ok) return bytes;
  return ok(new TextDecoder("utf-8", { fatal: true }).decode(bytes.value));
}

