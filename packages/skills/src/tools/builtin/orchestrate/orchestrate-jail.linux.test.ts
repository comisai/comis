// SPDX-License-Identifier: Apache-2.0
/**
 * (Linux/VPS) — the real-bwrap CONTAINMENT proof for the `orchestrate` runner
 * (ORCH-01/02, READ-02). It drives the GENUINE {@link createOrchestrateTool}
 * end-to-end against a real `BwrapProvider` jail and a real cap-socket server
 * (mirroring the Phase-211 endpoint's newline-JSON wire), proving on the
 * production Linux host class that:
 *   - the jailed child runs `--unshare-net`: a direct TCP egress FAILS; only the
 *     bound cap socket is reachable (ORCH-01 / T-212-19).
 *   - `~/.comis` is masked: the jail binds only the workspace + the curated
 *     SYSTEM_RO_PATHS, so a data-dir read returns ENOENT/empty (T-212-20).
 *   - stdout-only: a script that writes to stderr + computes a result + console
 *     .logs it → only the console.log slice re-enters; stderr never does
 *     (T-212-21).
 *   - ORCH-02 env-scrub (real spawn): a `process.env` dump shows NO
 *     `*KEY* / *TOKEN* / *SECRET*` but DOES show COMIS_CAP_LEASE/COMIS_ORCH_SOCKET
 *     (the lease vars survive via placeholders-merged-last — Pitfall 4).
 *   - READ-02 in-jail jq: a ResultRef materialized in `results/` is queryable via
 *     the cap socket's `jq` route; the slice returns, the full payload never
 *     enters stdout unless explicitly logged.
 *
 * It MUST compile cleanly on macOS (`tsc --noEmit` passes) but the whole describe
 * block SKIPS on non-Linux / when bwrap is unavailable (mirrors
 * `bwrap-cap-socket.linux.test.ts`) — so the macOS `pnpm validate` floor reports
 * it skipped, never failed. On `comisvps` (`pnpm validate:full`) it runs as the
 * VPS-tier gate for the orchestrate containment claim (deferred to the operator,
 * exactly like the Phase-211 `.linux` suites).
 *
 * @module
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { systemNowMs, type ComisLogger, type ResultRef } from "@comis/core";
import { BwrapProvider } from "../sandbox/bwrap-provider.js";
import { createOrchestrateTool, type OrchestrateResultStore } from "./orchestrate-tool.js";

/** Linux + real bwrap gate (mirrors bwrap-cap-socket.linux.test.ts). */
function canJailRun(): boolean {
  if (process.platform !== "linux") return false;
  // eslint-disable-next-line no-restricted-syntax -- Integration gate, Linux only.
  const provider = new BwrapProvider();
  return provider.available();
}

const jailAvailable = canJailRun();

function makeLogger(): ComisLogger {
  const noop = (): void => {};
  const logger: ComisLogger = {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    audit: noop,
    child: () => logger,
  };
  return logger;
}

/** A no-op store (the containment proofs don't assert on the run lifecycle). */
const noopStore: OrchestrateResultStore = {
  materialize: async () => undefined,
  gcRun: async () => {},
  cleanupRun: async () => {},
};

