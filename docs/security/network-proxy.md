# Network Proxy

Comis routes all outbound agent traffic through a configurable egress proxy. This page explains how proxy coverage works per channel transport, what security protections apply at the proxy layer, and how to configure the proxy for your deployment.

## Quick Start

Set standard environment variables before starting the daemon:

```bash
export HTTPS_PROXY=http://proxy.corp:3128
export NO_PROXY=localhost,127.0.0.1,::1
node packages/cli/dist/cli.js daemon start
```

Or configure via `~/.comis/config.yaml`:

```yaml
proxy:
  enabled: true
  httpsProxy: "http://proxy.corp:3128"
  noProxy: "localhost,127.0.0.1,::1"
  tls:
    caFile: "/etc/ssl/proxy-ca.pem"   # optional: proxy CA certificate
  loopbackMode: gateway-only           # default
```

Validate the proxy is reachable:

```bash
node packages/cli/dist/cli.js proxy validate
node packages/cli/dist/cli.js proxy validate --json
```

---

## Per-Transport Coverage Table

Comis uses several transport mechanisms across its channels. The table below shows exactly which connections are proxied, and which are accepted gaps.

**Two accepted gaps exist:** Discord WebSocket gateway and IRC raw TCP. All other channel traffic is proxied.

| Channel | Transport | Proxy Status | Notes |
|---------|-----------|-------------|-------|
| Telegram (grammy) | node:https.Agent | **Proxied** | `baseFetchConfig.agent = HttpsProxyAgent` injected at adapter construction |
| Discord REST | undici | **Proxied** | `rest.agent = ProxyAgent` (undici) injected at `new Client()` construction |
| Discord WS gateway | WebSocket | **ACCEPTED GAP** | `@discordjs/ws` gateway has no proxy hook accessible from `new Client()`; REST-only proxying. Use a system-level proxy (e.g. `tproxy`) or accept this gap. |
| Slack REST | axios | **Proxied** | `clientOptions.agent = HttpsProxyAgent` inside `new App()` |
| Slack Socket Mode | WebSocket via httpAgent | **Proxied** | Same `HttpsProxyAgent` as REST flows through `@slack/socket-mode` `httpAgent` option |
| WhatsApp (Baileys) WS | WebSocket | **Proxied** | `agent = HttpsProxyAgent` in `makeWASocket()` covers the control WebSocket |
| WhatsApp media | node:https | **Proxied** | `fetchAgent = HttpsProxyAgent` in `makeWASocket()` covers media upload/download |
| Email IMAP | raw TCP (HTTP CONNECT) | **Proxied** | `proxy: proxyUrl` in `ImapFlow` constructor (native HTTP CONNECT support) |
| Email SMTP | raw TCP (HTTP CONNECT) | **Proxied** | `proxy: proxyUrl` in `nodemailer.createTransport()` (native HTTP CONNECT support) |
| IRC | raw TCP/TLS | **ACCEPTED GAP** | `irc-framework` supports SOCKS natively but not HTTP CONNECT. HTTP CONNECT tunneling is disproportionate for a low-volume, operator-controllable channel. |
| Signal | HTTP/SSE fetch | **Proxied** | `signal-client.ts` uses Node.js global `fetch` (undici) — global dispatcher covers all fetch calls automatically |
| LINE | fetch | **Proxied** | `@line/bot-sdk` v10.x uses native `fetch` with no custom HTTP client — global dispatcher covers it automatically |
| LLM providers (Earendil Pi) | fetch | **Proxied** | `@earendil-works/pi-ai` uses `fetch` for provider API calls — global dispatcher covers it |
| MCP SDK | fetch | **Proxied** | MCP client uses `fetch` — global dispatcher covers it |
| Web search providers | fetch | **Proxied** | All search providers (Brave, Perplexity, Tavily, Exa, Jina) use `fetch` |

### How Global Dispatcher Coverage Works

