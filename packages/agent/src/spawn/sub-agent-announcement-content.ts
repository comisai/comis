// SPDX-License-Identifier: Apache-2.0
/** Completion-announcement text and expected-output validation. */

import { systemSleep } from "@comis/core";
import { stat } from "node:fs/promises";

export interface AbortClassification {
  category: "step_limit" | "budget" | "context_full" | "external_timeout" | "provider_degraded" | "unknown";
  hint: string;
  severity: "expected" | "actionable" | "investigate";
}

export interface ValidationResult {
  path: string;
  exists: boolean;
  size?: number;
}

export function buildAnnouncementMessage(params: {
  task: string;
  status: "completed" | "failed";
  response?: string;
  error?: string;
  runtimeMs: number;
  stepsExecuted?: number;
  tokensUsed: number;
  cost: number;
  finishReason?: string;
  sessionKey: string;
  validation?: ValidationResult[];
  abort?: AbortClassification;
  errorContext?: { errorType: string; retryable: boolean; failingTool?: string };
}): string {
  const finishReasonMap: Record<string, { label: string; verb: string }> = {
    max_steps: { label: "Halted (max steps reached)", verb: "halted (max steps reached)" },
    context_loop: { label: "Halted (context loop)", verb: "halted (context loop)" },
    context_exhausted: { label: "Halted (context exhausted)", verb: "halted (context exhausted)" },
    budget_exceeded: { label: "Halted (budget exceeded)", verb: "halted (budget exceeded)" },
    error: { label: "Halted (error)", verb: "halted (error)" },
  };
  const mapped = params.finishReason ? finishReasonMap[params.finishReason] : undefined;
  let terminalLabel = mapped?.label;
  let terminalVerb = mapped?.verb;
  if (params.finishReason === "error" && params.errorContext) {
    const retryHint = params.errorContext.retryable ? ", retryable" : "";
    const toolHint = params.errorContext.failingTool ? ` on ${params.errorContext.failingTool}` : "";
    terminalLabel = `Halted (${params.errorContext.errorType}${toolHint}${retryHint})`;
    terminalVerb = `halted (${params.errorContext.errorType.toLowerCase()})`;
  }

  let statusLabel: string;
  let announcementVerb: string;
  if (params.status === "failed") {
    statusLabel = terminalLabel ? `Failed — ${terminalLabel}` : "Failed";
    announcementVerb = terminalVerb ?? "failed";
  } else if (terminalLabel && terminalVerb) {
    statusLabel = terminalLabel;
    announcementVerb = terminalVerb;
  } else if (params.finishReason && params.finishReason !== "stop" && params.finishReason !== "end_turn") {
    statusLabel = `Completed (${params.finishReason})`;
    announcementVerb = "completed with warnings";
  } else {
    statusLabel = "Success";
    announcementVerb = "completed";
  }

  const resultText = params.status === "completed"
    ? (params.response ?? "No output")
    : `Error: ${params.error ?? "Unknown error"}`;
  let validationLine = "";
  if (params.validation && params.validation.length > 0) {
    const verified = params.validation.filter((result) => result.exists).length;
    validationLine = `Outputs: ${verified}/${params.validation.length} verified`;
    const missing = params.validation.filter((result) => !result.exists);
    if (missing.length > 0) validationLine += ` | Missing: ${missing.map((result) => result.path).join(", ")}`;
    validationLine += "\n";
  }
  const abortLine = params.abort
    ? `Abort: ${params.abort.category} | Hint: ${params.abort.hint}\n`
    : "";

  return (
    `[System Message]\n` +
    `A background task has ${announcementVerb}.\n\n` +
    `Task: ${params.task}\n` +
    `Status: ${statusLabel}\n` +
    `Result: ${resultText}\n\n` +
    `---\n` +
    `Runtime: ${(params.runtimeMs / 1000).toFixed(1)}s | ` +
    `Steps: ${params.stepsExecuted ?? 0} | ` +
    `Tokens: ${params.tokensUsed} | ` +
    `Cost: $${params.cost.toFixed(4)} | ` +
    `Session: ${params.sessionKey}\n` +
    validationLine + abortLine + `\n` +
    `Inform the user about this completed background task. ` +
    `Summarize the result in your own voice. ` +
    `If no user notification is needed, respond with NO_REPLY.`
  );
}

/** Strip the parent-rewrite instruction before direct channel delivery. */
export function stripAnnouncementInstruction(text: string): string {
  const marker = "Inform the user about this completed background task.";
  const index = text.lastIndexOf(marker);
  return index === -1 ? text : text.slice(0, index).trimEnd();
}

/** Validate expected output files with bounded retries for filesystem flush lag. */
export async function validateOutputs(paths: string[], retries = 3, delayMs = 200): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const filePath of paths) {
    let exists = false;
    let size: number | undefined;
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const fileStat = await stat(filePath);
        exists = true;
        size = fileStat.size;
        break;
      } catch {
        if (attempt < retries - 1) await systemSleep(delayMs);
      }
    }
    results.push({ path: filePath, exists, size });
  }
  return results;
}
