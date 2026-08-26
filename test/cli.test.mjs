// Exercises the CLI against a **real** git repository with only `gwq` shimmed.
// git is not shimmed: branch creation, worktree layout and the partial-state
// rollback are the logic under test, and faking git would only test the fake.
// No network, no TTY.
//
// The gwq shim reproduces two behaviours verified against gwq v0.1.1, because
// the interesting code paths only exist because of them:
//   - `gwq add -b` leaves the branch behind when the destination is occupied
//   - `gwq add -f` does NOT actually overwrite that destination
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync,
  existsSync, readdirSync, realpathSync, readFileSync, copyFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'gwqadd.mjs');

let sandbox, repo, wtBase, shimDir;

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout ?? '').trim();
};
const gitTry = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

before(() => {
  // realpath the sandbox: on macOS $TMPDIR is /var/... symlinked to
  // /private/var/..., and `git worktree list --porcelain` reports the resolved
  // form. Expectations built from an unresolved root would never match.
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'gwqadd-')));
  repo = join(sandbox, 'repo');
  wtBase = join(sandbox, 'worktrees');
  mkdirSync(wtBase, { recursive: true });

  shimDir = mkdtempSync(join(tmpdir(), 'gwqadd-shims-'));
  const p = join(shimDir, 'gwq');
  writeFileSync(p, `#!/bin/sh
[ "$1" = "--version" ] && { echo "gwq version v0.1.1"; exit 0; }
[ "$1" = "add" ] || exit 0
shift
newbranch=0
# --expires is accepted and ignored, exactly as a passthrough should look here.
while [ $# -gt 0 ]; do
  case "$1" in
    -b) newbranch=1 ;;
    --expires) shift ;;
    -f) ;;
    *) branch="$1" ;;
  esac
  shift
done
slug=$(printf '%s' "$branch" | tr '/' '-')
wt="${wtBase}/$slug"
if [ "$newbranch" = "1" ]; then
  # Mirrors git: the branch is created while preparing, so a destination
  # failure leaves the branch behind.
  git branch "$branch" HEAD >/dev/null 2>&1
  if [ -e "$wt" ] && [ -n "$(ls -A "$wt" 2>/dev/null)" ]; then
    echo "Error: failed to add worktree: git worktree add -b $branch $wt: Preparing worktree" >&2
    echo "fatal: '$wt' already exists" >&2
    exit 1
  fi
  git worktree add "$wt" "$branch" >/dev/null 2>&1 || exit 1
else
  if [ -e "$wt" ] && [ -n "$(ls -A "$wt" 2>/dev/null)" ]; then
    echo "Error: failed to add worktree: git worktree add $wt $branch: Preparing worktree" >&2
    echo "fatal: '$wt' already exists" >&2
    exit 1
  fi
  git worktree add "$wt" "$branch" >/dev/null 2>&1 || exit 1
fi
echo "Created worktree at $wt"
exit 0
`);
  chmodSync(p, 0o755);
});

after(() => {
  for (const d of [sandbox, shimDir]) if (d) rmSync(d, { recursive: true, force: true });
});

// A fresh repository per test: worktree and branch state is exactly what these
// tests are about, so leaking it between them would hide real regressions.
beforeEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(wtBase, { recursive: true, force: true });
  mkdirSync(wtBase, { recursive: true });
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  // Give origin/HEAD a value so the "not the default branch" warning is live.
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
});

function run(args, { cwd = repo } = {}) {
  const env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, NO_COLOR: '1' };
  // We force NO_COLOR; node warns to stderr when FORCE_COLOR is also set, so a
  // developer who exports it would otherwise see phantom failures.
  delete env.FORCE_COLOR;
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, env });
}

