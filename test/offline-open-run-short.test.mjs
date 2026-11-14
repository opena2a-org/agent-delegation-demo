// The offline check when its network open run returns without a complete
// answer: with no decision for scenario 4, or with no decision for the cross
// case. An open run with no complete answer to compare has not completed, so
// the check ends it the way it ends an open run that throws: the rerun is not
// asked, and the check answers once the root and every process the open run
// started have ended, with the rerun ended without four decisions as its
// reason, no count and no comparison. The open run's decisions stay on its
// side, the cross row has no decision to compare, and the keys the open run's
// answer lacked go to the run log, <runDir>/offline/not-run.json, and never to
// the result. Each test starts a stand in for sandbox-exec through the check's
// sandboxExec option, whose root answers the rerun with a decision for each of
// the four scenarios and for the cross case whenever it is asked, and gives
// the check a chain the real open run completes short: the shipped chain
// without scenario 4, or the four scenarios without the cross case. None edits
// the harness.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_MEASURED, readCounter } from '../src/egress/classify.mjs';
import { runOfflineCheckWithRun } from '../src/egress/offline.mjs';
import { sandboxStatus } from '../src/orchestrator/sandbox.mjs';
import { offlineBlock } from '../src/runner/offline-text.mjs';
import { COPY } from '../src/scenarios/labels.mjs';
import { offlineState } from '../src/view/offline-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAND_IN_ROOT = path.join(ROOT, 'test', 'fixtures', 'egress', 'stand-in-root.mjs');
const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); the offline check needs the OS sandbox and does not run without it';
const SCREEN = COPY.SCREENS.find((s) => s.id === 'offline');

// The reason, byte for byte as the screen prints it, and the state it reads
// under: the count reads not measured.
const STOPPED = NOT_MEASURED.rerunStopped;
const STOPPED_STATE = 'not measured';

// A short directory under /tmp, so the Unix socket paths of the run
// directories made inside it stay within the system's limit.
function scratch() {
  return fs.realpathSync(fs.mkdtempSync('/tmp/bank-demo-test-'));
}

// A stand in for sandbox-exec, started as <it> -f <profile> <node> <rerun
// file>: "$3" is this Node.js. The shell writes its pid, then applies the
// profile "$2" names and starts the stand in root under it in its own place,
// with the counter loaded, so the root keeps that pid. The root answers ready
// and, whenever it is asked, answers the rerun with a decision for each of the
// four scenarios and for the cross case.
function standIn(dir, pidFile) {
  const file = path.join(dir, 'sandbox-exec');
  fs.writeFileSync(file, ['#!/bin/sh', `echo $$ > '${pidFile}'`, `exec /usr/bin/sandbox-exec -f "$2" "$3" '${STAND_IN_ROOT}' five-decisions`, ''].join('\n'), { mode: 0o700 });
  return file;
}

const runDirs = (tmp) => fs.readdirSync(tmp).filter((n) => n.startsWith('bank-demo-run-')).map((n) => path.join(tmp, n));

// The check with the given chain and its network open run left on, under its
// own TMPDIR, where the test lists the run directories it made. It returns
// the answer, or what the check threw.
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

