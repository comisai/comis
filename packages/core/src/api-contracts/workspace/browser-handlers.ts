// SPDX-License-Identifier: Apache-2.0
/**
 * Browser-handlers contract slice.
 *
 * Mirrors `packages/daemon/src/api/browser-handlers.ts` (13 methods).
 * Spread order in `BROWSER_HANDLERS_CONTRACTS` matches the
 * `WORKSPACE_CONTRACTS` array byte for byte to keep
 * `contracts.generated.*` artifacts byte-identical.
 *
 * @module
 */
import { z } from "zod";
import { defineContract } from "../types.js";

// ===========================================================================
// Shared sub-schemas (allowlist shapes only).
// ===========================================================================

/**
 * Loose-record value type. Same definition as in `workspace-handlers.ts`
 * — module-private (not exported) so the cross-file duplication is safe.
 */
const LooseRecord = z.record(z.string(), z.unknown());

/**
 * Browser.tabs / browser.open / focus result — `TabInfo` from
 * `packages/skills/src/tools/browser/browser-service.ts:75-80`. Tight
 * model (4 string fields).
 */
const BrowserTabInfoSchema = z.object({
  targetId: z.string(),
  title: z.string(),
  url: z.string(),
  type: z.string(),
});

/**
 * Browser.status result — `BrowserStatus` from
 * `packages/skills/src/tools/browser/browser-service.ts:58-65`. Tight
 * model.
 */
const BrowserStatusSchema = z.object({
  running: z.boolean(),
  chromeVersion: z.string().optional(),
  cdpPort: z.number(),
  activeTabs: z.number(),
  connected: z.boolean(),
});

// ===========================================================================
// --- browser-handlers.ts ---
// ===========================================================================

/**
 * `browser.status` — query the browser service status (running flag,
 * chrome version, CDP port, active tab count, connection state). RPC
 * scope. Read-only.
 *
 * Request: `{}` (no params). The handler resolves `_agentId` from the
 * dispatcher-injected internals and routes via `getAgentBrowserService`.
 *
 * Response: `BrowserStatus` shape.
 */
export const BrowserStatusContract = defineContract({
  method: "browser.status",
  request: z.object({}),
  response: BrowserStatusSchema,
  scopes: ["rpc"] as const,
});

/**
 * `browser.start` — launch the per-agent Chrome instance and connect
 * Playwright via CDP. RPC scope. Idempotent (returns success when
 * already running).
 *
 * Response: `{ started: true }`.
 */
