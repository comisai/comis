/**
 * Route an explain reference exactly like the operator CLI.
 *
 * Root-run ids must be checked first because synthetic roots can contain
 * colons. Other colon-bearing values are session keys; UUID-like values are
 * trace ids.
 */
export function paramsForExplainRef(ref, depth) {
  if (ref.startsWith("root-")) return { rootRunId: ref, depth };
  if (ref.includes(":")) return { sessionKey: ref, depth };
  return { traceId: ref, depth };
}
