// SPDX-License-Identifier: Apache-2.0
/**
 * Single source of truth: which immutable config sections delegate to which
 * dedicated management tool, and what an LLM-readable redirect looks like.
 *
 * gateway/apply, gateway/patch, and config.* RPC immutability guards all
 * consume this module so their hints stay in sync. Adding a new managed
 * section is a one-line entry here -- no code changes anywhere else.
 *
 * Designed to be model-agnostic: the hint includes the tool name, the
 * discover_tools call to load it, and a parameter-correct example call body
 * (verified against each tool's TypeBox schema). Every capable LLM --
 * Opus/Sonnet/Haiku, GPT-5, Gemini 2.5/3 Flash/Pro, Mistral -- can imitate
 * the JSON example verbatim without further prompting.
 *
 * @module
 */

// ManagedSectionRedirect interface (Phase 30, CONFIG-DELIV-02):
// declared in section-registry.ts so the registry can own its own type
// without importing back from this file (which would re-introduce the
// section-registry.ts ↔ managed-sections.ts source-level cycle that the
// architecture no-cycles invariant rejects). Re-exported here so existing
// consumers reading `import type { ManagedSectionRedirect } from
// "./managed-sections.js"` (or via the public config index) keep working
// unchanged.
import {
  SECTION_REGISTRY,
  SUB_PATH_MANAGED_REDIRECTS,
  type ManagedSectionRedirect,
} from "./section-registry.js";

export type { ManagedSectionRedirect } from "./section-registry.js";

/**
 * Registered managed sections.
 *
 * Derived from the single SECTION_REGISTRY source of truth (Phase 30,
 * CONFIG-DELIV-02): top-level redirects live on each section entry's
 * `managedRedirect` field (3: providers, channels, agents), sub-path
 * redirects whose keys are NOT top-level section names live in
 * `SUB_PATH_MANAGED_REDIRECTS` (2: integrations.mcp.servers, gateway.tokens).
 *
 * Order matters: longest pathPrefix first, so getManagedSectionRedirect picks
 * the most specific match (e.g., "integrations.mcp.servers" wins over a
 * hypothetical "integrations" entry). The sort below guarantees that
 * ordering regardless of registry insertion order.
 */

export const MANAGED_SECTIONS: readonly ManagedSectionRedirect[] = Object.freeze(
  [
    // Top-level redirects from registry (3: providers, channels, agents).
    ...Object.values(SECTION_REGISTRY)
      .map((entry) => entry.managedRedirect)
      .filter((r): r is ManagedSectionRedirect => r !== undefined),
    // Sub-path redirects (2: integrations.mcp.servers, gateway.tokens).
    ...SUB_PATH_MANAGED_REDIRECTS,
  ]
    // Longest-prefix-first ordering for correct getManagedSectionRedirect lookup.
    // Stable across runs because pathPrefix lengths are all distinct in the
    // current 5-entry set: 24, 14, 9, 8, 6.
    .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length),
);

/**
 * Resolve the management redirect for a given section/key path.
 *
 * Picks the longest matching pathPrefix. Matches when fullPath equals or is a
 * child of a redirect's pathPrefix. Returns undefined when no dedicated tool
 * covers this path -- callers fall back to the generic immutable message.
 */
export function getManagedSectionRedirect(
  section: string | undefined,
  key?: string,
): ManagedSectionRedirect | undefined {
  if (!section) return undefined;
  const fullPath = key ? `${section}.${key}` : section;
  let best: ManagedSectionRedirect | undefined;
  for (const candidate of MANAGED_SECTIONS) {
    const matches =
      fullPath === candidate.pathPrefix ||
      fullPath.startsWith(candidate.pathPrefix + ".");
    if (matches && (!best || candidate.pathPrefix.length > best.pathPrefix.length)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Format an LLM-readable hint for an immutability rejection.
 *
 * Output is a single-step "Recovery: call <tool>(<example>)." line: the
 * dedicated `*_manage` tool auto-loads on first direct invocation under
 * every supported provider path:
 *
 * - Anthropic Sonnet/Opus 4.x: request-body-injector strips client-side
 *   `discover_tools` from the payload and marks deferred tools
 *   `defer_loading: true`; calling the tool by name auto-loads it.
 * - Anthropic Haiku / OpenAI / xAI / Google: tools surface via the
 *   client-side `discover_tools` corpus, but a stub-filter wraps deferred
 *   entries so that calling the tool by name still works first try (the
 *   stub forwards to the real tool and registers it as discovered).
 *
 * Naming `discover_tools` in the hint actively misleads Anthropic
 * Sonnet/Opus 4.x because that tool is not in their payload (production
 * repro: agent saw "Recovery: (1) call discover_tools(...)" and
 * gave up, reporting "I don't have a discover_tools function"). The
 * single-step framing works on every provider.
 *
 * The example call is JSON-stringified compactly so it can be copy-pasted
 * verbatim into the next tool invocation.
 *
 * @param redirect - The matched managed-section entry
 * @param mutablePaths - Optional override paths for in-place patching of
 *                      EXISTING entries (from getMutableOverridesForSection)
 */
export function formatRedirectHint(
  redirect: ManagedSectionRedirect,
  mutablePaths?: readonly string[],
): string {
  const parts: string[] = [];

  parts.push(`Use the "${redirect.tool}" tool: ${redirect.description}`);

  if (redirect.exampleArgs) {
    const example = JSON.stringify(redirect.exampleArgs);
    parts.push(`Recovery: call ${redirect.tool}(${example}).`);
  } else {
    parts.push(
      `Call ${redirect.tool} directly; it will auto-load on first invocation.`,
    );
  }

  // Bug B: inline the dedicated tool's action enum + required
  // fields so the LLM can call it without a separate discover_tools round-
  // trip. Positioned AFTER the Recovery example (so the example is the first
  // thing the model sees) and BEFORE the mutablePaths block (which is the
  // alternative path for already-existing entries).
  if (redirect.schemaFragment) {
    parts.push(`Tool actions: ${redirect.schemaFragment.actions.join(", ")}.`);
    if (redirect.schemaFragment.requiredByAction) {
      for (const [action, fields] of Object.entries(
        redirect.schemaFragment.requiredByAction,
      )) {
        parts.push(`Required fields for \`${action}\`: ${fields.join(", ")}.`);
      }
    }
  }

  if (mutablePaths && mutablePaths.length > 0) {
    parts.push(
      `For in-place updates of an entry that ALREADY exists, gateway/patch also accepts these specific paths: ${mutablePaths.join(", ")}.`,
    );
  }

  if (!redirect.fullyManaged) {
    parts.push(
      `Note: this tool operates on entries already present in config; adding brand-new platform types still requires operator config edits.`,
    );
  }

  return parts.join(" ");
}
