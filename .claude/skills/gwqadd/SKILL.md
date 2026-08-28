---
name: gwqadd
description: >
  Create a new branch and its git worktree inside the repository already on
  disk, and return the absolute path. Use when work should start on a new branch
  in the current repo without disturbing the checkout the user is in — not for
  cloning, and not for reaching a branch or worktree that already exists.
when_to_use: |
  Use when the user says one of (or equivalent intent):
    - "start a new branch for X / X のブランチ切って"
    - "make a worktree for this change so I keep the current one"
    - "work on this in a separate worktree"
    - "branch off main and start there"

  Do NOT use this skill when the user wants any of:
    - a repository that is not on disk yet (use `gwqpull`, or `ghq get`)
    - a branch or PR from a remote (use `gwqpull`)
    - an existing worktree (use `gwqcd`)
    - the main clone of a repo (use `ghqcd`)
    - a brand-new remote repository (use `ghnew`)
    - switching branches in place (that is `git switch`; gwqadd never touches
      the checkout the user is standing in)
    - deleting a branch or worktree (destructive — ask the user)
allowed-tools: Bash
---

# gwqadd — create a branch and its worktree here

`gwqadd` wraps `gwq add` plus branch creation and returns the new worktree path.
It never modifies the checkout the user is currently in.

## Prerequisites (verify before invoking)

1. `git --version`, `gwq --version`
2. `node --version` (must be `>= 20.12`)
3. The cwd is inside a git repository — otherwise gwqadd exits 2 (`E_NOT_REPO`).

`fzf` and `jq` are **not** required.

## Recommended call

Always pass `-n` and `--json`, and always pass `--from`.

```bash
gwqadd -n --json --from <base> <branch>
```

Or, pinned (`^0.3`, NOT `@latest`, so a future major bump does not silently
break the flow):

```bash
npx -y gwqadd@^0.3 -n --json --from <base> <branch>
```

`-n` matters: without it the tool prints a path meant for a shell function to
consume, and an agent harness generally cannot act on it. With `-n` the work
still happens and the path still comes back in the JSON.

## Always pass `--from` — this is the one that bites

The default base is the **HEAD of the current directory**, like
`git checkout -b`. An agent session frequently sits in some worktree it visited
earlier, so "create feat/x" can silently branch off an unrelated feature.

Decide the base explicitly:

```bash
# the repository's default branch, if that is what the user means
base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD | sed 's|^origin/||')
gwqadd -n --json --from "${base:-main}" feat/x
```

Read `base.ref` and `base.sha` back from the result and tell the user what the
branch was cut from.

## When the branch name is not the point

For an isolated worktree whose branch name nobody will read — a scratch
checkout, a parallel build, somewhere to try a risky change — do not invent a
name:

```bash
gwqadd --random -n --json --from <base>
```

This is the only naming path that works without a terminal. It runs no AI, asks
nothing, and returns a three-word name such as `plume-melting-bearskin` in the
usual JSON, with `"named":"random"` so you can tell it apart from a name you
chose. `--random` together with an explicit branch name is an error.

Use a real name when the branch will be pushed, reviewed or discussed.

## The interactive naming help is not for you

Run without a branch name, without `--random` and without a TTY, gwqadd exits 1
(`E_VALIDATION`) — it does **not** prompt, and it does **not** invoke an AI.
That is deliberate: the describe-and-confirm flow exists for a human at a
terminal.

So pass the branch name, or pass `--random`. Do not try to reach the naming flow
by allocating a pty, and do not set `GWQADD_AI` expecting it to fire — with a
name on the command line it never runs.

## A typo becomes a new branch

A branch name that exists nowhere is **created**. That is the point of the tool,
but it means a misspelling silently produces a new branch instead of an error.
When the user named an existing branch, check `created` in the result:
`branch+worktree` means you made something new. If they expected to reach an
existing branch, that is a signal you should have used `gwqcd` or `gwqpull`.

