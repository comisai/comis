// SPDX-License-Identifier: Apache-2.0
/**
 * Dockerfile workspace-package COPY completeness — the local guard for the
 * Docker-build dependency-drift class.
 *
 * The full-build Dockerfiles (`Dockerfile`, `Dockerfile.install`) seed the
 * dependency install by COPYing each `packages/<name>/package.json` BEFORE
 * `pnpm install --frozen-lockfile`, then build the WHOLE workspace
 * (`pnpm -r build` / `pnpm build`). The COPY list is hand-maintained, so it
 * drifts: when a NEW workspace package is added, its `package.json` must also be
 * added to the COPY list or `pnpm install` never fetches its dependencies and
 * the image build fails at `tsc` time.
 *
 * Live incident: `@comis/observability-otel` was added but NOT added to
 * the COPY list → `error TS2307: Cannot find module '@opentelemetry/*'` — which
 * `pnpm validate` could NOT catch (it builds the FULL local workspace where the
 * deps are already installed; only the Docker image has the selective per-package
 * COPY layer). It surfaced only in the Docker Release CI job.
 *
 * This is a STATIC, cross-platform invariant (no Docker daemon, no Linux) that
 * keeps the COPY list in sync with the actual `packages/*` workspace — so the
 * drift is caught locally in `pnpm validate` (the architecture project runs under
 * `test:coverage`), not in CI.
 *
 * `Dockerfile.web` is a MINIMAL builder (`pnpm --filter @comis/web build`, only
 * `@comis/web` + its workspace deps) and is intentionally NOT covered here.
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { AppConfigSchema } from "@comis/core";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const DOCKER_COMPOSE = readFileSync(resolve(REPO_ROOT, "docker-compose.yml"), "utf8");
const DOCKER_ENV_EXAMPLE = readFileSync(resolve(REPO_ROOT, ".env.docker.example"), "utf8");
const DOCKER_ENTRYPOINT_PATH = resolve(REPO_ROOT, "docker", "comis-entrypoint.sh");
const DOCKER_SETUP = readFileSync(resolve(REPO_ROOT, "docker-setup.sh"), "utf8");
const AUTO_COMPOSE_OVERRIDE = resolve(REPO_ROOT, "docker-compose.override.yml");
const EXPLICIT_DEV_COMPOSE = resolve(REPO_ROOT, "docker-compose.dev.yml");

const COMPOSE_CREDENTIAL_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "SLACK_BOT_TOKEN",
  "COMIS_GATEWAY_TOKEN",
] as const;

function shellFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start === -1) return "";
  const end = source.indexOf("\n}", start);
  return end === -1 ? source.slice(start) : source.slice(start, end + 2);
}

function setupConfigYaml(): string {
  const marker = `cat > "$config_file" << 'YAML'\n`;
  const start = DOCKER_SETUP.indexOf(marker);
  if (start === -1) return "";
  const bodyStart = start + marker.length;
  const end = DOCKER_SETUP.indexOf("\nYAML", bodyStart);
  return end === -1 ? "" : DOCKER_SETUP.slice(bodyStart, end);
}

function runEntrypointProbe(probe: string, value: string): string[] {
  const credentialEnv = Object.fromEntries(COMPOSE_CREDENTIAL_NAMES.map((name) => [name, value]));
  const result = spawnSync("sh", [DOCKER_ENTRYPOINT_PATH, "sh", "-c", probe], {
    encoding: "utf8",
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      COMIS_WITH_XVFB: "0",
      ...credentialEnv,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split("\n");
}

/**
 * The Dockerfiles that build the ENTIRE workspace and therefore MUST COPY every
 * `packages/*` `package.json` before the frozen install. (Both run a full
 * `pnpm -r build`; a missing package breaks the install/build.)
 */
const FULL_BUILD_DOCKERFILES = ["Dockerfile", "Dockerfile.install"];

