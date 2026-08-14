# gwqadd

Create a branch and its [gwq](https://github.com/d-kuro/gwq) worktree in the repository you are in, and `cd` there.

```console
~/ghq/github.com/you/api $ gwqadd feat/login
┌ gwqadd api
│ repo    api /Users/you/ghq/github.com/you/api
│ base    main 8f2c1a9
│ Created worktree at /Users/you/worktrees/github.com/you/api/feat-login
└ ✓ feat/login → /Users/you/worktrees/github.com/you/api/feat-login

~/worktrees/github.com/you/api/feat-login $
```

One command instead of: `git checkout -b` → realise you wanted a worktree →
`gwq add -b` → find where it landed → `cd`.

Run it with no branch name and it asks one question:

```console
~/ghq/github.com/you/api $ gwqadd
┌ gwqadd api
│ repo    api /Users/you/ghq/github.com/you/api
│ base    main 8f2c1a9
│
│ what do you want to do? (any language)
│ > セッションが期限切れでも通ってしまう不具合を直す
│
│ bugfix/expired-session-accepted   off main
│ create it? [Y]es · [n]o, describe again · [e]dit the name
└ ✓ bugfix/expired-session-accepted → …
```

No type menu, no list to choose from. Note the prefix: this repository uses
`bugfix/`, not `fix/`, and the suggestion followed it without being told.

## Install

```sh
npm install -g gwqadd
```

Then add the shell integration:

```sh
# zsh  — ~/.zshrc
eval "$(gwqadd --init zsh)"

# bash — ~/.bashrc
eval "$(gwqadd --init bash)"

# fish — ~/.config/fish/config.fish
gwqadd --init fish | source
```

Reload the shell and `gwqadd` moves it.

Prefer a different name? `eval "$(gwqadd --init zsh --cmd gwa)"` gives you `gwa`.

### Without installing

```sh
eval "$(npx -y gwqadd --init zsh)"
```

The emitted function resolves its binary in three steps — `gwqadd` on `PATH`,
then the script that generated the snippet, then `npx -y gwqadd@<version>` — so
it keeps working after npm garbage-collects the npx cache.

Requires `git` and `gwq` on `PATH` (`brew install git d-kuro/tap/gwq`), and
Node >= 20.12. No `fzf`, no `jq`, no npm dependencies.

## Where it branches from

**The current HEAD, exactly like `git checkout -b`.** Running it inside a
feature worktree therefore branches off that feature, not off `main` — which is
almost never what you meant, and `gwq add -b` does it silently.

`gwqadd` always prints the base it used, and warns when that is not the
repository's default branch:

```console
~/worktrees/github.com/you/api/feat-login $ gwqadd feat/logout
┌ gwqadd api
│ repo    api /Users/you/ghq/github.com/you/api
│ cwd     a linked worktree of it /Users/you/worktrees/github.com/you/api/feat-login
│ base    feat/login 3b7d004
gwqadd: branching from feat/login, not the default branch — pass `--from main` if that is not what you meant
```

So the fix is one flag:

```sh
gwqadd feat/logout --from main
```

## Naming help

One question, one confirmation:

| key | |
| --- | --- |
| `Y` / Enter | create it |
| `n` | describe the work again — the rejected name is excluded next time |
| `e` | edit the suggested name in place |
| Esc | give up, create nothing |

**Why the suggestions fit.** The prompt is not just your sentence. It carries:

- this repository's branch prefixes with their counts, so the AI picks the one
  you actually use — `feature/` over `feat/`, `bugfix/` over `fix/`;
- up to 20 existing branch names, for wording and length;
- the repository name and the ref being branched from;
- the paths you have already modified, if the working tree is dirty — often the
  clearest signal about what the work is.

**The AI** is whichever of these is on your `PATH`:

```
claude -p    →    codex exec    →    opencode run    →    gemini -p
```

No API key to obtain, no account to create — it uses what you already have.
Expect 6–8 seconds, almost all of it the CLI's own start-up; an elapsed counter
runs while it works.

| | |
| --- | --- |
| pick a different CLI | `--ai 'gemini -p'`, or `GWQADD_AI='gemini -p'` |
| turn it off | `--no-ai`, or `GWQADD_AI=off` — leaves a plain ASCII-name prompt |

**What is sent, and when.** Nothing leaves your machine until you answer the
question. At that point the sentence, the repository name, its branch names and
your modified file *paths* (never contents) go to that CLI. Nothing is created
until you confirm.

None of this happens when you pass a branch name on the command line, or when
there is no terminal. Scripts and agents keep the plain, silent contract.

## What it does

1. Work out which repository you are in — any worktree of it will do.
2. Create the branch and its worktree. If the branch already exists, create
   just the worktree. If both exist, go there.
3. `git submodule update --init --recursive` when the tree has submodules.
4. Hand the path back so the shell can `cd` there.

Re-running is safe.

### It will not eat your work

- A colliding directory is only touched with `-f`, and then it is **moved** to
  `<path>.bak-<timestamp>`, never deleted.
- A branch that already existed is never deleted, even when the run fails.
- A branch **`gwqadd` created** *is* rolled back if the worktree could not be
  made — otherwise `git worktree add -b`'s half-finished state would turn every
  later attempt into `branch already exists`.

## Usage

```
gwqadd [options] [<branch>]
```

| Option | Meaning |
| --- | --- |
| `--init <shell>` | print shell integration for `zsh` \| `bash` \| `fish` |
| `--cmd <name>` | function name emitted by `--init` (default: `gwqadd`) |
| `--from <ref>` | branch from this ref instead of the current HEAD |
| `--expires <dur>` | hand gwq an expiry (`1h`, `7d`, …) for a throwaway worktree |
| `--ai <cmd>` | AI CLI used to suggest names (default: autodetected) |
| `--no-ai` | never ask an AI, even when one is installed |
| `--no-submodules` | skip `git submodule update --init --recursive` |
| `-f`, `--force` | move a colliding worktree directory aside instead of failing |
| `-n`, `--no-cd` | do the work and report the path, but do not move the shell |
| `--json` | stdout = 1-line JSON |
| `--quiet` | stdout = path only |
| `--no-color` | disable ANSI colors (also respects `NO_COLOR`) |
| `-h`, `--help` | show help |
| `-V`, `--version` | show version |

Run it with no branch name and it asks what you want to do, then confirms once.

## For scripts and AI agents

```console
$ gwqadd -n --json feat/login
{"schemaVersion":1,"path":"/Users/you/worktrees/github.com/you/api/feat-login","branch":"feat/login","base":{"ref":"main","sha":"8f2c1a9…"},"repo":{"root":"/Users/you/ghq/github.com/you/api","name":"api"},"created":"branch+worktree","cd":false}
```

`created` is `branch+worktree`, `worktree` (the branch already existed) or
`none` (nothing to do). Progress narrates on stderr, so stdout stays parseable.

Errors go to stderr as JSON with stdout empty:

```console
$ gwqadd --json feat/x
{"schemaVersion":1,"error":{"code":"E_NOT_REPO","message":"not inside a git repository (/tmp). …"},"exitCode":2}
```

| Exit | Code | Meaning |
| --- | --- | --- |
| 0 | — | success |
| 1 | `E_VALIDATION` | bad flags, bad branch name, no branch name |
| 1 | `E_BRANCH` | `--from` ref unknown, or the branch could not be created |
| 1 | `E_WORKTREE` | `gwq add` failed (see the message for collisions) |
| 2 | `E_NOT_REPO` | not inside a git repository |
| 127 | `E_DEPS` | `git` or `gwq` not installed |
| 130 | `E_INTERRUPTED` | Ctrl-C |

Pass `-n` in an agent session, and pass `--from` explicitly rather than relying
on whatever HEAD the harness happens to be sitting on.

## Which one do I want?

| | |
| --- | --- |
| [`gwqadd`](https://github.com/ryoshin0830/gwqadd) | new branch + worktree, **in the repo I am in** |
| [`gwqpull`](https://github.com/ryoshin0830/gwqpull) | get a repo **from a remote** and land on a branch or PR |
| [`gwqcd`](https://github.com/ryoshin0830/gwqcd) | jump to a worktree that **already exists** |
| [`ghqcd`](https://github.com/ryoshin0830/ghqcd) | jump to a **ghq repository** |
| [`ghnew`](https://github.com/ryoshin0830/ghnew) | create a **brand-new GitHub repo** |

## License

MIT © ryoshin0830
