#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CYBER_ABUSE_AUTH_ENV = "COMIS_LIVE_CYBER_ABUSE_TESTS";
export const CYBER_ABUSE_AUTH_VALUE = "operator-authorized";
export const LIVE_TEST_RISK_ENV = "COMIS_LIVE_TEST_RISK";

// Generic RPC callers reach the provider with caller-supplied text, so every
// method is classified unless it is a purely operational or diagnostic call
// that carries no model prompt. Default-deny keeps a newly used RPC gated
// instead of silently escaping the suspension.
export const UNGATED_RPC_METHODS = Object.freeze([
  "capabilities.introspect",
  "cron.list",
  "cron.runs",
  "cron.status",
  "lease.revoke",
  "obs.explain",
  "obs.system.health",
  "run.kill",
  "session.reset_conversation",
  "tokens.create",
]);

const UNGATED_RPC_METHOD_SET = new Set(UNGATED_RPC_METHODS);
const RPC_TEXT_MAX_NODES = 500;
const RPC_TEXT_MAX_DEPTH = 12;

const RISK_PATTERNS = [
  {
    category: "cyber-operations",
    patterns: [
      /\b(?:soc|security operations?)\s+(?:alert|incident)\b/i,
      /\bthreat[-\s]?hunt(?:ing)?\b/i,
      /\b(?:lateral movement|credential dump(?:ing)?|reverse shell|shellcode|ransomware|malware|exploit(?:ation)?|command[-\s]?and[-\s]?control|red[-\s]?team|attack chain|port scan|network scan)\b/i,
    ],
  },
  {
    category: "credential-extraction",
    patterns: [
      /\b(?:print|show|dump|reveal|display|read|send|route|exfiltrat\w*|leak|give me)\b[^\n]{0,100}\b(?:secret|credential|token|api[-\s]?key|bearer|password|environment variable|env(?:ironment)?)\b/i,
      /\b(?:secret|credential|token|api[-\s]?key|bearer|password)\b[^\n]{0,100}\b(?:print|show|dump|reveal|display|read|send|route|exfiltrat\w*|leak)\b/i,
      /\bwhat(?:'s| is)\b[^\n]{0,60}\b(?:password|token|secret|api[-\s]?key)\b/i,
      /\b(?:use|connect|authenticate|save|store|configure)\b[^\n]{0,100}\b(?:credential|token|api[-\s]?key|bearer|password|secret)\b/i,
      /\b(?:credential|token|api[-\s]?key|bearer|password|secret)\b\s*(?:is|=|:)\s*\S+/i,
      /מה\s+(?:ה)?(?:סיסמה|טוקן|אסימון|סוד)/u,
    ],
  },
  {
    category: "security-control-evasion",
    patterns: [
      /\b(?:disable|turn off|remove|bypass|ignore|evade|weaken|relax|skip)\b[^\n]{0,100}\b(?:sandbox|audit|approval|safety|security|guardrail|policy|auth(?:entication|orization)?|limits?|checks?)\b/i,
      /\b(?:sandbox|audit|approval|safety|security|guardrail|policy|auth(?:entication|orization)?)\b[^\n]{0,80}\b(?:off|disabled|removed|bypassed|ignored|weakened|relaxed)\b/i,
      /\b(?:without|no longer need|do not need|don't need|dont need)\b[^\n]{0,60}\b(?:approvals?|authorization|sandbox|audit|security checks?|permission)\b/i,
      /\b(?:stop asking|do not ask|don't ask|dont ask)\b[^\n]{0,60}\b(?:approvals?|authorization|permission)\b/i,
      /\badd\b[^\n]{0,60}\b(?:command|binary|executable)\b[^\n]{0,60}\b(?:allowlist|allowed to run|permitted)\b/i,
      /\badd\b[^\n]{0,80}\bto what (?:you|you're|you are) (?:are )?(?:allowed|permitted) to run\b/i,
      /\bbrowse\b[^\n]{0,40}\bwithout\b[^\n]{0,40}\b(?:checking|approval|asking)\b/i,
      /(?:בלי|ללא|לעקוף)\s+אישור(?:ים)?/u,
    ],
  },
  {
    category: "privilege-escalation",
    patterns: [
      /\b(?:give|grant)\s+yourself\b[^\n]{0,60}\b(?:more access|permission|privilege|admin)/i,
      /\b(?:make|promote)\b[^\n]{0,60}\b(?:yourself|me|user|account)\b[^\n]{0,40}\badmin\b/i,
      /\bmake\b[^\n]{0,80}\ban?\s+admin\b/i,
      /\badd\b[^\n]{0,80}\b(?:allowlist|who can message|trusted senders?)\b/i,
      /\b(?:highest autonomy|self[-\s]?escalat\w*|privilege escalat\w*)\b/i,
      /(?:אתה\s+admin|הרשאת\s+מנהל)/u,
    ],
  },
  {
    category: "internal-network-probing",
    patterns: [
      /\b169\.254\.169\.254\b/,
      /\bmetadata\.google\.internal\b/i,
      /https?:\/\/(?:localhost|0(?:\.0){3}|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?![\w.-])/i,
      /https?:\/\/\[(?:::1|0{1,4}(?::0{1,4}){6}:0{0,3}1)\](?::\d{1,5})?/i,
      /\b(?:cloud metadata|instance metadata|metadata service)\b/i,
    ],
  },
  {
    category: "prompt-injection",
    patterns: [
      /\bignore\b[^\n]{0,80}\b(?:previous|prior|system|operator)\b[^\n]{0,50}\b(?:instruction|policy|rule)/i,
      /\b(?:override|replace)\b[^\n]{0,80}\b(?:operator|system)\b[^\n]{0,50}\b(?:policy|instruction|rule)/i,
      /(?:התעלם|תתעלם)[^\n]{0,80}(?:הוראות|כללים)/u,
      /(?:מערכת|system)[^\n]{0,50}(?:המנהל אישר|admin approved)/iu,
    ],
  },
  {
    category: "destructive-system-action",
    patterns: [
      /\b(?:delete|remove|wipe|erase|destroy)\b[^\n]{0,100}\b(?:files?|director(?:y|ies)|folders?|repositor(?:y|ies)|repo|databases?|data|logs?|workspace|disk|system)\b/i,
      /\b(?:rm\s+-rf|drop\s+(?:table|database)|truncate\s+table|format\s+(?:the\s+)?disk)\b/i,
    ],
  },
];

// The bounded `[^\n]{0,N}` distances keep a pattern from spanning two unrelated
// candidate texts, so "\n" stays the inter-text separator while every run of
// whitespace *inside* one text collapses to a single space. Without this, a
// risky phrase wrapped across a line break — the normal shape of a file-borne
// or heredoc prompt — matches nothing. Only the matching copy is normalized;
// callers keep their raw text, which is never echoed.
export function classifyLiveProviderCyberRisk(texts) {
  const candidates = Array.isArray(texts) ? texts : [texts];
  const joined = candidates
    .filter((text) => typeof text === "string" && text.length > 0)
    .map((text) => text.replace(/\s+/gu, " "))
    .join("\n");
  if (joined.length === 0) return [];

  return RISK_PATTERNS
    .filter(({ patterns }) => patterns.some((pattern) => pattern.test(joined)))
    .map(({ category }) => category);
}

export function isGatedRpcMethod(method) {
  return !UNGATED_RPC_METHOD_SET.has(method);
}

// Any string anywhere in a resolved params object can become a model prompt
// (`graph.execute` node tasks, `message.send` text, cron payloads), and inline
// JSON, key+val, and --file mode all converge on the same object. Collect every
// string rather than named keys so a new prompt-bearing field is classified too.
export function collectRpcRiskTexts(params) {
  const texts = [];
  const visit = (value, depth) => {
    if (texts.length >= RPC_TEXT_MAX_NODES || depth > RPC_TEXT_MAX_DEPTH) return;
    if (typeof value === "string") {
      if (value.length > 0) texts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  visit(params, 0);
  return texts;
}

export function liveProviderRiskDecision({
  texts = [],
  declaredRisk,
  authorization,
} = {}) {
  const reasons = [];
  const riskDeclared = declaredRisk === "cyber-abuse";
  if (riskDeclared) reasons.push("declared-cyber-abuse");
  reasons.push(...classifyLiveProviderCyberRisk(texts));

  const requiresAuthorization = reasons.length > 0;
  const authorized = riskDeclared && authorization === CYBER_ABUSE_AUTH_VALUE;
  return {
    allowed: !requiresAuthorization || authorized,
    authorized,
    reasons,
    requiresAuthorization,
  };
}

export function liveProviderRiskError({
  source,
  texts = [],
  declaredRisk,
  env = process.env,
} = {}) {
  const decision = liveProviderRiskDecision({
    texts,
    declaredRisk: declaredRisk ?? env[LIVE_TEST_RISK_ENV],
    authorization: env[CYBER_ABUSE_AUTH_ENV],
  });
  if (decision.allowed) return undefined;

  const label = typeof source === "string" && source.length > 0
    ? source
    : "live provider injector";
  return `${label}: suspended provider-backed test (${decision.reasons.join(", ")}). `
    + `Only the operator may authorize this test. If the operator explicitly requested it, `
    + `declare ${LIVE_TEST_RISK_ENV}=cyber-abuse and set `
    + `${CYBER_ABUSE_AUTH_ENV}=${CYBER_ABUSE_AUTH_VALUE}.`;
}

function parseCliArgs(argv) {
  const options = { texts: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv.at(index);
    if (argument === "--source") options.source = argv.at(++index);
    else if (argument === "--declared-risk") options.declaredRisk = argv.at(++index);
    else if (argument === "--text") options.texts.push(argv.at(++index) ?? "");
    else {
      console.error(`live-provider-risk-gate.mjs: unknown argument ${argument}`);
      process.exit(2);
    }
  }
  return options;
}

// Node resolves symlinks for `import.meta.url` but not for argv[1], so a plain
// comparison would skip the CLI block when this module is invoked through a
// symlinked path and exit 0 — which `|| exit $?` callers would read as
// authorization. Realpath both sides; fall back to the literal comparison when
// the path cannot be resolved, so the gate still runs.
function isDirectCliInvocation(entry) {
  if (!entry) return false;
  const modulePath = fileURLToPath(import.meta.url);
  const entryPath = resolve(entry);
  if (entryPath === modulePath) return true;
  try {
    return realpathSync(entryPath) === realpathSync(modulePath);
  } catch {
    return false;
  }
}

if (isDirectCliInvocation(process.argv[1])) {
  const error = liveProviderRiskError(parseCliArgs(process.argv.slice(2)));
  if (error) {
    console.error(error);
    process.exit(4);
  }
}
