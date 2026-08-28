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
4. Copy the main working tree's Git-ignored files into the new worktree.
5. `git submodule update --init --recursive` when `.gitmodules` exists.
6. Print the path; `--init <shell>` emits a function so the *shell* cds.

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

The destination is recovered from gwq's error text: git's quoted
`fatal: '<path>' already exists` first, then the command echo — which must be
told whether `-b` was used, since that swaps the argument order.

Two failures already lived here: a pattern stopping at the first space silently
broke `-f` for any gwq basedir under a directory with a space, and a pattern
running to the colon swallowed the branch name. Both orders and both spacings
are tested.

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

### I8b. The function must not capture output that is not a path

Every flag whose result goes to stdout has to be passed through uncaptured:
`-h`, `--help`, `-V`, `--version`, `--init`, `--json`. The wrapper adds
`--quiet`, so `--json` would additionally collide with it and error out.

This shipped broken in every one of these packages and was only found by running
the emitted function rather than syntax-checking it — `zsh -n` is perfectly happy
with a function that cds into a help page. There are tests now that install the
function in zsh, bash and fish and run `--version` and `--help` through it.

### I8c. The install snippet must say `command`

The emitted function shares its name with the binary, so `eval "$(gwqadd --init
zsh)"` in `~/.zshrc` resolves to the *function* on every re-source after the
first. A stale function then captures the `--init` output and hands it to `cd`:

    gwqcd:cd:5: no such file or directory: # gwqcd 0.2.1 — zsh integration\n…

Reported by a user running `source ~/.zshrc` after an upgrade. `command` skips
functions and goes to PATH, which makes re-sourcing idempotent no matter what is
already defined. The npx form (`eval "$(npx -y gwqadd --init zsh)"`) never had the
problem, because npx is not the function.

The generated snippet's own header comment shows the `command` form too — it is
the line people copy.

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

### I15. The naming layer is interactive-only, except `--random`

`composeBranchName()` runs when **and only when** there is no positional and
`isNonInteractive` is false. A branch name on the command line is the user
speaking; never second-guess it, and never let a script or an agent trigger a
prompt, a subprocess or a network round trip it did not ask for.

`--random` is the one exception, and it is one because it breaks none of that:
generating a name is arithmetic over a constant array — no prompt, no
subprocess, no network — and the flag is explicit, so nothing happens that the
caller did not ask for by name. `gwqadd --random` therefore works without a
terminal. Bare `gwqadd` with no positional and no terminal still dies with
`E_VALIDATION`, and that half is still tested.

Both halves are tested with a canary "AI" that records its own invocation, so
the absence is provable rather than assumed. `--random` is in those tests too.
Keep them.

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

This applies to the AI path. The random path emits no prefix at all — a random
name carries no information, so a `feat/` in front of it would claim a category
nobody chose. It is the only naming path in this tool that ignores the
repository's convention, and the shape is the point: three hyphenated words with
no slash is not a shape a person types, so `git branch` output separates real
branches from scratch worktrees at a glance.

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

### I23. The word lists are generated, and their provenance is recorded

`tools/build-words.mjs` is the only way `ADJECTIVES`, `GERUNDS` and `NOUNS` are
produced. Hand-editing them drifts the counts from the recipe and quietly
discards the licence trail. The script is a maintainer tool: it is in
`.npmignore`, it is absent from `files`, and nothing at install or run time
calls it.

Adjectives and nouns come from glitchdotcom/friendly-words (MIT (c) 2018 Glitch,
notice reproduced in `LICENSE`); gerunds from dariusk/corpora (CC0). VADER (MIT)
filters tone and dwyl/english-words (Unlicense) filters spelling, both at build
time only — neither is shipped.

The counts match `claude -w` (216 x 109 x 407 = 9,582,408). **The words do not.**
Lifting 732 hand-curated words out of a proprietary binary into an MIT package
is a licence question with no upside. There is a test asserting the counts, the
sort order, uniqueness and the character classes; it is the regression test for
a hand-edit.

### I24. A random name is checked before it is offered, never after

