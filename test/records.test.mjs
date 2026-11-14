// What each path can show in a dispute, read from the bank's records and the
// broker's signed log; and what never enters that log.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoRun } from '../src/orchestrator/run.mjs';
import { BILLPAY_CONSENT_TERMS, INVOICES } from '../src/config.mjs';
import { plantedPatterns } from './support/planted.mjs';
import { runSandboxed } from './support/sandboxed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('dispute on the grant path: the signed broker record names the agent and grant, joined to the ledger row; terms kept after withdrawal; a forged log is caught', async () => {
  const run = await DemoRun.create();
  try {
    assert.equal(await run.customerSignIn('B'), true);
    await run.approve('billpay');
    await run.approve('budget');
    const s1 = await run.agentTask('B', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
    assert.equal(s1.answer.status, 200);
    await run.agentTask('B', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.lakesideFake });
    const st = await run.state();
    const row = st.ledger.find((r) => r.path === 'B');
    const d = await run.dispute(row.rowId);
    assert.equal(d.agentOnRecord, 'demo_billpay_agent');
    assert.equal(d.grantReference, `grant://${run.consents.billpay.grantName}`);
    assert.equal(d.brokerDecision, 'allowed');
    assert.equal(d.matchedBy, 'Agent ID and time');
    assert.equal(d.signatureValid, true);
    for (const f of ['creditorAccounts', 'maximumIndividualAmount', 'periodicLimits', 'validToDateTime']) {
      assert.equal(d.consentCheck.find((x) => x.field === f).result, 'passed', f);
    }
    assert.equal(d.otherAttempts.length, 1);
    assert.equal(d.otherAttempts[0].failingField, 'creditorAccounts');

    // Withdrawal is not erasure: the dispute still shows the terms as approved.
    await run.withdraw('billpay');
    const before = JSON.stringify((await run.state()).ledger);
    const retry = await run.agentTask('B', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
    assert.equal(retry.answer.refused, true);
    assert.equal(JSON.stringify((await run.state()).ledger), before);
    const after = await run.dispute(row.rowId);
    assert.equal(after.consentAsOf.status, 'withdrawn');
    assert.deepEqual(after.consentAsOf.terms, structuredClone(BILLPAY_CONSENT_TERMS));
    assert.equal(after.signatureValid, true);

    // Re-sign the log with a fresh key and replace the .pub file beside it.
    const logPath = path.join(run.runDir, (await run.records()).audit.logFile);
    const forged = runSandboxed(path.join(HERE, 'support/resign-cell.mjs'), { args: [logPath] });
    assert.equal(forged.status, 0, forged.stderr);
    assert.equal(forged.json.verifiesUnderReplacedPubFile, true, 'a view that read the .pub file would call the forged log verified');
    const afterForgery = await run.dispute(row.rowId);
    assert.equal(afterForgery.signature.valid, false);
    assert.equal(afterForgery.signatureValid, false);
  } finally {
    await run.stop();
  }
});

test('dispute on the password path: the account log shows a password sign in and the payment, and no agent', async () => {
  const run = await DemoRun.create({ pathB: false });
  try {
    assert.equal(await run.customerSignIn('A'), true);
    await run.agentTask('A', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
    const row = (await run.state()).ledger[0];
    const d = await run.dispute(row.rowId);
    assert.equal(d.agentOnRecord, null);
    assert.deepEqual(d.accountLog.map((e) => e.event), ['sign in', 'payment']);
    assert.equal(d.accountLog[0].method, 'password');
    assert.ok(d.notInLog.includes('which agent acted'));
  } finally {
    await run.stop();
  }
});

test('a provider failure and a payment API failure leave no planted value in the broker log', async () => {
  const run = await DemoRun.create();
  try {
    assert.equal(await run.customerSignIn('B'), true);
    await run.approve('billpay');
    await run.pathBOp({ name: 'faultTokenService' });
    const a = await run.agentTask('B', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
    await run.pathBOp({ name: 'restore' });
    await run.pathBOp({ name: 'faultPaymentApi' });
    const b = await run.agentTask('B', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.lakesideFake });
    await run.pathBOp({ name: 'restore' });
    assert.equal(a.answer.step, 'broker');
    assert.equal(b.answer.step, 'broker');
    const rec = await run.records();
    const reasons = rec.audit.entries.filter((e) => e.eventType === 'grant').map((e) => e.reason);
    assert.ok(reasons.includes('resolution error: token exchange failed'), reasons.join(' | '));
    assert.ok(reasons.includes('resolution error: payment API call failed'), reasons.join(' | '));
    const text = fs.readFileSync(path.join(run.runDir, rec.audit.logFile), 'utf8');
    for (const re of plantedPatterns()) assert.equal(re.test(text), false, `the broker log holds ${re}`);
    assert.equal((await run.state()).ledger.length, 0);
  } finally {
    await run.stop();
  }
});
