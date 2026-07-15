// SPDX-License-Identifier: Apache-2.0
import { isAbsolute } from "node:path";

import { err, ok, type Result } from "@comis/shared";

export type ProductionHostRole = "production" | "test";

export interface ProductionHostProfile {
  readonly ssh: string;
  readonly sshPort?: number;
  readonly role: ProductionHostRole;
  readonly comisUser: string;
  readonly dataDir: string;
  readonly service: string;
  readonly expectedMachineIdSha256: string;
}

export interface ProductionReplayProfile {
  readonly source: ProductionHostProfile & { readonly role: "production" };
  readonly target: ProductionHostProfile & { readonly role: "test" };
}

export type ProductionProfileError =
  | { readonly kind: "missing_field"; readonly field: string; readonly message: string }
  | { readonly kind: "invalid_host"; readonly field: string; readonly message: string }
  | { readonly kind: "invalid_port"; readonly field: string; readonly message: string }
  | { readonly kind: "same_host"; readonly message: string }
  | { readonly kind: "invalid_role"; readonly field: string; readonly message: string }
  | { readonly kind: "invalid_path"; readonly field: string; readonly message: string }
  | { readonly kind: "invalid_name"; readonly field: string; readonly message: string }
  | { readonly kind: "invalid_machine_id"; readonly field: string; readonly message: string };

type ParsedValues = ReadonlyMap<string, string>;

const SAFE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.@-]*$/;
const SHA256_RE = /^[a-f0-9]{64}$/;

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function decodeValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function isAsciiAlphaNumeric(character: string): boolean {
  return (
    (character >= "0" && character <= "9") ||
    (character >= "A" && character <= "Z") ||
    (character >= "a" && character <= "z")
  );
}

function isSafeEndpointSegment(value: string, requireAlphaNumericFirst: boolean): boolean {
  if (value.length === 0 || (requireAlphaNumericFirst && !isAsciiAlphaNumeric(value[0] as string))) {
    return false;
  }
  for (const character of value) {
    if (!isAsciiAlphaNumeric(character) && character !== "." && character !== "_" && character !== "-") {
      return false;
    }
  }
  return true;
}

function isEnvKey(value: string): boolean {
  if (value.length === 0 || value[0] === undefined || value[0] < "A" || value[0] > "Z") {
    return false;
  }
  for (const character of value) {
    const digit = character >= "0" && character <= "9";
    const upper = character >= "A" && character <= "Z";
    if (!digit && !upper && character !== "_") return false;
  }
  return true;
}

function parseValues(content: string): ParsedValues {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const assignment = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    const key = assignment.slice(0, separator);
    if (!isEnvKey(key)) continue;
    values.set(key, decodeValue(assignment.slice(separator + 1)));
  }
  return values;
}

function requireField(
  values: ParsedValues,
  field: string,
): Result<string, ProductionProfileError> {
  const value = values.get(field);
  if (value === undefined || value === "") {
    return err({ kind: "missing_field", field, message: `${field} is required` });
  }
  return ok(value);
}

function validateHost(field: string, value: string): Result<string, ProductionProfileError> {
  const firstAt = value.indexOf("@");
  const lastAt = value.lastIndexOf("@");
  const user = firstAt === -1 ? undefined : value.slice(0, firstAt);
  const host = firstAt === -1 ? value : value.slice(firstAt + 1);
  if (
    firstAt !== lastAt ||
    (user !== undefined && !isSafeEndpointSegment(user, false)) ||
    !isSafeEndpointSegment(host, true)
  ) {
    return err({ kind: "invalid_host", field, message: `${field} is not a safe SSH target` });
  }
  return ok(value);
}

function optionalPort(
  values: ParsedValues,
  field: string,
): Result<number | undefined, ProductionProfileError> {
  const value = values.get(field);
  if (value === undefined || value === "") return ok(undefined);
  if (!/^[0-9]{1,5}$/u.test(value)) {
    return err({ kind: "invalid_port", field, message: `${field} must be an integer port` });
  }
  const port = Number(value);
  if (port < 1 || port > 65_535) {
    return err({ kind: "invalid_port", field, message: `${field} is outside the valid port range` });
  }
  return ok(port);
}

function validateRole(
  field: string,
  value: string,
  expected: ProductionHostRole,
): Result<ProductionHostRole, ProductionProfileError> {
  if (value !== expected) {
    return err({
      kind: "invalid_role",
      field,
      message: `${field} must be ${expected}`,
    });
  }
  return ok(expected);
}

function validatePath(field: string, value: string): Result<string, ProductionProfileError> {
  const segments = value.split("/");
  if (
    !isAbsolute(value) ||
    value === "/" ||
    segments.some((segment) => segment === "." || segment === "..") ||
    hasControlCharacters(value)
  ) {
    return err({
      kind: "invalid_path",
      field,
      message: `${field} must be an absolute non-root path`,
    });
  }
  return ok(value.replace(/\/+$/u, ""));
}

function validateName(field: string, value: string): Result<string, ProductionProfileError> {
  if (!SAFE_NAME_RE.test(value)) {
    return err({ kind: "invalid_name", field, message: `${field} contains unsafe characters` });
  }
  return ok(value);
}

