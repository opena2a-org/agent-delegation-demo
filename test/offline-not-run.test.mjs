// The offline check when its rerun cannot start under its own profile: it
// reads not run with one reason, sandbox-exec is not started a second time,
// nothing else of the check starts, and the rest of the demo keeps working.
// Each test feeds an input that breaks the rule (a parent process already
// inside another sandbox profile, a profile that does not parse, a
// sandbox-exec that ends in each way it can); none edits the harness. The
// test runner runs outside any sandbox profile; the processes the tests start
// run inside one, and the runner never does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOfflineCheckWithRun } from '../src/egress/offline.mjs';
import { freeLoopbackPort } from '../src/orchestrator/ports.mjs';
import { SANDBOX_EXEC, realExecPath, sandboxStatus, writeProfile } from '../src/orchestrator/sandbox.mjs';
import { ViewServer } from '../src/server/main.mjs';
import { NOT_APPLIED, NO_SANDBOX, OUTER, assertEndNotInAnswer, assertNotRun, readRunLog } from './support/not-run.mjs';
import { outerProfileText } from './support/profiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADLESS = path.join(ROOT, 'test', 'support', 'headless-offline.mjs');
const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); the offline check needs the OS sandbox and does not run without it';
const APPLY_REFUSED = 'sandbox-exec: sandbox_apply: Operation not permitted';

// A short directory under /tmp, so the Unix socket paths of the run
// directories made inside it stay within the system's limit.
function scratch() {
  return fs.realpathSync(fs.mkdtempSync('/tmp/bank-demo-test-'));
}

// The parent's own profile: the exec of a copy of /usr/bin/true that belongs
// to the test refused, beside the boundary's terms.
function outerProfile(dir) {
  const denied = path.join(dir, 'true');
  fs.copyFileSync('/usr/bin/true', denied);
  fs.chmodSync(denied, 0o700);
  const file = path.join(dir, 'outer.sb');
  writeProfile(file, outerProfileText([`(deny process-exec (literal "${denied}"))`]));
  return file;
}

// The environment of a process the test starts: its own HOME, and its own
// TMPDIR, under which it makes its run directories, where the test lists them.
function subjectEnv(dir) {
  const home = path.join(dir, 'home');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(tmp, { mode: 0o700 });
  return { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, LANG: 'C', TZ: 'UTC' };
}

const runDirs = (tmp) => fs.readdirSync(tmp).filter((n) => n.startsWith('bank-demo-run-')).map((n) => path.join(tmp, n));

// One headless rerun through the API, inside the given profile or none.
function headless(dir, opts = {}, outer = null) {
  const env = subjectEnv(dir);
  const argv = [realExecPath(), HEADLESS, JSON.stringify(opts)];
  const r = outer
    ? spawnSync(SANDBOX_EXEC, ['-f', outer, ...argv], { env, cwd: dir, encoding: 'utf8', timeout: 240000 })
    : spawnSync(argv[0], argv.slice(1), { env, cwd: dir, encoding: 'utf8', timeout: 240000 });
  const last = r.stdout.trim().split('\n').pop();
  assert.ok(last, `no answer from the headless rerun: ${r.stderr}`);
  return { status: r.status, out: JSON.parse(last), env };
}

// A stand in for sandbox-exec that ends the given way and starts nothing.
function stub(dir, name, lines) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, ['#!/bin/sh', ...lines, ''].join('\n'), { mode: 0o700 });
  return file;
}

// The profile the rerun was given: the credential store denies under the
// account's own home directory, never under the HOME its parent was given.
function assertStoreDenies(profile, subjectHome) {
  const home = fs.realpathSync(os.userInfo().homedir);
  assert.ok(profile.includes(`(subpath "${home}/.secretless-ai")`), 'the store deny names the account home');
  assert.ok(profile.includes(`(subpath "${home}/Library/Keychains")`), 'the keychain deny names the account home');
  assert.equal(profile.includes(subjectHome), false, 'a deny names the HOME the parent was given');
  assert.ok(profile.includes('(literal "/usr/bin/security")'), 'the keychain tool is refused by name');
  assert.equal(profile.includes('localhost:*'), false);
}

async function call(port, method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json };
}

test('a parent already inside another sandbox profile asks for the offline check: not run, the demo is already inside another sandbox, no digit, no counter file, and the view server keeps serving', () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = scratch();
  const h = headless(dir, {}, outerProfile(dir));
  assert.equal(h.status, 1, 'a headless rerun that was not run exits non-zero');
  assert.equal(h.out.httpStatus, 200);
  assertNotRun(h.out.result, OUTER);
  assert.equal(h.out.indexStatus, 200);
  assert.equal(h.out.componentExits, 0);
  // One run directory, the rerun's: the run as usual did not start. No
  // process wrote through the counter, so there is no counter file to read.
  const dirs = runDirs(h.env.TMPDIR);
  assert.equal(dirs.length, 1);
  assert.equal(fs.existsSync(path.join(dirs[0], 'egress.jsonl')), false, 'a counter file');
  assert.deepEqual(readRunLog(dirs[0]), {
    status: 'not run', runId: h.out.result.runId, reason: OUTER, spawnError: null, exitCode: 71, signal: null, stderr: APPLY_REFUSED,
  });
  assertEndNotInAnswer(h.out.result, { exitCode: 71, stderr: APPLY_REFUSED });
  assertStoreDenies(fs.readFileSync(path.join(dirs[0], 'egress.sb'), 'utf8'), h.env.HOME);
});

