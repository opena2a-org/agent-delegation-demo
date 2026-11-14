// The offline screen in each of its five states, rendered in the installed
// Chrome at 1440x900 from an offline check record in that state: one real
// measured record from this machine, and records made from it that break
// one rule each (a decision that differs, a count that is missing, a guard
// that fired, a rerun that returned three decisions, a rerun that never
// started). The words of each state are the copy file's, compared byte for
// byte with the words set for them. Then the screen with the view server
// itself inside another sandbox profile, where the rerun cannot start.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { freeLoopbackPort } from '../src/orchestrator/ports.mjs';
import { SANDBOX_EXEC, realExecPath, sandboxStatus, writeProfile } from '../src/orchestrator/sandbox.mjs';
import { ViewServer } from '../src/server/main.mjs';
import { ICON } from '../src/view/icons.mjs';
import { launchChrome, newContext, waitLoaded, waitTerminal } from './support/page-remote.mjs';
import { stopThenClose } from './support/teardown.mjs';
import { outerProfileText } from './support/profiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
const SCREEN = COPY.SCREENS.find((s) => s.id === 'offline');
const X = COPY.RULED_EXTRA;
const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); the offline check needs the OS sandbox and does not run without it';
const OUTER = 'the demo is already inside another sandbox';
const STOPPED = 'the rerun ended without four decisions';
// The words set for the idle and differs states, byte for byte.
const IDLE_RESULT = 'Run the offline check to rerun the four scenarios with the network blocked.';
const DIFFERS_OUTCOME = 'Not the same decisions';
const DIFFERS_OPENING = 'Not every decision matched. ';
const SAME = ', same';
const DIFFERENT = ', different';
// The amber triangle, by its outline.
const TRIANGLE = /<path d="([^"]+)"/.exec(ICON.warn)[1];
// The cell that starts the view server itself inside another sandbox
// profile: the bound on its ready line, and the wait for its exit after each
// signal.
const READY_MS = 30000;
const KILL_MS = 5000;

let view;
let base;
let browser;
let ctx;
let real;
const clone = (o) => JSON.parse(JSON.stringify(o));

before(async () => {
  const port = await freeLoopbackPort();
  view = new ViewServer({ port });
  await view.listen();
  base = `http://127.0.0.1:${port}`;
  browser = await launchChrome();
  ctx = await newContext(browser);
});

// The view server stops, then the browser closes within its bound
// (support/teardown.mjs).
after(async (t) => {
  await stopThenClose(t, { view, browser });
});

// The screen as rendered: the slots the state model names, where they sit,
// and what was clipped or pushed past the right edge.
function screenSix() {
  const main = document.querySelector('main');
  const r = (e) => e.getBoundingClientRect();
  const right = document.querySelectorAll('.col')[1];
  const left = document.querySelectorAll('.col')[0];
  const result = right.querySelector('.result');
  const leaves = [...document.querySelectorAll('main *')].filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
  const clipped = leaves.filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible').map((e) => e.textContent.trim().slice(0, 40));
  const pastEdge = leaves.filter((e) => r(e).right > window.innerWidth - 39).map((e) => e.textContent.trim().slice(0, 40));
  const tops = (col) => [...col.children].map((c) => Math.round(r(c).top));
  const outcome = right.querySelector('.outcome');
  const words = document.createRange();
  words.selectNodeContents(outcome);
  const values = [...right.querySelectorAll('.rows dd')];
  return {
    state: main.dataset.state,
    offlineState: main.dataset.offlineState,
    failed: main.dataset.failed || '',
    eyebrow: main.querySelector('.label').textContent,
    eyebrowHeight: r(main.querySelector('.label')).height,
    h1: main.querySelector('h1').textContent,
    sub: main.querySelector('.sub').textContent,
    subHeight: r(main.querySelector('.sub')).height,
    cardTop: Math.round(r(main.querySelector('.task')).top),
    buttonTop: Math.round(r(main.querySelector('.task [data-action]')).top),
    tone: right.querySelector('.tile').className.replace('tile ', ''),
    outcome: right.querySelector('.outcome').textContent,
    outcomePending: right.querySelector('.outcome').dataset.pending || null,
    result: result.textContent,
    resultPending: result.dataset.pending || null,
    why: right.querySelector('.why').textContent,
    rows: [...right.querySelectorAll('.rows dd')].map((d) => d.textContent),
    rowsPending: [...right.querySelectorAll('.rows dd')].map((d) => d.dataset.pending || null),
    leftRows: [...left.querySelectorAll('.rows dd')].map((d) => d.textContent),
    // The outcome's words against the room the column leaves them, the
    // result line's count of lines, and the icon outline beside each row.
    outcomeWidth: Math.round(words.getBoundingClientRect().width),
    outcomeRoom: Math.round(r(right).right - r(outcome).left),
    resultLines: Math.round(r(result).height / parseFloat(getComputedStyle(result).lineHeight)),
    rowIcons: values.map((d) => d.querySelector('svg path')?.getAttribute('d') ?? null),
    rowTones: values.map((d) => d.className),
    strong: [...result.querySelectorAll('b')].map((b) => b.textContent),
    rowTopsEqual: JSON.stringify(tops(left)) === JSON.stringify(tops(right)),
    scrollHeight: document.documentElement.scrollHeight,
    mainText: main.innerText,
    clipped,
    pastEdge,
  };
}

