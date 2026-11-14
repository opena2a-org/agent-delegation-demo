// The mock bank's records: customers, accounts, payees, sessions, the
// payment ledger, the bank's decision log, consent records with their
// history that is appended to and never rewritten, and each customer's
// account log.
//
// Everything lives in this process's memory for one run. Passwords are kept
// as scrypt hashes, never in clear.

import crypto from 'node:crypto';
import { CUSTOMERS, OPENING_BALANCE_CENTS, PAYEES } from '../config.mjs';
import { evaluateConsent } from './enforce.mjs';

const randomId = (prefix, bytes = 8) => `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;

function hashPassword(password, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(password, salt, 32);
  return { salt, hash };
}

function passwordMatches(stored, password) {
  if (!stored || typeof password !== 'string') return false;
  const { hash } = hashPassword(password, stored.salt);
  return crypto.timingSafeEqual(hash, stored.hash);
}

export class BankState {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
    this.customers = new Map();
    for (const c of Object.values(CUSTOMERS)) {
      this.customers.set(c.key, {
        key: c.key,
        username: c.username,
        displayName: c.displayName,
        email: c.email,
        customerNumber: c.customerNumber,
        accountId: c.accountId,
        balanceCents: OPENING_BALANCE_CENTS,
        password: null,
        payees: PAYEES.map((p) => ({ name: p.name, account: p.account, addedAt: null, addedBy: 'opening' })),
      });
    }
    this.sessions = new Map(); // token -> { sessionId, customerKey, createdAt }
    this.ledger = [];
    this.decisions = [];
    this.consents = new Map(); // consentId -> active consent record
    this.consentHistory = []; // appended to, never rewritten
    this.accountLog = [];
  }

  iso() {
    return this.now().toISOString();
  }

  customerByUsername(username) {
    for (const c of this.customers.values()) if (c.username === username) return c;
    return null;
  }

  log(customerKey, event, detail = {}) {
    const row = { time: this.iso(), customer: customerKey, event, ...detail };
    this.accountLog.push(row);
    return row;
  }

  setPassword(customerKey, password) {
    const c = this.customers.get(customerKey);
    if (!c) throw new Error('no such customer');
    c.password = hashPassword(password);
  }

  login(username, password) {
    const c = this.customerByUsername(username);
    if (!c || !passwordMatches(c.password, password)) {
      if (c) this.log(c.key, 'sign in refused', { method: 'password' });
      return null;
    }
    const token = crypto.randomBytes(32).toString('hex');
    const sessionId = randomId('ses', 4);
    this.sessions.set(token, { sessionId, customerKey: c.key, createdAt: this.iso() });
    this.log(c.key, 'sign in', { method: 'password', sessionId });
    return { token, sessionId, customer: c.key };
  }

  session(token) {
    if (typeof token !== 'string') return null;
    return this.sessions.get(token) ?? null;
  }

  endSessions(customerKey) {
    let ended = 0;
    for (const [token, s] of this.sessions) {
      if (s.customerKey === customerKey) {
        this.sessions.delete(token);
        ended += 1;
      }
    }
    return ended;
  }

  changePassword(token, currentPassword, newPassword) {
    const s = this.session(token);
    if (!s) return { ok: false, reason: 'not signed in' };
    const c = this.customers.get(s.customerKey);
    if (!passwordMatches(c.password, currentPassword)) return { ok: false, reason: 'current password does not match' };
    c.password = hashPassword(newPassword);
    const ended = this.endSessions(c.key);
    this.log(c.key, 'password changed', { sessionId: s.sessionId, sessionsEnded: ended });
    return { ok: true, sessionsEnded: ended };
  }

  balance(customerKey) {
    return this.customers.get(customerKey).balanceCents;
  }

  // Path A: a payment made from a customer session. The bank sees the
  // customer; a payee it has not seen before is added on the spot, with no
  // one time code or device check.
  payAsCustomer(token, { payeeName, payeeAccount, amountCents }) {
    const s = this.session(token);
    if (!s) return { ok: false, status: 401, reason: 'not signed in' };
    const c = this.customers.get(s.customerKey);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return { ok: false, status: 400, reason: 'bad amount' };
    if (amountCents > c.balanceCents) return { ok: false, status: 409, reason: 'insufficient funds' };
    let payeeAdded = false;
    if (!c.payees.some((p) => p.account === payeeAccount)) {
      c.payees.push({ name: payeeName, account: payeeAccount, addedAt: this.iso(), addedBy: s.sessionId });
      payeeAdded = true;
      this.log(c.key, 'payee added', { sessionId: s.sessionId, payeeAccount });
    }
    c.balanceCents -= amountCents;
    const row = {
      rowId: randomId('led'),
      time: this.iso(),
      customer: c.key,
      accountId: c.accountId,
      path: 'A',
      channel: 'online banking session',
      sessionId: s.sessionId,
      payeeName,
      payeeAccount,
      amountCents,
      currency: 'USD',
      payeeAdded,
      balanceAfterCents: c.balanceCents,
    };
    this.ledger.push(row);
    this.log(c.key, 'payment', { sessionId: s.sessionId, ledgerRowId: row.rowId, payeeAccount, amountCents });
    return { ok: true, row };
  }

  // Consent records. The consent id, grant name and binding name are random
  // and opaque: none is built from a customer's name, account or number.
  createConsent({ customerKey, agentId, agentDid, agentRole, terms, trustClass }) {
    const consentId = randomId('cns', 12);
    const grantName = `g-${crypto.randomBytes(12).toString('hex')}`;
    const record = {
      consentId,
      grantName,
      customer: customerKey,
      agentId,
      agentDid,
      agentRole,
      trustClass,
      terms: structuredClone(terms),
      status: 'active',
      approvedAt: this.iso(),
    };
    this.consents.set(consentId, record);
    this.consentHistory.push({ event: 'approved', at: record.approvedAt, record: structuredClone(record) });
    return record;
  }

  // Withdrawal removes the active record, so the bank stops honouring it at
  // once, and appends the withdrawal to the history, which keeps the terms as
  // they stood for any later dispute.
  withdrawConsent(consentId, customerKey) {
    const record = this.consents.get(consentId);
    if (!record || record.customer !== customerKey) return null;
    this.consents.delete(consentId);
    const at = this.iso();
    this.consentHistory.push({ event: 'withdrawn', at, record: { ...structuredClone(record), status: 'withdrawn', withdrawnAt: at } });
    this.log(customerKey, 'consent withdrawn', { consentId, agentId: record.agentId });
    return { ...record, status: 'withdrawn', withdrawnAt: at };
  }

  consentAsOf(consentId) {
    const active = this.consents.get(consentId);
    if (active) return structuredClone(active);
    const last = [...this.consentHistory].reverse().find((h) => h.record.consentId === consentId);
    return last ? structuredClone(last.record) : null;
  }

  // Path B: an operation under a consent, decided by the bank's own check.
  // The bank records every decision; a ledger row is written when money
  // moves, and at no other time.
  actUnderConsent({ consentId, tokenSub, tokenJti, operation }) {
    const now = this.now();
    const record = this.consentAsOf(consentId);
    const customerKey = record?.customer ?? null;
    const c = customerKey ? this.customers.get(customerKey) : null;
    const evaluation = evaluateConsent({
      consent: record,
      tokenSub,
      operation,
      ledger: this.ledger,
      now,
    });
    let funds = null;
    if (evaluation.allowed && operation.kind === 'payment' && operation.amountCents > c.balanceCents) {
      funds = { field: 'funds', result: 'failed' };
    }
    const allowed = evaluation.allowed && !funds;
    const decision = {
      decisionId: randomId('dec'),
      time: now.toISOString(),
      customer: customerKey,
      path: 'B',
      kind: operation.kind,
      agentDid: tokenSub,
      agentId: record && record.agentDid === tokenSub ? record.agentId : null,
      consentId,
      tokenJti,
      attempted: operation.kind === 'payment'
        ? { payeeAccount: operation.creditorAccount, amountCents: operation.amountCents, currency: operation.currency }
        : { read: 'balance' },
      decision: allowed ? 'allowed' : 'refused',
      failingField: allowed ? null : (evaluation.failingField ?? 'funds'),
      fields: evaluation.fields,
      reason: allowed ? evaluation.reason : (funds ? 'There are not enough funds for this payment.' : evaluation.reason),
      ledgerRowId: null,
    };
    let row = null;
    if (allowed && operation.kind === 'payment') {
      c.balanceCents -= operation.amountCents;
      const payee = c.payees.find((p) => p.account === operation.creditorAccount);
      row = {
        rowId: randomId('led'),
        time: decision.time,
        customer: c.key,
        accountId: c.accountId,
        path: 'B',
        channel: 'agent under consent',
        agentId: record.agentId,
        agentDid: tokenSub,
        consentId,
        tokenJti,
        payeeName: payee ? payee.name : null,
        payeeAccount: operation.creditorAccount,
        amountCents: operation.amountCents,
        currency: operation.currency,
        payeeAdded: false,
        balanceAfterCents: c.balanceCents,
        consentCheck: decision.fields,
        decisionId: decision.decisionId,
      };
      this.ledger.push(row);
      decision.ledgerRowId = row.rowId;
    }
    this.decisions.push(decision);
    return { decision, row, balanceCents: c && allowed && operation.kind === 'balance' ? c.balanceCents : null };
  }

  snapshot() {
    const customers = {};
    for (const c of this.customers.values()) {
      customers[c.key] = {
        username: c.username,
        displayName: c.displayName,
        email: c.email,
        customerNumber: c.customerNumber,
        accountId: c.accountId,
        balanceCents: c.balanceCents,
        payees: c.payees.map((p) => ({ ...p })),
        activeSessions: [...this.sessions.values()].filter((s) => s.customerKey === c.key).map((s) => s.sessionId),
      };
    }
    return {
      customers,
      ledger: structuredClone(this.ledger),
      decisions: structuredClone(this.decisions),
      consents: [...this.consents.values()].map((r) => structuredClone(r)),
      consentHistory: structuredClone(this.consentHistory),
      accountLog: structuredClone(this.accountLog),
    };
  }
}
