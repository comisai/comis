// SPDX-License-Identifier: Apache-2.0
/**
 * Agent config — Autonomy DURABILITY sub-block (Phase 216 — DUR-01..04 / HB-01).
 *
 * The nested `z.strictObject` block that gates the daemon-side durable-run +
 * resume engine (Plans 02-07). It follows the `message`/`lease`/`budget`/`rate`/
 * `spawn`/`outward` nested-block precedent (RESEARCH §D — A2): a `z.strictObject`
 * with every field `.default()`-ed and `strictObject` as the typo guard
 * (fails-closed).
 *
 * GATING (RESEARCH primary recommendation): `enabled` defaults to FALSE. The
 * daemon constructs the durable stores + resume engine + watchdog ONLY when this
 * is true AND an autonomy-bearing agent is configured — so a default install is
 * byte-identical (no new timer, no boot recovery work), mirroring the
 * `cap.sock`-only-when-autonomy-configured gate (data-directory.mdx).
 *
 * `schema-agent-autonomy.ts` wires this into `AutonomyConfigSchema` as
 * `durability: DurabilityConfigSchema.default({})`, so a fully-omitted block
 * resolves to `{ enabled:false, ... }` (default-off).
 *
 * Pure schema leaf — imports only `zod`. No `process.env` / `Date.now` /
 * `path.join` (AGENTS §2.2).
 *
 * @module
 */
import { z } from "zod";

/**
 * Durable-run + resume-engine posture (Phase 216). When `enabled`, the daemon
 * persists a per-root checkpoint as the spawn tree advances (DUR-01), emits a
 * keep-alive heartbeat on a timer (HB-01), and on boot (after channels) re-mints
 * from the persisted attenuated caps + reconciles crashed-mid-send rows
 * (DUR-02/04 + ONCE-03). A daemon-wide watchdog interval sweeps lapsed
 * heartbeats. Every field `.default()`-ed; `strictObject` rejects a typo'd key.
 */
export const DurabilityConfigSchema = z.strictObject({
  /**
   * Master gate (default FALSE). Off ⇒ no durable stores, no boot recovery, no
   * watchdog timer — a default install is byte-identical (no autonomy → no
   * engine). An operator turns this ON for an autonomy-bearing agent that must
   * survive a daemon restart mid-run.
   */
  enabled: z.boolean().default(false),
  /**
   * The lapsed-heartbeat threshold (ms) — a `running` run whose last heartbeat is
   * older than this is treated as crashed and orphan-swept by the watchdog
   * (DUR-04). Default 120s = 4x `keepAliveMs` (the Pitfall-4 conservative ratio:
   * a transiently-slow run that misses a keep-alive or two must NOT be falsely
   * failed and its work duplicated — the `ANNOUNCE_PARENT_TIMEOUT_MS` "30s was
   * too tight" lesson). The watchdog interval also fires at this cadence.
   */
  staleHeartbeatMs: z.number().int().positive().default(120_000),
  /**
   * The keep-alive write cadence (ms) — how often a live durable run stamps
   * `lastHeartbeatAt` (HB-01), INDEPENDENT of step/spawn completion so a
   * long-running child never looks stale. Default 30s (4x below
   * `staleHeartbeatMs`).
   */
  keepAliveMs: z.number().int().positive().default(30_000),
  /**
   * The wall-clock recovery budget (ms) for one boot/watchdog pass (HB-02). A
   * backlog larger than the budget is partially recovered and the remainder
   * DEFERRED (status stays `running`, so the next boot/tick picks them up) — no
   * thundering herd on a large crash backlog. Default 30s.
   */
  recoveryBudgetMs: z.number().int().positive().default(30_000),
});

export type DurabilityConfig = z.infer<typeof DurabilityConfigSchema>;
