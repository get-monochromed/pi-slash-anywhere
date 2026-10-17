# Chinese period completion implementation notes

## Status

- Regression tests. In progress. Add actual editor input and native path Tab assertions, then save `/tmp/pi-chinese-period-red.log` before implementation.
- Eligibility fix. Not started. Reuse `getInlineSlashPrefix` in the two editor predicates without new boundaries or provider changes.
- Verification and delivery. Not started. Run all tests and typecheck, fresh installed Pi offline TUI, review diff, commit, and pause writes.

## Scope and throughput checkpoint

One bounded worker unit, no nested agents. Parent supplied confirmed mechanism and fresh-process evidence in `/tmp/pi-chinese-period-repro-report.md`. Test, fix, and runtime verification are sequential dependencies. Keep exploration to editor/provider, existing tests, CONTEXT, and ADRs within the 20% context budget. No Pi core changes, new helper/types, provider punctuation changes, external actions, push, or PR.

## Playbook

1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables), even when a debug or instrumentation protocol says to ask the user to reproduce.
2. Binary-search the cause.
3. Plan the fix.
4. Verify on the same surface.
5. Stage the commits so the failing repro lands before the fix in git history.
6. Run Opening a PR. Skip because parent explicitly prohibits push and PR.

## Decisions

- Existing `string | null` prefix is the eligibility model. Additional path separators and line-start commands return null. Reuse that result instead of maintaining editor-only regex decisions.
- ADR-0001 requires native path completion to remain usable. Assert accepted text and cursor, not only menu absence.
- Local dependencies are Pi 0.86.0. Runtime proof uses installed Pi 1.3.0 with only the worktree extension and fresh processes.
- Advisor plan review requested actual input events, native path acceptance, line-start delegation, and verification of the red failure cause.

## Deviations

- No nested how/why exploration because parent owns orchestration and forbids nested agents. Confirmed parent diagnosis bounds investigation.
