# Chinese period completion implementation notes

## Status

- Regression tests. Done. `test/editor-handoff.test.ts` adds six cases. `/tmp/pi-chinese-period-red.log` proves three target failures before the fix. Test-first commit `0360ae6` preserves red history.
- Eligibility fix. Done. `extensions/editor.ts` uses `getInlineSlashPrefix(beforeCursor) !== null` in automatic and Tab predicates. Full tests and typecheck pass.
- Verification and delivery. Done. `/tmp/pi-chinese-period-green.log`, `/tmp/pi-chinese-period-typecheck.log`, and fresh Pi 1.3 captures prove the bounded acceptance criteria. Diff self-review completed. Commit and pause writes are the final handoff actions.

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

## Verification outcomes

- Red run used `node --import tsx --test test/editor-handoff.test.ts`. 21 tests, 18 passed, 3 failed. Exact screenshot text plus `。` failed with `true !== false` for the menu. Native absolute path Tab left `/nes` unchanged. An active inline menu transitioning into a path incorrectly reopened a menu.
- Green run used `npm test`. 73 tests, 59 passed, 0 failed, 14 skipped. The skips are existing real-host skill-card tests requiring Pi 1.1.0 or 1.2.0 through `PI_PACKAGE_DIR`, not completion regressions. All 21 editor tests pass. `npm run typecheck` exits 0.
- Fresh installed Pi 1.3 TUI with original extension reproduces the screenshot popup. Worktree extension has no popup for exact screenshot text with `。` or `.`, and no-path Chinese controls with either punctuation. Native Tab visibly changes `/tmp/pi-chinese-period-runtime/native/nes` to `/tmp/pi-chinese-period-runtime/native/nested.txt`.
- Positive fixture controls visibly change `foo /periodpr` to `foo /periodprobe` and `foo /skill:periodpr` to `foo /skill:periodprobe` after Tab. Before captures contain the selected fixture menu. Evidence is `/tmp/pi-chinese-period-fixed-inline-{command,skill}-{after,tab}.txt` and `/tmp/pi-chinese-period-fixed-inline-results.json`.
- Reproduction script is `/tmp/pi-chinese-period-fixed-runtime.mjs`. Each case launches a fresh process with `--offline --no-session --no-extensions` and an explicit single extension. Only local fixture skill and prompt are enabled for the positive controls. No Enter, model inference, or external publish occurs.
- Local `node_modules` is a temporary symlink to original dependencies and is excluded from commits. No package or provider file changed. Production diff removes redundant editor predicates without adding functions, helpers, or types.

## Deviations

- Initial `/mod` runtime control had no eligible candidate in the isolated configuration. Replaced it with explicit local fixtures. Initial menu detector recognized only directory arrows and missed visible slash menus. Corrected it to recognize the selected menu arrow. JSON expected text is now distinct from observed editor text. Partial fixture prefixes prove actual Tab acceptance. The earlier failed probe is not counted as a pass.
- Terminal capture strips trailing spaces, so runtime assertions establish visible text and menu behavior. Unit tests establish exact trailing spaces and cursor positions. IME keystroke encoding is not simulated.

- No nested how/why exploration because parent owns orchestration and forbids nested agents. Confirmed parent diagnosis bounds investigation.
