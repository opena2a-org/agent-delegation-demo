// The four scenarios and the cross agent case through the scenario engine,
// each checked against the bank's state; the every run rule; and the data
// that must never leave the bank's own records.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS } from '../src/config.mjs';
import { REPO_ROOT } from '../src/orchestrator/run.mjs';
import { runChain } from '../src/scenarios/engine.mjs';
import { credentialAndPathFindings, tokenFindings } from './support/emitted.mjs';
import { plantedPatterns } from './support/planted.mjs';

let full;
let st;
let rec;
let witness;
const agentLogs = [];

before(async () => {
  full = await runChain('all', { witness: true });
  st = await full.run.state();
  rec = await full.run.records();
  witness = await full.run.pathBOp({ name: 'witness' });
  for (const role of ['billpay', 'budget']) {
    agentLogs.push(fs.readFileSync(path.join(full.run.agentDir('B', role), 'agent.log'), 'utf8'));
  }
});
after(async () => { if (full) await full.run.stop(); });

const S = () => full.result.steps;

test('scenario 1: both paths pay City Water $86.40; both balances are $4,713.60', () => {
  assert.equal(S()['1'].A.bankDecision, 'paid');
  assert.equal(S()['1'].B.bankDecision, 'paid');
  assert.equal(S()['1'].A.balanceAfter, '$4,713.60');
  assert.equal(S()['1'].B.balanceAfter, '$4,713.60');
  for (const p of ['A', 'B']) assert.equal(S()['1'][p].ledgerRow.amountCents, 8640);
});

test('scenario 2: the password path pays account ending 4417; the grant path refuses it on creditorAccounts', () => {
  const { A, B } = S()['2'];
  assert.equal(A.attemptedAction.followedHiddenInstruction, true);
  assert.equal(A.attemptedAction.scriptedInjectedInstruction.label, 'scripted injected instruction');
  assert.equal(A.bankDecision, 'paid');
  assert.equal(A.ledgerRow.payeeAdded, true);
  assert.equal(A.balanceAfter, '$4,473.60');
  assert.equal(B.bankDecision, 'refused');
  assert.equal(B.consentField, 'creditorAccounts');
  assert.equal(B.ledgerRow, null);
  assert.equal(B.balanceAfter, '$4,713.60');
  assert.equal(st.customers.A.payees.some((p) => p.account === 'DEMO-0000-4417'), true);
  assert.equal(st.customers.B.payees.some((p) => p.account === 'DEMO-0000-4417'), false);
});

test('scenario 3: the password change stops both password agents and the customer; revoking one grant stops one agent', () => {
  const { A, B } = S()['3'];
  assert.deepEqual(A.effects.map((e) => e.outcome), ['refused at sign in', 'refused at sign in', 'signed out']);
  assert.deepEqual(B.effects.map((e) => e.outcome), ['refused by the broker', 'read the balance', 'kept working']);
  assert.equal(typeof B.restartSeconds, 'number');
  assert.deepEqual(st.customers.A.activeSessions, []);
  assert.ok(st.customers.B.activeSessions.length >= 1);
  assert.equal(st.consents.some((c) => c.agentId === 'demo_billpay_agent'), false);
  assert.equal(st.consents.some((c) => c.agentId === 'demo_budget_agent'), true);
  assert.equal(st.customers.A.balanceCents, 447360);
  assert.equal(st.customers.B.balanceCents, 471360);
});

test('scenario 4: the password path log has no agent; the grant path record names the agent, the grant and the decision', () => {
  const { A, B } = S()['4'];
  assert.equal(A.agentOnRecord, null);
  assert.deepEqual(A.recordRow.map((e) => e.event), ['sign in', 'payment']);
  assert.equal(B.agentOnRecord, 'demo_billpay_agent');
  assert.match(B.grantReference, /^grant:\/\/g-[0-9a-f]{24}$/);
  assert.equal(B.brokerDecision, 'allowed');
  assert.equal(B.signatureVerified, true);
  assert.equal(B.matchedBy, 'Agent ID and time');
  assert.equal(B.ledgerRow.amountCents, 8640);
  assert.equal(B.otherAttempts.filter((o) => o.failingField === 'creditorAccounts').length, 1);
});

