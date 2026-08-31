# Random Branch Names Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Superseded in 0.6.0.** The word lists are now filtered through EFF's short
> wordlist, so the counts (216 / 109 / 407), the namespace (9,582,408), the
> stride sampling and every sample name below are historical. `CLAUDE.md` I23
> is the current record. Kept as the design's provenance, not as reference.

**Goal:** Give `gwqadd` an instant, zero-cost branch name — `plume-melting-bearskin` — offered before the AI naming flow and available to scripts through `--random`.

**Architecture:** Three generated word lists live as constants in `bin/gwqadd.mjs`; `randomName()` picks one word from each over `crypto.randomBytes`. Interactive runs offer a random name first and fall through to today's describe→AI flow on `n`. `--random` is the one naming path allowed to run without a terminal.

**Tech Stack:** Node.js ≥ 20.12 ESM, zero runtime dependencies, `node:test`, real-git sandbox tests with a `gwq` shim.

**Spec:** `docs/superpowers/specs/2026-08-26-gwqadd-random-branch-names-design.md`

## Global Constraints

- `engines.node >= 20.12.0`. Do not lower it.
- **Zero runtime dependencies** (I12). The word lists are constants, not a package.
- **stdout is machine-readable only** (I1): `--quiet`, `--json`, `--init`, `--help`, `--version`. Everything else — including every new prompt and warning — goes to stderr via `log()` / `warn()` / `stderr.write()`. Never `console.log`.
- No `preinstall` / `postinstall` scripts in `package.json`, ever.
- No `const VERSION = '…'` literal; the version is read from `package.json`.
- `tools/` must never ship: it is absent from `package.json` `files` and present in `.npmignore`.
- Word lists are **generated**. Never hand-edit the three arrays; change `tools/build-words.mjs` and re-run it (I23).
- Every generated name must pass `git check-ref-format --branch` (I17) and must be free of both a local branch and a worktree before it is shown (I24).
- The `--json` schema gains fields only; `schemaVersion` stays `1` (I10).
- Tests must be hermetic: `run()` deletes `FORCE_COLOR`, and assertions on "our" stderr go through `ourStderr()`.

## Spec gap closed by this plan

The spec says the ten-collision fallback "lands in `typeItYourself()`", which has no meaning without a terminal. **Non-interactive exhaustion exits `E_VALIDATION` (1)** with a message naming the fix, matching the existing "a branch name is required" error. No new exit code. Task 3 implements and tests it.

---

### Task 1: Generated word lists

**Files:**
- Create: `tools/build-words.mjs`
- Modify: `bin/gwqadd.mjs` (insert the word-list section immediately above `// ── naming (interactive only) ──`, currently line 600)
- Modify: `.npmignore`, `LICENSE`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: three module-level constants in `bin/gwqadd.mjs` — `ADJECTIVES` (216 words, `/^[a-z]{3,9}$/`), `GERUNDS` (109 words, `/^[a-z]{5,10}$/`, all ending `ing`), `NOUNS` (407 words, `/^[a-z]{3,9}$/`). All sorted and unique.

- [ ] **Step 1: Write the failing test**

Append to `test/cli.test.mjs`, after the `--init` block:

```js
// ── generated word lists ─────────────────────────────────────────────────────
//
// The arrays are parsed out of the source rather than imported: bin/gwqadd.mjs
// runs main() at load, so importing it would run the CLI. This is also the
// regression test for I23 — a hand-edit that bypasses tools/build-words.mjs
// shows up here as a wrong count, a duplicate or a stray character.
const source = readFileSync(BIN, 'utf8');

function wordList(name) {
  const m = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(m, `${name} not found in bin/gwqadd.mjs`);
  return m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}

test('the generated word lists have the shape the generator assumes', () => {
  for (const [name, count, shape] of [
    ['ADJECTIVES', 216, /^[a-z]{3,9}$/],
    ['GERUNDS', 109, /^[a-z]{5,10}$/],
    ['NOUNS', 407, /^[a-z]{3,9}$/],
  ]) {
    const words = wordList(name);
    assert.equal(words.length, count, `${name}: expected ${count} words`);
    assert.equal(new Set(words).size, count, `${name}: duplicates`);
    assert.deepEqual([...words].sort(), words, `${name}: not sorted`);
    for (const w of words) assert.match(w, shape, `${name}: ${w}`);
  }
  assert.deepEqual(
    wordList('GERUNDS').filter((w) => !w.endsWith('ing')), [],
    'every gerund ends in ing',
  );
});
```

Add `readFileSync` to the existing `node:fs` import at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `ADJECTIVES not found in bin/gwqadd.mjs`

- [ ] **Step 3: Write the build script**

Create `tools/build-words.mjs`:

