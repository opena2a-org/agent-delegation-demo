import './support/outer-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resourceHandler } from '../src/bank/resource.mjs';
import { BankState } from '../src/bank/state.mjs';
import { TokenService } from '../src/bank/token-service.mjs';
import { BILLPAY_CONSENT_TERMS } from '../src/config.mjs';

// The payment API fixtures in conformance/mission, each served by the bank's
// payment API on 127.0.0.1 with the bank's token service holding the access
// token record. The bank gets a consent that allows the fixture's payment,
// so a refusal comes from the Mission rules and an admitted request reaches
// the consent check. A refusal moves no money.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'conformance', 'mission');
const manifest = fs.readFileSync(path.join(DIR, 'MANIFEST.sha256'), 'utf8').trim().split('\n').map((l) => l.split('  ')[1]);
const fixtures = manifest.map((rel) => JSON.parse(fs.readFileSync(path.join(DIR, rel), 'utf8'))).filter((d) => d.request);

async function serve({ verifierState, token, operation }) {
  const clock = Date.parse(verifierState.clockRfc3339);
  const bank = new BankState({ now: () => new Date(clock) });
  const consent = bank.createConsent({
    customerKey: 'B',
    agentId: 'demo_billpay_agent',
    agentDid: token.sub,
    agentRole: 'billpay',
    terms: BILLPAY_CONSENT_TERMS,
    trustClass: 'payment:billpay',
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-mission-'));
  const tokens = new TokenService({
    key: null,
    audience: verifierState.resource,
    verifyPath: null,
    workDir: dir,
    verifierEnv: {},
    jtiFile: path.join(dir, 'jti'),
    now: () => clock,
  });
  const access = crypto.randomBytes(32).toString('hex');
  tokens.issued.set(access, { ...structuredClone(token), scope: consent.consentId });
  const mission = {
    issuer: verifierState.missionIssuer,
    resource: verifierState.resource,
    missions: verifierState.missions === null ? null : new Map(verifierState.missions.map((m) => [m.id, structuredClone(m)])),
    decisions: [],
  };
  const server = http.createServer(resourceHandler(bank, tokens, mission));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${operation.path}`, {
      method: operation.method,
      headers: { authorization: `Bearer ${access}`, ...(operation.body ? { 'content-type': 'application/json' } : {}) },
      body: operation.body ? JSON.stringify(operation.body) : undefined,
    });
    return { status: res.status, challenge: res.headers.get('www-authenticate'), body: await res.json(), bank, mission };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const f of fixtures) {
  const e = f.expected;
  test(`${f.name}: ${e.httpStatus}${e.rejectCategory ? `, ${e.rejectCategory}` : ''}`, async () => {
    const r = await serve({ verifierState: f.verifierState, ...f.request });
    assert.equal(r.status, e.httpStatus, JSON.stringify(r.body));
    assert.equal(r.challenge, e.wwwAuthenticate ?? null);
    assert.equal(r.mission.decisions.length, 1, 'the bank records one Mission decision');
    const d = r.mission.decisions[0];
    if (e.verifyResult === 'ACCEPT') {
      assert.equal(d.decision, 'allowed');
      assert.equal(r.body.status, 'accepted');
      assert.equal(r.bank.ledger.length, 1);
    } else {
      assert.deepEqual(r.body, { status: 'refused' });
      assert.equal(d.decision, 'refused');
      assert.equal(d.category, e.rejectCategory);
      assert.ok(d.reason.includes(e.reasonContains), d.reason);
      assert.equal(r.bank.ledger.length, 0, 'a refusal moves no money');
      assert.equal(r.bank.decisions.length, 0, 'the consent check never ran');
    }
  });
}

const accept = fixtures.find((f) => f.name === 'mission-02/payment-api-accept-within-authority');

test('a token without a mission member is decided by the consent check, as before', async () => {
  const { mission: _, ...token } = accept.request.token;
  const r = await serve({ verifierState: accept.verifierState, token, operation: accept.request.operation });
  assert.equal(r.status, 200);
  assert.equal(r.mission.decisions.length, 0);
  assert.equal(r.bank.decisions.length, 1);
});

test('the Mission rules never widen the consent: a payment the Mission admits and the consent caps is refused by the consent', async () => {
  const token = structuredClone(accept.request.token);
  token.authorization_details[0].constraints.max_amount.amount = '300.00';
  const operation = structuredClone(accept.request.operation);
  operation.body.amount.amount = '300.00';
  const r = await serve({ verifierState: accept.verifierState, token, operation });
  assert.equal(r.mission.decisions[0]?.decision, 'allowed');
  assert.equal(r.status, 403);
  assert.equal(r.challenge, null);
  assert.equal(r.bank.decisions[0].failingField, 'maximumIndividualAmount');
  assert.equal(r.bank.ledger.length, 0);
});
