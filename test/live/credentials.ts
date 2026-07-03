// SPDX-License-Identifier: Apache-2.0
/**
 * Credential Registry — maps present API keys to unlockable test categories
 * and produces typed SKIPPED(reason) verdicts without ever failing for absence.
 *
 * Information Disclosure guard: env var values never leave this module;
 * CredentialRegistry.hasKey() returns boolean only — the key value itself is
 * never exported, serialized, or included in error messages.
 *
 * @module
 */
import { execSync } from "node:child_process";

/**
 * Exhaustive closed union of all possible skip verdicts.
 * A verdict of null means "no skip — proceed with the scenario".
 */
export type SkipVerdict =
  | "SKIPPED(no-creds)"
  | "SKIPPED(linux-only)"
  | "SKIPPED(macos-only)"
  | "SKIPPED(no-bwrap)"
  | "SKIPPED(no-platform)"
  | "SKIPPED(no-capability)"
  | "SKIPPED(budget-exceeded)"
  | null;

/**
 * A category string (e.g., "LLM(anthropic)", "CACHE(Anthropic)", "STT(openai)").
 * Using string type — categories are checked via the mapping table.
 */
export type Category = string;

/**
 * Capability enum — per-model capabilities for the skip-not-fail gate.
 */
export type Capability = "vision" | "tools" | "structured-output" | "thinking";

/**
 * Env-var → category mapping table.
 * All 13 documented API keys listed here.
 */
const KEY_TO_CATEGORIES: Record<string, Category[]> = {
  ANTHROPIC_API_KEY: ["LLM(anthropic)", "CACHE(Anthropic)", "vision(anthropic)"],
  OPENAI_API_KEY: ["LLM(openai)", "STT(openai)", "TTS(openai)", "vision(openai)", "image-gen(openai)", "embedding(openai)"],
  GOOGLE_API_KEY: ["LLM(google)", "CACHE(Gemini)", "vision(google)", "vision-video(google)"],
  GROQ_API_KEY: ["LLM(groq)", "STT(groq)"],
  DEEPGRAM_API_KEY: ["STT(deepgram)"],
  ELEVENLABS_API_KEY: ["TTS(elevenlabs)"],
  FAL_KEY: ["image-gen(fal)"],
  SEARCH_API_KEY: ["search(brave)"],
  TAVILY_API_KEY: ["search(tavily)"],
  EXA_API_KEY: ["search(exa)"],
  PERPLEXITY_API_KEY: ["search(perplexity)"],
  XAI_API_KEY: ["search(grok)"],
  JINA_API_KEY: ["search(jina)"],
};

/**
 * Categories that do not require any API key — these are keyless probes
 * that must always be runnable regardless of what credentials are present.
 * getSkipVerdict returns null for these before the no-creds fallthrough.
 */
const KEYLESS_CATEGORIES = new Set<string>([
  "TTS(edge)",
  "search(duckduckgo)",
  "search(searxng)",
  "mcp.transport=stdio",
  "channel-echo",
]);

/**
 * Per-model capability registry — pinned model snapshot IDs mapped to
 * supported capabilities. For the skip-not-fail gate.
 */
export const CAPABILITY_REGISTRY: Record<string, Capability[]> = {
  "claude-3-5-haiku-20241022": ["tools", "structured-output"],
  "claude-3-5-sonnet-20241022": ["vision", "tools", "structured-output", "thinking"],
  "gpt-4o-mini": ["vision", "tools", "structured-output"],
  "gemini-1.5-flash": ["vision", "tools", "structured-output"],
};

/**
 * The runtime credential registry interface — returned by buildCredentialRegistry().
 */
export interface CredentialRegistry {
  /**
   * Returns the set of categories unlocked by present env vars at build time.
   */
  getUnlockedCategories(): Category[];

  /**
   * Returns a SkipVerdict for the given category or platform check string,
   * or null if the check passes (no skip needed).
   *
   * Special check strings:
   *   "linux-only" — returns SKIPPED(linux-only) when not on Linux
   *   "bwrap"      — on Linux: checks execSync("which bwrap"); on darwin: SKIPPED(linux-only)
   *
   * Category strings: returns SKIPPED(no-creds) if not in unlocked set, null if present.
   */
  getSkipVerdict(categoryOrPlatform: string): SkipVerdict;

  /**
   * Returns true if the given env var name was present and non-empty at build time.
   * Value is never returned — boolean only.
   */
  hasKey(envVar: string): boolean;
}

/**
 * Check if bwrap is available on the current Linux system.
 * Returns true if available, false if not.
 * On non-Linux platforms this should never be called directly — use getSkipVerdict("bwrap").
 */
function isBwrapAvailable(): boolean {
  try {
    execSync("which bwrap", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a CredentialRegistry by reading all 13 documented API keys from env
 * at call time. The registry captures a boolean snapshot — key values never
 * escape the module boundary.
 */
export function buildCredentialRegistry(): CredentialRegistry {
  // Capture presence (boolean only) for all known keys at call time.
  // Values are never stored or returned.
  const presentKeys = new Set<string>(
    Object.keys(KEY_TO_CATEGORIES).filter(
      (k) => {
        const v = process.env[k];
        return v !== undefined && v !== "";
      },
    ),
  );

  // Compute unlocked categories from present keys.
  const unlockedCategories: Category[] = [];
  for (const key of presentKeys) {
    const cats = KEY_TO_CATEGORIES[key];
    if (cats) {
      for (const cat of cats) {
        if (!unlockedCategories.includes(cat)) {
          unlockedCategories.push(cat);
        }
      }
    }
  }

  return {
    getUnlockedCategories(): Category[] {
      return [...unlockedCategories];
    },

    getSkipVerdict(categoryOrPlatform: string): SkipVerdict {
      // Platform-level checks
      if (categoryOrPlatform === "linux-only") {
        return process.platform !== "linux" ? "SKIPPED(linux-only)" : null;
      }

      if (categoryOrPlatform === "bwrap") {
        if (process.platform !== "linux") {
          // darwin and other non-linux platforms cannot have bwrap
          return "SKIPPED(linux-only)";
        }
        return isBwrapAvailable() ? null : "SKIPPED(no-bwrap)";
      }

      if (categoryOrPlatform === "macos-only") {
        return process.platform !== "darwin" ? "SKIPPED(macos-only)" : null;
      }

      // Keyless categories: always runnable, no credentials required
      if (KEYLESS_CATEGORIES.has(categoryOrPlatform)) {
        return null;
      }

      // Category-level check: not in unlockedCategories → SKIPPED(no-creds)
      return unlockedCategories.includes(categoryOrPlatform)
        ? null
        : "SKIPPED(no-creds)";
    },

    hasKey(envVar: string): boolean {
      return presentKeys.has(envVar);
    },
  };
}
