// The words of the offline screen's idle and differs states and of its row
// tags, as the copy file carries them: compared byte for byte with the words
// set for them, then read back through the screen model and the text runner,
// which print these strings and carry none of their own. The records here
// are made by hand in the shape of the offline check's record.

import './support/outer-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offlineBlock } from '../src/runner/offline-text.mjs';
import { offlineState } from '../src/view/offline-state.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
const side = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.sidecar.json'), 'utf8'));
const SCREEN = COPY.SCREENS.find((s) => s.id === 'offline');
const X = COPY.RULED_EXTRA;
const clone = (o) => JSON.parse(JSON.stringify(o));

const IDLE_RESULT = 'Run the offline check to rerun the four scenarios with the network blocked.';
const DIFFERS_OUTCOME = 'Not the same decisions';
const DIFFERS_RESULT = 'Not every decision matched. Outbound connection attempts: {egressAttempts}.';
const STOPPED = 'the rerun ended without four decisions';

// One decision per scenario, each the decision its row names, short enough
// that the text runner prints each on one line.
const DECISIONS = {
  1: { outcome: 'paid', consentField: null, payment: { payee: 'City Water', amountCents: 8640 } },
  2: { outcome: 'refused', consentField: 'creditorAccounts', payment: null },
  3: { outcome: 'consent withdrawn', consentField: null, consents: [{ agent: 'Budget agent', status: 'active' }, { agent: 'Bill pay agent', status: 'withdrawn' }] },
  4: { outcome: 'agent on record', consentField: null, brokerDecision: 'allowed', signatureVerified: true },
};
// The bill paid with another amount: a decision its row names.
const OTHER_AMOUNT = { ...DECISIONS[1], payment: { ...DECISIONS[1].payment, amountCents: 8460 } };
// The fake invoice paid: a decision no row names.
const INVOICE_PAID = { ...DECISIONS[2], outcome: 'paid', consentField: null };

function record({ status = 'measured', reason = null, blocked = {}, egressAttempts = 0 } = {}) {
  const outcomes = ['1', '2', '3', '4'].map((scenario) => {
    const open = clone(DECISIONS[scenario]);
    const b = scenario in blocked ? clone(blocked[scenario]) : clone(DECISIONS[scenario]);
    return { scenario, open, blocked: b, same: b === null ? null : JSON.stringify(open) === JSON.stringify(b) };
  });
  return {
    check: 'offline', platform: 'darwin', status, reason, reasons: reason ? [reason] : [], runId: 'abcdefgh',
    profileSha256: 'f'.repeat(64), controls: [], outcomes, allSame: outcomes.every((o) => o.same === true), egressAttempts,
  };
}

// The model's result line as the page joins it, its fills in place.
const resultText = (right) => right.result.filter(Boolean)
  .map((p) => p.text.replace(/\{([A-Za-z]+)\}/g, (_, k) => String(p.values?.[k] ?? ''))).join(' ');

test('copy.json: the offline screen carries its row tags and the idle and differs words byte for byte, and no slot of theirs waits for words', () => {
  assert.equal(SCREEN.rowSame, ', same');
  assert.equal(SCREEN.rowDifferent, ', different');
  assert.deepEqual(SCREEN.states, {
    idle: { tone: 'neutral', outcome: 'Not run yet', result: IDLE_RESULT },
    differs: { tone: 'warn', outcome: DIFFERS_OUTCOME, result: DIFFERS_RESULT },
  });
  assert.equal(SCREEN.states.idle.outcome, COPY.GLOBAL.notRunOutcome);
  for (const [, v] of SCREEN.cols[1].rows) assert.ok(v.endsWith(SCREEN.rowSame), v);
  for (const k of ['offlineIdleResult', 'offlineDiffersOutcome', 'offlineDiffersResult']) {
    assert.equal(k in COPY.PENDING_WORDS, false, k);
    assert.equal(`PENDING_WORDS.${k}` in side.strings, false, k);
  }
});

test('screen model, idle: Not run yet, and the result line says what the check reruns', () => {
  const m = offlineState(COPY, null);
  assert.equal(m.state, 'idle');
  assert.equal(m.right.tone, 'neutral');
  assert.equal(m.right.outcome, 'Not run yet');
  assert.deepEqual(m.right.result, [{ text: IDLE_RESULT }]);
  assert.ok(m.right.rows.every(([, v]) => v === null));
});

