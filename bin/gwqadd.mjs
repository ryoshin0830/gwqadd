#!/usr/bin/env node
import { spawnSync, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Buffer } from 'node:buffer';
import {
  readFileSync, existsSync, readdirSync, renameSync, realpathSync,
  mkdtempSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

// Read from package.json rather than a hand-maintained constant: `npm version`
// only bumps the manifest, so a literal here silently drifts and `--version`
// then reports a build the user isn't running.
const VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const SCHEMA_VERSION = 1;
const PKG = 'gwqadd';
const SELF = fileURLToPath(import.meta.url);

const HELP = `${PKG} ${VERSION} — create a branch and its gwq worktree here, and cd there.

USAGE
  ${PKG} [options] [<branch>]
  eval "$(${PKG} --init zsh)"        # then \`${PKG}\` moves the shell itself

OPTIONS
  --init <shell>     print shell integration for zsh | bash | fish, then exit
  --cmd <name>       function name emitted by --init (default: ${PKG})
  --from <ref>       branch from this ref instead of the current HEAD
  --expires <dur>    hand gwq an expiry (1h, 7d, …) for a throwaway worktree
  --ai <cmd>         AI CLI used to suggest names (default: autodetected)
  --no-ai            never ask an AI, even when one is installed
  --no-submodules    skip \`git submodule update --init --recursive\`
  -f, --force        move a colliding worktree directory aside instead of failing
  -n, --no-cd        do the work and report the path, but do not move the shell
  --json             stdout = 1-line JSON
  --quiet            stdout = path only (this is what the shell function uses)
  --no-color         disable ANSI colors (also respects NO_COLOR env)
  -h, --help         show this help
  -V, --version      show version

EXAMPLES
  ${PKG} feat/login                  branch off HEAD, worktree, cd
  ${PKG} feat/login --from main      branch off main wherever you happen to be
  ${PKG} hotfix/x --expires 1d       gwq will mark it expired after a day
  ${PKG}                             describe the work, confirm, done
  ${PKG} -n --json feat/login        machine-readable, shell stays put

NAMING HELP
  Run ${PKG} with no branch name and it asks one question — what you want to do,
  in any language. An AI CLI turns that into a branch name and you confirm once:

    Y  create it        n  describe it again        e  edit the name

  There is no type menu. The prompt carries this repository's own prefixes and
  their counts, a sample of its branch names, and the paths you have already
  modified, so the AI picks the prefix and the wording that match the repo. A
  rejected suggestion is passed back as an exclusion, so "n" does not return it.

  The AI is whichever of these is on PATH — claude, codex, opencode, gemini —
  invoked headlessly. Nothing is sent anywhere until you answer the question,
  and nothing is created until you confirm. Override with --ai '<cmd>' or
  GWQADD_AI='<cmd>'; disable with --no-ai or GWQADD_AI=off, which leaves a plain
  prompt for an ASCII name.

  None of this happens with a branch name on the command line, or without a
  terminal — scripts and agents keep the plain, silent contract.

WHERE IT BRANCHES FROM
  The current HEAD, exactly like \`git checkout -b\` — which means running this
  inside a feature worktree branches off that feature, not off main. ${PKG}
  always prints the base it used, and warns when that is not the default
  branch. Pass --from to be explicit.

WHAT IT DOES
  1. work out which repository you are in (any worktree of it will do)
  2. create the branch and its worktree — or just the worktree if the branch
     already exists, or neither if both do
  3. \`git submodule update --init --recursive\` when the tree has submodules
  4. hand the path back so the shell can cd there

  Re-running is safe. A half-created branch is rolled back rather than left
  to collide with the next attempt.

OUTPUT
  Progress goes to stderr. stdout carries only the machine-readable result:
  the path in --quiet, one line of JSON in --json, nothing in pretty mode.

  --json:
    {"schemaVersion":1,"path":"…","branch":"…","base":{"ref":"…","sha":"…"},
     "repo":{"root":"…","name":"…"},"created":"branch+worktree","cd":true}

  On error in --json mode, stdout is empty and stderr gets:
    {"schemaVersion":1,"error":{"code":"E_NOT_REPO","message":"…"},"exitCode":2}

EXIT CODES
  0    success
  1    validation / branch / worktree failure
  2    not inside a git repository (E_NOT_REPO)
  127  git or gwq not installed (E_DEPS)
  130  interrupted — Ctrl-C (E_INTERRUPTED)
`;

// ── arg parsing ──────────────────────────────────────────────────────────────

// Detect --json early so even parseArgs / uncaughtException failures can
// produce a schema-compliant JSON error on stderr.
const rawJson = process.argv.slice(2).includes('--json');

function emitEarlyError(message, code = 'E_VALIDATION', exitCode = 1) {
  if (rawJson) {
    process.stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code, message },
      exitCode,
    }) + '\n');
  } else {
    process.stderr.write(`${PKG}: ${message}\n`);
    process.stderr.write(`run \`${PKG} --help\` for usage.\n`);
  }
  process.exit(exitCode);
}

let values, positionals;
try {
  ({ values, positionals } = parseArgs({
    options: {
      init: { type: 'string' },
      cmd: { type: 'string' },
      from: { type: 'string' },
      expires: { type: 'string' },
      ai: { type: 'string' },
      'no-ai': { type: 'boolean' },
      'no-submodules': { type: 'boolean' },
      force: { type: 'boolean', short: 'f' },
      'no-cd': { type: 'boolean', short: 'n' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'V' },
    },
    allowPositionals: true,
  }));
} catch (err) {
  emitEarlyError(err.message);
}

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (values.version) {
  process.stdout.write(`${PKG} ${VERSION}\n`);
  process.exit(0);
}

