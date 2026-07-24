// SPDX-License-Identifier: Apache-2.0
//
// silent-tokens predicate, idempotence, exports.
//
// Imports resolve at runtime via dynamic import + try/catch so the test
// reaches assertions even when the module does not yet exist (tests
// must FAIL with assertion errors, not module-not-found errors that
// abort the suite).
import { describe, it, expect } from "vitest";

// Dynamic import wrapper: returns the module or undefined.
async function loadSilentTokens(): Promise<
  | {
      isSilentResponse: (s: string | undefined) => boolean;
      stripReplyTags: (s: string) => string;
      NO_REPLY_TOKEN: string;
      HEARTBEAT_OK_TOKEN: string;
      SILENT_PREFIX: string;
    }
  | undefined
> {
  try {
    // The module path is intentionally a string literal so vitest's static
    // analyzer doesn't fail at import-time when the file doesn't exist.
    const mod = (await import("./silent-tokens.js")) as Record<string, unknown>;
    return mod as unknown as {
      isSilentResponse: (s: string | undefined) => boolean;
      stripReplyTags: (s: string) => string;
      NO_REPLY_TOKEN: string;
      HEARTBEAT_OK_TOKEN: string;
      SILENT_PREFIX: string;
    };
  } catch {
    return undefined;
  }
}

describe("silent-tokens module", () => {
  it("isSilentResponse classifies tokens vs substantive text", async () => {
    const mod = await loadSilentTokens();
    expect(mod).toBeDefined();
    if (!mod) return;

    expect(mod.isSilentResponse("NO_REPLY")).toBe(true);
    expect(mod.isSilentResponse("HEARTBEAT_OK")).toBe(true);
    expect(mod.isSilentResponse("[SILENT] context")).toBe(true);
    expect(mod.isSilentResponse("Hello")).toBe(false);
    expect(mod.isSilentResponse(undefined)).toBe(true);
    expect(mod.isSilentResponse("")).toBe(true);
  });

  it("stripReplyTags removes <reply> wrappers and trims", async () => {
    const mod = await loadSilentTokens();
    expect(mod).toBeDefined();
    if (!mod) return;

    expect(mod.stripReplyTags("<reply>NO_REPLY</reply>")).toBe("NO_REPLY");
    expect(mod.stripReplyTags("  <reply>  X  </reply>  ")).toBe("X");
  });

  it("stripReplyTags preserves similarly prefixed element names", async () => {
    const mod = await loadSilentTokens();
    expect(mod).toBeDefined();
    if (!mod) return;

    expect(mod.stripReplyTags("<replying>keep</replying>")).toBe(
      "<replying>keep</replying>",
    );
  });

  it("exported token constants match canonical values", async () => {
    const mod = await loadSilentTokens();
    expect(mod).toBeDefined();
    if (!mod) return;

    expect(mod.NO_REPLY_TOKEN).toBe("NO_REPLY");
    expect(mod.HEARTBEAT_OK_TOKEN).toBe("HEARTBEAT_OK");
    expect(mod.SILENT_PREFIX).toBe("[SILENT]");
  });
});

describe("isSilentResponse idempotence under stripReplyTags + trim", () => {
  it("agrees on raw and pre-stripped input", async () => {
    const mod = await loadSilentTokens();
    expect(mod).toBeDefined();
    if (!mod) return;

    const cases = [
      "NO_REPLY",
      "<reply>NO_REPLY</reply>",
      "  <reply>  NO_REPLY  </reply>  ",
      "HEARTBEAT_OK",
      "[SILENT] some context",
      "I used NO_REPLY in my example", // substantive — not silent
      "", // empty — silent
    ];
    for (const c of cases) {
      // For the empty / undefined cases, the predicate should still be defined,
      // and stripReplyTags should return the unchanged input.
      expect(mod.isSilentResponse(c)).toBe(mod.isSilentResponse(mod.stripReplyTags(c)));
    }
  });
});

describe("source-grep: index.ts re-exports silent-tokens + visible-delivery", () => {
  it("source-grep: packages/shared/src/index.ts re-exports new modules", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const indexPath = path.resolve(here, "index.ts");
    const src = fs.readFileSync(indexPath, "utf-8");
    // Strip line + block comments so the gate cannot be self-invalidated.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // index.ts re-exports the new modules.
    expect(stripped).toContain("./silent-tokens.js");
    expect(stripped).toContain("./visible-delivery.js");
  });
});
