# CLAUDE.md

Guidance for any AI agent (Claude Code, Codex, opencode, etc.) that works
**inside** this repository.

This file is for **maintainers of `gwqadd`**. To USE gwqadd from an agent
session, see `.claude/skills/gwqadd/SKILL.md` and the "For scripts and AI
agents" section of `README.md` instead.

---

## What this package does

A Node.js CLI (~750 lines, zero runtime dependencies) that creates a branch and
its worktree in whatever repository the user is standing in:

1. Resolve the repository from cwd (any worktree of it will do).
2. Take the branch name from the positional, or from one question plus an
   AI suggestion the user confirms (interactive only).
3. Create branch + worktree, or just the worktree, or neither.
4. `git submodule update --init --recursive` when `.gitmodules` exists.
5. Print the path; `--init <shell>` emits a function so the *shell* cds.

Single source of behavior: `bin/gwqadd.mjs`.

Sibling packages built to the same contract: `ghqcd`, `gwqcd`, `gwqpull`,
`ghnew`. The split that justifies a fourth tool: **`gwqadd` creates in the repo
you are in; `gwqpull` fetches a repo from a remote; `gwqcd` only navigates.**

---

## Facts about gwq v0.1.1 this design is built on

All four were verified empirically before a line was written. If a gwq upgrade
changes any of them, the corresponding code here is wrong, not merely stale.

### G1. `gwq add -b` branches from the HEAD of its cwd

Not from the main clone's HEAD. Running it inside a linked worktree branches off
that worktree. This is why `gwq add` is spawned with `cwd: process.cwd()` — it
gives the tool `git checkout -b` semantics — and why the base is always printed
(see I6).

### G2. `gwq add` accepts no base ref

Its usage is `gwq add [branch] [path]`; there is no commit-ish parameter. So
`--from` cannot be delegated: the branch is created with `git branch <name>
<base>` first, and gwq is then asked only for the worktree.

### G3. A failed `gwq add -b` leaves the branch behind

`git worktree add -b` creates the branch while "preparing", then dies on an
occupied destination. The branch survives. Without the rollback in I3, the
second run fails with `branch already exists` and the tool stops being
idempotent after its first bad day.

### G4. `gwq add -f` does not overwrite

Despite `-f, --force  Overwrite existing directory` in its help, the flag does
not reach `git worktree add`. Collision handling is ours (I4). `gwqpull` carries
the same note.

Also worth knowing: an **empty** destination directory is fine — git accepts it.
Only a non-empty one collides, so do not treat mere existence as a conflict.

---

## Invariants (do not break)

### I1. stdout / stderr discipline

- **stdout** is machine-readable only: the `--quiet` path, the `--json` payload,
  the `--init` snippet, `--help`/`--version`.
- **stderr** carries everything else: the repo/base lines, gwq's output,
  warnings, the `cd` box, the branch-name prompt.

`gwq add` prints `Created worktree at …`; children get
`stdio: ['inherit', 2, 'inherit']` so fd 1 folds onto **our stderr** and that
line can never end up inside the path the shell function is about to `cd` into.

### I2. `--no-cd` prints nothing on stdout

The generated function cds to whatever appears on stdout, so `-n` in `--quiet`
mode must emit **nothing**, not the path. In `--json` it is reported as
`"cd": false` and the path stays in the payload. The generated function treats
empty stdout as success.

### I3. Roll back only what we created

If the worktree could not be made and **we** created the branch this run, delete
it (G3). If the branch existed beforehand, never touch it — the user may have
work on it. `rollbackBranch()` checks `worktreePath()` first, because a racing
run may have produced the worktree after all.

This asymmetry is tested from both sides; keep both tests.

### I4. Collisions are moved, never deleted

With `-f` a non-empty destination is **renamed** to `<path>.bak-<timestamp>`.
Without `-f` it is left alone and the error names it, counts its entries, and
points at `-f`. Never `rm` a collision.

The destination is recovered from gwq's error text via the `COLLISION` regex.
If gwq changes its error format the regex stops matching and `-f` silently stops
working — the `-f` test is what catches that.

After moving the collision aside, the retry must check whether the first attempt
already left the branch behind (G3) and drop `-b` if so, or git refuses to
create it twice.

### I5. `--quiet` still narrates

`--quiet` is the shell function's mode. It is also the only way the user sees
which repository and which base were chosen, which is the whole point of I6.
Only `--json` goes silent.

### I6. The base is always visible

G1 makes the default base invisible and occasionally wrong. Two mitigations,
both required:

