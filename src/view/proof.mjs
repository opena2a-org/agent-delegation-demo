// What a screen may show. The view computes no value: every copy string that
// states an outcome or carries a value is shown when the bank's result or
// state for the run on screen holds it, and not otherwise, and its fills are
// read from that result. A string the bank does not bear out is replaced by
// null (an empty slot), its name is recorded, and the screen is a mismatch,
// never the copy's outcome. Pure functions: the page and the tests call them.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const COUNT_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

// $4,713.60 from 471360 cents.
export function money(cents) {
  if (!Number.isInteger(cents) || cents < 0) return null;
  const whole = String(Math.floor(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${whole}.${String(cents % 100).padStart(2, '0')}`;
}

// 25000 cents from "250.00".
export function cents(amount) {
  const m = /^(\d+)\.(\d{2})$/.exec(String(amount));
  return m ? Number(m[1]) * 100 + Number(m[2]) : null;
}

// 07:37:04 from 2026-10-24T07:37:04.725Z.
export function hhmmss(iso) {
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(\.\d+)?Z$/.exec(String(iso));
  return m ? m[1] : null;
}

// March 31, 2027 from 2027-03-31T23:59:59Z.
export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(String(iso));
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : null;
}

export const ending = (account) => {
  const m = /(\d{4})$/.exec(String(account));
  return m ? m[1] : null;
};

const screenOf = (copy, id) => copy.SCREENS.find((s) => s.id === id);

class Gate {
  constructor() { this.failed = []; }
  // The text when the bank bears it out, else null and the name recorded.
  show(name, ok, text) {
    if (ok) return text;
    this.failed.push(name);
    return null;
  }
}

// A copy column with the given slots replaced; an outcome the bank does not
// bear out takes no tone.
function column(deck, slots) {
  const out = { ...deck, ...slots };
  if (out.outcome === null) out.tone = 'neutral';
  return out;
}

const eff = (step, who) => (step && Array.isArray(step.effects) ? step.effects.find((e) => e.who === who)?.outcome ?? null : null);
const bankCheck = (step, field) => (step && Array.isArray(step.checks) ? step.checks.find((c) => c.field === field) ?? null : null);
const FOUR = ['creditorAccounts', 'maximumIndividualAmount', 'periodicLimits', 'validToDateTime'];

function checksOf(g, step, deckChecks, side) {
  return deckChecks.map(([field, word]) => [field, g.show(`${side} check ${field}`, bankCheck(step, field)?.result === word, word)]);
}

// Columns before the screen's step has run in the run on screen: no outcome,
// no evidence, the copy's not run words.
export function notRunColumns(copy, id) {
  const s = screenOf(copy, id);
  return s.cols.map((d) => ({
    ...d,
    tone: 'neutral',
    tileLabel: undefined,
    outcome: copy.GLOBAL.notRunOutcome,
    result: id === 'setup' ? null : copy.GLOBAL.notRunResult,
    why: null,
    checks: null,
    checksA: null,
    rows: d.rows ? d.rows.map(([k, , tone]) => [k, null, tone]) : undefined,
    panel: d.panel ? { title: d.panel.title } : undefined,
    log: d.log ? { title: d.log.title, rows: [], missingTitle: d.log.missingTitle, missing: d.log.missing.map(([k]) => [k, null]) } : undefined,
    record: d.record ? {
      signed: { title: d.record.signed.title, rows: d.record.signed.rows.map(([k]) => [k, null]) },
      ledger: { title: d.record.ledger.title, rows: d.record.ledger.rows.map(([k]) => [k, null]) },
    } : undefined,
    values: {},
    notRun: true,
  }));
}

// The step each screen's action runs, in the result of the run on screen.
export const SCREEN_STEP = Object.freeze({ setup: 'approve', s1: '1', s2: '2', s3: '3', s4: '4' });

export function hasStep(result, id) {
  const step = SCREEN_STEP[id];
  return Boolean(result && result.steps && result.steps[step] && result.steps[step].A && result.steps[step].B);
}

function setup(copy, result, state) {
  const s = screenOf(copy, 'setup');
  const [dA, dB] = s.cols;
  const g = new Gate();
  const A = result && result.steps && result.steps.setup ? result.steps.setup.A : null;
  const budget = result && result.steps && result.steps.setup ? result.steps.setup.B : null;
  const B = result && result.steps && result.steps.approve ? result.steps.approve.B : null;
  const signIns = A && Array.isArray(A.recordRow) ? A.recordRow.filter((r) => r.customer === 'A' && r.event === 'sign in' && r.method === 'password').length : 0;
  const custA = state && state.customers ? state.customers.A : null;
  const sawA = A && A.bankSaw === 'Customer A';
  const fieldsA = dA.panel.fields.map(([k, v]) => {
    if (k === 'Username') return [k, g.show('A username', custA && custA.username === v, v)];
    if (k === 'Saved in') return [k, g.show('A saved in', signIns === 2 && v === 'Bill pay agent, Budget agent', v)];
    return [k, v];
  });
  const colA = A ? column(dA, {
    panel: { ...dA.panel, fields: fieldsA },
    outcome: g.show('A outcome', sawA, dA.outcome),
    result: g.show('A result', sawA && signIns === 2, dA.result),
    why: g.show('A why', sawA, dA.why),
    values: {},
  }) : notRunColumns(copy, 'setup')[0];

  const budgetOk = Boolean(budget && budget.recordRow && budget.recordRow.agentId === 'demo_budget_agent' && budget.recordRow.status === 'active'
    && Array.isArray(budget.recordRow.terms?.permissions) && budget.recordRow.terms.permissions.join() === 'balance:read');
  if (!B) {
    const base = notRunColumns(copy, 'setup')[1];
    const colB = { ...base, panel: { title: dB.panel.title, formTitle: dB.panel.formTitle, fields: null, also: budgetOk ? dB.panel.also : null, approve: true } };
    return { cols: [colA, colB], failed: g.failed, done: false };
  }
  const rec = B.recordRow || {};
  const terms = rec.terms || {};
  const payees = state && state.customers && state.customers.B && Array.isArray(state.customers.B.payees) ? state.customers.B.payees : [];
  const names = Array.isArray(terms.creditorAccounts) ? terms.creditorAccounts.map((a) => payees.find((p) => p.account === a)?.name ?? null) : [];
  const usd = (x) => x && x.currency === 'USD' ? money(cents(x.amount)) : null;
  const month = Array.isArray(terms.periodicLimits) && terms.periodicLimits.length === 1 && terms.periodicLimits[0].periodType === 'Month' ? usd(terms.periodicLimits[0]) : null;
  const billpay = rec.agentId === 'demo_billpay_agent' && Array.isArray(terms.permissions) && terms.permissions.join() === 'payment:billpay';
  const approvedAtUtc = rec.status === 'active' && rec.customer === 'B' ? hhmmss(rec.approvedAt) : null;
  const fieldsB = dB.panel.fields.map(([k, v]) => {
    if (k === 'Approved payees') return [k, g.show('B payees', names.length > 0 && !names.includes(null) && names.join(', ') === v, v)];
    if (k === 'Most per payment') return [k, g.show('B per payment', usd(terms.maximumIndividualAmount) === v, v)];
    if (k === 'Most per month') return [k, g.show('B per month', month === v, v)];
    if (k === 'Ends') return [k, g.show('B ends', longDate(terms.validToDateTime) === v, v)];
    if (k === 'Status') return [k, g.show('B status', approvedAtUtc !== null, v)];
    return [k, g.show(`B ${k}`, false, v)];
  });
  const sawB = B.bankSaw === 'Bill pay agent';
  const colB = column(dB, {
    panel: { ...dB.panel, formTitle: g.show('B form', billpay, dB.panel.formTitle), fields: fieldsB, also: g.show('B also', budgetOk, dB.panel.also) },
    outcome: g.show('B outcome', sawB, dB.outcome),
    result: g.show('B result', B.bankDecision === 'consent approved' && rec.status === 'active', dB.result),
    why: g.show('B why', billpay && sawB, dB.why),
    values: { approvedAtUtc },
  });
  return { cols: [colA, colB], failed: g.failed, done: true };
}

function scenario1(copy, result) {
  const s = screenOf(copy, 's1');
  const [dA, dB] = s.cols;
  const g = new Gate();
  const { A, B } = result.steps['1'];
  const task = (x) => x && x.attemptedAction && `Pay the ${x.attemptedAction.payee} bill: ${x.attemptedAction.amount}.`;
  const card = g.show('card', task(A) === s.card.text && task(B) === s.card.text, s.card.text);
  const paidTo = (x) => x && x.ledgerRow ? `${money(x.ledgerRow.amountCents)} to ${x.ledgerRow.payeeName}.` : null;
  const balance = (x) => x && x.ledgerRow ? `${money(x.ledgerRow.balanceAfterCents)}, was ${money(x.ledgerRow.balanceAfterCents + x.ledgerRow.amountCents)}` : null;
  const pwSignIn = Array.isArray(A.recordRow) && A.recordRow.some((r) => r.event === 'sign in' && r.method === 'password');
  const sawA = A.bankSaw === 'Customer A' && A.ledgerRow && A.ledgerRow.channel === 'online banking session';
  const rowsA = dA.rows.map(([k, v]) => {
    if (k === 'Bank saw') return [k, g.show('A bank saw', sawA && pwSignIn && v === 'Customer A, signed in with the password', v)];
    if (k === 'Checked') return [k, g.show('A checked', sawA && pwSignIn && A.checks === null, v)];
    if (k === 'Balance') return [k, g.show('A balance', balance(A) === v && A.balanceAfter === money(A.ledgerRow.balanceAfterCents), v)];
    return [k, g.show(`A ${k}`, false, v)];
  });
  const colA = column(dA, {
    outcome: g.show('A outcome', A.bankDecision === 'paid' && Boolean(A.ledgerRow), dA.outcome),
    result: g.show('A result', paidTo(A) === dA.result, dA.result),
    why: g.show('A why', sawA && pwSignIn, dA.why),
    checksA: g.show('A no limits', A.checks === null, dA.checksA),
    rows: rowsA,
    values: {},
  });
  const four = FOUR.every((f) => bankCheck(B, f)?.result === 'passed');
  const allowed = B.decisionRow && B.decisionRow.decision === 'allowed';
  const sawB = B.bankSaw === 'Bill pay agent' && B.ledgerRow && B.ledgerRow.customer === 'B' && B.ledgerRow.channel === 'agent under consent';
  const rowsB = dB.rows.map(([k, v]) => {
    if (k === 'Bank saw') return [k, g.show('B bank saw', sawB && v === "Bill pay agent, under Customer B's grant", v)];
    if (k === 'Checked') return [k, g.show('B checked', bankCheck(B, 'agent')?.result === 'passed' && FOUR.every((f) => bankCheck(B, f)) && B.recordRow && B.recordRow.result === 'allowed', v)];
    if (k === 'Balance') return [k, g.show('B balance', balance(B) === v && B.balanceAfter === money(B.ledgerRow.balanceAfterCents), v)];
    return [k, g.show(`B ${k}`, false, v)];
  });
  const colB = column(dB, {
    outcome: g.show('B outcome', B.bankDecision === 'paid' && allowed && Boolean(B.ledgerRow), dB.outcome),
    result: g.show('B result', paidTo(B) === dB.result, dB.result),
    why: g.show('B why', allowed && four && B.ledgerRow && `Why: an approved payee, and ${money(B.ledgerRow.amountCents)} is inside every limit.` === dB.why, dB.why),
    checks: checksOf(g, B, dB.checks, 'B'),
    rows: rowsB,
    values: {},
  });
  return { card, cols: [colA, colB], failed: g.failed, done: true };
}

function scenario2(copy, result) {
  const s = screenOf(copy, 's2');
  const [dA, dB] = s.cols;
  const g = new Gate();
  const { A, B } = result.steps['2'];
  const before = result.steps['1'] ? result.steps['1'] : null;
  const task = (x) => x && x.attemptedAction && `Pay the attached ${x.attemptedAction.payee} invoice: ${x.attemptedAction.amount}.`;
  const hidden = (x) => x && x.attemptedAction && x.attemptedAction.scriptedInjectedInstruction ? `"${x.attemptedAction.scriptedInjectedInstruction.text}"` : null;
  const card = {
    text: g.show('card', task(A) === s.card.text && task(B) === s.card.text, s.card.text),
    hiddenText: g.show('card hidden line', hidden(A) === s.card.hiddenText && hidden(B) === s.card.hiddenText, s.card.hiddenText),
  };
  const end = A.ledgerRow ? ending(A.ledgerRow.payeeAccount) : null;
  const paidFake = A.bankDecision === 'paid' && A.attemptedAction && A.attemptedAction.followedHiddenInstruction === true && Boolean(A.ledgerRow);
  const rowsA = dA.rows.map(([k, v]) => {
    if (k === 'Balance') return [k, g.show('A balance', A.ledgerRow && `${money(A.ledgerRow.balanceAfterCents)}, was ${money(A.ledgerRow.balanceAfterCents + A.ledgerRow.amountCents)}` === v, v)];
    if (k === 'Payees') return [k, g.show('A payees', A.ledgerRow && A.ledgerRow.payeeAdded === true && `Account ending ${end} added` === v, v)];
    return [k, g.show(`A ${k}`, false, v)];
  });
  const colA = column(dA, {
    outcome: g.show('A outcome', paidFake, dA.outcome),
    result: g.show('A result', paidFake && A.ledgerRow.payeeAdded === true && `${money(A.ledgerRow.amountCents)} went to account ending ${end}, which the customer never approved.` === dA.result, dA.result),
    why: g.show('A why', A.bankSaw === 'Customer A' && A.checks === null, dA.why),
    checksA: g.show('A no limits', A.checks === null, dA.checksA),
    rows: rowsA,
    values: {},
  });
  const refused = B.bankDecision === 'refused' && B.consentField === 'creditorAccounts' && B.decisionRow && B.decisionRow.decision === 'refused' && B.decisionRow.failingField === 'creditorAccounts';
  const endB = B.decisionRow && B.decisionRow.attempted ? ending(B.decisionRow.attempted.payeeAccount) : null;
  const beforeB = before && before.B ? before.B.balanceAfter : null;
  const rowsB = dB.rows.map(([k, v]) => {
    if (k === 'Balance') return [k, g.show('B balance', B.ledgerRow === null && beforeB !== null && B.balanceAfter === beforeB && `${B.balanceAfter}, unchanged` === v, v)];
    if (k === 'Payees') return [k, g.show('B payees', B.ledgerRow === null && refused, v)];
    return [k, g.show(`B ${k}`, false, v)];
  });
  const colB = column(dB, {
    outcome: g.show('B outcome', refused && B.ledgerRow === null, dB.outcome),
    result: g.show('B result', refused && B.ledgerRow === null && `No money moved. The bank refused the payment to account ending ${endB}.` === dB.result, dB.result),
    why: g.show('B why', refused && `Why: account ending ${endB} isn't an approved payee account.` === dB.why, dB.why),
    checks: checksOf(g, B, dB.checks, 'B'),
    rows: rowsB,
    values: {},
  });
  return { card, cols: [colA, colB], failed: g.failed, done: true };
}

