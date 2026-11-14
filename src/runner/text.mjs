// npm run scenarios: every scenario on both paths, printed side by side in
// plain words. The full sequence runs on one bank; the cross agent case runs
// on its own chain. Every value is read from the bank's state and records.
// The offline check is not run here; the view server's Run starts it.
//
// The platform and the probe run before anything else, with the launcher's
// lines. Then the Node.js version, an inherited NODE_OPTIONS and the
// dependencies are checked, in the launcher's order, by the start checks'
// functions the launcher calls too, and the demo's other modules load after
// all of them. This process starts no view
// server and reads no port or argument, so the launcher's port and argument
// checks have nothing to check here.

import { dependencyLines, firstChecks, nodeOptionsLines, nodeVersionLines, notAppliedLines } from '../start/checks.mjs';

const checked = firstChecks();
if (checked.refusal) {
  for (const l of checked.refusal) process.stdout.write(`${l}\n`);
  process.exit(1);
}
const refused = nodeVersionLines() ?? nodeOptionsLines('npm run scenarios') ?? dependencyLines();
if (refused) {
  for (const l of refused) process.stdout.write(`${l}\n`);
  process.exit(1);
}
const { STEP_TITLES, runChain } = await import('../scenarios/engine.mjs');
const { FICTIONAL_LINE } = await import('../scenarios/labels.mjs');
const { INVOICES } = await import('../config.mjs');
const { sideBySide } = await import('./columns.mjs');

function attempted(r) {
  const a = r.attemptedAction;
  if (!a) return 'Nothing attempted.';
  if (a.kind === 'payment') {
    const injected = a.followedHiddenInstruction ? ' It followed the scripted injected instruction hidden in the invoice.' : '';
    return `${a.by} tried to pay ${a.payee} ${a.amount} to account ending ${a.payeeAccountEnding}.${injected}`;
  }
  if (a.kind === 'password change') return `${a.by} changed the password.`;
  if (a.kind === 'withdraw consent') return `${a.by} revoked ${a.agent}.`;
  if (a.kind === 'approve consent') return `${a.by} approved ${a.agent}.`;
  if (a.kind === 'dispute') return `${a.by} disputed ${a.payment}.`;
  if (a.kind === 'setup') return `${a.by} set up the agents.`;
  return `${a.by}: ${a.kind}.`;
}

function ledger(r) {
  if (!r.ledgerRow) return 'Ledger: no new row.';
  const row = r.ledgerRow;
  return `Ledger: ${row.payeeName ?? 'payee'}, account ending ${row.payeeAccount.slice(-4)}, ${row.channel}${row.agentId ? `, agent ${row.agentId}` : ''}.`;
}

function record(r) {
  if (r.path === 'A') {
    if (Array.isArray(r.recordRow) && r.recordRow.length) return `Account log: ${r.recordRow.map((e) => (e.method ? `${e.event} (${e.method})` : e.event)).join(', ')}.`;
    return 'Account log: nothing new.';
  }
  const rec = r.recordRow;
  if (!rec) return 'Broker record: none for this step.';
  if (rec.consentId) return `Consent record: ${rec.agentId}, status ${rec.status}.`;
  return `Broker record: ${rec.agentId}, ${rec.credentialName.slice(0, 16)}..., broker decision ${rec.result}.`;
}

function checks(r) {
  if (!r.checks) return null;
  const four = r.checks.filter((c) => ['creditorAccounts', 'maximumIndividualAmount', 'periodicLimits', 'validToDateTime'].includes(c.field));
  return `Consent check: ${four.map((c) => `${c.field} ${c.result}`).join(', ')}.`;
}

function labels(r) {
  const shown = r.labels.filter((l) => l.printable).map((l) => (l.id === 'noteA' ? 'Path A note' : l.id));
  const notShown = r.labels.filter((l) => !l.printable).map((l) => `${l.id} (${l.status.toLowerCase()})`);
  return `Labels: ${[...shown, ...notShown].join(', ')}.`;
}

function block(step, r) {
  const A = r.A;
  const B = r.B;
  const rows = [
    [attempted(A), attempted(B)],
    [`Bank decision: ${A.bankDecision}.`, `Bank decision: ${B.bankDecision}.${B.consentField ? ` Field: ${B.consentField}.` : ''}`],
    [A.reason, B.reason],
  ];
  if (A.effects || B.effects) {
    rows.push([
      (A.effects ?? []).map((e) => `${e.who}: ${e.outcome}.`).join(' '),
      (B.effects ?? []).map((e) => `${e.who}: ${e.outcome}.`).join(' ') + (B.restartSeconds !== undefined ? ` Broker restart ${B.restartSeconds.toFixed(1)} s.` : ''),
    ]);
  }
  if (step === '4') {
    rows.push([
      `Not in the log: ${A.notInLog.join('; ')}.`,
      `Agent on record: ${B.agentName ?? 'none'}. Grant: ${B.grantReference ? `${B.grantReference.slice(0, 16)}...` : 'none'}. Broker decision: ${B.brokerDecision}. Signature: ${B.signatureVerified ? 'verified with the key the bank captured' : 'not verified'}. Matched by ${B.matchedBy}. Other attempts under this consent: ${B.otherAttempts.length}.`,
    ]);
  }
  const ck = checks(B);
  if (ck) rows.push(['Consent check: none on this path.', ck]);
  if (A.balanceAfter || B.balanceAfter) rows.push([`Balance: ${A.balanceAfter ?? 'unchanged'}.`, `Balance: ${B.balanceAfter ?? 'unchanged'}.`]);
  rows.push([ledger(A), ledger(B)]);
  rows.push([record(A), record(B)]);
  rows.push([labels(A), labels(B)]);
  return `${STEP_TITLES[step]}\n${sideBySide(rows)}`;
}

async function main() {
  const out = [];
  out.push('Agent banking delegation demo: the scenarios on both paths');
  out.push(FICTIONAL_LINE);
  out.push(`Same input on both paths. Invoices: ${INVOICES.cityWater.invoiceId} (City Water, $86.40) and ${INVOICES.lakesideFake.invoiceId} (Lakeside Internet, $240.00, with a scripted injected instruction).`);
  const full = await runChain('all');
  try {
    out.push(`Run ${full.result.runId.slice(0, 4)}, ${full.result.ranAtUtc} UTC. Sandbox profiles: ${full.result.sandbox.applied ? 'applied' : `not applied (${full.result.sandbox.reason})`}.`);
    out.push('');
    for (const step of ['setup', 'approve', '1', '2', '3', '4']) {
      out.push(block(step, full.result.steps[step]));
      out.push('');
    }
  } finally {
    await full.run.stop();
  }
  const cross = await runChain('cross');
  try {
    out.push(`(Separate run ${cross.result.runId.slice(0, 4)}: setup, approve, scenarios 1 and 2, then this step.)`);
    out.push(block('cross', cross.result.steps.cross));
  } finally {
    await cross.run.stop();
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

main().catch((err) => {
  // A component whose profile was not applied: the launcher's lines.
  const lines = notAppliedLines(err);
  if (lines) {
    for (const l of lines) process.stdout.write(`${l}\n`);
    process.exit(1);
  }
  process.stderr.write(`The scenarios did not complete: ${err.message}\n`);
  process.exit(1);
});
