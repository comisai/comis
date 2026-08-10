// SPDX-License-Identifier: Apache-2.0
import { randomBytes } from "node:crypto";
import { unlinkSync } from "node:fs";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BundleDigestSchema, ServiceInstanceIdSchema } from "@comis/capability-service-sdk";
import { safePath } from "@comis/core";
import { createSystemClock } from "@comis/infra";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";
import { createCapabilityServiceProtocolFixtureServer } from "./capability-service-protocol-fixture-server.js";

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = resolve(here, "../../../capability-service-sdk/protocol/manifest.json");
const CREDENTIAL_NAME = "capability-service.bearer";
const DEFAULT_SERVICE_INSTANCE_ID = "service-instance_a";

interface EntryOptions {
  readonly directoryPath: string;
  readonly serviceInstanceId: string;
}

function parseArguments(args: readonly string[]): Result<EntryOptions> {
  let directoryPath: string | undefined;
  let serviceInstanceId = DEFAULT_SERVICE_INSTANCE_ID;
  for (let index = 0; index < args.length; index += 2) {
    // eslint-disable-next-line security/detect-object-injection -- fixed-step CLI parser reads only the caller's bounded argv positions
    const name = args[index];
    const value = args[index + 1];
    if (value === undefined) return err(new Error("every fixture-host option requires a value"));
    if (name === "--directory") directoryPath = value;
    else if (name === "--service-instance-id") serviceInstanceId = value;
    else return err(new Error("fixture host received an unknown option"));
  }
  if (!directoryPath || !ServiceInstanceIdSchema.safeParse(serviceInstanceId).success) {
    return err(new Error("fixture host requires --directory and a valid service instance ID"));
  }
  return ok({ directoryPath, serviceInstanceId });
}

async function readBundleDigest(): Promise<Result<string>> {
  const contents = await fromPromise(readFile(MANIFEST_PATH, "utf8"));
  if (!contents.ok) return contents;
  const parsed = tryCatch(() => JSON.parse(contents.value) as unknown);
  if (!parsed.ok || typeof parsed.value !== "object" || parsed.value === null) {
    return err(new Error("capability-service manifest is invalid"));
  }
  const digest = BundleDigestSchema.safeParse((parsed.value as { bundleDigest?: unknown }).bundleDigest);
  return digest.success ? ok(digest.data) : err(new Error("capability-service manifest digest is invalid"));
}

function waitForShutdown(credentialPath: string): Promise<void> {
  return new Promise((resolveShutdown) => {
    const finish = () => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      // Remove the secret before asynchronous socket teardown so a supervising
      // script cannot terminate this process between signal receipt and cleanup.
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- exact safePath-confined credential created by this process
      const removed = tryCatch(() => unlinkSync(credentialPath));
      if (!removed.ok && (removed.error as NodeJS.ErrnoException).code !== "ENOENT") {
        process.stderr.write("capability-service fixture host could not remove its credential\n");
        process.exitCode = 1;
      }
      resolveShutdown();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

async function run(): Promise<Result<void>> {
  const options = parseArguments(process.argv.slice(2));
  if (!options.ok) return options;
  const digest = await readBundleDigest();
  if (!digest.ok) return digest;
  const credentialPathResult = tryCatch(() => safePath(options.value.directoryPath, CREDENTIAL_NAME));
  if (!credentialPathResult.ok) return credentialPathResult;
  const bearer = randomBytes(32).toString("base64url");
  const server = createCapabilityServiceProtocolFixtureServer({
    activeScopes: [
      "health",
      "report",
      "workspace_lease",
      "terminal_events",
      "execution_attachment",
    ],
    attachmentPreparationRefs: ["external-run_a"],
    bundleDigest: digest.value,
    clock: createSystemClock(),
    directoryPath: options.value.directoryPath,
    expectedBearer: bearer,
    requestDeadlineMs: 5_000,
    serviceInstanceId: options.value.serviceInstanceId,
    workspacePreparationRefs: ["external-run_a"],
  });
  const started = await server.start();
  if (!started.ok) return started;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- safePath-confined credential target beneath the validated fixture directory
  const written = await fromPromise(writeFile(
    credentialPathResult.value,
    `${bearer}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  ));
  if (!written.ok) {
    await server.close();
    return written;
  }
  process.stdout.write(`${JSON.stringify({
    protocolId: "comis.capability-service/1",
    bundleDigest: digest.value,
    serviceInstanceId: options.value.serviceInstanceId,
    socketPath: started.value.socketPath,
    credentialSource: { kind: "file", path: credentialPathResult.value },
  })}\n`);
  await waitForShutdown(credentialPathResult.value);
  const closed = await server.close();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- removes only the exact safePath-confined credential created by this process
  const removed = await fromPromise(unlink(credentialPathResult.value));
  if (!closed.ok) return closed;
  if (!removed.ok && (removed.error as NodeJS.ErrnoException).code !== "ENOENT") return removed;
  return ok(undefined);
}

const result = await run();
if (!result.ok) {
  process.stderr.write(`capability-service fixture host failed: ${result.error.message}\n`);
  process.exitCode = 1;
}