- print `base <ref> <sha>` for every run that creates a branch;
- warn when that base is neither the default branch nor `--from`-chosen, and
  name the fix (`--from <default>`) in the warning.

The default branch comes from `refs/remotes/origin/HEAD`. When that is unset the
warning is skipped — do **not** guess between `main` and `master`.

### I7. `--init` is a flag, not a subcommand

`gwqadd init zsh` is ambiguous: the first positional is a branch name, so `init`
would become a branch. All five tools in this family spell it `--init <shell>`.

### I8. The generated function resolves its binary in three steps

`PATH` → the absolute path of the script that generated the snippet →
`npx -y gwqadd@<version>`. PATH first so a global install wins; the baked path
so `eval "$(npx -y gwqadd --init zsh)"` works at all; npx last because npm
garbage-collects `~/.npm/_npx/<hash>/`.

The lookup MUST be PATH-only (`whence -p` / `type -P` / `command -s`) — the
function shares its name with the binary, so a function-aware lookup recurses
until the shell dies.

### I9. Validate the branch name before touching anything

`git check-ref-format --branch` runs before any state changes, so a typo like
`feat..x` costs nothing and produces our error rather than git's.

### I10. `--json` schema (external contract)

```json
{
  "schemaVersion": 1,
  "path":          "<worktree path — where the shell would cd>",
  "branch":        "<branch, may contain slashes>",
  "base":          { "ref": "<label>", "sha": "<full sha>" },
  "repo":          { "root": "<main working tree>", "name": "<its directory name>" },
  "created":       "branch+worktree" | "worktree" | "none",
  "cd":            true | false
}
```

Error (stderr, exit ≠ 0):

```json
{ "schemaVersion": 1, "error": { "code": "E_*", "message": "…" }, "exitCode": <number> }
```

Adding fields is fine; removing or renaming requires a `schemaVersion` bump.

stderr *carries* the error line; it is not exclusively JSON. Node warnings and
child diagnostics share the stream. Consumers — including our own tests — must
select the line starting with `{`, never parse the whole stream.

### I11. Exit codes

| Code | Constant        | Meaning                                        |
|------|-----------------|------------------------------------------------|
| 0    | —               | success                                        |
| 1    | `E_VALIDATION`  | flag conflict, extra positional, bad/absent branch name |
| 1    | `E_BRANCH`      | `--from` ref unknown, or `git branch` failed   |
| 1    | `E_WORKTREE`    | `gwq add` failed                               |
| 2    | `E_NOT_REPO`    | cwd is not inside a git repository             |
| 127  | `E_DEPS`        | `git` or `gwq` missing                         |
| 130  | `E_INTERRUPTED` | Ctrl-C, or an empty answer at the prompt       |

`E_NOT_REPO` gets its own code because "you are not in a repo" is by far the
most likely misuse, and its message points at `gwqpull`.

### I12. Zero runtime dependencies

The branch prompt uses `node:readline/promises`, not a prompt library; the
confirm uses the raw-mode keypress reader already present. No `fzf` and no `jq`
either — this is the lightest tool in the family, and it should stay that way.

### I15. The naming layer is interactive-only

`composeBranchName()` runs when **and only when** there is no positional and
`isNonInteractive` is false. A branch name on the command line is the user
speaking; never second-guess it, and never let a script or an agent trigger a
prompt, a subprocess or a network round trip it did not ask for.

Both halves are tested with a canary "AI" that records its own invocation, so
the absence is provable rather than assumed. Keep those tests.

### I16. Delegate to an installed AI CLI; never embed an API client

The suggestion layer shells out to `claude -p` / `codex exec` /
`opencode run` / `gemini -p`, whichever is on `PATH`, overridable with `--ai`
or `GWQADD_AI`. This is deliberate:

- no API key to store, so the tool never holds a secret;
- no account to create, and no cost beyond what the user already pays;
- no HTTP client, no provider SDK, no I12 violation.

Measured on 2026-08-14, all four take **6–8 seconds**, and it is start-up, not
inference — `claude --model haiku` is no faster. That is why `runAi` is async
with an elapsed counter instead of a blocking `spawnSync`: a silent eight-second
freeze reads as a hang. A 60s SIGKILL bounds the worst case.

Every failure path — CLI missing, non-zero exit, unparseable output, zero usable
candidates — falls through to `typeItYourself()`. The AI is an accelerator; it
must never be able to block the user from naming a branch.

### I17. The model's output is never trusted as a branch name

`parseCandidates()` strips bullets, numbering and quotes, drops anything with
whitespace or characters git would reject, and then runs
`git check-ref-format --branch` on each survivor. Only names git has already
accepted are ever offered, and nothing is created until the user confirms.

