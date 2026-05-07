// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

describe("inbound-route uses BackgroundSessionResolver for active-session lookup (B30 / T0.27)", () => {
  it("source-grep: imports the resolver and does NOT directly call activeRunRegistry.get(", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "inbound-route.ts"), "utf-8");
    // Strip block + line comments so the gate cannot be self-invalidated.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    // The file imports the resolver (one of two acceptable
    // names — `resolveActiveSession` direct call or
    // `BackgroundSessionResolver` factory).
    const importsResolver =
      stripped.includes("resolveActiveSession") ||
      stripped.includes("BackgroundSessionResolver");
    expect(importsResolver).toBe(true);

    // NO literal activeRunRegistry.get( in the production source.
    expect(stripped).not.toMatch(/activeRunRegistry\.get\(/);
  });
});
