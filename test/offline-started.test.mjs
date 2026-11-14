// The offline check when its rerun started under its own profile and did not
// return a complete answer: a root process that wrote its hello line and
// ended before it answered, one that answered ready with no counter loaded
// and then ended, one that answered the rerun with no decisions, one that
// answered with a decision for each of the four scenarios and for the cross
// case and an error, and one that answered with a decision for each of the
// four scenarios, none for the cross case and no error. A hello line or an
// answer shows the rerun started, so none of them reads not run. Each reads
// not measured with the reason the rerun ended without four decisions,
// records every other reason that holds beside it, and shows no count and no
// comparison, and a headless rerun of it exits non-zero. Each test starts a
// stand in for sandbox-exec through the check's sandboxExec option; none
// edits the harness.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_RUN } from '../src/egress/classify.mjs';
import { ownAddress } from '../src/egress/controls.mjs';
import { realExecPath, sandboxStatus } from '../src/orchestrator/sandbox.mjs';
import { offlineBlock } from '../src/runner/offline-text.mjs';
import { offlineState } from '../src/view/offline-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
const SCREEN = COPY.SCREENS.find((s) => s.id === 'offline');
const HEADLESS = path.join(ROOT, 'test', 'support', 'headless-offline.mjs');
const STAND_IN_ROOT = path.join(ROOT, 'test', 'fixtures', 'egress', 'stand-in-root.mjs');
const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); the offline check needs the OS sandbox and does not run without it';

// The reasons, byte for byte as the screen prints them.
const STOPPED = 'the rerun ended without four decisions';
const COUNT_RECORD = 'the count record was missing or unreadable';
const NO_ADDRESS = 'no IPv4 address was found besides loopback';

// A short directory under /tmp, so the Unix socket paths of the run
// directories made inside it stay within the system's limit.
function scratch() {
  return fs.realpathSync(fs.mkdtempSync('/tmp/bank-demo-test-'));
}

// A stand in for sandbox-exec, started as <it> -f <profile> <node> <rerun
// file>: "$3" is this Node.js, and it applies the profile "$2" names.
function standIn(dir, line) {
  const file = path.join(dir, 'sandbox-exec');
  fs.writeFileSync(file, ['#!/bin/sh', line, ''].join('\n'), { mode: 0o700 });
  return file;
}

// One headless rerun through the API, the run as usual included, with
// its own HOME and TMPDIR. It returns the exit code, the answer and the lines
// of the rerun's counter file (null when there is none).
function headless(dir, sandboxExec) {
  const home = path.join(dir, 'home');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(tmp, { mode: 0o700 });
  const r = spawnSync(realExecPath(), [HEADLESS, JSON.stringify({ sandboxExec })], {
    env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, LANG: 'C', TZ: 'UTC' },
    cwd: dir,
    encoding: 'utf8',
    timeout: 240000,
  });
  const last = r.stdout.trim().split('\n').pop();
  assert.ok(last, `no answer from the headless rerun: ${r.stderr}`);
  // The rerun's run directory is the one with its profile in it.
  const rerunDirs = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).filter((d) => fs.existsSync(path.join(d, 'egress.sb')));
  assert.equal(rerunDirs.length, 1, 'one rerun run directory');
  const log = path.join(rerunDirs[0], 'egress.jsonl');
  const counter = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : null;
  return { status: r.status, out: JSON.parse(last), counter };
}

// Started and stopped: not measured, with the reason the rerun
// ended without four decisions, never a not run reason; every reason that
// holds recorded, and how the rerun ended; no decision of the rerun, no
// count, no number after "attempts:" on any line, and no sentence, outcome
// or row label on the decisions.
function assertStopped(h, reasons) {
  assert.equal(h.status, 1, 'a headless rerun that did not finish exits non-zero');
  assert.equal(h.out.httpStatus, 200);
  const r = h.out.result;
  assert.equal(r.status, 'not measured', PRE);
  assert.equal(r.reason, STOPPED);
  assert.deepEqual(r.reasons, reasons);
  for (const reason of r.reasons) assert.equal(Object.values(NOT_RUN).includes(reason), false, reason);
  assert.equal(typeof r.rerunError, 'string');
  assert.ok(r.rerunError.length > 0, 'how the rerun ended is recorded');
  assert.equal(r.egressAttempts, null);
  assert.equal(r.allSame, false);
  for (const o of r.outcomes) assert.deepEqual([o.blocked, o.same], [null, null], `scenario ${o.scenario}`);
  const text = offlineBlock(r);
  const lines = text.split('\n').map((l) => l.trim());
  assert.deepEqual(lines.filter((l) => /attempts:/i.test(l)), [`Outbound connection attempts: not measured (${STOPPED}).`], text);
  assert.equal(/matched|Same four decisions|\bsame\b|\bdifferent\b/i.test(text), false, text);
  return r;
}

