// SPDX-License-Identifier: Apache-2.0
/**
 * Postbuild asset copy: sandbox seccomp blob + orchestrate SDK artifacts.
 *
 * `tsc` emits only the `.js`/`.d.ts` it COMPILES from `.ts` sources — it does
 * NOT copy data assets, and with `allowJs: false` it ignores hand-committed
 * `.js`. Two such committed artifacts must ride into `dist/` beside their
 * compiled siblings so the runtime can resolve them via `import.meta.url`:
 *
 *   1. The seccomp BPF blob (`seccomp-orchestrate.bpf`, a precompiled raw-BPF
 *      artifact generated offline on Linux via libseccomp `scmp_export_bpf`)
 *      must sit beside the compiled `seccomp-profile.js` so
 *      `loadSeccompProfileFd()` can `open()` it. NO-OP when absent (macOS dev
 *      has no blob → the loader degrades to null and buildArgs omits
 *      `--seccomp`), so the build never fails for lack of the blob.
 *
 *   2. The generated `comis_tools.{d.ts,js}` SDK (emitted from
 *      `TOOL_CAPABILITY_MAP` by `scripts/orchestrate-sdk/generate-comis-tools-sdk.ts`).
 *      It is committed SOURCE (the byte-identical drift gate pins it),
 *      but tsc skips a hand-written `.js`, so it is copied here so the
 *      runner can read it from `dist/` and write it into the jailed workspace,
 *      and so it ships in the published tarball.
 *
 * Runs inside `pnpm -r run build` (and therefore inside the Docker image build),
 * so committed assets ride the normal build output into both the published
 * tarball (`files: ["dist"]`) and the container image — no separate Docker COPY.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

// 1. Sandbox seccomp blob(s): copy any *.bpf → dist (graceful no-op when absent).
const sandboxSrc = join(pkgRoot, "src", "tools", "builtin", "sandbox");
const sandboxDist = join(pkgRoot, "dist", "tools", "builtin", "sandbox");
if (existsSync(sandboxSrc)) {
  const blobs = readdirSync(sandboxSrc).filter((f) => f.endsWith(".bpf"));
  if (blobs.length > 0) {
    mkdirSync(sandboxDist, { recursive: true });
    for (const blob of blobs) {
      cpSync(join(sandboxSrc, blob), join(sandboxDist, blob));
      console.log(`[copy-sandbox-assets] ${blob} → dist/tools/builtin/sandbox/`);
    }
  }
}

// 2. Orchestrate SDK artifacts + the comis-agent manifest:
//    copy the generated comis_tools.{d.ts,js} AND the committed
//    comis-agent-manifest.json → dist so the runner / resolveJailAgentCli read
//    them from dist (via import.meta.url) and they ship in the tarball. tsc
//    ignores the hand-written .js (allowJs: false) and does NOT copy .json data
//    assets, so this copy is required for both.
const orchSrc = join(pkgRoot, "src", "tools", "builtin", "orchestrate");
const orchDist = join(pkgRoot, "dist", "tools", "builtin", "orchestrate");
const sdkArtifacts = ["comis_tools.js", "comis_tools.d.ts", "comis-agent-manifest.json"];
const presentArtifacts = sdkArtifacts.filter((f) => existsSync(join(orchSrc, f)));
if (presentArtifacts.length > 0) {
  mkdirSync(orchDist, { recursive: true });
  for (const artifact of presentArtifacts) {
    cpSync(join(orchSrc, artifact), join(orchDist, artifact));
    console.log(`[copy-sandbox-assets] ${artifact} → dist/tools/builtin/orchestrate/`);
  }
}
