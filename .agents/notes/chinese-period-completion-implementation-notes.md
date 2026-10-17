# Chinese punctuation autocomplete fix

## Status

- Eligibility. Done. Editor and provider reuse the same inline slash prefix decision. Paths with additional separators no longer initiate Inline Slash Completion.
- Request ownership. Done locally at `fe11045c73c88d67bdf91fe0a0158934bb2bff06`. Each queued options object has an immutable native or inline owner. Installed menus have independent list-identity provenance. Native scheduling remains unchanged.
- Tests. Passed on the implementation worktree. 99 tests, 85 passed, 14 existing host-card tests skipped, zero failures. Typecheck passed. Independent review found the completed forced-request leak, corrected in `35247737`; focused re-review found no further production blocker.
- Terminal verification. Eight installed Pi 1.3.0 controls pass with readiness polling and current-pane capture. The same-session native path completion followed by valid inline template completion also passes, recorded in `/tmp/pi-period-owned-continuity-results.json`. Main-directory tests independently report 85 passed, 14 skipped and typecheck success in `/tmp/pi-period-final-integrated-npm.log` and `/tmp/pi-period-final-integrated-tsc.log`. Acceptance is complete for the scoped bug; PR publication is next.

## Why the original trigger failed

The editor matched path tokens more broadly than the provider. Chinese punctuation was not whitespace for the plugin regex. The provider rejected the path and delegated a request that native Pi interpreted as an empty file prefix after the punctuation.

The first eligibility fix passed separate punctuation input but failed synchronous batches. Native startup awaits a preceding task before capturing text and cursor. A plugin request queued at an earlier slash could therefore capture the final sentence and open directory suggestions.

## Design decisions

Cursor eligibility, menu visibility and token changes do not establish request ownership. Prototypes using those signals broke native attachment takeover or forced-path cursor navigation. Those prototypes were discarded.

The final adapter captures native or inline ownership before queuing. Inline ownership includes the line and token start column. A WeakMap associates the exact cloned native options object with that owner. Native request execution and currentness checks remain intact. Applied menu list identity records UI ownership only after installation.

Pending work and installed UI are separate. Cleanup cancels only a still-live owned inline request, and clears only its installed menu. New native requests survive. Forced native pending work also prevents automatic inline requests from replacing it before a menu appears.

Completed forced requests that directly insert a single result must release pending ownership. Otherwise they block later automatic inline completion. Open forced menus retain their ownership until native cancellation changes the token.

## Verification evidence

- Initial and batch red evidence is preserved in the test-first commits and `/tmp/pi-period-batch-red.log`.
- The source implementation is `b29edc86`, completed-force cleanup is `35247737`, and corrected serial-queue late-result tests are `fe11045c`.
- `/tmp/pi-period-owned-ready-npm-test.log` reports 85 passed, 14 skipped, zero failed. `/tmp/pi-period-owned-ready-typecheck.log` records typecheck success.
- `/tmp/pi-period-owned-ready-results.json` records literal observed text for active-batch, active-chars, batch, chars, bracketed paste, native path Tab, inline template and inline skill. `/tmp/pi-period-owned-runtime.mjs` waits for the actual empty editor and fixture resources before typing.
- Independent reviewer `69930959` ran 12 focused tests and three cancellation probes with no new blocker. The earlier full review's two invalid double-resolve tests were replaced with real leave-and-return and queued-native ordering.

## Limits

The adapter uses private native editor methods. The relevant methods were inspected in local Pi 0.86 and installed Pi 1.3.0. Future native changes require compatibility validation. The full files were not byte-identical. The 14 skipped tests require separate real-host skill-card fixtures and do not exercise this completion path. Terminal tests do not emulate macOS IME composition. Captures trim trailing spaces; unit tests assert exact text and cursor positions.

## Delivery

The operator authorizes publication of a ready PR after validation. No merge is authorized. Original development commits and branch are preserved. Publication will use a separate bookmark. Temporary scripts and logs remain local; no dependencies or credentials belong in the PR.
