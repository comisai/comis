// SPDX-License-Identifier: Apache-2.0
/**
 * Prometheus/Grafana STACK artifact validity.
 *
 * The one-command stand-up's non-dashboard artifacts must be syntactically valid
 * AND structurally consistent (the mounts line up with what the provider/scrape
 * configs expect), so `docker compose up` can't silently come up wired wrong:
 *
 *   - `prometheus/prometheus.yml` — parses; has `scrape_configs` with a `comis`
 *     job targeting the exporter port, and `rule_files` globbing the shipped rules.
 *   - `grafana/provisioning/datasources/prometheus.yaml` — parses; `apiVersion: 1`;
 *     a Prometheus datasource pointing at the compose's `prometheus` service.
 *   - `grafana/provisioning/dashboards/comis.yaml` — parses; `apiVersion: 1`; a
 *     file provider whose `options.path` equals the docker-compose dashboards mount
 *     target (so the provisioned dashboards are actually found).
 *   - `docker/observability/docker-compose.yml` — parses; the prometheus service
 *     mounts `prometheus.yml` + the `rules/` dir; the grafana service mounts the
 *     `provisioning/` + `dashboards/` dirs.
 *
 * **Honestly DEFERRED (NOT faked):** the LIVE `docker compose up` end-to-end
 * (real Prometheus scraping a real daemon's /metrics, real Grafana render, the
 * exemplar→`comis explain` click-through) is operator/Linux-verified — it needs a
 * live daemon emitting /metrics. This test asserts the ARTIFACTS' validity +
 * structure only; it never launches docker. (Docker IS present on the host, but
 * the live stand-up needs a running enabled daemon, which is the operator's.)
 *
 * @module
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

const PROMETHEUS_YML = resolve(REPO_ROOT, "prometheus/prometheus.yml");
const DS_YAML = resolve(REPO_ROOT, "grafana/provisioning/datasources/prometheus.yaml");
const DASH_PROVIDER_YAML = resolve(REPO_ROOT, "grafana/provisioning/dashboards/comis.yaml");
const COMPOSE_YML = resolve(REPO_ROOT, "docker/observability/docker-compose.yml");

// The path the docker-compose mounts grafana/dashboards/ at — the file provider's
// options.path MUST equal this for the provisioned dashboards to be found.
const DASHBOARDS_MOUNT_TARGET = "/etc/grafana/dashboards";

function parseYamlFile(file: string): unknown {
  return parseYaml(readFileSync(file, "utf-8"));
}

describe("prometheus-stack — stand-up artifact validity (live up deferred)", () => {
  it("sanity: all four stack artifacts exist", () => {
    for (const f of [PROMETHEUS_YML, DS_YAML, DASH_PROVIDER_YAML, COMPOSE_YML]) {
      expect(existsSync(f), `missing stack artifact: ${f}`).toBe(true);
    }
  });

  it("prometheus.yml has a comis scrape job + rule_files glob", () => {
    const cfg = parseYamlFile(PROMETHEUS_YML) as {
      scrape_configs?: ReadonlyArray<{ job_name?: string; static_configs?: ReadonlyArray<{ targets?: readonly string[] }> }>;
      rule_files?: readonly string[];
    };
    const comisJob = (cfg.scrape_configs ?? []).find((j) => j.job_name === "comis");
    expect(comisJob, "prometheus.yml missing a job_name: comis scrape config").toBeTypeOf("object");
    const targets = (comisJob?.static_configs ?? []).flatMap((s) => s.targets ?? []);
    expect(targets.some((t) => t.includes(":9464")), `comis scrape job must target the exporter port 9464; got ${JSON.stringify(targets)}`).toBe(true);
    expect((cfg.rule_files ?? []).some((r) => r.includes("rules/")), "prometheus.yml missing rule_files globbing rules/").toBe(true);
  });

  it("the datasource provisioning is apiVersion 1 with a Prometheus datasource", () => {
    const ds = parseYamlFile(DS_YAML) as {
      apiVersion?: number;
      datasources?: ReadonlyArray<{ type?: string; url?: string; isDefault?: boolean }>;
    };
    expect(ds.apiVersion, "datasource provisioning must be apiVersion: 1").toBe(1);
    const prom = (ds.datasources ?? []).find((d) => d.type === "prometheus");
    expect(prom, "no prometheus datasource provisioned").toBeTypeOf("object");
    // The url must point at the compose's `prometheus` service (not localhost — the
    // datasource runs inside the grafana container).
    expect(prom?.url, `datasource url should target the compose prometheus service; got ${prom?.url}`).toContain("prometheus:9090");
  });

  it("the dashboard provider is apiVersion 1 and its path equals the compose mount target", () => {
    const prov = parseYamlFile(DASH_PROVIDER_YAML) as {
      apiVersion?: number;
      providers?: ReadonlyArray<{ type?: string; options?: { path?: string } }>;
    };
    expect(prov.apiVersion, "dashboard provider must be apiVersion: 1").toBe(1);
    const fileProvider = (prov.providers ?? []).find((p) => p.type === "file");
    expect(fileProvider, "no file dashboard provider").toBeTypeOf("object");
    expect(
      fileProvider?.options?.path,
      `the dashboard provider path must equal the docker-compose dashboards mount target (${DASHBOARDS_MOUNT_TARGET}); otherwise the provisioned dashboards are never found`,
    ).toBe(DASHBOARDS_MOUNT_TARGET);
  });

  it("the docker-compose mounts the provisioning + rules paths into the right services", () => {
    const compose = parseYamlFile(COMPOSE_YML) as {
      services?: {
        prometheus?: { image?: string; volumes?: readonly string[] };
        grafana?: { image?: string; volumes?: readonly string[] };
      };
    };
    const prom = compose.services?.prometheus;
    const graf = compose.services?.grafana;
    expect(prom, "compose missing the prometheus service").toBeTypeOf("object");
    expect(graf, "compose missing the grafana service").toBeTypeOf("object");
    expect(typeof prom?.image, "prometheus service missing an image").toBe("string");
    expect(typeof graf?.image, "grafana service missing an image").toBe("string");

    const promVols = (prom?.volumes ?? []).join("\n");
    expect(promVols.includes("prometheus/prometheus.yml"), "prometheus service must mount prometheus.yml").toBe(true);
    expect(promVols.includes("prometheus/rules"), "prometheus service must mount the rules/ dir").toBe(true);

    const grafVols = (graf?.volumes ?? []).join("\n");
    expect(grafVols.includes("grafana/provisioning"), "grafana service must mount the provisioning/ dir").toBe(true);
    expect(grafVols.includes("grafana/dashboards"), "grafana service must mount the dashboards/ dir").toBe(true);
    // The dashboards mount target must match the provider path asserted above.
    expect(grafVols.includes(`:${DASHBOARDS_MOUNT_TARGET}`), `grafana must mount dashboards at ${DASHBOARDS_MOUNT_TARGET}`).toBe(true);
  });
});
