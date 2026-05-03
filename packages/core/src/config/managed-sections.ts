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
  /**
   * Compact schema fragment so the LLM can call the tool without a separate
   * discover_tools round-trip. Populated when the action enum + required
   * fields fit in < 20 lines of hint text. Verified against the tool's
   * TypeBox parameter schema as of this commit.
   *
   * Bug B (260428-gj6): production trace c7b91328 showed the agent burning
   * ~30s × 4 LLM calls re-loading the agents_manage schema after an
   * immutable-path rejection. Surfacing the fragment inline closes that
   * round-trip tax.
   */
  schemaFragment?: {
    /** Valid `action` enum values (pinned to the tool's TypeBox Union literals). */
    actions: readonly string[];
    /**
     * Required field names per action -- only entries that are strictly
     * required by the tool's handler (omitting Type.Optional fields with
     * sensible defaults). Omit the whole property when no action has
     * required-beyond-action fields (e.g., channels_manage operates on
     * existing entries only).
     */
    requiredByAction?: Record<string, readonly string[]>;
  };
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
    // Action enum pinned to mcp-manage-tool.ts TypeBox Union (lines 25-31).
    // requiredByAction.connect captures the stdio-transport happy path
    // (transport="sse"|"http" requires `url` instead of `command` -- the
    // exampleArgs above documents the stdio shape, the schema fragment
    // documents required fields for that same shape).
    schemaFragment: {
      actions: ["list", "status", "connect", "disconnect", "reconnect"],
      requiredByAction: {
        connect: ["name", "transport", "command"],
      },
    },
  },
  {
    pathPrefix: "gateway.tokens",
    tool: "tokens_manage",
    description: "Manage gateway tokens (list, create, revoke, rotate).",
    // Verified against tokens-manage-tool.ts TokensManageToolParams.
    exampleArgs: { action: "create", token_id: "<token-id>", scopes: ["rpc", "ws"] },
    fullyManaged: true,
    // Action enum pinned to tokens-manage-tool.ts TypeBox Union (lines 25-31).
    // token_id is genuinely Type.Optional (auto-generated when omitted, per
    // the schema description at L36); only `scopes` is strictly required for
    // create.
    schemaFragment: {
      actions: ["list", "create", "revoke", "rotate"],
      requiredByAction: {
        create: ["scopes"],
      },
    },
  },
  {
    pathPrefix: "providers",
    tool: "providers_manage",
    description:
      "Manage LLM providers (list, get, create, update, delete, enable, disable).",
    // Verified against providers-manage-tool.ts ProvidersManageToolParams.
    exampleArgs: {
      action: "create",
      provider_id: "<any-name>",
      config: {
        type: "<sdk-type>",
        name: "<display-name>",
        baseUrl: "<api-base-url>",
        apiKeyName: "<SECRET_KEY_NAME>",
        models: [{ id: "<model-id>" }],
      },
    },
    fullyManaged: true,
    // Action enum pinned to providers-manage-tool.ts TypeBox Union.
    // provider_id + config are required for create; other actions require
    // only provider_id or nothing (list).
    schemaFragment: {
      actions: ["list", "get", "create", "update", "delete", "enable", "disable"],
      requiredByAction: {
        create: ["provider_id", "config"],
      },
    },
  },
  {
    pathPrefix: "channels",
    tool: "channels_manage",
    description:
      "Manage channel adapters (list, get, enable, disable, restart, configure).",
    // No exampleArgs -- no create-equivalent action; channels are configured
    // via operator config + media-setting toggles only.
    fullyManaged: false,
    // Action enum pinned to channels-manage-tool.ts TypeBox Union (lines 32-37).
    // No requiredByAction -- channels_manage operates on existing entries; all
    // fields beyond `action` are looked up from config or optional.
    schemaFragment: {
      actions: ["list", "get", "enable", "disable", "restart", "configure"],
    },
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
        // Phase 9 R8 (plan 06): advertise the per-agent OAuth profile
        // preference to the LLM. Maps provider → "<provider>:<identity>"
        // stored profile ID. Validated end-to-end by Plan 02's Zod refine
        // and Plan 06's daemon-side has() existence check.
        oauthProfiles: { "openai-codex": "openai-codex:user@example.com" },
      },
    },
    fullyManaged: true,
    // Action enum pinned to agents-manage-tool.ts TypeBox Union (lines 27-32).
    // agent_id is required on every action (Type.String, not Optional);
    // config is required for create (the action handler rejects create
    // without a config payload, even though the schema marks it Optional to
    // accept the alternate JSON-string fallback shape).
    schemaFragment: {
      actions: ["create", "get", "update", "delete", "suspend", "resume"],
      requiredByAction: {
        create: ["agent_id", "config"],
      },
    },
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
 * Sonnet/Opus 4.x because that tool is not in their payload (260428-oyc
 * production repro: agent saw "Recovery: (1) call discover_tools(...)" and
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

  // Bug B (260428-gj6): inline the dedicated tool's action enum + required
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