`claude -w` lets a collision become a hard error telling the user to pass a
different name. `freeRandomName()` rerolls instead, so the confirmation prompt
can never propose something that cannot be created. Ten failures means our
randomness is broken, not the user's luck — without a terminal that is
`E_VALIDATION`, with one it falls through to `typeItYourself()`.

Asking git about **branches is enough**, and a `worktreePath()` call beside it
would be dead code: `git worktree list --porcelain` prints `branch
refs/heads/<name>` only for a worktree that has that branch checked out, and
`detached` for one without a branch. A name a worktree holds is therefore always
a name a branch holds. This was verified against git, and the first draft
carried the redundant call until the test written for it could not be made to
fail.

Both the reroll and the exhaustion path are tested by running a copy of the CLI
whose word lists have been shrunk to one or two words. Keep that helper: it is
what lets the real generator be tested without a test hook in shipped code.

### I25. Ignored files come from the main working tree, and cannot fail the run

A worktree gets what git tracks and nothing else, so it starts with no `.env`,
no credentials and no local config — unable to run the project it is a checkout
of. `seedIgnoredFiles()` copies everything `git ls-files --others --ignored
--exclude-standard` reports, and it is **on by default**; `--no-copy-ignored-files`
turns it off and `--copy-ignored-files` is accepted so a script can be explicit.
Both together is `E_VALIDATION`.

Four properties, all required, all tested:

- **The source is `repo.root`, not cwd.** G1 deliberately takes the *base* from
  the cwd's HEAD; the ignored files go the other way, because they belong to the
  repository rather than to whichever branch you were standing on. A user who
  edited `.env` inside worktree A does not thereby make it the template for
  worktree B. The source path is printed, for the same reason I6 prints the base.
- **Missing-only, never destructive.** A path the destination already has is
  counted as kept and left alone: an `.env` edited in a worktree is the user's,
  and re-running has to stay a no-op. Nothing is ever overwritten or deleted.
- **The write cannot leave the destination.** The list comes from the
  filesystem, so every entry is checked lexically (`isWithin`) *and* against
  symlinked parents (`hasSymlinkInPath`) before mkdir and again after — mkdir
  can follow a link that appeared in between. A rejected entry is skipped, not
  fatal.
- **It never blocks.** Every failure — unreadable source, a symlinked parent, a
  full disk — warns and carries on, exactly as the naming layer does (I22). A
  worktree without its `.env` is worse than one with it; a worktree that was
  never created is worse than both. This is also why a copy failure does not
  trigger the I3 rollback: by then the worktree exists and is fine.

The copy also runs on the "worktree already exists" path, so a worktree made
before this feature picks its files up on the next `gwqadd`.

`node_modules` and build output are in scope on purpose — the decision was
"copy everything ignored", not "guess which ignored files matter". That makes
the operation slow enough to need narration: there is a counter on a TTY, and
`copied N ignored file(s)` afterwards. A silent multi-minute pause reads as a
hang for the same reason I16's eight seconds did.

The sharp edge of that scope is the "worktree already exists" path: filling in
only what is missing in a worktree that has its own `node_modules` interleaves
two installs. Documented in the README rather than special-cased, because a
denylist of "regenerable" directory names is exactly the guessing this decision
rejected.

