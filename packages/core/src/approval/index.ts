// SPDX-License-Identifier: Apache-2.0
export { createApprovalGate } from "./approval-gate.js";
export type { ApprovalGate, ApprovalGateDeps } from "./approval-gate.js";
export {
  MANAGED_APPROVAL_GRANT_TTL_MS,
  createManagedApprovalGrantRegistry,
} from "./managed-approval-grant.js";
export type {
  ManagedApprovalGrantBindingInput,
  ManagedApprovalGrantConsumeInput,
  ManagedApprovalGrantReceipt,
  ManagedApprovalGrantRegistry,
} from "./managed-approval-grant.js";
export type { SerializedApprovalRequest } from "../domain/approval-request.js";
export { SerializedApprovalRequestSchema } from "../domain/approval-request.js";