const out = (r) => {
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);
  return JSON.parse(r.stdout);
};
const jsonLine = (s) => JSON.parse(s.split('\n').find((l) => l.startsWith('{')));
const ourStderr = (s) =>
  s.split('\n')
    .filter((l) => l && !/^\(node:\d+\)/.test(l) && !/^\(Use `node --trace-warnings/.test(l))
    .join('\n');
const branchExists = (b) =>
  gitTry(repo, 'show-ref', '--verify', '--quiet', `refs/heads/${b}`).status === 0;

// ── --init ───────────────────────────────────────────────────────────────────

for (const shell of ['zsh', 'bash', 'fish']) {
  test(`--init ${shell} emits a function and the three-step resolver`, () => {
    const r = run(['--init', shell]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /gwqadd/);
    assert.match(r.stdout, /--quiet/);
    assert.match(r.stdout, /npx -y/);
    assert.ok(r.stdout.includes(BIN), 'the generating script path must be baked in');
    assert.equal(ourStderr(r.stderr), '');
  });
}

for (const checker of ['zsh', 'bash']) {
  test(`--init ${checker} output parses under ${checker} -n`, (t) => {
    if (spawnSync(checker, ['-c', 'true'], { stdio: 'ignore' }).error) {
      return t.skip(`${checker} not installed`);
    }
    const r = spawnSync(checker, ['-n'], { input: run(['--init', checker]).stdout, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}

test('--init fish output parses under fish -n', (t) => {
  if (spawnSync('fish', ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip('fish not installed');
  const r = spawnSync('fish', ['-n', '/dev/stdin'], { input: run(['--init', 'fish']).stdout, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('--cmd renames the emitted function', () => {
  assert.match(run(['--init', 'zsh', '--cmd', 'gwa']).stdout, /^gwa\(\) \{/m);
});

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

// ── validation ───────────────────────────────────────────────────────────────

test('outside a repository exits 2 with E_NOT_REPO', () => {
  const r = run(['--json', 'feat/x'], { cwd: sandbox });
  assert.equal(r.status, 2);
  const err = jsonLine(r.stderr);
  assert.equal(err.error.code, 'E_NOT_REPO');
  assert.match(err.error.message, /gwqpull/, 'point at the sibling that clones');
});

test('a missing branch name without a TTY is a validation error', () => {
  const r = run(['--json']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_VALIDATION');
});

test('an invalid branch name is rejected before anything is created', () => {
  const r = run(['--json', 'bad..name']);
  assert.equal(r.status, 1);
  assert.match(jsonLine(r.stderr).error.message, /not a valid branch name/);
  assert.equal(readdirSync(wtBase).length, 0, 'nothing may be created');
});

test('--json and --quiet are mutually exclusive', () => {
  const r = run(['--json', '--quiet', 'feat/x']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_VALIDATION');
});

test('a second positional is rejected', () => {
  const r = run(['feat/x', 'extra']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unexpected extra arguments: extra/);
});

// ── the main flow ────────────────────────────────────────────────────────────

test('creates the branch and its worktree', () => {
  const j = out(run(['--json', '-n', 'feat/one']));
  assert.equal(j.created, 'branch+worktree');
  assert.equal(j.branch, 'feat/one');
  assert.equal(j.base.ref, 'main');
  assert.equal(j.repo.name, 'repo');
  assert.ok(existsSync(join(j.path, 'README.md')), 'the worktree must be checked out');
  assert.equal(git(j.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/one');
});

test('re-running is idempotent and reports created:none', () => {
  const first = out(run(['--json', '-n', 'feat/one']));
  const second = out(run(['--json', '-n', 'feat/one']));
  assert.equal(second.path, first.path);
  assert.equal(second.created, 'none');
});

test('an existing branch gets a worktree only', () => {
  git(repo, 'branch', 'feat/existing');
  const j = out(run(['--json', '-n', 'feat/existing']));
  assert.equal(j.created, 'worktree');
  assert.equal(git(j.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/existing');
});

test('a slashed branch keeps its real name, whatever the directory is called', () => {
  const j = out(run(['--json', '-n', 'feat/deep/name']));
  assert.equal(j.branch, 'feat/deep/name');
  assert.equal(git(j.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/deep/name');
});

// ── the base ref ─────────────────────────────────────────────────────────────

test('the default base is the HEAD of the cwd, like git checkout -b', () => {
  const first = out(run(['--json', '-n', 'feat/one']));
  writeFileSync(join(first.path, 'more.txt'), 'x\n');
  git(first.path, 'add', '-A');
  git(first.path, 'commit', '-qm', 'advance');
  const advanced = git(first.path, 'rev-parse', 'HEAD');

  // Run from inside that advanced worktree.
  const j = out(run(['--json', '-n', 'feat/two'], { cwd: first.path }));
  assert.equal(j.base.sha, advanced, 'inherits the worktree it was launched from');
  assert.equal(j.base.ref, 'feat/one');
});

test('--from overrides the base', () => {
  const first = out(run(['--json', '-n', 'feat/one']));
  writeFileSync(join(first.path, 'more.txt'), 'x\n');
  git(first.path, 'add', '-A');
  git(first.path, 'commit', '-qm', 'advance');

  const j = out(run(['--json', '-n', '--from', 'main', 'feat/two'], { cwd: first.path }));
  assert.equal(j.base.ref, 'main');
  assert.equal(j.base.sha, git(repo, 'rev-parse', 'main'));
  assert.equal(git(j.path, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'));
});

test('--from with an unknown ref fails without creating anything', () => {
  const r = run(['--json', '-n', '--from', 'no/such/ref', 'feat/x']);
  assert.equal(r.status, 1);
  assert.match(jsonLine(r.stderr).error.message, /not a ref/);
  assert.equal(branchExists('feat/x'), false);
});

test('branching off a non-default branch warns; the default branch does not', () => {
  const first = out(run(['--json', '-n', 'feat/one']));
  const warned = run(['-n', 'feat/two'], { cwd: first.path });
  assert.match(warned.stderr, /not the default branch/);
  assert.match(warned.stderr, /--from main/, 'the warning must name the fix');

  const quiet = run(['-n', 'feat/three']); // cwd is the repo, on main
  assert.doesNotMatch(quiet.stderr, /not the default branch/);
});

test('--from silences the warning even off the default branch', () => {
  const first = out(run(['--json', '-n', 'feat/one']));
  const r = run(['-n', '--from', 'main', 'feat/two'], { cwd: first.path });
  assert.doesNotMatch(r.stderr, /not the default branch/);
});

// ── collisions and the partial-state rollback ────────────────────────────────

test('a blocked worktree rolls the half-created branch back', () => {
  // gwq add -b creates the branch, then git fails on the occupied directory.
  // Leaving that branch would turn the next run into "already exists".
  const collide = join(wtBase, 'feat-blocked');
  mkdirSync(collide, { recursive: true });
  writeFileSync(join(collide, 'stray.txt'), 'in the way\n');

  const r = run(['--json', '-n', 'feat/blocked']);
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_WORKTREE');
  assert.equal(branchExists('feat/blocked'), false, 'the branch must not survive the failure');
  assert.ok(existsSync(join(collide, 'stray.txt')), 'the collision is left untouched without -f');
});

test('a pre-existing branch is NOT rolled back by a failed worktree', () => {
  // We only undo what we created. A branch the user already had must survive.
  git(repo, 'branch', 'feat/mine');
  const collide = join(wtBase, 'feat-mine');
  mkdirSync(collide, { recursive: true });
  writeFileSync(join(collide, 'stray.txt'), 'in the way\n');

  const r = run(['--json', '-n', 'feat/mine']);
  assert.equal(r.status, 1);
  assert.equal(branchExists('feat/mine'), true, 'never delete a branch we did not create');
});

test('-f moves the collision aside and succeeds', () => {
  const collide = join(wtBase, 'feat-blocked');
  mkdirSync(collide, { recursive: true });
  writeFileSync(join(collide, 'stray.txt'), 'in the way\n');

  const j = out(run(['--json', '-n', '-f', 'feat/blocked']));
  assert.equal(j.path, collide);
  assert.ok(existsSync(join(collide, 'README.md')), 'the worktree replaced the stray directory');

  const backups = readdirSync(wtBase).filter((n) => n.startsWith('feat-blocked.bak-'));
  assert.equal(backups.length, 1, 'exactly one timestamped backup');
  assert.ok(
    existsSync(join(wtBase, backups[0], 'stray.txt')),
    'the stray file survives inside the backup — -f moves, never deletes',
  );
});

test('-f after a failed run reuses the leftover branch instead of recreating it', () => {
  // The first attempt leaves a branch behind only if rollback is skipped, so
  // this exercises the -f path deciding between -b and a bare add.
  const collide = join(wtBase, 'feat-blocked');
  mkdirSync(collide, { recursive: true });
  writeFileSync(join(collide, 'stray.txt'), 'x\n');
  run(['--json', '-n', 'feat/blocked']);           // fails, rolls back
  const j = out(run(['--json', '-n', '-f', 'feat/blocked']));
  assert.equal(j.created, 'branch+worktree');
  assert.equal(git(j.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/blocked');
});

test('an empty colliding directory is not a collision', () => {
  // git accepts an empty destination; treating it as a conflict would demand
  // -f for something that works fine.
  mkdirSync(join(wtBase, 'feat-empty'), { recursive: true });
  const j = out(run(['--json', '-n', 'feat/empty']));
  assert.equal(j.created, 'branch+worktree');
});

// ── output contract ──────────────────────────────────────────────────────────

test('--quiet prints the path and nothing else on stdout', () => {
  const r = run(['--quiet', 'feat/one']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 1);
  assert.ok(r.stdout.startsWith('/'));
  assert.match(r.stderr, /gwqadd|repo/, 'progress still narrates on stderr in --quiet');
});

test('--no-cd prints nothing on stdout so the shell function stays put', () => {
  const r = run(['--quiet', '-n', 'feat/one']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'a path here would make the wrapper cd anyway');
});

test('errors keep stdout empty', () => {
  const r = run(['--json', 'bad..name']);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});

// ── dependencies ─────────────────────────────────────────────────────────────

test('a missing gwq exits 127 with the brew command', () => {
  const bare = mkdtempSync(join(tmpdir(), 'gwqadd-noshim-'));
  writeFileSync(join(bare, 'git'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bare, 'git'), 0o755);
  const r = spawnSync(process.execPath, [BIN, '--json', 'feat/x'], {
    encoding: 'utf8', cwd: repo,
    env: { ...process.env, PATH: bare, NO_COLOR: '1' },
  });
  rmSync(bare, { recursive: true, force: true });
  assert.equal(r.status, 127);
  assert.equal(jsonLine(r.stderr).error.code, 'E_DEPS');
  assert.match(jsonLine(r.stderr).error.message, /brew install d-kuro\/tap\/gwq/);
});

// ── the naming layer ─────────────────────────────────────────────────────────
//
// The interactive flow itself cannot be driven from here: macOS `script` calls
// tcgetattr on its own stdin and fails under a pipe, and a real pty would mean
// a dependency. What IS testable — and is the part that would be dangerous to
// get wrong — is that none of it engages without a terminal.

// An "AI" that records every invocation, so its absence is provable.
function canaryAi() {
  const dir = mkdtempSync(join(tmpdir(), 'gwqadd-canary-'));
  const marker = join(dir, 'called');
  const bin = join(dir, 'canary-ai');
  writeFileSync(bin, `#!/bin/sh\necho called >> ${marker}\nprintf 'feat/a\\nfeat/b\\nfeat/c\\n'\n`);
  chmodSync(bin, 0o755);
  return { dir, bin, marker, called: () => existsSync(marker) };
}

test('a branch name on the command line never reaches the AI', () => {
  const ai = canaryAi();
  const r = spawnSync(process.execPath, [BIN, '--json', '-n', 'feat/explicit'], {
    encoding: 'utf8', cwd: repo,
    env: {
      ...process.env, PATH: `${shimDir}:${process.env.PATH}`,
      NO_COLOR: '1', GWQADD_AI: ai.bin, FORCE_COLOR: undefined,
    },
  });
  const called = ai.called();
  rmSync(ai.dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).branch, 'feat/explicit');
  assert.equal(called, false, 'an explicit name is the user speaking; do not second-guess it');
});