```js
#!/usr/bin/env node
// Regenerates the three word lists in bin/gwqadd.mjs.
//
// Maintainer tool. It is in .npmignore, it is absent from package.json `files`,
// and nothing at install or run time calls it. Design and rationale:
// docs/superpowers/specs/2026-08-26-gwqadd-random-branch-names-design.md
//
//   adjectives, nouns  glitchdotcom/friendly-words   MIT (c) 2018 Glitch
//   gerunds            dariusk/corpora               CC0
//   tone filter        cjhutto/vaderSentiment        MIT       build-time only
//   spelling           dwyl/english-words            Unlicense build-time only
//
// Only the first two contribute words. Usage:
//   node tools/build-words.mjs > /tmp/words.js
// then paste the three arrays into bin/gwqadd.mjs.

const FW = 'https://raw.githubusercontent.com/glitchdotcom/friendly-words/main/words/';
const CORPORA = 'https://raw.githubusercontent.com/dariusk/corpora/master/data/words/verbs_with_conjugations.json';
const VADER = 'https://raw.githubusercontent.com/cjhutto/vaderSentiment/master/vaderSentiment/vader_lexicon.txt';
const DICT = 'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt';

// Matching `claude -w` exactly: 216 * 109 * 407 = 9,582,408 names.
const COUNTS = { ADJECTIVES: 216, GERUNDS: 109, NOUNS: 407 };

// VADER scores sentiment, not taste, so words that are merely charmless get
// through it. Growing this list is expected maintenance, not a design failure.
const REJECT = new Set([
  'abrasive', 'banning', 'begging', 'concerning', 'groaning', 'harming',
  'itching', 'screeching', 'spoiling',
]);

async function text(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

const [predRaw, objRaw, verbsRaw, vaderRaw, dictRaw] = await Promise.all(
  [`${FW}predicates.txt`, `${FW}objects.txt`, CORPORA, VADER, DICT].map(text),
);

const negative = new Set(
  lines(vaderRaw)
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 2 && Number(p[1]) < 0)
    .map((p) => p[0]),
);
// Check the stems too: "harming" is not in VADER, "harm" is.
const pleasant = (w) =>
  ![w, w.slice(0, -1), w.slice(0, -2), w.slice(0, -3), `${w.slice(0, -3)}e`]
    .some((s) => negative.has(s));

const spelled = new Set(lines(dictRaw));

// The spelling check is what kills "claping" (a misspelling that ships in
// corpora) and "aerosteon" / "agustinia" (dinosaur genera that friendly-words
// counts as objects).
const keep = (words, shape) =>
  [...new Set(words)]
    .filter((w) => shape.test(w) && spelled.has(w) && pleasant(w) && !REJECT.has(w))
    .sort();

const predicates = lines(predRaw);
const adjectives = keep(predicates.filter((w) => !w.endsWith('ing')), /^[a-z]{3,9}$/);
const nouns = keep(lines(objRaw), /^[a-z]{3,9}$/);
// friendly-words carries only 84 -ing words, short of the 109 needed, so the
// gerunds are topped up from corpora and filtered harder.
const gerunds = keep(
  [
    ...predicates.filter((w) => w.endsWith('ing')),
    ...JSON.parse(verbsRaw).map((v) => v.gerund?.[0]?.toLowerCase()).filter(Boolean),
  ],
  /^[a-z]{5,10}$/,
).filter((w) => w.endsWith('ing'));

// Stride sampling: deterministic in any language, no seed to reproduce, and it
// spreads the selection across the alphabet instead of taking one clump of it.
function stride(pool, n) {
  if (pool.length < n) throw new Error(`pool of ${pool.length} cannot yield ${n}`);
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool[Math.floor((i * pool.length) / n)]);
  if (new Set(out).size !== n) throw new Error('stride sampling produced duplicates');
  return out;
}

// Wrap so the arrays read like the rest of the file rather than one long line.
function wrap(words, width = 76) {
  const out = [];
  let line = '';
  for (const w of words.map((x) => `'${x}'`)) {
    const next = line ? `${line}, ${w}` : w;
    if (next.length > width) { out.push(`${line},`); line = w; } else { line = next; }
  }
  if (line) out.push(line);
  return out.join('\n  ');
}

process.stderr.write(
  `pools: ${adjectives.length} adjectives, ${gerunds.length} gerunds, ${nouns.length} nouns\n`,
);
for (const [name, pool] of [
  ['ADJECTIVES', adjectives], ['GERUNDS', gerunds], ['NOUNS', nouns],
]) {
  process.stdout.write(`const ${name} = [\n  ${wrap(stride(pool, COUNTS[name]))}\n];\n\n`);
}
```

- [ ] **Step 4: Run the build script and paste its output**

Run: `node tools/build-words.mjs > /tmp/gwqadd-words.js`
Expected on stderr: `pools: 1140 adjectives, 542 gerunds, 2512 nouns` (numbers may drift as the upstream sources change; anything above 216 / 109 / 407 is fine — the script throws if a pool is too small).

Insert the contents of `/tmp/gwqadd-words.js` into `bin/gwqadd.mjs` immediately above the `// ── naming (interactive only) ──` banner, under this header:

```js
// ── word lists (generated — do not hand-edit) ────────────────────────────────
//
// Regenerate with `node tools/build-words.mjs`. Editing these by hand drifts
// the counts from the recipe and discards the licence trail (I23).
//
// Adjectives and nouns: glitchdotcom/friendly-words, MIT (c) 2018 Glitch.
// Gerunds: dariusk/corpora, CC0.
//
// The counts match `claude -w` (216 * 109 * 407 = 9,582,408 names); the words
// deliberately do not. See the design doc for why they were not copied.
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test`
Expected: PASS, including the new word-list test.

- [ ] **Step 6: Keep the build script out of the tarball and credit the source**

Add to `.npmignore`:

```
tools/
docs/
```

Append to `LICENSE`:

```
---

This package embeds word lists derived from third-party sources:

glitchdotcom/friendly-words — https://github.com/glitchdotcom/friendly-words

MIT License

Copyright (c) 2018 Glitch

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

dariusk/corpora — https://github.com/dariusk/corpora — released under CC0
(public domain). No attribution is required; it is given anyway.
```