// The check on a chain its network open run completes short of a decision
// for each key in lacked, with the rerun's root ready to answer in full. It
// answers the rerun ended without four decisions with no count and no
// comparison, keeps the open run's decisions on its side, writes the keys
// the open run lacked to its run log and nowhere else, and answers once the
// root and every process the open run started have ended.
async function assertEndsShort(chain, lacked) {
  assert.equal(sandboxStatus().available, true, PRE);
  assert.equal(STOPPED, 'the rerun ended without four decisions');
  const { answer, thrown, tmp, pidFile } = await check(chain);
  assert.equal(thrown, null, `the check threw "${thrown && thrown.message}"`);
  const r = answer.result;

  // The record: not measured, the rerun ended without four decisions, no
  // control, count or comparison, and the rerun did not fail: it was not
  // asked.
  assert.equal(r.status, STOPPED_STATE);
  assert.equal(r.reason, STOPPED);
  assert.deepEqual(r.reasons, [STOPPED]);
  assert.deepEqual(r.controls, []);
  assert.equal(r.decision2, null);
  assert.equal(r.rerunError, null, 'the rerun was not asked, so it did not fail');
  assert.notEqual(r.openRun, null, 'the open run\'s side');
  assert.equal(typeof r.openRun.runId, 'string');
  assert.equal(typeof r.openRun.egress, 'object');
  assert.notEqual(r.openRun.egress, null);
  assert.equal(r.egressAttempts, null);
  assert.equal(r.allSame, false);
  // The open run's decisions stay on its side; the blocked side has none and
  // no row is compared. The cross case has its own row.
  assert.equal(r.extra.length, 1);
  assert.equal(r.extra[0].scenario, 'cross');
  for (const o of [...r.outcomes, ...r.extra]) {
    assert.deepEqual([o.blocked, o.same], [null, null], `scenario ${o.scenario}`);
    if (lacked.includes(o.scenario)) assert.equal(o.open, null, `scenario ${o.scenario}: the open run gave no decision`);
    else assert.equal(typeof o.open?.outcome, 'string', `scenario ${o.scenario}: the open run's decision`);
  }
  for (const s of strings(r)) {
    assert.equal(/sandbox-exec|\bexit\b|\bsignal\b|stderr/i.test(s), false, s);
    assert.equal(s.includes('/'), false, `a host path in the result: ${s}`);
  }
  // The keys the open run's answer lacked go to the run log, never to the
  // result: the open run's side holds its run id and counter summary, and no
  // sentence the check wrote names one of the keys. The platform, the fixed
  // labels and line, and the open run's own decisions are not the check's
  // sentences: a release number or a version can hold the digit 4.
  assert.deepEqual(Object.keys(r.openRun), ['runId', 'egress']);
  const notWritten = new Set(['platform', 'labels', 'fictionalLine', 'outcomes', 'extra']);
  const written = Object.entries(r).filter(([k]) => !notWritten.has(k)).map(([, v]) => v);
  for (const s of strings(written).filter((t) => /\s/.test(t))) {
    for (const key of lacked) assert.equal(new RegExp(`\\b${key}\\b`, 'i').test(s), false, `the result names "${key}": ${s}`);
  }

  // The text block and the screen: the reason, no digit after "attempts:"
  // and no comparison word; no row on the blocked side reads same or
  // different, and none has a tone or a pending mark.
  const text = offlineBlock(r);
  const lines = text.split('\n').map((l) => l.trim());
  assert.deepEqual(lines.filter((l) => /attempts:/i.test(l)), [`Outbound connection attempts: not measured (${STOPPED}).`], text);
  assert.equal(/attempts:[^\n]*\d/i.test(text), false, text);
  assert.equal(/matched|Same four decisions|\bsame\b|\bdifferent\b/i.test(text), false, text);
  const m = offlineState(COPY, r);
  assert.equal(m.state, 'not-measured');
  assert.equal(m.right.outcome, null);
  assert.deepEqual(m.right.result, [{ text: COPY.RULED_EXTRA.offlineNotMeasured, values: { reason: STOPPED } }]);
  assert.deepEqual(m.failed, []);
  for (const [k, v, tone, pending] of m.right.rows) {
    assert.equal([SCREEN.rowSame, SCREEN.rowDifferent].some((tag) => typeof v === 'string' && v.includes(tag)), false, `${k}: ${v}`);
    assert.equal(tone ?? null, null, k);
    assert.equal(pending ?? null, null, k);
  }

  // The run log: one JSON line, mode 0600, with the result's status and
  // reason, the open run's run id and the keys its answer lacked, and how
  // sandbox-exec ended once the check stopped it. No string in it holds a
  // host path.
  const logFile = path.join(answer.runDir, 'offline', 'not-run.json');
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
  const raw = fs.readFileSync(logFile, 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(raw.trimEnd().split('\n').length, 1, raw);
  const log = JSON.parse(raw);
  assert.deepEqual(Object.keys(log), ['status', 'runId', 'reason', 'openRun', 'spawnError', 'exitCode', 'signal', 'stderr']);
  assert.equal(log.status, r.status);
  assert.equal(log.runId, r.runId);
  assert.equal(log.reason, STOPPED);
  assert.deepEqual(Object.keys(log.openRun), ['error', 'code', 'message', 'runId', 'missing']);
  assert.deepEqual([log.openRun.error, log.openRun.code, log.openRun.message], [null, null, null], 'the open run did not throw');
  assert.equal(log.openRun.runId, r.openRun.runId);
  assert.deepEqual(log.openRun.missing, lacked);
  // The stand in root ends with exit 0 when the check stops it.
  assert.deepEqual([log.spawnError, log.exitCode, log.signal], [null, 0, null]);
  for (const s of strings(log)) assert.equal(s.includes('/'), false, `a host path in the run log: ${s}`);

  // Two run directories, the rerun's and the open run's; the open run's
  // holds the pids its processes recorded, the bank and the four agents at
  // least. Each of them and the root have ended.
  const dirs = runDirs(tmp);
  assert.equal(dirs.length, 2, 'two run directories, the rerun\'s and the open run\'s');
  assert.equal(dirs.includes(answer.runDir), true, 'the rerun\'s run directory');
  const openDirs = dirs.filter((d) => d !== answer.runDir);
  const pids = recordedPids(openDirs[0]);
  assert.ok(pids.length >= 5, `the open run recorded ${pids.length} processes`);
  for (const pid of [...pids, rootPid(pidFile)]) assert.equal(running(pid), false, `process ${pid} is still running`);
}

test('B9 (n): a network open run that returns without a decision for scenario 4: the check answers not measured, the rerun ended without four decisions, with the rerun not asked, the open run\'s decisions on its side, and the key it lacked in its run log and not in the result', async () => {
  // The shipped chain without scenario 4: the open run runs it to its end and
  // answers with no decision for scenario 4.
  await assertEndsShort(['setup', 'approve', '1', '2', 'cross', '3'], ['4']);
});

test('B9 (o): a network open run that returns four scenario decisions and none for the cross case: the check answers the same way, with the cross case in its run log and not in the result', async () => {
  // The four scenarios without the cross case: the open run answers with no
  // decision for the cross case.
  await assertEndsShort(['setup', 'approve', '1', '2', '3', '4'], ['cross']);
});
