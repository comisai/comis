// SPDX-License-Identifier: Apache-2.0
/**
 * Microsoft Teams Bot Framework Connector transport.
 *
 * The REST mechanics the adapter drives — path-safety guards, the cached-token
 * PUT/DELETE activity mutations, and the typing keepalive — factored out so the
 * adapter stays a lean controller (it resolves the routing context + owns the
 * handlers; this module owns the wire). Every call reuses the shared token
 * provider, the `classifyMsTeamsError` failure classifier and the
 * `encodeURIComponent` path-safety; none of it touches adapter state.
 *
 * Security-relevant guards live here because this is where ids/serviceUrls are
 * interpolated into the REST path (T-8) and where the bearer token is emitted
 * (T-3 host allowlist / T-5 no-log).
 *
 * @module
 */

import type { ComisLogger, TimerHandle, TimerPort } from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { classifyMsTeamsError } from "./errors.js";
import { buildMentionEntities } from "./mentions.js";
import type { ConnectorTokenProvider } from "./msteams-auth.js";

// ---------------------------------------------------------------------------
// Path safety (T-8 / T-3)
// ---------------------------------------------------------------------------

/** True if the id carries an ASCII control character (never valid, always dropped). */
function hasControlChar(id: string): boolean {
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Reject a conversation/activity id that is empty, `..`-escaping, or carries a
 * control character. The charset is otherwise unconstrained: the id is
 * URL-encoded before it is interpolated into the REST path, so path separators
 * (standard base64 `@thread.v2` ids carry `/`) are transported safely rather
 * than false-rejected.
 */
export function isSafeConversationId(id: string): boolean {
  return id.length > 0 && !id.includes("..") && !hasControlChar(id);
}

/**
 * Bot Framework Connector service-host suffixes. A minted Connector bearer token
 * is only ever transmitted to a host under one of these, so an inbound activity
 * (or a stored reference) bearing a hostile serviceUrl cannot exfiltrate the
 * token to an arbitrary origin. A static defense-in-depth allowlist.
 */
const BF_SERVICE_HOST_SUFFIXES = [".botframework.com", ".trafficmanager.net"];

/**
 * A send target is safe only over https, free of a `..` traversal segment, and
 * hosted under a Bot Framework Connector service host — so the bearer token is
 * never sent to an arbitrary origin.
 */
export function isSafeServiceUrl(serviceUrl: string): boolean {
  if (serviceUrl.includes("..")) return false;
  const parsed = tryCatch(() => new URL(serviceUrl));
  if (!parsed.ok || parsed.value.protocol !== "https:") return false;
  const host = parsed.value.hostname.toLowerCase();
  return BF_SERVICE_HOST_SUFFIXES.some(
    (suffix) => host === suffix.slice(1) || host.endsWith(suffix),
  );
}

// ---------------------------------------------------------------------------
// Structural Connector error (the edit-in-place renderer classifies on it)
// ---------------------------------------------------------------------------

/**
 * A Connector REST failure that carries the numeric HTTP status — and, for a 429,
 * the `Retry-After` seconds — as STRUCTURAL fields. The edit-in-place renderer
 * classifies on these to pick a render variant (429 → back off, 404 → drop the
 * edit); a bare `Error(message)` would classify as an internal fault and neither
 * the rate-limit backoff nor the activity-gone drop would ever engage.
 */
interface ConnectorRestError extends Error {
  status: number;
  retryAfter?: number;
}

/** Build a {@link ConnectorRestError} carrying the status (+ retryAfter on a 429). */
function connectorRestError(status: number, retryAfter?: number): ConnectorRestError {
  const error = new Error(`connector request returned status ${status}`) as ConnectorRestError;
  error.status = status;
  if (retryAfter !== undefined) error.retryAfter = retryAfter;
  return error;
}

/** Read the integer `Retry-After` seconds off a Connector response, when present. */
function parseRetryAfterSeconds(res: {
  headers?: { get?: (name: string) => string | null };
}): number | undefined {
  const raw = res.headers?.get?.("retry-after");
  if (typeof raw !== "string") return undefined;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

// ---------------------------------------------------------------------------
// Typing keepalive tuning
// ---------------------------------------------------------------------------

/**
 * A Bot Framework typing activity lapses after roughly half a minute, so the
 * keepalive re-POSTs one every {@link TYPING_REFRESH_MS} to hold the indicator
 * open. {@link TYPING_TTL_MS} caps the total keepalive lifetime so an un-stopped
 * indicator (a missed stop signal) can never refresh forever;
 * {@link MAX_TYPING_REFRESHES} expresses that cap as a refresh count so it holds
 * regardless of the injected clock. Internal constants — not operator-tunable.
 */
const TYPING_REFRESH_MS = 8_000;
const TYPING_TTL_MS = 600_000;
const MAX_TYPING_REFRESHES = Math.ceil(TYPING_TTL_MS / TYPING_REFRESH_MS);

// ---------------------------------------------------------------------------
// Connector factory
// ---------------------------------------------------------------------------

/** Dependencies for the Connector transport. Mirrors the adapter's injected seams. */
export interface MsTeamsConnectorDeps {
  /** Cached client-credentials token provider (shared with the adapter's send). */
  tokens: ConnectorTokenProvider;
  /** Injected fetch, defaulting to the global; lets a unit test stub the calls. */
  fetchImpl?: typeof fetch;
  /** Logger for the outbound boundary matrix. */
  logger: ComisLogger;
  /** Injected clock in ms; makes durationMs deterministic. */
  now: () => number;
  /** Injected timer for the typing keepalive; absent → keepalive is a no-op. */
  timer?: TimerPort;
}

/** The Connector transport surface the adapter drives. */
export interface MsTeamsConnector {
  /** PUT updateActivity — edit an existing activity's text (+ mentions). */
  editActivity(
    serviceUrl: string,
    conversationId: string,
    messageId: string,
    text: string,
  ): Promise<Result<void, Error>>;
  /** DELETE deleteActivity — remove an existing activity. */
  deleteActivity(
    serviceUrl: string,
    conversationId: string,
    messageId: string,
  ): Promise<Result<void, Error>>;
  /** (Re)start the typing keepalive for a conversation over the injected timer. */
  startTyping(conversationId: string, serviceUrl: string): void;
  /** Cancel the active typing keepalive, if any. Idempotent + cancel-safe. */
  stopTyping(): void;
}

/**
 * Build the Connector transport over the injected token/fetch/timer. The
 * edit/delete calls validate the interpolated ids + serviceUrl (T-8/T-3) before
 * any fetch and return a {@link ConnectorRestError} on a non-2xx so the caller's
 * edit-in-place renderer can classify it. State (health, lastError) stays with
 * the adapter — these calls only return `Result`.
 */
export function createMsTeamsConnector(deps: MsTeamsConnectorDeps): MsTeamsConnector {
  let typingHandle: TimerHandle | undefined;
  let typingRefreshCount = 0;

  async function mutate(
    method: "PUT" | "DELETE",
    op: "edit" | "delete",
    serviceUrl: string,
    conversationId: string,
    messageId: string,
    text?: string,
  ): Promise<Result<void, Error>> {
    const startedAt = deps.now();

    // Path-safety gate: validate BOTH interpolated ids before building the path.
    if (!isSafeConversationId(conversationId) || !isSafeConversationId(messageId)) {
      deps.logger.warn(
        {
          channelType: "msteams" as const,
          op,
          hint: "Reject the conversation/message id: it must be free of control chars and '..'",
          errorKind: "precondition" as const,
        },
        "Connector activity mutation blocked: unsafe id",
      );
      return err(new Error("unsafe activity id"));
    }
    if (!isSafeServiceUrl(serviceUrl)) {
      deps.logger.warn(
        {
          channelType: "msteams" as const,
          op,
          hint: "Reject the serviceUrl: it must be an https Bot Framework Connector host free of '..'",
          errorKind: "precondition" as const,
        },
        "Connector activity mutation blocked: unsafe service url",
      );
      return err(new Error("unsafe service url"));
    }

    const tok = await deps.tokens.getToken();
    if (!tok.ok) return err(tok.error);

    const url = `${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(messageId)}`;
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${tok.value}`,
        "content-type": "application/json",
      },
    };
    if (text !== undefined) {
      const built = buildMentionEntities(text);
      const body: Record<string, unknown> = { type: "message", text: built.text };
      if (built.entities.length > 0) body.entities = built.entities;
      init.body = JSON.stringify(body);
    }

    const responded = await fromPromise((deps.fetchImpl ?? fetch)(url, init));
    if (!responded.ok) {
      const classified = classifyMsTeamsError(undefined, responded.error);
      deps.logger.warn(
        {
          channelType: "msteams" as const,
          op,
          hint: classified.hint,
          errorKind: classified.errorKind,
        },
        "Connector activity mutation failed: no response from the connector",
      );
      return err(responded.error);
    }

    const res = responded.value;
    if (!res.ok) {
      const classified = classifyMsTeamsError(res.status);
      const retryAfter = parseRetryAfterSeconds(res);
      deps.logger.warn(
        {
          channelType: "msteams" as const,
          op,
          status: res.status,
          hint: classified.hint,
          errorKind: classified.errorKind,
        },
        "Connector activity mutation failed: connector returned an error status",
      );
      // Structural status so the edit-in-place renderer classifies (429/404/…).
      return err(connectorRestError(res.status, retryAfter));
    }

    deps.logger.info(
      {
        step: "channels-outbound",
        channelType: "msteams" as const,
        op,
        messageId,
        chatId: conversationId,
        durationMs: deps.now() - startedAt,
      },
      "Outbound activity mutation",
    );
    return ok(undefined);
  }

  function stopTyping(): void {
    if (typingHandle !== undefined && !typingHandle.cancelled) typingHandle.cancel();
    typingHandle = undefined;
  }

  /** POST a single {type:"typing"} activity (best-effort; failures log at DEBUG). */
  async function postTyping(conversationId: string, serviceUrl: string): Promise<void> {
    const tok = await deps.tokens.getToken();
    if (!tok.ok) return; // the token provider already logged its failure branch
    const url = `${serviceUrl}v3/conversations/${encodeURIComponent(conversationId)}/activities`;
    const responded = await fromPromise(
      (deps.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tok.value}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "typing" }),
      }),
    );
    if (!responded.ok) {
      const classified = classifyMsTeamsError(undefined, responded.error);
      deps.logger.debug(
        { channelType: "msteams" as const, hint: classified.hint, errorKind: classified.errorKind },
        "Typing keepalive post failed to reach the connector",
      );
      return;
    }
    if (!responded.value.ok) {
      const classified = classifyMsTeamsError(responded.value.status);
      deps.logger.debug(
        {
          channelType: "msteams" as const,
          status: responded.value.status,
          hint: classified.hint,
          errorKind: classified.errorKind,
        },
        "Typing keepalive post rejected by the connector",
      );
    }
  }

  function scheduleRefresh(conversationId: string, serviceUrl: string): void {
    const timer = deps.timer;
    if (timer === undefined) return;
    if (typingRefreshCount >= MAX_TYPING_REFRESHES) {
      // TTL backstop: stop rearming even without an explicit stopTyping.
      stopTyping();
      return;
    }
    const handle = timer.setTimeout(() => {
      typingHandle = undefined;
      typingRefreshCount += 1;
      void postTyping(conversationId, serviceUrl);
      scheduleRefresh(conversationId, serviceUrl);
    }, TYPING_REFRESH_MS);
    handle.unref();
    typingHandle = handle;
  }

  function startTyping(conversationId: string, serviceUrl: string): void {
    // Idempotent restart: cancel any prior keepalive, POST now, schedule refreshes.
    stopTyping();
    typingRefreshCount = 0;
    void postTyping(conversationId, serviceUrl);
    scheduleRefresh(conversationId, serviceUrl);
  }

  return {
    editActivity: (serviceUrl, conversationId, messageId, text) =>
      mutate("PUT", "edit", serviceUrl, conversationId, messageId, text),
    deleteActivity: (serviceUrl, conversationId, messageId) =>
      mutate("DELETE", "delete", serviceUrl, conversationId, messageId),
    startTyping,
    stopTyping,
  };
}