// ── color helpers ────────────────────────────────────────────────────────────

const noColorEnv =
  process.env.NO_COLOR != null && process.env.NO_COLOR !== '';
const useColor =
  !noColorEnv && !values['no-color'] && process.stderr.isTTY;
const ansi = (code) =>
  useColor ? (s) => `\x1b[${code}m${s}\x1b[0m` : (s) => String(s);
const dim = ansi(2);
const cyan = ansi(36);
const green = ansi(32);
const yellow = ansi(33);
const red = ansi(31);
const bold = ansi(1);

// ── output helpers ───────────────────────────────────────────────────────────

const isJson = !!values.json;
const isQuiet = !!values.quiet;

const stderr = process.stderr;
// --quiet is the shell function's mode and still narrates: it is the only way
// the user sees which repository and base ref were chosen. Only --json, whose
// contract is one line, goes silent. Nothing here ever touches stdout (I1).
const log = (s) => {
  if (isJson) return;
  stderr.write(s + '\n');
};
const warn = (s) => {
  if (isJson) return;
  stderr.write(`${yellow(`${PKG}:`)} ${s}\n`);
};

// ── error reporting ──────────────────────────────────────────────────────────

const EXIT = {
  E_VALIDATION: 1,
  E_BRANCH: 1,
  E_WORKTREE: 1,
  E_NOT_REPO: 2,
  E_DEPS: 127,
  E_INTERRUPTED: 130,
};

function die(code, message, extra = []) {
  const exitCode = EXIT[code] ?? 1;
  if (isJson) {
    stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code, message },
      exitCode,
    }) + '\n');
  } else if (code !== 'E_INTERRUPTED') {
    stderr.write(`${red(`${PKG}:`)} ${message}\n`);
    for (const line of extra) stderr.write(`    ${line}\n`);
  }
  process.exit(exitCode);
}

// ── shell integration (--init) ───────────────────────────────────────────────

const SHELLS = ['zsh', 'bash', 'fish'];

// Single-quote for POSIX shells: close, escape, reopen.
const shq = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;
// fish single-quotes only treat \ and ' as special.
const fishq = (s) => `'${String(s).replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

// The emitted function resolves the binary in three steps, in this order:
//
//   1. `${PKG}` on PATH — a global install (`npm i -g ${PKG}`). Fastest, and
//      the only one that picks up upgrades.
//   2. the absolute path of the script that generated this snippet. Covers
//      `eval "$(npx -y ${PKG} --init zsh)"` for as long as that file survives.
//   3. `npx -y ${PKG}@<version>` — always correct, ~1s per call.
//
// Step 2 matters because npx caches under ~/.npm/_npx/<hash>/ and npm may
// garbage-collect it; step 3 is what keeps the shell working when it does.
// The lookup is PATH-only (`whence -p` / `type -P` / `command -s`) — the
// function usually shares its name with the binary, so a function-aware
// lookup would find the function and recurse forever.
function shellInit(shell, fnName) {
  const desc = 'Create a branch and its gwq worktree here, and cd there';
  const v = `${PKG}@${VERSION}`;
  const slug = fnName.replaceAll(/[^A-Za-z0-9_]/g, '_');

  if (shell === 'zsh') {
    return `# ${PKG} ${VERSION} — zsh integration
# Add to ~/.zshrc:  eval "$(${PKG} --init zsh)"

__${slug}_fallback=${shq(SELF)}

__${slug}_exec() {
  local __bin
  __bin=$(whence -p ${PKG} 2>/dev/null)
  if [[ -n $__bin ]]; then
    "$__bin" "$@"
  elif [[ -x $__${slug}_fallback ]]; then
    "$__${slug}_fallback" "$@"
  else
    npx -y ${shq(v)} "$@"
  fi
}

# ${desc}.
${fnName}() {
  emulate -L zsh
  local __dir
  __dir=$(__${slug}_exec --quiet "$@") || return $?
  # Empty is not a failure: --no-cd, --help and --version all succeed without
  # naming a destination.
  [[ -n $__dir ]] || return 0
  builtin cd -- "$__dir"
}
`;
  }

  if (shell === 'bash') {
    return `# ${PKG} ${VERSION} — bash integration
# Add to ~/.bashrc:  eval "$(${PKG} --init bash)"

__${slug}_fallback=${shq(SELF)}

__${slug}_exec() {
  local __bin
  __bin=$(type -P ${PKG} 2>/dev/null)
  if [ -n "$__bin" ]; then
    "$__bin" "$@"
  elif [ -x "$__${slug}_fallback" ]; then
    "$__${slug}_fallback" "$@"
  else
    npx -y ${shq(v)} "$@"
  fi
}

# ${desc}.
${fnName}() {
  local __dir
  __dir=$(__${slug}_exec --quiet "$@") || return $?
  [ -n "$__dir" ] || return 0
  cd -- "$__dir"
}
`;
  }

  if (shell === 'fish') {
    return `# ${PKG} ${VERSION} — fish integration
# Add to ~/.config/fish/config.fish:  ${PKG} --init fish | source

set -g __${slug}_fallback ${fishq(SELF)}

function __${slug}_exec
    set -l __bin (command -s ${PKG})
    if test -n "$__bin"
        $__bin $argv
    else if test -x "$__${slug}_fallback"
        $__${slug}_fallback $argv
    else
        npx -y ${fishq(v)} $argv
    end
end

