/**
 * Route an explain reference exactly like the operator CLI.
 *
 * Root-run ids must be checked first because synthetic roots can contain
 * colons. Other colon-bearing values are session keys; UUID-like values are
 * trace ids.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function paramsForExplainRef(ref, depth, hasTerminalGraphRun = false) {
  if (ref.startsWith("root-")) return { rootRunId: ref, depth };
  if (hasTerminalGraphRun) return { graphId: ref, depth };
  if (ref.includes(":")) return { sessionKey: ref, depth };
  return { traceId: ref, depth };
}

const invokedPath = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const ref = process.argv[2];
  const depth = process.argv[3] === "summary" ? "summary" : "full";
  if (ref === undefined) {
    console.error("usage: explain-ref.mjs <sessionKey|traceId|rootRunId> [summary|full]");
    process.exit(2);
  }
  console.log(JSON.stringify(paramsForExplainRef(ref, depth), null, 2));
}
