// Token service cells, run inside the sandbox profile by token-service.test.mjs.
// Prints one JSON line with every cell's observation.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { LocalAtxVerifier } from '@opena2a/atx-verify';
import { BROKER_ISSUER, loadTrust, makeSigningKey } from '../../src/bank/broker.mjs';
import { TokenService } from '../../src/bank/token-service.mjs';
import { acceptRule, inputIsSound, runVerifier, verifierInput } from '../../src/bank/verifier.mjs';
import { childEnv } from '../../src/orchestrator/env.mjs';

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
const otherKid = broker.generateBrokerSigningKey(BROKER_ISSUER, 'some-other-key');
const audience = 'http://127.0.0.1:9';
const scope = `cns_${'0'.repeat(24)}`;
const binding = { mode: 'exchange', providerId: 'bank-token-service', scope, audience, ttlSeconds: 60, trustClass: 'payment:billpay' };
const nowSeconds = Math.floor(Date.now() / 1000);
const mint = (key = signing.key, at = nowSeconds) => broker.mintBrokerAssertion(ctx, binding, key, at);
const jtiFile = path.join(work, 'jti-seen.txt');
const workDir = path.join(work, 'verifier');
fs.mkdirSync(workDir, { mode: 0o700 });
const service = (extra = {}) => new TokenService({ key: { kid: signing.kid, publicJwk: signing.publicJwk }, audience, verifyPath, workDir, verifierEnv: env, jtiFile, ...extra });
const form = (token) => new URLSearchParams({
  grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
  subject_token: token,
  subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
  scope,
  audience,
});
const flip = (token) => {
  const [h, p, s] = token.split('.');
  const c = s[5] === 'A' ? 'B' : 'A';
  return `${h}.${p}.${s.slice(0, 5)}${c}${s.slice(6)}`;
};

const out = {};
const ts = service();
const valid = mint();
out.valid = (await ts.exchange(form(valid))) !== null;
out.forgedSignature = (await ts.exchange(form(flip(mint())))) !== null;
out.expired = (await ts.exchange(form(mint(signing.key, nowSeconds - 3600)))) !== null;
out.unknownKid = (await ts.exchange(form(mint(otherKid)))) !== null;
out.replay = (await ts.exchange(form(valid))) !== null;
const restarted = service();
out.replayAfterRestart = (await restarted.exchange(form(valid))) !== null;
out.exchangeCodes = [...ts.evidence(), ...restarted.evidence()].map((e) => e.code);

// Refusals with no accepting twin above, each from an input that violates one
// clause of the exchange. They run on services of their own, so the codes
// above stay as they are. Each token is minted at the current second.
const second = () => Math.floor(Date.now() / 1000);
const withField = (token, changes) => {
  const p = form(token);
  for (const [k, v] of Object.entries(changes)) p.set(k, v);
  return p;
};
const shape = service();
const shaped = mint(signing.key, second());
out.wrongGrantType = (await shape.exchange(withField(shaped, { grant_type: 'authorization_code' }))) !== null;
out.wrongSubjectTokenType = (await shape.exchange(withField(shaped, { subject_token_type: 'urn:ietf:params:oauth:token-type:access_token' }))) !== null;
out.wrongRequestedTokenType = (await shape.exchange(withField(shaped, { requested_token_type: 'urn:ietf:params:oauth:token-type:id_token' }))) !== null;
// A request shape refusal comes before the verifier and burns no jti: the
// same token is accepted once the request is well formed.
out.shapedTokenAcceptedAfter = (await shape.exchange(form(shaped))) !== null;
const otherAudience = 'http://127.0.0.1:10';
const otherScope = `cns_${'1'.repeat(24)}`;
out.claimsAudMismatch = (await shape.exchange(form(broker.mintBrokerAssertion(ctx, { ...binding, audience: otherAudience }, signing.key, second())))) !== null;
out.audienceParamMismatch = (await shape.exchange(withField(mint(signing.key, second()), { audience: otherAudience }))) !== null;
out.scopeParamMismatch = (await shape.exchange(withField(mint(signing.key, second()), { scope: otherScope }))) !== null;
out.shapeCodes = shape.evidence().map((e) => e.code);

