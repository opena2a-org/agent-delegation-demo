// Seeded control for the by-value check of test/path-b.test.mjs. Run alone it
// must fail:
//
//   node --test test/controls/seeded-broker-token-in-agent-log.mjs
//
// test/seeded-control.test.mjs runs it and requires every arm to fail. It is
// outside the test script's file pattern, so npm test passes with it in place.
//
// One grant path run. Then a fixture writes a value the bank made into one of
// the bill pay agent's own files and applies the check unchanged: arm 1 writes
// the broker token into the agent's log, arm 2 writes an access token the
// token service issued into its stderr.log. An arm that passes means the check
// does not read that file. Each arm puts the file back as it found it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { INVOICES } from '../../src/config.mjs';
import { agentFiles, assertNoTokenOutsideBrokerTokenCopy, witnessedRun } from '../support/emitted.mjs';

let run;
let witness;
let answers;

before(async () => {
  run = await witnessedRun();
  assert.equal(await run.customerSignIn('B'), true);
  await run.approve('billpay');
  const paid = await run.agentTask('B', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
  answers = [{ where: 'answer s1', text: JSON.stringify(paid) }];
  witness = await run.pathBOp({ name: 'witness' });
});

after(async () => {
  if (run) await run.stop();
});

// Write the line into the file, apply the check, put the file back.
function seeded(file, line) {
  const original = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(file, line);
  try {
    const reports = Object.entries(run.reports).map(([name, text]) => ({ where: `${name} stdout`, text }));
    assertNoTokenOutsideBrokerTokenCopy({ files: agentFiles(run), answers: [...answers, ...reports], witness });
  } finally {
    fs.writeFileSync(file, original);
  }
}

test('arm 1: the broker token written into the bill pay agent\'s agent.log', () => {
  const file = path.join(run.agentDir('B', 'billpay'), 'agent.log');
  seeded(file, `${JSON.stringify({ time: new Date().toISOString(), event: 'seeded', authorization: `Bearer ${witness.brokerTokens.at(-1)}` })}\n`);
});

test('arm 2: an access token the token service issued written into the bill pay agent\'s stderr.log', () => {
  assert.ok(witness.accessTokens.length >= 1, 'precondition: the run issued an access token');
  const file = path.join(run.agentDir('B', 'billpay'), 'stderr.log');
  seeded(file, `seeded ${witness.accessTokens.at(-1)}\n`);
});
