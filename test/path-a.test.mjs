// The password path, end to end: real bank and agent processes, each under
// its own sandbox profile where the system has one. Every assertion reads
// the bank's state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DemoRun } from '../src/orchestrator/run.mjs';
import { INVOICES } from '../src/config.mjs';
import { formatUsd } from '../src/bank/money.mjs';

function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

test('password path: the agent pays as the customer, follows the hidden line, and a password change stops everyone', async () => {
  const run = await DemoRun.create({ pathB: false });
  try {
    assert.equal(await run.customerSignIn('A'), true);

    const s1 = await run.agentTask('A', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
    assert.equal(s1.answer.status, 200);
    let st = await run.state();
    assert.equal(formatUsd(st.customers.A.balanceCents), '$4,713.60');
    assert.equal(st.ledger.length, 1);
    assert.equal(st.ledger[0].channel, 'online banking session');
    assert.equal(st.ledger[0].agentId, undefined, 'the bank records no agent on the password path');

    const s2 = await run.agentTask('A', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.lakesideFake });
    assert.equal(s2.followedHiddenInstruction, true);
    assert.equal(s2.answer.status, 200);
    st = await run.state();
    assert.equal(formatUsd(st.customers.A.balanceCents), '$4,473.60');
    const added = st.customers.A.payees.find((p) => p.account === 'DEMO-0000-4417');
    assert.ok(added, 'the new payee was added');
    assert.equal(st.ledger[1].payeeAdded, true);

    const budgetBefore = await run.agentTask('A', 'budget', { kind: 'read-balance' });
    assert.equal(budgetBefore.answer.status, 200);
    assert.equal((await run.customerBalance('A')).status, 200);

    const change = await run.customerChangePassword('A');
    assert.equal(change.status, 200);
    st = await run.state();
    assert.deepEqual(st.customers.A.activeSessions, [], 'every session of Customer A ended');

    const retry = await run.agentTask('A', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
    assert.equal(retry.answer.refused, true);
    assert.equal(retry.answer.step, 'sign in');
    const budgetAfter = await run.agentTask('A', 'budget', { kind: 'read-balance' });
    assert.equal(budgetAfter.answer.refused, true);
    assert.equal((await run.customerBalance('A')).status, 401, 'the customer has to sign in again');
    st = await run.state();
    assert.equal(formatUsd(st.customers.A.balanceCents), '$4,473.60');
    assert.equal(st.ledger.length, 2);

    const log = st.accountLog.filter((r) => r.customer === 'A');
    assert.ok(log.some((r) => r.event === 'sign in' && r.method === 'password'));
    assert.ok(log.some((r) => r.event === 'payment'));
    assert.ok(log.every((r) => !('agentId' in r) && !('agentDid' in r)), 'the account log names no agent');
    assert.ok(log.filter((r) => r.event === 'sign in refused').length >= 2, 'both agents were refused at sign in');

    const password = run.passwords.A;
    for (const f of filesUnder(run.runDir)) {
      assert.equal(fs.readFileSync(f, 'utf8').includes(password), false, `${path.relative(run.runDir, f)} holds the password`);
    }
  } finally {
    await run.stop();
  }
});

test('password path: two runs make two different passwords, and neither is written to the run directory', async () => {
  const seen = [];
  for (let i = 0; i < 2; i += 1) {
    const run = await DemoRun.create({ pathB: false });
    try {
      assert.equal(await run.customerSignIn('A'), true);
      await run.agentTask('A', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
      seen.push(run.passwords.A);
      for (const f of filesUnder(run.runDir)) {
        assert.equal(fs.readFileSync(f, 'utf8').includes(run.passwords.A), false);
      }
    } finally {
      await run.stop();
    }
  }
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
});