At daemon boot, Comis installs a global undici `EnvHttpProxyAgent` dispatcher via `setGlobalDispatcher()`. This intercepts **all** Node.js `fetch()` calls and undici HTTP requests process-wide — no per-adapter configuration is needed for fetch-based transports. The non-fetch transports (grammy, Slack, Baileys, email) receive explicit `HttpsProxyAgent` injection at their SDK construction sites.

### Accepted Gaps

**Discord WS gateway:** The `@discordjs/ws` WebSocket gateway does not use the `rest.agent` option. Routing the WS through a proxy would require intercepting the `ws` module at the TCP level. Operators who require full Discord traffic proxying can use a transparent/TPROXY proxy at the network layer.

**IRC:** `irc-framework` 4.x uses raw `node:net` / `node:tls` sockets and supports SOCKS natively (via the `socks` npm package) but not HTTP CONNECT. Implementing HTTP CONNECT tunnel pre-establishment (`http-proxy-agent`) is disproportionate for a low-volume, operator-controllable channel. Operators who require IRC proxying should configure a SOCKS proxy and use the `irc.socks` option if/when exposed, or use a TPROXY at the network layer.

---

## SSRF Blocklist

Comis blocks proxy requests to internal and special-purpose IP ranges to prevent Server-Side Request Forgery (SSRF). The following ranges are checked against the target host before any proxy agent is constructed:

| Range | Description |
|-------|-------------|
| `127.0.0.0/8` | IPv4 loopback |
| `::1/128` | IPv6 loopback |
| `10.0.0.0/8` | RFC 1918 private (Class A) |
| `172.16.0.0/12` | RFC 1918 private (Class B) |
| `192.168.0.0/16` | RFC 1918 private (Class C) |
| `169.254.0.0/16` | IPv4 link-local (APIPA); also covers AWS/GCP/Azure `169.254.169.254` metadata |
| `100.64.0.0/10` | CGNAT / RFC 6598 shared address space |
| `fd00::/8` | IPv6 ULA (RFC 4193) |
| `fe80::/10` | IPv6 link-local |
| `::ffff:0:0/96` | IPv4-mapped IPv6 |

When `isSsrfBlocked(host)` returns true, `resolveProxyAgentForHost` returns `undefined` — no proxy agent is constructed and the request is rejected. This check runs before any proxy connection is attempted.

**Cloud metadata endpoints** in the link-local range (`169.254.169.254`, `169.254.170.2`) are blocked by the `169.254.0.0/16` entry above.

---

## loopbackMode Policy

The `proxy.loopbackMode` config key controls how the daemon gateway address (`localhost:4766`) is treated relative to proxy routing:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `gateway-only` | **Default.** The daemon gateway address (`localhost` / `127.0.0.1` / `::1`) is always in the effective `NO_PROXY` list, regardless of what `NO_PROXY` is set to. Prevents the CLI from accidentally routing its own gateway connection through an external proxy. | All standard deployments |
| `proxy` | Loopback addresses are NOT automatically added to `NO_PROXY`. Gateway traffic may route through the proxy if the proxy URL covers loopback. | Unusual split-tunnel setups |
| `block` | Any connection to a loopback address is rejected outright, even if no proxy is configured. | Hardened environments that want to prevent any loopback egress from the daemon |

The `loopbackMode: gateway-only` default ensures the `comis proxy validate` loopback canary check always passes — it asserts that `localhost:4766` is correctly bypassed by the proxy.

```yaml
proxy:
  loopbackMode: gateway-only  # or: proxy | block
```

---

## TLS: Custom CA Certificate (caFile)

If your proxy uses a self-signed or internal CA certificate, configure it via `proxy.tls.caFile`:

```yaml
proxy:
  enabled: true
  httpsProxy: "http://proxy.corp:3128"
  tls:
    caFile: "/etc/ssl/certs/proxy-ca.pem"
```