// The screen rendered from a record: the page reads the last check from
// GET /api/offline, answered here with the record given.
async function render(record) {
  const page = await ctx.newPage();
  await page.fulfillGet('**/api/offline', { status: record ? 200 : 409, contentType: 'application/json', body: JSON.stringify(record ?? { error: 'no offline check yet' }) });
  await page.goto(`${base}/offline`);
  await waitLoaded(page);
  await page.evaluate(() => document.fonts.ready);
  const s = await page.evaluate(screenSix);
  await page.close();
  return s;
}

const layout = [];
function commonChecks(s, name) {
  assert.equal(s.scrollHeight, 900, `${name}: one screen at 1440x900`);
  assert.deepEqual(s.clipped, [], name);
  assert.deepEqual(s.pastEdge, [], name);
  assert.ok(s.rowTopsEqual, `${name}: row tops equal`);
  assert.ok(s.eyebrowHeight >= 24, `${name}: the eyebrow slot keeps its height`);
  assert.ok(s.subHeight >= 30, `${name}: the subhead slot keeps its height`);
  assert.equal(/\{[A-Za-z0-9]+\}/.test(s.mainText), false, `${name}: a fill marker`);
  // A row tag follows decision words; a row the design leaves empty carries neither tag.
  for (const v of s.rows) assert.equal(v === SAME || v === DIFFERENT || v.startsWith(', '), false, `${name}: a row tag alone: ${JSON.stringify(v)}`);
  layout.push({ name, cardTop: s.cardTop, buttonTop: s.buttonTop });
}

// Each row of the right column: an equal decision ends with the same tag and
// no icon; an unequal decision the row names ends with the different tag
// beside the amber triangle; a decision whose words are not set stays empty.
function assertRows(s, name, { different = [], unnamed = [] }) {
  SCREEN.cols[1].rows.forEach(([, v], i) => {
    if (different.includes(i)) {
      assert.equal(s.rows[i], `${v.slice(0, -SAME.length)}${DIFFERENT}`, `${name}: row ${i + 1}`);
      assert.equal(s.rowTones[i], 'warn', `${name}: row ${i + 1}`);
      assert.equal(s.rowIcons[i], TRIANGLE, `${name}: row ${i + 1}`);
    } else if (unnamed.includes(i)) {
      assert.equal(s.rows[i], '', `${name}: row ${i + 1}`);
      assert.equal(s.rowsPending[i], 'offlineDiffersRow', `${name}: row ${i + 1}`);
      assert.equal(s.rowIcons[i], null, `${name}: row ${i + 1}`);
    } else {
      assert.ok(v.endsWith(SAME), v);
      assert.equal(s.rows[i], v, `${name}: row ${i + 1}`);
      assert.equal(s.rowIcons[i], null, `${name}: row ${i + 1}`);
    }
  });
}

test('a real offline check on this machine, run through the API: measured, four decisions the same, the count read from its counter', async () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const res = await fetch(`${base}/api/offline`, { method: 'POST' });
  real = await res.json();
  assert.equal(real.status, 'measured', PRE);
  assert.ok(real.outcomes.every((o) => o.same === true));
  assert.ok(Number.isInteger(real.egressAttempts));
});