function ${fnName} --description ${fishq(desc)}
    set -l __dir (__${slug}_exec --quiet $argv)
    # \`set\` reports the command substitution's status, but not every fish
    # release agrees on that. Capturing it keeps a failed run from cd'ing,
    # and the empty-string guard below is correct either way.
    set -l __st $status
    if test $__st -ne 0
        return $__st
    end
    if test -z "$__dir"
        return 0
    end
    cd -- $__dir
end
`;
  }

  return null;
}

if (values.init != null) {
  const shell = values.init;
  if (!SHELLS.includes(shell)) {
    emitEarlyError(`--init expects one of ${SHELLS.join(' | ')}, got '${shell}'`);
  }
  const fnName = values.cmd ?? PKG;
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(fnName)) {
    emitEarlyError(`--cmd must be a valid shell function name, got '${fnName}'`);
  }
  process.stdout.write(shellInit(shell, fnName));
  process.exit(0);
}

// ── argument validation ──────────────────────────────────────────────────────

if (values.json && values.quiet) {
  die('E_VALIDATION', '--json and --quiet are mutually exclusive');
}
if (values.cmd != null) {
  die('E_VALIDATION', '--cmd is only meaningful together with --init');
}
if (positionals.length > 1) {
  die('E_VALIDATION', `unexpected extra arguments: ${positionals.slice(1).join(' ')}`);
}

const doSubmodules = !values['no-submodules'];
const force = !!values.force;
const stayOut = !!values['no-cd'];

// ── interactivity ────────────────────────────────────────────────────────────

const stdinTTY = !!process.stdin.isTTY;
const stderrTTY = !!process.stderr.isTTY;
const isNonInteractive = isJson || !stdinTTY || !stderrTTY;

// Children inherit stderr and have their stdout folded onto ours — which is
// stderr, never stdout. gwq's "Created worktree at …" must not end up inside
// the path the shell function is about to cd into.
const childStdio = isJson
  ? ['inherit', 'ignore', 'ignore']
  : ['inherit', 2, 'inherit'];

// ── tool checks ──────────────────────────────────────────────────────────────

function commandExists(cmd) {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !(r.error && r.error.code === 'ENOENT');
}

const INSTALL = {
  git: { brew: 'git', url: 'https://git-scm.com/downloads' },
  gwq: { brew: 'd-kuro/tap/gwq', url: 'https://github.com/d-kuro/gwq#installation' },
};

function brewAvailable() {
  return spawnSync('brew', ['--version'], { stdio: 'ignore' }).status === 0;
}

async function ensureTool(cmd) {
  if (commandExists(cmd)) return;
  const { brew, url } = INSTALL[cmd];
  if (isNonInteractive) {
    die('E_DEPS', `'${cmd}' not found in PATH. Install it with \`brew install ${brew}\` — ${url}`);
  }
  const ok = await confirmYesNo(`'${cmd}' not found. Install via 'brew install ${brew}'?`);
  if (!ok) die('E_DEPS', `Aborted. See ${url}`);
  if (!brewAvailable()) die('E_DEPS', `Homebrew unavailable. See ${url}`);
  const r = spawnSync('brew', ['install', brew], { stdio: ['inherit', 2, 'inherit'] });
  if (r.status !== 0) die('E_DEPS', `brew install ${brew} failed`);
}

// ── raw-mode keypress (no dependency on a prompt library) ────────────────────

let rawModeEngaged = false;
function disengageRawMode() {
  if (rawModeEngaged && process.stdin.isTTY) {
    try { process.stdin.setRawMode(false); } catch { /* ignore */ }
  }
  rawModeEngaged = false;
}
function restoreCursor() {
  if (process.stderr.isTTY) {
    try { process.stderr.write('\x1b[?25h'); } catch { /* ignore */ }
  }
}

process.on('exit', () => { disengageRawMode(); restoreCursor(); });
for (const sig of ['SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { disengageRawMode(); restoreCursor(); process.exit(130); });
}
process.on('uncaughtException', (err) => {
  disengageRawMode(); restoreCursor();
  if (rawJson) {
    stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code: 'E_VALIDATION', message: String(err?.message ?? err) },
      exitCode: 1,
    }) + '\n');
  } else {
    stderr.write(`${red(`${PKG}:`)} ${err?.stack ?? err}\n`);
  }
  process.exit(1);
});

async function waitForKey() {
  process.stdin.removeAllListeners('data');
  process.stdin.removeAllListeners('keypress');
  try {
    process.stdin.setRawMode(true);
    rawModeEngaged = true;
  } catch { /* setRawMode throws on non-TTY; let the keypress fall through */ }
  process.stdin.resume();
  try {
    return await new Promise((resolve) => {
      const handler = (buf) => {
        process.stdin.removeListener('data', handler);
        resolve(buf);
      };
      process.stdin.on('data', handler);
    });
  } finally {
    disengageRawMode();
    process.stdin.pause();
  }
}

async function confirmYesNo(question) {
  stderr.write(`${question} ${dim('[Y/n]')} `);
  const buf = await waitForKey();
  stderr.write('\n');
  if (buf.includes(0x03)) process.exit(130);
  const c = buf[0];
  return c === 0x0d || c === 0x0a || c === 0x79 || c === 0x59; // Enter, y, Y
}

// A line, not a keypress — a description or a branch name needs editing. The
// prompt goes to stderr so stdout stays the path channel (I1). `initial`
// pre-fills the line so "edit this suggestion" starts from the suggestion
// rather than from an empty prompt.
async function askLine(question, initial = '') {
  const rl = createInterface({ input: process.stdin, output: stderr, terminal: true });
  try {
    const answer = rl.question(question);
    if (initial) rl.write(initial);
    return (await answer).trim();
  } finally {
    rl.close();
  }
}

