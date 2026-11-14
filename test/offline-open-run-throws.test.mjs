// The offline check when its network open run throws after the rerun's root
// process answered ready: the rerun is not asked, so it stopped before it
// finished. The check answers that ending itself and never throws to the
// request handler. It answers once the root and every process the open run
// started have ended, with the rerun ended without four decisions as its
// reason, no count, no comparison and no text of the open run's error. Before
// it answers it writes one record to its run log, <runDir>/offline/not-run.json:
// what the open run threw and how sandbox-exec ended. Each test starts a
// stand in for sandbox-exec through the check's sandboxExec option and gives
// the check a chain the open run throws on: a step the scenarios do not
// have, so it throws before it starts any process, or scenario 4 without
// scenario 1, so its step throws once the open run's bank and agents run.
// None edits the harness.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_RUN, readCounter } from '../src/egress/classify.mjs';
import { runOfflineCheckWithRun } from '../src/egress/offline.mjs';
import { freeLoopbackPort } from '../src/orchestrator/ports.mjs';
import { sandboxStatus } from '../src/orchestrator/sandbox.mjs';
import { offlineBlock } from '../src/runner/offline-text.mjs';
import { COPY } from '../src/scenarios/labels.mjs';
import { ViewServer } from '../src/server/main.mjs';
import { offlineState } from '../src/view/offline-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAND_IN_ROOT = path.join(ROOT, 'test', 'fixtures', 'egress', 'stand-in-root.mjs');
const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); the offline check needs the OS sandbox and does not run without it';

// The reason, byte for byte as the screen prints it, and the state it reads
// under: the count reads not measured.
const STOPPED = 'the rerun ended without four decisions';
const STOPPED_STATE = 'not measured';
// A step the scenarios do not have: the open run throws on it before it
// starts a process.
const STEP = 'a-step-the-scenarios-do-not-have';

// A short directory under /tmp, so the Unix socket paths of the run
// directories made inside it stay within the system's limit.
function scratch() {
  return fs.realpathSync(fs.mkdtempSync('/tmp/bank-demo-test-'));
}

// A stand in for sandbox-exec, started as <it> -f <profile> <node> <rerun
// file>: "$3" is this Node.js. The shell writes its pid, then applies the
// profile "$2" names and starts the stand in root under it in its own place,
// with the counter loaded, so the root keeps that pid. The root answers
// ready and waits to be asked.
function standIn(dir, pidFile) {
  const file = path.join(dir, 'sandbox-exec');
  fs.writeFileSync(file, ['#!/bin/sh', `echo $$ > '${pidFile}'`, `exec /usr/bin/sandbox-exec -f "$2" "$3" '${STAND_IN_ROOT}' ends`, ''].join('\n'), { mode: 0o700 });
  return file;
}

const runDirs = (tmp) => fs.readdirSync(tmp).filter((n) => n.startsWith('bank-demo-run-')).map((n) => path.join(tmp, n));

// The check with the given chain, under its own TMPDIR, where the test lists
// the run directories it made. It returns the answer, or what the check threw.
async function check(chain) {
  const dir = scratch();
  const pidFile = path.join(dir, 'root.pid');
  const sandboxExec = standIn(dir, pidFile);
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp, { mode: 0o700 });
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  try {
    return { answer: await runOfflineCheckWithRun({ sandboxExec, chain }), thrown: null, tmp, pidFile };
  } catch (err) {
    return { answer: null, thrown: err, tmp, pidFile };
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

// The pids a run's counted processes recorded: each hello line, and each
// child a counted process started.
function recordedPids(runDir) {
  const pids = new Set();
  for (const l of readCounter(path.join(runDir, 'egress.jsonl')).lines) {
    if (l.kind === 'hello' && l.main) pids.add(l.pid);
    if (l.kind === 'child' && Number.isInteger(l.childPid) && l.childPid > 0) pids.add(l.childPid);
  }
  return [...pids];
}

const rootPid = (pidFile) => Number(fs.readFileSync(pidFile, 'utf8').trim());

function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

// Every string a value holds, at any depth.
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

async function call(port, method, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { method });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json };
}

// The rerun ended without four decisions, with no count, no decision on either
// side, no comparison, nothing of how sandbox-exec ended and no text of the
// open run's error (thrownText is a part of it).
function assertStoppedBeforeAsked(r, thrownText) {
  assert.equal(r.status, STOPPED_STATE, PRE);
  assert.equal(r.reason, STOPPED);
  assert.deepEqual(r.reasons, [STOPPED]);
  for (const reason of r.reasons) assert.equal(Object.values(NOT_RUN).includes(reason), false, reason);
  assert.match(r.runId, /^[0-9a-f]{8}$/);
  assert.equal(r.rerunError, null, 'the rerun did not fail');
  assert.equal(r.openRun, null);
  assert.equal(r.egressAttempts, null);
  assert.equal(r.allSame, false);
  assert.deepEqual(r.controls, []);
  for (const o of r.outcomes) assert.deepEqual([o.open, o.blocked, o.same], [null, null, null], `scenario ${o.scenario}`);
  assert.equal(JSON.stringify(r).includes(thrownText), false, `"${thrownText}" is in the result`);
  for (const s of strings(r)) {
    assert.equal(/unknown step|sandbox-exec|\bexit\b|\bsignal\b|stderr/i.test(s), false, s);
  }
}