- [ ] **Step 7: Verify the tarball is unchanged in shape**

Run: `npm pack --dry-run`
Expected: `bin/gwqadd.mjs`, `LICENSE`, `README.md`, `package.json` only. No `tools/`, no `docs/`, no `test/`, no `.claude/`.

- [ ] **Step 8: Commit**

```bash
git add tools/build-words.mjs bin/gwqadd.mjs test/cli.test.mjs .npmignore LICENSE
git commit -m "feat: generated word lists for random branch names

216 adjectives, 109 gerunds and 407 nouns, built by tools/build-words.mjs
from friendly-words (MIT) and corpora (CC0), filtered for tone with VADER
and for spelling against words_alpha, then stride-sampled to the counts
claude -w uses. The words themselves are not claude's."
```

---

### Task 2: `randomName()` and the `--random` flag

**Files:**
- Modify: `bin/gwqadd.mjs` — imports (line 2-12), `options` block (line 131-146), the word-list section, `main()` (line 1054-1065), `finish()` (line 1176-1187)
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: `ADJECTIVES`, `GERUNDS`, `NOUNS` from Task 1; existing `hasLocalBranch(dir, branch)`, `worktreePath(dir, branch)`, `die(code, message)`, `isNonInteractive`.
- Produces:
  - `randomName(): string` — one name, no freshness check.
  - `freeRandomName(dir: string): string` — a name no branch and no worktree holds, or `''` after `RANDOM_TRIES` attempts.
  - `RANDOM_TRIES: number` = 10.
  - `values.random` / `values['no-random']` booleans; `randomFirst: boolean` (module level, false when `--no-random` or `GWQADD_RANDOM` is off).
  - `finish()` gains a `named` parameter: `'argument' | 'random' | 'ai' | 'manual'`, emitted as `"named"` in `--json`.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.mjs`:

```js
// ── random names ─────────────────────────────────────────────────────────────

const RANDOM_SHAPE = /^[a-z]{3,9}-[a-z]{5,10}-[a-z]{3,9}$/;

test('--random names and creates a branch with no terminal and no AI', () => {
  const ai = canaryAi();
  const r = spawnSync(process.execPath, [BIN, '--random', '--json', '-n'], {
    encoding: 'utf8',
    cwd: repo,
    env: {
      ...process.env, PATH: `${shimDir}:${process.env.PATH}`,
      NO_COLOR: '1', GWQADD_AI: ai.bin, FORCE_COLOR: undefined,
    },
  });
  const called = ai.called();
  rmSync(ai.dir, { recursive: true, force: true });

  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.match(j.branch, RANDOM_SHAPE);
  assert.match(j.branch.split('-')[1], /ing$/, 'the middle word is a gerund');
  assert.equal(j.named, 'random');
  assert.equal(j.created, 'branch+worktree');
  assert.equal(branchExists(j.branch), true);
  assert.equal(called, false, 'a random name must never reach for an AI');

  spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', j.path]);
  spawnSync('git', ['-C', repo, 'branch', '-D', j.branch]);
});

