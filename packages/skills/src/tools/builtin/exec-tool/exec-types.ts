// SPDX-License-Identifier: Apache-2.0
/**
 * Exec tool types and parameter schema.
 *
 * Holds the interfaces, the TypeBox parameter schema, and the module-private
 * constants consumed by foreground/background helpers in this directory.
 *
 * @module
 */

import type { spawn } from "node:child_process";
import type { createWriteStream } from "node:fs";
import { Type } from "typebox";
import type { TypedEventBus, SecretManager, ToolCapabilityPort, ApprovalGate } from "@comis/core";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExecSandboxConfig } from "../sandbox/types.js";
import type { ProcessRegistry } from "../process-registry.js";
import type { InstallDetourDecision } from "../install-detour.js";
import { DEFAULT_MAX_BYTES } from "../truncate.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum bytes to persist to disk for truncated output. */
export const MAX_PERSIST_BYTES = 64 * 1024 * 1024;

/** Max output chars for background mode's ProcessSession rolling buffer. */
export const BACKGROUND_MAX_OUTPUT_CHARS = 1024 * 1024; // 1MB

/** Rolling buffer size for foreground streaming (2x DEFAULT_MAX_BYTES). */
export const ROLLING_BUFFER_MAX = DEFAULT_MAX_BYTES * 2; // 100KB

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;

/** Valid secret env var name (same rule as env.set). */
export const SECRET_REF_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

// ---------------------------------------------------------------------------
// Parameter schema
// ---------------------------------------------------------------------------

