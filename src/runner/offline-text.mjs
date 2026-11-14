// A result of the offline check in plain words: the three control rows, then
// the four outcomes side by side, then the count. The text runner does not
// print it: the check is started by the view server's Run and nothing else.
// A count that was not measured is never printed as a number, and names its
// reason.
// A check that was not run prints its outcome, the reason and what the check
// needs, and no number.
// The sentence on the decisions, the row labels and the counts print when
// both runs returned a decision for each of the four scenarios, and a missing
// decision is never different.
// The row labels, the sentence on the decisions and the words for no decision
// are the copy file's, the strings the offline screen shows.

import { COPY } from '../scenarios/labels.mjs';
import { fourOnBothSides, hasDecision } from '../view/offline-compare.mjs';
import { sideBySide } from './columns.mjs';

const OFFLINE = COPY.SCREENS.find((screen) => screen.id === 'offline');
const WORDS = COPY.RULED_EXTRA;
const SCENARIO_NAMES = Object.fromEntries(OFFLINE.cols[0].rows.map(([name]) => [name.split(' ')[0], name]));
// The opening sentence of a result line on the screen, where the view splits it.
const opening = (line) => line.slice(0, line.indexOf('. ') + 1);
const MATCHED = opening(OFFLINE.cols[1].result);
const NOT_MATCHED = opening(OFFLINE.states.differs.result);

function decisionWords(d) {
  if (!hasDecision(d)) return WORDS.offlineNoDecision;
  const parts = [d.outcome];
  if (d.consentField) parts.push(`field ${d.consentField}`);
  if (d.agent) parts.push(d.agent);
  if (d.effects) parts.push(d.effects.map((e) => `${e.who}: ${e.outcome}`).join('; '));
  return parts.join(', ');
}

export function offlineBlock(r) {
  const out = [];
  if (r.status === 'not run') {
    out.push(`${OFFLINE.label}: ${WORDS.offlineNotRun}`);
    out.push(`  ${WORDS.offlineNotRunResult.replace('{reason}', r.reason)}`);
    out.push(`  ${WORDS.offlineNotRunNeeds[r.reason]}`);
    return out.join('\n');
  }
  out.push(`${OFFLINE.label} (run ${r.runId.slice(0, 4)}, ${r.platform}, sandbox profile sha256 ${r.profileSha256.slice(0, 16)})`);
  // A rerun that stopped before it answered made no control inside the block.
  if (r.controls.length) out.push('  Controls, each made outside the block and then inside it:');
  for (const c of r.controls) out.push(`    ${c.control}${c.interface ? ` (interface ${c.interface})` : ''}: ${c.outside}, ${c.inside}.`);
  const compared = fourOnBothSides(r.outcomes);
  const rows = r.outcomes.map((o) => [
    `${SCENARIO_NAMES[o.scenario] ?? o.scenario}: ${decisionWords(o.open)}.`,
    `${decisionWords(o.blocked)}${compared ? (o.same ? OFFLINE.rowSame : OFFLINE.rowDifferent) : ''}.`,
  ]);
  out.push(sideBySide(rows, [OFFLINE.cols[0].title, OFFLINE.cols[1].title]));
  if (r.decision2) out.push(`  Control connection to ${r.decision2.target}: ${r.decision2.inside}, counted ${r.decision2.lines === 1 ? 'once' : `${r.decision2.lines} times`}.`);
  const result = [];
  if (compared) result.push(r.outcomes.every((o) => o.same === true) ? MATCHED : NOT_MATCHED);
  if (r.status !== 'measured') result.push(WORDS.offlineNotMeasured.replace('{reason}', r.reason));
  else if (compared) result.push(`Outbound connection attempts: ${r.egressAttempts}.`);
  if (result.length) out.push(`  ${result.join(' ')}`);
  if (r.openRun && compared) {
    const e = r.openRun.egress;
    out.push(`  The run as usual, ${e.scope}: outbound connection attempts: ${e.status === 'measured' ? e.egressAttempts : `not measured (${e.reason})`}.`);
  }
  return out.join('\n');
}
