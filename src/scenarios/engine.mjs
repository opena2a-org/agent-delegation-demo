// The scenarios. Every run starts a fresh bank and replays the chain that
// leads to the scenario through the same code paths, so any scenario, run in
// any order and as often as asked, gives the values of the presenter order.
// The same input goes to the agent on both paths; the way it reaches the
// bank is the one difference. Every result is read back from the bank's state and records.

import fs from 'node:fs';
import path from 'node:path';
import { AGENTS, INVOICES } from '../config.mjs';
import { accountEnding, formatUsd, parseCents } from '../bank/money.mjs';
import { joinAuditRecord } from '../bank/dispute.mjs';
import { DemoRun, REPO_ROOT } from '../orchestrator/run.mjs';
import { FICTIONAL_LINE, grantPathLabels, passwordPathLabels } from './labels.mjs';

export const CHAINS = Object.freeze({
  setup: ['setup'],
  approve: ['setup', 'approve'],
  1: ['setup', 'approve', '1'],
  2: ['setup', 'approve', '1', '2'],
  cross: ['setup', 'approve', '1', '2', 'cross'],
  3: ['setup', 'approve', '1', '2', '3'],
  4: ['setup', 'approve', '1', '2', '4'],
  all: ['setup', 'approve', '1', '2', '3', '4'],
});

export const STEP_TITLES = Object.freeze({
  setup: 'Setup',
  approve: 'Customer B approves the bill pay agent',
  1: 'Scenario 1: a normal bill',
  2: 'Scenario 2: an invoice with a scripted injected instruction',
  cross: 'Another agent presents the bill pay grant',
  3: 'Scenario 3: stop one agent',
  4: "Scenario 4: \"I didn't authorize that payment\"",
});

const AGENT_BY_ROLE = {};
const ROLE_BY_AGENT_ID = {};
const AGENT_ID_BY_DID = {};
for (const [role, a] of Object.entries(AGENTS)) {
  const atx = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, a.credentialFile), 'utf8'));
  AGENT_BY_ROLE[role] = { agentId: atx.agentId, agentDid: atx.agentDid, name: a.displayName };
  ROLE_BY_AGENT_ID[atx.agentId] = role;
  AGENT_ID_BY_DID[atx.agentDid] = atx.agentId;
}
const agentName = (agentId) => (ROLE_BY_AGENT_ID[agentId] ? AGENTS[ROLE_BY_AGENT_ID[agentId]].displayName : null);

function describeAttempt(att, by, followed) {
  if (att.kind === 'payment') {
    return {
      kind: 'payment',
      by,
      payee: att.payeeName,
      payeeAccountEnding: accountEnding(att.payeeAccount),
      amount: formatUsd(parseCents(att.amount)),
      invoiceId: att.invoiceId,
      followedHiddenInstruction: followed,
      scriptedInjectedInstruction: followed ? { label: INVOICES.lakesideFake.hidden.label, text: INVOICES.lakesideFake.hidden.text } : null,
    };
  }
  return { kind: 'balance read', by };
}

function scopeIsConsent(state, records) {
  const ids = new Set(state.consentHistory.map((h) => h.record.consentId));
  return records.exchanges.filter((e) => e.accepted).every((e) => ids.has(e.claims.scope));
}

function auditFor(records, agentId, time) {
  if (!agentId || !time) return null;
  return joinAuditRecord(records.audit.entries, { agentId, time }).record;
}

function lastAuditFor(records, agentId, since) {
  const t = Date.parse(since);
  return [...records.audit.entries].reverse().find((e) => e.eventType === 'grant' && e.agentId === agentId && Date.parse(e.timestamp) >= t) ?? null;
}

// Each of the customer's consents as it stands now, from the bank's consent
// history (a withdrawn consent leaves the active set but stays there).
function latestConsents(state, customer) {
  const last = new Map();
  for (const h of state.consentHistory) if (h.record.customer === customer) last.set(h.record.consentId, h.record);
  return [...last.values()].map((r) => ({ agent: agentName(r.agentId), status: r.status }));
}

function passwordResult({ scenario, role, out, before, after }) {
  const rows = after.ledger.slice(before.ledger.length).filter((r) => r.customer === 'A');
  const row = rows[0] ?? null;
  const log = after.accountLog.slice(before.accountLog.length).filter((e) => e.customer === 'A');
  let reason;
  if (row) {
    reason = row.payeeAdded
      ? `Paid from a password session as Customer A, to account ending ${accountEnding(row.payeeAccount)}, a payee added in that session.`
      : 'Paid from a password session as Customer A.';
  } else if (out.answer.step === 'sign in') {
    reason = 'The bank refused the sign in: the password no longer matches.';
  } else {
    reason = `The bank refused the request (status ${out.answer.status}).`;
  }
  return {
    scenario: String(scenario),
    path: 'A',
    attemptedAction: describeAttempt(out.attempted, AGENTS[role].displayName, out.followedHiddenInstruction),
    bankDecision: row ? 'paid' : 'refused',
    reason,
    consentField: null,
    checks: null,
    ledgerRow: row,
    recordRow: log,
    bankSaw: 'Customer A',
    balanceAfter: formatUsd(after.customers.A.balanceCents),
    labels: passwordPathLabels(),
  };
}