// Started and answered with its decisions but no complete answer: an error
// beside them, or no decision for the cross case. Not measured with the
// reason the rerun ended without four decisions; every reason that holds
// recorded; the decisions the rerun returned kept and none compared: every
// same null, allSame false and no count. In the text runner the not measured
// line is the one line with "attempts:", with no sentence, outcome or row
// label on the decisions. On the page the open run's rows are kept on the
// left, and the right column has no outcome, no opening sentence and no row
// tag from the same or differs words.
function assertIncomplete(h, reasons) {
  assert.equal(h.status, 1, 'a headless rerun without a complete answer exits non-zero');
  assert.equal(h.out.httpStatus, 200);
  const r = h.out.result;
  assert.equal(r.status, 'not measured', PRE);
  assert.equal(r.reason, STOPPED);
  assert.deepEqual(r.reasons, reasons);
  for (const o of r.outcomes) assert.notEqual(o.blocked, null, `scenario ${o.scenario}: the rerun's decision is kept`);
  for (const o of r.outcomes) assert.equal(o.same, null, `scenario ${o.scenario}`);
  assert.equal(r.extra[0].scenario, 'cross');
  assert.equal(r.extra[0].same, null, 'the cross case');
  assert.equal(r.allSame, false);
  assert.equal(r.egressAttempts, null);
  const text = offlineBlock(r);
  const lines = text.split('\n').map((l) => l.trim());
  assert.deepEqual(lines.filter((l) => /attempts:/i.test(l)), [`Outbound connection attempts: not measured (${STOPPED}).`], text);
  assert.equal(/matched|Same four decisions|\bsame\b|\bdifferent\b/i.test(text), false, text);
  const m = offlineState(COPY, r);
  assert.equal(m.state, 'not-measured');
  assert.deepEqual(m.left.rows.map(([k, v]) => [k, v]), SCREEN.cols[0].rows.map(([k, v]) => [k, v]), 'the open run\'s rows on the left');
  assert.equal(m.right.outcome, null);
  assert.deepEqual(m.right.result, [{ text: COPY.RULED_EXTRA.offlineNotMeasured, values: { reason: STOPPED } }], 'no opening sentence');
  for (const [k, v, tone, pending] of m.right.rows) {
    assert.equal([SCREEN.rowSame, SCREEN.rowDifferent].some((tag) => typeof v === 'string' && v.includes(tag)), false, `${k}: ${v}`);
    assert.equal(tone ?? null, null, k);
    assert.equal(pending ?? null, null, k);
  }
  return r;
}

test('a root process that wrote its hello line and ended with exit 3 before it answered ready: not measured, the rerun ended without four decisions, no count and no comparison, and a headless rerun exits non-zero', () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = scratch();
  const h = headless(dir, standIn(dir, 'exec /usr/bin/sandbox-exec -f "$2" "$3" -e "process.exit(3)"'));
  // The witness is the hello line: the counter was loaded and wrote it.
  assert.ok(h.counter && h.counter.some((l) => l.kind === 'hello' && l.main), 'the root process wrote its hello line');
  const r = assertStopped(h, [STOPPED]);
  // It never answered ready, so the run as usual did not start.
  assert.equal(r.openRun, null);
  assert.deepEqual(r.controls, []);
});

test('a root process that answered ready with no counter loaded and then ended at the rerun request: the profile was applied, so never not run and never the sandbox could not be applied; the rerun ended without four decisions shows, with the missing count record recorded beside it', () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = scratch();
  const h = headless(dir, standIn(dir, `exec /usr/bin/env -u NODE_OPTIONS /usr/bin/sandbox-exec -f "$2" "$3" '${STAND_IN_ROOT}' ends`));
  // The witness is the answer: no process wrote through the counter.
  assert.equal(h.counter, null, 'a counter file');
  const r = assertStopped(h, [COUNT_RECORD, STOPPED]);
  assert.notEqual(r.reason, NOT_RUN.notApplied);
  // The run as usual started after the answer and returned all four.
  assert.ok(r.outcomes.every((o) => o.open !== null), 'the open run returned a decision for each scenario');
});

test('a root process that answered ready and then answered the rerun with no decisions, both control lines counted: not measured, the rerun ended without four decisions, no count and no comparison against the open run\'s four decisions, and a headless rerun exits non-zero', () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = scratch();
  const h = headless(dir, standIn(dir, `exec /usr/bin/sandbox-exec -f "$2" "$3" '${STAND_IN_ROOT}' no-decisions`));
  const r = assertStopped(h, ownAddress() ? [STOPPED] : [NO_ADDRESS, STOPPED]);
  assert.equal(r.rerunError, 'the scenarios did not complete');
  // Each control passed: the 192.0.2.1 control from a counted process,
  // refused and counted once, and each control row refused inside.
  assert.equal(r.decision2.pass, true);
  assert.equal(r.decision2.lines, 1);
  assert.equal(r.decision2.hello, true);
  for (const c of r.controls.filter((x) => x.id !== 'network' || ownAddress())) assert.equal(c.pass, true, c.control);
  assert.ok(r.outcomes.every((o) => o.open !== null), 'the open run returned a decision for each scenario');
});

test('B9 (l): a root process that answered ready and then answered the rerun with a decision for each of the four scenarios and for the cross case, and an error, both control lines counted: not measured, the rerun ended without four decisions, the decisions kept and none compared, no count, and a headless rerun exits non-zero', () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = scratch();
  const h = headless(dir, standIn(dir, `exec /usr/bin/sandbox-exec -f "$2" "$3" '${STAND_IN_ROOT}' error-with-decisions`));
  const r = assertIncomplete(h, ownAddress() ? [STOPPED] : [NO_ADDRESS, STOPPED]);
  assert.equal(r.rerunError, 'the scenarios did not complete');
  assert.notEqual(r.extra[0].blocked, null, 'the cross case keeps the rerun\'s decision');
});

test('B9 (m): a root process that answered ready and then answered the rerun with a decision for each of the four scenarios, none for the cross case and no error, both control lines counted: not measured, the rerun ended without four decisions, the decisions kept and none compared, no count, and a headless rerun exits non-zero', () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = scratch();
  const h = headless(dir, standIn(dir, `exec /usr/bin/sandbox-exec -f "$2" "$3" '${STAND_IN_ROOT}' no-cross`));
  const r = assertIncomplete(h, ownAddress() ? [STOPPED] : [NO_ADDRESS, STOPPED]);
  assert.equal(r.rerunError, null);
  assert.equal(r.extra[0].blocked, null, 'the cross case has no decision');
});
