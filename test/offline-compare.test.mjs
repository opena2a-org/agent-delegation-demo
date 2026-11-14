// The comparison of the offline check's two runs. A scenario is the same or
// different when both runs carry its decision, and a missing decision is
// never different. The sentence on the decisions, the outcome that states
// it, the row labels and the count show when both runs returned a decision
// for each of the four scenarios, in the text runner and on the offline
// screen, and in no other record. The inputs: one real measured record from
// this machine; records made from it that leave decisions out, on either
// side and in each way a decision can be missing; and a rerun whose root
// process answers three decisions and an error record in place of the fourth.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOfflineCheck } from '../src/egress/offline.mjs';
import { freeLoopbackPort } from '../src/orchestrator/ports.mjs';
import { sandboxStatus } from '../src/orchestrator/sandbox.mjs';
import { offlineBlock } from '../src/runner/offline-text.mjs';
import { ViewServer } from '../src/server/main.mjs';
import { offlineState } from '../src/view/offline-state.mjs';
import { launchChrome, newContext, waitLoaded } from './support/page-remote.mjs';
import { stopThenClose } from './support/teardown.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
const STAND_IN_ROOT = path.join(ROOT, 'test', 'fixtures', 'egress', 'stand-in-root.mjs');
const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); the offline check needs the OS sandbox and does not run without it';
const STOPPED = 'the rerun ended without four decisions';
// The slots that hold the words for a decision that differs.
const DIFFERS = ['offlineDiffersOutcome', 'offlineDiffersResult', 'offlineDiffersRow'];
// The words set for a decision that differs, where the offline screen
// carries them: the outcome, the opening sentence and the row tag.
const DIFFERS_SET = (({ states, rowDifferent }) => [states.differs.outcome, states.differs.result.split('. ')[0], rowDifferent])(COPY.SCREENS.find((s) => s.id === 'offline'));
// The words that state a comparison: the sentence on the decisions, the
// outcome that states it, and a row label.
const COMPARED = /matched|Same four decisions|\bsame\b|\bdifferent\b/i;
// A count: a number right after "attempts:".
const COUNT = /attempts:\s*\d/i;
const clone = (o) => JSON.parse(JSON.stringify(o));

let real;
let view;
let base;
let browser;
let ctx;

