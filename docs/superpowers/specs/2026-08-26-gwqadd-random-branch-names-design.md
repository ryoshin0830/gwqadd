# gwqadd — random branch names

Design, 2026-08-26. Status: approved, not yet implemented.

## The problem

Today a `gwqadd` run with no positional costs the user a sentence and 6–8
seconds:

```
│ what do you want to do? (any language)
│ > ...
        ↑ then claude/codex/opencode/gemini boots, ~7s, and one name comes back
```

That is the right price when the branch name matters. It is the wrong price
when it does not — a throwaway worktree to try something, a scratch branch that
will be squashed away, a worktree an agent needs for isolation and nothing else.
In those cases the user is being asked to do design work on a label nobody will
read.

`claude -w` solves the same problem by not asking: it generates a name and gets
out of the way.

## What `claude -w` actually does

Measured against Claude Code 2.1.246 on 2026-08-26, in a throwaway repository:

```
$ claude -w -p 'Reply with exactly: OK'
worktree: <repo>/.claude/worktrees/noble-exploring-perlis   (locked)
branch:   worktree-noble-exploring-perlis
```

Recovered from the binary, the generator is three dictionary picks over
`crypto.randomBytes`:

```js
const pick = (a) => a[randomBytes(4).readUInt32BE(0) % a.length];
const name = `${pick(ADJ)}-${pick(GERUND)}-${pick(NOUN)}`;
```

- `ADJ` 216 words — cozy (`whimsical`, `zazzy`) mixed with computing
  (`async`, `immutable`, `memoized`)
- `GERUND` 109 words — `baking`, `booping`, `exploring`, `stargazing`
- `NOUN` 407 words — nature, animals, small objects, and the surnames of
  computer scientists (`turing`, `liskov`, `perlis`, `matsumoto`)
- namespace 216 × 109 × 407 = **9,582,408**
- names are validated at ≤ 64 characters, no `.`/`..` segment, no `.git`
  segment; the branch is `worktree-` + the name with `/` replaced by `+`
- **there is no collision retry.** A name that is already taken is a hard
  error telling the user to pass a different one. Anthropic bets on
  1-in-9.6-million.

Two facts we deliberately do not copy:

1. **Location.** claude puts worktrees inside the repository at
   `.claude/worktrees/`. gwq puts them under `worktree.basedir`, laid out by
   `{{.Host}}/{{.Owner}}/{{.Repository}}/{{.Branch}}`. gwqadd stays with gwq.
2. **The `worktree-` prefix.** See "Name shape" below.

## Decisions

| Question | Decision |
| --- | --- |
| Name shape | Bare three words, no prefix: `plume-melting-bearskin` |
| When it fires | Interactive `gwqadd` offers a random name **first**, at zero cost; `n` falls through to today's describe→AI flow |
| Generator | Same scheme as claude, our own word lists, assembled from free sources |
| Word counts | 216 / 109 / 407, matching claude exactly |

### Name shape

A random name carries no information, so a `feat/` on the front of it would be a
lie — it claims a category nobody chose. `wt/` was considered and rejected for
the same reason a prefix was rejected in I18: the prefix is a statement about
the work, and there is no work to make a statement about yet.

So the random path is the **one** naming path in this tool that does not follow
the repository's prefix convention, and that is deliberate. Its shape is its
signal: three hyphenated words with no slash is not a shape any human types, so
`git branch` output reads as "these four are real, that one is a scratch
worktree" at a glance.

### The flow

```
┌ gwqadd gwqadd
│ repo    gwqadd  ~/ghq/github.com/ryoshin0830/gwqadd
│ base    main  6524c03
│
│ plume-melting-bearskin   off main
│ create it? [Y]es · [n]o, name it properly · [e]dit · [r]eroll
```

Everything above appears immediately — there is no network call and no
subprocess on this path. The keys:

- `Y` / Enter — create it
- `n` — drop into today's flow: "what do you want to do?", then the AI
- `e` — edit the generated name in place (`typeItYourself(name)`, unchanged)
- `r` — reroll, another random name, still zero cost

`r` exists because rerolling is the cheapest possible action and pressing `n`
to get a 7-second round trip is not what a user who dislikes `plume-melting-bearskin`
usually wants.

This inverts the default: the fast path is now the one you get by pressing
nothing, and the expensive path costs one keystroke. The AI flow itself is
untouched, including I18's repo-context prompt and I19's rejection memory.

### Flags

| Flag | Effect |
| --- | --- |
| `--random` | Skip straight to a random name. Legal **without a terminal**, unlike every other naming path. |
| `--no-random` | Start at the describe→AI prompt, i.e. 0.3.x behaviour. `GWQADD_RANDOM=off` is equivalent. |

`--random` with a positional is `E_VALIDATION` — the positional is the user
speaking, and asking for a random name at the same time is a contradiction, not
a preference to resolve silently.

`--random --no-ai` is fine: the random path never wanted an AI.

`--random` non-interactively creates immediately with no confirmation. That is
the agent path, and it is the whole reason the flag is allowed to bypass the TTY
requirement.

