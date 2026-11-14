// The loopback API the web view calls.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ViewServer } from '../src/server/main.mjs';
import { freeLoopbackPort } from '../src/orchestrator/ports.mjs';

let view;
let port;
const bodies = [];

async function call(method, route, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  bodies.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

function rawPost(route, headers, body = '{}') {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

before(async () => {
  port = await freeLoopbackPort();
  view = new ViewServer({ port });
  await view.listen();
});
after(async () => { await view.stop(); });

test('run one scenario: a structured result per path, read from the bank', async () => {
  const r = await call('POST', '/api/run', { scenario: '1' });
  assert.equal(r.status, 200);
  const { A, B } = r.json.steps['1'];
  for (const x of [A, B]) {
    for (const k of ['scenario', 'path', 'attemptedAction', 'bankDecision', 'reason', 'consentField', 'ledgerRow', 'recordRow', 'labels']) assert.ok(k in x, k);
  }
  assert.equal(r.json.fictionalLine, 'Every customer, account, payee and payment in this demo is fictional.');
  const st = await call('GET', '/api/state');
  assert.equal(st.json.runId, r.json.runId);
  assert.equal(st.json.state.ledger.length, 2);
});

test('one path at a time', async () => {
  const r = await call('POST', '/api/run', { scenario: '1', path: 'B' });
  assert.deepEqual(Object.keys(r.json.steps['1']), ['B']);
});

test('a double click runs once: two identical requests share one bank run and add no rows', async () => {
  const [a, b] = await Promise.all([call('POST', '/api/run', { scenario: '2' }), call('POST', '/api/run', { scenario: '2' })]);
  assert.equal(a.json.runId, b.json.runId);
  const st = await call('GET', '/api/state');
  assert.equal(st.json.state.ledger.filter((r) => r.customer === 'A').length, 2);
  assert.equal(st.json.state.ledger.filter((r) => r.customer === 'B').length, 1);
});

test('records: the broker log with its verification under the captured key; no token string', async () => {
  const r = await call('GET', '/api/records');
  assert.equal(r.status, 200);
  assert.equal(r.json.audit.verification.valid, true);
  assert.ok(r.json.exchanges.length > 0);
  assert.equal(/eyJ[A-Za-z0-9_-]+\./.test(r.text), false);
});

test('copy: the deck, its fills and the bearer credential label in its set words', async () => {
  const r = await call('GET', '/api/copy');
  assert.equal(r.json.copy.LABELS.L10, 'Bearer credential: a copy with the grant name is accepted as this agent. Proof of possession is specified in AAP, not yet in the reference implementation.');
  assert.match(r.json.fills.verifierSha12, /^[0-9a-f]{12}$/);
});

test('refusals: an unknown scenario, a foreign Origin, a foreign Host', async () => {
  assert.equal((await call('POST', '/api/run', { scenario: 'nope' })).status, 400);
  assert.equal(await rawPost('/api/run', { Origin: 'http://rebind.example' }, '{"scenario":"1"}'), 403);
  assert.equal(await rawPost('/api/run', { Host: 'rebind.example' }, '{"scenario":"1"}'), 403);
});

test('offline check: POST runs it, the three control rows, then the four outcomes; GET returns the last one; a foreign Origin is refused; the current run is untouched', async () => {
  const runId = view.current.run.runId;
  const r = await call('POST', '/api/offline');
  assert.equal(r.status, 200);
  const keys = Object.keys(r.json);
  assert.ok(keys.indexOf('controls') < keys.indexOf('outcomes'));
  assert.equal(r.json.controls.length, 3);
  assert.deepEqual(r.json.outcomes.map((o) => o.scenario), ['1', '2', '3', '4']);
  assert.equal(r.json.status, 'measured', 'precondition: /usr/bin/sandbox-exec (macOS)');
  assert.equal(r.json.egressAttempts, 0);
  assert.ok(r.json.labels.some((l) => l.id === 'L7'));
  assert.equal(r.json.fictionalLine, 'Every customer, account, payee and payment in this demo is fictional.');
  const again = await call('GET', '/api/offline');
  assert.equal(again.json.runId, r.json.runId);
  assert.equal(await rawPost('/api/offline', { Origin: 'http://rebind.example' }), 403);
  assert.equal(view.current.run.runId, runId);
});

test('an unknown route answers a not found page with a link to the start, and no stack trace', async () => {
  const r = await call('GET', '/no/such/page');
  assert.equal(r.status, 404);
  assert.match(r.text, /href="\/"/);
  assert.equal(/\n\s+at |Error:/.test(r.text), false);
});

test('no response carries a private key, the broker token or a password', async () => {
  const run = view.current.run;
  const token = fs.readFileSync(path.join(run.dirs.bank, 'broker.token'), 'utf8').trim();
  for (const t of bodies) {
    assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t), false);
    assert.equal(t.includes(token), false);
    for (const p of Object.values(run.passwords)) assert.equal(t.includes(p), false);
  }
});

test('a component that stops while the demo runs is reported with its log', async () => {
  const run = view.current.run;
  const seen = new Promise((resolve) => { view.onComponentExit = resolve; });
  run.bank.child.kill('SIGKILL');
  const ev = await seen;
  view.onComponentExit = null;
  assert.equal(ev.name, 'bank');
  assert.ok(ev.log.endsWith('stderr.log'));
});
