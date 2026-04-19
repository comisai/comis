/**
 * Hash-based router with parameterized route support for the Comis SPA.
 *
 * Supports 27 route patterns with named parameters (e.g., `:id`, `:type`).
 * Routes are matched longest-first to ensure specific patterns like
 * `observe/billing` take priority over `observe` with a parameter.
 *
 * Usage:
 *   const router = createRouter((match) => renderView(match));
 *   router.start(); // begins listening for hashchange
 */

/** Matched route information */
export interface RouteMatch {
  /** The view tag name (e.g., "ic-agent-list") */
  view: string;
  /** Base route name (e.g., "agents") */
  route: string;
  /** Extracted params (e.g., { id: "default" }) */
  params: Record<string, string>;
  /** Query parameters parsed from hash URL (e.g., #/sessions?filter=active) */
  query: Record<string, string>;
}

/** Router control interface */
export interface Router {
  /** Navigate to a path (sets window.location.hash) */
  navigate(path: string): void;
  /** Get the current route match */
  current(): RouteMatch;
  /** Start listening for hash changes */
  start(): void;
  /** Stop listening */
  stop(): void;
  /** Update URL query parameters without triggering a full navigation */
  setQuery(params: Record<string, string>): void;
}

/** Internal route definition */
interface RouteDefinition {
  /** Pattern string (e.g., "agents/:id/edit") */
  pattern: string;
  /** View tag name to render */
  view: string;
  /** Pattern segments for matching */
  segments: string[];
  /** Number of segments (used for longest-match sorting) */
  segmentCount: number;
}

/**
 * The full route table for the Comis operator console.
 * Order does not matter - routes are sorted by segment count (longest first).
 */
const ROUTE_TABLE: ReadonlyArray<{ pattern: string; view: string }> = [
  { pattern: "dashboard", view: "ic-dashboard" },
  { pattern: "agents", view: "ic-agent-list" },
  { pattern: "agents/:id", view: "ic-agent-detail" },
  { pattern: "agents/:id/edit", view: "ic-agent-editor" },
  { pattern: "agents/:id/workspace", view: "ic-workspace-manager" },
  { pattern: "channels", view: "ic-channel-list" },
  { pattern: "channels/:type", view: "ic-channel-detail" },
  { pattern: "messages", view: "ic-message-center" },
  { pattern: "messages/:type", view: "ic-message-center" },
  { pattern: "skills", view: "ic-skills-view" },
  { pattern: "mcp", view: "ic-mcp-management" },
  { pattern: "chat", view: "ic-chat-console" },
  { pattern: "chat/:sessionKey", view: "ic-chat-console" },
  { pattern: "memory", view: "ic-memory-inspector" },
  { pattern: "sessions", view: "ic-session-list-view" },
  { pattern: "sessions/:key", view: "ic-session-detail" },
  { pattern: "scheduler", view: "ic-scheduler-view" },
  { pattern: "scheduler/:jobId", view: "ic-scheduler-view" },
  { pattern: "models", view: "ic-models-view" },
  { pattern: "observe/overview", view: "ic-observe-dashboard" },
  { pattern: "observe/context", view: "ic-context-engine-view" },
  { pattern: "observe/billing", view: "ic-billing-view" },
  { pattern: "observe/delivery", view: "ic-delivery-view" },
  { pattern: "observe/diagnostics", view: "ic-diagnostics-view" },
  { pattern: "context", view: "ic-context-dag-browser" },
  { pattern: "subagents", view: "ic-subagents-view" },
  { pattern: "media", view: "ic-media-test-view" },
  { pattern: "media/config", view: "ic-media-config-view" },
  { pattern: "security", view: "ic-security-view" },
  { pattern: "approvals", view: "ic-approvals-view" },
  { pattern: "config", view: "ic-config-editor" },
  { pattern: "setup", view: "ic-setup-wizard" },
  { pattern: "pipelines", view: "ic-pipeline-list" },
  { pattern: "pipelines/new", view: "ic-pipeline-builder" },
  { pattern: "pipelines/history", view: "ic-pipeline-history" },
  { pattern: "pipelines/history/:graphId", view: "ic-pipeline-history-detail" },
  { pattern: "pipelines/:graphId", view: "ic-pipeline-monitor" },
  { pattern: "pipelines/:graphId/edit", view: "ic-pipeline-builder" },
];

/**
 * Build compiled route definitions sorted by segment count (longest first).
 * This ensures specific routes like "observe/billing" match before "observe" + param.
 */
function compileRoutes(): RouteDefinition[] {
  return ROUTE_TABLE.map((r) => {
    const segments = r.pattern.split("/");
    return {
      pattern: r.pattern,
      view: r.view,
      segments,
      segmentCount: segments.length,
    };
  }).sort((a, b) => b.segmentCount - a.segmentCount);
}