/** Every `packages/<name>` workspace dir that has a `package.json`. */
function workspacePackages(): string[] {
  return readdirSync(PACKAGES_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(resolve(PACKAGES_ROOT, e.name, "package.json")))
    .map((e) => e.name)
    .sort();
}

/**
 * The set of `<name>`s COPY'd via `COPY packages/<name>/package.json …` in the
 * install LAYER (before the first `pnpm install --frozen-lockfile`; COPYs after
 * the install do not seed it).
 */
function copiedBeforeInstall(dockerfile: string): Set<string> {
  const src = readFileSync(resolve(REPO_ROOT, dockerfile), "utf8");
  const installIdx = src.search(/pnpm install --frozen-lockfile/);
  const head = installIdx === -1 ? src : src.slice(0, installIdx);
  const copied = new Set<string>();
  const re = /^\s*COPY\s+packages\/([^/\s]+)\/package\.json\b/gm;
  for (let m = re.exec(head); m !== null; m = re.exec(head)) copied.add(m[1]!);
  return copied;
}

describe("Dockerfile workspace-package COPY completeness", () => {
  const pkgs = workspacePackages();

  it("has at least one workspace package (sanity: the walker resolved the repo)", () => {
    expect(pkgs.length).toBeGreaterThan(0);
  });

  for (const dockerfile of FULL_BUILD_DOCKERFILES) {
    it(`${dockerfile} COPYs every packages/* package.json before the frozen install`, () => {
      const copied = copiedBeforeInstall(dockerfile);
      const missing = pkgs.filter((p) => !copied.has(p));
      expect(
        missing,
        `${dockerfile} is missing a per-package COPY for: [${missing.join(", ")}]. ` +
          `Their dependencies will NOT install in the Docker build → the image build fails at tsc ` +
          `(e.g. the v2.28 observability-otel @opentelemetry TS2307). Add ` +
          `"COPY packages/<name>/package.json packages/<name>/" before "pnpm install --frozen-lockfile".`,
      ).toEqual([]);
    });
  }
});

describe("Docker Compose encrypted-storage first boot", () => {
  it("does not inject an empty master key that overrides the first-boot generated value", () => {
    expect(DOCKER_COMPOSE).not.toMatch(/^\s*(?:-\s*)?SECRETS_MASTER_KEY\s*(?:=|:|$)/m);
  });

  it("does not teach operators to define a blank master key in the Compose environment template", () => {
    expect(DOCKER_ENV_EXAMPLE).not.toMatch(/^SECRETS_MASTER_KEY\s*=\s*$/m);
  });
});

describe("Docker Compose safe default file selection", () => {
  it("keeps development overrides out of Compose's auto-loaded override filename", () => {
    expect(existsSync(AUTO_COMPOSE_OVERRIDE)).toBe(false);
    expect(existsSync(EXPLICIT_DEV_COMPOSE)).toBe(true);
  });

  it("binds the default daemon and dashboard host ports to loopback", () => {
    expect(DOCKER_COMPOSE).toContain(
      '"${COMIS_GATEWAY_HOST:-127.0.0.1}:${COMIS_GATEWAY_PORT:-4766}:4766"',
    );
    expect(DOCKER_COMPOSE).toContain(
      '"${COMIS_WEB_HOST:-127.0.0.1}:${COMIS_WEB_PORT:-8080}:8080"',
    );
  });

  it("keeps the explicit development overlay honest about its active behavior", () => {
    const devCompose = readFileSync(EXPLICIT_DEV_COMPOSE, "utf8");
    expect(devCompose).toContain("profiles: !override []");
    expect(devCompose).not.toContain("/app/src");
  });
});

