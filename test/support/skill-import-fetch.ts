// SPDX-License-Identifier: Apache-2.0
/** Test-only skill-import fetch seam that delegates to each test's mocked global fetch. */
import { ok } from "@comis/shared";
import type {
  SkillImportFetchDeps,
  SkillImportResponse,
} from "../../packages/daemon/src/skills/import-fetch.js";

export function createGlobalFetchSkillImportDeps(): SkillImportFetchDeps {
  return {
    validate: async (url) =>
      ok({ hostname: new URL(url).hostname, ip: "198.51.100.30", url: new URL(url) }),
    fetchPinned: async (url, _pinnedIp, init) =>
      globalThis.fetch(url, init as RequestInit) as unknown as Promise<SkillImportResponse>,
  };
}