## Output (stdout, 1 line)

```json
{
  "schemaVersion": 1,
  "path":          "/Users/alice/worktrees/github.com/alice/api/feat-login",
  "branch":        "feat/login",
  "base":          { "ref": "main", "sha": "8f2c1a9…" },
  "repo":          { "root": "/Users/alice/ghq/github.com/alice/api", "name": "api" },
  "created":       "branch+worktree",
  "named":         "argument",
  "ignoredFiles":  { "copied": 6, "kept": 0, "skipped": 41932,
                     "failed": 0, "error": null },
  "cd":            false
}
```

- `path` — where the work should happen. Use `git -C "<path>" …`.
- `created` — `branch+worktree`, `worktree` (branch already existed) or `none`.
- `named` — how the name was chosen: `argument` (you passed it), `random`
  (`--random` generated it), or `ai` / `manual` from the interactive flow.
- `repo.root` — the main working tree; **not** where you should work.
- `ignoredFiles` — how many Git-ignored files (`.env`, credentials, local
  config) were copied in from `repo.root`, how many the worktree already had and
  kept, and how many were `skipped` for living in a dependency or build
  directory (`node_modules`, `.venv`, `dist`, … — `gwqadd --help` lists all 46).
  This happens by default; pass `--no-copy-ignored-files` to skip it. Nothing is
  ever overwritten. **The copy did its job iff `error` is null and `failed` is
  0** — it never affects `exitCode`, and in `--json` this is the only place its
  trouble is reported, so check it rather than the exit code or stderr.
  **The new worktree has no `node_modules`** — run the project's install step
  there before building or testing.

Parse with `jq -r .path`. Tolerate unknown fields — the schema allows additive
growth.

## Errors (stderr, 1 line JSON, non-zero exit)

```json
{ "schemaVersion": 1, "error": { "code": "E_NOT_REPO", "message": "…" }, "exitCode": 2 }
```

| code            | exit | meaning                                          |
|-----------------|------|---------------------------------------------------|
| `E_VALIDATION`  | 1    | bad flags, invalid branch name, no branch name    |
| `E_BRANCH`      | 1    | `--from` ref unknown, or the branch failed        |
| `E_WORKTREE`    | 1    | `gwq add` failed — usually a directory collision  |
| `E_NOT_REPO`    | 2    | cwd is not inside a git repository                |
| `E_DEPS`        | 127  | `git` or `gwq` missing                            |
| `E_INTERRUPTED` | 130  | Ctrl-C                                            |

stderr *carries* that line; it is not exclusively JSON. git and gwq diagnostics
share the stream, so select the line starting with `{` —
`2>&1 >/dev/null | grep -m1 '^{' | jq -r .error.code` — rather than piping the
whole stream to `jq`.

Recovery:

- `E_NOT_REPO` → find the repo first (`ghqcd --json <name>`), then re-run there.
- `E_BRANCH` naming `--from` → the ref does not exist locally. A `git fetch` may
  be needed; ask before fetching.
- `E_WORKTREE` naming a collision → a directory is in the way. Report it and
  ask. `-f` **moves** it to `<path>.bak-<timestamp>`, but that is the user's call.

## Things the skill must NOT do

- Call gwqadd without `-n --json`.
- Rely on the default base. Pass `--from`.
- Pass `-f` without explicit user consent — it relocates a directory that may
  hold their work.
- Treat `repo.root` as the working directory. Work in `path`.
- Assume the user's original worktree changed. It did not; gwqadd only adds.
- Run `gwqadd --init` to modify the user's shell config without being asked.
- Follow up with `git push -u`, `gwq remove`, or `git branch -D`.

## After success

Report the branch, the base it was cut from, and the path. Run subsequent
commands with `git -C "<path>"`, or `cd` there if the harness can change cwd.
Mention that the user's previous worktree is untouched — that is usually why
they asked for a worktree rather than `git switch`.