function scenario3(copy, result, labelText) {
  const s = screenOf(copy, 's3');
  const [dA, dB] = s.cols;
  const g = new Gate();
  const { A, B } = result.steps['3'];
  const changed = Array.isArray(A.recordRow) ? A.recordRow.find((r) => r.event === 'password changed') : null;
  const aDone = A.bankDecision === 'every session ended' && changed && changed.customer === 'A' && changed.sessionsEnded >= 1;
  const aStops = eff(A, 'Bill pay agent') === 'refused at sign in' && eff(A, 'Budget agent') === 'refused at sign in' && eff(A, 'Customer A') === 'signed out';
  const rowState = { Stopped: (o) => typeof o === 'string' && o.startsWith('refused'), 'Signed out': (o) => o === 'signed out', Working: (o) => o === 'read the balance', 'Signed in': (o) => o === 'kept working' };
  const rowWho = { A: { 'Bill pay agent': 'Bill pay agent', 'Budget agent': 'Budget agent', Customer: 'Customer A' }, B: { 'Bill pay agent': 'Bill pay agent', 'Budget agent': 'Budget agent', Customer: 'Customer B' } };
  const rows = (side, step, deckRows) => deckRows.map(([k, v, tone]) => [k, g.show(`${side} ${k}`, Boolean(rowState[v] && rowState[v](eff(step, rowWho[side][k]))), v), tone]);
  const colA = column(dA, {
    panel: {
      ...dA.panel,
      action: g.show('A panel action', A.attemptedAction && A.attemptedAction.kind === 'password change' && A.attemptedAction.by === 'Customer A', dA.panel.action),
      done: g.show('A panel done', aDone, dA.panel.done),
    },
    outcome: g.show('A outcome', aDone && aStops, dA.outcome),
    result: g.show('A result', aStops, dA.result),
    why: g.show('A why', A.bankSaw === 'Customer A' && aStops, dA.why),
    rows: rows('A', A, dA.rows),
    values: {},
  });
  const consent = (agent) => Array.isArray(B.consentsAfter) ? B.consentsAfter.find((c) => c.agent === agent)?.status ?? null : null;
  const revoked = B.bankDecision === 'consent withdrawn' && B.attemptedAction && B.attemptedAction.kind === 'withdraw consent' && B.attemptedAction.by === 'Customer B' && B.attemptedAction.agent === 'Bill pay agent' && consent('Bill pay agent') === 'withdrawn';
  const bStops = eff(B, 'Bill pay agent') === 'refused by the broker' && eff(B, 'Budget agent') === 'read the balance' && eff(B, 'Customer B') === 'kept working';
  const restart = typeof B.restartSeconds === 'number' && Number.isFinite(B.restartSeconds) && B.restartSeconds >= 0 ? B.restartSeconds.toFixed(1) : null;
  const l12 = labelText(B, 'L12');
  const l11 = labelText(B, 'L11');
  const colB = column(dB, {
    panel: {
      ...dB.panel,
      action: g.show('B panel action', revoked, dB.panel.action),
      done: g.show('B panel done', consent('Budget agent') === 'active', dB.panel.done),
      status: g.show('B panel status', revoked && l12 !== null, l12),
      statusMeasured: g.show('B restart', revoked && restart !== null, copy.RULED_EXTRA.restartTook),
      note: g.show('B panel note', revoked && l11 !== null, l11),
    },
    outcome: g.show('B outcome', revoked && bStops, dB.outcome),
    result: g.show('B result', bStops, dB.result),
    why: g.show('B why', revoked && consent('Budget agent') === 'active', dB.why),
    rows: rows('B', B, dB.rows),
    values: { restartSeconds: restart },
  });
  return { cols: [colA, colB], failed: g.failed, done: true };
}

