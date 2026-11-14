// The re-pin arms on the pinned verifier, run inside the sandbox profile by
// test/aap-verifier-arms.test.mjs. Each arm is one input file run as the bank
// runs it (node verify.mjs <file>), with real broker tokens from the reference
// implementation and a broker key made here. Prints one JSON line: per arm,
// the exit status, the lines that begin with "observed:", the summary line,
// and what the bank's input check and accept rule say. No token is printed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LocalAtxVerifier } from '@opena2a/atx-verify';
import { loadTrust, makeSigningKey } from '../../src/bank/broker.mjs';
import { acceptRule, inputIsSound, runVerifier, verifierInput } from '../../src/bank/verifier.mjs';
import { childEnv } from '../../src/orchestrator/env.mjs';
import { headerMemberToken } from './header-injection.mjs';

const require = createRequire(import.meta.url);
const broker = require('secretless-ai/dist/broker/index.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = process.argv[2];
const pins = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/pins.json'), 'utf8'));
const verifyPath = path.join(ROOT, pins.aapConformance.vendoredPath);
const env = childEnv({ home: path.join(work, 'home') });

const trust = loadTrust(path.join(ROOT, 'fixtures/issuer/trust.json'));
const ctx = new LocalAtxVerifier(trust).verify(JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures/agents/billpay-agent.atx.json'), 'utf8'))).context;
const signing = makeSigningKey();
const key = { kid: signing.kid, publicJwk: signing.publicJwk };
const binding = { mode: 'exchange', providerId: 'bank-token-service', scope: `cns_${'0'.repeat(24)}`, audience: 'http://127.0.0.1:9', ttlSeconds: 60, trustClass: 'payment:billpay' };
const now = Math.floor(Date.now() / 1000);
const fresh = broker.mintBrokerAssertion(ctx, binding, signing.key, now);
// Issued an hour ago with a 60 second lifetime: expired at the bank's clock.
const stale = broker.mintBrokerAssertion(ctx, binding, signing.key, now - 3600);
const flip = (token) => {
  const [h, p, s] = token.split('.');
  return `${h}.${p}.${s.slice(0, 5)}${s[5] === 'A' ? 'B' : 'A'}${s.slice(6)}`;
};
const input = (token) => verifierInput({ token, nowSeconds: now, key });
const without = (o, k) => Object.fromEntries(Object.entries(o).filter(([name]) => name !== k));

const ARMS = {
  v1: input(fresh),
  v2: input(flip(fresh)),
  v3: without(input(flip(fresh)), 'expected'),
  v4: { ...input(flip(fresh)), expected: { verifyResult: 'ACCEPTED' } },
  v5a: { ...input(stale), verifierState: without(input(stale).verifierState, 'clockNumericDate') },
  v5b: input(stale),
  G: without(input(headerMemberToken(fresh, signing)), 'expected'),
};

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(verifyPath)).digest('hex');
const out = { pinnedCommit: pins.aapConformance.commit, vendoredSha256Matches: sha256 === pins.aapConformance.sha256, arms: {} };
const dir = path.join(work, 'arms');
fs.mkdirSync(dir, { mode: 0o700 });
for (const [name, doc] of Object.entries(ARMS)) {
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
  const run = await runVerifier({ verifyPath, inputFile: file, cwd: work, env });
  const lines = (run.stdout ?? '').split('\n').map((l) => l.trim());
  out.arms[name] = {
    exitCode: run.exitCode,
    observed: lines.filter((l) => l.startsWith('observed:')),
    summary: lines.find((l) => l.startsWith('summary:')) ?? null,
    inputSound: inputIsSound(doc, { nowSeconds: now, key }),
    accepted: acceptRule(run),
  };
}
process.stdout.write(`${JSON.stringify(out)}\n`);