test('idle: before any check finished, the headline slot holds the screen name, the eyebrow and subhead are empty, Not run yet, and the result line says what the check reruns, on two lines or fewer', async () => {
  const s = await render(null);
  commonChecks(s, 'idle');
  assert.equal(s.offlineState, 'idle');
  assert.equal(s.state, 'idle');
  assert.equal(s.h1, SCREEN.label);
  assert.equal(s.eyebrow, '');
  assert.equal(s.sub, '');
  assert.equal(s.tone, 'tone-neutral');
  assert.equal(s.outcome, COPY.GLOBAL.notRunOutcome);
  assert.equal(s.outcome, SCREEN.states.idle.outcome);
  assert.equal(s.result, IDLE_RESULT);
  assert.equal(s.result, SCREEN.states.idle.result);
  assert.equal(s.resultPending, null);
  assert.ok(s.resultLines >= 1 && s.resultLines <= 2, `idle result on ${s.resultLines} lines`);
  assert.equal(s.why, '');
  assert.ok(s.rows.every((v) => v === ''));
});

test('measured, subhead A: the eyebrow over the headline, the full subhead when the scenario runs counted 0, Same four decisions, the count in bold from the record', async () => {
  const rec = clone(real);
  rec.openRun.egress = { ...rec.openRun.egress, status: 'measured', egressAttempts: 0 };
  const s = await render(rec);
  commonChecks(s, 'measured');
  assert.equal(s.offlineState, 'measured');
  assert.equal(s.state, 'done', s.failed);
  assert.equal(s.eyebrow, SCREEN.label);
  assert.equal(s.h1, SCREEN.h1);
  assert.equal(s.sub, SCREEN.sub);
  assert.equal(s.tone, 'tone-ok');
  assert.equal(s.outcome, SCREEN.cols[1].outcome);
  assert.equal(s.result, SCREEN.cols[1].result.replace('{egressAttempts}', String(rec.egressAttempts)));
  assert.deepEqual(s.strong, [String(rec.egressAttempts)]);
  assert.equal(s.why, SCREEN.cols[1].why);
  assert.deepEqual(s.rows, SCREEN.cols[1].rows.map(([, v]) => v));
  assert.deepEqual(s.leftRows, SCREEN.cols[0].rows.map(([, v]) => v));
});

test('measured, subhead B: when the scenario runs did not count 0, the second sentence stands alone', async () => {
  const rec = clone(real);
  rec.openRun.egress = { ...rec.openRun.egress, status: 'measured', egressAttempts: 1 };
  const s = await render(rec);
  assert.equal(s.offlineState, 'measured');
  assert.equal(s.sub, SCREEN.subB);
});

test('measured with a count above 0: shown as counted, in the same tone', async () => {
  const rec = clone(real);
  rec.egressAttempts = 2;
  const s = await render(rec);
  assert.equal(s.offlineState, 'measured');
  assert.equal(s.tone, 'tone-ok');
  assert.deepEqual(s.strong, ['2']);
  assert.ok(s.result.endsWith('Outbound connection attempts: 2.'));
});

// The real record with the fake invoice paid with the network blocked: a
// decision no row of the screen names.
function fakeInvoicePaid() {
  const rec = clone(real);
  rec.outcomes[1].blocked = { ...rec.outcomes[1].blocked, outcome: 'paid', consentField: null };
  rec.outcomes[1].same = false;
  rec.allSame = false;
  return rec;
}

test('differs: one decision changed with the network blocked: the screen name, the amber triangle, Not the same decisions on one line, the opening sentence and the count, each equal row same, and the changed row left empty while the words for its decision are not set', async () => {
  const rec = fakeInvoicePaid();
  const s = await render(rec);
  commonChecks(s, 'differs');
  assert.equal(s.offlineState, 'differs');
  assert.equal(s.state, 'done', s.failed);
  assert.equal(s.h1, SCREEN.label);
  assert.equal(s.eyebrow, '');
  assert.equal(s.sub, '');
  assert.equal(s.tone, 'tone-warn');
  assert.equal(s.outcome, DIFFERS_OUTCOME);
  assert.equal(s.outcome, SCREEN.states.differs.outcome);
  assert.equal(s.outcomePending, null);
  assert.ok(s.outcomeWidth > 0 && s.outcomeWidth <= s.outcomeRoom, `${s.outcomeWidth} of ${s.outcomeRoom} px`);
  assert.ok(s.result.startsWith(DIFFERS_OPENING), s.result);
  assert.equal(s.result, SCREEN.states.differs.result.replace('{egressAttempts}', String(rec.egressAttempts)));
  assert.equal(s.resultPending, null);
  assert.deepEqual(s.strong, [String(rec.egressAttempts)]);
  assert.equal(s.why, '');
  assertRows(s, 'differs', { unnamed: [1] });
});