`gwqpull` carries the same behaviour, sharing the implementation by copy rather
than by dependency (I12).

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
git push --follow-tags      # pushing main fires .github/workflows/publish.yml
gh run watch                # optional; the publish happens in CI
npx -y gwqadd@latest --version
```

**Do not run `npm publish` by hand.** **Every push to main releases.** CI runs
the suite, then publishes whatever `package.json` says — raising patch itself,
and committing that bump back to main, when the version there has already
shipped. Bump manually first (`npm version minor`) to choose a number; forget,
and you still shipped at +patch. Re-run a failure with
`gh workflow run publish.yml` — there is nothing to undo and no tag to move.

Because every push releases, treat main as the publish button: docs fixes and
test tweaks land as real versions. That is deliberate; if it ever feels wrong,
the fix is fewer pushes to main, not a new gate.

Commit-message footgun: GitHub reads **every line** of a push's HEAD message,
not just the subject, and skips the whole event when any of them carries a CI
skip token. One release note once said `The bump commit carries [skip ci]` and
that push released nothing — silently. Never write the token in prose; say
"the skip token" instead. The bot's own releases use it legitimately, which is
why they never fan out.

CI publishes with npm trusted publishing (OIDC), so there is no npm token on
any laptop and none in this repository's secrets. A publish-capable token
sitting in `~/.npmrc` is exactly what the worm this file already worries about
goes looking for, and it is also what made every release need a browser and a
passkey.

The tag `npm version` writes is history, not the trigger. Firing on the branch
*and* the tag would start two runs for one `git push --follow-tags`, racing for
the same version.

`prepublishOnly` runs `npm test && npm pack --dry-run && node bin/gwqadd.mjs --help`,
in CI as well as locally.

One-time setup per package, on npmjs.com → the package → Settings → Trusted
Publisher: GitHub Actions, owner `ryoshin0830`, this repository, workflow
filename `publish.yml`, allowed action `npm publish`. Nothing to rotate
afterwards — OIDC tokens are minted per run and expire with it.

The developer machine's `.npmrc` points `registry=` at a private mirror, which
is why anything run locally against npmjs.org still needs
`--registry=https://registry.npmjs.org`. CI has no such mirror, so the workflow
does not pass it.

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

**The interactive flow is driven with `expect`, not `script`.** macOS `script`
calls `tcgetattr` on its own stdin and fails under a pipe, so it cannot be
driven from `spawnSync` — piping keystrokes into it just hangs until something
kills it. `expect` allocates a pty properly and works, which is what
`runInteractiveExpect()` uses; it takes the keystroke script and any extra
flags, and the tests skip themselves when `expect` is not installed. `expect`
is a test-time tool on the developer's machine, not a package dependency, so
I12 is untouched.

Covered there: the rolled name appearing before any question, `r` rerolling to
a different one, `n` falling through to the AI, `e` editing, and Ctrl-C exiting
130. Add to those tests rather than to the matrix below.

Not covered — run by hand:

| Scenario | Command | Expect |
| --- | --- | --- |
| House style | in a repo using `bugfix/` | the suggestion uses `bugfix/`, not `fix/` |
| Cancel | Esc at either prompt | exit 130, nothing created |
| Dirty tree | modify files first | their paths reach the prompt, and the name reflects them |
| AI sandbox | a `GWQADD_AI` script that runs `pwd >&2` | prints a temp dir, never the repo (I21) |
| No repo contamination | `gwqadd` in this repo, describe unrelated work | the name follows the description, not CLAUDE.md |
| No AI installed | `PATH=/usr/bin:/bin gwqadd --no-random` | straight to the ASCII-name prompt |
| AI broken | `GWQADD_AI=false gwqadd --no-random` | warns, falls through to that prompt |
| AI disabled | `gwqadd --no-ai --no-random` | no description prompt at all |
| Non-ASCII fallback | at the ASCII prompt, type Japanese | refused with advice, not slugified |
| Messy model output | `GWQADD_AI='printf %s\\n 1)\\ feat/a'` | the numbering is stripped |
| Real gwq layout | `gwqadd feat/x` in a ghq repo | lands under gwq's `worktree.basedir` |
| `--expires` | `gwqadd tmp/x --expires 1h` | gwq records the expiry |
| Submodules | in a repo with submodules | submodules populated |
| Ignored copy, big tree | a repo with `node_modules` installed | a counter moves, then `copied N ignored file(s)` |
| Ignored copy, from a worktree | `gwqadd feat/x` inside worktree A | the printed source is the main clone, not A |
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
- `tools/build-words.mjs` — regenerates the three word lists. Not shipped.
- `docs/superpowers/` — design docs and implementation plans. Not shipped.

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
- **A `--words` file or `GWQADD_WORDS` override.** The shape of a random branch
  name should be predictable to anyone reading `git branch`.
- **`--expires` defaulting on for random names.** A random name suggests a
  throwaway, but expiry is destructive-adjacent policy and stays explicit.
- **Telemetry / analytics.**
