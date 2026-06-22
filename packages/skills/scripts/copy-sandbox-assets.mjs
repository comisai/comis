// SPDX-License-Identifier: Apache-2.0
/**
 * Postbuild asset copy for the sandbox (JAIL-01).
 *
 * `tsc` emits only `.js`/`.d.ts` — it does NOT copy data assets. The seccomp
 * BPF blob (`seccomp-orchestrate.bpf`, a precompiled raw-BPF artifact generated
 * offline on Linux via libseccomp `scmp_export_bpf`) must sit BESIDE the compiled
 * `seccomp-profile.js` in `dist/` so `loadSeccompProfileFd()` (which resolves the
 * blob via `import.meta.url`) can `open()` it.
 *
 * This copies any `*.bpf` from `src/tools/builtin/sandbox/` to the matching
 * `dist/tools/builtin/sandbox/`. It is a NO-OP when the blob is absent (the
 * macOS dev checkout has none — the loader then degrades to null and buildArgs
 * omits `--seccomp`), so the build never fails for lack of the blob.
 *
 * Runs inside `pnpm -r run build` (and therefore inside the Docker image build),
 * so a committed blob rides the normal build output into both the published
 * tarball (`files: ["dist"]`) and the container image — no separate Docker COPY.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const srcDir = join(pkgRoot, "src", "tools", "builtin", "sandbox");
const distDir = join(pkgRoot, "dist", "tools", "builtin", "sandbox");

if (!existsSync(srcDir)) {
  // No sandbox source — nothing to do.
  process.exit(0);
}

const blobs = readdirSync(srcDir).filter((f) => f.endsWith(".bpf"));
if (blobs.length === 0) {
  // No blob committed yet (generated offline on Linux) — graceful no-op.
  process.exit(0);
}

mkdirSync(distDir, { recursive: true });
for (const blob of blobs) {
  cpSync(join(srcDir, blob), join(distDir, blob));
  // eslint-disable-next-line no-console -- build-script progress line
  console.log(`[copy-sandbox-assets] ${blob} → dist/tools/builtin/sandbox/`);
}
