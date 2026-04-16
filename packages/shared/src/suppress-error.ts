/**
 * Suppress a promise rejection by logging it at debug level.
 *
 * Use this instead of empty `.catch(() => {})` blocks.
 * The `reason` parameter documents WHY the error is being suppressed,
 * making it searchable in logs.
 *
 * @param promise - The promise whose rejection should be suppressed
 * @param reason - Human-readable reason for suppression (logged)
 * @param logger - Optional custom logger function. When provided, receives
 *   the formatted message instead of console.debug. Useful for routing
 *   suppressed errors through structured logging (e.g., Pino).
 */
export function suppressError(
  promise: Promise<unknown>,
  reason: string,
  logger?: (message: string) => void,
): void {
  void promise.catch((e: unknown) => {
    const msg = `Suppressed error (${reason}): ${e instanceof Error ? e.message : String(e)}`;
    if (logger) {
      logger(msg);
    } else {
      console.debug(msg);
    }
  });
}
