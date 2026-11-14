// A stand in for the offline check's rerun root process. A stand in for
// sandbox-exec starts it in its own place, so it keeps sandbox-exec's pid,
// with the egress counter loaded or without it. It answers ready, then, by
// the word it is started with:
//   ends              ends when asked for the rerun, with no answer;
//   no-decisions      answers the rerun with no decisions, as the rerun does
//                     when its scenarios did not complete;
//   three-decisions   answers with a decision for scenarios 1 to 3 and an
//                     error record in place of the decision for scenario 4;
//   error-with-decisions
//                     answers with a decision for scenarios 1 to 4 and for
//                     the cross case, and the error the rerun reports when
//                     its scenarios did not complete;
//   no-cross          answers with a decision for scenarios 1 to 4, none for
//                     the cross case, and no error;
//   five-decisions    answers with a decision for scenarios 1 to 4 and for
//                     the cross case, and no error.
// Each answer has both control connections refused and counted once, and the
// two deny form controls refused. It makes no connection: it writes the two
// lines the counter writes for them.

import fs from 'node:fs';
import { serve } from '../../../src/orchestrator/channel.mjs';

const mode = process.argv[2];

function counted(file, host) {
  fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), pid: process.pid, ppid: process.ppid, thread: 0, fn: 'net.Socket.connect', kind: 'tcp', host, port: 9 })}\n`);
}

const paid = { outcome: 'paid', consentField: null, agent: 'Bill pay agent', payment: null, balanceAfter: null };
// A decision for each of the four scenarios, and one for the cross case.
const FOUR = { 1: paid, 2: { ...paid, outcome: 'refused', consentField: 'creditorAccounts' }, 3: { ...paid, outcome: 'consent withdrawn' }, 4: { ...paid, outcome: 'refused' } };
const CROSS = { ...paid, outcome: 'refused' };

serve({
  ready() {
    return { pid: process.pid };
  },

  rerun(params) {
    if (mode === 'ends') process.exit(0);
    counted(params.egressLog, '192.0.2.1');
    if (params.ownAddress) counted(params.egressLog, params.ownAddress);
    const decisions = mode === 'three-decisions'
      ? { 1: paid, 2: { ...paid, outcome: 'refused', consentField: 'creditorAccounts' }, 3: { ...paid, outcome: 'consent withdrawn' }, 4: { error: 'the scenario did not complete' } }
      : mode === 'error-with-decisions' ? { ...FOUR, cross: CROSS }
      : mode === 'no-cross' ? FOUR
      : mode === 'five-decisions' ? { ...FOUR, cross: CROSS }
      : null;
    return {
      pid: process.pid,
      sentinel: { outcome: 'EPERM' },
      exec: { outcome: 'EPERM' },
      decisions,
      extra: [],
      decision2: { outcome: 'EPERM', ms: 1 },
      decision3: params.ownAddress ? { outcome: 'EPERM', ms: 1 } : null,
      error: mode === 'error-with-decisions' || !decisions ? 'the scenarios did not complete' : null,
    };
  },

  stop() {
    return { stopped: true };
  },
});
