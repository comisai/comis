// SPDX-License-Identifier: Apache-2.0
import { isAbsolute } from "node:path";

import { err, ok, tryCatch, type Result } from "@comis/shared";

import type {
  ProductionRemoteExecutor,
  ProductionRemoteInvocation,
} from "./production-bootstrap.js";
import type { ProductionReplayProfile } from "./production-profile.js";

export const MESSAGES_ATTESTATION_BEGIN = "COMIS_OFFLINE_MESSAGES_ATTESTATION_V1_BEGIN";
export const MESSAGES_ATTESTATION_END = "COMIS_OFFLINE_MESSAGES_ATTESTATION_V1_END";
const MESSAGE_LIMIT = 10_000;
const MAX_ATTESTATION_BYTES = 2048;

export interface ProductionMessagesPlanInput {
  readonly host: string;
  readonly port?: number;
  readonly expectedMachineIdSha256: string;
  readonly role: "production" | "test";
  readonly serviceUser: string;
  readonly service: string;
  readonly dataDir: string;
  readonly channel: string;
}

export interface ProductionMessagesAttestation {
  readonly schema: "comis-offline-messages-attestation";
  readonly schemaVersion: 1;
  readonly channel: string;
  readonly limit: 10_000;
  readonly count: number;
  readonly bytes: number;
  readonly digestSha256: string;
  readonly truncated: boolean;
}

export interface ProductionMessagesParityReport {
  /** The bounded retained message exports match; other activity sources are outside this claim. */
  readonly historyMatched: true;
  readonly source: ProductionMessagesAttestation;
  readonly target: ProductionMessagesAttestation;
}

export type ProductionMessagesError =
  | { readonly kind: "unsafe_input"; readonly field: string; readonly message: string }
  | { readonly kind: "remote_failure"; readonly stage: string; readonly message: string }
  | { readonly kind: "malformed_attestation"; readonly message: string }
  | { readonly kind: "history_mismatch"; readonly message: string }
  | { readonly kind: "history_truncated"; readonly message: string };

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_.@-]*$/u;
const SAFE_CHANNEL = /^[a-z][a-z0-9_-]{0,63}$/u;
const ATTESTATION_KEYS = [
  "schema",
  "schemaVersion",
  "channel",
  "limit",
  "count",
  "bytes",
  "digestSha256",
  "truncated",
] as const;
const ATTESTATION_KEY_SET = new Set<string>(ATTESTATION_KEYS);

const MESSAGES_SCRIPT = String.raw`set -euo pipefail
expected_machine="$1"
role="$2"
service_user="$3"
service="$4"
data_dir="$5"
channel="$6"
if [ "$(id -u)" -ne 0 ]; then exit 70; fi
actual_machine="$(sha256sum /etc/machine-id | awk '{print $1}')"
if [ "$actual_machine" != "$expected_machine" ]; then exit 71; fi
if [ "$role" = test ]; then
  marker=/etc/comis/environment-role
  if [ -L "$marker" ] || [ "$(cat "$marker" 2>/dev/null || true)" != test ] || \
     [ "$(stat -c '%u:%g:%a:%s' "$marker" 2>/dev/null || true)" != 0:0:644:5 ]; then exit 72; fi
elif [ "$role" != production ]; then
  exit 72
fi
case "$service" in *.service) unit="$service" ;; *) unit="$service.service" ;; esac
if [ "$(systemctl is-active "$unit" 2>/dev/null || true)" != inactive ]; then exit 73; fi
if [ ! -d "$data_dir" ] || [ -L "$data_dir" ] || ! id "$service_user" >/dev/null 2>&1; then exit 74; fi
service_home="$(getent passwd "$service_user" | cut -d: -f6)"
cli="$service_home/.npm-global/bin/comis"
if [ ! -x "$cli" ]; then exit 75; fi
parser='const crypto=require("node:crypto");let chunks=[];let bytes=0;const max=67108864;process.stdin.on("data",chunk=>{bytes+=chunk.length;if(bytes>max)process.exit(76);chunks.push(chunk)});process.stdin.on("end",()=>{try{const raw=Buffer.concat(chunks);const value=JSON.parse(raw.toString("utf8"));if(!Array.isArray(value))process.exit(77);const report={schema:"comis-offline-messages-attestation",schemaVersion:1,channel:process.argv[1],limit:10000,count:value.length,bytes,digestSha256:crypto.createHash("sha256").update(raw).digest("hex"),truncated:value.length===10000};process.stdout.write("COMIS_OFFLINE_MESSAGES_ATTESTATION_V1_BEGIN\n"+JSON.stringify(report)+"\nCOMIS_OFFLINE_MESSAGES_ATTESTATION_V1_END\n")}catch{process.exit(77)}})'
sudo -H -u "$service_user" env COMIS_DATA_DIR="$data_dir" \
  "$cli" messages --channel "$channel" --limit 10000 --format json 2>/dev/null | \
  node -e "$parser" "$channel"
`;

