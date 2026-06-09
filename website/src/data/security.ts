// SPDX-License-Identifier: Apache-2.0
/**
 * The single source of truth for the website's security story.
 *
 * The audited README deliberately leads with MECHANISMS and never headlines a
 * "layer count" - this module mirrors that. The only locked security numbers
 * are the 18 skill-content-scanner rules and the credential-broker / kernel-
 * sandbox mechanisms (CONTEXT "Accuracy contract (LOCKED)"). It does NOT encode
 * a 22/23/24/25 layer tally anywhere, and it carries the corrected cache-
 * architecture wording so compare pages have a ready, accurate replacement for
 * the cache phrasing the accuracy audit retired.
 *
 * Plain `as const` data - no logic, no derived counts.
 *
 * @module
 */

export const SECURITY = {
  /**
   * The README's headline security mechanisms, in narrative order. Each carries
   * a plain-language `promise` a household/team member can understand, plus a
   * `forEngineers` detail for the secondary/expandable layer.
   * Used by: security page, homepage Security section, compare pages.
   */
  mechanisms: [
    {
      name: "Kernel-enforced exec sandbox",
      promise:
        "Tools run jailed by the operating system itself - on by default, not a setting you have to remember to turn on.",
      forEngineers:
        "Bubblewrap on Linux (full namespace unshare: mount, PID, user, cgroup, IPC; private /tmp and /dev); sandbox-exec on macOS with profiles that open `(deny default)`. No network by default, even for interactive terminal sessions the agent drives.",
    },
    {
      name: "Credential broker",
      promise:
        "Your API keys are never where the agent can read them.",
      forEngineers:
        "Secrets live in an AES-256-GCM encrypted store; the key is injected at the network boundary, never inside the sandbox. The code that builds the sandbox env never even reads the real key. An in-process MITM broker terminates TLS with its own CA, validates a single-use session token, matches host and path against the allow-list, and swaps the placeholder at the header layer. It fails closed: any gate failure (407/403/502) destroys the tunnel before a single byte reaches upstream.",
    },
    {
      name: "Skill content scanner",
      promise:
        "Every skill is screened for hidden attacks before it can run.",
      forEngineers:
        "18 rules covering exec injection, exfiltration, and XML breakout, applied at skill load time (content-scanner). This is the canonical 18 - it belongs to the content scanner, not to log redaction.",
    },
    {
      name: "MCP malware screening",
      promise:
        "Third-party tool servers are checked for known-bad packages before they ever start.",
      forEngineers:
        "MCP packages are checked against the OSV malware database before first spawn (mcp-client-osv-check).",
    },
    {
      name: "Action classifier",
      promise:
        "Destructive actions stop and ask you first.",
      forEngineers:
        "Destructive actions pause for HMAC-signed operator approval via chat buttons; unknown action types classify as destructive and fail closed (action-classifier).",
    },
    {
      name: "Trust-partitioned memory",
      promise:
        "What an untrusted sender says can never overwrite what the system has verified.",
      forEngineers:
        "Memory writes are validated and trust-partitioned; the trust weight is structurally frozen so learning can never be poisoned into overriding a verified fact.",
    },
    {
      name: "ESLint-enforced security bans + architecture-as-tests",
      promise:
        "Insecure code patterns are blocked before they ever reach the main branch.",
      forEngineers:
        "Named bans: no path.join, no process.env, no eval/new Function, no swallowed errors - plus architecture-as-tests that block insecure patterns in CI.",
    },
  ],

  /**
   * The ONE locked security number, attributed to the content scanner. Import
   * this wherever the figure is shown so the old 18-misattribution (it was
   * mis-credited to log redaction) can never come back.
   */
  contentScannerRules: 18,

  /**
   * The SINGLE mechanism-first framing used wherever a count might otherwise be
   * headlined. Do NOT add a 22/23/24/25 layer tally - the README never does.
   */
  layerFraming:
    "defense in depth - layered runtime defenses, benchmarked, not a single guardrail",

  /**
   * The CORRECT cache wording - the accurate replacement for the cache phrasing
   * the accuracy audit retired. Used by: compare pages, context-management /
   * cost sections.
   */
  cacheArchitecture:
    "a cache-fence index keeps the cached prefix byte-stable while the context engine edits everything after it, with adaptive TTL escalation, two-phase cache-break detection, and sub-agent spawn staggering - 15+ shipped optimizations",
} as const;
