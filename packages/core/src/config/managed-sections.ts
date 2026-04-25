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

/** A single redirect entry: which tool, and a parameter-correct example. */
export interface ManagedSectionRedirect {
  /** Path prefix that triggers this redirect (e.g., "agents", "integrations.mcp.servers"). */
  pathPrefix: string;
  /** Tool name (matches the registered AgentTool name). */
  tool: string;
  /** One-line description that includes the tool's full action list. */
  description: string;
  /**
   * Concrete example arguments for the most common create-equivalent action.
   * Shape MUST match the tool's TypeBox parameter schema exactly -- verified
   * against the tool source as of this commit. Omit when the tool has no
   * "create" semantics (e.g., channels_manage cannot add new platform types).
   */
  exampleArgs?: Record<string, unknown>;
  /**
   * True when the tool fully replaces gateway-patch for this section
   * (create + update + delete). False when it can only operate on entries
   * already present in config.
   */
  fullyManaged: boolean;
}

/**
 * Registered managed sections.
 *
 * Order matters: longest pathPrefix first, so getManagedSectionRedirect picks
 * the most specific match (e.g., "integrations.mcp.servers" wins over a
 * hypothetical "integrations" entry).
 */
export const MANAGED_SECTIONS: readonly ManagedSectionRedirect[] = [
  {
    pathPrefix: "integrations.mcp.servers",
    tool: "mcp_manage",
    description:
      "Manage MCP server connections (list, status, connect, disconnect, reconnect).",
    // Flat parameter shape -- verified against mcp-manage-tool.ts McpManageToolParams.
    exampleArgs: {
      action: "connect",
      name: "<server-name>",
      transport: "stdio",
      command: "<command>",
      args: [],
    },
    fullyManaged: true,
  },
  {
    pathPrefix: "gateway.tokens",
    tool: "tokens_manage",
    description: "Manage gateway tokens (list, create, revoke, rotate).",
    // Verified against tokens-manage-tool.ts TokensManageToolParams.
    exampleArgs: { action: "create", token_id: "<token-id>", scopes: ["rpc", "ws"] },
    fullyManaged: true,
  },
  {
    pathPrefix: "channels",
    tool: "channels_manage",
    description:
      "Manage channel adapters (list, get, enable, disable, restart, configure).",
    // No exampleArgs -- no create-equivalent action; channels are configured
    // via operator config + media-setting toggles only.
    fullyManaged: false,
  },
  {
    pathPrefix: "agents",
    tool: "agents_manage",
    description: "Manage agent fleet (create, get, update, delete, suspend, resume).",
    // Verified against agents-manage-tool.ts AgentsManageToolParams.
    exampleArgs: {
      action: "create",
      agent_id: "<new-agent-id>",
      config: {
        name: "<display-name>",
        model: "<model-id>",
        provider: "<provider>",
        maxSteps: 100,
      },
    },
    fullyManaged: true,
  },
] as const;

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
 * The output uses an explicit two-step "Recovery:" framing because smaller
 * models (Haiku 4.5, Gemini Flash, GPT-OSS-20b) parse numbered steps more
 * reliably than prose. The example call is JSON-stringified compactly so it
 * can be copy-pasted into the next tool invocation.
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
    parts.push(
      `Recovery: (1) call discover_tools("${redirect.tool}") to load the schema, then (2) call ${redirect.tool}(${example}).`,
    );
  } else {
    parts.push(
      `Load it via discover_tools("${redirect.tool}") if not yet available.`,
    );
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
