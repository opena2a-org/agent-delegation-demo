// A deny form seen not refusing, as the view server answers it: the read
// under the credential store deny form succeeded inside, or the copy of
// /usr/bin/true under the exec deny form was executed inside. The server
// stops its current run and refuses every later scenario run and offline
// check of that session with the control's reason. Any other answer of the
// check, not measured or not run, stops nothing. Each test feeds an input
// that breaks one rule (a profile edit, a stand in timing for an outside
// half); none edits the harness.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownAddress } from '../src/egress/controls.mjs';
import { freeLoopbackPort } from '../src/orchestrator/ports.mjs';
import { realExecPath, sandboxStatus } from '../src/orchestrator/sandbox.mjs';
import { ViewServer } from '../src/server/main.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADLESS = path.join(ROOT, 'test', 'support', 'headless-offline.mjs');
const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); the offline check needs the OS sandbox and does not run without it';

// The reasons, byte for byte as the screen prints them.
const REASON = Object.freeze({
  addressControl: "the control to this machine's address failed",
  storeControl: 'the control reading a test file failed',
  notApplied: 'the sandbox could not be applied',
});

// A short directory under /tmp, so the Unix socket paths of the run
// directories made inside it stay within the system's limit.
function scratch() {
  return fs.realpathSync(fs.mkdtempSync('/tmp/bank-demo-test-'));
}

function subjectEnv(dir) {
  const home = path.join(dir, 'home');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(tmp, { mode: 0o700 });
  return { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, LANG: 'C', TZ: 'UTC' };
}

const runDirs = (tmp) => fs.readdirSync(tmp).filter((n) => n.startsWith('bank-demo-run-')).map((n) => path.join(tmp, n));

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

// A reader in place of the kernel witness: it records each call.
function readerStandIn() {
  const calls = [];
  return { calls, read: (args) => { calls.push(args); return { standIn: calls.length }; } };
}

// A view server with a current run, for the tests that expect nothing to
// stop: it answers the given test, then stops.
async function withCurrentRun(offlineOptions, body) {
  const port = await freeLoopbackPort();
  const view = new ViewServer({ port, offlineOptions });
  let componentExits = 0;
  view.onComponentExit = () => { componentExits += 1; };
  await view.listen();
  try {
    assert.equal((await call(port, 'POST', '/api/run', { scenario: 'setup' })).status, 200);
    await body({ port, view, run: view.current.run, componentExits: () => componentExits });
  } finally {
    await view.stop();
  }
}

// Nothing stopped: the current run is the one from before the check and
// still runs, no component exit was reported, the next scenario runs on
// the grant path, and the next check is answered, not refused.
async function assertNothingStopped({ port, view, run, componentExits }, status) {
  // The launcher reports a component exit 500 ms after its rule is called.
  await new Promise((resolve) => { setTimeout(resolve, 1000); });
  assert.equal(componentExits(), 0);
  assert.equal(run.stopped, false);
  assert.equal(view.current.run, run);
  const one = await call(port, 'POST', '/api/run', { scenario: '1' });
  assert.equal(one.status, 200);
  assert.ok(one.json.steps['1'].B.bankDecision, 'scenario 1 ran on the grant path');
  const again = await call(port, 'POST', '/api/offline');
  assert.deepEqual([again.status, again.json.status], [200, status]);
}

