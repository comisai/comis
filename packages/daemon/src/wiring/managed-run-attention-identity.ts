// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

/** Derive the durable attention handle shared by report ingestion and private response delivery. */
export function managedRunAttentionId(identity: {
  readonly serviceInstanceId: string;
  readonly managedRunId: string;
  readonly externalKey: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `${identity.serviceInstanceId}\0${identity.managedRunId}\0${identity.externalKey}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 48);
  return `attention-${digest}`;
}