before(async () => {
  real = await runOfflineCheck();
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

// Every word the screen's model puts on the screen, its fills in place; the
// slots that wait for words not set yet; and the tones of the right column.
function modelWords(m) {
  const filled = (x) => (x && typeof x.text === 'string' ? x.text.replace(/\{([A-Za-z]+)\}/g, (_, k) => String(x.values?.[k] ?? '')) : '');
  const text = [m.eyebrow, m.h1, m.sub, ...[m.left, m.right].flatMap((c) => [c.title, c.outcome, c.why, ...(c.result ?? []).map(filled), ...c.rows.flatMap(([k, v]) => [k, v])])]
    .filter((t) => typeof t === 'string').join('\n');
  const pending = [m.right.outcomePending, ...(m.right.result ?? []).map((x) => x && x.pending), ...m.right.rows.map((r) => r[3])].filter(Boolean);
  return { text, pending, tones: [m.right.tone, ...m.right.rows.map((r) => r[2])].filter(Boolean) };
}

// The offline screen as the page renders a record: the page reads the last
// check from GET /api/offline, answered here with the record given.
async function render(record) {
  const page = await ctx.newPage();
  await page.fulfillGet('**/api/offline', { status: 200, contentType: 'application/json', body: JSON.stringify(record) });
  await page.goto(`${base}/offline`);
  await waitLoaded(page);
  const s = await page.evaluate(() => {
    const main = document.querySelector('main');
    return {
      offlineState: main.dataset.offlineState,
      text: main.innerText,
      pending: [...main.querySelectorAll('[data-pending]')].map((e) => e.dataset.pending),
      tones: [...main.querySelectorAll('.cols .tile, .cols dd')].map((e) => e.className),
    };
  });
  await page.close();
  return s;
}

function assertNoComparisonText(text, name) {
  assert.equal(COMPARED.test(text), false, `${name}: ${text}`);
  assert.equal(COUNT.test(text), false, `${name}: ${text}`);
}

// The screen in neither the measured nor the differs state, with no words
// set for a decision that differs.
function assertNoComparisonScreen({ state, text, pending, tones }, name) {
  assertNoComparisonText(text, name);
  assert.equal(['measured', 'differs'].includes(state), false, `${name}: ${state}`);
  assert.deepEqual(pending.filter((k) => DIFFERS.includes(k)), [], name);
  assert.deepEqual(tones.filter((t) => /\b(tone-)?(ok|warn)\b/.test(t)), [], name);
  for (const k of DIFFERS) if (typeof COPY.PENDING_WORDS[k] === 'string') assert.equal(text.includes(COPY.PENDING_WORDS[k]), false, name);
  for (const words of DIFFERS_SET) assert.equal(text.includes(words), false, `${name}: ${words}`);
}

function assertNoComparison(record, name, page = null) {
  assertNoComparisonText(offlineBlock(record), `${name}, text runner`);
  const m = offlineState(COPY, record);
  assertNoComparisonScreen({ state: m.state, ...modelWords(m) }, `${name}, screen model`);
  if (page) assertNoComparisonScreen({ state: page.offlineState, text: page.text, pending: page.pending, tones: page.tones }, `${name}, screen`);
}

// The real record with decisions left out: on one side, for the scenarios
// at the indexes given, in one way; each such scenario still labelled as a
// record compared them before (same true or same false), and the record said
// measured with its count or not measured with the rerun ended without four
// decisions.
function without(side, indexes, kind, same, status) {
  const rec = clone(real);
  for (const i of indexes) {
    const o = rec.outcomes[i];
    if (kind === 'null') o[side] = null;
    else if (kind === 'missing key') delete o[side];
    else o[side] = { error: 'the scenario did not complete' };
    o.same = same;
  }
  rec.allSame = rec.outcomes.every((o) => o.same === true);
  if (status === 'not measured') Object.assign(rec, { status, reason: STOPPED, reasons: [STOPPED], egressAttempts: null });
  return rec;
}

test('the real record, where both runs returned all four decisions: the sentence, the outcome and the row labels show, in the text runner and on the screen', async () => {
  assert.equal(real.status, 'measured', PRE);
  assert.ok(real.outcomes.every((o) => o.same === true), PRE);
  const text = offlineBlock(real);
  assert.match(text, /Each decision matched\. Outbound connection attempts: \d+\./);
  // The two columns wrap, so a row label can sit on a line of its own.
  assert.equal(text.match(/\bsame\./g).length, 4);
  const m = offlineState(COPY, real);
  assert.equal(m.state, 'measured');
  assert.match(modelWords(m).text, /Same four decisions/);
  const page = await render(real);
  assert.equal(page.offlineState, 'measured');
  assert.match(page.text, /Same four decisions/);
  assert.match(page.text, /Each decision matched\./);
});

test('a rerun root that answers decisions for three scenarios and an error record in place of the fourth: the three are kept and none is compared, the fourth is no decision, no scenario and not the cross case is same or different, and the count reads not measured, the rerun ended without four decisions', async () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/bank-demo-test-'));
  const sandboxExec = path.join(dir, 'sandbox-exec');
  fs.writeFileSync(sandboxExec, ['#!/bin/sh', `exec /usr/bin/sandbox-exec -f "$2" "$3" '${STAND_IN_ROOT}' three-decisions`, ''].join('\n'), { mode: 0o700 });
  const r = await runOfflineCheck({ sandboxExec });
  assert.ok(r.outcomes.every((o) => o.open !== null), 'the open run returned a decision for each scenario');
  assert.deepEqual(r.outcomes.map((o) => (o.same === null ? null : typeof o.same)), [null, null, null, null]);
  assert.equal(r.extra[0].same, null);
  assert.equal(r.outcomes[3].blocked, null, 'an error record in place of a decision is no decision');
  assert.equal(r.allSame, false);
  assert.equal(r.status, 'not measured');
  assert.equal(r.reason, STOPPED);
  assert.equal(r.egressAttempts, null);
  assertNoComparison(r, 'three decisions and an error record', await render(r));
});

test('a record whose rerun carries three of the four decisions, said measured or not measured: no sentence on the decisions, no outcome that states them, no row labelled same or different and no count, in the text runner and on the screen', async () => {
  for (const status of ['measured', 'not measured']) {
    const rec = without('blocked', [3], 'null', false, status);
    assertNoComparison(rec, `three of four, ${status}`, await render(rec));
  }
});

test('the sweep: no record whose four decisions are incomplete on either side shows a comparison word or a count, in the text runner and on the screen', async () => {
  const sets = [[0], [1], [2], [3], [0, 1, 2], [0, 1, 2, 3]];
  let checked = 0;
  let rendered = 0;
  for (const side of ['open', 'blocked']) {
    for (const indexes of sets) {
      for (const kind of ['null', 'missing key', 'error record']) {
        for (const same of [true, false]) {
          for (const status of ['measured', 'not measured']) {
            const rec = without(side, indexes, kind, same, status);
            const name = `${side} without ${indexes.map((i) => i + 1).join(' ')} (${kind}, same ${same}, ${status})`;
            // The page renders each way a decision can be missing, for one
            // scenario and for all four, on each side and in each state.
            const onPage = (indexes.length === 1 && indexes[0] === 3) || (indexes.length === 4 && same);
            assertNoComparison(rec, name, onPage ? await render(rec) : null);
            checked += 1;
            if (onPage) rendered += 1;
          }
        }
      }
    }
  }
  assert.equal(checked, 144);
  assert.equal(rendered, 36);
});