function unsafeInput(field: string): Result<never, ProductionMessagesError> {
  return err({ kind: "unsafe_input", field, message: `Offline messages ${field} is unsafe` });
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function buildProductionMessagesPlan(
  input: ProductionMessagesPlanInput,
): Result<ProductionRemoteInvocation, ProductionMessagesError> {
  if (input.host === "" || /\s/u.test(input.host) || hasControlCharacters(input.host)) {
    return unsafeInput("host");
  }
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)) {
    return unsafeInput("port");
  }
  if (!SHA256.test(input.expectedMachineIdSha256)) return unsafeInput("machine identity");
  if (input.role !== "production" && input.role !== "test") return unsafeInput("role");
  if (!SAFE_NAME.test(input.serviceUser)) return unsafeInput("service user");
  if (!SAFE_NAME.test(input.service)) return unsafeInput("service");
  if (
    !isAbsolute(input.dataDir) ||
    input.dataDir === "/" ||
    input.dataDir.includes("\\") ||
    hasControlCharacters(input.dataDir) ||
    input.dataDir.split("/").slice(1).some((part) => part === "" || part === "." || part === "..")
  ) {
    return unsafeInput("data directory");
  }
  if (!SAFE_CHANNEL.test(input.channel)) return unsafeInput("channel");
  return ok({
    label: input.role === "production" ? "messages-attest-source" : "messages-attest-target",
    host: input.host,
    ...(input.port !== undefined ? { port: input.port } : {}),
    args: [
      "sudo",
      "bash",
      "-s",
      "--",
      input.expectedMachineIdSha256,
      input.role,
      input.serviceUser,
      input.service,
      input.dataDir,
      input.channel,
    ],
    stdin: MESSAGES_SCRIPT,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value);
  return keys.length === ATTESTATION_KEYS.length && keys.every((key) => ATTESTATION_KEY_SET.has(key));
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseProductionMessagesAttestation(
  raw: string,
): Result<ProductionMessagesAttestation, ProductionMessagesError> {
  if (
    Buffer.byteLength(raw, "utf8") > MAX_ATTESTATION_BYTES ||
    raw.includes("\0") ||
    raw.includes("\r")
  ) {
    return err({ kind: "malformed_attestation", message: "Offline messages attestation is invalid" });
  }
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  const lines = normalized.split("\n");
  if (
    lines.length !== 3 ||
    lines.at(0) !== MESSAGES_ATTESTATION_BEGIN ||
    lines.at(2) !== MESSAGES_ATTESTATION_END
  ) {
    return err({ kind: "malformed_attestation", message: "Offline messages attestation is invalid" });
  }
  const decoded = tryCatch(() => JSON.parse(lines.at(1) as string) as unknown);
  if (!decoded.ok || !isRecord(decoded.value) || !hasExactKeys(decoded.value)) {
    return err({ kind: "malformed_attestation", message: "Offline messages attestation is invalid" });
  }
  const value = decoded.value;
  if (
    value.schema !== "comis-offline-messages-attestation" ||
    value.schemaVersion !== 1 ||
    typeof value.channel !== "string" ||
    !SAFE_CHANNEL.test(value.channel) ||
    value.limit !== MESSAGE_LIMIT ||
    !isCount(value.count) ||
    value.count > MESSAGE_LIMIT ||
    !isCount(value.bytes) ||
    value.bytes === 0 ||
    typeof value.digestSha256 !== "string" ||
    !SHA256.test(value.digestSha256) ||
    typeof value.truncated !== "boolean" ||
    value.truncated !== (value.count === MESSAGE_LIMIT)
  ) {
    return err({ kind: "malformed_attestation", message: "Offline messages attestation is invalid" });
  }
  return ok(value as unknown as ProductionMessagesAttestation);
}

async function executeOne(
  plan: ProductionRemoteInvocation,
  executor: ProductionRemoteExecutor,
): Promise<Result<ProductionMessagesAttestation, ProductionMessagesError>> {
  const result = await executor.run(plan);
  if (!result.ok || result.value.exitCode !== 0) {
    return err({
      kind: "remote_failure",
      stage: plan.label,
      message: `Offline messages attestation failed during ${plan.label}`,
    });
  }
  const parsed = parseProductionMessagesAttestation(result.value.stdout);
  if (!parsed.ok) return parsed;
  return parsed;
}

export async function executeProductionMessagesAttestation(
  profile: ProductionReplayProfile,
  channel: string,
  executor: ProductionRemoteExecutor,
): Promise<Result<ProductionMessagesParityReport, ProductionMessagesError>> {
  const sourcePlan = buildProductionMessagesPlan({
    host: profile.source.ssh,
    ...(profile.source.sshPort !== undefined ? { port: profile.source.sshPort } : {}),
    expectedMachineIdSha256: profile.source.expectedMachineIdSha256,
    role: "production",
    serviceUser: profile.source.comisUser,
    service: profile.source.service,
    dataDir: profile.source.dataDir,
    channel,
  });
  if (!sourcePlan.ok) return sourcePlan;
  const targetPlan = buildProductionMessagesPlan({
    host: profile.target.ssh,
    ...(profile.target.sshPort !== undefined ? { port: profile.target.sshPort } : {}),
    expectedMachineIdSha256: profile.target.expectedMachineIdSha256,
    role: "test",
    serviceUser: profile.target.comisUser,
    service: profile.target.service,
    dataDir: profile.target.dataDir,
    channel,
  });
  if (!targetPlan.ok) return targetPlan;

  const [source, target] = await Promise.all([
    executeOne(sourcePlan.value, executor),
    executeOne(targetPlan.value, executor),
  ]);
  if (!source.ok) return source;
  if (!target.ok) return target;
  if (source.value.truncated || target.value.truncated) {
    return err({
      kind: "history_truncated",
      message: "Offline message history reached the fixed extraction limit",
    });
  }
  if (
    source.value.channel !== target.value.channel ||
    source.value.count !== target.value.count ||
    source.value.bytes !== target.value.bytes ||
    source.value.digestSha256 !== target.value.digestSha256
  ) {
    return err({
      kind: "history_mismatch",
      message: "Restored offline message history does not match the production source",
    });
  }
  return ok({ historyMatched: true, source: source.value, target: target.value });
}