Three candidates are requested but only the first valid one is shown. The spares
exist so a malformed leader does not cost a 7-second round trip; they are not
offered as a menu, because the agreed UX is one name and one confirmation.

### I18. The prompt carries the repository, so there is no type menu

An earlier version made the user pick a prefix from a list. That was the wrong
division of labour: if an AI is being asked anyway, it can read the convention
too. `repoContext()` gathers prefix counts, example branch names, the repo name,
the base ref, and the dirty paths, and `namingPrompt()` tells the model to pick
a prefix the repo already uses. Verified: in a repo using `bugfix/`, a Japanese
description produced `bugfix/expired-session-accepted` — not `fix/…`.

Do not reintroduce the menu. If the model picks badly, improve the prompt.

### I19. One confirmation, and "no" goes back to the description

`confirmCreate()` is the only checkpoint. `n` returns to the description prompt
— not to a candidate list — and every name from the rejected round is passed to
the next prompt as an exclusion, so the model cannot answer with the same thing.
`e` edits the suggestion in place, which costs no extra step and saves a round
trip when a name is one word off.

### I20. Never trim a stream you are going to parse by column

`gitOut()` ends in `.trim()`, which is right for `rev-parse` and fatal for
`git status --porcelain`: it eats the leading space of the **first** line only,
so `slice(3)` then takes the first character of that path with it. ` M a.txt`
became `.txt` while every later line was fine — the kind of bug that survives
casual testing because it looks like a plausible filename.

The porcelain parse therefore uses `git()` directly, and handles ` -> ` renames
and `"quoted paths"`. There is a regression test that also asserts the broken
behaviour of the trimmed version, so nobody simplifies it back.

### I21. The AI runs in an empty directory, never in the user's repository

These CLIs are **agents**, not text transformers. Run one with `cwd` inside a
repository and it reads `CLAUDE.md`, the source and the git log, then names the
branch after what it found rather than what the user typed. This shipped broken
in 0.3.0 and was reported immediately: the description was `uiのバグの修正` and
the suggestion came back `feat/naming-prompt-repo-context` — a phrase lifted
straight out of *this repository's* `CLAUDE.md`.

Measured, same description, three runs each:

| `cwd` | results |
| --- | --- |
| this repo | `feat/ui-bug-fix`, `fix/ui-display-bug`, `feat/ui-bug-fix` |
| empty dir | `fix/ui-display-bug` ×3 |

In-repo it both wavered and chose `feat/` for a bug fix twice. So `runAi()`
mkdtemps a directory, runs there, and removes it. Everything the model
legitimately needs is already in the prompt (I18); giving it a repository to
read makes the answer worse, not better, and quietly widens what it sees.

If `mkdtemp` fails, the run inherits cwd rather than refusing — a degraded
answer beats no answer — but that is a fallback, not the path.

### I22. The naming layer never blocks

Every failure — CLI missing, non-zero exit, unparseable output, no usable
candidate — falls through to `typeItYourself()`. That prompt rejects non-ASCII
input rather than slugifying it: a user who was mid-way through describing work
in Japanese will type Japanese there, and git would happily create a branch
named in Japanese that no CI, URL or completion wants. The message points at the
two things that do work — describe it at the previous prompt, or pass a name as
an argument to use it verbatim.

---

## Do NOT

- Add `preinstall` / `postinstall` scripts to `package.json` (Shai-Hulud worm
  infection vector). `npm install --ignore-scripts` must work.
- Remove `.claude/`, `CLAUDE.md` or `test/` from `.npmignore`.
- Use `console.log` for human output. Use `stderr.write(...)` / `log()`.
- `rm` anything. The only destructive operations are a rename under `-f` and the
  I3 rollback of a branch this run created.
- Default the base to the default branch "because it is safer". That silently
  contradicts `git checkout -b`; the warning in I6 is the agreed compromise.
- Add a runtime dependency (see I12).
- Reintroduce a `const VERSION = '…'` literal. `npm version` only bumps the
  manifest, so a literal drifts and `--version` names a build nobody is running.

---

## Release workflow

```sh
git add -A && git commit -m "feat: …"
npm pack --dry-run          # must not contain .claude/, CLAUDE.md, test/, .git/
npm version patch           # or minor / major — commits and tags
git push --follow-tags
npm publish --registry=https://registry.npmjs.org
npm view gwqadd version
npx -y gwqadd@latest --version
```

`prepublishOnly` runs `npm test && npm pack --dry-run && node bin/gwqadd.mjs --help`.