## The generator

```js
// crypto, not Math.random: this names a branch that may outlive the session,
// and a seeded PRNG that repeats across two shells in the same second would
// produce a collision the user has to clean up by hand.
const pick = (a) => a[randomBytes(4).readUInt32BE(0) % a.length];
const randomName = () => `${pick(ADJ)}-${pick(GERUND)}-${pick(NOUN)}`;
```

The modulo in `randomBytes(4).readUInt32BE(0) % a.length` biases the first few
words of each list upward by about `407 / 2^32` ≈ 1e-7 in relative terms. That
is invisible at any number of branches a human will ever create, and not worth a
rejection loop.

### Collision handling — where we differ from claude

Unlike claude, a generated name is checked before it is offered:

```js
for (let i = 0; i < 10; i++) {
  const name = randomName();
  if (!hasLocalBranch(cwd, name) && !worktreePath(cwd, name)) return name;
}
// 10 collisions in a 9.6M namespace means something is wrong with our
// randomness, not with the user's luck. Fall through rather than loop forever.
return typeItYourself();
```

The cost is two `git` calls we already have helpers for, and it removes the one
failure mode claude accepts. `git check-ref-format --branch` still runs on the
result like every other name (I17) — belt and braces, since the word lists are
ASCII by construction.

## Word lists

### Provenance

