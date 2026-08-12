// TEMPORARY probe — deleted after use.
// Emulates the CI shard's CPU starvation (single core, competing hogs) to see
// whether the factory sweep's directory scan can be descheduled long enough to
// observe — and unlink — the first set()'s in-flight temp in an EMPTY data dir.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFileLock, createOAuthCredentialStoreFile } from "./packages/core/dist/index.js";

const ITER = Number(process.argv[2] ?? 300);
let failures = 0;
for (let i = 0; i < ITER; i++) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-starve-"));
  const store = createOAuthCredentialStoreFile({ dataDir: tmp, fileLock: createFileLock() });
  const r = await store.set("openai-codex:user_a@example.com", {
    provider: "openai-codex",
    profileId: "openai-codex:user_a@example.com",
    access: "a",
    refresh: "r",
    expires: Date.now() + 1000,
    version: 1,
  });
  if (!r.ok) {
    failures++;
    console.log(`iter ${i}: ${r.error.message}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`done: ${failures}/${ITER} failed`);
