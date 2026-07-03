// SPDX-License-Identifier: Apache-2.0
/**
 * Pure PLAT harness for the PLATFORM scenario tests.
 *
 * Provides the fixtures + builders the four PLAT scenario files consume — all FAKE test
 * data, typed against the REAL product shapes via `satisfies` so a product drift is a COMPILE
 * error. No daemon, no real key, no network.
 *
 *   - PLAT-02 (config): INVALID_CONFIGS (each FAILS validateConfig), MALFORMED_YAML / ARRAY_TOP_LEVEL
 *     (loadConfigFile PARSE_ERROR), ENV_VAR_FIXTURE + makeGetSecret (${VAR} resolution), LAYER_BASE /
 *     LAYER_OVERRIDE (deepMerge precedence), writeTmpConfigFile (a tmp YAML/JSON for loadConfigFile).
 *   - PLAT-03 (secrets): TEST_MASTER_KEY_HEX (a FAKE 64-hex key parseMasterKey accepts), makeTmpDataDir,
 *     and SECRET_CANARY (re-exported from sec-config — the canary credential value).
 *   - PLAT-04 (scheduler): makeCronJob / makeInMemoryCronStore (a CronStore stub) / makeStubHeartbeatSource
 *     (a HeartbeatSourcePort stub), makeNoopSchedulerLogger, QUIET_HOURS_OFF, OK_HEARTBEAT_TEXT (= the
 *     real HEARTBEAT_OK_TOKEN — the classifier returns "ok" ONLY when the text contains it) /
 *     ALERT_HEARTBEAT_TEXT.
 *   - PLAT-01 (terminal): TERMINAL_SCREENS {safe,auth,destructive,approval}, SAFE_HINT_PATTERNS,
 *     AUTH_HINT_OVERLAP (a screen matching BOTH a safe hint AND an auth marker — proves escalate-always
 *     WINS), makeValidTerminalConfig (a valid TerminalDriverConfig), hasBwrap (FALSE on macOS).
 *
 * @module
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { CronJob, CronStore, HeartbeatSourcePort, HeartbeatCheckResult, QuietHoursConfig } from "@comis/scheduler";
import type { SchedulerLogger } from "@comis/scheduler";
import { HEARTBEAT_OK_TOKEN } from "@comis/shared";
import { detectSandboxProvider } from "@comis/skills/tools";

import { SECRET_CANARY } from "./sec-config.js";

// Re-export the canary so PLAT-03 imports it from one place.
export { SECRET_CANARY };

// ---------------------------------------------------------------------------
// PLAT-02 — config fixtures
// ---------------------------------------------------------------------------

/**
 * Raw config objects that each FAIL AppConfigSchema (validateConfig ⇒ ok:false):
 *   - bad enum value (security.storage must be encrypted|file|env);
 *   - wrong primitive type (agents.<id>.maxSteps must be a number);
 *   - unknown top-level key (AppConfigSchema is z.strictObject — an unrecognized key rejects).
 */
export const INVALID_CONFIGS: ReadonlyArray<{ name: string; raw: Record<string, unknown> }> = [
  { name: "bad enum (security.storage)", raw: { security: { storage: "plaintext" } } },
  { name: "wrong type (agents.default.maxSteps string)", raw: { agents: { default: { maxSteps: "notanumber" } } } },
  { name: "unknown top-level key (strictObject)", raw: { thisKeyDoesNotExistInTheSchema: true } },
];

/** A YAML string the parser rejects (unterminated flow sequence) → loadConfigFile PARSE_ERROR. */
export const MALFORMED_YAML = "key: [unterminated\n  nested: : :";

/** A JSON array top-level → loadConfigFile rejects a non-object top-level as PARSE_ERROR. */
export const ARRAY_TOP_LEVEL = "[1, 2, 3]";

/** A raw config object containing a ${VAR} reference (resolved by makeGetSecret). */
export const ENV_VAR_FIXTURE: Record<string, unknown> = { tenantId: "${TEST_VAR}" };

/** A getSecret callback that resolves only TEST_VAR (everything else ⇒ undefined ⇒ ENV_VAR_ERROR). */
export function makeGetSecret(): (key: string) => string | undefined {
  return (key: string) => (key === "TEST_VAR" ? "resolved-value" : undefined);
}

/** Base layer for a deepMerge precedence assertion (a nested object + an array + a primitive). */
export const LAYER_BASE: Record<string, unknown> = {
  nested: { keep: "base", shared: "base" },
  arr: [1, 2, 3],
  prim: "base",
};

/** Override layer: overlaps `nested.shared`/`arr`/`prim`, leaves `nested.keep`. */
export const LAYER_OVERRIDE: Record<string, unknown> = {
  nested: { shared: "override" },
  arr: [9],
  prim: "override",
};

/** Write a config fixture to a tmp dir and return its absolute path. */
export function writeTmpConfigFile(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, { encoding: "utf-8" });
  return p;
}

// ---------------------------------------------------------------------------
// PLAT-03 — secrets fixtures
// ---------------------------------------------------------------------------

/**
 * A FAKE 64-hex master key (NEVER a real key). 64 hex chars → parseMasterKey accepts it as a
 * 32-byte key, so setupSecrets({env:{SECRETS_MASTER_KEY:TEST_MASTER_KEY_HEX}}) returns ok({crypto,dbPath}).
 * It exists purely so the encrypted-store round-trip is testable; it secures only throwaway tmp data.
 */
export const TEST_MASTER_KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** Create a unique tmp data dir; caller is responsible for rmSync cleanup. */
export function makeTmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "plat-"));
}

// ---------------------------------------------------------------------------
// PLAT-04 — scheduler fixtures
// ---------------------------------------------------------------------------