test('a network open run that throws after the rerun\'s root answered ready: the check answers with the rerun ended without four decisions, no count and no comparison, after the root has ended, and keeps one run log record of what the open run threw and how sandbox-exec ended', async () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const { answer, thrown, tmp, pidFile } = await check([STEP]);
  // One run directory, the rerun's: the open run threw before it started a
  // process.
  const dirs = runDirs(tmp);
  assert.equal(dirs.length, 1, 'one run directory, the rerun\'s');
  const logFile = path.join(dirs[0], 'offline', 'not-run.json');
  assert.equal(thrown, null, `the check threw "${thrown && thrown.message}" and wrote ${fs.existsSync(logFile) ? 'a' : 'no'} run log`);
  assert.equal(answer.runDir, dirs[0]);
  const r = answer.result;
  assertStoppedBeforeAsked(r, STEP);

  // The text block and the screen: the reason, no digit after "attempts:"
  // and no comparison word; the screen's rows hold no decision.
  const text = offlineBlock(r);
  const lines = text.split('\n').map((l) => l.trim());
  assert.deepEqual(lines.filter((l) => /attempts:/i.test(l)), [`Outbound connection attempts: not measured (${STOPPED}).`], text);
  assert.equal(/attempts:[^\n]*\d/i.test(text), false, text);
  assert.equal(/matched|Same four decisions|\bsame\b|\bdifferent\b/i.test(text), false, text);
  const m = offlineState(COPY, r);
  assert.equal(m.state, 'not-measured');
  assert.equal(m.right.outcome, null);
  assert.deepEqual(m.right.result, [{ text: COPY.RULED_EXTRA.offlineNotMeasured, values: { reason: STOPPED } }]);
  for (const [label, value] of m.right.rows) assert.equal(value, null, label);
  assert.deepEqual(m.failed, []);

  // The run log: one JSON line, mode 0600, with the result's status and
  // reason, what the open run threw, and how sandbox-exec ended once the
  // check stopped it. No string in it holds a host path.
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
  const raw = fs.readFileSync(logFile, 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(raw.trimEnd().split('\n').length, 1, raw);
  const log = JSON.parse(raw);
  assert.deepEqual(Object.keys(log), ['status', 'runId', 'reason', 'openRun', 'spawnError', 'exitCode', 'signal', 'stderr']);
  assert.equal(log.status, r.status);
  assert.equal(log.runId, r.runId);
  assert.equal(log.reason, STOPPED);
  assert.deepEqual(Object.keys(log.openRun), ['error', 'code', 'message', 'runId']);
  assert.equal(log.openRun.error, 'Error');
  assert.equal(log.openRun.code, null);
  assert.match(log.openRun.message, /unknown step/);
  // The open run threw before it had a run of its own.
  assert.equal(log.openRun.runId, null);
  // The stand in root ends with exit 0 when the check stops it.
  assert.deepEqual([log.spawnError, log.exitCode, log.signal], [null, 0, null]);
  for (const s of strings(log)) assert.equal(s.includes('/'), false, `a host path in the run log: ${s}`);

  // The root process has ended.
  const pid = rootPid(pidFile);
  assert.ok(Number.isInteger(pid) && pid > 0, 'the root\'s pid');
  assert.equal(running(pid), false, `the root process ${pid} is still running`);
});

test('the same ending through the view server: POST /api/offline answers 200 with the result, GET /api/offline then answers the record with that run id, and the component exit rule does not fire', async () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = scratch();
  const sandboxExec = standIn(dir, path.join(dir, 'root.pid'));
  const port = await freeLoopbackPort();
  const view = new ViewServer({ port, offlineOptions: { sandboxExec, chain: [STEP] } });
  let componentExits = 0;
  view.onComponentExit = () => { componentExits += 1; };
  await view.listen();
  try {
    const posted = await call(port, 'POST', '/api/offline');
    const again = await call(port, 'GET', '/api/offline');
    assert.deepEqual([posted.status, again.status], [200, 200], JSON.stringify({ post: posted.json, get: again.json }));
    assertStoppedBeforeAsked(posted.json, STEP);
    assert.equal(again.json.runId, posted.json.runId);
    assert.deepEqual(again.json, posted.json);
    // The launcher reports a component exit 500 ms after its rule is called.
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
    assert.equal(componentExits, 0);
  } finally {
    await view.stop();
  }
});

test('a network open run whose step throws after its bank and agents started: the check answers with the rerun ended without four decisions once the root and every process the open run started have ended, and keeps the throw in its run log', async () => {
  assert.equal(sandboxStatus().available, true, PRE);
  // Scenario 4 disputes scenario 1's payment; with no scenario 1 before it,
  // its step throws once the open run's processes run.
  const { answer, thrown, tmp, pidFile } = await check(['4']);
  assert.equal(thrown, null, `the check threw "${thrown && thrown.message}"`);
  assertStoppedBeforeAsked(answer.result, 'Cannot read properties');
  const log = JSON.parse(fs.readFileSync(path.join(answer.runDir, 'offline', 'not-run.json'), 'utf8'));
  assert.deepEqual([log.status, log.runId, log.reason], [answer.result.status, answer.result.runId, STOPPED]);
  assert.deepEqual([log.openRun.error, log.openRun.code], ['TypeError', null]);
  assert.match(log.openRun.message, /Cannot read properties/);
  // The open run's own directory, beside the rerun's, holds the pids its
  // processes recorded: the bank and the four agents at least.
  const openDirs = runDirs(tmp).filter((d) => d !== answer.runDir);
  assert.equal(openDirs.length, 1, 'the open run\'s run directory');
  const pids = recordedPids(openDirs[0]);
  assert.ok(pids.length >= 5, `the open run recorded ${pids.length} processes`);
  for (const pid of [...pids, rootPid(pidFile)]) assert.equal(running(pid), false, `process ${pid} is still running`);
});
