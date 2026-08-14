type BootstrapSecretName = "SECRETS_MASTER_KEY" | "CANARY_SECRET";

export function hasBootstrapSecret(env: NodeJS.ProcessEnv, name: BootstrapSecretName): boolean {
  const value = name === "SECRETS_MASTER_KEY" ? env.SECRETS_MASTER_KEY : env.CANARY_SECRET;
  return typeof value === "string" && value.trim().length > 0;
}