/** A valid CronJob; pass `{nextRunAtMs: <=now}` to make it immediately due. */
export function makeCronJob(overrides?: Partial<CronJob>): CronJob {
  const base: CronJob = {
    id: `job-${Math.random().toString(36).slice(2, 10)}`,
    name: "plat test job",
    agentId: "default",
    schedule: { kind: "every", everyMs: 60_000 },
    enabled: true,
    nextRunAtMs: 0,
    consecutiveErrors: 0,
  };
  return { ...base, ...overrides };
}

/** An in-memory CronStore stub (closure-local array; satisfies the real CronStore port). */
export function makeInMemoryCronStore(initial?: CronJob[]): CronStore {
  let jobs: CronJob[] = [...(initial ?? [])];
  const store = {
    async load(): Promise<CronJob[]> {
      return [...jobs];
    },
    async save(next: CronJob[]): Promise<void> {
      jobs = [...next];
    },
    async addJob(job: CronJob): Promise<void> {
      jobs.push(job);
    },
    async removeJob(jobId: string): Promise<boolean> {
      const before = jobs.length;
      jobs = jobs.filter((j) => j.id !== jobId);
      return jobs.length < before;
    },
    async updateJob(jobId: string, update: Partial<CronJob>): Promise<boolean> {
      const job = jobs.find((j) => j.id === jobId);
      if (!job) return false;
      Object.assign(job, update);
      return true;
    },
  } satisfies CronStore;
  return store;
}

/** The OK heartbeat text MUST contain HEARTBEAT_OK_TOKEN — classifyHeartbeatResult returns "ok" only then. */
export const OK_HEARTBEAT_TEXT = `${HEARTBEAT_OK_TOKEN} — all systems nominal`;

/** Any text NOT containing the OK token and NOT containing CRITICAL/EMERGENCY classifies as "alert". */
export const ALERT_HEARTBEAT_TEXT = "disk usage at 95% on the primary volume";

/** A stub HeartbeatSourcePort whose check() resolves a fixed text. */
export function makeStubHeartbeatSource(id: string, name: string, text: string): HeartbeatSourcePort {
  const source = {
    id,
    name,
    async check(): Promise<HeartbeatCheckResult> {
      return { sourceId: id, text, timestamp: Date.now() };
    },
  } satisfies HeartbeatSourcePort;
  return source;
}

/** A no-op SchedulerLogger (ignores all args; child() returns itself). */
export function makeNoopSchedulerLogger(): SchedulerLogger {
  const log: SchedulerLogger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => log,
  };
  return log;
}

/** Quiet hours OFF — the REAL QuietHoursConfig shape (no criticalBypass field; that is a runner dep). */
export const QUIET_HOURS_OFF: QuietHoursConfig = {
  enabled: false,
  start: "22:00",
  end: "07:00",
  timezone: "",
};

// ---------------------------------------------------------------------------
// PLAT-01 — terminal fixtures
// ---------------------------------------------------------------------------

/**
 * Driven-CLI screen fixtures for decideAutoAnswer. `safe` matches a hintPattern WITHOUT tripping
 * any escalate-always marker. auth/destructive/approval each ALSO match the safe hintPattern
 * ("press enter to continue") AND carry an auth/destructive/approval cue — i.e. the exact
 * phishing shape the escalate-always VETO defends against: a CLI rendering a benign
 * affordance beneath a sensitive prompt. The veto is scoped to an about-to-
 * auto-answer screen (a screen with NO safe match is escalated `no_safe_match` regardless, so the
 * broad markers are not run against it — they false-positive on narration),
 * so these fixtures embed the safe hint to exercise the veto firing over a real safe match.
 */
export const TERMINAL_SCREENS = {
  safe: "Build complete. Press enter to continue.",
  auth: "Your session expired. Please log in / enter your password: Press enter to continue.",
  destructive: "This operation will delete all files in the workspace. Press enter to continue.",
  approval: "Are you sure you want to proceed with this? Press enter to continue.",
} as const;

/** Operator-allowlisted safe prompt cues (the safe screen matches SAFE_HINT_PATTERNS[0]). */
export const SAFE_HINT_PATTERNS: readonly string[] = ["press enter to continue"];

/**
 * A screen that matches the safe hint AND contains an auth marker — proves the escalate-always
 * gate WINS over an operator hintPattern (decideAutoAnswer must escalate auth_login, not answer).
 */
export const AUTH_HINT_OVERLAP = "Please log in to continue. Press enter to continue.";

/** A valid TerminalDriverConfig (every required field present; consent.acknowledgedRisk literal true). */
export function makeValidTerminalConfig(): unknown {
  return {
    enabled: true,
    worker: {
      maxSessions: 4,
      idleTtlMs: 300_000,
      ringBytes: 65_536,
      stuckMs: 60_000,
      maxConcurrentAttentionTurns: 2,
    },
    defaults: { cols: 120, rows: 40, scrollback: 1000 },
    allow: [
      {
        id: "plat-test-entry",
        match: { path: "/usr/bin/true" },
        scope: {},
        autoAnswer: "safe-only",
        hintPatterns: ["press enter to continue"],
        consent: { acknowledgedRisk: true, acknowledgedAt: "2026-06-06T00:00:00Z" },
      },
    ],
    redactSecrets: true,
    audit: { enabled: true },
  };
}

/** True only on a host with bwrap on PATH (Linux); FALSE on macOS — gates the PLAT-01 Stage-C skip. */
export function hasBwrap(): boolean {
  try {
    return detectSandboxProvider()?.name === "bwrap";
  } catch {
    return false;
  }
}