// ── git helpers ──────────────────────────────────────────────────────────────

const git = (dir, args, opts = {}) =>
  spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', ...opts });

const gitOut = (dir, args) => {
  const r = git(dir, args);
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
};

const hasLocalBranch = (dir, br) =>
  git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${br}`], { stdio: 'ignore' }).status === 0;

// git reports resolved paths in `worktree list`, so a plain string compare
// against a path we assembled ourselves can miss (/var vs /private/var on
// macOS, or any symlinked checkout).
function samePath(a, b) {
  if (a === b) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

// The worktree path for a branch, or '' — read from git rather than
// reimplementing gwq's naming template, which we do not control.
function worktreePath(dir, branch) {
  const out = gitOut(dir, ['worktree', 'list', '--porcelain']);
  let current = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return current;
  }
  return '';
}

// The repository we are standing in. Any worktree of it will do: gwq add works
// from a linked worktree, and running it from the user's cwd is what makes the
// default base match `git checkout -b`.
function resolveRepo() {
  const top = gitOut(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (!top) {
    die('E_NOT_REPO',
      `not inside a git repository (${process.cwd()}). ` +
      'cd into one first, or use `gwqpull <repo> <branch>` to clone one.');
  }
  // The main working tree is the first entry of `worktree list`; we only need
  // it to name the repository and to tell the user where they actually are.
  const list = gitOut(top, ['worktree', 'list', '--porcelain']);
  const mainWorktree = list.split('\n').find((l) => l.startsWith('worktree '))
    ?.slice('worktree '.length) ?? top;
  const name = mainWorktree.split('/').filter(Boolean).pop() ?? 'repository';
  return { cwdTop: top, root: mainWorktree, name, inLinkedWorktree: !samePath(top, mainWorktree) };
}

// The ref a bare `gwq add -b` would branch from, resolved for display.
function resolveBase(dir, from) {
  const ref = from || 'HEAD';
  const sha = gitOut(dir, ['rev-parse', ref]);
  if (!sha) {
    die(from ? 'E_BRANCH' : 'E_NOT_REPO', from
      ? `--from ${from} is not a ref this repository knows`
      : 'HEAD does not resolve — is this an empty repository?');
  }
  const label = from || gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || sha.slice(0, 7);
  return { ref: label, sha };
}

// origin/HEAD is the closest thing to "the branch people cut from". Missing on
// clones that never ran `git remote set-head`, so treat absence as unknown
// rather than guessing between main and master.
function defaultBranch(dir) {
  const head = gitOut(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  return head ? head.replace(/^refs\/remotes\/origin\//, '') : '';
}

// ── naming (interactive only) ────────────────────────────────────────────────

// Everything about the repository worth telling a model that is choosing a
// branch name. The point of gathering it here is that the model picks the
// prefix too — there is no menu, so the convention has to travel in the prompt.
function repoContext(dir, repo, base) {
  const refs = gitOut(dir, [
    'for-each-ref', '--format=%(refname:short)', '--sort=-committerdate',
    '--count=300', 'refs/heads', 'refs/remotes/origin',
  ]);
  const names = new Set();
  for (let b of refs.split('\n')) {
    b = b.trim();
    if (!b || b === 'HEAD' || b === 'origin/HEAD') continue;
    if (b.startsWith('origin/')) b = b.slice('origin/'.length);
    names.add(b); // a branch on both local and origin must count once
  }
  const counts = new Map();
  for (const b of names) {
    const i = b.indexOf('/');
    if (i <= 0) continue;
    const p = b.slice(0, i);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const prefixes = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  // Work already in progress is the strongest hint there is about what the
  // branch is for. Paths only — never contents.
  // Not gitOut(): it trims the whole output, which eats the leading space of
  // porcelain's first line and takes the first character of that path with it.
  // Every entry is `XY<space>path`, and a rename is `R <space>old -> new`.
  const status = git(dir, ['status', '--porcelain', '--untracked-files=no']);
  const dirty = (status.status === 0 ? status.stdout ?? '' : '')
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3))
    .map((l) => (l.includes(' -> ') ? l.slice(l.indexOf(' -> ') + 4) : l))
    .map((l) => l.replace(/^"(.*)"$/, '$1').trim()) // porcelain quotes odd paths
    .filter(Boolean)
    .slice(0, 20);

  return {
    name: repo.name,
    base: base.ref,
    prefixes,
    examples: [...names].filter((n) => n.includes('/')).slice(0, 20),
    dirty,
  };
}

function namingPrompt(ctx, description, rejected) {
  const conventions = ctx.prefixes.length
    ? `This repository's branch prefixes, most used first — pick one of these unless the work clearly does not fit:\n${
      ctx.prefixes.map(([p, n]) => `  ${p}/  (${n} branches)`).join('\n')}`
    : 'This repository has no prefix convention yet. Use a Conventional Commits type: feat, fix, docs, refactor, test, chore or perf.';

  return [
    'You name git branches. Reply with exactly 3 candidate names, one per line.',
    'No numbering, no bullets, no quotes, no code fences, no explanation.',
    `Repository: ${ctx.name}. The branch will be cut from: ${ctx.base}.`,
    conventions,
    ctx.examples.length
      ? `Existing branch names — match their wording and length:\n${ctx.examples.map((e) => `  ${e}`).join('\n')}`
      : '',
    ctx.dirty.length
      ? `Files already modified in the working tree, which is what the work touches:\n${ctx.dirty.map((f) => `  ${f}`).join('\n')}`
      : '',
    'Include the prefix and a slash. After it use lowercase ASCII words joined by hyphens. Under 40 characters. Be specific about this change, not generic.',
    'The description below is the only thing the branch is about. Do not name it after anything else you can see.',
    rejected.length
      ? `These were rejected — do not propose them or close variants:\n${rejected.map((r) => `  ${r}`).join('\n')}`
      : '',
    `The work to name, written in the author's own language:\n${description}`,
  ].filter(Boolean).join('\n\n');
}