test('differs: a decision its row names, changed with the network blocked: the bill paid with another amount reads Bill paid, different beside the amber triangle', async () => {
  const rec = clone(real);
  const b = rec.outcomes[0].blocked;
  rec.outcomes[0].blocked = { ...b, payment: { ...b.payment, amountCents: b.payment.amountCents - 180 } };
  rec.outcomes[0].same = false;
  rec.allSame = false;
  const s = await render(rec);
  commonChecks(s, 'differs, a decision its row names');
  assert.equal(s.offlineState, 'differs');
  assert.equal(s.state, 'done', s.failed);
  assert.equal(s.tone, 'tone-warn');
  assert.equal(s.outcome, DIFFERS_OUTCOME);
  assert.ok(s.result.startsWith(DIFFERS_OPENING), s.result);
  assert.equal(s.rows[0], `${SCREEN.cols[0].rows[0][1]}${DIFFERENT}`);
  assertRows(s, 'differs, a decision its row names', { different: [0] });
});

test('not-measured, a guard fired: the screen name, the gray minus, the decisions per comparison, and the count not measured with its reason, no digit after attempts', async () => {
  const reason = X.offlineNotMeasuredReasons[6];
  const rec = clone(real);
  Object.assign(rec, { status: 'not measured', reason, reasons: [reason], egressAttempts: null });
  const s = await render(rec);
  commonChecks(s, 'not-measured');
  assert.equal(s.offlineState, 'not-measured');
  assert.equal(s.state, 'done', s.failed);
  assert.equal(s.h1, SCREEN.label);
  assert.equal(s.eyebrow, '');
  assert.equal(s.sub, '');
  assert.equal(s.tone, 'tone-neutral');
  assert.equal(s.outcome, SCREEN.cols[1].outcome);
  assert.equal(s.result, `Each decision matched. ${X.offlineNotMeasured.replace('{reason}', reason)}`);
  assert.equal(/attempts:[^.]*\d/.test(s.result), false, s.result);
  assert.equal(s.why, '');
});

test('not-measured, the count missing from a record that says measured: no default, the reason is the count record, and no digit after attempts', async () => {
  const rec = clone(real);
  delete rec.egressAttempts;
  const s = await render(rec);
  assert.equal(s.offlineState, 'not-measured');
  assert.ok(s.result.endsWith(X.offlineNotMeasured.replace('{reason}', X.offlineNotMeasuredReasons[0])), s.result);
  assert.equal(/attempts:[^.]*\d/.test(s.result), false, s.result);
  assert.equal(s.strong.length, 0);
});

test('not-measured, a guard fired and one decision changed: the gray minus, Not the same decisions, and the result line opens with the sentence of the differs state', async () => {
  const reason = X.offlineNotMeasuredReasons[6];
  const rec = Object.assign(fakeInvoicePaid(), { status: 'not measured', reason, reasons: [reason], egressAttempts: null });
  const s = await render(rec);
  commonChecks(s, 'not-measured, one decision changed');
  assert.equal(s.offlineState, 'not-measured');
  assert.equal(s.state, 'done', s.failed);
  assert.equal(s.tone, 'tone-neutral');
  assert.equal(s.outcome, DIFFERS_OUTCOME);
  assert.ok(s.result.startsWith(DIFFERS_OPENING), s.result);
  assert.equal(s.result, `${DIFFERS_OPENING}${X.offlineNotMeasured.replace('{reason}', reason)}`);
  assert.equal(/attempts:[^.]*\d/.test(s.result), false, s.result);
  assertRows(s, 'not-measured, one decision changed', { unnamed: [1] });
});

test('a rerun that returned three decisions, one of them changed: no sentence on the decisions, no outcome that states them, and no row labelled same or different', async () => {
  const rec = Object.assign(fakeInvoicePaid(), { status: 'not measured', reason: STOPPED, reasons: [STOPPED], egressAttempts: null });
  rec.outcomes[3].blocked = null;
  rec.outcomes[3].same = null;
  const s = await render(rec);
  commonChecks(s, 'three decisions');
  assert.notEqual(s.offlineState, 'differs');
  assert.equal(s.state, 'done', s.failed);
  assert.equal(s.tone, 'tone-neutral');
  assert.equal(s.outcome, '');
  assert.equal(s.result, X.offlineNotMeasured.replace('{reason}', STOPPED));
  for (const words of [DIFFERS_OUTCOME, DIFFERS_OPENING.trim(), SCREEN.cols[1].result.split('. ')[0]]) assert.equal(s.mainText.includes(words), false, words);
  assert.ok(s.rows.every((v) => v === ''), JSON.stringify(s.rows));
  assert.ok(s.rowsPending.every((k) => k === null), JSON.stringify(s.rowsPending));
});

