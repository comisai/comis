#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CYBER_ABUSE_AUTH_ENV = "COMIS_LIVE_CYBER_ABUSE_TESTS";
export const CYBER_ABUSE_AUTH_VALUE = "operator-authorized";
export const LIVE_TEST_RISK_ENV = "COMIS_LIVE_TEST_RISK";

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
      /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?=[:/\s]|$)/i,
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

export function classifyLiveProviderCyberRisk(texts) {
  const candidates = Array.isArray(texts) ? texts : [texts];
  const joined = candidates
    .filter((text) => typeof text === "string" && text.length > 0)
    .join("\n");
  if (joined.length === 0) return [];

  return RISK_PATTERNS
    .filter(({ patterns }) => patterns.some((pattern) => pattern.test(joined)))
    .map(({ category }) => category);
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
    declaredRisk: declaredRisk ?? env.COMIS_LIVE_TEST_RISK,
    authorization: env.COMIS_LIVE_CYBER_ABUSE_TESTS,
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const error = liveProviderRiskError(parseCliArgs(process.argv.slice(2)));
  if (error) {
    console.error(error);
    process.exit(4);
  }
}
