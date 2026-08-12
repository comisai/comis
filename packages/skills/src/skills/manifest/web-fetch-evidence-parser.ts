// SPDX-License-Identifier: Apache-2.0
/** Defensive parsing for optional prompt-skill web research evidence metadata. */

import {
  MinDistinctWebFetchUrlsSchema,
  MinDistinctWebSearchQueriesSchema,
} from "./schema.js";

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

/** Keep a malformed optional search-query declaration from hiding the skill. */
export function parseMinDistinctWebSearchQueriesDefensively(
  raw: unknown,
  skillName: string,
  logger?: EvidenceParserLogger,
): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = MinDistinctWebSearchQueriesSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  logger?.warn(
    {
      skillName,
      errorKind: "validation" as const,
      hint:
        "Set comis.min-distinct-web-search-queries to an integer from 1 through 10.",
    },
    "Ignoring malformed prompt skill web-search evidence metadata",
  );
  return undefined;
}