describe("Docker Compose credential precedence", () => {
  it("unsets blank Compose credentials before the daemon loads its mounted environment file", () => {
    const probe = COMPOSE_CREDENTIAL_NAMES
      .map((name) => `printf '${name}=%s\\n' "\${${name}+set}"`)
      .join("; ");
    expect(runEntrypointProbe(probe, "")).toEqual(
      COMPOSE_CREDENTIAL_NAMES.map((name) => `${name}=`),
    );
  });

  it("preserves every explicit non-empty Compose credential value", () => {
    const probe = COMPOSE_CREDENTIAL_NAMES
      .map((name) => `printf '${name}=%s\\n' "\${${name}-}"`)
      .join("; ");
    expect(runEntrypointProbe(probe, "test-key")).toEqual(
      COMPOSE_CREDENTIAL_NAMES.map((name) => `${name}=test-key`),
    );
  });

  it("routes the one-shot CLI through the credential-normalizing entrypoint", () => {
    const cliService = DOCKER_COMPOSE.slice(DOCKER_COMPOSE.indexOf("  comis-cli:"));
    expect(cliService).toContain(
      'entrypoint: ["/usr/local/bin/comis-entrypoint.sh", "node", "packages/cli/dist/cli.js"]',
    );
  });
});

describe("Docker setup generated configuration", () => {
  it("parses the generated YAML through the current strict application schema", () => {
    const yaml = setupConfigYaml();
    expect(yaml).not.toBe("");
    const resolvedYaml = yaml.replace("${COMIS_GATEWAY_TOKEN}", "a".repeat(64));
    const result = AppConfigSchema.safeParse(parseYaml(resolvedYaml));
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
  });

  it("connects the generated gateway token to an authenticated admin entry", () => {
    const config = parseYaml(setupConfigYaml()) as {
      gateway?: { tokens?: Array<{ id?: string; secret?: string; scopes?: string[] }> };
    };
    expect(config.gateway?.tokens).toEqual([
      { id: "default", secret: "${COMIS_GATEWAY_TOKEN}", scopes: ["*"] },
    ]);
  });

  it("keeps generated runtime files under the mounted container data directory", () => {
    const config = parseYaml(setupConfigYaml()) as {
      daemon?: { logging?: { filePath?: string } };
      memory?: { dbPath?: string };
    };
    expect(config.daemon?.logging?.filePath).toBe("/home/comis/.comis/logs/daemon.log");
    expect(config.memory?.dbPath).toBe("/home/comis/.comis/memory.db");
    expect(setupConfigYaml()).not.toContain("/data");
  });
});

describe("Docker setup host-directory permissions", () => {
  it("creates both data and separately configured config directories", () => {
    const body = shellFunctionBody(DOCKER_SETUP, "ensure_dirs");
    expect(body).toContain('mkdir -p "$COMIS_DATA_DIR/traces"');
    expect(body).toContain('mkdir -p "$COMIS_CONFIG_DIR"');
  });

  it("runs ownership preparation as root for both mounted host directories", () => {
    const body = shellFunctionBody(DOCKER_SETUP, "fix_permissions");
    expect(body).toContain("docker run --rm --user root");
    expect(body).toContain('$COMIS_DATA_DIR:/data');
    expect(body).toContain('$COMIS_CONFIG_DIR:/config');
    expect(body).toContain('$COMIS_ENV_FILE:/env-file');
    expect(body).not.toMatch(/\|\|\s*true/);
  });

  it("uses the configured Compose environment file for token reads and writes", () => {
    expect(shellFunctionBody(DOCKER_SETUP, "ensure_dirs")).toContain(
      'mkdir -p "$(dirname "$COMIS_ENV_FILE")"',
    );
    expect(shellFunctionBody(DOCKER_SETUP, "ensure_dirs")).toContain('touch "$COMIS_ENV_FILE"');
    expect(shellFunctionBody(DOCKER_SETUP, "generate_token")).toContain(
      '[ -f "$COMIS_ENV_FILE" ]',
    );
    expect(shellFunctionBody(DOCKER_SETUP, "write_env")).toContain(
      'local env_file="$COMIS_ENV_FILE"',
    );
  });

  it("loads the project Compose settings before applying setup defaults", () => {
    const probe = `
      source "$1"
      docker() {
        printf '%s\\n' \
          'COMIS_DATA_DIR=~/docker-data' \
          'COMIS_CONFIG_DIR=~/docker-config' \
          'COMIS_ENV_FILE=~/docker-secrets/runtime.env' \
          'COMIS_IMAGE=example.com/comis:test' \
          'COMIS_GATEWAY_HOST=127.0.0.2' \
          'COMIS_GATEWAY_PORT=8765'
      }
      load_compose_settings
      printf '%s\\n' "$COMIS_DATA_DIR" "$COMIS_CONFIG_DIR" "$COMIS_ENV_FILE" \
        "$COMIS_IMAGE" "$COMIS_GATEWAY_HOST" "$COMIS_GATEWAY_PORT"
    `;
    const result = spawnSync(
      "bash",
      ["-c", probe, "docker-setup-test", resolve(REPO_ROOT, "docker-setup.sh")],
      {
        encoding: "utf8",
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/tmp/comis-home" },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "/tmp/comis-home/docker-data",
      "/tmp/comis-home/docker-config",
      "/tmp/comis-home/docker-secrets/runtime.env",
      "example.com/comis:test",
      "127.0.0.2",
      "8765",
    ]);
  });
});

