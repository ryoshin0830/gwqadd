# Branch Name Retry Freeze Fix Design

## Problem

The interactive naming flow freezes after the user rejects an AI suggestion
with `n` or chooses `e` to edit it. The next line prompt renders, but ordinary
input, Enter, and Ctrl-C are no longer processed.

The failure is deterministic. `askLine()` creates and closes a Node readline
interface, after which readline leaves its internal `data` decoder listener on
`process.stdin` for reuse. `waitForKey()` then calls
`removeAllListeners('data')` and `removeAllListeners('keypress')`, deleting
readline-owned state along with any listener owned by gwqadd. When the next
readline interface opens, it installs a `keypress` listener but does not restore
the missing `data` decoder, so no bytes reach the prompt.

This explains both affected paths:

- `n` returns from `confirmCreate()` to the description `askLine()`.
- `e` returns from `confirmCreate()` to the pre-filled branch-name `askLine()`.

It also explains why Ctrl-C cannot recover the process: the byte never reaches
readline and therefore cannot become a SIGINT event.

## Selected Approach

Keep the existing raw-key/readline architecture and make `waitForKey()` manage
only the listener it owns. Remove the blanket `removeAllListeners()` calls.
The function already removes its own `data` handler immediately after receiving
a key, so no additional cleanup mechanism is required.

Once input delivery is restored, Node readline reports Ctrl-C by rejecting the
pending `question()` with `ABORT_ERR`. `askLine()` will translate that rejection
to gwqadd's existing `E_INTERRUPTED` path so the documented exit status remains
130 instead of falling through to the generic uncaught-exception handler.

This is preferred over keeping one readline interface alive for the whole flow,
which would require a broader interaction refactor, and over adding a prompt
library, which would violate the zero-runtime-dependency invariant.

## Behavior

The user-visible flow remains unchanged:

- `Y`, Enter, or Return accepts the suggested branch name.
- `n` returns to the work-description prompt and excludes rejected candidates.
- `e` opens the ASCII branch-name prompt pre-filled with the suggestion.
- Ctrl-C exits instead of leaving an unresponsive process.

The fix must not alter stdout/stderr separation, branch-name validation, AI
selection, branch creation, or worktree creation.

## Testing

Add an integration regression test that runs the real CLI under an `expect`
pseudo-terminal when `expect` is available. The test uses the existing real-git
sandbox and gwq shim plus a deterministic AI shim.

The test drives the transitions that previously froze:

1. Enter a work description and receive a deterministic suggestion.
2. Press `n`, enter a second description, and confirm that the description
   prompt accepts input again.
3. Press `e`, edit the pre-filled suggestion, submit it, and confirm that the
   CLI completes with the edited branch name.

A second PTY scenario sends Ctrl-C from the line prompt reached after a
confirmation choice and verifies exit status 130. On systems without `expect`,
these PTY-specific tests are skipped; all existing hermetic non-TTY tests still
run everywhere.

The TDD sequence is:

1. Add the PTY regression and verify it times out or otherwise fails on the
   current implementation.
2. Remove the two blanket listener-removal calls.
3. Verify the regression passes.
4. Run the complete `npm test` suite.
5. Manually drive the real interactive CLI once in a PTY as an end-to-end check.

## Scope

Only `bin/gwqadd.mjs` and `test/cli.test.mjs` will change for the bug fix. No
dependencies, flags, output schemas, help text, or unrelated refactors are part
of this work.