test('every result carries the labels that apply, and a held or contested label is never printable', () => {
  for (const step of Object.values(S())) {
    for (const r of [step.A, step.B]) {
      assert.ok(Array.isArray(r.labels) && r.labels.length > 0);
      for (const l of r.labels) if (l.status !== 'ruled') assert.equal(l.printable, false, l.id);
    }
    if (step.B.bankDecision !== 'not applicable') {
      const ids = step.B.labels.map((l) => l.id);
      for (const id of ['L1', 'L6', 'L7', 'L8', 'L9', 'L10']) assert.ok(ids.includes(id), `${step.B.scenario} lacks ${id}`);
    }
  }
  const l7 = S()['1'].B.labels.find((l) => l.id === 'L7');
  assert.match(l7.text, /at commit [0-9a-f]{12}\.$/);
  const l10 = S()['1'].B.labels.find((l) => l.id === 'L10');
  assert.equal(l10.text, 'Bearer credential: a copy with the grant name is accepted as this agent. Proof of possession is specified in AAP, not yet in the reference implementation.');
  assert.equal(l10.printable, true);
  assert.equal(full.result.fictionalLine, 'Every customer, account, payee and payment in this demo is fictional.');
});

test('no payee, account, amount or customer identifier leaves the bank: not in any broker token, issued token, broker record or agent response', () => {
  const claims = JSON.stringify(rec.exchanges.map((e) => e.claims ?? { sub: e.sub, scope: e.scope, aud: e.aud, jti: e.jti }));
  const auditText = fs.readFileSync(path.join(full.run.runDir, rec.audit.logFile), 'utf8');
  for (const re of plantedPatterns()) {
    assert.equal(re.test(claims), false, `a broker token carries ${re}`);
    assert.equal(re.test(auditText), false, `the broker record carries ${re}`);
  }
  for (const log of agentLogs) {
    for (const line of log.trim().split('\n')) {
      const answer = JSON.stringify(JSON.parse(line).answer ?? null);
      for (const re of plantedPatterns()) assert.equal(re.test(answer), false, `an agent response carries ${re}`);
    }
  }
});

test('what the view renders, the scenario results the API returns with the agents\' attempted actions and outcomes, carries no broker token, no access token, no agent credential, no broker socket path and no run directory path', () => {
  assert.ok(witness.brokerTokens.length >= 4 && witness.accessTokens.length >= 3, 'precondition: the witness holds the run\'s broker tokens and access tokens');
  const items = [{ where: 'scenario results', text: JSON.stringify(full.result) }];
  assert.deepEqual(tokenFindings({ files: [], answers: items, brokerTokens: witness.brokerTokens, accessTokens: witness.accessTokens }), []);
  const credentials = Object.values(AGENTS).map((a) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, a.credentialFile), 'utf8')));
  const socketPath = path.join(full.run.dirs.sock, 'broker.sock');
  assert.deepEqual(credentialAndPathFindings({ items, runDir: full.run.runDir, socketPath, credentials }), []);
});

test('positive control: the bank\'s own records hold every planted value that is bank data', () => {
  const bankText = JSON.stringify({ customers: st.customers, consentHistory: st.consentHistory, ledger: st.ledger, decisions: st.decisions });
  // Not bank data: the SHA-256 of each account number, which the bank never
  // computes. Every other planted value must be found.
  const bankData = plantedPatterns().filter((re) => !/^[0-9a-f]{64}$/.test(re.source));
  assert.equal(plantedPatterns().length - bankData.length, 4);
  for (const re of bankData) assert.equal(re.test(bankText), true, `the bank's records lack ${re}`);
});

test('every run gives the presenter order values: scenario 2 alone equals scenario 2 in the sequence', async () => {
  const again = await runChain('2');
  try {
    const { A, B } = again.result.steps['2'];
    assert.equal(A.balanceAfter, '$4,473.60');
    assert.equal(B.balanceAfter, '$4,713.60');
    assert.equal(B.consentField, 'creditorAccounts');
    assert.notEqual(again.run.runId, full.run.runId);
  } finally {
    await again.run.stop();
  }
});