test('not-run: Not run and the reason, what the check needs in the why slot, no digit in the result line, no decision labelled same, the value cells empty', async () => {
  const rec = {
    check: 'offline', platform: real.platform, status: 'not run', reason: OUTER, reasons: [OUTER], runId: real.runId, controls: [],
    outcomes: ['1', '2', '3', '4'].map((scenario) => ({ scenario, open: null, blocked: null, same: null })), allSame: false, egressAttempts: null,
    labels: real.labels, fictionalLine: real.fictionalLine,
  };
  const s = await render(rec);
  commonChecks(s, 'not-run');
  assert.equal(s.offlineState, 'not-run');
  assert.equal(s.state, 'done', s.failed);
  assert.equal(s.h1, SCREEN.label);
  assert.equal(s.eyebrow, '');
  assert.equal(s.sub, '');
  assert.equal(s.tone, 'tone-neutral');
  assert.equal(s.outcome, X.offlineNotRun);
  assert.equal(s.result, X.offlineNotRunResult.replace('{reason}', OUTER));
  assert.equal(/\d/.test(s.result), false, s.result);
  assert.equal(s.why, X.offlineNotRunNeeds[OUTER]);
  assert.equal(/\bsame\b/.test(s.mainText), false);
  assert.equal(/\bdifferent\b/.test(s.mainText), false);
  assert.ok(s.rows.every((v) => v === '') && s.leftRows.every((v) => v === ''));
});

test('the card and the run button sit at the same place in every state', () => {
  assert.equal(layout.length, 8);
  for (const l of layout) assert.deepEqual([l.cardTop, l.buttonTop], [layout[0].cardTop, layout[0].buttonTop], l.name);
});

test('the view server inside another sandbox profile: a click on Run offline check reads not-run with that reason, no digit, and the server keeps serving', async (t) => {
  // Each step writes the milliseconds since the cell began, so a cell that
  // stops partway names the step it reached.
  const began = performance.now();
  const step = (name) => t.diagnostic(`${name} ${Math.round(performance.now() - began)}`);
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/bank-demo-view-'));
  const denied = path.join(dir, 'true');
  fs.copyFileSync('/usr/bin/true', denied);
  fs.chmodSync(denied, 0o700);
  const profile = path.join(dir, 'outer.sb');
  writeProfile(profile, outerProfileText([`(deny process-exec (literal "${denied}"))`]));
  const home = path.join(dir, 'home');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(tmp, { mode: 0o700 });
  const child = spawn(SANDBOX_EXEC, ['-f', profile, realExecPath(), path.join(ROOT, 'test/support/view-serve.mjs')], {
    cwd: dir, env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, LANG: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  step('spawn');
  try {
    const readyLine = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the view server printed no ready line in time')), READY_MS);
      const rl = readline.createInterface({ input: child.stdout });
      rl.once('line', (line) => { clearTimeout(timer); resolve(line); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the view server ended (${code})`)); });
    });
    step('ready line');
    const { port } = JSON.parse(readyLine);
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/offline`);
    await waitLoaded(page);
    step('page open');
    await page.locator('main [data-action="run"]').click();
    step('click');
    await waitTerminal(page);
    step('terminal state');
    const s = await page.evaluate(screenSix);
    assert.equal(s.offlineState, 'not-run');
    assert.equal(s.state, 'done', s.failed);
    assert.equal(s.result, X.offlineNotRunResult.replace('{reason}', OUTER));
    assert.equal(/\d/.test(s.result), false, s.result);
    assert.equal(s.why, X.offlineNotRunNeeds[OUTER]);
    const index = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(index.status, 200);
    step('index fetch');
    await page.close();
  } finally {
    // SIGTERM, then SIGKILL when the server has not exited KILL_MS later;
    // after each signal its exit is awaited for that long.
    const ended = (ms) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(true); return; }
      const timer = setTimeout(() => resolve(false), ms);
      child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
    child.kill('SIGTERM');
    let exited = await ended(KILL_MS);
    if (!exited) {
      child.kill('SIGKILL');
      exited = await ended(KILL_MS);
    }
    step('exit');
    assert.ok(exited, 'the view server was sent SIGTERM and then SIGKILL, and no exit was observed');
  }
});
