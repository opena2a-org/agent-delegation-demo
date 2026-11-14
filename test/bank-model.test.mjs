import './support/outer-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BankState } from '../src/bank/state.mjs';
import { BILLPAY_CONSENT_TERMS, BUDGET_CONSENT_TERMS, INJECTED_ACCOUNT } from '../src/config.mjs';
import { formatUsd, parseCents } from '../src/bank/money.mjs';

const BILLPAY_DID = 'did:opena2a:agent:demo_billpay_agent';
const BUDGET_DID = 'did:opena2a:agent:demo_budget_agent';

function bankAt(iso) {
  let t = Date.parse(iso);
  const bank = new BankState({ now: () => new Date(t) });
  bank.tick = (ms = 1000) => { t += ms; };
  return bank;
}

function consentFor(bank, customerKey = 'B') {
  return bank.createConsent({
    customerKey,
    agentId: 'demo_billpay_agent',
    agentDid: BILLPAY_DID,
    agentRole: 'billpay',
    terms: BILLPAY_CONSENT_TERMS,
    trustClass: 'payment:billpay',
  });
}

const pay = (account, amount) => ({ kind: 'payment', creditorAccount: account, amountCents: parseCents(amount), currency: 'USD' });

function frozen(bank) {
  return JSON.stringify({ balance: bank.balance('B'), ledger: bank.ledger, payees: bank.customers.get('B').payees });
}

test('opening state: two customers at $4,800.00 with three approved payees each', () => {
  const bank = bankAt('2026-10-23T12:00:00Z');
  const s = bank.snapshot();
  for (const k of ['A', 'B']) {
    assert.equal(formatUsd(s.customers[k].balanceCents), '$4,800.00');
    assert.deepEqual(s.customers[k].payees.map((p) => p.name), ['City Water', 'Metro Power', 'Lakeside Internet']);
  }
  assert.equal(s.ledger.length, 0);
});

test('password path: the bank sees the customer and adds a new payee with no further check', () => {
  const bank = bankAt('2026-10-23T12:00:00Z');
  bank.setPassword('A', 'correct horse');
  assert.equal(bank.login('customer.a', 'wrong'), null);
  const session = bank.login('customer.a', 'correct horse');
  const r1 = bank.payAsCustomer(session.token, { payeeName: 'City Water', payeeAccount: 'DEMO-0000-1180', amountCents: 8640 });
  assert.equal(r1.ok, true);
  assert.equal(formatUsd(bank.balance('A')), '$4,713.60');
  const r2 = bank.payAsCustomer(session.token, { payeeName: 'Lakeside Internet', payeeAccount: INJECTED_ACCOUNT, amountCents: 24000 });
  assert.equal(r2.ok, true);
  assert.equal(r2.row.payeeAdded, true);
  assert.equal(formatUsd(bank.balance('A')), '$4,473.60');
  assert.ok(bank.customers.get('A').payees.some((p) => p.account === INJECTED_ACCOUNT));
  assert.equal(bank.ledger.filter((r) => r.customer === 'A').length, 2);
  assert.ok(bank.ledger.every((r) => r.agentId === undefined));
});

test('password change ends every session of that customer', () => {
  const bank = bankAt('2026-10-23T12:00:00Z');
  bank.setPassword('A', 'one');
  const s1 = bank.login('customer.a', 'one');
  const s2 = bank.login('customer.a', 'one');
  const s3 = bank.login('customer.a', 'one');
  const r = bank.changePassword(s3.token, 'one', 'two');
  assert.deepEqual(r, { ok: true, sessionsEnded: 3 });
  for (const s of [s1, s2, s3]) assert.equal(bank.session(s.token), null);
  assert.equal(bank.login('customer.a', 'one'), null);
  assert.ok(bank.login('customer.a', 'two'));
});

test('consent check: an approved payee inside every limit is paid and all four fields pass', () => {
  const bank = bankAt('2026-10-23T12:00:00Z');
  const c = consentFor(bank);
  const r = bank.actUnderConsent({ consentId: c.consentId, tokenSub: BILLPAY_DID, tokenJti: 'j1', operation: pay('DEMO-0000-1180', '86.40') });
  assert.equal(r.decision.decision, 'allowed');
  for (const f of ['creditorAccounts', 'maximumIndividualAmount', 'periodicLimits', 'validToDateTime']) {
    assert.equal(r.decision.fields.find((x) => x.field === f).result, 'passed', f);
  }
  assert.equal(formatUsd(bank.balance('B')), '$4,713.60');
  assert.equal(bank.ledger.length, 1);
  assert.equal(bank.ledger[0].consentId, c.consentId);
});

test('consent check: a payee outside the record is refused, balance and ledger unchanged', () => {
  const bank = bankAt('2026-10-23T12:00:00Z');
  const c = consentFor(bank);
  const before = frozen(bank);
  const r = bank.actUnderConsent({ consentId: c.consentId, tokenSub: BILLPAY_DID, tokenJti: 'j2', operation: pay(INJECTED_ACCOUNT, '240.00') });
  assert.equal(r.decision.decision, 'refused');
  assert.equal(r.decision.failingField, 'creditorAccounts');
  assert.equal(r.decision.reason, "Account ending 4417 isn't an approved payee account.");
  for (const f of ['maximumIndividualAmount', 'periodicLimits', 'validToDateTime']) {
    assert.equal(r.decision.fields.find((x) => x.field === f).result, 'passed', f);
  }
  assert.equal(frozen(bank), before);
});