// ── the AI layer ─────────────────────────────────────────────────────────────

// Delegate to whatever agent CLI the user already has, rather than embedding an
// API client. No key to store, no account to create, no new dependency, and it
// bills to whatever they already pay for. Order is by how reliably each one
// answers a bare prompt headlessly.
const AI_CLIS = [
  { bin: 'claude', args: ['-p'] },
  { bin: 'codex', args: ['exec'] },
  { bin: 'opencode', args: ['run'] },
  { bin: 'gemini', args: ['-p'] },
];

// GWQADD_AI may be an absolute path; only the command name is worth showing.
const aiLabel = (ai) => ai.bin.split('/').pop();

function detectAi() {
  if (values['no-ai']) return null;
  const override = values.ai ?? process.env.GWQADD_AI;
  if (override != null && override !== '') {
    if (['off', '0', 'false', 'none'].includes(override)) return null;
    // Split on whitespace only: quoting rules would be a shell of our own.
    const parts = override.split(/\s+/).filter(Boolean);
    return { bin: parts[0], args: parts.slice(1) };
  }
  return AI_CLIS.find((c) => commandExists(c.bin)) ?? null;
}

// These CLIs are agents, not text transformers: run one inside a repository and
// it reads CLAUDE.md, the source and the git history, then names the branch
// after what it found instead of what the user asked for. Measured in this very
// repository — description "uiのバグの修正", three runs each:
//
//   cwd = the repo   feat/ui-bug-fix, fix/ui-display-bug, feat/ui-bug-fix
//   cwd = empty dir  fix/ui-display-bug, fix/ui-display-bug, fix/ui-display-bug
//
// In-repo it both wavered and picked `feat/` for a bug fix twice. It once
// answered `feat/naming-prompt-repo-context`, which is a phrase straight out of
// this repo's CLAUDE.md. Everything the model legitimately needs is already in
// the prompt, so it runs in an empty directory and is given nothing else.
//
// spawnSync would also freeze the terminal for the 6-8 seconds these CLIs take
// to boot, with no sign of life; async plus an elapsed counter is the difference
// between "working" and "hung".
function runAi(ai, prompt) {
  return new Promise((resolve) => {
    let sandbox = '';
    try {
      sandbox = mkdtempSync(joinPath(tmpdir(), 'gwqadd-ai-'));
    } catch { /* fall back to inheriting cwd rather than not answering at all */ }
    const cleanup = () => {
      if (!sandbox) return;
      try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
      sandbox = '';
    };

    let child;
    try {
      child = spawn(ai.bin, [...ai.args, prompt], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(sandbox ? { cwd: sandbox } : {}),
      });
    } catch (err) {
      cleanup();
      return resolve({ ok: false, out: '', err: String(err?.message ?? err) });
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 60_000);
    child.on('error', (e) => {
      clearTimeout(kill);
      cleanup();
      resolve({ ok: false, out: '', err: String(e?.message ?? e) });
    });
    child.on('close', (code) => {
      clearTimeout(kill);
      cleanup();
      resolve({ ok: code === 0, out, err });
    });
  });
}

async function askAi(ai, prompt) {
  const started = Date.now();
  let tick;
  if (stderrTTY) {
    tick = setInterval(() => {
      const s = Math.round((Date.now() - started) / 1000);
      stderr.write(`\r${dim('│')} ${dim('thinking')} ${dim(`(${aiLabel(ai)}, ${s}s)`)}   `);
    }, 250);
  } else {
    log(`${dim('│')} asking ${aiLabel(ai)}…`);
  }
  try {
    return await runAi(ai, prompt);
  } finally {
    if (tick) {
      clearInterval(tick);
      stderr.write(`\r${' '.repeat(48)}\r`);
    }
  }
}

const validBranchName = (name) =>
  !!name && spawnSync('git', ['check-ref-format', '--branch', name], { stdio: 'ignore' }).status === 0;

