// SPDX-License-Identifier: Apache-2.0
/**
 * The single source of truth for every counted, benchmarked, and cost fact the
 * website states. Import `FACTS` instead of hardcoding a number in a page or
 * component - so "11 channels", "15 packages", "35 providers", or "~71%" can
 * never be stated two different ways across the site.
 *
 * Every value here is copied verbatim from the audited README and is treated
 * as a locked accuracy contract. Do NOT round, rephrase, or recompute a
 * number - that is the entire point of this module.
 * It is plain `as const` data: no logic and no derived counts.
 *
 * @module
 */

export const FACTS = {
  // Positioning spine (mirror README header). Plain-language, non-technical-first.
  // Used by: Hero, Footer, AboutName, every page's meta title/description voice.
  // No trailing period; consumers (Footer/AboutName) add their own.
  spine: "Self-hosted AI agents for teams, communities, and serious personal workflows",
  subspine:
    "Messaging-native agents, encrypted secrets, sandboxed tools, learning memory, and an auditable operations surface - all on infrastructure you control.",

  // Counts.
  // Used by: homepage / Channels / compare pages (channels), Everything-in-the-box (packages).
  channels: 11,
  channelList: [
    "Telegram", "Discord", "Slack", "WhatsApp", "Signal",
    "iMessage", "LINE", "IRC", "Email", "Microsoft Teams",
    "Matrix",
  ],
  packages: 15,
  nodeEngines: "22.19+",
  dagNodeTypes: 7, // agent, debate, vote, refine, collaborate, map-reduce, human approval gate

  // Models / tools / MCP (the corrected framing - not a 6-name list, and the tool
  // count is never conflated with the MCP-server ecosystem figure).
  // Used by: homepage Features / Any-model section, compare pages.
  models:
    "35 catalog providers via pi-ai, local Ollama/LM Studio, and any OpenAI-compatible endpoint",
  modelProvidersCount: 35,
  mcp: "the MCP ecosystem's 50+ servers - none bundled, you choose",

  // Docker sandbox (corrected wording - the daemon detects the constraint and
  // auto-disables the exec sandbox; it never does so without surfacing it).
  // Used by: QuickStart / security / docker callouts.
  dockerSandbox:
    "Comis detects unsupported dev/container sandbox hosts at startup, logs the downgrade, and auto-disables exec sandboxing rather than pretending isolation exists",

  // Benchmarks (each maps to a committed manifest).
  // Used by: memory page, compare pages, homepage CostSavings/memory hooks.
  benchmarks: {
    longMemEval: "~71%",          // 71.11 cross-judged (LongMemEval + LoCoMo)
    recallAt5: "84.5%",           // 0.84508
    mem0Tie: "87.5%",             // head-to-head tie with mem0, N=8, both 0.875
    mem0TieN: 8,
    controlDelta: "+37.5 pt",     // over a 50% full-context-dump control
    onDeviceCost: "$0 on-device",
  },
  benchmarksRepoTree: "https://github.com/comisai/comis/tree/main/benchmarks/results",
  benchmarkReproduceCmd: "pnpm bench:memory",

  // Cost (previously published - keep verbatim).
  // Used by: CostSavings component, context-management page.
  costs: {
    cachedSession: "$5.02",       // 76-call Opus session
    uncachedSession: "$26.42",
    cacheHitRate: "94%",          // warm turns
    cacheRatio: "16.9x",          // production cache read/write ratio (canonical - rounds to "17 tokens served" in prose)
    pipelineCost: "$2.11",        // 8-agent pipeline, 788K tokens
    pipelineTokens: "788K",
    savingsPct: "81%",            // "81% cheaper"
  },

  // Canonical external links the site reuses.
  // Used by: Nav / Footer / OpenSource / QuickStart across all pages.
  links: {
    github: "https://github.com/comisai/comis",
    docs: "https://docs.comis.ai",
    discord: "https://discord.gg/FsqgJkpp",
    install: "https://comis.ai/install.sh",
    goodFirstIssue:
      "https://github.com/comisai/comis/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22",
  },
} as const;
