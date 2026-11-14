// The offline screen's left column and the text runner's line on the same
// run: the title names how that run was made, the way every run of the demo
// is made; the text runner prints it as the column header beside the blocked
// run's, and names the same run in the line on its count. Compared byte for
// byte on a measured record whose run as usual counted 0. The record is made
// by hand in the shape of the offline check's record, with the scope words
// the check writes for that run.

import './support/outer-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { offlineBlock } from '../src/runner/offline-text.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
const side = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.sidecar.json'), 'utf8'));
const SCREEN = COPY.SCREENS.find((s) => s.id === 'offline');
const clone = (o) => JSON.parse(JSON.stringify(o));

const TITLE = 'Path B, run as usual';
const BLOCKED_TITLE = 'Path B, network blocked';
const SCOPE = 'the bank and the agent processes of both paths';
// The header as the text runner prints it: two spaces, the left title padded
// to its column of 46 characters, three spaces, then the right title.
const HEADER = `  ${TITLE}${' '.repeat(46 - TITLE.length)}   ${BLOCKED_TITLE}`;
const LINE = 'The run as usual, the bank and the agent processes of both paths: outbound connection attempts: 0.';
// The words the title and the line no longer carry, built from their parts
// so that a search of the tree for them finds no line here.
const WITHDRAWN = new RegExp(['network', 'open'].join(' '), 'i');

// One decision per scenario, each the decision its row names.
const DECISIONS = {
  1: { outcome: 'paid', consentField: null, payment: { payee: 'City Water', amountCents: 8640 } },
  2: { outcome: 'refused', consentField: 'creditorAccounts', payment: null },
  3: { outcome: 'consent withdrawn', consentField: null, consents: [{ agent: 'Budget agent', status: 'active' }, { agent: 'Bill pay agent', status: 'withdrawn' }] },
  4: { outcome: 'agent on record', consentField: null, brokerDecision: 'allowed', signatureVerified: true },
};

// A measured check: four decisions on both sides, each the same, 0 outbound
// attempts in the blocked run, and the run as usual measured at 0 unless its
// count is given as not measured.
function measured(openEgress = { status: 'measured', reason: null, egressAttempts: 0 }) {
  const outcomes = ['1', '2', '3', '4'].map((scenario) => ({ scenario, open: clone(DECISIONS[scenario]), blocked: clone(DECISIONS[scenario]), same: true }));
  return {
    check: 'offline', platform: 'darwin', status: 'measured', reason: null, reasons: [], runId: 'abcdefgh',
    profileSha256: 'f'.repeat(64), controls: [], outcomes, allSame: true, egressAttempts: 0,
    openRun: { runId: 'ijklmnop', egress: { scope: SCOPE, ...openEgress, attempts: [] } },
  };
}

test('the text runner, on a measured record whose run as usual counted 0: the column header names that run beside the blocked run, and the line on its count names the same run, byte for byte', () => {
  // The scope on the record is the one the check writes for that run.
  const check = fs.readFileSync(path.join(ROOT, 'src/egress/offline.mjs'), 'utf8');
  assert.equal(check.split(`scope: '${SCOPE}'`).length, 2);
  const lines = offlineBlock(measured()).split('\n');
  assert.deepEqual(lines.filter((l) => l.includes(BLOCKED_TITLE)), [HEADER]);
  assert.deepEqual(lines.filter((l) => l.includes(SCOPE)), [`  ${LINE}`]);
  assert.equal(LINE.length, 98);
  assert.deepEqual(lines.filter((l) => WITHDRAWN.test(l)), []);
});

test('the text runner, on a run as usual whose count was not measured: the line names the same run and gives the reason in place of a number', () => {
  const reason = COPY.RULED_EXTRA.offlineNotMeasuredReasons[0];
  const lines = offlineBlock(measured({ status: 'not measured', reason, egressAttempts: null })).split('\n');
  assert.deepEqual(lines.filter((l) => l.includes(SCOPE)), [`  The run as usual, ${SCOPE}: outbound connection attempts: not measured (${reason}).`]);
});

test('copy.json: the left column title is 20 characters beside the blocked column, and the sidecar records it as ruled, with its reason', () => {
  assert.equal(SCREEN.cols[0].title, TITLE);
  assert.equal(SCREEN.cols[0].title.length, 20);
  assert.equal(SCREEN.cols[1].title, BLOCKED_TITLE);
  const entry = side.strings['SCREENS (offline cols[0].title)'];
  assert.equal(entry?.status, 'ruled');
  assert.equal(typeof entry.reason, 'string');
});