function scenario4(copy, result, state) {
  const s = screenOf(copy, 's4');
  const [dA, dB] = s.cols;
  const g = new Gate();
  const { A, B } = result.steps['4'];
  const claim = (x) => {
    const m = x && x.attemptedAction && x.attemptedAction.kind === 'dispute' ? /^(\$[0-9,]+\.\d{2}) to (.+)$/.exec(String(x.attemptedAction.payment)) : null;
    return m ? `"I didn't authorize the ${m[1]} payment to ${m[2]}."` : null;
  };
  const card = g.show('card', claim(A) === s.card.text && claim(B) === s.card.text, s.card.text);
  const signIn = Array.isArray(A.recordRow) ? A.recordRow.find((r) => r.event === 'sign in') : null;
  const pay = Array.isArray(A.recordRow) ? A.recordRow.find((r) => r.event === 'payment') : null;
  const username = state && state.customers && state.customers.A ? state.customers.A.username : null;
  const notIn = Array.isArray(A.notInLog) ? A.notInLog : [];
  const noAgent = Array.isArray(A.recordRow) && A.recordRow.every((r) => !('agentId' in r) && !('agentDid' in r));
  const t1 = signIn ? hhmmss(signIn.time) : null;
  const t2a = pay ? hhmmss(pay.time) : null;
  const logRows = dA.log.rows.map(([t, what, detail]) => {
    if (what === 'Sign in') return [t, what, g.show('A log sign in', signIn && signIn.customer === 'A' && signIn.method === 'password' && `${username}, password` === detail, detail)];
    if (what === 'Payment') return [t, what, g.show('A log payment', pay && A.ledgerRow && pay.ledgerRowId === A.ledgerRow.rowId && `${A.ledgerRow.payeeName}, ${money(pay.amountCents)}` === detail, detail)];
    return [t, what, g.show(`A log ${what}`, false, detail)];
  });
  const missing = dA.log.missing.map(([k, v]) => {
    if (k === 'Agent') return [k, g.show('A not recorded', notIn.includes('which agent acted') && noAgent, v)];
    if (k === 'Customer limits') return [k, g.show('A no limits', notIn.includes('a consent or its limits'), v)];
    if (k === 'Signature') return [k, g.show('A no signature', notIn.includes('a record signed by anyone but the bank'), v)];
    return [k, g.show(`A ${k}`, false, v)];
  });
  const noAgentOnRecord = A.bankDecision === 'no agent on record' && A.agentOnRecord === null;
  const colA = column(dA, {
    outcome: g.show('A outcome', noAgentOnRecord && noAgent, dA.outcome),
    log: { ...dA.log, rows: logRows, missing },
    result: g.show('A result', signIn && pay && signIn.method === 'password' && A.recordRow.indexOf(signIn) < A.recordRow.indexOf(pay), dA.result),
    why: g.show('A why', signIn && signIn.method === 'password' && noAgentOnRecord, dA.why),
    values: { t1, t2: t2a },
  });
  const led = B.ledgerRow;
  const four = led && Array.isArray(led.consentCheck) && FOUR.every((f) => led.consentCheck.find((c) => c.field === f)?.result === 'passed');
  const other = Array.isArray(B.otherAttempts) ? B.otherAttempts.find((o) => o.decision === 'refused') : null;
  const onRecord = B.bankDecision === 'agent on record' && typeof B.agentOnRecord === 'string' && B.agentOnRecord !== '';
  const grant = typeof B.grantReference === 'string' && B.grantReference.startsWith('grant://') && B.recordRow && B.recordRow.credentialName === B.grantReference;
  const t2b = led ? hhmmss(led.time) : null;
  const signed = dB.record.signed.rows.map(([k, v]) => {
    if (k === 'Agent') return [k, g.show('B agent', onRecord && B.agentName === 'Bill pay agent' && B.recordRow && B.recordRow.agentId === B.agentOnRecord, v)];
    if (k === 'Grant reference') return [k, g.show('B grant', grant, v)];
    if (k === 'Broker decision') return [k, g.show('B broker decision', B.brokerDecision === 'allowed' && B.recordRow && B.recordRow.result === 'allowed' && v === 'Allowed', v)];
    if (k === 'Signature') return [k, g.show('B signature', B.signatureVerified === true && B.signature && B.signature.valid === true, v)];
    return [k, g.show(`B ${k}`, false, v)];
  });
  const ledger = dB.record.ledger.rows.map(([k, v]) => {
    if (k === 'Payment') return [k, g.show('B payment', led && `${led.payeeName}, ${money(led.amountCents)}, {t2} UTC` === v, v)];
    if (k === 'Consent check') return [k, g.show('B consent check', four, v)];
    if (k === 'Matched by') return [k, g.show('B matched by', B.matchedBy === 'Agent ID and time' || B.matchedBy === 'Token ID', v)];
    if (k === 'Other attempt') return [k, g.show('B other attempt', other && other.attempted && `${money(other.attempted.amountCents)} to account ending ${ending(other.attempted.payeeAccount)}: blocked` === v, v)];
    return [k, g.show(`B ${k}`, false, v)];
  });
  const colB = column(dB, {
    outcome: g.show('B outcome', onRecord, dB.outcome),
    record: { signed: { ...dB.record.signed, rows: signed }, ledger: { ...dB.record.ledger, rows: ledger } },
    result: g.show('B result', onRecord && grant, dB.result),
    why: g.show('B why', onRecord && led && led.agentId === B.agentOnRecord, dB.why),
    values: { agentId: onRecord ? B.agentOnRecord : null, grantReference: grant ? B.grantReference : null, matchedBy: B.matchedBy, t2: t2b },
  });
  return { card, cols: [colA, colB], failed: g.failed, done: true };
}

