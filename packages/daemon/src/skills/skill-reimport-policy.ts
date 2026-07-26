// SPDX-License-Identifier: Apache-2.0
/** Verify a live incumbent and decide whether a skill re-import may proceed. */

import { safePath, type ComisLogger, type TypedEventBus } from "@comis/core";
import {
  decideSkillReimport,
  vetSkillBundle,
  type VetSkillBundleResult,
} from "@comis/skills";
import { err, ok, type Result } from "@comis/shared";
import { existsSync } from "node:fs";
import { recordSkillImportRejection, type SkillImportFailure } from "./skill-import-observability.js";
import { collectSkillBundleFiles } from "./skill-provenance-backfill.js";
import {
  provenanceKey,
  readSkillProvenance,
  type SkillProvenanceRecord,
  type SkillProvenanceScope,
} from "./skill-provenance-store.js";

export interface SkillReimportCheckInput {
  readonly dataDir: string;
  readonly skillDir: string;
  readonly scope: SkillProvenanceScope;
  readonly skillName: string;
  readonly source: SkillImportFailure["source"];
  readonly candidate: VetSkillBundleResult;
  readonly confirmed: boolean;
  readonly eventBus?: TypedEventBus;
  readonly logger: ComisLogger;
}

export type SkillReimportOutcome =
  | { readonly kind: "install" }
  | { readonly kind: "unchanged"; readonly incumbent: SkillProvenanceRecord };

function emitRejection(
  input: SkillReimportCheckInput,
  code: string,
): void {
  recordSkillImportRejection({
    eventBus: input.eventBus,
    skillName: input.skillName,
    source: input.source,
    stage: "vet",
    code,
  });
}

/** Return the collision-policy outcome without writing candidate bytes. */
export function checkSkillReimport(
  input: SkillReimportCheckInput,
): Result<SkillReimportOutcome, Error> {
  if (!existsSync(input.skillDir)) return ok({ kind: "install" });

  const incumbent = readSkillProvenance(input.dataDir)[
    provenanceKey(input.scope, input.skillName)
  ];
  if (incumbent === undefined) {
    input.logger.warn(
      {
        method: "skills.import",
        skillName: input.skillName,
        hint:
          "The destination is untracked. Review and explicitly delete it before importing the same name.",
        errorKind: "precondition" as const,
      },
      "Skill re-import found an untracked incumbent",
    );
    emitRejection(input, "skill_reimport_untracked");
    return err(
      new Error(
        `[skill_reimport_untracked] Skill directory ${input.skillName} already exists without durable provenance; ` +
          "refusing to overwrite unknown bytes",
      ),
    );
  }

  const liveFiles = collectSkillBundleFiles(
    input.skillDir,
    safePath(input.skillDir, "SKILL.md"),
  );
  if (!liveFiles.ok) {
    input.logger.warn(
      {
        method: "skills.import",
        skillName: input.skillName,
        err: liveFiles.error.message,
        hint:
          "The incumbent could not be hashed. Check skill-directory permissions and member types before retrying.",
        errorKind: "resource" as const,
      },
      "Skill re-import could not verify incumbent bytes",
    );
    emitRejection(input, "skill_reimport_unreadable");
    return err(
      new Error(
        `[skill_reimport_unreadable] Could not verify live skill ${input.skillName}: ${liveFiles.error.message}`,
      ),
    );
  }

  const liveHash = vetSkillBundle({
    files: liveFiles.value,
    trust: incumbent.trust,
  }).contentHash;
  if (liveHash !== incumbent.contentHash) {
    input.logger.warn(
      {
        method: "skills.import",
        skillName: input.skillName,
        incumbentTrust: incumbent.trust,
        hint:
          "The live directory changed after provenance was recorded. Review the local changes and remove or restore the incumbent before retrying.",
        errorKind: "precondition" as const,
      },
      "Skill re-import detected incumbent tampering",
    );
    emitRejection(input, "skill_reimport_tampered");
    return err(
      new Error(
        `[skill_reimport_tampered] Live bytes for ${input.skillName} differ from installed-skills.json; ` +
          "refusing to overwrite until the incumbent is reviewed",
      ),
    );
  }

  const decision = decideSkillReimport({
    incumbentHash: incumbent.contentHash,
    incumbentTrust: incumbent.trust,
    candidateHash: input.candidate.contentHash,
    candidateTrust: input.candidate.trust,
    confirmed: input.confirmed,
  });
  if (decision === "no_op") return ok({ kind: "unchanged", incumbent });

  if (decision === "refuse") {
    input.logger.warn(
      {
        method: "skills.import",
        skillName: input.skillName,
        incumbentTrust: incumbent.trust,
        candidateTrust: input.candidate.trust,
        hint:
          "A lower-trust source cannot replace this skill. Remove the incumbent explicitly only after reviewing its provenance.",
        errorKind: "precondition" as const,
      },
      "Skill re-import refused by trust policy",
    );
    emitRejection(input, "skill_reimport_trust_refused");
    return err(
      new Error(
        `[skill_reimport_refused] incumbent=${incumbent.trust} candidate=${input.candidate.trust}`,
      ),
    );
  }

  if (decision === "confirm") {
    const candidateCritical = input.candidate.findings.filter(
      (finding) => finding.severity === "CRITICAL",
    ).length;
    input.logger.warn(
      {
        method: "skills.import",
        skillName: input.skillName,
        incumbentTrust: incumbent.trust,
        candidateTrust: input.candidate.trust,
        findingCounts: {
          critical: candidateCritical,
          warn: input.candidate.findings.length - candidateCritical,
        },
        hint:
          "Review the counts-only re-import difference, then repeat the same call with force: true to replace the incumbent.",
        errorKind: "precondition" as const,
      },
      "Skill re-import requires confirmation",
    );
    emitRejection(input, "skill_reimport_confirmation_required");
    return err(
      new Error(
        `[skill_reimport_confirm] Different bytes require force: true; findingCounts ` +
          `incumbent={critical:${incumbent.findingCounts.critical},warn:${incumbent.findingCounts.warn}} ` +
          `candidate={critical:${candidateCritical},warn:${input.candidate.findings.length - candidateCritical}}`,
      ),
    );
  }

  return ok({ kind: "install" });
}