// Models add bullets, backticks and commentary no matter how firmly asked not
// to. Keep only things that could actually be branch names, and let git have
// the final say on each one.
function parseCandidates(text) {
  const cleaned = text.split('\n')
    .map((l) => l.trim())
    .map((l) => l.replace(/^[-*•]\s*/, ''))
    .map((l) => l.replace(/^\d+[.)]\s*/, ''))
    .map((l) => l.replace(/^[`'"]+|[`'"]+$/g, ''))
    .filter(Boolean)
    .filter((l) => !/\s/.test(l))
    .filter((l) => /^[A-Za-z0-9._/-]+$/.test(l));

  const seen = new Set();
  const out = [];
  for (const name of cleaned) {
    if (seen.has(name) || !validBranchName(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length === 3) break;
  }
  return out;
}

function slugify(s) {
  return s.trim().toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9./-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/(^[-/]+)|([-/]+$)/g, '');
}

// This prompt is where the AI path lands when it is unavailable or declined, so
// a user who was mid-way through describing the work in their own language will
// type that language here. Slugifying it would silently create a branch named
// in Japanese; git allows it, but no CI, URL or tab-completion wants it. Say so
// and point at the two things that do work.
async function typeItYourself(initial = '') {
  for (;;) {
    const raw = await askLine(`${dim('│')} branch name ${dim('(ascii)')}: `, initial);
    if (!raw) die('E_INTERRUPTED', 'cancelled');
    if (/[^\x00-\x7F]/.test(raw)) {
      warn('this prompt takes an ASCII name. Describe the work at the previous prompt to have it translated, or pass a name as an argument to use it verbatim.');
      initial = '';
      continue;
    }
    const name = slugify(raw);
    if (validBranchName(name)) return name;
    warn(`'${name}' is not a valid branch name — try again`);
    initial = raw;
  }
}

// The single checkpoint before anything is created. `n` sends the user back to
// describing the work, which is what they asked for; `e` is there because a
// suggestion that is one word off should not cost another round trip.
async function confirmCreate(name, base) {
  log(`${dim('│')}`);
  log(`${dim('│')} ${bold(cyan(name))}   ${dim(`off ${base}`)}`);
  stderr.write(
    `${dim('│')} create it? ${dim('[Y]es')} ${dim('·')} ${dim('[n]o, describe again')} ` +
    `${dim('·')} ${dim('[e]dit the name')} `,
  );
  for (;;) {
    const buf = await waitForKey();
    if (buf.includes(0x03) || buf[0] === 0x1b) { stderr.write('\n'); die('E_INTERRUPTED', 'cancelled'); }
    const c = buf[0];
    if (c === 0x79 || c === 0x59 || c === 0x0d || c === 0x0a) { stderr.write('\n'); return { create: true }; }
    if (c === 0x6e || c === 0x4e) { stderr.write('\n'); return { again: true }; }
    if (c === 0x65 || c === 0x45) { stderr.write('\n'); return { edit: true }; }
  }
}

// The whole interactive path. Returns a branch name git has already accepted;
// never runs unless there is a terminal and no positional was given.
async function composeBranchName(dir, repo, base) {
  const ai = detectAi();
  if (!ai) return typeItYourself();

  const ctx = repoContext(dir, repo, base);
  const rejected = [];

  for (;;) {
    log(`${dim('│')}`);
    const description = await askLine(
      `${dim('│')} what do you want to do? ${dim('(any language)')}\n${dim('│')} ${dim('>')} `,
    );
    // An empty answer is the escape hatch out of the AI entirely.
    if (!description) return typeItYourself();

    const res = await askAi(ai, namingPrompt(ctx, description, rejected));
    if (!res.ok) {
      warn(`${aiLabel(ai)} failed — name it yourself instead`);
      const first = (res.err || '').trim().split('\n')[0];
      if (first) log(`${dim('│')} ${dim(first.slice(0, 120))}`);
      return typeItYourself();
    }
    const candidates = parseCandidates(res.out);
    if (candidates.length === 0) {
      warn(`${aiLabel(ai)} returned nothing usable — name it yourself instead`);
      return typeItYourself();
    }

    const choice = await confirmCreate(candidates[0], ctx.base);
    if (choice.create) return candidates[0];
    if (choice.edit) return typeItYourself(candidates[0]);
    // Rejected: remember every suggestion from this round so the next prompt
    // cannot come back with a near-identical name.
    rejected.push(...candidates);
  }
}
// ── width / box ──────────────────────────────────────────────────────────────

// Rough East Asian Width: 全角 CJK + 全角ラテン + half-symbols treated as wide.
// Good enough for box layouts; bail to one-line fallback when uncertain.
function charWidth(ch) {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return 0;
  if (cp < 0x20) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||
    (cp >= 0x2E80 && cp <= 0x303E) ||
    (cp >= 0x3041 && cp <= 0x33FF) ||
    (cp >= 0x3400 && cp <= 0x4DBF) ||
    (cp >= 0x4E00 && cp <= 0x9FFF) ||
    (cp >= 0xA000 && cp <= 0xA4CF) ||
    (cp >= 0xAC00 && cp <= 0xD7A3) ||
    (cp >= 0xF900 && cp <= 0xFAFF) ||
    (cp >= 0xFE30 && cp <= 0xFE4F) ||
    (cp >= 0xFF00 && cp <= 0xFF60) ||
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||
    (cp >= 0x1F300 && cp <= 0x1FAFF)
  ) return 2;
  return 1;
}
function strWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch);
  return w;
}

function renderBox(cdCommand) {
  const cols = process.stdout.columns || process.stderr.columns || 80;
  const inner = strWidth(cdCommand) + 4;
  if (inner + 2 > cols - 2) return `${dim('next:')} ${cyan(cdCommand)}`;
  const titleRaw = ' next ';
  const titleW = strWidth(titleRaw);
  const top = `╭─${titleRaw}${'─'.repeat(Math.max(0, inner - titleW - 1))}╮`;
  const empty = `│${' '.repeat(inner)}│`;
  const bot = `╰${'─'.repeat(inner)}╯`;
  const pad = ' '.repeat(Math.max(0, inner - strWidth(cdCommand) - 2));
  return [
    dim(top), dim(empty),
    dim('│  ') + cyan(cdCommand) + dim(pad + '│'),
    dim(empty), dim(bot),
  ].join('\n');
}

// ── clipboard ────────────────────────────────────────────────────────────────

