import { assembleIncidentReportFromSources, assembleSystemHealthReport, makeRealReader } from "../api/obs-handlers/index.js";
import { ObsExplainContract, ObsSystemHealthContract } from "@comis/core";

/**
 * The trust-flag-FREE obs.explain + obs.system.health MCP-client closures
 * (operator-allowlisted `obs_explain` / `obs_system_health` tools). Extracted from
 * daemon.ts `bootGateway` to keep daemon.ts within the ≤3000-line architecture cap.
 *
 * SECURITY: these closures run the SAME assemblers the admin RPC
 * handlers delegate to, DIRECTLY under daemon authority — they do NOT go through the
 * admin-gated obs.* RPC, do NOT inject `_trustLevel:"admin"`, and are NOT reached via
 * daemonRpcForMcpClient. The only authorization boundary is the per-client
 * `mcpClient.allowlist` (the MCP dispatcher's registration filter + live re-check)
 * plus the digest-only/bounded report. `params` arrive already `_trustLevel`-stripped
 * (the MCP dispatcher strips for every tool); the contract `request.parse` validates
 * the shape (its `.refine` rejects an invalid call → the dispatcher's try/catch turns
 * the throw into a generic `dispatch_error` sentinel, no raw leak) before the
 * assembler reads any source.
 *
 * `dataDir` MUST be the ABSOLUTE boot data dir (never "."). `makeRealReader` builds
 * `safePath(dataDir, "sessions"|"logs")` eagerly, and safePath rejects a relative base
 * — a "." crashes boot with PathTraversalError.
 *
 * `clock` is the SAME ClockPort wired into the RPC handler deps (load-bearing,
 * `deps.clock!`). `durableRuns` is the live durable-run
 * store for the autonomy block — this closure bypasses buildRpcDispatchDeps (the RPC
 * path already wires it), so it is the NET-NEW thread; pass
 * `boot.durableRunStore`. Absent (durability off) ⇒ honest degradation (the autonomy
 * block is omitted), byte-identical with the offline path.
 */
type SystemAssemblerDeps = Parameters<typeof assembleSystemHealthReport>[0];

export function buildObsMcpClientClosures(deps: {
  dataDir: string;
  obsStore: SystemAssemblerDeps["obsStore"];
  clock: SystemAssemblerDeps["clock"];
  durableRuns: SystemAssemblerDeps["durableRuns"];
}): {
  obsExplainForMcpClient: (params: Record<string, unknown>) => Promise<unknown>;
  obsSystemHealthForMcpClient: (params: Record<string, unknown>) => Promise<unknown>;
} {
  const reader = makeRealReader(deps.dataDir, deps.obsStore);
  const obsExplainForMcpClient = (params: Record<string, unknown>): Promise<unknown> => {
    const parsed = ObsExplainContract.request.parse(params);
    return assembleIncidentReportFromSources(reader, deps.dataDir, parsed);
  };
  const obsSystemHealthForMcpClient = (params: Record<string, unknown>): Promise<unknown> => {
    const parsed = ObsSystemHealthContract.request.parse(params);
    return assembleSystemHealthReport(
      { obsStore: deps.obsStore, dataDir: deps.dataDir, clock: deps.clock, durableRuns: deps.durableRuns },
      parsed.sinceHours ?? 24,
    );
  };
  return { obsExplainForMcpClient, obsSystemHealthForMcpClient };
}