describe.skipIf(!jailAvailable)("orchestrate jail containment (real bwrap, Linux only)", () => {
  let workspacePath: string;
  let sdkAssetsDir: string;
  let socketPath: string;
  let server: net.Server | undefined;
  const createdSockets: string[] = [];

  /** A cap server that answers `tool.invoke` for `jq`/`read`/`grep` from a fixed map. */
  function startCapServer(
    handle: (tool: string, args: Record<string, unknown>) => unknown,
  ): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer((conn) => {
        let buf = "";
        conn.setEncoding("utf8");
        conn.on("data", (chunk: string) => {
          buf += chunk;
          const nl = buf.indexOf("\n");
          if (nl === -1) return;
          const line = buf.slice(0, nl);
          try {
            const req = JSON.parse(line) as {
              method: string;
              params?: { tool?: string; args?: Record<string, unknown> };
            };
            const result = handle(req.params?.tool ?? "", req.params?.args ?? {});
            conn.end(JSON.stringify({ result }) + "\n");
          } catch (err) {
            conn.end(JSON.stringify({ error: String(err) }) + "\n");
          }
        });
      });
      srv.once("error", reject);
      srv.listen(socketPath, () => resolve(srv));
    });
  }

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "comis-orch-jail-ws-"));
    mkdirSync(join(workspacePath, "results"), { recursive: true });
    sdkAssetsDir = mkdtempSync(join(tmpdir(), "comis-orch-jail-sdk-"));
    // Minimal real SDK assets so the runner's copy step succeeds; the
    // containment proofs use inline scripts that don't need the full SDK.
    writeFileSync(join(sdkAssetsDir, "comis_tools.d.ts"), "export {};\n");
    writeFileSync(join(sdkAssetsDir, "comis_tools.js"), "export const comis_tools = {};\n");
    writeFileSync(
      join(sdkAssetsDir, "orchestrate-sdk-runtime.js"),
      "export const invoke = () => {}; export const wrapResultRef = (r) => r;\n",
    );
    socketPath = `/tmp/comis-orch-jail-${systemNowMs()}.sock`;
    createdSockets.push(socketPath);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((r) => server!.close(() => r()));
      server = undefined;
    }
    for (const p of createdSockets) {
      try {
        unlinkSync(p);
      } catch {
        /* gone — ok */
      }
    }
    rmSync(workspacePath, { recursive: true, force: true });
    rmSync(sdkAssetsDir, { recursive: true, force: true });
  });

  function makeTool() {
    return createOrchestrateTool({
      logger: makeLogger(),
      workspaceResolver: () => workspacePath,
      capSocketPath: socketPath,
      sandbox: new BwrapProvider(),
      sdkAssetsDir,
      brokerSpawnEnv: {
        placeholders: { COMIS_CAP_LEASE: "lease-vps", COMIS_ORCH_SOCKET: socketPath },
      },
      store: noopStore,
      // The base env carries decoy secrets the scrub MUST strip.
      baseEnv: {
        PATH: "/usr/bin:/bin",
        HOME: workspacePath,
        ANTHROPIC_API_KEY: "sk-leak",
        SOME_TOKEN: "tok-leak",
        DB_SECRET: "sec-leak",
      },
    });
  }

  it(
    "returns ONLY stdout — a script's stderr + intermediate output never re-enter",
    { timeout: 20_000 },
    async () => {
      server = await startCapServer(() => null);
      const tool = makeTool();
      const script = [
        'process.stderr.write("STDERR-MUST-NOT-LEAK\\n");',
        'const intermediate = "INTERMEDIATE-MUST-NOT-LEAK";',
        'console.log("THE-RESULT");',
      ].join("\n");

      const result = await tool.execute("c", { script, language: "js" });
      const text = result.content.map((b) => b.text ?? "").join("");

      expect(text).toContain("THE-RESULT");
      expect(text).not.toContain("STDERR-MUST-NOT-LEAK");
      expect(text).not.toContain("INTERMEDIATE-MUST-NOT-LEAK");
    },
  );

  it(
    "masks ~/.comis: a data-dir read from inside the jail returns ENOENT/empty",
    { timeout: 20_000 },
    async () => {
      server = await startCapServer(() => null);
      const tool = makeTool();
      // Try to read the host data dir; the jail binds only the workspace +
      // SYSTEM_RO_PATHS, so ~/.comis is not present → readFileSync throws ENOENT.
      const script = [
        'const fs = require("node:fs");',
        'const os = require("node:os");',
        'try {',
        '  const data = fs.readFileSync(os.homedir() + "/.comis/config.yaml", "utf8");',
        '  console.log("LEAKED:" + data.length);',
        '} catch (e) {',
        '  console.log("MASKED:" + (e && e.code ? e.code : "ERR"));',
        '}',
      ].join("\n");

      const result = await tool.execute("c", { script, language: "js" });
      const text = result.content.map((b) => b.text ?? "").join("");

      expect(text).not.toMatch(/LEAKED:/);
      expect(text).toMatch(/MASKED:/);
    },
  );

  it(
    "cuts direct egress (--unshare-net): a direct TCP connect from the jail fails",
    { timeout: 20_000 },
    async () => {
      server = await startCapServer(() => null);
      const tool = makeTool();
      // A direct outbound TCP connect must fail under --unshare-net (no route).
      const script = [
        'const net = require("node:net");',
        'const s = net.connect({ host: "1.1.1.1", port: 80 });',
        's.setTimeout(3000);',
        's.on("connect", () => { console.log("EGRESS-OPEN"); s.destroy(); });',
        's.on("error", (e) => { console.log("EGRESS-CUT:" + e.code); });',
        's.on("timeout", () => { console.log("EGRESS-CUT:TIMEOUT"); s.destroy(); });',
      ].join("\n");

      const result = await tool.execute("c", { script, language: "js" });
      const text = result.content.map((b) => b.text ?? "").join("");

      expect(text).not.toContain("EGRESS-OPEN");
      expect(text).toMatch(/EGRESS-CUT:/);
    },
  );

  it(
    "ORCH-02 env-scrub holds in a real spawn: secrets stripped, lease vars survive",
    { timeout: 20_000 },
    async () => {
      server = await startCapServer(() => null);
      const tool = makeTool();
      // Dump the in-jail env; assert the scrub stripped the decoys but the lease
      // placeholders survived (merged AFTER the scrub — Pitfall 4).
      const script = [
        'const keys = Object.keys(process.env);',
        'const leaked = keys.filter((k) => /KEY|TOKEN|SECRET/i.test(k));',
        'console.log("LEAKED_SECRET_KEYS=" + JSON.stringify(leaked));',
        'console.log("HAS_LEASE=" + (process.env.COMIS_CAP_LEASE ? "1" : "0"));',
        'console.log("HAS_SOCKET=" + (process.env.COMIS_ORCH_SOCKET ? "1" : "0"));',
      ].join("\n");

      const result = await tool.execute("c", { script, language: "js" });
      const text = result.content.map((b) => b.text ?? "").join("");

      expect(text).toContain("LEAKED_SECRET_KEYS=[]");
      expect(text).toContain("HAS_LEASE=1");
      expect(text).toContain("HAS_SOCKET=1");
    },
  );

  it(
    "READ-02 in-jail jq: a ResultRef in results/ is queryable via the cap socket; the slice returns",
    { timeout: 20_000 },
    async () => {
      // The cap server answers the `jq` route by returning only the requested
      // slice (here: the ids extracted from the materialized payload).
      server = await startCapServer((tool, args) => {
        if (tool === "jq") {
          expect(typeof args.path).toBe("string");
          expect(args.expr).toBe(".[].id");
          return [1, 2, 3];
        }
        return null;
      });
      // Materialize a (large) ResultRef payload in results/ — it must NOT enter
      // stdout; only the jq slice does.
      const ref: ResultRef = {
        ref: "results/big.jsonl",
        kind: "jsonl",
        bytes: 1_000_000,
        rows: 3,
        preview: "",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      writeFileSync(
        join(workspacePath, "results", "big.jsonl"),
        "BIG-PAYLOAD-MUST-NOT-LEAK\n".repeat(40_000),
      );
      // Copy the REAL compiled runtime into the fixture so the runner writes it
      // into the jail and the in-jail `import` resolves the genuine
      // invoke/wrapResultRef (the jq round-trips over the cap socket). validate
      // :full builds dist/ first, so the compiled module is present.
      const distRuntime = new URL(
        "../../../../dist/tools/builtin/orchestrate/orchestrate-sdk-runtime.js",
        import.meta.url,
      ).pathname;
      expect(existsSync(distRuntime), "dist runtime must exist (run pnpm build)").toBe(true);
      copyFileSync(distRuntime, join(sdkAssetsDir, "orchestrate-sdk-runtime.js"));

      const refLiteral = JSON.stringify(ref);
      const script = [
        'import { wrapResultRef } from "./orchestrate-sdk-runtime.js";',
        `const ref = ${refLiteral};`,
        "const wrapped = wrapResultRef(ref);",
        'const ids = await wrapped.jq(".[].id");',
        'console.log("IDS=" + JSON.stringify(ids));',
      ].join("\n");
      const tool = makeTool();

      const result = await tool.execute("c", { script, language: "js" });
      const text = result.content.map((b) => b.text ?? "").join("");

      expect(text).toContain("IDS=[1,2,3]");
      expect(text).not.toContain("BIG-PAYLOAD-MUST-NOT-LEAK");
    },
  );
});
