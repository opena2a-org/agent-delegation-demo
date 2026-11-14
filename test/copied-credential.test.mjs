// The copied credential case, recorded as a known limitation, not shown as a
// scenario. The agent credential is a bearer credential: the broker checks
// the credential and the grant, and nothing proves the presenter holds a key
// bound to it. A copy of the bill pay agent's own credential, presented with
// its grant name by a second holder (the budget agent's process), is
// accepted today, and the bank's records name the bill pay agent, not the
// process that sent it. Every grant path decision carries the bearer
// credential label (held until its words are ruled, so never printed by
// mistake). This test fails when that changes, so the label is reviewed with
// it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DemoRun } from '../src/orchestrator/run.mjs';
import { INVOICES } from '../src/config.mjs';
import { grantPathLabels } from '../src/scenarios/labels.mjs';

let run;
const R = {};

before(async () => {
  run = await DemoRun.create();
  assert.equal(await run.customerSignIn('B'), true);
  await run.approve('billpay');
  await run.approve('budget');
  R.before = await run.state();
  const copy = run.placeCredentialCopy('billpay', 'budget');
  R.out = await run.agentTask('B', 'budget', {
    kind: 'pay-invoice',
    invoice: INVOICES.cityWater,
    present: { grant: `grant://${run.consents.billpay.grantName}`, atxFile: copy },
  });
  R.after = await run.state();
});
after(async () => { if (run) await run.stop(); });

test('a copy of the bill pay agent\'s credential with its grant name, presented by a second holder, is accepted today, and the bank records the bill pay agent', () => {
  const decisions = R.after.decisions.slice(R.before.decisions.length);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, 'allowed');
  assert.equal(decisions[0].agentId, 'demo_billpay_agent');
  const rows = R.after.ledger.slice(R.before.ledger.length);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agentId, 'demo_billpay_agent');
  assert.equal(rows[0].payeeName, 'City Water');
  assert.equal(rows[0].amountCents, 8640);
  assert.equal(R.after.customers.B.balanceCents, R.before.customers.B.balanceCents - 8640);
  assert.equal(R.out.answer.refused, false);
});

// The label states what case 1 proves: a copy, presented with the grant
// name, is accepted as this agent.
const BEARER = 'Bearer credential: a copy with the grant name is accepted as this agent. Proof of possession is specified in AAP, not yet in the reference implementation.';

test('every grant path decision carries the bearer credential label in its set words, printable on all eight placements', () => {
  for (const screen of ['setup', 'approve', '1', '2', 'cross', '3', '4', 'offline']) {
    const bearer = grantPathLabels(screen).find((l) => l.id === 'L10');
    assert.ok(bearer, screen);
    assert.equal(bearer.text, BEARER, screen);
    assert.equal(bearer.status, 'ruled', screen);
    assert.equal(bearer.printable, true, screen);
    assert.equal(bearer.onScreen, true, screen);
  }
});
