// SPDX-License-Identifier: Apache-2.0
/** GitHub skill source must use the shared validated, DNS-pinned fetch seam. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok } from "@comis/shared";
import { fetchGitHubDir } from "./github-skill-fetch.js";
import type { SkillImportFetchDeps, SkillImportResponse } from "../skills/import-fetch.js";

function response(body: string, contentType: string): SkillImportResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": contentType, "content-length": String(bytes.byteLength) }),
    body: (async function* (): AsyncGenerator<Uint8Array> {
      yield bytes;
    })(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchGitHubDir remote fetch policy", () => {
  it("validates and pins both the API listing and each downloaded file", async () => {
    const validate = vi.fn(async (url: string) =>
      ok({ hostname: new URL(url).hostname, ip: "198.51.100.20", url: new URL(url) }),
    );
    const fetchPinned = vi.fn(async (url: string) =>
      url.startsWith("https://api.github.com/")
        ? response(
            JSON.stringify([
              {
                name: "SKILL.md",
                type: "file",
                download_url: "https://raw.example/SKILL.md",
                path: "skills/demo/SKILL.md",
              },
            ]),
            "application/json",
          )
        : response("---\nname: demo\ndescription: Demo\n---\nBody\n", "text/markdown"),
    );
    const fetchDeps: SkillImportFetchDeps = { validate, fetchPinned };
    const bareFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("bare fetch used"));

    const files = await fetchGitHubDir(
      "owner",
      "repo",
      "skills/demo",
      "main",
      fetchDeps as unknown as string,
    );

    expect(files).toEqual([
      {
        path: "SKILL.md",
        content: "---\nname: demo\ndescription: Demo\n---\nBody\n",
      },
    ]);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(fetchPinned).toHaveBeenCalledTimes(2);
    expect(bareFetch).not.toHaveBeenCalled();
  });
});

