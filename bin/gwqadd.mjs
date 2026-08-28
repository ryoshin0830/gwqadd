#!/usr/bin/env node
import { spawnSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { Buffer } from 'node:buffer';
import {
  readFileSync, existsSync, readdirSync, renameSync, realpathSync,
  mkdtempSync, rmSync, cpSync, lstatSync, mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath, dirname, resolve as resolvePath, sep } from 'node:path';
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
  eval "$(command ${PKG} --init zsh)"   # then \`${PKG}\` moves the shell itself

OPTIONS
  --init <shell>     print shell integration for zsh | bash | fish, then exit
  --cmd <name>       function name emitted by --init (default: ${PKG})
  --from <ref>       branch from this ref instead of the current HEAD
  --expires <dur>    hand gwq an expiry (1h, 7d, …) for a throwaway worktree
  --ai <cmd>         AI CLI used to suggest names (default: autodetected)
  --no-ai            never ask an AI, even when one is installed
  --random           skip the questions and generate a name
  --no-random        start by describing the work instead of rolling a name
  --no-submodules    skip \`git submodule update --init --recursive\`
  --copy-ignored-files
                     copy the repository's Git-ignored files in — the default,
                     accepted so a script can say so out loud
  --no-copy-ignored-files
                     do not copy them
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
  ${PKG}                             roll a name, confirm, done
  ${PKG} --random                    roll a name for a script, no questions
  ${PKG} -n --json feat/login        machine-readable, shell stays put

NAMING HELP
  Run ${PKG} with no branch name and it rolls one immediately — three words, no
  prefix, no waiting:

    Y  create it     n  name it properly     e  edit the name     r  reroll

  Nothing has been sent anywhere and nothing created at that point. Press n and
  it asks what you want to do, in any language, and hands that to an AI CLI
  which answers with one name in this repository's own style:

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

  --no-random (or GWQADD_RANDOM=off) starts at the description prompt instead.
  --random goes the other way and never asks; it is the only naming path that
  works without a terminal, which is what scripts and agents should use.

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
  3. copy the Git-ignored files it does not have yet from the main working tree
  4. \`git submodule update --init --recursive\` when the tree has submodules
  5. hand the path back so the shell can cd there

  Re-running is safe. A half-created branch is rolled back rather than left
  to collide with the next attempt.

IGNORED FILES
  A worktree starts without the files git never tracked — .env, credentials,
  local config — so it starts unable to run anything. They are copied over from
  the main working tree, not from the worktree you happen to be standing in,
  because they belong to the repository rather than to a branch.

  Dependency and build directories are skipped: they are reproducible from what
  git does track, and copying one is slow and often wrong. git cannot tell them
  from an .env, so the exclusion is by name. It matches parent directories at
  any depth, so conf/tmp/app.conf goes too, while a file called dist stays:

    .angular  .astro  .cache  .dart_tool  .direnv  .docusaurus  .eggs
    .gradle  .mypy_cache  .next  .nuxt  .nyc_output  .output
    .parcel-cache  .pnpm-store  .pytest_cache  .ruff_cache  .sass-cache
    .serverless  .stack-work  .svelte-kit  .terraform  .terragrunt-cache
    .tox  .turbo  .venv  .virtualenvs  .vite  .yarn  Carthage  Pods
    __pycache__  _build  bower_components  build  coverage  deps  dist
    jspm_packages  node_modules  out  site-packages  target  tmp  vendor
    venv

  Every run says how many entries it skipped and which of these they were in.
  An entry is a path git listed: one file under node_modules, but one whole
  directory where git stops at a repository boundary — so a nested worktree
  counts once, whatever it holds.

  The worktrees of this repository are skipped as well, and so is everything
  else sitting in the directory gwq puts worktrees in — a \`.bak-\` moved aside
  by -f, or a worktree whose .git file went missing. That matters when gwq's
  basedir is inside the repository, where each of those is a full checkout that
  would otherwise be copied into every new worktree.

  The set is whatever git itself ignores, which is not only .gitignore: it
  includes .git/info/exclude and the machine's global core.excludesFile.

  Nothing is ever overwritten or deleted: a file the destination already has is
  left exactly as it is, so re-running is safe and an .env you edited in a
  worktree stays yours. A copy that fails is a warning, not a failure — the
  worktree is created either way.

  --no-copy-ignored-files turns it off. --copy-ignored-files is the default and
  is accepted so a script can say so out loud.

OUTPUT
  Progress goes to stderr. stdout carries only the machine-readable result:
  the path in --quiet, one line of JSON in --json, nothing in pretty mode.

  --json:
    {"schemaVersion":1,"path":"…","branch":"…","base":{"ref":"…","sha":"…"},
     "repo":{"root":"…","name":"…"},"created":"branch+worktree",
     "ignoredFiles":{"copied":0,"kept":0,"skipped":0,"failed":0,"error":null,
                     "enabled":true},
     "cd":true}

  The copy did everything it set out to do when ignoredFiles.enabled is true,
  ignoredFiles.error is null and ignoredFiles.failed is 0. enabled is there
  because the counters of a copy that never ran are the counters of a repository
  with nothing to copy. The copy never affects the exit code, and in --json this
  payload is the only place its trouble is reported.

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
      random: { type: 'boolean' },
      'no-random': { type: 'boolean' },
      'no-submodules': { type: 'boolean' },
      'copy-ignored-files': { type: 'boolean' },
      'no-copy-ignored-files': { type: 'boolean' },
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
# Add to ~/.zshrc:  eval "$(command ${PKG} --init zsh)"

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
  # These print to stdout for the caller — help text, a list, JSON — and one of
  # them, --json, would collide with the --quiet added below. Capturing that and
  # handing it to cd produced "file name too long" on --help. Pass them through.
  local __a
  for __a in "$@"; do
    case $__a in
      -h|--help|-V|--version|--init|--init=*|--json)
        __${slug}_exec "$@"
        return $?
        ;;
    esac
  done
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
# Add to ~/.bashrc:  eval "$(command ${PKG} --init bash)"

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
  # These print to stdout for the caller — help text, a list, JSON — and one of
  # them, --json, would collide with the --quiet added below. Capturing that and
  # handing it to cd produced "file name too long" on --help. Pass them through.
  local __a
  for __a in "$@"; do
    case "$__a" in
      -h|--help|-V|--version|--init|--init=*|--json)
        __${slug}_exec "$@"
        return $?
        ;;
    esac
  done
  local __dir
  __dir=$(__${slug}_exec --quiet "$@") || return $?
  [ -n "$__dir" ] || return 0
  cd -- "$__dir"
}
`;
  }

  if (shell === 'fish') {
    return `# ${PKG} ${VERSION} — fish integration
# Add to ~/.config/fish/config.fish:  command ${PKG} --init fish | source

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
    # Help text, a list or JSON goes to the caller, not to cd. --json would also
    # collide with the --quiet added below.
    for __a in $argv
        switch $__a
            case -h --help -V --version --init '--init=*' --json
                __${slug}_exec $argv
                return $status
        end
    end
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
// On by default: a worktree without its .env cannot run the project, and having
// to remember a flag for that is the whole complaint this answers.
const copyIgnored = !values['no-copy-ignored-files'];
const force = !!values.force;
const stayOut = !!values['no-cd'];

// The random-first prompt is the default; --no-random restores the 0.3.x flow
// of describing the work to an AI straight away.
const randomOff =
  !!values['no-random'] ||
  ['off', '0', 'false', 'none'].includes(process.env.GWQADD_RANDOM ?? '');
const randomFirst = !randomOff;

if (values.random && values['no-random']) {
  die('E_VALIDATION', '--random and --no-random cannot both be given');
}

if (values['copy-ignored-files'] && values['no-copy-ignored-files']) {
  die('E_VALIDATION', '--copy-ignored-files and --no-copy-ignored-files cannot both be given');
}

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
  } catch (err) {
    if (err?.code === 'ABORT_ERR') die('E_INTERRUPTED', 'cancelled');
    throw err;
  } finally {
    rl.close();
  }
}

// ── git helpers ──────────────────────────────────────────────────────────────

// spawnSync's default maxBuffer is 1 MiB, and `ls-files --others --ignored` in a
// repository that has had `npm install` run in it goes straight past that: the
// child is killed with SIGTERM, stdout arrives truncated and status is null.
// That used to read as "could not list the ignored files" and copy nothing at
// all — .env included, and silently in --json. The listing is bounded by the
// number of paths in the repository, so give it room.
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

const git = (dir, args, opts = {}) =>
  spawnSync('git', ['-C', dir, ...args],
    { encoding: 'utf8', maxBuffer: GIT_MAX_BUFFER, ...opts });

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

// ── ignored files ────────────────────────────────────────────────────────────

// The shape --json reports when the copy did not run at all. `enabled: false`
// exists because {copied:0,kept:0,skipped:0,failed:0,error:null} was identical
// to a successful copy of a repository with no ignored files, and an agent
// following "error is null and failed is 0" would then believe the .env is there.
const noCopy = () => ({
  copied: 0, kept: 0, skipped: 0, failed: 0, error: null, enabled: false,
});

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root, candidate) {
  const rootPath = resolvePath(root);
  const candidatePath = resolvePath(candidate);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

// Lexical containment does not protect a write through a symlinked parent.
// Check every existing component before mkdir/copy; the destination root is
// realpathed by seedIgnoredFiles so the root itself cannot redirect the write.
//
// Returns why the path is unusable, or '' when it is fine. It reports the
// reason rather than a boolean because "crosses a symlink" was being printed
// for an ENOTDIR — a destination blocked by an ordinary file, where nothing is
// a symlink at all.
//
// `verified` memoises directories this run has already walked past. Only real
// directories go in, and only the pre-mkdir call passes it: the post-mkdir call
// has to lstat the component mkdir just made, which is the whole point of
// looking twice.
function destinationBlockedBy(root, candidate, verified) {
  const rootPath = resolvePath(root);
  let current = resolvePath(candidate);
  if (!isWithin(rootPath, current)) return 'escapes the worktree';
  const walked = [];
  while (current !== rootPath) {
    if (verified?.has(current)) break;
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) return 'crosses a symlink in the worktree';
      if (st.isDirectory()) walked.push(current);
    } catch (err) {
      if (err.code !== 'ENOENT') return `blocked by ${err.code} in the worktree`;
    }
    const parent = dirname(current);
    if (parent === current) return 'escapes the worktree';
    current = parent;
  }
  if (verified) for (const d of walked) verified.add(d);
  return '';
}

// Every working tree of this repository, resolved both ways: git reports
// resolved paths, we assemble unresolved ones.
function ownWorktrees(dir) {
  const paths = new Set();
  for (const line of gitOut(dir, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (!line.startsWith('worktree ')) continue;
    const p = line.slice('worktree '.length);
    paths.add(resolvePath(p));
    try { paths.add(realpathSync(p)); } catch { /* pruned since */ }
  }
  return paths;
}

// Ignored paths a package manager or a build tool puts back on its own. git
// cannot tell these from an .env: `--directory` only says a directory is
// ignored as a whole, which is just as true of `.secrets/`, and a size budget
// would change the answer with the state of the disk. The only honest
// discriminator is the name, so the list is fixed, sorted, reproduced in
// --help, and every run says how much it skipped and where.
const REGENERABLE_DIRS = [
  '.angular', '.astro', '.cache', '.dart_tool', '.direnv', '.docusaurus',
  '.eggs', '.gradle', '.mypy_cache', '.next', '.nuxt', '.nyc_output',
  '.output', '.parcel-cache', '.pnpm-store', '.pytest_cache', '.ruff_cache',
  '.sass-cache', '.serverless', '.stack-work', '.svelte-kit', '.terraform',
  '.terragrunt-cache', '.tox', '.turbo', '.venv', '.virtualenvs', '.vite',
  '.yarn', 'Carthage', 'Pods', '__pycache__', '_build', 'bower_components',
  'build', 'coverage', 'deps', 'dist', 'jspm_packages', 'node_modules',
  'out', 'site-packages', 'target', 'tmp', 'vendor', 'venv',
];
const REGENERABLE = new Set(REGENERABLE_DIRS);

// The name of the regenerable directory this entry lives in, or ''. Only parent
// components count: a file called `dist` is a file, not a build directory.
function regenerableDir(entry) {
  const parts = entry.split('/');
  parts.pop();
  for (const part of parts) if (REGENERABLE.has(part)) return part;
  return '';
}

// A new worktree gets everything git tracks and nothing it does not, so it
// starts without the .env and the credentials the project needs to run. Those
// live in the main working tree; copy over the ones the destination lacks.
//
// Three rules make this safe to have on by default:
//   - never overwrite and never delete, so an .env edited in a worktree is the
//     user's and re-running is a no-op;
//   - never leave the destination, checked lexically and against symlinked
//     parents, because the list comes from the filesystem;
//   - never fail the command. A worktree missing its .env is worse than one
//     with it, but a worktree that was never created is worse than both, so
//     every failure here is a warning (cf. the naming layer, I22).
function seedIgnoredFiles(sourceDir, destinationDir) {
  // `error` carries a listing failure into --json, where warn() is silent and
  // {copied:0,kept:0,skipped:0} is otherwise indistinguishable from a
  // repository that simply has no ignored files.
  const result = {
    copied: 0, kept: 0, skipped: 0, failed: 0, error: null, enabled: true,
  };
  if (samePath(sourceDir, destinationDir)) return result;

  let destinationRoot;
  try {
    destinationRoot = realpathSync(destinationDir);
  } catch (err) {
    result.error = `could not resolve ${destinationDir}: ${err.message}`;
    warn(result.error);
    return result;
  }

  const r = git(sourceDir, [
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z',
  ]);
  if (r.status !== 0 || r.error) {
    // Say why. The reason used to be dropped, which made an ENOBUFS truncation
    // look like a repository with nothing to copy.
    const why = r.error?.code
      ?? (r.signal ? `killed by ${r.signal}` : `git exited ${r.status}`);
    result.error = `could not list the ignored files in ${sourceDir} (${why})`;
    warn(result.error);
    return result;
  }

  const entries = (r.stdout ?? '').split('\0').filter(Boolean);
  if (!entries.length) return result;

  // Prune before touching the filesystem: git lists every single file inside
  // node_modules, and there can be hundreds of thousands of them.
  //
  // Our own worktrees go too. A gwq basedir inside the repository makes every
  // worktree an ignored directory of it, and git reports such a directory as
  // one indivisible entry — so worktrees start duplicating each other, one
  // level deeper on every run, with only cpSync's "subdirectory of self" check
  // stopping the recursion. That is a structural fact from `git worktree list`,
  // not another name to guess at (I25b).
  const worktrees = ownWorktrees(sourceDir);
  // `git worktree list` knows only the live ones. Everything else beside them
  // in gwq's basedir is a full checkout of this repository that git reports as
  // an ordinary ignored directory: a `<path>.bak-<timestamp>` this tool moved
  // aside itself (I4), or a worktree whose `.git` file went missing — and our
  // own `git worktree prune` runs before this, so that entry is already gone.
  // The directory the destination sits in is therefore pruned wholesale — one
  // level, not gwq's whole basedir, which we have no way to ask for. With a
  // naming template that nests (host/owner/repo/branch) a leftover further up
  // is still copied; that needs a layout change to happen at all, and taking
  // the topmost ancestor instead would prune a real config directory whenever
  // someone points the basedir inside one. The samePath guard is for a basedir
  // at the repository root, where pruning the holder would prune everything.
  const holder = dirname(destinationRoot);
  const holdsWorktrees = isWithin(sourceDir, holder) && !samePath(holder, sourceDir);
  const isOwnWorktree = (p) => {
    if (holdsWorktrees && isWithin(holder, p)) return true;
    // The arguments look backwards and are not: `worktrees` contains the main
    // working tree, so asking isWithin(w, p) would put every entry inside it and
    // prune the lot. git collapses a healthy worktree into exactly one entry, so
    // p === w is the case that matters here.
    for (const w of worktrees) if (isWithin(p, w)) return true;
    return false;
  };
  const pruned = new Map();
  const wanted = [];
  for (const entry of entries) {
    const dir = regenerableDir(entry);
    const label = dir || (isOwnWorktree(resolvePath(sourceDir, entry)) ? 'worktrees of this repository' : '');
    if (label) pruned.set(label, (pruned.get(label) ?? 0) + 1);
    else wanted.push(entry);
  }
  result.skipped = entries.length - wanted.length;

  if (wanted.length) log(`${dim('│')} copying ignored files from ${dim(sourceDir)}`);

  // node_modules and build output are in scope by design, so this can be tens
  // of thousands of files. A silent multi-minute pause reads as a hang, so keep
  // a counter moving whenever there is a terminal to move it on.
  const showProgress = stderrTTY && !isJson;
  let lastTick = 0;
  let processed = 0;
  // The sample is capped; the count is not. Reporting `skipped.length` as the
  // number of failures under-reported everything past the hundredth.
  const samples = [];
  const skip = (reason) => {
    result.failed++;
    if (samples.length < 3) samples.push(reason);
  };
  const verified = new Set();

  for (const entry of wanted) {
    // Tick first: kept and skipped entries do work too, and a re-run that keeps
    // everything is exactly the silent wait the counter exists for.
    processed++;
    if (showProgress && Date.now() - lastTick > 200) {
      lastTick = Date.now();
      stderr.write(`\r\x1b[K${dim('│')} ${processed} / ${wanted.length}`);
    }
    const sourcePath = resolvePath(sourceDir, entry);
    const destinationPath = resolvePath(destinationRoot, entry);
    if (!isWithin(sourceDir, sourcePath) || !isWithin(destinationRoot, destinationPath)) {
      skip(`${entry} (escapes the worktree)`);
      continue;
    }
    if (!pathExists(sourcePath)) continue;
    if (pathExists(destinationPath)) {
      result.kept++;
      continue;
    }
    const blocked = destinationBlockedBy(destinationRoot, destinationPath, verified);
    if (blocked) {
      skip(`${entry} (${blocked})`);
      continue;
    }
    try {
      mkdirSync(dirname(destinationPath), { recursive: true });
      // Look again: mkdir may have followed a link that appeared meanwhile, so
      // this call deliberately does not use the memo.
      const raced = destinationBlockedBy(destinationRoot, destinationPath);
      if (raced) {
        skip(`${entry} (${raced})`);
        continue;
      }
      // verbatimSymlinks: a relative link is a link within the tree being
      // copied. Resolving it, which is cpSync's default, rewrites
      // `.secrets/bin/key -> ../real/key` into an absolute path back into
      // the main working tree. (Not a node_modules example: I25b never copies those.)
      cpSync(sourcePath, destinationPath,
        { recursive: true, force: false, verbatimSymlinks: true });
      result.copied++;
    } catch (err) {
      skip(`${entry} (${err.message})`);
    }
  }
  if (showProgress) stderr.write('\r\x1b[K');

  // Name what was left behind: an exclusion nobody can see is a silent
  // surprise the first time a project keeps something real in `dist/`.
  const names = [...pruned.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  log(`${dim('│')} copied ${result.copied} ignored file(s)` +
    (result.kept ? `, kept ${result.kept} the worktree already had` : '') +
    (result.skipped
      ? `, skipped ${result.skipped} entr${result.skipped === 1 ? 'y' : 'ies'} in ` +
        names.slice(0, 3).join(', ') + (names.length > 3 ? ', …' : '')
      : ''));
  if (result.failed) {
    warn(`could not copy ${result.failed} ignored file(s), starting with ${samples[0]}`);
  }
  return result;
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

const ADJECTIVES = [
  'aback', 'abrupt', 'achieved', 'adaptable', 'aerial', 'airy', 'alike',
  'alpine', 'amplified', 'apricot', 'ash', 'available', 'azure', 'basalt',
  'bejeweled', 'bevel', 'bloom', 'bold', 'boundless', 'branched', 'brawny',
  'bright', 'bronzed', 'burly', 'butternut', 'cactus', 'candied', 'caramel',
  'carpal', 'celestial', 'chambray', 'checkered', 'chestnut', 'chisel',
  'citrine', 'clean', 'cloudy', 'coconut', 'colossal', 'concise', 'cookie',
  'cord', 'creative', 'cuddly', 'cyber', 'daily', 'darkened', 'decorous',
  'delicious', 'dented', 'diamond', 'dolomite', 'dune', 'early', 'educated',
  'elated', 'elite', 'endurable', 'equinox', 'evergreen', 'expensive',
  'faceted', 'familiar', 'fantastic', 'fearless', 'field', 'first', 'flannel',
  'flax', 'flower', 'foremost', 'fortune', 'freckle', 'frill', 'furtive',
  'garrulous', 'geode', 'ginger', 'glib', 'glorious', 'goldenrod', 'graceful',
  'grass', 'grey', 'guiltless', 'half', 'happy', 'heathered', 'helpful',
  'hill', 'honorable', 'humane', 'hurricane', 'icy', 'important', 'innate',
  'iodized', 'island', 'jet', 'judicious', 'juvenile', 'knotty', 'languid',
  'lavender', 'learned', 'level', 'lime', 'lively', 'lopsided', 'lumbar',
  'luxurious', 'magical', 'malleable', 'marble', 'marred', 'massive', 'mellow',
  'mercurial', 'mica', 'military', 'mire', 'modest', 'mousy', 'narrow',
  'nebula', 'nice', 'ninth', 'numerous', 'occipital', 'olivine', 'orchid',
  'ossified', 'pale', 'past', 'pear', 'perfect', 'petalite', 'picayune',
  'pineapple', 'plaid', 'platinum', 'plume', 'polarized', 'polyester',
  'prairie', 'private', 'proximal', 'pyrite', 'quickest', 'quilted', 'radical',
  'raspy', 'regal', 'repeated', 'respected', 'ringed', 'road', 'romantic',
  'round', 'rustic', 'salt', 'sapphire', 'scented', 'season', 'sedate',
  'separate', 'shaded', 'sheer', 'shiny', 'shrub', 'silky', 'sincere',
  'skitter', 'slimy', 'smooth', 'solar', 'southern', 'speckle', 'spiced',
  'spiral', 'spotless', 'spurious', 'steel', 'stone', 'strong', 'subdued',
  'sugar', 'sumptuous', 'superb', 'sweet', 'tame', 'tartan', 'temporal',
  'thankful', 'thoracic', 'tide', 'tiny', 'torpid', 'tropical', 'tundra',
  'typhoon', 'unique', 'upbeat', 'valiant', 'vast', 'verbose', 'violet',
  'volcano', 'water', 'west', 'wholesale', 'winter', 'wobbly', 'woolen',
  'young', 'zest'
];

const GERUNDS = [
  'abiding', 'adding', 'affording', 'amazing', 'appearing', 'asking',
  'attracting', 'baring', 'behaving', 'blotting', 'booking', 'boxing',
  'brushing', 'bustling', 'carrying', 'charming', 'chopping', 'clipping',
  'colouring', 'completing', 'continuing', 'counting', 'curing', 'daring',
  'delighting', 'deserving', 'doubling', 'dropping', 'employing', 'escaping',
  'exercising', 'exploding', 'fastening', 'filling', 'floating', 'flying',
  'forming', 'gathering', 'gluing', 'guessing', 'hanging', 'heating',
  'hopping', 'hunting', 'including', 'intending', 'joining', 'kicking',
  'knowing', 'launching', 'licking', 'listing', 'loving', 'matching',
  'melting', 'mining', 'muddling', 'nesting', 'obeying', 'offering', 'owning',
  'parting', 'pedaling', 'phoning', 'planning', 'poking', 'pouring',
  'preferring', 'printing', 'pulling', 'pushing', 'raining', 'recording',
  'rejoicing', 'reminding', 'replying', 'returning', 'rotating', 'sailing',
  'scorching', 'sealing', 'shading', 'shining', 'signing', 'slapping',
  'smiling', 'snoring', 'sparing', 'spotting', 'squeaking', 'standing',
  'stepping', 'stretching', 'suggesting', 'surprising', 'taming', 'testing',
  'ticking', 'touching', 'trading', 'trusting', 'tying', 'unpacking',
  'wailing', 'warming', 'weighing', 'whistling', 'wondering', 'yawning'
];

const NOUNS = [
  'aardvark', 'acorn', 'actress', 'aftermath', 'air', 'airport', 'alibi',
  'almanac', 'aluminum', 'amp', 'ancient', 'anise', 'antimony', 'apology',
  'appliance', 'archduke', 'armchair', 'article', 'asterisk', 'attempt',
  'author', 'axolotl', 'bag', 'ball', 'barbecue', 'barn', 'barracuda',
  'basket', 'bathtub', 'beak', 'bearskin', 'bedbug', 'beginner', 'beluga',
  'bicycle', 'birch', 'bit', 'blarney', 'blouse', 'boat', 'bongo', 'booth',
  'bow', 'braid', 'brass', 'breath', 'broccoli', 'brow', 'buckaroo', 'buffet',
  'bun', 'butter', 'cabbage', 'cafe', 'camera', 'candytuft', 'cap', 'caption',
  'carbon', 'caribou', 'carpet', 'carver', 'cat', 'catmint', 'ceder', 'cello',
  'centipede', 'chair', 'change', 'chauffeur', 'chemistry', 'chevre', 'chill',
  'chive', 'cicada', 'cirrus', 'clarinet', 'click', 'clock', 'clover', 'coat',
  'cockroach', 'cold', 'colossus', 'comfort', 'concrete', 'conifer', 'copy',
  'corn', 'couch', 'course', 'cowl', 'crate', 'creature', 'cricket', 'crow',
  'cub', 'cupcake', 'curve', 'cylinder', 'dancer', 'dataset', 'decade', 'den',
  'desk', 'dewberry', 'dichondra', 'dinghy', 'discovery', 'dogwood', 'donut',
  'drain', 'drifter', 'drizzle', 'duckling', 'durian', 'earth', 'echo',
  'education', 'elbow', 'elm', 'energy', 'entree', 'ermine', 'evergreen',
  'eyebrow', 'falcon', 'farm', 'feather', 'femur', 'ferret', 'fibre', 'figure',
  'fine', 'flag', 'flavor', 'flood', 'flyaway', 'football', 'form', 'foxtail',
  'freedom', 'friction', 'frog', 'function', 'galley', 'garage', 'garnet',
  'gauge', 'gemini', 'gerbera', 'ginger', 'glasses', 'glow', 'golf', 'gouda',
  'gram', 'grey', 'group', 'guarantee', 'gull', 'haddock', 'hallway',
  'handsaw', 'hare', 'hawthorn', 'health', 'heaven', 'hellebore', 'herring',
  'hiss', 'homegrown', 'hoof', 'hose', 'hourglass', 'humerus', 'hydrangea',
  'hyphen', 'icon', 'income', 'ink', 'iron', 'jacket', 'jasmine', 'jellyfish',
  'jodhpur', 'judge', 'juniper', 'kayak', 'keyboard', 'king', 'knee', 'krill',
  'lake', 'land', 'larkspur', 'launch', 'lead', 'legal', 'lemur', 'letter',
  'license', 'lighter', 'limpet', 'lion', 'liver', 'lobster', 'logic', 'lunch',
  'lychee', 'macaw', 'magician', 'mailbox', 'mallow', 'mandible', 'manta',
  'march', 'market', 'mars', 'mastodon', 'may', 'medallion', 'memory',
  'meteoroid', 'midnight', 'mine', 'mirror', 'molasses', 'money', 'moon',
  'mosquito', 'mountain', 'muenster', 'museum', 'mustang', 'napkin', 'nebula',
  'neon', 'net', 'newt', 'nitrogen', 'nurse', 'oatmeal', 'octagon', 'office',
  'onion', 'opinion', 'orca', 'origami', 'ounce', 'owl', 'pail', 'pan',
  'panther', 'papyrus', 'park', 'particle', 'passive', 'path', 'pea', 'pear',
  'pencil', 'perch', 'pet', 'pharaoh', 'piccolo', 'pig', 'pin', 'piper',
  'place', 'plant', 'platypus', 'plot', 'plutonium', 'polyester', 'porter',
  'potato', 'prawn', 'prince', 'process', 'proof', 'ptarmigan', 'puppet',
  'pyramid', 'quart', 'quill', 'quotation', 'radiator', 'raft', 'rainstorm',
  'range', 'reaction', 'recess', 'region', 'repair', 'research', 'reward',
  'riddle', 'riverbed', 'rock', 'rook', 'rosemary', 'rubidium', 'runner',
  'saguaro', 'salary', 'salute', 'sapphire', 'saturn', 'saxophone', 'scapula',
  'school', 'scooter', 'screen', 'seaplane', 'second', 'seer', 'server',
  'shallot', 'shear', 'shift', 'shop', 'shroud', 'silence', 'silver', 'skull',
  'slice', 'slipper', 'smoke', 'sneeze', 'snowman', 'soarer', 'sodalite',
  'sole', 'soul', 'soy', 'spark', 'spectrum', 'spider', 'split', 'sprint',
  'spy', 'stage', 'station', 'step', 'sting', 'stocking', 'story', 'streetcar',
  'subject', 'suit', 'sundial', 'sunspot', 'surgeon', 'sweater', 'swordfish',
  'system', 'tailor', 'tangelo', 'target', 'tartan', 'teal', 'tellurium',
  'tent', 'textbook', 'thorium', 'throne', 'tick', 'tile', 'tip', 'toast',
  'topaz', 'town', 'traffic', 'traveler', 'tricorne', 'trouser', 'trust',
  'tugboat', 'turkey', 'turret', 'twine', 'uncle', 'vacation', 'variety',
  'vein', 'vertebra', 'viola', 'viscose', 'voice', 'walk', 'walleye',
  'warbler', 'wasp', 'wave', 'weaver', 'whale', 'whitefish', 'wineberry',
  'wisteria', 'wolfsbane', 'woolen', 'wrinkle', 'xylophone', 'yarrow', 'zebra',
  'zinnia'
];

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
//
// The branch check alone is enough, and a `worktreePath()` call beside it would
// be unreachable: `git worktree list --porcelain` only prints `branch
// refs/heads/<name>` for a worktree that has that branch checked out, and a
// worktree with no branch prints `detached` instead. So a name a worktree holds
// is always a name a branch holds. Verified against git before this was cut.
function freeRandomName(dir) {
  for (let i = 0; i < RANDOM_TRIES; i++) {
    const name = randomName();
    if (!hasLocalBranch(dir, name)) return name;
  }
  return '';
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
// suggestion that is one word off should not cost another round trip; `r` only
// appears for a random name, where rerolling costs nothing at all.
async function confirmCreate(name, base, { reroll = false } = {}) {
  log(`${dim('│')}`);
  log(`${dim('│')} ${bold(cyan(name))}   ${dim(`off ${base}`)}`);
  const no = reroll ? '[n]o, name it properly' : '[n]o, describe again';
  const extra = reroll ? `${dim('·')} ${dim('[r]eroll')} ` : '';
  stderr.write(
    `${dim('│')} create it? ${dim('[Y]es')} ${dim('·')} ${dim(no)} ` +
    `${dim('·')} ${dim('[e]dit the name')} ${extra}`,
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

// The whole interactive path. Returns a branch name git has already accepted;
// never runs unless there is a terminal and no positional was given.
async function composeBranchName(dir, repo, base) {
  // Random first: it is free, and a user who wanted to think about the name is
  // one keystroke away from the prompt that lets them.
  if (randomFirst || values.random) {
    const chosen = await offerRandom(dir, base.ref);
    if (chosen) return chosen;
  }

  const ai = detectAi();
  if (!ai) return { branch: await typeItYourself(), named: 'manual' };

  const ctx = repoContext(dir, repo, base);
  const rejected = [];

  for (;;) {
    log(`${dim('│')}`);
    const description = await askLine(
      `${dim('│')} what do you want to do? ${dim('(any language)')}\n${dim('│')} ${dim('>')} `,
    );
    // An empty answer is the escape hatch out of the AI entirely.
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

  const branchExisted = hasLocalBranch(cwd, branch);
  if (branchExisted) {
    log(`${dim('│')} ${dim(`${branch} already exists — the base above is not used`)}`);
  }

  git(cwd, ['worktree', 'prune'], { stdio: 'ignore' }); // clear hand-deleted leftovers

  // Already done? Say so and go there. Re-running must be safe.
  const existing = worktreePath(cwd, branch);
  if (existing && existsSync(existing)) {
    log(`${dim('│')} ${dim('worktree already exists')}`);
    // Still seed it: the worktree may predate this feature, or the main working
    // tree may have gained an .env since. Missing-only, so this cannot clobber.
    const ignoredFiles = copyIgnored
      ? seedIgnoredFiles(repo.root, existing)
      : noCopy();
    log(`${dim('└')} ${green('✓')} ${cyan(branch)} ${dim('→')} ${existing}`);
    return finish({
      repo, branch, base, path: existing, created: 'none', named, ignoredFiles,
    });
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

  // The source is the main working tree, never the worktree we are standing in:
  // ignored files belong to the repository, not to whichever branch you had
  // checked out when you ran this.
  const ignoredFiles = copyIgnored
    ? seedIgnoredFiles(repo.root, created)
    : noCopy();

  if (doSubmodules && existsSync(`${created}/.gitmodules`)) {
    log(`${dim('│')} initialising submodules`);
    const r = git(created, ['submodule', 'update', '--init', '--recursive'], { stdio: childStdio });
    if (r.status !== 0) warn('submodule initialisation failed');
  }

  log(`${dim('└')} ${green('✓')} ${cyan(branch)} ${dim('→')} ${created}`);
  return finish({
    repo, branch, base, path: created, named, ignoredFiles,
    created: branchExisted ? 'worktree' : 'branch+worktree',
  });
}

// ── output ───────────────────────────────────────────────────────────────────

async function finish({ repo, branch, base, path, created, named, ignoredFiles }) {
  if (isJson) {
    process.stdout.write(JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      path,
      branch,
      base: { ref: base.ref, sha: base.sha },
      repo: { root: repo.root, name: repo.name },
      created,
      // What the ignored-file copy did, so a caller can tell a worktree that
      // got its .env from one that did not. Adding a field does not bump
      // schemaVersion (I10).
      ignoredFiles: ignoredFiles ?? noCopy(),
      // How the name was chosen, so a caller can tell a name it picked from one
      // the tool invented. Adding a field does not bump schemaVersion (I10).
      named,
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
    `   ${dim('tip:')} ${dim(`eval "$(command ${PKG} --init zsh)"`)} ${dim('lets')} ` +
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
