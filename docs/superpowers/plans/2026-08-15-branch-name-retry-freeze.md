# Branch Name Retry Freeze Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the interactive branch-name flow responsive after `n` and `e`, and preserve exit status 130 for Ctrl-C.

**Architecture:** Preserve the existing raw-key/readline split. The raw-key helper will remove only its own listener, while the line helper will translate readline's Ctrl-C rejection into the CLI's established interrupted exit path. Real CLI behavior will be exercised through an optional `expect` pseudo-terminal integration test.

**Tech Stack:** Node.js ESM, `node:test`, real Git sandbox, shell-based gwq/AI shims, optional system `expect`.

## Global Constraints

- Keep zero runtime dependencies.
- Preserve stdout/stderr discipline and the JSON schema.
- Do not change naming, branch creation, worktree creation, or shell integration behavior.
- PTY tests must skip cleanly when `expect` is unavailable.

---

### Task 1: Reproduce the retry and edit freeze in an automated PTY

**Files:**
- Modify: `test/cli.test.mjs`

**Interfaces:**
- Consumes: `BIN`, `repo`, `sandbox`, `shimDir`, `canaryAi()`, and the existing real-git test sandbox.
- Produces: `runInteractiveExpect(lines, ai)` returning the `spawnSync` result, plus two regression tests for continued line input and Ctrl-C.

- [ ] **Step 1: Add the PTY test helper and failing regression tests**

Add this helper after `canaryAi()`:

```js
function runInteractiveExpect(lines, ai) {
  const script = join(sandbox, 'interactive.exp');
  writeFileSync(script, [
    'set timeout 5',
    'set node [lindex $argv 0]',
    'set bin [lindex $argv 1]',
    'spawn $node $bin --no-cd',
    ...lines,
  ].join('\n') + '\n');
  const env = {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH}`,
    NO_COLOR: '1',
    GWQADD_AI: ai.bin,
  };
  delete env.FORCE_COLOR;
  return spawnSync('expect', [script, process.execPath, BIN], {
    cwd: repo,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}
```

Add the behavior tests:

```js
test('n and e return to responsive line prompts', (t) => {
  if (spawnSync('expect', ['-v'], { stdio: 'ignore' }).error) {
    return t.skip('expect not installed');
  }
  const ai = canaryAi();
  t.after(() => rmSync(ai.dir, { recursive: true, force: true }));
  const r = runInteractiveExpect([
    'expect "what do you want to do?"',
    'send -- "first description\\r"',
    'expect "create it?"',
    'send -- "n"',
    'expect "what do you want to do?"',
    'send -- "second description\\r"',
    'expect "create it?"',
    'send -- "e"',
    'expect "branch name (ascii):"',
    'send -- "\\025fix/edited-name\\r"',
    'expect eof',
    'set result [wait]',
    'exit [lindex $result 3]',
  ], ai);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(branchExists('fix/edited-name'), true);
});

test('Ctrl-C after edit exits 130', (t) => {
  if (spawnSync('expect', ['-v'], { stdio: 'ignore' }).error) {
    return t.skip('expect not installed');
  }
  const ai = canaryAi();
  t.after(() => rmSync(ai.dir, { recursive: true, force: true }));
  const r = runInteractiveExpect([
    'expect "what do you want to do?"',
    'send -- "description\\r"',
    'expect "create it?"',
    'send -- "e"',
    'expect "branch name (ascii):"',
    'send -- "\\003"',
    'expect eof',
    'set result [wait]',
    'exit [lindex $result 3]',
  ], ai);
  assert.equal(r.status, 130, `${r.stdout}\n${r.stderr}`);
  assert.equal(branchExists('feat/a'), false, 'interrupt creates nothing');
});
```

- [ ] **Step 2: Run only the new tests and verify RED**

Run:

```bash
node --test --test-name-pattern='n and e return|Ctrl-C after edit' test/cli.test.mjs
```

Expected: both tests fail on the existing implementation because the prompt after `n` or `e` receives no data and `expect` times out.

- [ ] **Step 3: Commit the failing tests**

```bash
git add test/cli.test.mjs
git commit -m "test: reproduce branch-name retry freeze"
```

---

### Task 2: Preserve readline state across confirmation choices

**Files:**
- Modify: `bin/gwqadd.mjs`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Consumes: `waitForKey()`, `askLine()`, and `die('E_INTERRUPTED', ...)`.
- Produces: responsive line prompts after raw-key input and exit status 130 for Ctrl-C.

- [ ] **Step 1: Remove blanket listener deletion**

Change `waitForKey()` so it starts directly with raw-mode setup:

```js
async function waitForKey() {
  try {
    process.stdin.setRawMode(true);
    rawModeEngaged = true;
  } catch { /* setRawMode throws on non-TTY; let the keypress fall through */ }
```

Keep the existing local `handler`, its `removeListener('data', handler)`, and the existing `finally` cleanup unchanged.

- [ ] **Step 2: Map readline Ctrl-C to E_INTERRUPTED**

Update `askLine()`:

```js
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
```

- [ ] **Step 3: Run the PTY regressions and verify GREEN**

Run:

```bash
node --test --test-name-pattern='n and e return|Ctrl-C after edit' test/cli.test.mjs
```

Expected: 2 passing tests, no failures.

- [ ] **Step 4: Run the complete test suite**

Run:

```bash
npm test
```

Expected: all installed-tool tests pass, with only existing optional-tool skips.

- [ ] **Step 5: Commit the fix**

```bash
git add bin/gwqadd.mjs
git commit -m "fix: keep branch-name retries responsive"
```

---

### Task 3: Verify and prepare the pull request

**Files:**
- Verify: `bin/gwqadd.mjs`
- Verify: `test/cli.test.mjs`
- Verify: `docs/superpowers/specs/2026-08-15-branch-name-retry-freeze-design.md`

**Interfaces:**
- Consumes: committed fix and regression tests.
- Produces: verified branch ready for review and publication.

- [ ] **Step 1: Run static and package checks**

Run:

```bash
node --check bin/gwqadd.mjs
npm test
npm pack --dry-run
git diff --check origin/main...HEAD
```

Expected: every command exits 0; test output has no failures; package contents remain within the established manifest.

- [ ] **Step 2: Manually verify the real interactive transition**

Run the CLI in a PTY with the deterministic AI shim, choose `e`, edit the pre-filled name, and submit it. Repeat and choose `n`, then enter a new description. Cancel before creating any extra persistent branch.

Expected: both line prompts accept input immediately, and Ctrl-C exits rather than hanging.

- [ ] **Step 3: Review the complete diff**

Run:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
git status --short --branch
```

Expected: only the design, plan, regression test, and focused terminal-input fix are present; the worktree is clean.