test('screen model, differs: Not the same decisions in amber, the opening sentence and the count, the row a changed decision names tagged different, each equal row tagged same', () => {
  const m = offlineState(COPY, record({ blocked: { 1: OTHER_AMOUNT } }));
  assert.equal(m.state, 'differs');
  assert.equal(m.right.tone, 'warn');
  assert.equal(m.right.outcome, DIFFERS_OUTCOME);
  assert.equal(m.right.outcomePending ?? null, null);
  assert.equal(resultText(m.right), 'Not every decision matched. Outbound connection attempts: 0.');
  assert.deepEqual(m.right.rows[0].slice(0, 3), [SCREEN.cols[1].rows[0][0], `${SCREEN.cols[0].rows[0][1]}, different`, 'warn']);
  for (const i of [1, 2, 3]) assert.deepEqual(m.right.rows[i].slice(0, 3), [...SCREEN.cols[1].rows[i], null]);
  assert.deepEqual(m.failed, []);
});

test('screen model, differs: a changed decision no row names leaves its row empty, with neither tag, while the words for that decision are not set', () => {
  const m = offlineState(COPY, record({ blocked: { 2: INVOICE_PAID } }));
  assert.equal(m.state, 'differs');
  assert.equal(m.right.outcome, DIFFERS_OUTCOME);
  assert.ok(resultText(m.right).startsWith('Not every decision matched. '));
  assert.equal(m.right.rows[1][1], null);
  assert.equal(m.right.rows[1][3], 'offlineDiffersRow');
  for (const i of [0, 2, 3]) assert.equal(m.right.rows[i][1], SCREEN.cols[1].rows[i][1]);
});

test('screen model, not-measured with a changed decision: the gray minus, Not the same decisions, and the opening sentence of the differs state', () => {
  const reason = X.offlineNotMeasuredReasons[6];
  const m = offlineState(COPY, record({ status: 'not measured', reason, blocked: { 1: OTHER_AMOUNT }, egressAttempts: null }));
  assert.equal(m.state, 'not-measured');
  assert.equal(m.right.tone, 'neutral');
  assert.equal(m.right.outcome, DIFFERS_OUTCOME);
  assert.equal(resultText(m.right), `Not every decision matched. ${X.offlineNotMeasured.replace('{reason}', reason)}`);
  assert.equal(m.right.rows[0][1], `${SCREEN.cols[0].rows[0][1]}, different`);
});

test('screen model, a rerun that returned three decisions with one changed: no opening sentence, no outcome and no row tag', () => {
  const m = offlineState(COPY, record({ status: 'not measured', reason: STOPPED, blocked: { 1: OTHER_AMOUNT, 4: null }, egressAttempts: null }));
  assert.notEqual(m.state, 'differs');
  assert.equal(m.right.outcome, null);
  assert.equal(resultText(m.right), X.offlineNotMeasured.replace('{reason}', STOPPED));
  assert.ok(m.right.rows.every(([, v]) => v === null));
});

test('text runner: the row tags, the opening sentences and the words for no decision come from the copy file, and its source carries none of them', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/runner/offline-text.mjs'), 'utf8');
  for (const literal of ["', same'", "', different'", "'Each decision matched.'", "'Not every decision matched.'", "'no decision'"]) {
    assert.equal(source.includes(literal), false, literal);
  }
  assert.equal(X.offlineNoDecision, 'no decision');
  const opening = (line) => line.slice(0, line.indexOf('. ') + 1);
  const measured = offlineBlock(record());
  assert.ok(measured.includes(`  ${opening(SCREEN.cols[1].result)} Outbound connection attempts: 0.`), measured);
  assert.equal(measured.split('\n').filter((l) => l.includes(`${SCREEN.rowSame}.`)).length, 4, measured);
  const differs = offlineBlock(record({ blocked: { 1: OTHER_AMOUNT } }));
  assert.ok(differs.includes(`  ${opening(SCREEN.states.differs.result)} Outbound connection attempts: 0.`), differs);
  assert.ok(differs.includes(`paid${SCREEN.rowDifferent}.`), differs);
  const three = offlineBlock(record({ status: 'not measured', reason: STOPPED, blocked: { 4: null }, egressAttempts: null }));
  assert.ok(three.includes(`${X.offlineNoDecision}.`), three);
});
