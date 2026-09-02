# Claude-to-Codex branch-name fallback

## Goal

When the interactive branch-name flow automatically selects `claude -p` and
Claude cannot produce a usable suggestion, try `codex exec` with the same
prompt before asking the user to name the branch manually.

## Scope and behavior

- The automatic CLI order remains `claude -p`, `codex exec`, `opencode run`,
  then `gemini -p`.
- Automatic detection returns an ordered list of installed candidates instead
  of committing to the first installed command. A candidate is exhausted when
  it cannot start, exits unsuccessfully, or returns no parseable branch names.
- The next available candidate receives the original prompt, including the
  rejected-name context accumulated in the current naming round.
- Once a fallback CLI is selected, later description rounds use that CLI first;
  a failed CLI is not retried repeatedly in the same run.
- An explicit `--ai` or `GWQADD_AI` value remains a single, explicit command and
  does not acquire implicit fallback behavior. `--no-ai` remains unchanged.
- If every automatic candidate fails, the existing manual ASCII-name prompt and
  its error messaging remain the final fallback.
- `codex` is invoked as `codex exec <prompt>`, matching the installed CLI's
  documented non-interactive command.

## Implementation shape

Keep the existing `runAi()` and `askAi()` process boundaries. Add a small
ordered-candidate selector and a helper that asks the current candidate,
advances to the next available candidate on an execution or parse failure, and
returns both the response and selected CLI for the caller's status message.
Existing parsing, confirmation, branch validation, stdout/stderr discipline,
and non-interactive behavior remain unchanged.

## Error handling

The first failure is reported as a warning that a fallback is being tried. A
fallback failure is reported using the existing manual-name path. The original
CLI's stderr remains truncated to the existing diagnostic limit; no child
output is placed on stdout.

## Verification

Add an interactive PTY regression test with deterministic `claude` and `codex`
shims. The Claude shim must report a failed prompt invocation, the Codex shim
must return valid candidates, and the test must verify both invocations and the
created branch. Also retain the full existing suite and update the help/README
text to describe fallback on failure.
