import type { HookRunner } from "./hook-runner.js";

/**
 * Global hook runner singleton.
 *
 * Set once at bootstrap, accessed from deliverToChannel() and other
 * call sites that cannot practically thread the hook runner through
 * dependency injection (24+ call sites).
 *
 * Usage:
 * - Bootstrap: setGlobalHookRunner(hookRunner)
 * - Delivery: getGlobalHookRunner()?.runBeforeDelivery(...)
 * - Shutdown/test: clearGlobalHookRunner()
 */
let globalHookRunner: HookRunner | null = null;

export function setGlobalHookRunner(runner: HookRunner): void {
  globalHookRunner = runner;
}

export function getGlobalHookRunner(): HookRunner | null {
  return globalHookRunner;
}

export function clearGlobalHookRunner(): void {
  globalHookRunner = null;
}
