# Claude-to-Codex Naming Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the interactive automatic naming flow try `codex exec` when `claude -p` cannot return a usable branch name.

**Architecture:** Keep the existing process runner and branch-name parser. Change automatic AI detection to retain the ordered installed candidates, then advance through that list when a candidate cannot start, exits unsuccessfully, or returns no valid candidates. Explicit `--ai` / `GWQADD_AI` remains a single command with the current manual fallback behavior.

**Tech Stack:** Node.js >= 20.12.0 ESM, `node:test`, real Git fixtures, shell shims, and the existing optional `expect` PTY tests.

## Global Constraints

- Preserve zero runtime dependencies and the existing Node.js engine floor.
- Preserve stdout/stderr discipline: AI diagnostics and fallback warnings go to stderr; stdout remains the path/JSON channel.
- Preserve non-interactive behavior: no AI process runs unless an explicit `--random` path is requested; a positional branch name never reaches AI.
- Invoke Codex as `codex exec --skip-git-repo-check <prompt>`, as confirmed by
  `codex exec --help`; the flag is required for the intentionally empty AI cwd.
- Do not add implicit fallback to an explicit `--ai` or `GWQADD_AI` command.
- Keep the automatic order `claude -p`, `codex exec --skip-git-repo-check`,
  `opencode run`, `gemini -p`.
- Run the complete `npm test` suite before claiming completion or creating the PR.

---

### Task 1: Regression test for Claude failure fallback

**Files:**
- Modify: `test/cli.test.mjs` — extend the PTY helper and add the fallback test beside the existing naming-flow tests.

**Interfaces:**
- Consumes: the existing `runInteractiveExpect()` helper, Git fixture, and `gwq` shim.
- Produces: a deterministic test proving automatic Claude failure invokes Codex and that Codex's valid name is used to create a branch.

- [ ] **Step 1: Add deterministic Claude/Codex shims and make the PTY helper accept an environment override**

Add `fallbackAis()` after `canaryAi()`. It creates executable `claude` and `codex` scripts in a temporary directory. Each script exits successfully for `--version`; Claude records prompt calls, prints an error, and exits 1; Codex records prompt calls and prints three valid branch names.

Change the helper signature to `runInteractiveExpect(lines, ai, args = [], extraEnv = {})`. Set `GWQADD_AI` only when `ai` is non-null, delete it otherwise, and apply `Object.assign(env, extraEnv)` before spawning `expect`. This lets the new test exercise automatic detection rather than an explicit override.

- [ ] **Step 2: Add the failing PTY regression**

Add `test('a failed automatically detected Claude falls back to Codex', ...)` after the existing rolled-name AI test. The test must:

- use `fallbackAis()` and put its directory first in `PATH`;
- enter a description, wait for the confirmation prompt, accept it, and wait for EOF;
- assert exit status 0;
- assert both the Claude and Codex markers exist;
- assert the Codex-provided branch `feat/codex-fallback` exists in the fixture repository.

- [ ] **Step 3: Run the focused test and verify it fails for the missing fallback**

Run:

    node --test --test-name-pattern='failed automatically detected Claude' test/cli.test.mjs

Expected: FAIL because the current implementation reports `claude failed` and opens the manual branch-name prompt; the Codex marker is absent and no successful fallback branch is created.

- [ ] **Step 4: Commit the red regression test**

    git add test/cli.test.mjs
    git commit -m "test: cover Claude to Codex naming fallback"

### Task 2: Implement ordered automatic fallback and update documentation

**Files:**
- Modify: `bin/gwqadd.mjs` — AI detection, naming loop, and help text.
- Modify: `README.md` — describe failure fallback and explicit override behavior.

**Interfaces:**
- Consumes: `AI_CLIS`, `commandExists()`, `askAi()`, `parseCandidates()`, and the existing manual fallback.
- Produces: automatic candidate selection and fallback without changing public CLI flags or the JSON schema.

- [ ] **Step 1: Represent automatic and explicit AI selections separately**

Keep the existing `AI_CLIS` order. Change `detectAi()` so it returns `null` for `--no-ai`/off, `{ candidates: [{ bin, args }], automatic: false }` for an explicit `--ai` or `GWQADD_AI` value, and `{ candidates: AI_CLIS.filter((c) => commandExists(c.bin)), automatic: true }` for automatic detection.

The explicit branch must keep the current whitespace split and must never add an implicit Codex candidate. An automatic selection must preserve the existing Claude, Codex, opencode, and gemini order while filtering out commands that are not installed.

- [ ] **Step 2: Advance to the next automatic CLI on process or parse failure**

In `composeBranchName()`, replace the single detected `ai` with `selection` and an `aiIndex` initialized to zero. If there are no candidates, return the existing manual prompt. For each description, call `askAi(selection.candidates[aiIndex], namingPrompt(...))`.

Treat either `res.ok === false` or an empty result from `parseCandidates(res.out)` as failure. When `selection.automatic` is true and another candidate exists, warn with the failed CLI and next CLI labels, log the first stderr diagnostic line using the existing 120-character limit, increment `aiIndex`, and retry the same description with the next candidate. When no candidate remains, preserve the current manual-name fallback and `named: 'manual'` result.

Keep `aiIndex` unchanged after a successful response so a rejected suggestion is retried by the selected CLI; after fallback, later description rounds start with the fallback CLI. Preserve the existing confirmation, edit, rejected-candidate list, branch validation, and `named: 'ai'` behavior.

- [ ] **Step 3: Update help and README wording**

In the `NAMING HELP` text in `bin/gwqadd.mjs`, state that automatic detection tries `claude -p` first and tries `codex exec --skip-git-repo-check` when Claude fails or returns no usable name, followed by the existing opencode and gemini candidates. State that `--ai` and `GWQADD_AI` explicitly select one command and therefore do not activate implicit fallback.

Update the corresponding AI paragraph in `README.md` with the same behavior and the exact `codex exec` invocation.

- [ ] **Step 4: Run the focused regression and the complete suite**

Run:

    node --test --test-name-pattern='failed automatically detected Claude' test/cli.test.mjs
    npm test

Expected: the focused test passes with both shim markers present, and the full suite reports zero failures. Existing optional fish/expect skips are acceptable when those tools are unavailable.

- [ ] **Step 5: Review the diff and commit the implementation**

Run `git diff --check` and `git diff --stat`, then commit:

    git add bin/gwqadd.mjs README.md
    git commit -m "feat: fall back to Codex when Claude naming fails"

### Task 3: PR verification and handoff

**Files:**
- No source changes; verify the branch and remote PR artifacts.

- [ ] **Step 1: Verify the complete branch state**

Run `git status --short --branch`, `git log --oneline --decorate -5`, and `npm test`. Confirm only the intended commits/files are present and the test suite is green.

- [ ] **Step 2: Push the current branch**

Run `git push -u origin HEAD` and retain the resulting branch name for the PR.

- [ ] **Step 3: Create the PR with a body file**

Write a Markdown body to `/tmp/pr-bodies/educated-printing-license.md` and create the PR with `gh pr create --base main --head educated-printing-license --title 'feat: fall back to Codex when Claude naming fails' --body-file /tmp/pr-bodies/educated-printing-license.md`. Use `--body-file` because the body is multi-line and contains Markdown.

- [ ] **Step 4: Verify the PR body and open it in Chrome**

Run `gh pr view --json url,title,body,headRefName,baseRefName` and confirm the body retains its headings and line breaks. Navigate the authenticated Chrome tab to the returned PR URL and verify the PR page is visible.
