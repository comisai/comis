// SPDX-License-Identifier: Apache-2.0
/** Operator-configured registry client boundary contract. */
import { describe, expect, it, vi } from "vitest";
import type {
  SkillImportFetchDeps,
  SkillImportResponse,
} from "./import-fetch.js";
import { resolveRegistryMetadata } from "./registry-client.js";

function response(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): SkillImportResponse {
  const bytes = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 429 ? "Too Many Requests" : "OK",
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? null,
    },
    body: (async function* () {
      if (bytes.byteLength > 0) yield bytes;
    })(),
  };
}

function fetchDeps(
  fetchPinned: SkillImportFetchDeps["fetchPinned"],
): SkillImportFetchDeps {
  return {
    validate: vi.fn(async (url: string) => ({
      ok: true as const,
      value: { url: new URL(url), ip: "203.0.113.10" },
    })),
    fetchPinned,
  };
}

const registries = [
  {
    id: "community-a",
    base: "https://registry.example/api/v1",
    kind: "registry" as const,
    trust: "community" as const,
  },
];

describe("resolveRegistryMetadata", () => {
  it("refuses an unconfigured registry before any network request", async () => {
    const fetchPinned = vi.fn();

    const result = await resolveRegistryMetadata({
      registryId: "missing",
      ref: "summarize",
      registries,
      deps: { fetchDeps: fetchDeps(fetchPinned) },
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "registry_not_configured",
        hint: expect.stringContaining("skills.import.registries"),
      },
    });
    expect(fetchPinned).not.toHaveBeenCalled();
  });

  it("caps retry-after at fifteen seconds and stops after three attempts", async () => {
    const fetchPinned = vi.fn(async () =>
      response("rate limited", 429, { "retry-after": "30" }),
    );
    const sleep = vi.fn(async () => undefined);

    const result = await resolveRegistryMetadata({
      registryId: "community-a",
      ref: "summarize",
      registries,
      deps: { fetchDeps: fetchDeps(fetchPinned), sleep },
    });

    expect(fetchPinned).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[15_000], [15_000]]);
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "rate_limited",
        hint: expect.stringContaining("Retry-After capped at 15000ms"),
      },
    });
  });

  it("resolves latest metadata and records registry verdicts as evidence", async () => {
    const requestedUrls: string[] = [];
    const requestBodies: string[] = [];
    const fetchPinned = vi.fn(async (url: string, _ip: string, init: { method?: string; body?: string }) => {
      requestedUrls.push(url);
      if (init.body !== undefined) requestBodies.push(init.body);
      if (url.endsWith("/skills/summarize")) {
        return response({
          skill: { slug: "summarize" },
          latestVersion: { version: "1.2.3" },
        });
      }
      return response({
        schema: "registry.skill.security-verdicts.v1",
        items: [
          {
            decision: "pass",
            requestedSlug: "summarize",
            slug: "summarize",
            requestedVersion: "1.2.3",
            version: "1.2.3",
            publisherHandle: "publisher_a",
            checkedAt: "2026-07-26T12:00:00.000Z",
            securityAuditUrl: "https://registry.example/publisher_a/summarize/security-audit",
            security: { status: "clean", passed: true },
          },
        ],
      });
    });

    const result = await resolveRegistryMetadata({
      registryId: "community-a",
      ref: "summarize",
      registries,
      deps: { fetchDeps: fetchDeps(fetchPinned) },
    });

    expect(requestedUrls).toEqual([
      "https://registry.example/api/v1/skills/summarize",
      "https://registry.example/api/v1/skills/-/security-verdicts",
    ]);
    expect(JSON.parse(requestBodies[0]!)).toEqual({
      items: [{ slug: "summarize", version: "1.2.3" }],
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        registryTrust: "community",
        resolution: {
          slug: "summarize",
          version: "1.2.3",
          evidence: {
            registryId: "community-a",
            publisherHandle: "publisher_a",
            securityStatus: "clean",
            securityPassed: true,
            registryDecision: "pass",
          },
        },
      },
    });
  });
});