Publishing needs `registry.npmjs.org` credentials and a browser OTP round.
If the machine's `.npmrc` points `registry=` at a private mirror, the
`--registry` flag above is not optional.

---

## Testing

`npm test` runs `test/cli.test.mjs` (`node:test`, no network, no TTY) against a
**real git repository** in a sandbox, with only `gwq` shimmed. git is
deliberately not shimmed: branch creation, worktree layout and the I3 rollback
are the logic under test, and faking git would only test the fake.

The shim reproduces G3 and G4 on purpose. If you simplify it into a
"successful gwq", the rollback and `-f` tests stop testing anything.

`beforeEach` rebuilds the repository, because worktree and branch state is
exactly what these tests are about.

Two traps for anyone adding tests:

- **Realpath the sandbox root.** macOS `$TMPDIR` is `/var/...` symlinked to
  `/private/var/...`, and git reports the resolved form.
- **Stay hermetic against the developer's environment.** `run()` deletes
  `FORCE_COLOR`, because we set `NO_COLOR` and node warns to stderr when it sees
  both. That failed a sibling package's suite at `npm publish` time.

**The interactive flow cannot be automated here.** macOS `script` calls
`tcgetattr` on its own stdin and fails under a pipe, so it cannot be driven from
`spawnSync`; a real pty would mean a dependency, which I12 forbids. Driving it
from an interactive shell by hand works (`script -q /dev/null zsh -c '…'` with
keystrokes piped in) and is what the matrix below assumes. Do not spend an
afternoon rediscovering this.

Not covered — run by hand:

| Scenario | Command | Expect |
| --- | --- | --- |
| The whole flow | `gwqadd`, describe work, `Y` | one suggestion, one confirm, created |
| House style | in a repo using `bugfix/` | the suggestion uses `bugfix/`, not `fix/` |
| Reject | at the confirm, press `n` | back to the description; the old name never returns |
| Edit | at the confirm, press `e` | prompt pre-filled with the suggestion |
| Cancel | Esc at either prompt | exit 130, nothing created |
| Dirty tree | modify files first | their paths reach the prompt, and the name reflects them |
| AI sandbox | a `GWQADD_AI` script that runs `pwd >&2` | prints a temp dir, never the repo (I21) |
| No repo contamination | `gwqadd` in this repo, describe unrelated work | the name follows the description, not CLAUDE.md |
| No AI installed | `PATH=/usr/bin:/bin gwqadd` | straight to the ASCII-name prompt |
| AI broken | `GWQADD_AI=false gwqadd` | warns, falls through to that prompt |
| AI disabled | `gwqadd --no-ai` | no description prompt at all |
| Non-ASCII fallback | at the ASCII prompt, type Japanese | refused with advice, not slugified |
| Messy model output | `GWQADD_AI='printf %s\\n 1)\\ feat/a'` | the numbering is stripped |
| Real gwq layout | `gwqadd feat/x` in a ghq repo | lands under gwq's `worktree.basedir` |
| `--expires` | `gwqadd tmp/x --expires 1h` | gwq records the expiry |
| Submodules | in a repo with submodules | submodules populated |
| npx one-shot | `npx gwqadd feat/x` | box on terminal, `c` copies the cd command |
| Stdout separation | `gwqadd feat/x > out.txt` | box on terminal, `out.txt` empty |

---

## Where things live

- `bin/gwqadd.mjs` — the entire CLI (ESM, top-level await OK).
- `package.json` — `bin.gwqadd`, `engines.node`, `files`, `prepublishOnly`.
- `.npmignore` — defense-in-depth complement to `files`.
- `.claude/skills/gwqadd/SKILL.md` — agent USE contract.
- `README.md` — end-user docs.
- `test/cli.test.mjs` — real-git sandbox tests.

---

## Things that are intentionally NOT here

- **An fzf picker, or any picker.** There is exactly one choice left in the flow
  and it is Y/n/e. Staying finder-free keeps this the one tool in the family with
  no fzf dependency.
- **A type menu.** Removed deliberately; see I18.
- **An embedded LLM client, or a bundled API key.** See I16. If someone asks for
  "just add Groq", the answer is `GWQADD_AI='<their own command>'`.
- **Caching AI suggestions.** They are cheap, and a stale suggestion for a
  different piece of work is worse than waiting.
- **Removing worktrees or branches.** `gwq remove` and `git branch -D` are
  destructive; the only deletion here is the I3 rollback of our own branch.
- **Pushing or setting upstream.** `git push -u` is one command and the user
  may not want the branch published yet.
- **Cloning.** That is `gwqpull`. Keep the split.
- **Telemetry / analytics.**
