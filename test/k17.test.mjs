// K17 on a broker built the bank's way and on the mutant built without its
// grant resolver. Each broker runs in a cell inside the sandbox profile; the
// two requests come from this process, to that one broker, while it runs.
// The mutant is built in the cell script, never in src.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { K17_TCP_AT_PIN, k17Line, k17Problems, postGrant } from './support/k17.mjs';
import { startSandboxed } from './support/sandboxed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CELLS = path.join(HERE, 'support/broker-cells.mjs');
const PIN = JSON.parse(fs.readFileSync(path.join(HERE, '../vendor/pins.json'), 'utf8')).secretlessAi.commit;

async function grantCell(mode) {
  const cell = await startSandboxed(CELLS, { args: ['grant', mode] });
  try {
    const { socketPath, port, tokenFile } = cell.ready;
    const token = fs.readFileSync(tokenFile, 'utf8').trim();
    return { socket: await postGrant({ socketPath, token }), tcp: await postGrant({ port, token }) };
  } finally {
    await cell.stop();
  }
}

test('K17 on a broker built the bank\'s way: an authenticated POST /grant {} reads 400 on the socket, and on the TCP port the value recorded for this pin', async (t) => {
  const r = await grantCell('bank');
  t.diagnostic(k17Line(r));
  assert.deepEqual(k17Problems(r, PIN), []);
});

test('K17 mutant: the bank\'s broker built with grantResolver: null reads 404 on its socket, and the K17 assertion fails', async (t) => {
  const r = await grantCell('no-grant-resolver');
  t.diagnostic(k17Line(r));
  assert.equal(r.socket, 404);
  assert.notDeepEqual(k17Problems(r, PIN), []);
});

test('K17 rule: a TCP 404 passes together with socket 400 at a pin that records 404, and never alone', () => {
  assert.ok(Number.isInteger(K17_TCP_AT_PIN[PIN]), 'the pinned commit has a recorded TCP value');
  const fixed = { 'pin-that-serves-grants-on-the-socket': 404 };
  assert.deepEqual(k17Problems({ socket: 400, tcp: 404 }, 'pin-that-serves-grants-on-the-socket', fixed), []);
  assert.notDeepEqual(k17Problems({ socket: 404, tcp: 404 }, 'pin-that-serves-grants-on-the-socket', fixed), []);
  assert.notDeepEqual(k17Problems({ socket: null, tcp: 404 }, 'pin-that-serves-grants-on-the-socket', fixed), []);
  assert.notDeepEqual(k17Problems({ socket: 400, tcp: 404 }, PIN), [], 'a TCP 404 at a pin that records 400 is read, not passed');
  assert.notDeepEqual(k17Problems({ socket: 400, tcp: 400 }, 'a-pin-with-no-recorded-value'), []);
});
