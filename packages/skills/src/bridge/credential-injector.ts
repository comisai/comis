/**
 * Credential injector: Transparent HTTP credential injection for agent tools.
 *
 * Intercepts outbound fetch() calls from agent tools and injects credentials
 * (bearer tokens, custom headers, query params, basic auth) for matching URLs.
 * Tool code never sees plaintext API keys -- the injection is transparent.
 *
 * Security invariants:
 * - SSRF validation runs BEFORE credential injection (no creds to private IPs)
 * - globalThis.fetch is always restored in finally block after tool execution
 * - Error messages are sanitized to prevent credential leakage in stack traces
 *
 * @module
 */

import type { SecretManager, TypedEventBus, CredentialMapping } from "@comis/core";
import { validateUrl, sanitizeLogString } from "@comis/core";
import type { AgentTool, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Credential injector: creates fetch wrappers that inject credentials for matching URLs. */
export interface CredentialInjector {
  /** Create a fetch function that injects credentials for a specific tool. */
  createInjectedFetch(toolName: string): typeof fetch;
  /** Get a frozen copy of the configured credential mappings. */
  getMappings(): readonly CredentialMapping[];
}

/** Dependencies for creating a credential injector. */
export interface CredentialInjectorDeps {
  /** Secret manager for resolving credential values by name. */
  secretManager: SecretManager;
  /** Credential mappings defining which URLs get which credentials. */
  mappings: CredentialMapping[];
  /** Optional event bus for audit event emission. */
  eventBus?: TypedEventBus;
  /** Optional agent ID for audit event attribution. */
  agentId?: string;
}

// ---------------------------------------------------------------------------
// URL matching
// ---------------------------------------------------------------------------

/**
 * Check whether a request URL matches a credential mapping URL pattern.
 *
 * Matching rules:
 * 1. Parse both URLs (pattern gets "https://" prepended if no protocol)
 * 2. Compare hostnames exactly (case-insensitive via URL normalization)
 * 3. If pattern has a non-root pathname, check request path starts with it
 *
 * @param requestUrl - The full URL being fetched
 * @param urlPattern - The pattern from the credential mapping (hostname or hostname/path)
 * @returns true if the request URL matches the pattern
 */
export function matchesUrl(requestUrl: string, urlPattern: string): boolean {
  try {
    const reqUrl = new URL(requestUrl);
    const patternInput = urlPattern.includes("://")
      ? urlPattern
      : `https://${urlPattern}`;
    const patternUrl = new URL(patternInput);

    // Exact hostname comparison (URL constructor normalizes to lowercase)
    if (reqUrl.hostname !== patternUrl.hostname) {
      return false;
    }

    // Optional path prefix check
    if (patternUrl.pathname && patternUrl.pathname !== "/") {
      if (!reqUrl.pathname.startsWith(patternUrl.pathname)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Credential injection dispatch
// ---------------------------------------------------------------------------

/**
 * Inject a credential into an outbound HTTP request based on the mapping type.
 *
 * @param init - The RequestInit (headers, body, etc.)
 * @param url - The parsed request URL
 * @param mapping - The credential mapping defining injection strategy
 * @param secretValue - The plaintext secret value to inject
 * @returns Updated init and url (url may change for query_param injection)
 */
export function injectCredential(
  init: RequestInit,
  url: URL,
  mapping: CredentialMapping,
  secretValue: string,
): { init: RequestInit; url: URL } {
  const headers = new Headers(init.headers);

  switch (mapping.injectionType) {
    case "bearer_header":
      headers.set("Authorization", `Bearer ${secretValue}`);
      break;

    case "custom_header":
      if (!mapping.injectionKey) {
        throw new Error(
          `Credential mapping "${mapping.id}" has injectionType=custom_header but no injectionKey`,
        );
      }
      headers.set(mapping.injectionKey, secretValue);
      break;

    case "query_param": {
      if (!mapping.injectionKey) {
        throw new Error(
          `Credential mapping "${mapping.id}" has injectionType=query_param but no injectionKey`,
        );
      }
      // Clone URL to avoid mutating the original
      url = new URL(url.toString());
      url.searchParams.set(mapping.injectionKey, secretValue);
      break;
    }

    case "basic_auth":
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(secretValue).toString("base64")}`,
      );
      break;
  }

  return { init: { ...init, headers }, url };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a credential injector that wraps fetch() to transparently inject credentials.
 *
 * The injector captures a reference to the REAL globalThis.fetch at creation time.
 * All HTTP calls (both matched and unmatched) go through this captured reference,
 * not through globalThis.fetch (which will be the wrapper during tool execution).
 *
 * @param deps - Injector dependencies (secret manager, mappings, optional event bus)
 * @returns A frozen CredentialInjector instance
 */
export function createCredentialInjector(
  deps: CredentialInjectorDeps,
): CredentialInjector {
  const { secretManager, mappings, eventBus, agentId } = deps;

  // Capture the REAL fetch before any wrapping occurs.
  // All HTTP calls go through this reference, not globalThis.fetch.
  const realFetch = globalThis.fetch;

  function findMapping(
    requestUrl: string,
    toolName: string,
  ): CredentialMapping | undefined {
    for (const m of mappings) {
      // If mapping is tool-scoped, skip if tool name doesn't match
      if (m.toolName && m.toolName !== toolName) {
        continue;
      }
      if (matchesUrl(requestUrl, m.urlPattern)) {
        return m;
      }
    }
    return undefined;
  }

  function emitAccess(
    secretName: string,
    outcome: "success" | "denied" | "not_found",
  ): void {
    eventBus?.emit("secret:accessed", {
      secretName,
      agentId: agentId ?? "unknown",
      outcome,
      timestamp: Date.now(),
    });
  }

  function createInjectedFetch(toolName: string): typeof fetch {
    return async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      // Extract URL string from input
      let urlString: string;
      if (typeof input === "string") {
        urlString = input;
      } else if (input instanceof URL) {
        urlString = input.toString();
      } else if (input instanceof Request) {
        urlString = input.url;
      } else {
        // Unknown input type -- delegate to real fetch
        return realFetch(input, init);
      }

      // Find matching credential mapping
      const mapping = findMapping(urlString, toolName);
      if (!mapping) {
        // No match -- delegate to real fetch without injection
        return realFetch(input, init);
      }

      // Resolve secret value
      const secretValue = secretManager.get(mapping.secretName);
      if (secretValue === undefined) {
        emitAccess(mapping.secretName, "not_found");
        // Secret not available -- delegate without injection
        return realFetch(input, init);
      }

      emitAccess(mapping.secretName, "success");

      // Parse URL for manipulation
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(urlString);
      } catch {
        // Invalid URL -- delegate to real fetch (it will fail naturally)
        return realFetch(input, init);
      }

      // SSRF check: never send credentials to private/loopback IPs
      const ssrfResult = await validateUrl(urlString);
      if (!ssrfResult.ok) {
        // SSRF validation failed -- do NOT inject credentials, delegate to real fetch
        return realFetch(input, init);
      }

      // Inject credential
      const injected = injectCredential(init ?? {}, parsedUrl, mapping, secretValue);

      // Execute the actual HTTP request with injected credentials
      try {
        return await realFetch(injected.url.toString(), injected.init);
      } catch (error: unknown) {
        // Sanitize error message to prevent credential leakage (e.g., query_param in URL)
        const originalMessage =
          error instanceof Error ? error.message : String(error);
        const sanitizedMessage = sanitizeLogString(originalMessage);
        throw new Error(sanitizedMessage, { cause: error });
      }
    };
  }

  function getMappings(): readonly CredentialMapping[] {
    return Object.freeze([...mappings]);
  }

  return Object.freeze({ createInjectedFetch, getMappings });
}

// ---------------------------------------------------------------------------
// Tool wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap an AgentTool to inject credentials into its outbound HTTP requests.
 *
 * During tool.execute(), globalThis.fetch is replaced with an injected fetch
 * that transparently adds credentials for matching URLs. The original fetch
 * is always restored in the finally block, even if execute() throws.
 *
 * @concurrency WARNING: This function mutates globalThis.fetch for the duration
 * of tool.execute(). If multiple tools execute concurrently in the same Node.js
 * process, their fetch wrappers will conflict. The current architecture runs
 * tools sequentially within a single agent execution loop, making this safe.
 * If parallel tool execution is introduced, migrate to AsyncLocalStorage-based
 * fetch scoping instead of globalThis mutation.
 *
 * @param tool - The AgentTool to wrap
 * @param injector - The credential injector to use
 * @returns A new AgentTool with credential injection
 */
export function wrapWithCredentialInjection(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
  tool: AgentTool<any>,
  injector: CredentialInjector,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AgentTool generic requires `any` per pi-agent-core API
): AgentTool<any> {
  return {
    ...tool,
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) {
      const originalFetch = globalThis.fetch;
      try {
        // CONCURRENCY: Safe only under sequential tool execution. See @concurrency JSDoc.
        globalThis.fetch = injector.createInjectedFetch(tool.name);
        return await tool.execute(toolCallId, params, signal, onUpdate);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  };
}