function requireMachineId(
  values: ParsedValues,
  field: string,
): Result<string, ProductionProfileError> {
  const required = requireField(values, field);
  if (!required.ok) return required;
  const value = required.value;
  if (!SHA256_RE.test(value)) {
    return err({
      kind: "invalid_machine_id",
      field,
      message: `${field} must be a lowercase SHA-256 digest`,
    });
  }
  return ok(value);
}

function endpointIdentity(ssh: string): string {
  const at = ssh.lastIndexOf("@");
  return ssh.slice(at + 1).toLowerCase();
}

export function parseProductionProfile(
  content: string,
): Result<ProductionReplayProfile, ProductionProfileError> {
  const values = parseValues(content);

  const sourceHostField = requireField(values, "SOURCE_HOST");
  if (!sourceHostField.ok) return sourceHostField;
  const sourceHost = validateHost("SOURCE_HOST", sourceHostField.value);
  if (!sourceHost.ok) return sourceHost;

  const targetHostField = requireField(values, "TARGET_HOST");
  if (!targetHostField.ok) return targetHostField;
  const targetHost = validateHost("TARGET_HOST", targetHostField.value);
  if (!targetHost.ok) return targetHost;

  const sourcePort = optionalPort(values, "SOURCE_SSH_PORT");
  if (!sourcePort.ok) return sourcePort;
  const targetPort = optionalPort(values, "TARGET_SSH_PORT");
  if (!targetPort.ok) return targetPort;

  if (endpointIdentity(sourceHost.value) === endpointIdentity(targetHost.value)) {
    return err({
      kind: "same_host",
      message: "SOURCE_HOST and TARGET_HOST must resolve to distinct configured endpoints",
    });
  }

  const sourceRoleField = requireField(values, "SOURCE_ROLE");
  if (!sourceRoleField.ok) return sourceRoleField;
  const sourceRole = validateRole("SOURCE_ROLE", sourceRoleField.value, "production");
  if (!sourceRole.ok) return sourceRole;

  const targetRoleField = requireField(values, "TARGET_ROLE");
  if (!targetRoleField.ok) return targetRoleField;
  const targetRole = validateRole("TARGET_ROLE", targetRoleField.value, "test");
  if (!targetRole.ok) return targetRole;

  const sourceUserField = requireField(values, "SOURCE_COMIS_USER");
  if (!sourceUserField.ok) return sourceUserField;
  const sourceUser = validateName("SOURCE_COMIS_USER", sourceUserField.value);
  if (!sourceUser.ok) return sourceUser;

  const targetUserField = requireField(values, "TARGET_COMIS_USER");
  if (!targetUserField.ok) return targetUserField;
  const targetUser = validateName("TARGET_COMIS_USER", targetUserField.value);
  if (!targetUser.ok) return targetUser;

  const sourceDataField = requireField(values, "SOURCE_DATA");
  if (!sourceDataField.ok) return sourceDataField;
  const sourceData = validatePath("SOURCE_DATA", sourceDataField.value);
  if (!sourceData.ok) return sourceData;

  const targetDataField = requireField(values, "TARGET_DATA");
  if (!targetDataField.ok) return targetDataField;
  const targetData = validatePath("TARGET_DATA", targetDataField.value);
  if (!targetData.ok) return targetData;

  const sourceServiceField = requireField(values, "SOURCE_SERVICE");
  if (!sourceServiceField.ok) return sourceServiceField;
  const sourceService = validateName("SOURCE_SERVICE", sourceServiceField.value);
  if (!sourceService.ok) return sourceService;

  const targetServiceField = requireField(values, "TARGET_SERVICE");
  if (!targetServiceField.ok) return targetServiceField;
  const targetService = validateName("TARGET_SERVICE", targetServiceField.value);
  if (!targetService.ok) return targetService;

  const sourceMachineId = requireMachineId(values, "SOURCE_MACHINE_ID_SHA256");
  if (!sourceMachineId.ok) return sourceMachineId;
  const targetMachineId = requireMachineId(values, "TARGET_MACHINE_ID_SHA256");
  if (!targetMachineId.ok) return targetMachineId;

  return ok({
    source: {
      ssh: sourceHost.value,
      ...(sourcePort.value !== undefined ? { sshPort: sourcePort.value } : {}),
      role: "production",
      comisUser: sourceUser.value,
      dataDir: sourceData.value,
      service: sourceService.value,
      expectedMachineIdSha256: sourceMachineId.value,
    },
    target: {
      ssh: targetHost.value,
      ...(targetPort.value !== undefined ? { sshPort: targetPort.value } : {}),
      role: "test",
      comisUser: targetUser.value,
      dataDir: targetData.value,
      service: targetService.value,
      expectedMachineIdSha256: targetMachineId.value,
    },
  });
}

export function productionProfileSummary(profile: ProductionReplayProfile): {
  readonly source: ProductionHostProfile;
  readonly target: ProductionHostProfile;
} {
  return {
    source: { ...profile.source },
    target: { ...profile.target },
  };
}
