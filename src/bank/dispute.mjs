// What the bank can show when a customer says "I didn't authorize that
// payment".
//
// Password path: the account log, which shows a sign in with the password
// and then the payment. It holds no agent, credential or consent, because
// the bank never saw one.
//
// Grant path: the bank's ledger row (payee, amount, the bank's consent check
// with each field's result) beside the broker's signed record (agent, grant,
// broker decision). The two are joined by agent ID and time: the broker
// writes its record after the payment API answers, so the ledger row's time
// falls inside [record time minus its latency, record time]. The signature
// chain is verified with the public key the bank captured when its broker
// started, never with the key file beside the log.

const JOIN_SLACK_MS = 5;

export const NOT_IN_PASSWORD_LOG = Object.freeze([
  'which agent acted',
  'an agent credential',
  'a consent or its limits',
  'a record signed by anyone but the bank',
]);

export function passwordPathDispute(state, rowId) {
  const row = state.ledger.find((r) => r.rowId === rowId);
  if (!row || row.path !== 'A') return null;
  // The session's entries up to and including the disputed payment.
  const session = state.accountLog.filter((e) => e.customer === row.customer && e.sessionId === row.sessionId);
  const end = session.findIndex((e) => e.event === 'payment' && e.ledgerRowId === row.rowId);
  const log = end === -1 ? session : session.slice(0, end + 1).filter((e) => e.event !== 'payee added' || e.payeeAccount === row.payeeAccount);
  return {
    path: 'A',
    ledgerRow: row,
    accountLog: log,
    agentOnRecord: null,
    notInLog: [...NOT_IN_PASSWORD_LOG],
  };
}

export function joinAuditRecord(entries, row) {
  const t = Date.parse(row.time);
  const candidates = entries.filter((e) => e.eventType === 'grant'
    && e.result === 'allowed'
    && e.agentId === row.agentId
    && Number.isFinite(e.latencyMs)
    && t >= Date.parse(e.timestamp) - e.latencyMs - JOIN_SLACK_MS
    && t <= Date.parse(e.timestamp) + JOIN_SLACK_MS);
  return candidates.length === 1
    ? { record: candidates[0], index: entries.indexOf(candidates[0]), matchedBy: 'Agent ID and time' }
    : { record: null, index: null, matchedBy: null, candidates: candidates.length };
}

export function grantPathDispute(state, audit, consentAsOf, rowId) {
  const row = state.ledger.find((r) => r.rowId === rowId);
  if (!row || row.path !== 'B') return null;
  const join = joinAuditRecord(audit.entries, row);
  const decision = state.decisions.find((d) => d.decisionId === row.decisionId) ?? null;
  const otherAttempts = state.decisions
    .filter((d) => d.decisionId !== row.decisionId && d.consentId === row.consentId)
    .map((d) => ({ time: d.time, decision: d.decision, failingField: d.failingField, reason: d.reason, attempted: d.attempted }));
  return {
    path: 'B',
    ledgerRow: row,
    consentCheck: decision ? decision.fields : null,
    consentAsOf,
    brokerRecord: join.record,
    brokerRecordIndex: join.index,
    matchedBy: join.matchedBy,
    signature: audit.verification,
    signatureValid: audit.verification.valid === true && audit.keyChanged === false,
    agentOnRecord: join.record ? join.record.agentId : null,
    grantReference: join.record ? join.record.credentialName : null,
    brokerDecision: join.record ? join.record.result : null,
    otherAttempts,
  };
}