| Source | Licence | Used for |
| --- | --- | --- |
| [glitchdotcom/friendly-words](https://github.com/glitchdotcom/friendly-words) | MIT © 2018 Glitch | adjectives (`predicates.txt`), nouns (`objects.txt`) |
| [dariusk/corpora](https://github.com/dariusk/corpora) | CC0 | gerunds (`data/words/verbs_with_conjugations.json`, `.gerund[0]`) |
| [cjhutto/vaderSentiment](https://github.com/cjhutto/vaderSentiment) | MIT | build-time tone filter only — **not shipped** |
| [dwyl/english-words](https://github.com/dwyl/english-words) | Unlicense | build-time spelling check only — **not shipped** |

Only the first two contribute words. The MIT notice for friendly-words goes in
`LICENSE`; CC0 requires no attribution but is credited anyway in the build
script's header.

**The word lists were not copied from Claude Code.** Only the scheme
(adjective-gerund-noun) and the counts are shared. Lifting 732 hand-curated
words out of a proprietary binary into an MIT package is a licence question with
no upside, and friendly-words is curated for exactly this tone anyway.

### Why not one source

Measured while designing this. A straight CC0 dump from corpora, filtered only
for shape, produces branch names nobody wants:

```
harlot-planning-bandana      warlike-pecking-boyle       blackened-injuring-lehmann
wanton-numbering-blodgett    besieged-pecking-bardeen    virgin-scratching-chapati
```

General-purpose English word lists are not curated for tone, and roughly a
third of English adjectives are unpleasant. friendly-words is curated (it backs
Glitch's project namer) but carries only 84 `-ing` words — short of the 109 we
need. Hence: friendly-words for adjectives and nouns, corpora for gerunds, and a
sentiment filter over the corpora half.

### The recipe

`tools/build-words.mjs`, run by a maintainer, never at install or run time:

1. Fetch the four sources above.
2. Build a rejection set: every VADER entry with valence < 0, matched against
   the word and its plausible stems (`-ing`, `-e`, `-s`, `-ed`).
3. Keep only `/^[a-z]{3,9}$/` (adjectives, nouns) or `/^[a-z]{5,10}$/` ending in
   `ing` (gerunds). Lowercase ASCII only means no escaping question ever
   reaches `git check-ref-format`.
4. Drop anything absent from `words_alpha.txt`. This is what kills `claping`
   (a misspelling that ships in corpora) and `aerosteon` / `agustinia`
   (dinosaur genera that friendly-words counts as objects).
5. Subtract `REJECT`, a short hand-maintained list in the build script for the
   duds the mechanical filters miss. VADER is a sentiment lexicon, not a
   taste lexicon, so words that are merely charmless survive it: `abrasive`,
   `screeching`, `begging`, `banning`, `concerning`. Growing this list is
   expected maintenance, not a design failure.
6. Sort, then **stride-sample** to the target count: `pool[floor(i * len / n)]`
   for `0 ≤ i < n`. Deterministic in any language, no seeded RNG to reproduce,
   and it spreads the selection across the alphabet instead of clumping. The
   build script asserts the result is `n` *distinct* words — stride sampling
   over a sorted unique pool cannot repeat, and an assertion is cheaper than
   discovering otherwise from a duplicate in the shipped array.
7. Print the three arrays; the maintainer pastes them into `bin/gwqadd.mjs`.

Measured pool sizes on 2026-08-26, running the recipe exactly as written above:
1140 adjectives, 542 gerunds, 2512 nouns — comfortably above 216 / 109 / 407,
with room for the sources to shrink.

Sample output of the recipe as specified:

```
icy-reminding-beak           bold-exercising-broccoli     plume-melting-bearskin
winter-recording-catmint     shaded-attracting-blarney    bronzed-mining-mandible
grass-concerning-lighter     olivine-dropping-attempt     quilted-licking-barn
```

Not every draw is charming — `quilted-licking-barn` is the price of not
hand-curating 732 words. The bar is "instantly recognisable as a throwaway, and
never unpleasant", and the filters clear it.

The arrays cost about **6.9 KB** in the source, taking `bin/gwqadd.mjs` from
1232 to roughly 1300 lines. No runtime dependency is added (I12 holds), nothing
is fetched at run time, and the tool still works offline.

## Invariants

### Amended

**I15 — the naming layer is interactive-only.** Now: *the naming layer is
interactive-only, except that `--random` may run without a terminal.* The
reasoning that produced I15 was that a script or an agent must never trigger an
unrequested prompt, subprocess or network round trip. A random name is none of
those — it is arithmetic over a constant array. `--random` is explicit, so
nothing is triggered that the caller did not ask for by name. Bare `gwqadd` with
no positional and no terminal still dies with `E_VALIDATION`; that is unchanged
and still tested.

The canary tests stay, and gain a case: `--random` must not invoke an AI CLI
either.

**I18 — the prompt carries the repository, so there is no type menu.** Unchanged
for the AI path. Gains a sentence: the random path emits no prefix at all, by
design, and is the only naming path in this tool that ignores the repository's
convention.

### New

**I23. The word lists are generated, and their provenance is recorded.**
`tools/build-words.mjs` is the only way the three arrays are produced. Editing
them by hand makes the counts drift from the recipe and quietly discards the
licence trail. The build script is a maintainer tool: it is in `.npmignore`, it
is not in `files`, and it never runs at install or run time.

**I24. Random names are checked before they are offered, never after.** claude
lets a collision become an error; we reroll. Both `hasLocalBranch` and
`worktreePath` must be clear before a name is shown to the user, so the
confirmation prompt never proposes something that cannot be created.

## Contracts

### `--json`

One field is added. Adding fields does not bump `schemaVersion` (I10).

```json
{ "named": "argument" | "random" | "ai" | "manual" }
```

An agent that passes `--random` gets `"named":"random"` back and can tell the
difference between a name it chose and one the tool invented — which matters if
it later wants to rename the branch to something meaningful.

### `.claude/skills/gwqadd/SKILL.md`

The agent contract gains the isolation case, which today has no answer:

```bash
gwqadd --random -n --json --from <base>
```

for "I need a worktree to work in and the branch name is not the point". The
existing advice — always `-n`, always `--json`, always `--from` — is unchanged.
This is a user-visible interface change and gets called out in the commit
message.

### Exit codes

No new codes. `--random` with a positional is `E_VALIDATION` (1); the
ten-collision fallback lands in `typeItYourself()` and can still end in
`E_INTERRUPTED` (130) if the user cancels there.

## Testing

Automated, in `test/cli.test.mjs` against the real-git sandbox:

- a generated name matches `/^[a-z]{3,9}-[a-z]{5,10}-[a-z]{3,9}$/` and passes
  `git check-ref-format --branch`
- `--random` non-interactively creates branch and worktree, exits 0, and reports
  `"named":"random"`
- `--random` non-interactively does **not** invoke the canary AI (extends the
  existing I15 canary tests)
- `--random <branch>` is `E_VALIDATION`
- bare `gwqadd` non-interactively is still `E_VALIDATION` — I15's remaining half
- the reroll loop skips a name that already exists: seed the sandbox with a
  branch, stub the picker, assert the taken name is never returned
- the three arrays are 216 / 109 / 407, are sorted, are unique, and contain only
  the permitted character classes — this is the regression test for a hand-edit
  that bypasses the build script (I23)

By hand, since the interactive flow cannot be driven from `spawnSync` here (see
CLAUDE.md, Testing):

| Scenario | Expect |
| --- | --- |
| `gwqadd` | a name appears instantly, no AI runs |
| press `r` a few times | a different name each time, still instant |
| press `n` | today's "what do you want to do?" prompt, AI as before |
| press `e` | the prompt is pre-filled with the random name |
| Esc | exit 130, nothing created |
| `gwqadd --no-random` | straight to the description prompt, 0.3.x behaviour |
| `GWQADD_RANDOM=off gwqadd` | same |
| `gwqadd --random` in a repo, then again | two different worktrees, no collision |

## Out of scope

- **Any use of the description to seed the name.** claude carries a slugifier
  for that; ours would compete with the AI path for no gain.
- **Reusing claude's `.claude/worktrees/` location, or its `worktree-` prefix.**
  gwq owns worktree layout here.
- **`--expires` defaulting on for random names.** Tempting — a random name
  suggests a throwaway — but expiry is a destructive-adjacent policy and the
  user did not ask for it. It remains an explicit flag.
- **A `--words` file or `GWQADD_WORDS` override.** No demand, and it would make
  the branch-name shape unpredictable for anyone reading `git branch`.
- **Regenerating the lists in CI.** The sources are upstream repositories that
  can change under us; pinning the output in source is the point.