test('--random and an explicit branch name is a contradiction', () => {
  const r = run(['--random', '--json', '-n', 'feat/explicit']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_VALIDATION');
});

test('--random and --no-random together is a contradiction', () => {
  const r = run(['--random', '--no-random', '--json', '-n']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_VALIDATION');
});

test('an explicit branch name reports named=argument', () => {
  const j = out(run(['--json', '-n', 'feat/named-arg']));
  assert.equal(j.named, 'argument');
  spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', j.path]);
  spawnSync('git', ['-C', repo, 'branch', '-D', 'feat/named-arg']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `--random` is rejected by `parseArgs` as an unknown option, so the first three tests exit 1 for the wrong reason and the fourth reports `named: undefined`.

- [ ] **Step 3: Implement**

In `bin/gwqadd.mjs`, add to the `node:crypto` import (create the import line if absent, next to the other `node:` imports at the top):

```js
import { randomBytes } from 'node:crypto';
```

Add to the `options` object (after `'no-ai'`):

```js
      random: { type: 'boolean' },
      'no-random': { type: 'boolean' },
```

Below the word lists, add the generator:

```js
// ── random names ─────────────────────────────────────────────────────────────

// crypto, not Math.random: two shells started in the same second must not be
// able to agree on a branch name. The modulo biases the first few words of each
// list upward by about 407 / 2^32, which is invisible at any number of branches
// a person will ever create.
const pick = (a) => a[randomBytes(4).readUInt32BE(0) % a.length];
const randomName = () => `${pick(ADJECTIVES)}-${pick(GERUNDS)}-${pick(NOUNS)}`;

const RANDOM_TRIES = 10;

// `claude -w` lets a collision become a hard error; we reroll instead. The
// check has to happen before the name is shown, so the confirmation prompt can
// never offer something that cannot be created (I24). Ten failures in a
// 9,582,408-name space means our randomness is broken, not the user's luck.
function freeRandomName(dir) {
  for (let i = 0; i < RANDOM_TRIES; i++) {
    const name = randomName();
    if (!hasLocalBranch(dir, name) && !worktreePath(dir, name)) return name;
  }
  return '';
}
```

Next to the other flag-derived constants (near `const force = !!values.force;`):

```js
// The random-first prompt is the default; --no-random restores the 0.3.x flow
// of describing the work to an AI straight away.
const randomOff =
  !!values['no-random'] ||
  ['off', '0', 'false', 'none'].includes(process.env.GWQADD_RANDOM ?? '');
const randomFirst = !randomOff;

if (values.random && values['no-random']) {
  die('E_VALIDATION', '--random and --no-random cannot both be given');
}
```

In `main()`, replace the branch-resolution block (currently lines 1054-1065):

```js
  let branch = positionals[0];
  let named = 'argument';
  if (branch) {
    // A name on the command line is the user speaking; never second-guess it.
    if (values.random) {
      die('E_VALIDATION', '--random cannot be combined with a branch name');
    }
    // git would reject this later with a less obvious message.
    if (!validBranchName(branch)) {
      die('E_VALIDATION', `'${branch}' is not a valid branch name`);
    }
  } else if (isNonInteractive) {
    // --random is the one naming path that needs no terminal: it is arithmetic
    // over a constant array, so nothing is triggered that the caller did not
    // ask for by name (I15).
    if (!values.random) {
      die('E_VALIDATION', 'a branch name is required — `gwqadd <branch>`');
    }
    branch = freeRandomName(cwd);
    if (!branch) {
      die('E_VALIDATION',
        `could not find an unused random name in ${RANDOM_TRIES} tries — pass a branch name`);
    }
    named = 'random';
  } else {
    // composeBranchName only ever returns a name git has already accepted.
    ({ branch, named } = await composeBranchName(cwd, repo, base));
  }
```

Change `composeBranchName`'s two `return` statements so it returns the new shape — the AI path returns `{ branch: candidates[0], named: 'ai' }` on create, and every `typeItYourself()` result is wrapped as `{ branch: <name>, named: 'manual' }`. Task 4 rewrites the top of this function; for now the minimal change is enough to keep `main()` working:

```js
async function composeBranchName(dir, repo, base) {
  const ai = detectAi();
  if (!ai) return { branch: await typeItYourself(), named: 'manual' };

  const ctx = repoContext(dir, repo, base);
  const rejected = [];

  for (;;) {
    log(`${dim('│')}`);
    const description = await askLine(
      `${dim('│')} what do you want to do? ${dim('(any language)')}\n${dim('│')} ${dim('>')} `,
    );
    if (!description) return { branch: await typeItYourself(), named: 'manual' };

    const res = await askAi(ai, namingPrompt(ctx, description, rejected));
    if (!res.ok) {
      warn(`${aiLabel(ai)} failed — name it yourself instead`);
      const first = (res.err || '').trim().split('\n')[0];
      if (first) log(`${dim('│')} ${dim(first.slice(0, 120))}`);
      return { branch: await typeItYourself(), named: 'manual' };
    }
    const candidates = parseCandidates(res.out);
    if (candidates.length === 0) {
      warn(`${aiLabel(ai)} returned nothing usable — name it yourself instead`);
      return { branch: await typeItYourself(), named: 'manual' };
    }

    const choice = await confirmCreate(candidates[0], ctx.base);
    if (choice.create) return { branch: candidates[0], named: 'ai' };
    if (choice.edit) return { branch: await typeItYourself(candidates[0]), named: 'manual' };
    rejected.push(...candidates);
  }
}
```

Thread `named` through both `finish()` call sites in `main()` — the "worktree already exists" early return and the final one — and add the field to the payload in `finish()`:

```js
async function finish({ repo, branch, base, path, created, named }) {
  if (isJson) {
    process.stdout.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      path,
      branch,
      base: { ref: base.ref, sha: base.sha },
      repo: { root: repo.root, name: repo.name },
      created,
      // How the name was chosen, so a caller can tell a name it picked from one
      // the tool invented. Adding a field does not bump schemaVersion (I10).
      named,
      cd: !stayOut,
    }) + '\n');
    return;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all four new tests plus the whole existing suite. The existing test `without a TTY the naming layer never engages, AI included` must still pass unchanged — that is I15's surviving half.

- [ ] **Step 5: Confirm the shell function does not need a passthrough**

Run: `node bin/gwqadd.mjs --init zsh | grep -n 'h|--help'`
Expected: the case list is unchanged — `-h|--help|-V|--version|--init|--init=*|--json`.

`--random` and `--no-random` both end in a path on stdout, so they are exactly what the wrapper is supposed to capture. Nothing to add (I8b). Record this as checked; do not edit the snippet.

- [ ] **Step 6: Commit**

```bash
git add bin/gwqadd.mjs test/cli.test.mjs
git commit -m "feat: --random generates a branch name instead of asking

An adjective-gerund-noun name over crypto.randomBytes, checked free of
both a branch and a worktree before it is used. --random is the one
naming path allowed to run without a terminal (I15), which is what lets
an agent take an isolated worktree without inventing a label.

--json gains \"named\", so a caller can tell its own name from ours."
```

---

### Task 3: Reroll on collision, deterministically tested

**Files:**
- Modify: `bin/gwqadd.mjs` (no behaviour change expected — this task proves Task 2's `freeRandomName` and fixes it if it is wrong)
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: `freeRandomName(dir)` and `RANDOM_TRIES` from Task 2.
- Produces: `cliWithWords(adj, ger, noun)` test helper returning `{ root, bin }` — a runnable copy of the CLI whose word lists have been shrunk.

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.mjs`. Add `copyFileSync` to the `node:fs` import.

```js
// Shrinking the word lists in a *copy* of the CLI is how the reroll gets a
// deterministic test without a test-only hook in the shipped code. The copy
// needs a package.json one directory up, because bin/gwqadd.mjs reads its
// version from `new URL('../package.json', import.meta.url)`.
function cliWithWords(adj, ger, noun) {
  const root = mkdtempSync(join(tmpdir(), 'gwqadd-words-'));
  mkdirSync(join(root, 'bin'));
  copyFileSync(join(dirname(BIN), '..', 'package.json'), join(root, 'package.json'));
  const literal = (a) => `[${a.map((w) => `'${w}'`).join(', ')}]`;
  const src = source
    .replace(/const ADJECTIVES = \[[^\]]*\]/, `const ADJECTIVES = ${literal(adj)}`)
    .replace(/const GERUNDS = \[[^\]]*\]/, `const GERUNDS = ${literal(ger)}`)
    .replace(/const NOUNS = \[[^\]]*\]/, `const NOUNS = ${literal(noun)}`);
  const bin = join(root, 'bin', 'gwqadd.mjs');
  writeFileSync(bin, src);
  return { root, bin };
}

const runCli = (bin, args) => {
  const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', cwd: repo, env });
};

test('a taken random name is rerolled, not offered', () => {
  // Two possible names; one of them already exists, so only 'bb-humming-owl'
  // is available. Ten independent picks all landing on the taken half would
  // fail this — that is 1 in 1024, and is the price of testing the real
  // generator instead of a stubbed one.
  const { root, bin } = cliWithWords(['aa', 'bb'], ['humming'], ['owl']);
  git(repo, 'branch', 'aa-humming-owl');

  const r = runCli(bin, ['--random', '--json', '-n']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.branch, 'bb-humming-owl');

  spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', j.path]);
  spawnSync('git', ['-C', repo, 'branch', '-D', 'bb-humming-owl']);
  gitTry(repo, 'branch', '-D', 'aa-humming-owl');
  rmSync(root, { recursive: true, force: true });
});

test('exhausting the rerolls without a terminal is E_VALIDATION, not a hang', () => {
  // One possible name, and it is taken. Every reroll must fail, and the
  // non-interactive path cannot fall through to a prompt nobody can answer.
  const { root, bin } = cliWithWords(['aa'], ['humming'], ['owl']);
  git(repo, 'branch', 'aa-humming-owl');

  const r = runCli(bin, ['--random', '--json', '-n']);
  assert.equal(r.status, 1);
  const err = jsonLine(r.stderr).error;
  assert.equal(err.code, 'E_VALIDATION');
  assert.match(err.message, /random name/);

  gitTry(repo, 'branch', '-D', 'aa-humming-owl');
  rmSync(root, { recursive: true, force: true });
});

test('a random name is skipped when a worktree holds it without a branch', () => {
  // worktreePath() is the second half of the freshness check and is easy to
  // drop; this is the test that notices.
  const { root, bin } = cliWithWords(['aa', 'bb'], ['humming'], ['owl']);
  git(repo, 'branch', 'aa-humming-owl');
  git(repo, 'worktree', 'add', join(wtBase, 'aa-humming-owl'), 'aa-humming-owl');

  const r = runCli(bin, ['--random', '--json', '-n']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).branch, 'bb-humming-owl');

  const j = JSON.parse(r.stdout);
  spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', j.path]);
  spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', join(wtBase, 'aa-humming-owl')]);
  gitTry(repo, 'branch', '-D', 'aa-humming-owl');
  gitTry(repo, 'branch', '-D', 'bb-humming-owl');
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they pass or fail meaningfully**

Run: `npm test`
Expected: PASS if Task 2's `freeRandomName` is correct. If any fail, the bug is in `freeRandomName` — fix it there, not in the test. The most likely defect is calling `worktreePath` with the wrong argument order or forgetting it entirely.

- [ ] **Step 3: Commit**

```bash
git add test/cli.test.mjs
git commit -m "test: prove the random-name reroll and its exhaustion path

Shrinking the word lists in a copy of the CLI makes the generator
predictable, so the reroll and the ten-try give-up can be tested without
putting a test hook in the shipped code."
```

---

### Task 4: The interactive flow — random first, `r` to reroll

**Files:**
- Modify: `bin/gwqadd.mjs` — `confirmCreate()` (line 840-857), `composeBranchName()` (line 859-899)
- Test: `test/cli.test.mjs` (what is reachable without a terminal), plus the manual matrix in Task 6

**Interfaces:**
- Consumes: `freeRandomName(dir)`, `randomFirst`, `typeItYourself(initial)`, `confirmCreate`.
- Produces:
  - `confirmCreate(name, baseRef, { reroll = false } = {})` → `{ create: true } | { again: true } | { edit: true } | { reroll: true }`.
  - `offerRandom(dir, baseRef)` → `{ branch, named } | null` — `null` means the user pressed `n` and wants the AI flow.
  - `composeBranchName(dir, repo, base)` → `{ branch, named }` (unchanged from Task 2).

- [ ] **Step 1: Write the failing tests**

Append to `test/cli.test.mjs`:

```js
test('--no-random leaves the non-interactive contract exactly as it was', () => {
  const ai = canaryAi();
  const r = spawnSync(process.execPath, [BIN, '--no-random', '--json'], {
    encoding: 'utf8',
    cwd: repo,
    env: {
      ...process.env, PATH: `${shimDir}:${process.env.PATH}`,
      NO_COLOR: '1', GWQADD_AI: ai.bin, FORCE_COLOR: undefined,
    },
  });
  const called = ai.called();
  rmSync(ai.dir, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_VALIDATION');
  assert.equal(called, false);
});

test('GWQADD_RANDOM=off is accepted and changes nothing non-interactively', () => {
  const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, NO_COLOR: '1', GWQADD_RANDOM: 'off' };
  delete env.FORCE_COLOR;
  const r = spawnSync(process.execPath, [BIN, '--json', '-n', 'feat/env-off'], {
    encoding: 'utf8', cwd: repo, env,
  });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.branch, 'feat/env-off');
  spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', j.path]);
  spawnSync('git', ['-C', repo, 'branch', '-D', 'feat/env-off']);
});

test('--help documents the random path and how to turn it off', () => {
  const h = run(['--help']).stdout;
  assert.match(h, /--random/);
  assert.match(h, /--no-random/);
  assert.match(h, /GWQADD_RANDOM/);
  assert.match(h, /reroll/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `--no-random` is unknown to `parseArgs` only if Task 2 was skipped; otherwise the first two pass and the `--help` test fails on `/--random/`.

- [ ] **Step 3: Implement the reroll key**

Replace `confirmCreate` in `bin/gwqadd.mjs`:

```js
// The single checkpoint before anything is created. `n` sends the user back to
// describing the work, which is what they asked for; `e` is there because a
// suggestion that is one word off should not cost another round trip; `r` only
// appears for a random name, where rerolling costs nothing at all.
async function confirmCreate(name, base, { reroll = false } = {}) {
  log(`${dim('│')}`);
  log(`${dim('│')} ${bold(cyan(name))}   ${dim(`off ${base}`)}`);
  const no = reroll ? '[n]o, name it properly' : '[n]o, describe again';
  const extra = reroll ? ` ${dim('·')} ${dim('[r]eroll')}` : '';
  stderr.write(
    `${dim('│')} create it? ${dim('[Y]es')} ${dim('·')} ${dim(no)} ` +
    `${dim('·')} ${dim('[e]dit the name')}${extra} `,
  );
  for (;;) {
    const buf = await waitForKey();
    if (buf.includes(0x03) || buf[0] === 0x1b) { stderr.write('\n'); die('E_INTERRUPTED', 'cancelled'); }
    const c = buf[0];
    if (c === 0x79 || c === 0x59 || c === 0x0d || c === 0x0a) { stderr.write('\n'); return { create: true }; }
    if (c === 0x6e || c === 0x4e) { stderr.write('\n'); return { again: true }; }
    if (c === 0x65 || c === 0x45) { stderr.write('\n'); return { edit: true }; }
    if (reroll && (c === 0x72 || c === 0x52)) { stderr.write('\n'); return { reroll: true }; }
  }
}
```

- [ ] **Step 4: Implement the random-first offer**

Add above `composeBranchName`:

```js
// The fast half of the naming layer: a name appears with no prompt, no
// subprocess and no network, and the expensive path costs one keystroke.
// Returns null when the user wants to describe the work to an AI instead.
async function offerRandom(dir, baseRef) {
  for (;;) {
    const name = freeRandomName(dir);
    if (!name) {
      warn(`could not find an unused random name in ${RANDOM_TRIES} tries — name it yourself instead`);
      return { branch: await typeItYourself(), named: 'manual' };
    }
    const choice = await confirmCreate(name, baseRef, { reroll: true });
    if (choice.create) return { branch: name, named: 'random' };
    if (choice.edit) return { branch: await typeItYourself(name), named: 'manual' };
    if (choice.reroll) continue;
    return null; // `n` — fall through to describing the work
  }
}
```

Then give `composeBranchName` its new opening. Insert directly after the function's first line:

```js
async function composeBranchName(dir, repo, base) {
  // Random first: it is free, and a user who wanted to think about the name
  // is one keystroke away from the prompt that lets them.
  if (randomFirst || values.random) {
    const chosen = await offerRandom(dir, base.ref);
    if (chosen) return chosen;
  }

  const ai = detectAi();
  if (!ai) return { branch: await typeItYourself(), named: 'manual' };
  // …the rest is unchanged from Task 2
```

Note the base: `offerRandom` takes `base.ref` (a string), matching what `confirmCreate` already receives from the AI path as `ctx.base`.

- [ ] **Step 5: Update `--help`**

In the `HELP` template, add to `OPTIONS` after `--no-ai`:

```
  --random           skip the questions and generate a name
  --no-random        start by describing the work instead of rolling a name
```

Replace the `NAMING HELP` section's opening paragraph with:

```
NAMING HELP
  Run ${PKG} with no branch name and it rolls one immediately — three words,
  no prefix, no waiting:

    Y  create it     n  name it properly     e  edit the name     r  reroll

  Nothing has been sent anywhere and nothing has been created at that point.
  Press n and it asks what you want to do, in any language, and hands that to
  an AI CLI which answers with one name in this repository's own style:

    Y  create it        n  describe it again        e  edit the name
```

and add, after the paragraph about `GWQADD_AI`:

```
  --no-random (or GWQADD_RANDOM=off) starts at the description prompt instead.
  --random goes the other way and never asks; it is the only naming path that
  works without a terminal, which is what scripts and agents should use.
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 7: Drive the interactive flow by hand**

The interactive path cannot be automated here — macOS `script` calls `tcgetattr` on its own stdin and fails under a pipe, and a real pty would mean a dependency. Run these in a terminal, inside this repository:

| Do | Expect |
| --- | --- |
| `node bin/gwqadd.mjs` | a three-word name appears instantly; no AI process starts |
| press `r` three times | a different name each time, still instant |
| press `e` | the prompt is pre-filled with the rolled name |
| press `n` | today's "what do you want to do?" prompt, then the AI |
| press `Esc` | exit 130, nothing created, no error line |
| `node bin/gwqadd.mjs --no-random` | straight to the description prompt |
| `GWQADD_RANDOM=off node bin/gwqadd.mjs` | same |

Delete any worktrees and branches these create before moving on.

- [ ] **Step 8: Commit**

```bash
git add bin/gwqadd.mjs test/cli.test.mjs
git commit -m "feat: offer a random name first, one keystroke from the AI

Interactive gwqadd now rolls a name before it asks anything, so the
common case costs nothing and the 6-8 second AI round trip costs a key.
r rerolls, n falls through to describing the work exactly as before."
```

---

### Task 5: Documentation and invariants

**Files:**
- Modify: `README.md`, `.claude/skills/gwqadd/SKILL.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: the finished behaviour from Tasks 1-4.
- Produces: no code.

- [ ] **Step 1: Amend the two invariants this changes**

In `CLAUDE.md`, rewrite the body of **I15** to:

```markdown
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
```

Append to **I18**:

```markdown
This applies to the AI path. The random path emits no prefix at all — a random
name carries no information, so a `feat/` in front of it would claim a category
nobody chose. It is the only naming path in this tool that ignores the
repository's convention, and the shape is the point: three hyphenated words
with no slash is not a shape a person types, so `git branch` output separates
real branches from scratch worktrees at a glance.
```

Add two new invariants after I22:

```markdown
### I23. The word lists are generated, and their provenance is recorded

`tools/build-words.mjs` is the only way `ADJECTIVES`, `GERUNDS` and `NOUNS` are
produced. Hand-editing them drifts the counts from the recipe and quietly
discards the licence trail. The script is a maintainer tool: it is in
`.npmignore`, it is absent from `files`, and nothing at install or run time
calls it.

Adjectives and nouns come from glitchdotcom/friendly-words (MIT © 2018 Glitch,
notice reproduced in `LICENSE`); gerunds from dariusk/corpora (CC0). VADER (MIT)
filters tone and dwyl/english-words (Unlicense) filters spelling, both at build
time only — neither is shipped.

The counts match `claude -w` (216 × 109 × 407 = 9,582,408). **The words do not.**
Lifting 732 hand-curated words out of a proprietary binary into an MIT package
is a licence question with no upside. There is a test asserting the counts, the
sort order, uniqueness and the character classes; it is the regression test for
a hand-edit.

### I24. A random name is checked before it is offered, never after

`claude -w` lets a collision become a hard error telling the user to pass a
different name. `freeRandomName()` rerolls instead: both `hasLocalBranch` and
`worktreePath` must be clear before a name reaches the user, so the
confirmation prompt can never propose something that cannot be created. Ten
failures means our randomness is broken, not the user's luck — without a
terminal that is `E_VALIDATION`, with one it falls through to
`typeItYourself()`.

Both the reroll and the exhaustion path are tested by running a copy of the CLI
whose word lists have been shrunk to one or two words. Keep that helper: it is
what lets the real generator be tested without a test hook in shipped code.
```

Add to the **Testing** matrix in `CLAUDE.md`:

```markdown
| Random, then reroll | `gwqadd`, press `r` a few times | a new name each time, instantly |
| Random, then AI | `gwqadd`, press `n` | the description prompt, then the AI |
| Random off | `gwqadd --no-random` | straight to the description prompt |
```

Add to **Where things live**:

```markdown
- `tools/build-words.mjs` — regenerates the three word lists. Not shipped.
- `docs/superpowers/specs/` — design docs. Not shipped.
```

Remove "A prompt library, a logger, or a clipboard package" — no, leave **Things that are intentionally NOT here** alone except to append:

```markdown
- **A `--words` file or `GWQADD_WORDS` override.** The shape of a random branch
  name should be predictable to anyone reading `git branch`.
- **`--expires` defaulting on for random names.** A random name suggests a
  throwaway, but expiry is destructive-adjacent policy and stays explicit.
```

- [ ] **Step 2: Update the agent contract**

In `.claude/skills/gwqadd/SKILL.md`, add after the "Recommended call" section:

```markdown
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
chose. `--random` and an explicit branch name together are an error.

Use a real name when the branch will be pushed, reviewed or discussed.
```

Update the JSON example in that file to include `"named"`.

- [ ] **Step 3: Update the README**

In `README.md`, add `--random` and `--no-random` to the options table, and add a short section after the existing naming section:

```markdown
### No name? Take a random one

Run `gwqadd` with no branch name and it rolls one before it asks you anything:

```
│ plume-melting-bearskin   off main
│ create it? [Y]es · [n]o, name it properly · [e]dit · [r]eroll
```

Three words, no prefix, no waiting — nothing has been sent anywhere and nothing
created. `r` rolls again, `e` edits it, and `n` drops you into the "what do you
want to do?" prompt where an AI names the branch in your repository's own style.

`--random` skips the confirmation and is the only naming path that works without
a terminal, which makes it the one scripts and agents should use. `--no-random`
(or `GWQADD_RANDOM=off`) starts at the description prompt instead.
```

- [ ] **Step 4: Verify the docs match the build**

Run: `node bin/gwqadd.mjs --help`
Expected: the `--random` / `--no-random` lines and the `Y n e r` legend appear, and the text matches what the README claims.

Run: `npm test`
Expected: PASS, including the `--help` assertions from Task 4.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md .claude/skills/gwqadd/SKILL.md
git commit -m "docs: random branch names, and the two invariants they amend

I15 gains a --random exception to its interactive-only rule, I18 gains
the note that the random path is the one with no prefix, and I23/I24
record where the words come from and why a taken name is rerolled rather
than turned into an error.

SKILL.md is an agent-facing interface change: gwqadd --random -n --json
is now the documented way to take an isolated worktree without inventing
a branch name."
```

---

### Task 6: Full verification

**Files:** none modified.

**Interfaces:**
- Consumes: everything above.
- Produces: a release-ready branch. **Stops before `npm version` and `npm publish`** — those are the user's call.

- [ ] **Step 1: Run the whole suite**

Run: `npm test`
Expected: PASS with zero failing subtests. Paste the summary line into the completion report; do not claim success without it.

- [ ] **Step 2: Run the publish gate without publishing**

Run: `npm pack --dry-run && node bin/gwqadd.mjs --help && node bin/gwqadd.mjs --version`
Expected: the tarball lists `bin/gwqadd.mjs`, `LICENSE`, `README.md`, `package.json` and nothing else — specifically no `tools/`, `docs/`, `test/`, `.claude/` or `CLAUDE.md`. Help and version both print.

- [ ] **Step 3: Prove the shell integration still moves the shell**

`zsh -n` is happy with a function that cds into a help page, so syntax checking is not enough — run the function.

```bash
zsh -c 'eval "$(node bin/gwqadd.mjs --init zsh)"; gwqadd --version; gwqadd --help | head -1'
bash -c 'eval "$(node bin/gwqadd.mjs --init bash)"; gwqadd --version'
```

Expected: version and help print normally; the shell does not try to `cd` into either.

- [ ] **Step 4: Run the manual matrix**

Everything in Task 4 Step 7, plus:

| Do | Expect |
| --- | --- |
| `node bin/gwqadd.mjs --random` in a real repo, twice | two different worktrees under gwq's basedir, no collision |
| `node bin/gwqadd.mjs --random > out.txt` | the box on the terminal, `out.txt` empty (I1) |
| `node bin/gwqadd.mjs --random feat/x` | exit 1, `E_VALIDATION` |
| `PATH=/usr/bin:/bin node bin/gwqadd.mjs --random` | works — the random path needs no AI |

Clean up the worktrees and branches afterwards with `gwq remove` / `git branch -D`.

- [ ] **Step 5: Report and hand back**

Report: the `npm test` summary, the `npm pack --dry-run` file list, and which manual rows were actually run. Say plainly which were not.

Do **not** run `npm version` or `npm publish`. Ask whether to cut a release; it is a minor bump (new flags, new `--json` field, no removals).

---

## Self-review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| Name shape — bare three words | Task 2 (`randomName`) |
| The flow — random first, `Y`/`n`/`e`/`r` | Task 4 |
| Flags — `--random`, `--no-random`, `GWQADD_RANDOM` | Tasks 2, 4 |
| `--random` + positional is `E_VALIDATION` | Task 2 |
| `--random` legal without a terminal | Task 2 |
| Generator — `crypto.randomBytes`, three picks | Task 2 |
| Collision reroll, ten tries | Tasks 2, 3 |
| Word list provenance and licences | Task 1 |
| Build recipe — filters, stride sampling | Task 1 |
| `I15` / `I18` amendments, `I23` / `I24` | Task 5 |
| `--json` `named` field | Task 2 |
| `SKILL.md` agent contract | Task 5 |
| Test plan — automated 7, manual 8 | Tasks 1-4, 6 |

No spec requirement is unassigned.

**Gaps found and closed while writing this plan:**

1. **Non-interactive exhaustion was undefined.** The spec sends the ten-collision fallback to `typeItYourself()`, which cannot run without a terminal. Closed above: `E_VALIDATION`, no new exit code, tested in Task 3.
2. **The spec did not say how the word lists get tested.** Importing `bin/gwqadd.mjs` runs `main()`, so Task 1 parses the arrays out of the source instead.
3. **`composeBranchName`'s return type changes** from `string` to `{ branch, named }`. The spec's `named` field implied it but did not say it; Task 2 rewrites every `return` in that function so no path is missed.
4. **`I8b` needed checking, not changing.** `--random` yields a path, so the `--init` passthrough list stays as it is. Task 2 Step 5 records the check rather than leaving it to be rediscovered.

**Type consistency:** `freeRandomName(dir)` returns `string` (`''` on failure) in Tasks 2, 3 and 4. `confirmCreate(name, baseRef, opts)` takes a **string** base in both call sites, matching the existing AI path's `ctx.base`. `composeBranchName` returns `{ branch, named }` in Tasks 2 and 4. `named` is `'argument' | 'random' | 'ai' | 'manual'` everywhere.
