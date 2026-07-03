#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// webhook-drive.mjs — the HTTP-webhook analog of drive.mjs for the self-driving rig.
//
// Comis webhooks (packages/gateway/src/webhook/) are mounted on the gateway HTTP port
// (default 127.0.0.1:4766) at the configured base path (default /hooks). HMAC is ALWAYS
// active on the endpoint (setup-gateway-routes.ts: secret = config.webhooks.token ->
// WEBHOOK_HMAC_SECRET -> auto-generated), so a webhook POST MUST carry a valid
// `x-webhook-signature: <hex hmac-sha256(rawBody, secret)>` or it is 401'd before any
// agent turn. This script computes that signature and POSTs, then prints the response.
//
// The agent turn fires ASYNC past the 200 response (the claude run takes minutes) — read
// completion from the trajectory / daemon log / built files, NOT this script's output
// (the DAG-async trap). This script proves the INBOUND contract (auth + mapping + code).
//
// Runs ON THE VPS (the gateway binds loopback). Uses only Node builtins.
//
// Usage:
//   node webhook-drive.mjs <path> <json-or-@file> [opts]
//     <path>            webhook path segment after the base path, e.g. "devtask" or "github"
//     <json-or-@file>   inline JSON string, or @/abs/path to read the raw body from a file,
//                       or "-" to read the raw body from stdin
//   --secret <s>        HMAC secret (default: env WEBHOOK_HMAC_SECRET, then env WH_SECRET)
//   --base <p>          base path (default: env WH_BASE or "/hooks")
//   --port <n>          gateway port (default: env GW_PORT or 4766)
//   --host <h>          gateway host (default: env GW_HOST or 127.0.0.1)
//   --header k:v        add/override a request header (repeatable; e.g. content-type, x-github-event)
//   --algo <a>          hmac algorithm sha256|sha384|sha512 (default sha256)
//   --ts                add a fresh `x-webhook-timestamp` (unix seconds)
//   --ts-offset <sec>   add `x-webhook-timestamp` = now+offset (negative = stale; implies --ts)
//   --no-sign           omit the signature header entirely (tests the 401 missing-sig path)
//   --bad-sign          send a deliberately wrong signature (tests the 401 invalid-sig path)
//   --raw               send the body verbatim, do NOT require it to be JSON (tests the 400 path)
//   --method <m>        HTTP method (default POST)
//   --allow-stale       permit a `@file` body older than 120s (default: HARD-FAIL on a stale reuse)
//
// Exit code: 0 if the HTTP response status is 2xx, else 1 (so `&&` chains are honest).
// A missing `@file` or a stale reused body exits 2 (a rig error, distinct from an honest HTTP non-2xx).

import { createHmac } from "node:crypto";
import http from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";

function parseArgs(argv) {
  const pos = [];
  const opt = { headers: {} };
  // Normalize `--flag=value` → `--flag` `value` so both forms work (avoids the
  // `--ts-offset=-350`-silently-dropped trap).
  argv = argv.flatMap((a) => {
    if (a.startsWith("--") && a.includes("=")) {
      const i = a.indexOf("=");
      return [a.slice(0, i), a.slice(i + 1)];
    }
    return [a];
  });
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-sign") opt.noSign = true;
    else if (a === "--bad-sign") opt.badSign = true;
    else if (a === "--raw") opt.raw = true;
    else if (a === "--allow-stale") opt.allowStale = true;
    else if (a === "--ts") opt.ts = true;
    else if (a === "--secret") opt.secret = argv[++i];
    else if (a === "--base") opt.base = argv[++i];
    else if (a === "--port") opt.port = Number(argv[++i]);
    else if (a === "--host") opt.host = argv[++i];
    else if (a === "--algo") opt.algo = argv[++i];
    else if (a === "--method") opt.method = argv[++i];
    else if (a === "--ts-offset") { opt.tsOffset = Number(argv[++i]); opt.ts = true; }
    else if (a === "--header") {
      const hv = argv[++i] ?? "";
      const idx = hv.indexOf(":");
      if (idx > 0) opt.headers[hv.slice(0, idx).trim().toLowerCase()] = hv.slice(idx + 1).trim();
    } else pos.push(a);
  }
  return { pos, opt };
}