test('a profile without the sentinel deny, through the API: the check answers, the current run stops, and the next scenario run and the next offline check of that session are refused with the store control\'s reason; nothing more starts', () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = scratch();
  const env = subjectEnv(dir);
  const opts = { open: false, dropSentinel: true, runBefore: 'setup', runAfter: '1' };
  const r = spawnSync(realExecPath(), [HEADLESS, JSON.stringify(opts)], { env, cwd: dir, encoding: 'utf8', timeout: 240000 });
  const last = r.stdout.trim().split('\n').pop();
  assert.ok(last, `no answer from the headless rerun: ${r.stderr}`);
  const out = JSON.parse(last);
  assert.equal(r.status, 1);

  // The check answered, and its store row shows the form not refusing.
  assert.equal(out.httpStatus, 200);
  const row = out.result.controls.find((c) => c.id === 'store deny form');
  assert.equal(row.insideOutcome, 'read', PRE);
  assert.equal(out.result.status, 'not measured');
  assert.ok(out.result.reasons.includes(REASON.storeControl), JSON.stringify(out.result.reasons));

  // The run that was current before the check stopped, and none took its place.
  assert.equal(out.before.status, 200);
  assert.match(String(out.before.runId), /^[0-9a-f]+$/);
  assert.equal(out.runBeforeStopped, true);
  assert.equal(out.currentRunId, null);

  // Refused, each with the store control's reason.
  for (const answer of [out.runAfter, out.offlineAgain]) {
    assert.equal(answer.status, 409);
    assert.deepEqual([answer.json.error, answer.json.reason], ['request refused', REASON.storeControl]);
  }
  assert.equal(out.currentAfter, null);

  // Nothing more started: the setup run's directory and the check's blocked
  // run are the two run directories there are, and the blocked run holds no
  // bank.
  const dirs = runDirs(env.TMPDIR);
  const blocked = dirs.filter((d) => fs.existsSync(path.join(d, 'egress.sb')));
  assert.equal(blocked.length, 1, 'a second offline check started');
  assert.equal(fs.existsSync(path.join(blocked[0], 'bank')), false, 'a bank started under the profile');
  assert.equal(dirs.length, 2, 'a scenario run started after the stop');

  // The view keeps serving, and the stop is not a component exit.
  assert.equal(out.indexStatus, 200);
  assert.equal(out.componentExits, 0);

  // The result records the profile as edited, and the kernel witness's
  // reading of the rerun's root, taken while the root still ran under its
  // profile: the witness's lines and its exit code.
  assert.equal(out.result.profileEdited, true);
  const w = out.result.witness;
  assert.ok([0, 1, 2].includes(w.exitCode), JSON.stringify(w));
  assert.ok(w.lines.some((l) => /^rerun \(pid \d+\) .*\bsandboxed 1\b/.test(l)), JSON.stringify(w.lines));
});

test('the outside half of the control to this machine\'s address fails (a stand in timing): the count reads not measured, no deny form was seen not refusing, and nothing stops', async () => {
  assert.equal(sandboxStatus().available, true, PRE);
  assert.ok(ownAddress(), 'precondition: a network interface besides loopback');
  // An answer from the host 2.5 s after the connect, outside the block.
  const late = async () => ({ outcome: 'ECONNREFUSED', ms: 2500 });
  const reader = readerStandIn();
  await withCurrentRun({ open: false, connect: late, readWitness: reader.read }, async (ctx) => {
    const r = await call(ctx.port, 'POST', '/api/offline');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'not measured', PRE);
    assert.ok(r.json.reasons.includes(REASON.addressControl), JSON.stringify(r.json.reasons));
    const inside = Object.fromEntries(r.json.controls.map((c) => [c.id, c.insideOutcome]));
    assert.deepEqual([inside['store deny form'], inside['exec deny form']], ['EPERM', 'EPERM']);
    assert.equal(r.json.profileEdited, false);
    assert.equal(r.json.witness, null);
    assert.deepEqual(reader.calls, []);
    await assertNothingStopped(ctx, 'not measured');
  });
});

test('a check that was not run (a profile that does not parse): nothing stops, and the next scenario run starts', async () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const reader = readerStandIn();
  const unparsed = (p) => `${p}(not a rule\n`;
  await withCurrentRun({ open: false, editProfile: unparsed, readWitness: reader.read }, async (ctx) => {
    const r = await call(ctx.port, 'POST', '/api/offline');
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.status, r.json.reason], ['not run', REASON.notApplied], PRE);
    // A check that was not run carries no profile record.
    for (const key of ['profileEdited', 'witness']) assert.equal(key in r.json, false, key);
    assert.deepEqual(reader.calls, []);
    await assertNothingStopped(ctx, 'not run');
  });
});