The `caFile` path must be an absolute path to a PEM-encoded CA certificate. It is passed to `HttpsProxyAgent` and undici `ProxyAgent` at construction time — it applies to the **proxy tunnel connection** (the CONNECT handshake and the proxy's TLS), not to the upstream server's TLS certificate.

Symptom of a missing `caFile`: the `comis proxy validate` output shows `proxy_tls_error` with a `CERT_*` error code. The hint will name `proxy.tls.caFile` as the config key to set.

**Security note:** The `caFile` value is the file path only. Comis reads the certificate at daemon startup; the certificate content is never logged.

---

## Environment Variables

Comis reads standard proxy environment variables at daemon boot. These take lower priority than `config.yaml` proxy settings when both are set.

### Precedence

1. `config.yaml proxy.*` keys (highest priority)
2. `HTTPS_PROXY` / `HTTP_PROXY` environment variables
3. No proxy configured (direct connections)

### Variable Reference

| Variable | Description |
|----------|-------------|
| `HTTPS_PROXY` | Proxy URL for HTTPS connections. Lowercase `https_proxy` is also read; uppercase wins if both are set. |
| `HTTP_PROXY` | Proxy URL for HTTP connections. Lowercase `http_proxy` is also read; uppercase wins if both are set. |
| `ALL_PROXY` | Fallback proxy URL used when neither `HTTPS_PROXY` nor `HTTP_PROXY` is set for a given scheme. Comis expands `ALL_PROXY` manually — it is not natively read by all underlying libraries. |
| `NO_PROXY` | Comma-separated list of hostnames, IP addresses, and CIDR ranges that bypass the proxy. Full matching: a bare hostname matches the host exactly (no subdomain wildcard); a CIDR range matches any IP in the block; a leading `.` matches the domain and all subdomains. |

```bash
# Example: corp proxy with internal domains bypassed
export HTTPS_PROXY=http://proxy.corp:3128
export NO_PROXY=localhost,127.0.0.1,::1,*.corp.internal,10.0.0.0/8
```

For the full per-variable reference including defaults and format details, see [Environment Variables — Proxy Variables](/reference/environment-variables).

---

## config.yaml Reference

```yaml
proxy:
  enabled: true                          # false = ignore all proxy settings
  httpsProxy: "http://proxy.corp:3128"  # proxy URL (overrides HTTPS_PROXY env)
  httpProxy: "http://proxy.corp:3128"   # proxy URL for HTTP (usually same as httpsProxy)
  noProxy: "localhost,127.0.0.1,::1"   # bypass list (merged with NO_PROXY env)
  loopbackMode: gateway-only            # gateway-only | proxy | block
  tls:
    caFile: "/etc/ssl/certs/proxy-ca.pem"  # optional: proxy CA certificate path
```

**Note:** Proxy credentials (username:password) belong in the proxy URL itself — `http://user:pass@proxy.corp:3128`. Comis redacts credentials from all log output via `sanitizeProxyUrl`. Never log the raw proxy URL.

---

## Validating Your Proxy Setup

```bash
# Basic validation (table output)
node packages/cli/dist/cli.js proxy validate

# JSON output (for scripts and CI)
node packages/cli/dist/cli.js proxy validate --json

# Custom target
node packages/cli/dist/cli.js proxy validate --target https://api.openai.com
```

The `proxy validate` command runs three checks:

1. **Proxy reachability** — sends a test request through the configured proxy to the target URL.
2. **Loopback canary** — asserts that `localhost:4766` is matched by the effective `NO_PROXY`, confirming the gateway is not routed through the proxy.
3. **Uncovered transports report** — lists the two accepted gaps (Discord WS, IRC) so operators know what is not proxied.

See [`comis proxy validate`](/reference/cli#comis-proxy-validate) for the full flag reference and exit code table.

---

## Related

- [Environment Variables — Proxy Variables](/reference/environment-variables)
- [CLI Reference — `comis proxy validate`](/reference/cli#comis-proxy-validate)
- [Defense in Depth](/security/defense-in-depth)
- [Hardening](/security/hardening)