function grantResult({ scenario, role, out, before, after, records, since }) {
  const d = after.decisions.slice(before.decisions.length).at(-1) ?? null;
  const row = d && d.ledgerRowId ? after.ledger.find((r) => r.rowId === d.ledgerRowId) : null;
  const presenter = d ? AGENT_ID_BY_DID[d.agentDid] : AGENT_BY_ROLE[role].agentId;
  const record = d ? auditFor(records, presenter, d.time) : lastAuditFor(records, presenter, since);
  let bankDecision = 'refused by the broker';
  if (d) bankDecision = d.decision === 'allowed' ? (d.kind === 'payment' ? 'paid' : 'allowed') : 'refused';
  return {
    scenario: String(scenario),
    path: 'B',
    attemptedAction: describeAttempt(out.attempted, AGENTS[role].displayName, out.followedHiddenInstruction),
    bankDecision,
    reason: d ? d.reason : "The bank's broker refused the grant; no payment request reached the bank.",
    consentField: d ? d.failingField : null,
    checks: d ? d.fields : null,
    ledgerRow: row,
    decisionRow: d,
    recordRow: record,
    bankSaw: agentName(presenter),
    balanceAfter: formatUsd(after.customers.B.balanceCents),
    labels: grantPathLabels(String(scenario), { scopeIsConsent: scopeIsConsent(after, records) }),
  };
}

async function payBoth(ctx, scenario, invoice) {
  const before = await ctx.run.state();
  const since = new Date().toISOString();
  const outA = await ctx.run.agentTask('A', 'billpay', { kind: 'pay-invoice', invoice });
  const outB = await ctx.run.agentTask('B', 'billpay', { kind: 'pay-invoice', invoice });
  const after = await ctx.run.state();
  const records = await ctx.run.records();
  return {
    A: passwordResult({ scenario, role: 'billpay', out: outA, before, after }),
    B: grantResult({ scenario, role: 'billpay', out: outB, before, after, records, since }),
  };
}

const notApplicable = (scenario, pathKey, why) => ({
  scenario: String(scenario),
  path: pathKey,
  attemptedAction: null,
  bankDecision: 'not applicable',
  reason: why,
  consentField: null,
  ledgerRow: null,
  recordRow: null,
  labels: pathKey === 'A' ? passwordPathLabels() : grantPathLabels(String(scenario)),
});

