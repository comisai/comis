// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import type {
  ManagedAttentionReplyBindingOutcome,
  ManagedAttentionReplyInput,
  ManagedAttentionReplyPort,
  ManagedRunAttentionRecord,
  ManagedRunContentPort,
  ManagedRunOwnerScope,
  ManagedRunStorePort,
} from "@comis/core";
import { err, fromPromise, ok, tryCatch, type Result } from "@comis/shared";

const externalRunTokenPattern = /(?<![A-Za-z0-9._~-])[A-Za-z0-9][A-Za-z0-9._~-]{0,255}(?![A-Za-z0-9._~-])/gu;

async function invoke<T>(operation: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> {
  const invoked = tryCatch(operation);
  if (!invoked.ok) return err(invoked.error);
  const settled = await fromPromise(invoked.value);
  return settled.ok ? settled.value : err(settled.error);
}

function responseRef(attentionId: string, operationId: string): string {
  const digest = createHash("sha256")
    .update(`${attentionId}\0${operationId}`, "utf8")
    .digest("hex")
    .slice(0, 48);
  return `attention-response-${digest}`;
}

function contentScope(attention: ManagedRunAttentionRecord) {
  return {
    tenantId: attention.tenantId,
    agentId: attention.agentId,
    managedRunId: attention.managedRunId,
  };
}

function referencedRunDigests(text: string): ReadonlySet<string> {
  const digests = new Set<string>();
  for (const token of text.match(externalRunTokenPattern) ?? []) {
    digests.add(createHash("sha256").update(token, "utf8").digest("hex"));
  }
  return digests;
}

/** Bind private reply content only after exact durable attention selection. */
export function createManagedAttentionReplyBinder(deps: {
  readonly store: ManagedRunStorePort;
  readonly contentStore: ManagedRunContentPort;
}): ManagedAttentionReplyPort {
  return Object.freeze({
    bind: async (
      scope: ManagedRunOwnerScope,
      input: ManagedAttentionReplyInput,
    ): Promise<Result<ManagedAttentionReplyBindingOutcome, Error>> => {
      const prior = await invoke(
        () => deps.store.getAttentionResponseByOperation(scope, input.operationId),
      );
      if (!prior.ok) return prior;
      let selected = prior.value;
      let candidateAttentionIds: string[] = [];
      if (selected !== undefined) {
        if (input.attentionId !== undefined && input.attentionId !== selected.attentionId) {
          return err(new Error("managed-run attention response replay conflicts with its original handle"));
        }
      } else {
        const listed = await invoke(() => deps.store.listOpenAttention(scope, { limit: 10_000 }));
        if (!listed.ok) return listed;
        const open = listed.value.filter((candidate) => candidate.status === "open");
        candidateAttentionIds = open.map((candidate) => candidate.attentionId).sort();
        if (input.attentionId !== undefined) {
          const exactAttentionId = input.attentionId;
          const exact = await invoke(() => deps.store.getAttention(scope, exactAttentionId));
          if (!exact.ok) return exact;
          if (exact.value === undefined) {
            return ok({ kind: "clarification_required", reason: "handle_not_found", candidateAttentionIds });
          }
          if (exact.value.status !== "open") {
            return ok({ kind: "clarification_required", reason: "already_answered", candidateAttentionIds });
          }
          selected = exact.value;
        } else if (open.length === 0) {
          return ok({ kind: "clarification_required", reason: "none_open", candidateAttentionIds });
        } else {
          const referencedDigests = referencedRunDigests(input.text);
          const scopedRuns = await invoke(() => deps.store.listScoped({ scope, limit: 10_000 }));
          if (!scopedRuns.ok) return scopedRuns;
          const referencedRunIds = new Set(scopedRuns.value
            .filter((run) => referencedDigests.has(run.externalRunRefDigest))
            .map((run) => run.managedRunId));
          if (referencedRunIds.size === 1) {
            const matching = open.filter((candidate) => referencedRunIds.has(candidate.managedRunId));
            if (matching.length === 0) return ok({ kind: "not_applicable" });
            if (matching.length === 1) selected = matching[0];
            else {
              return ok({
                kind: "clarification_required",
                reason: "ambiguous",
                candidateAttentionIds: matching.map((candidate) => candidate.attentionId).sort(),
              });
            }
          } else if (referencedRunIds.size > 1 || open.length !== 1) {
            return ok({ kind: "clarification_required", reason: "ambiguous", candidateAttentionIds });
          } else {
            selected = open[0];
          }
        }
      }
      if (selected === undefined) return err(new Error("managed-run attention selection failed closed"));

      const privateRef = responseRef(selected.attentionId, input.operationId);
      const scopeForContent = contentScope(selected);
      const published = await invoke(() => deps.contentStore.putAttentionBody(
        scopeForContent,
        privateRef,
        { body: new TextEncoder().encode(input.text) },
      ));
      if (!published.ok) return published;
      const claimed = await invoke(() => deps.store.claimAttentionResponse(scope, {
        operationId: input.operationId,
        attentionId: selected.attentionId,
        responseRef: published.value.contentRef,
        respondedAtMs: input.respondedAtMs,
      }));
      if (!claimed.ok) {
        await invoke(() => deps.contentStore.deleteAttentionBody(scopeForContent, privateRef));
        return claimed;
      }
      if (claimed.value.kind === "updated" || claimed.value.kind === "identical_replay") {
        return ok({ kind: "bound", attention: claimed.value.record });
      }
      const removed = await invoke(() => deps.contentStore.deleteAttentionBody(scopeForContent, privateRef));
      if (!removed.ok) return removed;
      if (claimed.value.kind === "state_mismatch") {
        return ok({ kind: "clarification_required", reason: "already_answered", candidateAttentionIds });
      }
      if (claimed.value.kind === "not_found" || claimed.value.kind === "scope_mismatch") {
        return ok({ kind: "clarification_required", reason: "handle_not_found", candidateAttentionIds });
      }
      return err(new Error("managed-run attention response replay conflicted"));
    },
  });
}