test('each way sandbox-exec ends before the rerun writes its hello line has one reason; nothing else of the check starts, the end goes to the run log and nowhere else, and the view server keeps serving', () => {
  const dir = scratch();
  const cases = [
    { name: 'not there', file: path.join(dir, 'no-sandbox-exec'), reason: NO_SANDBOX, end: { spawnError: 'ENOENT', exitCode: null, signal: null, stderr: null } },
    { name: 'apply refused', lines: [`echo '${APPLY_REFUSED}' >&2`, 'exit 71'], reason: OUTER, end: { spawnError: null, exitCode: 71, signal: null, stderr: APPLY_REFUSED } },
    { name: 'exit 71, another line', lines: ["echo 'sandbox-exec: something else' >&2", 'exit 71'], reason: NOT_APPLIED, end: { spawnError: null, exitCode: 71, signal: null, stderr: 'sandbox-exec: something else' } },
    { name: 'profile does not parse', lines: ["echo \"sandbox-exec: syntax error: expecting ')'\" >&2", 'exit 65'], reason: NOT_APPLIED, end: { spawnError: null, exitCode: 65, signal: null, stderr: "sandbox-exec: syntax error: expecting ')'" } },
    { name: 'exit 0', lines: ['exit 0'], reason: NOT_APPLIED, end: { spawnError: null, exitCode: 0, signal: null, stderr: null } },
    { name: 'killed', lines: ['kill -9 $$'], reason: NOT_APPLIED, end: { spawnError: null, exitCode: null, signal: 'SIGKILL', stderr: null } },
  ];
  for (const c of cases) {
    const caseDir = fs.mkdtempSync(path.join(dir, 'case-'));
    const sandboxExec = c.file ?? stub(caseDir, 'sandbox-exec', c.lines);
    const h = headless(caseDir, { sandboxExec });
    assert.equal(h.status, 1, `${c.name}: a headless rerun that was not run exits non-zero`);
    assert.equal(h.out.httpStatus, 200, c.name);
    assertNotRun(h.out.result, c.reason);
    assert.equal(h.out.indexStatus, 200, c.name);
    assert.equal(h.out.componentExits, 0, c.name);
    const dirs = runDirs(h.env.TMPDIR);
    assert.equal(dirs.length, 1, `${c.name}: one run directory, the rerun's`);
    assert.equal(fs.existsSync(path.join(dirs[0], 'egress.jsonl')), false, `${c.name}: a counter file`);
    assert.deepEqual(readRunLog(dirs[0]), { status: 'not run', runId: h.out.result.runId, reason: c.reason, ...c.end }, c.name);
    assertEndNotInAnswer(h.out.result, { exitCode: c.end.exitCode, stderr: c.end.stderr });
  }
});

test('the run as usual starts after the rerun wrote its hello line, never before: when sandbox-exec ends before it, the check made one run directory, the rerun\'s', async () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = scratch();
  const refused = stub(dir, 'sandbox-exec', [`echo '${APPLY_REFUSED}' >&2`, 'exit 71']);
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp, { mode: 0o700 });
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  let r;
  try {
    r = await runOfflineCheckWithRun({ sandboxExec: refused });
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
  assert.deepEqual(runDirs(tmp), [r.runDir], 'a run directory besides the rerun\'s');
  assertNotRun(r.result, OUTER);
});

test('no second try: when the apply fails, sandbox-exec was started once, with -f and the rerun profile, and no rerun process wrote a hello line', async () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = scratch();
  // Records each call, one line of tab separated arguments, then runs the
  // real sandbox-exec in its own place.
  const recorder = (where) => {
    const calls = path.join(where, 'calls.tsv');
    const file = stub(where, 'sandbox-exec', [
      `printf '%s' "$#" >> '${calls}'`,
      `for a in "$@"; do printf '\\t%s' "$a" >> '${calls}'; done`,
      `printf '\\n' >> '${calls}'`,
      `exec ${SANDBOX_EXEC} "$@"`,
    ]);
    return { file, calls: () => fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => l.split('\t')) };
  };
  const argsOf = (runDir) => ['4', '-f', path.join(runDir, 'egress.sb'), realExecPath(), path.join(ROOT, 'src', 'egress', 'rerun.mjs')];

  // A profile that does not parse: sandbox-exec exits 65.
  const parse = recorder(fs.mkdtempSync(path.join(dir, 'parse-')));
  const { result: r, runDir, egressLog } = await runOfflineCheckWithRun({ sandboxExec: parse.file, editProfile: (p) => `${p}(allow\n` });
  assertNotRun(r, NOT_APPLIED);
  assert.deepEqual(parse.calls(), [argsOf(runDir)]);
  assert.equal(fs.existsSync(egressLog), false, 'a process wrote through the counter');
  const log = readRunLog(runDir);
  assert.deepEqual([log.reason, log.spawnError, log.exitCode], [NOT_APPLIED, null, 65]);
  assert.match(log.stderr, /^sandbox-exec: syntax error/);
  assertEndNotInAnswer(r, { exitCode: 65, stderr: log.stderr });

  // A parent inside another profile: sandbox-exec exits 71.
  const outerDir = fs.mkdtempSync(path.join(dir, 'outer-'));
  const nested = recorder(outerDir);
  const h = headless(outerDir, { sandboxExec: nested.file }, outerProfile(outerDir));
  assertNotRun(h.out.result, OUTER);
  const [rerunDir] = runDirs(h.env.TMPDIR);
  assert.deepEqual(nested.calls(), [argsOf(rerunDir)]);
  assert.equal(fs.existsSync(path.join(rerunDir, 'egress.jsonl')), false, 'a process wrote through the counter');
});