function hasCmd(c) {
  return spawnSync(c, ['--version'], { stdio: 'ignore' }).error?.code !== 'ENOENT'
    || spawnSync('which', [c], { stdio: 'ignore' }).status === 0;
}
function clipboardCommand() {
  if (process.platform === 'darwin') return { bin: 'pbcopy', args: [] };
  if (process.env.WAYLAND_DISPLAY && hasCmd('wl-copy')) return { bin: 'wl-copy', args: [] };
  if (process.env.DISPLAY && hasCmd('xclip')) {
    return { bin: 'xclip', args: ['-selection', 'clipboard'] };
  }
  return null;
}
function copyToClipboard(text) {
  if (process.env.SSH_CONNECTION || process.env.TMUX) {
    try {
      stderr.write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
    } catch { /* ignore */ }
  }
  const cmd = clipboardCommand();
  if (!cmd) {
    stderr.write(dim('clipboard tool not found, copy manually\n'));
    return false;
  }
  const r = spawnSync(cmd.bin, cmd.args, { input: text });
  if (r.status !== 0) {
    stderr.write(dim(`${cmd.bin} failed, copy manually\n`));
    return false;
  }
  return true;
}

// ── worktree creation ────────────────────────────────────────────────────────

// A collision's destination has to be recovered from gwq's error text. Two
// sources, in order of reliability:
//
//   fatal: '<path>' already exists            <- git, quoted, unambiguous
//   ...: git worktree add [-b <branch>] <path>: ...
//
// The quoted form is preferred because the command echo is not parseable in
// general: `-b` swaps the argument order (`add -b <branch> <path>` versus
// `add <path> <branch>`), and a path containing a space silently truncated the
// old pattern — a gwq basedir under a directory with a space made `-f` do
// nothing at all, without saying so.
const COLLISION_QUOTED = /fatal: '([^']+)' already exists/;

// The command echo needs to know which form was used, because `-b` swaps the
// argument order and both a path and a branch can follow `add`:
//
//   gwq add -b <branch>      ->  git worktree add -b <branch> <path>: …
//   gwq add <branch>         ->  git worktree add <path> <branch>: …
//
// Guessing cost real time once already: a pattern that stopped at the first
// space read the path-first form correctly by accident, and a pattern that ran
// to the colon swallowed the branch with it.
const collisionFromCmd = (out, withB) => (withB
  ? out.match(/git worktree add -b \S+ (.+?): /)
  : out.match(/git worktree add (.+?) \S+: /))?.[1];

function collisionPath(out, withB) {
  const quoted = out.match(COLLISION_QUOTED)?.[1];
  return (quoted ?? collisionFromCmd(out, withB) ?? '').trim();
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// gwq add must run where the user is: `-b` branches from the HEAD of its cwd,
// which is what makes the default base behave like `git checkout -b`.
function runGwqAdd(cwd, args) {
  const full = ['add', ...args];
  if (values.expires) full.push('--expires', values.expires);
  const r = spawnSync('gwq', full, { cwd, encoding: 'utf8' });
  if (r.error) die('E_WORKTREE', `could not run gwq: ${r.error.message}`);
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(), status: r.status };
}

// ── main flow ────────────────────────────────────────────────────────────────

