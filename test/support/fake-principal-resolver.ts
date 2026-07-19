// SPDX-License-Identifier: Apache-2.0
import { ok } from "@comis/shared";
import type { PrincipalResolverPort } from "@comis/core";

export function createFakePrincipalResolver(): PrincipalResolverPort {
  return {
    resolve(_tenantId, _agentId, assertion) {
      return ok({ principalId: `platform_${assertion.platformSubjectId}` });
    },
  };
}