test('an apply refusal is a screen state: the view server keeps serving, the current run and the scenarios keep working, and the component exit rule does not fire', async () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = scratch();
  const refused = stub(dir, 'sandbox-exec', [`echo '${APPLY_REFUSED}' >&2`, 'exit 71']);
  const port = await freeLoopbackPort();
  const view = new ViewServer({ port, offlineOptions: { sandboxExec: refused } });
  let componentExits = 0;
  view.onComponentExit = () => { componentExits += 1; };
  await view.listen();
  try {
    assert.equal((await call(port, 'POST', '/api/run', { scenario: 'setup' })).status, 200);
    const runId = view.current.run.runId;
    const r = await call(port, 'POST', '/api/offline');
    assert.equal(r.status, 200);
    assertNotRun(r.json, OUTER);
    // The launcher reports a component exit 500 ms after its rule is called.
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
    assert.equal(componentExits, 0);
    assert.equal((await call(port, 'GET', '/')).status, 200);
    assert.equal((await call(port, 'GET', '/health')).json.ok, true);
    assert.equal(view.current.run.runId, runId);
    const again = await call(port, 'GET', '/api/offline');
    assert.deepEqual([again.status, again.json.status, again.json.reason], [200, 'not run', OUTER]);
    const one = await call(port, 'POST', '/api/run', { scenario: '1' });
    assert.equal(one.status, 200);
    assert.ok(one.json.steps['1'].B.bankDecision, 'scenario 1 ran on the grant path');
    assert.equal(componentExits, 0);
  } finally {
    await view.stop();
  }
});

test('where an exit code is the verdict, not run and not measured exit non-zero: the offline tests inside another profile, and a headless rerun through the API', () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = scratch();
  // The test of a stray request, run inside another profile: the check reads
  // not run, so the test fails and its runner exits non-zero.
  const suiteDir = fs.mkdtempSync(path.join(dir, 'suite-'));
  const suite = spawnSync(SANDBOX_EXEC, ['-f', outerProfile(suiteDir), realExecPath(), '--test', '--test-name-pattern', 'a stray request', path.join(ROOT, 'test', 'offline.test.mjs')], {
    env: subjectEnv(suiteDir),
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 240000,
  });
  assert.equal(Number.isInteger(suite.status), true, 'the suite ended with an exit code');
  assert.notEqual(suite.status, 0);
  assert.match(suite.stdout, /a stray request/);

  // Not measured: a profile widened to localhost:* fails the address control.
  const widened = headless(fs.mkdtempSync(path.join(dir, 'widened-')), { open: false, widenLoopback: true });
  assert.equal(widened.out.result.status, 'not measured', PRE);
  assert.equal(widened.status, 1);
  // Measured: the same rerun with its profile as written exits 0.
  const measured = headless(fs.mkdtempSync(path.join(dir, 'measured-')), { open: false });
  assert.equal(measured.out.result.status, 'measured', PRE);
  assert.equal(measured.status, 0);
});

test('npm run scenarios starts no offline rerun: no rerun profile, no offline directory and no offline block', () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.scenarios, 'node src/runner/text.mjs');
  const dir = scratch();
  const env = subjectEnv(dir);
  const r = spawnSync(realExecPath(), [path.join(ROOT, 'src', 'runner', 'text.mjs')], { env, cwd: ROOT, encoding: 'utf8', timeout: 240000 });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Agent banking delegation demo: the scenarios on both paths$/m);
  assert.equal(r.stdout.includes('Offline check'), false);
  const dirs = runDirs(env.TMPDIR);
  assert.ok(dirs.length >= 2, 'the runner made its runs under this TMPDIR');
  for (const d of dirs) {
    assert.equal(fs.existsSync(path.join(d, 'egress.sb')), false, 'a rerun profile');
    assert.equal(fs.existsSync(path.join(d, 'offline')), false, 'an offline directory');
  }
});
