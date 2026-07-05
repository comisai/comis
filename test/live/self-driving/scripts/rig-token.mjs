// rig-token.mjs — VPS: print the gateway token LITERAL from $DATA/config.yaml, or nothing.
// The config-literal half of deploy-scripts.sh's GWTOKEN auto-fetch (the secrets-store half is
// `comis secrets get COMIS_GATEWAY_TOKEN`, which needs no helper). A ${REF} placeholder prints
// nothing — an unresolved reference is unusable as a bearer token.
import { readFileSync } from "node:fs";
import { rig, requireCodeRoot } from "./_rig.mjs";

try {
  const YAML = requireCodeRoot("yaml");
  const cfg = YAML.parse(readFileSync(`${rig.dataDir}/config.yaml`, "utf8"));
  const secret = cfg?.gateway?.tokens?.[0]?.secret ?? "";
  if (secret && !secret.startsWith("${")) process.stdout.write(secret);
} catch {
  /* no config yet (fresh box) — print nothing; the caller warns */
}
