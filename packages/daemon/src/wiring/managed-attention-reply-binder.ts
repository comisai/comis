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
      const listed = await invoke(() => deps.store.listOpenAttention(scope, { limit: 10_000 }));
      if (!listed.ok) return listed;
      const open = listed.value.filter((candidate) => candidate.status === "open");
      const candidateAttentionIds = open.map((candidate) => candidate.attentionId).sort();
      let selected: ManagedRunAttentionRecord | undefined;
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
      } else if (open.length !== 1) {
        return ok({ kind: "clarification_required", reason: "ambiguous", candidateAttentionIds });
      } else {
        selected = open[0];
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
