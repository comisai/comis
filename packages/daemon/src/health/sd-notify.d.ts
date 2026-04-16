/**
 * Type declarations for sd-notify.
 * sd-notify is a Linux-native C addon for systemd notification.
 * It is NOT available on macOS. The actual import is wrapped in
 * try/catch in watchdog.ts for graceful degradation.
 * This declaration prevents TypeScript errors when the module
 * is not installed.
 */
declare module "sd-notify" {
  function ready(): void;
  function watchdogInterval(): number;
  function sendStatus(status: string): void;
  function startWatchdogMode(interval: number): void;
  function stopWatchdogMode(): void;
  export default {
    ready,
    watchdogInterval,
    sendStatus,
    startWatchdogMode,
    stopWatchdogMode,
  };
}
