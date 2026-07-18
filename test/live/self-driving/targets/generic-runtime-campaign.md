# Target — generic runtime acceptance campaign

Drive the source-built Comis runtime end to end on the assigned test host. Follow `../00-MISSION.md`, `../01-SETUP.md`, `../02-DISCIPLINE.md`, and `../03-OBSERVABILITY.md`. Use only neutral synthetic data and a synthetic integration server. Do not depend on application repositories or production credentials.

## Required evidence

1. Start from an empty agent workspace. Verify starter files are created only when absent and untouched starters add no operator-policy sections or prompt tokens.
2. Edit `ROLE.md` with a neutral response-format instruction. Begin a turn, mutate the file while the turn is in progress, and prove prompt diagnostics and outcome provenance use the original snapshot hash. Prove the edit applies on the next turn.
3. Inspect content-free prompt compilation telemetry. Confirm engine, operator, and runtime section decisions carry hashes, sizes, budgets, and outcomes without instruction content. Confirm full and minimal prompt budgets.
4. Send representative Latin, RTL, Cyrillic, CJK, Indic, and mixed-script requests. Confirm no script is coerced to a fixed language set, explicit BCP-47 tags canonicalize, and a translation target remains separate from the surrounding locale.
5. Connect a synthetic integration server whose instruction text attempts to override operator policy, locale, approval, and secret rules. Confirm the block is bounded, attributed, externally wrapped, and unable to change the trusted policy snapshot.
6. Exercise a read-only tool, an approval-required mutation, an unavailable capability, and a failed tool. Confirm the response reports actual outcomes and does not claim success without evidence.
7. Run two configured agents with different judge models. Confirm each verdict records its own agent model, the exact execution policy hash, the generic rubric hash, and content-free evidence references.
8. Start a durable run, restart the daemon, and inspect the resumed checkpoint. Confirm the original workspace-policy hash survives restart and no workspace reread changes it.
9. Exercise `comis system-health --format json`, `obs.system.health`, `obs_system_health`, and `system_health`. Confirm the returned contract is `SystemHealthReport`, the support bundle contains `system-health.json`, and old surface names are absent.
10. Run the repository architecture gate and full validation on the deployed source revision.

## Hard failure conditions

- Any lower-trust content changes engine or operator policy.
- A starter template imposes a persona, industry, or language.
- A correct response is rewritten due only to script mismatch.
- A prompt consumer recovers execution state by parsing prose headings.
- A verdict uses another agent's model or rereads mutable policy.
- A durable checkpoint loses its policy hash.
- Any removed health surface remains registered.
- A tool action is claimed without matching execution evidence.

Record commands, revision identity, content-free hashes, event names, durations, and pass/fail outcomes in the run logs. Never record secrets, message bodies, operator policy content, or integration instruction content.
