// SPDX-License-Identifier: Apache-2.0
import type { PrincipalResolverPort } from "@comis/core";

export function createFakePrincipalResolver(): PrincipalResolverPort {
  return {
    resolve(_tenantId, _agentId, assertion) {
      return {
        ok: true,
        value: { principalId: `platform_${assertion.platformSubjectId}` },
      };
    },
  };
}
