// SPDX-License-Identifier: Apache-2.0
/** Defensive parsing for optional prompt-skill web-fetch evidence metadata. */

import { MinDistinctWebFetchUrlsSchema } from "./schema.js";

interface EvidenceParserLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Keep a malformed optional evidence declaration from hiding the skill. */
export function parseMinDistinctWebFetchUrlsDefensively(
  raw: unknown,
  skillName: string,
  logger?: EvidenceParserLogger,
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = MinDistinctWebFetchUrlsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logger?.warn(
    {
      skillName,
      errorKind: "validation" as const,
      hint:
        "Set comis.min-distinct-web-fetch-urls to an integer from 1 through 10.",
    },
    "Ignoring malformed prompt skill web-fetch evidence metadata",
  );
  return undefined;
}