async function main() {
  await ensureTool('git');
  await ensureTool('gwq');

  const repo = resolveRepo();
  const cwd = process.cwd();

  const base = resolveBase(cwd, values.from);

  // Where you are and what you are cutting from come first — before any naming,
  // because both are things you would want to correct before investing in a
  // branch name, and the base especially is easy to get silently wrong.
  log(`${dim('┌')} ${bold(PKG)} ${dim(repo.name)}`);
  log(`${dim('│')} repo    ${cyan(repo.name)} ${dim(repo.root)}`);
  if (repo.inLinkedWorktree) {
    log(`${dim('│')} cwd     ${dim('a linked worktree of it')} ${dim(repo.cwdTop)}`);
  }
  log(`${dim('│')} base    ${cyan(base.ref)} ${dim(base.sha.slice(0, 7))}`);
  // The silent version of this is the whole reason --from exists: running
  // inside a feature worktree branches off that feature, not off main.
  const def = defaultBranch(cwd);
  if (!values.from && def && base.ref !== def && base.ref !== `origin/${def}`) {
    warn(`branching from ${base.ref}, not the default branch — pass \`--from ${def}\` if that is not what you meant`);
  }

  let branch = positionals[0];
  if (branch) {
    // git would reject this later with a less obvious message.
    if (!validBranchName(branch)) {
      die('E_VALIDATION', `'${branch}' is not a valid branch name`);
    }
  } else {
    if (isNonInteractive) {
      die('E_VALIDATION', 'a branch name is required — `gwqadd <branch>`');
    }
    // composeBranchName only ever returns a name git has already accepted.
    branch = await composeBranchName(cwd, repo, base);
  }

  const branchExisted = hasLocalBranch(cwd, branch);
  if (branchExisted) {
    log(`${dim('│')} ${dim(`${branch} already exists — the base above is not used`)}`);
  }

  git(cwd, ['worktree', 'prune'], { stdio: 'ignore' }); // clear hand-deleted leftovers

  // Already done? Say so and go there. Re-running must be safe.
  const existing = worktreePath(cwd, branch);
  if (existing && existsSync(existing)) {
    log(`${dim('│')} ${dim('worktree already exists')}`);
    log(`${dim('└')} ${green('✓')} ${cyan(branch)} ${dim('→')} ${existing}`);
    return finish({ repo, branch, base, path: existing, created: 'none' });
  }

  // Two ways in. Without --from, `gwq add -b` creates branch and worktree in
  // one git call. With --from, gwq has no way to express a base, so the branch
  // is made first and gwq is asked for the worktree only.
  let weCreatedBranch = false;
  let addArgs;
  if (branchExisted) {
    addArgs = [branch];
    log(`${dim('│')} ${dim('creating its worktree only')}`);
  } else if (values.from) {
    const made = git(cwd, ['branch', branch, values.from]);
    if (made.status !== 0) {
      die('E_BRANCH', `could not create ${branch} from ${values.from}`,
        (made.stderr ?? '').trim().split('\n').filter(Boolean).slice(0, 2));
    }
    weCreatedBranch = true;
    addArgs = [branch];
  } else {
    addArgs = ['-b', branch];
  }

  let { out, status } = runGwqAdd(cwd, addArgs);

  // `git worktree add -b` creates the branch *before* it fails on the
  // destination, so a failed run leaves a branch with no worktree. Left alone
  // it turns the next attempt into "branch already exists" — the tool would
  // stop being idempotent after its first bad day.
  const rollbackBranch = () => {
    const madeHere = weCreatedBranch || (!branchExisted && hasLocalBranch(cwd, branch));
    if (!madeHere) return;
    if (worktreePath(cwd, branch)) return; // it did get a worktree after all
    if (git(cwd, ['branch', '-D', branch], { stdio: 'ignore' }).status === 0) {
      warn(`rolled back the half-created branch ${branch}`);
    }
  };

  if (status !== 0) {
    const collide = collisionPath(out, addArgs[0] === '-b');
    // gwq's own -f does not reach `git worktree add` (verified against v0.1.1),
    // so a collision has to be cleared here or not at all.
    if (collide && existsSync(collide) && force) {
      const aside = `${collide}.bak-${timestamp()}`;
      warn(`${collide} already exists — moving it to ${aside}`);
      try {
        renameSync(collide, aside);
      } catch (err) {
        rollbackBranch();
        die('E_WORKTREE', `could not move ${collide} aside: ${err.message}`);
      }
      // The first attempt may have left the branch behind; reuse it rather
      // than asking git to create it twice.
      if (!branchExisted && hasLocalBranch(cwd, branch)) {
        weCreatedBranch = true;
        addArgs = [branch];
      }
      ({ out, status } = runGwqAdd(cwd, addArgs));
    }

    if (status !== 0) {
      // A racing run may have created it already; that is a success.
      const late = worktreePath(cwd, branch);
      if (!late || !existsSync(late)) {
        const detail = out.split('\n').filter((l) => /^(Error:|fatal:)/.test(l));
        if (collide && existsSync(collide)) {
          let count = '?';
          try { count = String(readdirSync(collide).length); } catch { /* ignore */ }
          detail.push(`${collide} still holds ${count} entries`);
          detail.push('inspect and remove it, or re-run with -f to move it aside');
        }
        rollbackBranch();
        die('E_WORKTREE', `could not create a worktree for ${branch}`, detail);
      }
    }
  }

  const created = worktreePath(cwd, branch);
  if (!created || !existsSync(created)) {
    rollbackBranch();
    die('E_WORKTREE', `gwq reported success but no worktree for ${branch} could be found`);
  }

  if (doSubmodules && existsSync(`${created}/.gitmodules`)) {
    log(`${dim('│')} initialising submodules`);
    const r = git(created, ['submodule', 'update', '--init', '--recursive'], { stdio: childStdio });
    if (r.status !== 0) warn('submodule initialisation failed');
  }

  log(`${dim('└')} ${green('✓')} ${cyan(branch)} ${dim('→')} ${created}`);
  return finish({
    repo, branch, base, path: created,
    created: branchExisted ? 'worktree' : 'branch+worktree',
  });
}

// ── output ───────────────────────────────────────────────────────────────────

async function finish({ repo, branch, base, path, created }) {
  if (isJson) {
    process.stdout.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      path,
      branch,
      base: { ref: base.ref, sha: base.sha },
      repo: { root: repo.root, name: repo.name },
      created,
      cd: !stayOut,
    }) + '\n');
    return;
  }

  if (isQuiet) {
    // The shell function cds to whatever lands here, so --no-cd must print
    // nothing at all rather than a path the wrapper would then follow.
    if (!stayOut) process.stdout.write(path + '\n');
    return;
  }

  if (stayOut) return;

  // Pretty mode is the `npx ${PKG}` path: no shell function is in play, so the
  // best we can do is hand over a cd command the user can paste or copy.
  const cdCommand = `cd "${path}"`;
  stderr.write('\n');
  stderr.write(renderBox(cdCommand) + '\n');
  stderr.write(
    `   ${dim('tip:')} ${dim(`eval "$(${PKG} --init zsh)"`)} ${dim('lets')} ` +
    `${bold(PKG)} ${dim('cd for you')}\n`,
  );

  if (!stdinTTY || !stderrTTY) return;
  stderr.write(`   ${dim('press')} ${bold('c')} ${dim('to copy')} ${dim('·')} ${dim('any other key to exit')}\n`);
  const buf = await waitForKey();
  if (buf.includes(0x03)) process.exit(130);
  if (buf[0] === 99 || buf[0] === 67) {
    if (copyToClipboard(cdCommand)) stderr.write(`   ${green('✓')} ${dim('copied')}\n`);
  }
}

main().catch((err) => {
  disengageRawMode();
  restoreCursor();
  if (err?.code === 'ABORT_ERR' || err?.name === 'AbortError') process.exit(130);
  if (isJson) {
    stderr.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      error: { code: 'E_VALIDATION', message: String(err?.message ?? err) },
      exitCode: 1,
    }) + '\n');
  } else {
    stderr.write(`${red(`${PKG}:`)} ${err?.stack ?? err}\n`);
  }
  process.exit(1);
});