// One of the four scenario screens or setup, from the run on screen.
// labelText(step, id) gives a label's words for that step, or null when they
// may not be printed.
export function screenModel(copy, id, { result, state, labelText }) {
  if (id === 'setup') return setup(copy, result, state);
  if (!hasStep(result, id)) return { cols: notRunColumns(copy, id), failed: [], done: false };
  if (id === 's1') return scenario1(copy, result);
  if (id === 's2') return scenario2(copy, result);
  if (id === 's3') return scenario3(copy, result, labelText);
  if (id === 's4') return scenario4(copy, result, state);
  throw new Error(`no model for ${id}`);
}

// The summary's one cell that carries values: what Customer B allowed the
// bill pay agent, as the bank recorded it when the consent was approved (a
// consent withdrawn in scenario 3 leaves the bank's list of consents and
// stays in its history).
export function summaryModel(copy, state) {
  const s = screenOf(copy, 'summary');
  const g = new Gate();
  const approved = state && Array.isArray(state.consentHistory)
    ? [...state.consentHistory].reverse().find((h) => h.event === 'approved' && h.record && h.record.agentId === 'demo_billpay_agent')
    : null;
  const consent = approved ? approved.record : null;
  const t = consent ? consent.terms || {} : {};
  const n = Array.isArray(t.creditorAccounts) ? t.creditorAccounts.length : -1;
  const usd = (x) => x && x.currency === 'USD' ? money(cents(x.amount)) : null;
  const month = Array.isArray(t.periodicLimits) && t.periodicLimits.length === 1 && t.periodicLimits[0].periodType === 'Month' ? usd(t.periodicLimits[0]) : null;
  const allowed = consent ? `${COUNT_WORDS[n] ?? ''} payees, ${usd(t.maximumIndividualAmount)} a payment, ${month} a month, until ${longDate(t.validToDateTime)}` : null;
  const rows = s.table.rows.map(([need, a, b]) => {
    if (need === 'Know what the customer allowed') return [need, a, g.show('summary allowed', allowed === b, b)];
    return [need, a, b];
  });
  return { rows, failed: g.failed, done: g.failed.length === 0 };
}