function readBody(spec, opt) {
  if (spec === "-") return readFileSync(0, "utf8");
  if (typeof spec === "string" && spec.startsWith("@")) {
    const path = spec.slice(1);
    // A MISSING @file is a rig error, not an honest HTTP negative — exit 2 with a clean
    // message instead of a raw ENOENT stack. The footgun this guards against:
    // a `node -e` used process.env.ID BEFORE `export ID`, wrote `wh-undefined.json`, and the
    // POST referenced a DIFFERENT path → an ENOENT crash mid-drive that read as a daemon fault.
    if (!existsSync(path)) {
      console.error(`[local] body file not found: ${path}`);
      console.error(`[local] ⚠ did an earlier step fail to write it (e.g. an unset $ID → wh-undefined.json)? Write the body to a UNIQUE per-run path and \`&&\`-gate it BEFORE this POST.`);
      process.exit(2);
    }
    // Surface the file's size + mtime so a STALE body is obvious, and HARD-FAIL on a stale
    // reuse. The prior footgun: a botched `writeFileSync`
    // EACCES-failed to refresh a reused `/tmp/<name>.json` (a prior run left it comis-owned),
    // but the POST still sent the STALE body — a phantom turn (id from the OLD run) that
    // looked like a durable-drive resurrection. Rules: (1) UNIQUE, self-owned path per run;
    // (2) `&&`-gate the write BEFORE the POST. Pass --allow-stale to override intentionally.
    const st = statSync(path);
    const ageS = Math.round((Date.now() - st.mtimeMs) / 1000);
    console.error(`[local] body from ${path} (bytes=${st.size}, mtime=${new Date(st.mtimeMs).toISOString()}, age=${ageS}s)`);
    if (ageS > 120 && !opt.allowStale) {
      console.error(`[local] ✗ that body file is ${ageS}s old — refusing to send a likely-STALE body. Write a UNIQUE per-run path, or pass --allow-stale to override.`);
      process.exit(2);
    }
    if (ageS > 120) console.error(`[local] ⚠ sending a ${ageS}s-old body anyway (--allow-stale).`);
    return readFileSync(path, "utf8");
  }
  return spec ?? "";
}

const { pos, opt } = parseArgs(process.argv.slice(2));
if (pos.length < 1) {
  console.error("usage: webhook-drive.mjs <path> <json-or-@file|-> [opts]  (see header)");
  process.exit(2);
}
const path = pos[0].replace(/^\/+/, "");
const rawBody = readBody(pos[1] ?? "{}", opt);
const secret = opt.secret ?? process.env.WEBHOOK_HMAC_SECRET ?? process.env.WH_SECRET ?? "";
const base = (opt.base ?? process.env.WH_BASE ?? "/hooks").replace(/\/+$/, "");
const port = opt.port ?? Number(process.env.GW_PORT ?? 4766);
const host = opt.host ?? process.env.GW_HOST ?? "127.0.0.1";
const algo = opt.algo ?? "sha256";
const method = opt.method ?? "POST";

if (!opt.raw) {
  // Validate JSON locally so a 400 from the server is unambiguous (not our typo),
  // UNLESS --raw was passed (which intentionally sends a non-JSON body to test the 400 path).
  try { JSON.parse(rawBody); } catch (e) {
    console.error(`[local] body is not valid JSON (${e.message}). Pass --raw to send it anyway.`);
    process.exit(2);
  }
}

const headers = { "content-type": "application/json", ...opt.headers };

// Signature
if (!opt.noSign) {
  let sig;
  if (opt.badSign) {
    sig = "deadbeef".repeat(8); // wrong but well-formed hex
  } else {
    if (!secret) {
      console.error("[local] no HMAC secret (set --secret or WEBHOOK_HMAC_SECRET). The endpoint ALWAYS requires a signature.");
      process.exit(2);
    }
    sig = createHmac(algo, secret).update(rawBody).digest("hex");
  }
  headers["x-webhook-signature"] = sig;
}
if (opt.ts) {
  const now = Math.floor(Date.now() / 1000);
  headers["x-webhook-timestamp"] = String(now + (opt.tsOffset ?? 0));
}

const fullPath = `${base}/${path}`;
const reqBody = Buffer.from(rawBody, "utf8");
headers["content-length"] = String(reqBody.length);

const req = http.request({ host, port, path: fullPath, method, headers }, (res) => {
  let data = "";
  res.on("data", (c) => (data += c));
  res.on("end", () => {
    console.log(`POST http://${host}:${port}${fullPath}`);
    console.log(`  bodyBytes=${reqBody.length} signed=${!opt.noSign && !opt.badSign} badSign=${!!opt.badSign} ts=${headers["x-webhook-timestamp"] ?? "none"}`);
    console.log(`STATUS ${res.statusCode}`);
    console.log(`BODY ${data.slice(0, 2000)}`);
    process.exit(res.statusCode >= 200 && res.statusCode < 300 ? 0 : 1);
  });
});
req.on("error", (e) => {
  console.log(`POST http://${host}:${port}${fullPath}`);
  console.log(`ERROR ${e.code ?? ""} ${e.message}`);
  // ECONNREFUSED / no-route when webhooks disabled is an HONEST negative, not a script bug.
  process.exit(1);
});
req.write(reqBody);
req.end();
