// SPDX-License-Identifier: Apache-2.0
import type { Result } from "@comis/shared";
import type { PlatformPrincipalAssertion, PrincipalScope } from "../domain/conversation-scope.js";
import type { PrincipalResolutionError } from "../domain/principal-resolution-error.js";

export interface PrincipalResolverPort {
  resolve(
    tenantId: string,
    agentId: string,
    assertion: PlatformPrincipalAssertion,
  ): Result<PrincipalScope, PrincipalResolutionError>;
}
