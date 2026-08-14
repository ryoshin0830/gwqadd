#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { Buffer } from 'node:buffer';
import { readFileSync, existsSync, readdirSync, renameSync, realpathSync } from 'node:fs';
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
  ${PKG}                             asks for the branch name
  ${PKG} -n --json feat/login        machine-readable, shell stays put

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

// A line, not a keypress — the branch name needs editing and history. The
// prompt goes to stderr so stdout stays the path channel (I1).
async function askLine(question) {
  const rl = createInterface({ input: process.stdin, output: stderr, terminal: true });
  try {
    return (await rl.question(question)).trim();
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

// gwq reports the git command it ran, so a collision's destination can be read
// back out of its error text.
const COLLISION = /git worktree add (?:-b [^ ]* )?(\/[^ :]*)/;

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

  let branch = positionals[0];
  if (!branch) {
    if (isNonInteractive) {
      die('E_VALIDATION', 'a branch name is required — `gwqadd <branch>`');
    }
    log(`${dim('┌')} ${bold(PKG)} ${dim(repo.name)}`);
    branch = await askLine(`${dim('│')} new branch: `);
    if (!branch) die('E_INTERRUPTED', 'cancelled');
  } else {
    log(`${dim('┌')} ${bold(PKG)} ${dim(repo.name)}`);
  }

  // git would reject this later with a less obvious message.
  const check = spawnSync('git', ['check-ref-format', '--branch', branch], { stdio: 'ignore' });
  if (check.status !== 0) {
    die('E_VALIDATION', `'${branch}' is not a valid branch name`);
  }

  const base = resolveBase(cwd, values.from);
  const branchExisted = hasLocalBranch(cwd, branch);

  log(`${dim('│')} repo    ${cyan(repo.name)} ${dim(repo.root)}`);
  if (repo.inLinkedWorktree) {
    log(`${dim('│')} cwd     ${dim('a linked worktree of it')} ${dim(repo.cwdTop)}`);
  }
  if (!branchExisted) {
    log(`${dim('│')} base    ${cyan(base.ref)} ${dim(base.sha.slice(0, 7))}`);
    // The silent version of this is the whole reason --from exists: running
    // inside a feature worktree branches off that feature, not off main.
    const def = defaultBranch(cwd);
    if (!values.from && def && base.ref !== def && base.ref !== `origin/${def}`) {
      warn(`branching from ${base.ref}, not the default branch — pass \`--from ${def}\` if that is not what you meant`);
    }
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
    log(`${dim('│')} ${dim('branch exists — creating its worktree only')}`);
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
    const collide = out.match(COLLISION)?.[1] ?? '';
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