export const BrowserStartContract = defineContract({
  method: "browser.start",
  request: z.object({}),
  response: z.object({
    started: z.literal(true),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.stop` — disconnect Playwright and stop the Chrome instance.
 * RPC scope. Idempotent.
 *
 * Response: `{ stopped: true }`.
 */
export const BrowserStopContract = defineContract({
  method: "browser.stop",
  request: z.object({}),
  response: z.object({
    stopped: z.literal(true),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.navigate` — navigate the current (or specified) tab to a
 * URL. RPC scope. The handler passes `{ url, targetId? }` to the
 * BrowserService; the service-layer enforces ALLOWED_NAV_PROTOCOLS
 * (http: / https: / about:).
 *
 * Note: the handler reads `params.targetUrl` (NOT `params.url`) — the
 * dispatcher accepts the agent-tool param name `targetUrl` and forwards
 * it through. The contract models the handler-read name verbatim.
 *
 * Response: `NavigateResult = { url, title, targetId: string | null }`.
 * `targetId` is nullable (the underlying playwright session may not
 * have a stable id for the new page).
 */
export const BrowserNavigateContract = defineContract({
  method: "browser.navigate",
  request: z.object({
    targetUrl: z.string().min(1),
    targetId: z.string().optional(),
  }),
  response: z.object({
    url: z.string(),
    title: z.string(),
    targetId: z.string().nullable(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.snapshot` — accessibility-tree snapshot of the current or
 * specified tab. RPC scope. Several optional knobs control snapshot
 * shape (interactive-only, max-depth, compact filter, CSS selector
 * scope, max-chars cap).
 *
 * Response: loose record. The underlying `SnapshotResult`
 * (`packages/skills/src/tools/browser/playwright-snapshots.ts:49-56`)
 * carries `refs: RoleRefMap` (a `Record<string, unknown>` of role→ref
 * mappings) plus `stats: { lines, chars, refs, interactive }`. Tight
 * modeling would force every RoleRefMap value-shape into the wire
 * contract.
 */
export const BrowserSnapshotContract = defineContract({
  method: "browser.snapshot",
  request: z.object({
    targetId: z.string().optional(),
    interactive: z.boolean().optional(),
    depth: z.number().optional(),
    compact: z.boolean().optional(),
    selector: z.string().optional(),
    maxChars: z.number().optional(),
  }),
  response: LooseRecord,
  scopes: ["rpc"] as const,
});

/**
 * `browser.screenshot` — capture a screenshot of the current or
 * specified tab. RPC scope. The handler base64-encodes the buffer
 * before returning (browser-handlers.ts:82). Optional `fullPage`,
 * `ref`/`element` (snapshot-ref-scoped capture), and `type` (png |
 * jpeg) knobs.
 *
 * Response: `{ base64: string, mimeType: string }`.
 */
export const BrowserScreenshotContract = defineContract({
  method: "browser.screenshot",
  request: z.object({
    targetId: z.string().optional(),
    fullPage: z.boolean().optional(),
    ref: z.string().optional(),
    element: z.string().optional(),
    type: z.enum(["png", "jpeg"]).optional(),
  }),
  response: z.object({
    base64: z.string(),
    mimeType: z.string(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.pdf` — render the current or specified tab to PDF. RPC
 * scope. Base64-encoded buffer return.
 *
 * Response: `{ base64: string, mimeType: string }`.
 */
export const BrowserPdfContract = defineContract({
  method: "browser.pdf",
  request: z.object({
    targetId: z.string().optional(),
  }),
  response: z.object({
    base64: z.string(),
    mimeType: z.string(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.act` — execute a UI action (click, type, press, hover,
 * drag, select, fill, close) on the current page. RPC scope. The
 * `request` field is a `BrowserAction` (`ActParams`) — a discriminated
 * union over the 8 action shapes whose discriminator is `action`. The
 * contract models it as a loose record (the union is large and the
 * handler's bespoke pre-Zod guard at browser-handlers.ts:95-98
 * produces the user-facing error for missing `request`).
 *
 * Response: loose record (`ActionResult = { ok, action, error? }`
 * but the handler returns the result directly; modeling as a loose
 * record matches the snapshot-result precedent for browser handlers).
 */
export const BrowserActContract = defineContract({
  method: "browser.act",
  request: z.object({
    request: LooseRecord,
  }),
  response: LooseRecord,
  scopes: ["rpc"] as const,
});

/**
 * `browser.tabs` — list all open tabs. RPC scope. Read-only.
 *
 * Response: `{ tabs: BrowserTabInfo[] }`.
 */
export const BrowserTabsContract = defineContract({
  method: "browser.tabs",
  request: z.object({}),
  response: z.object({
    tabs: z.array(BrowserTabInfoSchema),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.open` — open a new tab. RPC scope. `targetUrl` defaults to
 * `"about:blank"` when omitted (browser-handlers.ts:109).
 *
 * Response: `BrowserTabInfo`.
 */
export const BrowserOpenContract = defineContract({
  method: "browser.open",
  request: z.object({
    targetUrl: z.string().optional(),
  }),
  response: BrowserTabInfoSchema,
  scopes: ["rpc"] as const,
});

/**
 * `browser.focus` — focus an existing tab by `targetId`. RPC scope.
 * The bespoke guard at browser-handlers.ts:117 produces "targetId is
 * required for browser.focus".
 *
 * Response: `{ focused: true, targetId }`.
 */
export const BrowserFocusContract = defineContract({
  method: "browser.focus",
  request: z.object({
    targetId: z.string().min(1),
  }),
  response: z.object({
    focused: z.literal(true),
    targetId: z.string(),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.close` — close a tab (specified by `targetId`, or the
 * active tab when omitted). RPC scope.
 *
 * Response: `{ closed: true }`.
 */
export const BrowserCloseContract = defineContract({
  method: "browser.close",
  request: z.object({
    targetId: z.string().optional(),
  }),
  response: z.object({
    closed: z.literal(true),
  }),
  scopes: ["rpc"] as const,
});

/**
 * `browser.console` — read console messages from the current or
 * specified tab. RPC scope. Optional `level` filter.
 *
 * Response: `{ messages: ConsoleEntry[] }`. Loose-record for the
 * entry shape — `BrowserConsoleMessage` carries a `location` block
 * with file/line/column nested fields that we don't pin in the wire
 * contract.
 */
export const BrowserConsoleContract = defineContract({
  method: "browser.console",
  request: z.object({
    level: z.string().optional(),
    targetId: z.string().optional(),
  }),
  response: z.object({
    messages: z.array(LooseRecord),
  }),
  scopes: ["rpc"] as const,
});

/**
 * browser-handlers slice (13 contracts). Spread order matches the
 * `WORKSPACE_CONTRACTS` array byte for byte — determinism-critical
 * for codegen output stability.
 */
export const BROWSER_HANDLERS_CONTRACTS = [
  BrowserStatusContract,
  BrowserStartContract,
  BrowserStopContract,
  BrowserNavigateContract,
  BrowserSnapshotContract,
  BrowserScreenshotContract,
  BrowserPdfContract,
  BrowserActContract,
  BrowserTabsContract,
  BrowserOpenContract,
  BrowserFocusContract,
  BrowserCloseContract,
  BrowserConsoleContract,
] as const;