test('consent check: a payment over the per payment limit is refused, balance and ledger unchanged', () => {
  const bank = bankAt('2026-10-23T12:00:00Z');
  const c = consentFor(bank);
  const before = frozen(bank);
  const r = bank.actUnderConsent({ consentId: c.consentId, tokenSub: BILLPAY_DID, tokenJti: 'j3', operation: pay('DEMO-0000-6342', '250.01') });
  assert.equal(r.decision.failingField, 'maximumIndividualAmount');
  assert.equal(frozen(bank), before);
});

test('consent check: a payment over the monthly total is refused, balance and ledger unchanged', () => {
  const bank = bankAt('2026-10-23T12:00:00Z');
  const c = consentFor(bank);
  for (const [i, amount] of ['200.00', '200.00'].entries()) {
    const r = bank.actUnderConsent({ consentId: c.consentId, tokenSub: BILLPAY_DID, tokenJti: `m${i}`, operation: pay('DEMO-0000-6342', amount) });
    assert.equal(r.decision.decision, 'allowed');
    bank.tick();
  }
  const before = frozen(bank);
  const r = bank.actUnderConsent({ consentId: c.consentId, tokenSub: BILLPAY_DID, tokenJti: 'm3', operation: pay('DEMO-0000-2208', '100.01') });
  assert.equal(r.decision.failingField, 'periodicLimits');
  assert.equal(frozen(bank), before);
});

test('consent check: the monthly total starts again in the next calendar month (UTC)', () => {
  let t = Date.parse('2026-10-31T23:59:00Z');
  const bank = new BankState({ now: () => new Date(t) });
  const c = consentFor(bank);
  for (const j of ['a', 'b']) bank.actUnderConsent({ consentId: c.consentId, tokenSub: BILLPAY_DID, tokenJti: j, operation: pay('DEMO-0000-6342', '250.00') });
  t = Date.parse('2026-11-01T00:00:01Z');
  const r = bank.actUnderConsent({ consentId: c.consentId, tokenSub: BILLPAY_DID, tokenJti: 'c', operation: pay('DEMO-0000-6342', '250.00') });
  assert.equal(r.decision.decision, 'allowed');
});

test('consent check: after validToDateTime every payment is refused on that field', () => {
  const bank = bankAt('2027-04-01T00:00:00Z');
  const c = consentFor(bank);
  const r = bank.actUnderConsent({ consentId: c.consentId, tokenSub: BILLPAY_DID, tokenJti: 'x', operation: pay('DEMO-0000-1180', '86.40') });
  assert.equal(r.decision.failingField, 'validToDateTime');
  assert.equal(r.decision.reason, 'The consent ended on March 31, 2027.');
});

test('consent check: another agent presenting this consent is refused on the agent field, state unchanged', () => {
  const bank = bankAt('2026-10-23T12:00:00Z');
  const c = consentFor(bank);
  const before = frozen(bank);
  const r = bank.actUnderConsent({ consentId: c.consentId, tokenSub: BUDGET_DID, tokenJti: 'y', operation: pay('DEMO-0000-1180', '86.40') });
  assert.equal(r.decision.failingField, 'agent');
  assert.equal(frozen(bank), before);
});

test('consent check: a consent to read the balance cannot pay', () => {
  const bank = bankAt('2026-10-23T12:00:00Z');
  const c = bank.createConsent({ customerKey: 'B', agentId: 'demo_budget_agent', agentDid: BUDGET_DID, agentRole: 'budget', terms: BUDGET_CONSENT_TERMS, trustClass: 'payment:read' });
  const r = bank.actUnderConsent({ consentId: c.consentId, tokenSub: BUDGET_DID, tokenJti: 'z', operation: pay('DEMO-0000-1180', '86.40') });
  assert.equal(r.decision.failingField, 'permissions');
  const read = bank.actUnderConsent({ consentId: c.consentId, tokenSub: BUDGET_DID, tokenJti: 'z2', operation: { kind: 'balance' } });
  assert.equal(read.decision.decision, 'allowed');
  assert.equal(read.balanceCents, 480000);
});

test('withdrawal is not erasure: the terms stay on record and a new payment is refused at once', () => {
  const bank = bankAt('2026-10-23T12:00:00Z');
  const c = consentFor(bank);
  const paid = bank.actUnderConsent({ consentId: c.consentId, tokenSub: BILLPAY_DID, tokenJti: 'p', operation: pay('DEMO-0000-1180', '86.40') });
  assert.equal(paid.decision.decision, 'allowed');
  bank.tick();
  const w = bank.withdrawConsent(c.consentId, 'B');
  assert.equal(w.status, 'withdrawn');
  assert.equal(bank.consents.has(c.consentId), false, 'the active consent record is removed');
  const asOf = bank.consentAsOf(paid.row.consentId);
  assert.deepEqual(asOf.terms, structuredClone(BILLPAY_CONSENT_TERMS));
  assert.equal(asOf.status, 'withdrawn');
  const before = frozen(bank);
  const r = bank.actUnderConsent({ consentId: c.consentId, tokenSub: BILLPAY_DID, tokenJti: 'q', operation: pay('DEMO-0000-1180', '86.40') });
  assert.equal(r.decision.failingField, 'status');
  assert.equal(frozen(bank), before);
  assert.deepEqual(bank.consentHistory.map((h) => h.event), ['approved', 'withdrawn']);
});

test('consent ids and grant names are random and carry no customer identifier', () => {
  const bank = bankAt('2026-10-23T12:00:00Z');
  const a = consentFor(bank);
  const b = consentFor(bank);
  assert.notEqual(a.consentId, b.consentId);
  assert.notEqual(a.grantName, b.grantName);
  for (const v of [a.consentId, a.grantName]) {
    assert.match(v, /^(cns_|g-)[0-9a-f]{24}$/);
    for (const bad of ['customer', 'DEMO', '000B', 'b@']) assert.ok(!v.includes(bad), `${v} carries ${bad}`);
  }
});