/** Default route match when no route is matched */
const DEFAULT_MATCH: RouteMatch = {
  view: "ic-dashboard",
  route: "dashboard",
  params: {},
  query: {},
};

/**
 * Match a path against the compiled route definitions.
 *
 * @param path - The path to match (without #/ prefix)
 * @param routes - Compiled route definitions (sorted longest first)
 * @returns The matched route or null
 */
function matchRoute(path: string, routes: RouteDefinition[]): RouteMatch | null {
  // Split the path into segments. Session keys can contain colons (e.g., "agent:default:telegram:12345"),
  // so we need to handle that during param extraction, not during splitting.
  const pathSegments = path.split("/");

  for (const route of routes) {
    // First check: if the path has fewer segments than non-param segments, skip.
    // But for param routes, the param can consume the rest via exact segment count match.
    if (pathSegments.length !== route.segmentCount) continue;

    const params: Record<string, string> = {};
    let matched = true;

    for (let i = 0; i < route.segments.length; i++) {
      const routeSegment = route.segments[i];
      const pathSegment = pathSegments[i];

      if (routeSegment.startsWith(":")) {
        // Named parameter - capture it
        params[routeSegment.slice(1)] = pathSegment;
      } else if (routeSegment !== pathSegment) {
        matched = false;
        break;
      }
    }

    if (matched) {
      return { view: route.view, route: route.pattern, params, query: {} };
    }
  }

  return null;
}

/**
 * Route aliases for backward compatibility.
 * Old paths redirect silently to new canonical paths via history.replaceState.
 */
const ROUTE_ALIASES: ReadonlyArray<{ from: string; to: string }> = [
  { from: "observe", to: "observe/overview" },
  // Future phases may add more aliases as routes are restructured
  // e.g., { from: "security", to: "configure/security" }
];

/**
 * Create a hash-based router with parameterized route support.
 *
 * @param onChange - Called when the route changes with the matched RouteMatch
 * @param defaultRoute - Route to navigate to when hash is empty (default: "dashboard")
 * @returns A Router instance
 */
export function createRouter(
  onChange: (match: RouteMatch) => void,
   
  _defaultRoute: string = "dashboard",
): Router {
  const compiledRoutes = compileRoutes();

  function resolveHash(): RouteMatch {
    const raw = window.location.hash.replace(/^#\/?/, "");
    if (!raw) return { ...DEFAULT_MATCH };

    // Split path from query string
    const qIndex = raw.indexOf("?");
    const path = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
    const queryString = qIndex >= 0 ? raw.slice(qIndex + 1) : "";

    // Parse query parameters
    const query: Record<string, string> = {};
    if (queryString) {
      for (const pair of queryString.split("&")) {
        const eqIndex = pair.indexOf("=");
        if (eqIndex >= 0) {
          const key = decodeURIComponent(pair.slice(0, eqIndex));
          const value = decodeURIComponent(pair.slice(eqIndex + 1));
          if (key) query[key] = value;
        } else if (pair) {
          query[decodeURIComponent(pair)] = "";
        }
      }
    }

    // Check aliases - use history.replaceState to avoid hashchange loop
    for (const alias of ROUTE_ALIASES) {
      if (path === alias.from) {
        const newHash = queryString
          ? `#/${alias.to}?${queryString}`
          : `#/${alias.to}`;
        history.replaceState(null, "", newHash);
        // Re-resolve with the new path (no infinite loop since replaceState
        // does not fire hashchange)
        const match = matchRoute(alias.to, compiledRoutes);
        if (match) return { ...match, query };
        return { ...DEFAULT_MATCH, query };
      }
    }

    const match = matchRoute(path, compiledRoutes);
    if (match) return { ...match, query };
    return { ...DEFAULT_MATCH, query };
  }

  function handleChange(): void {
    const match = resolveHash();
    onChange(match);
  }

  return {
    navigate(path: string): void {
      window.location.hash = `#/${path}`;
    },

    current(): RouteMatch {
      return resolveHash();
    },

    start(): void {
      window.addEventListener("hashchange", handleChange);
      handleChange();
    },

    stop(): void {
      window.removeEventListener("hashchange", handleChange);
    },

    setQuery(params: Record<string, string>): void {
      const current = resolveHash();
      const merged = { ...current.query, ...params };
      // Remove keys with empty string values
      const filtered = Object.entries(merged).filter(([, v]) => v !== "");
      const qs = filtered.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
      const newHash = qs ? `#/${current.route}?${qs}` : `#/${current.route}`;
      history.replaceState(null, "", newHash);
    },
  };
}