describe("Docker CLI mounted environment", () => {
  it("mounts the same configured environment file as the daemon", () => {
    const cliService = DOCKER_COMPOSE.slice(DOCKER_COMPOSE.indexOf("  comis-cli:"));
    expect(cliService).toContain(
      "${COMIS_ENV_FILE:-~/.comis/.env}:/home/comis/.comis/.env",
    );
  });
});

describe("Docker setup health handoff", () => {
  it("does not print any gateway-token fragment on successful setup", () => {
    expect(DOCKER_SETUP).not.toContain("${COMIS_GATEWAY_TOKEN:0");
    expect(DOCKER_SETUP).toContain('log "  Credentials: $COMIS_ENV_FILE"');
  });

  it("waits through the Compose start period and first healthcheck window", () => {
    const compose = parseYaml(DOCKER_COMPOSE) as {
      services?: {
        "comis-daemon"?: {
          healthcheck?: { start_period?: string; interval?: string; timeout?: string };
        };
      };
    };
    const health = compose.services?.["comis-daemon"]?.healthcheck;
    const seconds = (value: string | undefined): number => Number.parseInt(value ?? "0", 10);
    const minimumWaitSeconds =
      seconds(health?.start_period) + seconds(health?.interval) + seconds(health?.timeout);
    const body = shellFunctionBody(DOCKER_SETUP, "start_services");
    const configuredWait = Number.parseInt(body.match(/local wait_seconds=(\d+)/)?.[1] ?? "0", 10);
    expect(configuredWait).toBeGreaterThanOrEqual(minimumWaitSeconds);
  });

  it("returns nonzero with an actionable logs command instead of reporting false success", () => {
    expect(DOCKER_SETUP).toContain('if [[ "${BASH_SOURCE[0]}" == "$0" ]]');

    const probe = `
      source "$1"
      ensure_dirs() { :; }
      generate_token() { COMIS_GATEWAY_TOKEN="test-key"; export COMIS_GATEWAY_TOKEN; }
      write_env() { :; }
      create_default_config() { :; }
      build_image() { :; }
      fix_permissions() { :; }
      sleep() { :; }
      docker() {
        if [ "\${1:-}" = "inspect" ]; then
          printf '%s\\n' starting
        fi
        return 0
      }
      main
    `;
    const result = spawnSync("bash", ["-c", probe, "docker-setup-test", resolve(REPO_ROOT, "docker-setup.sh")], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: "/tmp" },
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("Setup complete!");
    expect(result.stderr).toContain("docker compose logs --tail=200 comis-daemon");
  });
});
