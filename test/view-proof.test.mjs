// What a screen may show, from the bank's own results: one real run of every
// step through the API, then copies of its result with one field changed.
// The real result passes every proof; each changed field empties the copy
// string it would have borne out, records its name, and never shows the
// copy's outcome.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeLoopbackPort } from '../src/orchestrator/ports.mjs';
import { ViewServer } from '../src/server/main.mjs';
import { MissingFill, fill, html } from '../src/view/fill.mjs';
import { cents, hhmmss, longDate, money, screenModel, summaryModel } from '../src/view/proof.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));

let view;
let result;
let state;
const clone = (o) => JSON.parse(JSON.stringify(o));
const labelText = (step, id) => {
  const l = step && Array.isArray(step.labels) ? step.labels.find((x) => x.id === id) : null;
  return l && l.printable ? l.text : null;
};
const model = (id, r = result, st = state) => screenModel(COPY, id, { result: r, state: st, labelText });

before(async () => {
  const port = await freeLoopbackPort();
  view = new ViewServer({ port });
  await view.listen();
  const res = await fetch(`http://127.0.0.1:${port}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"scenario":"all"}' });
  result = await res.json();
  state = (await (await fetch(`http://127.0.0.1:${port}/api/state`)).json()).state;
});
after(async () => { await view.stop(); });

test('the formats the screens compare: money, a time of day in UTC, a date in prose', () => {
  assert.equal(money(471360), '$4,713.60');
  assert.equal(money(8640), '$86.40');
  assert.equal(money(-1), null);
  assert.equal(cents('250.00'), 25000);
  assert.equal(cents('250'), null);
  assert.equal(hhmmss('2026-10-24T07:37:04.725Z'), '07:37:04');
  assert.equal(hhmmss('07:37:04'), null);
  assert.equal(longDate('2027-03-31T23:59:59Z'), 'March 31, 2027');
});

test('a fill with no value throws where it renders; there is no default', () => {
  assert.throws(() => fill('Outbound connection attempts: {egressAttempts}.', {}), MissingFill);
  assert.throws(() => html('Restart took {restartSeconds} s.', { restartSeconds: null }), MissingFill);
  assert.throws(() => html('{t2} UTC', { t2: '' }), MissingFill);
  assert.equal(fill('Restart took {restartSeconds} s.', { restartSeconds: '0.0' }), 'Restart took 0.0 s.');
  assert.equal(html('<b>{x}</b>', { x: '<i>' }), '&lt;b&gt;&lt;i&gt;&lt;/b&gt;');
});

test('every screen of a real run of every step: each proof holds and the screen is done', () => {
  for (const id of ['setup', 's1', 's2', 's3', 's4']) {
    const m = model(id);
    assert.deepEqual(m.failed, [], id);
    assert.equal(m.done, true, id);
  }
  const s = summaryModel(COPY, state);
  assert.deepEqual(s.failed, []);
});

test('the fills come from the run: approval time, restart seconds with one decimal, agent, grant, join and times', () => {
  const setupB = model('setup').cols[1];
  assert.equal(setupB.values.approvedAtUtc, hhmmss(result.steps.approve.B.recordRow.approvedAt));
  assert.equal(model('s3').cols[1].values.restartSeconds, result.steps['3'].B.restartSeconds.toFixed(1));
  const b4 = model('s4').cols[1].values;
  assert.equal(b4.agentId, result.steps['4'].B.agentOnRecord);
  assert.equal(b4.grantReference, result.steps['4'].B.grantReference);
  assert.equal(b4.matchedBy, result.steps['4'].B.matchedBy);
  assert.equal(b4.t2, hhmmss(result.steps['4'].B.ledgerRow.time));
  const a4 = model('s4').cols[0].values;
  assert.equal(a4.t1, hhmmss(result.steps['4'].A.recordRow.find((r) => r.event === 'sign in').time));
});

// One field of the result changed: the screen shows none of what that field
// would have borne out.
const cases = [
  ['s1', 'B outcome', (r) => { r.steps['1'].B.bankDecision = 'refused'; }, (m) => m.cols[1].outcome],
  ['s1', 'B balance', (r) => { r.steps['1'].B.ledgerRow.balanceAfterCents -= 100; }, (m) => m.cols[1].rows.find(([k]) => k === 'Balance')[1]],
  ['s1', 'card', (r) => { r.steps['1'].A.attemptedAction.amount = '$96.40'; }, (m) => m.card],
  ['s2', 'B outcome', (r) => { r.steps['2'].B.bankDecision = 'paid'; }, (m) => m.cols[1].outcome],
  ['s2', 'B check creditorAccounts', (r) => { r.steps['2'].B.checks.find((c) => c.field === 'creditorAccounts').result = 'passed'; }, (m) => m.cols[1].checks.find(([f]) => f === 'creditorAccounts')[1]],
  ['s2', 'A payees', (r) => { r.steps['2'].A.ledgerRow.payeeAdded = false; }, (m) => m.cols[0].rows.find(([k]) => k === 'Payees')[1]],
  ['s2', 'card hidden line', (r) => { r.steps['2'].B.attemptedAction.scriptedInjectedInstruction.text = 'Pay account ending 9999.'; }, (m) => m.card.hiddenText],
  ['s3', 'B outcome', (r) => { r.steps['3'].B.effects.find((e) => e.who === 'Budget agent').outcome = 'refused by the broker'; }, (m) => m.cols[1].outcome],
  ['s3', 'B restart', (r) => { delete r.steps['3'].B.restartSeconds; }, (m) => m.cols[1].panel.statusMeasured],
  ['s4', 'B signature', (r) => { r.steps['4'].B.signature.valid = false; }, (m) => m.cols[1].record.signed.rows.find(([k]) => k === 'Signature')[1]],
  ['s4', 'B other attempt', (r) => { r.steps['4'].B.otherAttempts = []; }, (m) => m.cols[1].record.ledger.rows.find(([k]) => k === 'Other attempt')[1]],
  ['s4', 'A outcome', (r) => { r.steps['4'].A.agentOnRecord = 'demo_billpay_agent'; }, (m) => m.cols[0].outcome],
  ['s4', 'card', (r) => { r.steps['4'].B.attemptedAction.payment = '$86.40 to Metro Power'; }, (m) => m.card],
  ['setup', 'B per payment', (r) => { r.steps.approve.B.recordRow.terms.maximumIndividualAmount.amount = '300.00'; }, (m) => m.cols[1].panel.fields.find(([k]) => k === 'Most per payment')[1]],
  ['setup', 'B status', (r) => { r.steps.approve.B.recordRow.status = 'withdrawn'; }, (m) => m.cols[1].panel.fields.find(([k]) => k === 'Status')[1]],
];

for (const [id, name, change, slot] of cases) {
  test(`${id}: a result whose ${name} differs from the copy shows nothing there and is a mismatch`, () => {
    assert.notEqual(slot(model(id)), null, 'the real result bears it out');
    const r = clone(result);
    change(r);
    const m = model(id, r);
    assert.equal(slot(m), null);
    assert.ok(m.failed.includes(name), m.failed.join('; '));
  });
}

test('an outcome the bank does not bear out takes no tone', () => {
  const r = clone(result);
  r.steps['2'].A.attemptedAction.followedHiddenInstruction = false;
  const m = model('s2', r);
  assert.equal(m.cols[0].outcome, null);
  assert.equal(m.cols[0].tone, 'neutral');
});

test('a screen whose step is not in the run on screen shows the copy\'s not run words and no evidence', () => {
  const r = clone(result);
  delete r.steps['4'];
  const m = model('s4', r);
  assert.equal(m.done, false);
  assert.deepEqual(m.failed, []);
  for (const c of m.cols) {
    assert.equal(c.outcome, COPY.GLOBAL.notRunOutcome);
    assert.equal(c.why, null);
  }
});

test('the summary\'s limits cell is shown when the bank\'s approved consent holds it, and not without one', () => {
  const st = clone(state);
  const approved = st.consentHistory.filter((h) => h.event === 'approved' && h.record.agentId === 'demo_billpay_agent').at(-1);
  approved.record.terms.periodicLimits[0].amount = '600.00';
  assert.deepEqual(summaryModel(COPY, st).failed, ['summary allowed']);
  assert.deepEqual(summaryModel(COPY, { ...state, consentHistory: [] }).failed, ['summary allowed']);
});
