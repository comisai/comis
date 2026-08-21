import type { SecretStorePort } from "@comis/core";
import { ok, tryCatch, type Result } from "@comis/shared";

type BootstrapSecretName = "SECRETS_MASTER_KEY" | "CANARY_SECRET";

export function hasBootstrapSecret(env: NodeJS.ProcessEnv, name: BootstrapSecretName): boolean {
  const value = name === "SECRETS_MASTER_KEY" ? env.SECRETS_MASTER_KEY : env.CANARY_SECRET;
  return typeof value === "string" && value.trim().length > 0;
}

export function ensureEncryptedCanarySecret(
  secretStore: SecretStorePort,
  env: NodeJS.ProcessEnv,
  initialize: () => void,
): Result<void, Error> {
  if (hasBootstrapSecret(env, "CANARY_SECRET")) return ok(undefined);
  const storedCanary = secretStore.getDecrypted("CANARY_SECRET");
  if (!storedCanary.ok) return storedCanary;
  if (storedCanary.value !== undefined) return ok(undefined);
  return tryCatch(initialize);
}
