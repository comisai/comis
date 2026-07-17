// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../..");

interface RawEmission {
  readonly method: "emit" | "emitSafely";
  readonly eventName?: string;
  readonly line: number;
}

const SAFE_ONLY_FILES = [
  "packages/core/src/approval/approval-gate.ts",
  "packages/core/src/delivery/delivery-service.ts",
  "packages/core/src/delivery/retry-engine.ts",
  "packages/agent/src/background/background-task-manager.ts",
  "packages/agent/src/background/completion-dispatcher.ts",
  "packages/agent/src/background/completion-runner.ts",
  "packages/agent/src/executor/prompt-runner/interactive-silent-recovery.ts",
  "packages/agent/src/executor/prompt-runner/retry-loop.ts",
  "packages/agent/src/executor/prompt-runner/silent-failure-handlers.ts",
  "packages/channels/src/shared/lifecycle-reactor.ts",
  "packages/orchestrator/src/inbound/inbound-gate.ts",
  "packages/orchestrator/src/queue/queue-observability.ts",
  "packages/orchestrator/src/source-message-terminal.ts",
  "packages/daemon/src/api/shared/emit-capability-audit.ts",
  "packages/daemon/src/wiring/setup-gateway/setup-gateway-admin.ts",
] as const;

const PROTECTED_EVENTS_BY_FILE = {
  "packages/agent/src/executor/pi-executor/pi-executor.ts": [
    "security:warn",
  ],
  "packages/daemon/src/api/rpc-dispatch.ts": [
    "execution:aborted",
    "autonomy:denial_breaker_tripped",
  ],
  "packages/daemon/src/wiring/setup-gateway-routes.ts": [
    "diagnostic:webhook_delivered",
  ],
} as const satisfies Record<string, readonly string[]>;

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression)
    || ts.isParenthesizedExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function eventNameFrom(expression: ts.Expression | undefined): string | undefined {
  if (expression === undefined) return undefined;
  const unwrapped = unwrapExpression(expression);
  return ts.isStringLiteralLike(unwrapped) ? unwrapped.text : undefined;
}

function collectRawEmissions(source: string, fileName: string): RawEmission[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const emissions: RawEmission[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === "emit" || method === "emitSafely") {
        emissions.push({
          method,
          eventName: eventNameFrom(node.arguments[0]),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return emissions;
}

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

describe("observational event emission boundary", () => {
  it("detects raw bus calls without classifying the safe helper as raw", () => {
    const emissions = collectRawEmissions(`
      bus.emit("first:event", {});
      bus.emitSafely("second:event" as EventName, {});
      emitObservationalEventSafely({ eventBus: bus }, "third:event", {});
    `, "fixture.ts");

    expect(emissions).toEqual([
      { method: "emit", eventName: "first:event", line: 2 },
      { method: "emitSafely", eventName: "second:event", line: 3 },
    ]);
  });

  it("keeps migrated observational publishers on the safe helper", () => {
    const violations = SAFE_ONLY_FILES.flatMap((relativePath) =>
      collectRawEmissions(readRepoFile(relativePath), relativePath).map((emission) => ({
        file: relativePath,
        ...emission,
      })),
    );

    for (const [relativePath, protectedEvents] of Object.entries(PROTECTED_EVENTS_BY_FILE)) {
      const protectedNames = new Set<string>(protectedEvents);
      for (const emission of collectRawEmissions(readRepoFile(relativePath), relativePath)) {
        if (emission.eventName !== undefined && protectedNames.has(emission.eventName)) {
          violations.push({ file: relativePath, ...emission });
        }
      }
    }

    expect(
      violations,
      "Outcome-adjacent events must use emitObservationalEventSafely so subscriber and logger failures cannot alter publisher control flow.",
    ).toEqual([]);
  });

  it("retains imperative scheduler wake commands as direct emissions", () => {
    const relativePath = "packages/daemon/src/wiring/setup-gateway-routes.ts";
    const emissions = collectRawEmissions(readRepoFile(relativePath), relativePath);

    expect(emissions).toContainEqual(expect.objectContaining({
      method: "emit",
      eventName: "scheduler:wake",
    }));
  });
});