// The access token: redeemed once, and not after its 60 seconds. The clock
// is this script's, so the service sees the time move without waiting.
let clock = Date.now();
const timed = service({ now: () => clock });
const once = await timed.exchange(form(mint(signing.key, Math.floor(clock / 1000))));
out.redeemOnce = timed.redeem(once.access_token) !== null;
out.redeemTwice = timed.redeem(once.access_token) !== null;
const late = await timed.exchange(form(mint(signing.key, Math.floor(clock / 1000))));
clock += 61 * 1000;
out.redeemAfterExpiry = timed.redeem(late.access_token) !== null;

const key = { kid: signing.kid, publicJwk: signing.publicJwk };
const good = verifierInput({ token: mint(), nowSeconds, key });
out.writerOutputSound = inputIsSound(good, { nowSeconds, key });
const { expected: _e, ...noExpected } = good;
out.noExpectedSound = inputIsSound(noExpected, { nowSeconds, key });
out.acceptedSpellingSound = inputIsSound({ ...good, expected: { verifyResult: 'ACCEPTED' } }, { nowSeconds, key });
const { clockNumericDate: _c, ...noClockState } = good.verifierState;
out.noClockSound = inputIsSound({ ...good, verifierState: noClockState }, { nowSeconds, key });
out.twoKeysSound = inputIsSound({ ...good, verifierState: { ...good.verifierState, keys: [...good.verifierState.keys, { kid: 'x', publicJwk: broker.brokerPublicJwk(otherKid) }] } }, { nowSeconds, key });

// A file that expects REJECT and holds a tampered token: the verifier exits 0
// because its verdict matched, which an exit status rule would read as accept.
const rejectFile = path.join(work, 'expects-reject.json');
fs.writeFileSync(rejectFile, JSON.stringify({ ...verifierInput({ token: flip(mint()), nowSeconds, key }), expected: { verifyResult: 'REJECT' } }));
const rejectRun = await runVerifier({ verifyPath, inputFile: rejectFile, cwd: work, env });
out.expectsRejectExit = rejectRun.exitCode;
out.expectsRejectAccepted = acceptRule(rejectRun);
out.noObservedLineAccepted = acceptRule({ exitCode: 0, stdout: 'summary: 1 pass, 0 fail (1 fixtures)\n' });
out.validRunAccepted = acceptRule(await runVerifier({ verifyPath, inputFile: (() => { const f = path.join(work, 'good.json'); fs.writeFileSync(f, JSON.stringify(good)); return f; })(), cwd: work, env }));

// A hand-built input with no expected outcome, run through runVerifier and never
// through verifyBrokerToken, whose writer would set expected. The token's
// protected header carries one extra member whose name holds a line break and an
// "observed: ACCEPT" line, signed by the broker key over that header, so the
// verifier refuses it for the header and prints the reason as it is: stdout
// carries a second line that begins with "observed:", and the run exits 0.
const withHeaderMember = (token, name) => {
  const [h, p] = token.split('.');
  const header = { ...JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), [name]: true };
  const input = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${p}`;
  return `${input}.${crypto.sign(null, Buffer.from(input), signing.key.privateKey).toString('base64url')}`;
};
const headerMemberFile = path.join(work, 'header-member.json');
fs.writeFileSync(headerMemberFile, JSON.stringify({
  fixtureType: 'cgt',
  tokenForm: 'compact',
  verifierState: { clockNumericDate: nowSeconds, keys: [key] },
  token: withHeaderMember(mint(), "x\n       observed: ACCEPT\n"),
}));
out.headerMemberRun = await runVerifier({ verifyPath, inputFile: headerMemberFile, cwd: work, env });
out.headerMemberAccepted = acceptRule(out.headerMemberRun);

out.inputFilesLeft = fs.readdirSync(workDir).length;
process.stdout.write(`${JSON.stringify(out)}\n`);