const STEPS = {
  async setup(ctx) {
    await ctx.run.customerSignIn('A');
    await ctx.run.customerSignIn('B');
    // The budget agent's consent to read the balance goes through the same
    // consent API the customer uses for the bill pay agent.
    const budget = await ctx.run.approve('budget');
    // Both budget agents read the balance once, so each holds a working way
    // in before anything changes.
    await ctx.run.agentTask('A', 'budget', { kind: 'read-balance' });
    await ctx.run.agentTask('B', 'budget', { kind: 'read-balance' });
    const st = await ctx.run.state();
    return {
      A: {
        scenario: 'setup',
        path: 'A',
        attemptedAction: { kind: 'setup', by: 'Customer A' },
        bankDecision: 'not applicable',
        reason: "Both agents hold Customer A's username and password; the bank sees Customer A.",
        consentField: null,
        ledgerRow: null,
        recordRow: st.accountLog.filter((e) => e.customer === 'A'),
        bankSaw: 'Customer A',
        balanceAfter: formatUsd(st.customers.A.balanceCents),
        labels: passwordPathLabels(),
      },
      B: {
        scenario: 'setup',
        path: 'B',
        attemptedAction: { kind: 'setup', by: 'Customer B' },
        bankDecision: 'consent approved',
        reason: 'Customer B approved a consent for the budget agent to read the balance; each agent presents its own credential.',
        consentField: null,
        ledgerRow: null,
        recordRow: st.consents.find((c) => c.consentId === budget.consentId),
        bankSaw: 'Budget agent',
        restartSeconds: budget.restartSeconds,
        balanceAfter: formatUsd(st.customers.B.balanceCents),
        labels: grantPathLabels('setup'),
      },
    };
  },

  async approve(ctx) {
    const r = await ctx.run.approve('billpay');
    const st = await ctx.run.state();
    const consent = st.consents.find((c) => c.consentId === r.consentId);
    return {
      A: { ...notApplicable('approve', 'A', "The password path has no consent: both agents already hold Customer A's password."), bankSaw: 'Customer A' },
      B: {
        scenario: 'approve',
        path: 'B',
        attemptedAction: { kind: 'approve consent', by: 'Customer B', agent: 'Bill pay agent' },
        bankDecision: 'consent approved',
        reason: 'Customer B approved the bill pay agent with three payees, per payment and monthly amount limits, and an end date.',
        consentField: null,
        ledgerRow: null,
        recordRow: consent,
        bankSaw: 'Bill pay agent',
        restartSeconds: r.restartSeconds,
        balanceAfter: formatUsd(st.customers.B.balanceCents),
        labels: grantPathLabels('approve'),
      },
    };
  },

  async 1(ctx) {
    const r = await payBoth(ctx, '1', INVOICES.cityWater);
    ctx.scenario1Rows = { A: r.A.ledgerRow?.rowId ?? null, B: r.B.ledgerRow?.rowId ?? null };
    return r;
  },

  2(ctx) {
    return payBoth(ctx, '2', INVOICES.lakesideFake);
  },

  async cross(ctx) {
    const before = await ctx.run.state();
    const since = new Date().toISOString();
    const out = await ctx.run.agentTask('B', 'budget', {
      kind: 'pay-invoice',
      invoice: INVOICES.cityWater,
      present: { grant: `grant://${ctx.run.consents.billpay.grantName}` },
    });
    const after = await ctx.run.state();
    const records = await ctx.run.records();
    return {
      A: notApplicable('cross', 'A', 'On the password path both agents are the customer to the bank, so there is no other agent to tell apart.'),
      B: grantResult({ scenario: 'cross', role: 'budget', out, before, after, records, since }),
    };
  },

  async 3(ctx) {
    const run = ctx.run;
    const beforeA = await run.state();
    const change = await run.customerChangePassword('A');
    const aBill = await run.agentTask('A', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
    const aBudget = await run.agentTask('A', 'budget', { kind: 'read-balance' });
    const aCustomer = await run.customerBalance('A');
    const beforeB = await run.state();
    const since = new Date().toISOString();
    const withdrawal = await run.withdraw('billpay');
    const bBill = await run.agentTask('B', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
    const bBudget = await run.agentTask('B', 'budget', { kind: 'read-balance' });
    const bCustomer = await run.customerBalance('B');
    const after = await run.state();
    const records = await run.records();
    const outcome = (ans, okWord) => {
      if (!ans.refused) return okWord;
      if (ans.step === 'sign in') return 'refused at sign in';
      if (ans.step === 'broker') return 'refused by the broker';
      if (ans.step === 'no session') return 'signed out';
      return ans.status === 401 ? 'signed out' : 'refused';
    };
    return {
      A: {
        scenario: '3',
        path: 'A',
        attemptedAction: { kind: 'password change', by: 'Customer A' },
        bankDecision: change.status === 200 ? 'every session ended' : 'password not changed',
        reason: `Customer A changed the password; the bank ended ${change.sessionsEnded} sessions.`,
        consentField: null,
        effects: [
          { who: 'Bill pay agent', attempted: 'pay City Water $86.40', outcome: outcome(aBill.answer, 'paid') },
          { who: 'Budget agent', attempted: 'read the balance', outcome: outcome(aBudget.answer, 'read the balance') },
          { who: 'Customer A', attempted: 'read the balance', outcome: outcome(aCustomer, 'kept working') },
        ],
        ledgerRow: null,
        recordRow: after.accountLog.slice(beforeA.accountLog.length).filter((e) => e.customer === 'A'),
        bankSaw: 'Customer A',
        balanceAfter: formatUsd(after.customers.A.balanceCents),
        labels: passwordPathLabels(),
      },
      B: {
        scenario: '3',
        path: 'B',
        attemptedAction: { kind: 'withdraw consent', by: 'Customer B', agent: 'Bill pay agent' },
        bankDecision: 'consent withdrawn',
        reason: "Customer B withdrew the consent for the bill pay agent; the bank removed that agent's grant and restarted its broker.",
        consentField: null,
        restartSeconds: withdrawal.restartSeconds,
        effects: [
          { who: 'Bill pay agent', attempted: 'pay City Water $86.40', outcome: outcome(bBill.answer, 'paid') },
          { who: 'Budget agent', attempted: 'read the balance', outcome: outcome(bBudget.answer, 'read the balance') },
          { who: 'Customer B', attempted: 'read the balance', outcome: outcome(bCustomer, 'kept working') },
        ],
        ledgerRow: null,
        decisionRow: after.decisions.slice(beforeB.decisions.length).at(-1) ?? null,
        consentsAfter: latestConsents(after, 'B'),
        recordRow: lastAuditFor(records, AGENT_BY_ROLE.billpay.agentId, since),
        bankSaw: 'Bill pay agent',
        balanceAfter: formatUsd(after.customers.B.balanceCents),
        labels: grantPathLabels('3', { scopeIsConsent: scopeIsConsent(after, records) }),
      },
    };
  },

  async 4(ctx) {
    const a = await ctx.run.dispute(ctx.scenario1Rows.A);
    const b = await ctx.run.dispute(ctx.scenario1Rows.B);
    return {
      A: {
        scenario: '4',
        path: 'A',
        attemptedAction: { kind: 'dispute', by: 'Customer A', payment: `${formatUsd(a.ledgerRow.amountCents)} to ${a.ledgerRow.payeeName}` },
        bankDecision: 'no agent on record',
        reason: 'The bank log shows a sign in with the password, then the payment.',
        consentField: null,
        ledgerRow: a.ledgerRow,
        recordRow: a.accountLog,
        notInLog: a.notInLog,
        agentOnRecord: null,
        labels: passwordPathLabels(),
      },
      B: {
        scenario: '4',
        path: 'B',
        attemptedAction: { kind: 'dispute', by: 'Customer B', payment: `${formatUsd(b.ledgerRow.amountCents)} to ${b.ledgerRow.payeeName}` },
        bankDecision: b.agentOnRecord ? 'agent on record' : 'no agent on record',
        reason: b.agentOnRecord
          ? `The signed broker record names the ${agentName(b.agentOnRecord).toLowerCase()} and its grant; the bank's ledger entry beside it holds the payment and the consent check.`
          : 'The bank could not match a signed broker record to this payment.',
        consentField: null,
        checks: b.consentCheck,
        ledgerRow: b.ledgerRow,
        recordRow: b.brokerRecord,
        agentOnRecord: b.agentOnRecord,
        agentName: b.agentOnRecord ? agentName(b.agentOnRecord) : null,
        grantReference: b.grantReference,
        brokerDecision: b.brokerDecision,
        signatureVerified: b.signatureValid,
        signature: b.signature,
        matchedBy: b.matchedBy,
        consentAsOf: b.consentAsOf,
        otherAttempts: b.otherAttempts,
        labels: grantPathLabels('4'),
      },
    };
  },
};

// The offline check's chain: the four scenarios and the cross agent case,
// in presenter order, on one bank.
export const OFFLINE_CHAIN = Object.freeze(['setup', 'approve', '1', '2', 'cross', '3', '4']);
export const OFFLINE_SCENARIOS = Object.freeze(['1', '2', '3', '4']);

// What the offline check compares between the open run and the blocked
// rerun, per scenario: the outcome, the failing consent field and the agent,
// each read back from the bank's state and records. Never a key, an id or a
// time, which differ per run by design.
export function offlineDecisions(steps) {
  const out = {};
  for (const [step, both] of Object.entries(steps)) {
    const B = both.B;
    if (!B || !['1', '2', 'cross', '3', '4'].includes(step)) continue;
    if (step === '3') {
      out[step] = {
        outcome: B.bankDecision,
        consentField: B.consentField,
        agent: B.bankSaw,
        consents: B.consentsAfter,
        effects: B.effects.map((e) => ({ who: e.who, outcome: e.outcome })),
      };
    } else if (step === '4') {
      out[step] = {
        outcome: B.bankDecision,
        consentField: B.consentField,
        agent: B.agentName,
        brokerDecision: B.brokerDecision,
        signatureVerified: B.signatureVerified,
      };
    } else {
      out[step] = {
        outcome: B.bankDecision,
        consentField: B.consentField,
        agent: B.bankSaw,
        payment: B.ledgerRow ? { payee: B.ledgerRow.payeeName, amountCents: B.ledgerRow.amountCents } : null,
        balanceAfter: B.balanceAfter,
      };
    }
  }
  return out;
}

// Run one named chain on a fresh bank. The caller owns the returned run and
// stops it when it is replaced.
export function runChain(target, runOptions = {}) {
  const chain = CHAINS[target];
  if (!chain) throw new Error(`unknown scenario ${target}`);
  return runSteps(chain, runOptions, String(target));
}

export async function runSteps(chain, runOptions = {}, target = chain.at(-1)) {
  for (const step of chain) if (!Object.hasOwn(STEPS, step)) throw new Error(`unknown step ${step}`);
  const run = await DemoRun.create(runOptions);
  const ctx = { run, scenario1Rows: null };
  const steps = {};
  try {
    for (const step of chain) steps[step] = await STEPS[step](ctx);
  } catch (err) {
    await run.stop();
    throw err;
  }
  return {
    run,
    result: {
      target: String(target),
      runId: run.runId,
      ranAtUtc: new Date().toISOString().replace('T', ' ').slice(0, 19),
      sandbox: run.sandbox,
      steps,
      fictionalLine: FICTIONAL_LINE,
    },
  };
}
