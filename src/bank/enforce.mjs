// The demo bank's own consent check. This is the bank's code and policy, not
// the reference implementation: the broker decides whether an agent may use a
// grant at all, and this check decides whether one operation fits the
// customer's consent record.
//
// Every field is evaluated on every operation and every result is returned.
// The earliest failing field in the order below names the refusal.

import { accountEnding, formatUsd, parseCents, proseDate } from './money.mjs';

export const FIELD_ORDER = Object.freeze([
  'status',
  'agent',
  'permissions',
  'creditorAccounts',
  'maximumIndividualAmount',
  'periodicLimits',
  'validToDateTime',
]);

// The four consent fields the view shows for every payment.
export const CONSENT_FIELDS = Object.freeze(['creditorAccounts', 'maximumIndividualAmount', 'periodicLimits', 'validToDateTime']);

function monthStartUtc(now) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

// Allowed payments under this consent since the start of the current
// calendar month (UTC), in cents.
export function spentThisPeriod(ledger, consentId, now) {
  const from = monthStartUtc(now);
  let total = 0;
  for (const row of ledger) {
    if (row.consentId === consentId && Date.parse(row.time) >= from && Date.parse(row.time) <= now.getTime()) {
      total += row.amountCents;
    }
  }
  return total;
}

export function evaluateConsent({ consent, tokenSub, operation, ledger, now }) {
  const fields = [];
  const push = (field, result, detail) => fields.push({ field, result, detail });

  if (!consent) {
    push('status', 'failed', 'no consent record for this grant');
    for (const f of FIELD_ORDER.slice(1)) push(f, 'not evaluated', 'no consent record');
    return finish(fields, 'status', 'The bank has no consent record for this grant.');
  }

  push('status', consent.status === 'active' ? 'passed' : 'failed', consent.status);
  push('agent', consent.agentDid === tokenSub ? 'passed' : 'failed', 'consent agent equals token subject');

  const terms = consent.terms;
  const need = operation.kind === 'payment' ? 'payment:billpay' : 'balance:read';
  push('permissions', terms.permissions.includes(need) ? 'passed' : 'failed', need);

  if (operation.kind === 'payment') {
    const cents = operation.amountCents;
    push('creditorAccounts', terms.creditorAccounts.includes(operation.creditorAccount) ? 'passed' : 'failed',
      `account ending ${accountEnding(operation.creditorAccount)}`);

    const cap = terms.maximumIndividualAmount;
    const capOk = cap && cap.currency === operation.currency && cents <= parseCents(cap.amount);
    push('maximumIndividualAmount', capOk ? 'passed' : 'failed', cap ? `${formatUsd(cents)} against ${formatUsd(parseCents(cap.amount))}` : 'no amount allowed');

    const limits = terms.periodicLimits ?? [];
    const spent = spentThisPeriod(ledger, consent.consentId, now);
    let periodOk = limits.length > 0;
    for (const l of limits) {
      if (l.periodType !== 'Month' || l.periodAlignment !== 'Calendar' || l.currency !== operation.currency) periodOk = false;
      else if (spent + cents > parseCents(l.amount)) periodOk = false;
    }
    push('periodicLimits', periodOk ? 'passed' : 'failed', `${formatUsd(spent + cents)} this month with this payment`);
  } else {
    for (const f of ['creditorAccounts', 'maximumIndividualAmount', 'periodicLimits']) push(f, 'not applicable', 'not a payment');
  }

  push('validToDateTime', now.getTime() <= Date.parse(terms.validToDateTime) ? 'passed' : 'failed', terms.validToDateTime);

  const failing = FIELD_ORDER.find((f) => fields.find((x) => x.field === f)?.result === 'failed') ?? null;
  return finish(fields, failing, reasonFor(failing, { consent, operation, ledger, now }));
}

function finish(fields, failingField, reason) {
  return { allowed: failingField === null, failingField, fields, reason };
}

// The bank's own words for its decision. They are recorded in the bank's
// ledger and decision log and shown to the customer; they are never sent to
// the agent.
export function reasonFor(field, { consent, operation, ledger, now }) {
  const terms = consent?.terms;
  switch (field) {
    case null:
      return operation.kind === 'payment'
        ? `An approved payee, and ${formatUsd(operation.amountCents)} is inside every limit.`
        : 'The consent allows this agent to read the balance.';
    case 'status':
      return consent ? 'The customer withdrew this consent.' : 'The bank has no consent record for this grant.';
    case 'agent':
      return 'The consent names a different agent from the one that presented this grant.';
    case 'permissions':
      return operation.kind === 'payment' ? 'The consent does not allow this agent to make payments.' : 'The consent does not allow this agent to read the balance.';
    case 'creditorAccounts':
      return `Account ending ${accountEnding(operation.creditorAccount)} isn't an approved payee account.`;
    case 'maximumIndividualAmount':
      if (!terms.maximumIndividualAmount) return 'The consent allows no payment amount.';
      return `${formatUsd(operation.amountCents)} is over the most per payment, ${formatUsd(parseCents(terms.maximumIndividualAmount.amount))}.`;
    case 'periodicLimits': {
      if (!terms.periodicLimits?.length) return 'The consent sets no monthly amount for payments.';
      const total = spentThisPeriod(ledger, consent.consentId, now) + operation.amountCents;
      return `${formatUsd(total)} this month would be over the most per month, ${formatUsd(parseCents(terms.periodicLimits[0].amount))}.`;
    }
    case 'validToDateTime':
      return `The consent ended on ${proseDate(terms.validToDateTime)}.`;
    default:
      return 'The bank refused this operation.';
  }
}