export const ExecParams = Type.Object({
  command: Type.String({ description: "The shell command to execute (single-line only — use 'input' param for multi-line scripts)" }),
  cwd: Type.Optional(
    Type.String({ description: "Working directory (defaults to workspace)" }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      description: "Timeout in ms (default 120000, max 600000)",
      default: 120_000,
    }),
  ),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Environment variable overrides",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({ description: "Run in background and return immediately" }),
  ),
  input: Type.Optional(
    Type.String({ description: "String to write to process stdin" }),
  ),
  autoBackgroundMs: Type.Optional(
    Type.Integer({
      description:
        "Auto-background threshold in ms. Foreground commands exceeding this duration transition to background. Default 15000. Set 0 to disable.",
      default: 15_000,
    }),
  ),
  description: Type.Optional(
    Type.String({
      description:
        "Human-readable label for this command (e.g. 'Installing dependencies'). Appears in UI activity indicators and structured logs.",
    }),
  ),
  pty: Type.Optional(
    Type.Boolean({
      description:
        "Allocate a pseudo-terminal for the command. Required for interactive CLI tools that check process.stdout.isTTY. Wraps the command in 'script' to provide a real TTY.",
    }),
  ),
  secretRefs: Type.Optional(
    Type.Array(Type.String(), {
      maxItems: 8,
      description:
        "Secret/credential NAMES (not values) to inject as env vars into the subprocess. Use this to pass API tokens to CLI tools like wrangler/gh/gcloud/kubectl without tripping the env-var allowlist. Names are resolved server-side via SecretManager; values never flow through agent context. Call env_list first to discover available names. Platform-managed secrets (referenced by the daemon config, e.g. ANTHROPIC_API_KEY) are rejected. Raw-interpreter commands (python -c, node -e, bash -c, etc.) are rejected with secretRefs to prevent trivial echo-to-stdout leaks. Example: {command: 'npx wrangler pages deploy ./dist', secretRefs: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']}",
    }),
  ),
  allowInstallDetour: Type.Optional(
    Type.Boolean({
      description:
        "Request an operator-approved override when the user explicitly needs " +
        "package installation despite an equivalent connected MCP server or " +
        "available skill. Submits an approval request — does NOT self-authorize. " +
        "Per-commandDigest scoped (one approval does not cover a different install).",
    }),
  ),
});

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/** Minimal pino-compatible logger for structured tool logging. */
export interface ToolLogger {
  debug(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

// ---------------------------------------------------------------------------
// ExecToolDeps
// ---------------------------------------------------------------------------

/**
 * Dependencies for the exec tool factory. Backward compatibility is NOT
 * preserved.
 *
 * `toolCapabilityPort` is REQUIRED — wires the install-detour policy gate
 * inside `execute(...)` consuming `port.getInstallDetourMode()`. Daemon
 * wiring may inject `createNoOpCapabilityPort()` at the construction site
 * (`packages/daemon/src/wiring/setup-tools.ts`); the no-op returns empty
 * connected-server and skill arrays so the parser sees no overlaps.
 *
 * `approvalGate` is OPTIONAL — only required by the `soft-stop` mode
 * override path. Missing gate → `soft-stop` denies override (fail-closed).
 */
export interface ExecToolDeps {
  readonly workspacePath: string;
  readonly registry: ProcessRegistry;
  readonly secretManager: SecretManager;
  readonly platformSecretNames: ReadonlySet<string>;
  readonly logger?: ToolLogger;
  readonly subprocessEnv?: Record<string, string>;
  readonly sandboxConfig?: ExecSandboxConfig;
  readonly eventBus?: TypedEventBus;
  readonly getToolResultsDir?: () => string | undefined;
  /** REQUIRED for the capability layer. */
  readonly toolCapabilityPort: ToolCapabilityPort;
  /** Optional. Required only for soft-stop override path. */
  readonly approvalGate?: ApprovalGate;
  /**
   * Broker proxy env injected ONLY for the driven-CLI spawn — never for general exec.
   * When present, these env vars are merged LAST in buildExecEnv so they win over
   * wrapEnv output. Only the daemon wiring for the driven-CLI call site passes this
   * field; the general exec call site never passes it (egress security invariant).
   */
  readonly brokerSpawnEnv?: {
    // HTTPS_PROXY / NODE_EXTRA_CA_CERTS are OPTIONAL: the Phase 211 capability-
    // lease path injects ONLY `placeholders` (COMIS_CAP_LEASE / COMIS_ORCH_SOCKET)
    // with no HTTPS proxy when no broker is configured.
    readonly HTTPS_PROXY?: string;
    /** HTTP_PROXY intentionally omitted — broker is CONNECT-only (HTTPS). */
    readonly HTTP_PROXY?: string;
    readonly NODE_EXTRA_CA_CERTS?: string;
    /** Provider placeholder key env vars. e.g. { ANTHROPIC_API_KEY: "broker-placeholder" } */
    readonly placeholders: Record<string, string>;
  };
}

// ---------------------------------------------------------------------------
// EscalationContext (shared between foreground and background)
// ---------------------------------------------------------------------------

export interface EscalationContext {
  command: string;
  child: ReturnType<typeof spawn>;
  /** performance.now() at spawn -- monotonic, used for elapsed durationMs. */
  startTime: number;
  /** systemNowMs() at spawn -- Unix epoch ms, used for ProcessSession.startedAt
   *  (which downstream code subtracts from systemNowMs() to compute runtimeMs).
   *  Captured separately because performance.now() is a monotonic clock relative
   *  to process start, not a wall clock. */
  startTimeMs: number;
  stdoutBuf: string;
  stderrBuf: string;
  registry: ProcessRegistry;
  sandboxConfig?: ExecSandboxConfig;
  logger?: ToolLogger;
  spillStream: ReturnType<typeof createWriteStream> | null;
  signal?: AbortSignal;
  onAbort: () => void;
  timeoutTimer: ReturnType<typeof setTimeout>;
  resolve: (value: AgentToolResult<unknown>) => void;
  setResolved: () => void;
  description?: string;
  /** Install-detour spawn-time decision (advise+overlap only). */
  installDetourDecision?: InstallDetourDecision;
  /** Install-detour mode at spawn time (drives augmentation). */
  installDetourMode?: "observe" | "advise" | "soft-stop";
}
