// SPDX-License-Identifier: Apache-2.0
/**
 * The single source of truth for the website's competitor comparison.
 *
 * Mirrors the README "How Comis compares" stance: credit each competitor's real
 * strengths honestly (bolded where they win in the rendered pages), and quote
 * only their own documentation - verbatim. Every quote here is copied exactly
 * from the competitor's public SECURITY.md (line numbers recorded in CONTEXT /
 * RESEARCH). The Hermes channel figure is the A1-RESOLVED, enum-sourced "20+";
 * the site never prints "~5" for Hermes.
 *
 * Plain `as const` data - no logic, no derived counts.
 *
 * @module
 */

export const COMPETITORS = {
  openclaw: {
    name: "OpenClaw",
    repo: "https://github.com/openclaw/openclaw",
    // Their own framing - a personal assistant by design.
    designCenter:
      "Personal assistant - one trusted operator (potentially many agents), by design.",
    quotes: [
      {
        text: "'personal assistant' (one trusted operator, potentially many agents), not 'shared multi-tenant bus'",
        source: "OpenClaw SECURITY.md",
      },
      {
        text: "the exec sandbox is opt-in and off by default",
        source: "OpenClaw SECURITY.md",
      },
      {
        text: "prompt injection is out of scope absent a boundary bypass",
        source: "OpenClaw SECURITY.md",
      },
    ],
    // Credit honestly (bold in the rendered pages where OpenClaw wins).
    strengths: [
      "23+ channels",
      "native mobile & desktop apps",
      "voice wake",
      "Canvas",
      "140+ extensions",
    ],
    // A1-RESOLVED, repo-verified channel figure.
    channels: "23+",
  },

  hermes: {
    name: "Hermes Agent",
    repo: "https://github.com/NousResearch/hermes-agent",
    // Their own framing - a single-tenant personal agent, host-first.
    designCenter:
      "Single-tenant personal agent - host-first by default.",
    quotes: [
      {
        text: "Hermes Agent is a single-tenant personal agent",
        source: "Hermes SECURITY.md",
      },
      {
        text: "The only security boundary against an adversarial LLM is the operating system.",
        source: "Hermes SECURITY.md",
      },
    ],
    // Credit honestly (bold in the rendered pages where Hermes wins).
    strengths: [
      "self-improving skill loop (the agent rewrites its own skills)",
      "20+ platform adapters",
      "serverless execution backends (Modal/Daytona hibernate when idle)",
      "trajectory export as model-training data (ShareGPT/RL datasets)",
    ],
    // A1-RESOLVED, enum-sourced channel figure - never "~5".
    channels: "20+",
  },
} as const;

/**
 * Where Comis wins - the differentiators (CONTEXT "Competitor comparison").
 * Rendered as the Comis column / "why pick Comis" list on the compare pages.
 */
export const COMIS_WINS = [
  "Platform / multi-tenant design center - many agents × many operators, one auditable install",
  "Kernel-enforced exec sandbox, on by default",
  "Encrypted secrets (AES-256-GCM) + credential broker - keys never meet agents",
  "Layered + benchmarked prompt-injection defense",
  "Trust-partitioned learning memory (bounded tuner, trust weight frozen)",
  "Lossless context (DAG engine - nothing deleted, compression reversible in-session)",
  "Natural-language → DAG orchestration (7 node types)",
  "Local-model security floor + reliability scaffold - a weaker model gets a stricter posture and is actively tuned to run well",
  "Result<T, E> + traceId glass box - every action reconstructable from logs alone",
] as const;

/**
 * The "choose honestly" close, adapted from README §How Comis compares.
 * Rendered as the closing paragraph on the compare pages.
 */
export const COMPARE_CLOSE =
  "Choose honestly. If you want a personal assistant with native mobile apps, voice wake, and the widest channel list, OpenClaw is excellent. If you want a self-improving research agent that writes its own skills, Hermes is excellent. If you want an agent platform you can hand to your team, your family, or your company - and audit every action it takes - that's Comis.";