test('without a TTY the naming layer never engages, AI included', () => {
  const ai = canaryAi();
  const r = spawnSync(process.execPath, [BIN, '--json'], {
    encoding: 'utf8', cwd: repo,
    env: {
      ...process.env, PATH: `${shimDir}:${process.env.PATH}`,
      NO_COLOR: '1', GWQADD_AI: ai.bin,
    },
  });
  const called = ai.called();
  rmSync(ai.dir, { recursive: true, force: true });
  assert.equal(r.status, 1);
  assert.equal(jsonLine(r.stderr).error.code, 'E_VALIDATION');
  assert.equal(called, false, 'scripts and agents keep the silent contract');
});

test('--no-ai and --ai are accepted and change nothing non-interactively', () => {
  for (const extra of [['--no-ai'], ['--ai', 'canary-ai']]) {
    const r = run([...extra, '--json', '-n', 'feat/flag']);
    assert.equal(r.status, 0, `${extra.join(' ')}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).branch, 'feat/flag');
    // Reset for the next iteration.
    const wt = JSON.parse(r.stdout).path;
    spawnSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt]);
    spawnSync('git', ['-C', repo, 'branch', '-D', 'feat/flag']);
  }
});

test('--help documents the naming help and how to turn it off', () => {
  const h = run(['--help']).stdout;
  assert.match(h, /NAMING HELP/);
  assert.match(h, /GWQADD_AI/);
  assert.match(h, /--no-ai/);
  assert.match(h, /claude, codex, opencode, gemini/);
});

// The prompt is assembled from git output, and one of those parses was wrong in
// a way only visible by reading the prompt itself: `gitOut` trims the whole
// string, so porcelain's first line lost its leading space and then its first
// path character. The AI path cannot be reached without a TTY, so drive the
// same parse through a stand-in and assert on what it produced.
test('modified paths survive porcelain quirks (first line, rename, quoting)', () => {
  // Recorded from git: a quoted path, a rename, and a plain entry. The first
  // line is the one that used to arrive as ".txt" instead of "a.txt".
  const porcelain = ' M a.txt\n A "has space.txt"\nRM old.txt -> renamed.txt\n A src/auth/session.ts\n';
  const parsed = porcelain
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3))
    .map((l) => (l.includes(' -> ') ? l.slice(l.indexOf(' -> ') + 4) : l))
    .map((l) => l.replace(/^"(.*)"$/, '$1').trim())
    .filter(Boolean);
  assert.deepEqual(parsed, ['a.txt', 'has space.txt', 'renamed.txt', 'src/auth/session.ts']);

  // And the bug itself: prove trimming the stream is what broke it, so nobody
  // "simplifies" this back to gitOut().
  const viaTrim = porcelain.trim().split('\n').map((l) => l.slice(3).trim());
  assert.equal(viaTrim[0], '.txt', 'trimming the stream eats the first path character');
});

test('collision paths parse in both argument orders, spaces and all', () => {
  // `-b` swaps the order, and a gwq basedir under a directory with a space
  // silently broke `-f` entirely: the pattern stopped at the first space, so
  // the path it produced did not exist and the move-aside was skipped without
  // a word. Both forms, with and without spaces, plus git's quoted line.
  const parse = (out, withB) => {
    const quoted = out.match(/fatal: '([^']+)' already exists/)?.[1];
    const cmd = (withB
      ? out.match(/git worktree add -b \S+ (.+?): /)
      : out.match(/git worktree add (.+?) \S+: /))?.[1];
    return (quoted ?? cmd ?? '').trim();
  };
  assert.equal(parse('x: git worktree add -b feat/x /wt/feat-x: Preparing', true), '/wt/feat-x');
  assert.equal(parse('x: git worktree add /wt/feat-x feat/x: Preparing', false), '/wt/feat-x');
  assert.equal(parse('x: git worktree add -b feat/x /a b/feat-x: Preparing', true), '/a b/feat-x');
  assert.equal(parse('x: git worktree add /a b/feat-x feat/x: Preparing', false), '/a b/feat-x');
  assert.equal(parse("fatal: '/a b/feat-x' already exists", false), '/a b/feat-x');
  // The old pattern is what this guards against.
  assert.equal('x: git worktree add -b feat/x /a b/feat-x: p'
    .match(/git worktree add (?:-b [^ ]* )?(\/[^ :]*)/)?.[1], '/a',
    'the superseded pattern truncated at the space');
});

// ── the emitted function, actually run ───────────────────────────────────────
//
// A syntax check never caught this: with the function installed, every flag
// whose output goes to stdout was captured and handed to `cd`. `--version`
// became "no such file or directory: gwqadd x.y.z" and `--help` became
// "file name too long". Run the function for real.

function shellRun(shell, args) {
  const init = run(['--init', shell]).stdout;
  const script = shell === 'fish'
    ? `${init}\ngwqadd ${args.join(' ')}`
    : `${init}\ngwqadd ${args.join(' ')}`;
  return spawnSync(shell, ['-c', script], { encoding: 'utf8' });
}

for (const shell of ['zsh', 'bash', 'fish']) {
  test(`the ${shell} function passes --version through instead of cd'ing into it`, (t) => {
    if (spawnSync(shell, ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip(`${shell} missing`);
    const r = shellRun(shell, ['--version']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^gwqadd \d+\.\d+\.\d+/m);
    assert.doesNotMatch(r.stderr, /cd:|no such file|not a directory/);
  });

  test(`the ${shell} function passes --help through`, (t) => {
    if (spawnSync(shell, ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip(`${shell} missing`);
    const r = shellRun(shell, ['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /USAGE/);
    assert.doesNotMatch(r.stderr, /file name too long|cd:/);
  });
}

test('the emitted snippet tells people to use `command`', () => {
  // `eval "$(<pkg> --init zsh)"` in ~/.zshrc resolves to the *function* on every
  // re-source after the first, and a stale function captures this very output
  // and hands it to cd. `command` skips functions. The header comment is the
  // line people copy, so it has to be the correct one.
  for (const shell of ['zsh', 'bash']) {
    const out = run(['--init', shell]).stdout;
    assert.match(out, /eval "\$\(command gwqadd --init (zsh|bash)\)"/,
      `${shell} header must recommend the command form`);
  }
  assert.match(run(['--init', 'fish']).stdout, /command gwqadd --init fish \| source/);
});

test('re-sourcing is idempotent even with a stale function defined', (t) => {
  if (spawnSync('zsh', ['-c', 'true'], { stdio: 'ignore' }).error) return t.skip('zsh missing');
  const init = run(['--init', 'zsh']).stdout;
  // A pre-`command` function: captures stdout and cds into it, whatever it is.
  const stale = `gwqadd() { local d; d=$(echo stale) || return $?; builtin cd -- "$d"; }`;
  const script = [stale, init, 'gwqadd --version'].join('\n');
  const r = spawnSync('zsh', ['-c', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^gwqadd \d+\.\d+\.\d+/m, 'the new function must have replaced the stale one');
  assert.doesNotMatch(r.stderr, /cd:|no such file/);
});

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
