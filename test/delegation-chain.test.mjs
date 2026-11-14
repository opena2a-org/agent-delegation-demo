// The bank broker's delegation chain check, exported by src/bank/broker.mjs
// as verifyDelegationChain, against draft-asor-wimse-agent-delegation-chain-03:
// every committed fixture under fixtures/delegation-chain/, the same cases
// minted again with keys made in this run, and the choices the draft's text
// leaves to an implementation, each held to the choice the header of
// src/bank/delegation-chain.mjs names.

import './support/outer-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as broker from '../src/bank/broker.mjs';
import { CASE_FILES, DRAFT, ROOT_KID, buildCases, makeKit } from '../scripts/delegation-chain/cases.mjs';
import { makeKey, mint, rootHeader } from '../scripts/delegation-chain/mint.mjs';
import { report } from '../scripts/delegation-chain/report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'fixtures', 'delegation-chain');
const committed = CASE_FILES.map((file) => ({ file, fixture: JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) }));
const fresh = buildCases();

// Table 2 of the draft, in its order.
const TABLE_2 = ['malformed', 'non_canonical', 'duplicate_member', 'non_finite', 'signature_invalid', 'par_hash_mismatch', 'depth_invalid', 'principal_altered', 'not_narrower', 'expired', 'holder_binding_failed', 'revoked', 'status_unknown', 'audience_mismatch', 'scope_not_granted', 'ceiling_exceeded', 'unknown_constraint'];

const verify = (chain, state) => broker.verifyDelegationChain(chain, state);

function want(expected) {
  if (expected.verifyResult === 'ACCEPT') return 'ACCEPT, steps 6 and 8 not performed';
  return `REJECT ${expected.rejectCategory} at ${expected.step === 'parse' ? 'parse' : `step ${expected.step}`}, DT_${expected.index}`;
}

function assertExpected(result, expected, label) {
  if (expected.verifyResult === 'ACCEPT') {
    assert.equal(result.outcome, 'valid', `${label}: ${result.outcome}: ${result.detail}`);
    assert.equal(result.valid, true);
    assert.deepEqual(result.stepsNotPerformed, expected.stepsNotPerformed);
    assert.deepEqual(result.leaf.unknownConstraintTypes, expected.unknownConstraintTypes ?? []);
  } else {
    assert.deepEqual({ outcome: result.outcome, step: result.step, index: result.index }, { outcome: expected.rejectCategory, step: expected.step, index: expected.index }, `${label}: ${result.detail}`);
    assert.equal(result.valid, false);
  }
  assert.equal(result.authorizes, false, `${label}: a check without the request never reports the chain as authorizing an action`);
}

for (const { file, fixture } of committed) {
  test(`committed fixture ${file}: ${want(fixture.expected)}`, () => {
    assertExpected(verify(fixture.chain, fixture.verifierState), fixture.expected, file);
  });
}

for (const { file, fixture } of fresh) {
  test(`case ${file} minted under keys made in this run: ${want(fixture.expected)}`, () => {
    assertExpected(verify(fixture.chain, fixture.verifierState), fixture.expected, file);
  });
}

test('the broker module exports verifyDelegationChain and the outcome names of Table 2 beside the AAP grant path it already exports', () => {
  assert.equal(typeof broker.verifyDelegationChain, 'function');
  assert.deepEqual(broker.DELEGATION_CHAIN_OUTCOMES, TABLE_2);
  for (const name of ['BankBroker', 'loadTrust', 'makeSigningKey', 'jwkThumbprint', 'refusingResolver']) assert.ok(name in broker, name);
});

test('fixtures/delegation-chain/ holds the case files, a README and nothing else, each fixture in the aap-conformance envelope with a Table 2 name and no private key member', () => {
  assert.deepEqual(fs.readdirSync(DIR).sort(), ['README.md', ...CASE_FILES].sort());
  for (const { file, fixture } of committed) {
    assert.deepEqual(Object.keys(fixture), ['name', 'description', 'fixtureType', 'tokenForm', 'spec', 'verifierState', 'chain', 'expected'], file);
    assert.equal(fixture.name, `${DRAFT}/${file.replace(/\.json$/, '')}`);
    assert.equal(fixture.fixtureType, 'dc');
    assert.equal(fixture.tokenForm, 'compact');
    assert.ok(fixture.spec.length > 0 && fixture.spec.every((s) => s.id === DRAFT), file);
    assert.ok(Array.isArray(fixture.chain) && fixture.chain.every((t) => typeof t === 'string' && t.split('.').length === 3), file);
    assert.ok(['ACCEPT', 'REJECT'].includes(fixture.expected.verifyResult), file);
    if (fixture.expected.verifyResult === 'REJECT') assert.ok(broker.DELEGATION_CHAIN_OUTCOMES.includes(fixture.expected.rejectCategory), file);
    for (const k of fixture.verifierState.keys) assert.deepEqual(Object.keys(k.publicJwk).sort(), ['crv', 'kty', 'x'], file);
    for (const t of fixture.chain) {
      const header = JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString('utf8'));
      if (header.jwk) assert.deepEqual(Object.keys(header.jwk).sort(), ['crv', 'kty', 'x'], file);
    }
  }
});

test('the valid two-hop chain: three tokens under one principal, three acting agents, each child signed by its parent\'s holder, and a trace of the parse and of steps 1 to 5 and 7', () => {
  const { fixture } = committed.find((c) => c.file === 'dc-compact-valid-two-hop.json');
  const r = verify(fixture.chain, fixture.verifierState);
  assert.equal(r.outcome, 'valid', r.detail);
  assert.deepEqual(r.chain, { length: 3, principal: 'DEMO-CUST-0000A', actingAgents: ['demo_billpay_agent', 'demo_utilities_agent', 'demo_power_bill_agent'] });
  assert.deepEqual([...new Set(r.trace.map((t) => t.step))], ['parse', 1, 2, 3, 4, 5, 7]);
  const signed = r.trace.filter((t) => t.step === 1).map((t) => t.check);
  assert.equal(signed.length, 3);
  assert.match(signed[0], /^DT_0 verifies under the trusted root key "examplebank-chain-root-1" \(Ed25519\)$/);
  assert.match(signed[1], /^DT_1 verifies under the key DT_0\.cnf names, jkt [A-Za-z0-9_-]{43} \(Ed25519\)$/);
  assert.match(signed[2], /^DT_2 verifies under the key DT_1\.cnf names, jkt [A-Za-z0-9_-]{43} \(Ed25519\)$/);
  assert.deepEqual(r.stepsPerformed, [1, 2, 3, 4, 5, 7]);
  assert.deepEqual(r.leaf.scopes, ['payment.billpay.metro_power']);
});

test('the report scripts/delegation-chain/verify.mjs prints: PASS for every committed fixture, the two-hop chain as ACCEPT with its trace and no action reported as authorized, and FAIL when the expected result is not the observed one', () => {
  for (const { file, fixture } of committed) assert.equal(report(fixture, file).ok, true, file);
  const { fixture } = committed.find((c) => c.file === 'dc-compact-valid-two-hop.json');
  const { ok, lines } = report(fixture, 'dc-compact-valid-two-hop.json', { trace: true });
  assert.equal(ok, true);
  assert.ok(lines.includes('  observed: ACCEPT'));
  assert.ok(lines.includes('  steps performed: 1 2 3 4 5 7; not performed: 6 8, which need the request; reports an action as authorized: no'));
  assert.equal(lines.filter((l) => l.startsWith('  step ')).length, 12);
  assert.equal(lines.at(-1), '  result: PASS');
  const wrong = report({ ...fixture, expected: { verifyResult: 'REJECT', rejectCategory: 'expired', step: 5, index: 2 } }, 'altered expectation');
  assert.equal(wrong.ok, false);
  assert.equal(wrong.lines.at(-1), '  result: FAIL');
});

// Cells on the choices the draft's text leaves open. Each mints a valid chain
// under a kit made here and changes one thing.
const kit = makeKit();
const payloadText = (token) => Buffer.from(token.split('.')[1], 'base64url').toString('utf8');
// The valid chain with DT_index's payload replaced by edit(its JCS text); the
// tokens after it commit to the replaced token.
function edited(index, edit, cs = kit.claims()) {
  const text = edit(payloadText(kit.chain(cs)[index]));
  return kit.chain(cs, { payloadText: { [index]: text } });
}
const appendMember = (member) => (t) => `${t.slice(0, -1)},${member}}`;
const outcome = (chain, state = kit.state) => {
  const r = verify(chain, state);
  return { outcome: r.outcome, step: r.step, index: r.index };
};

test('parse order: a payload that repeats a member name is duplicate_member, though its bytes are not JCS either', () => {
  assert.deepEqual(outcome(edited(1, appendMember('"sub":"DEMO-CUST-0000A"'))), { outcome: 'duplicate_member', step: 'parse', index: 1 });
});

test('parse order: a number that overflows binary64 (1e400) is non_finite, though its bytes are not JCS either', () => {
  assert.deepEqual(outcome(edited(1, appendMember('"zzz":1e400'))), { outcome: 'non_finite', step: 'parse', index: 1 });
});

test('parse order: an integer above 2^53-1 written in full (9007199254740993) is malformed, though it also reads back as another number', () => {
  assert.deepEqual(outcome(edited(1, appendMember('"zzz":9007199254740993'))), { outcome: 'malformed', step: 'parse', index: 1 });
});

test('an integer of magnitude 2^53 in its JCS form (9007199254740992) is malformed: the bound reads the value', () => {
  assert.deepEqual(outcome(edited(1, appendMember('"zzz":9007199254740992'))), { outcome: 'malformed', step: 'parse', index: 1 });
  assert.deepEqual(outcome(edited(1, appendMember('"zzz":9007199254740991'))), { outcome: 'valid', step: null, index: null });
});

test('a lone UTF-16 surrogate in a claim (written as the escape \\ud800) is malformed', () => {
  assert.deepEqual(outcome(edited(1, appendMember('"zzz":"\\ud800"'))), { outcome: 'malformed', step: 'parse', index: 1 });
  assert.deepEqual(outcome(edited(1, appendMember('"zzz":"\\ud83d\\ude00"'))), { outcome: 'non_canonical', step: 'parse', index: 1 }, 'a surrogate pair written as escapes is not the JCS form, which writes the character');
});

test('JCS forms: numbers as ECMAScript writes them verify, other spellings of the same values are non_canonical', () => {
  const cs = kit.claims();
  cs[1].x_numbers = [1e-7, 0.000001, 123.456, -5, 0];
  assert.deepEqual(outcome(kit.chain(cs)), { outcome: 'valid', step: null, index: null });
  for (const [from, to] of [['1e-7', '1E-7'], ['0.000001', '1e-6'], ['123.456', '123.4560'], [',0]', ',-0]']]) {
    assert.deepEqual(outcome(edited(1, (t) => t.replace(from, to), structuredClone(cs))), { outcome: 'non_canonical', step: 'parse', index: 1 }, to);
  }
});

test('JCS member order is by UTF-16 code units: names U+20AC, U+1F600 and U+FB33 verify in that order and are non_canonical in code point order', () => {
  const cs = kit.claims();
  Object.assign(cs[1], { '€': 1, '😀': 2, 'דּ': 3 });
  assert.deepEqual(outcome(kit.chain(cs)), { outcome: 'valid', step: null, index: null });
  const swap = (t) => t.replace('"😀":2,"דּ":3', '"דּ":3,"😀":2');
  assert.deepEqual(outcome(edited(1, swap, structuredClone(cs))), { outcome: 'non_canonical', step: 'parse', index: 1 });
});

test('a protected header out of JCS order is non_canonical', () => {
  const cs = kit.claims();
  const header = '{"typ":"at+jwt","alg":"Ed25519","c14n":"JCS","kid":"examplebank-chain-root-1"}';
  const [t0] = kit.chain(cs, { header: { 0: header } });
  const rest = kit.chain(cs, { parent: { 1: t0 } }).slice(1);
  assert.deepEqual(outcome([t0, ...rest]), { outcome: 'non_canonical', step: 'parse', index: 0 });
});

test('every token is parsed before step 1 runs: DT_0 under an untrusted key and DT_2 without par_hash give malformed at DT_2', () => {
  assert.deepEqual(outcome(kit.chain(kit.claims(), { signer: { 0: makeKey() }, noParHash: [2] })), { outcome: 'malformed', step: 'parse', index: 2 });
});

test('step 1 runs over the chain before step 2: a par_hash mismatch at DT_1 and a foreign signer at DT_2 give signature_invalid at DT_2', () => {
  const stranger = mint({ header: rootHeader('another-root'), payload: { iss: 'https://elsewhere.test' }, key: makeKey() });
  assert.deepEqual(outcome(kit.chain(kit.claims(), { parent: { 1: stranger }, signer: { 2: makeKey() } })), { outcome: 'signature_invalid', step: 1, index: 2 });
});

test('the key of a child: a child whose protected header carries no "jwk" is signature_invalid, and one whose "jwk" is the key DT_{i-1}.cnf names verifies', () => {
  const header = { alg: 'Ed25519', c14n: 'JCS', kid: 'demo-utilities-agent-key', typ: 'at+jwt' };
  assert.deepEqual(outcome(kit.chain(kit.claims(), { header: { 2: header } })), { outcome: 'signature_invalid', step: 1, index: 2 });
  assert.deepEqual(outcome(kit.chain(kit.claims())), { outcome: 'valid', step: null, index: null });
});

test('the signature of a child: a child whose header carries the key DT_{i-1}.cnf names but is signed by another key is signature_invalid at that child', () => {
  const header = (i) => ({ alg: 'Ed25519', c14n: 'JCS', jwk: kit.holders[i - 1].publicJwk, typ: 'at+jwt' });
  assert.deepEqual(outcome(kit.chain(kit.claims(), { signer: { 2: makeKey() }, header: { 2: header(2) } })), { outcome: 'signature_invalid', step: 1, index: 2 });
  assert.deepEqual(outcome(kit.chain(kit.claims(), { signer: { 1: makeKey() }, header: { 1: header(1) } })), { outcome: 'signature_invalid', step: 1, index: 1 });
});

test('the algorithm configured for a key: with Ed25519 and EdDSA both accepted, a token naming EdDSA is signature_invalid at that token, since this verifier configures Ed25519 for every Ed25519 key, and the unchanged chain is valid', () => {
  const state = { ...kit.state, acceptedAlgorithms: ['Ed25519', 'EdDSA'] };
  assert.deepEqual(outcome(kit.chain(kit.claims()), state), { outcome: 'valid', step: null, index: null });
  const root = { alg: 'EdDSA', c14n: 'JCS', kid: ROOT_KID, typ: 'at+jwt' };
  assert.deepEqual(outcome(kit.chain(kit.claims(), { header: { 0: root } }), state), { outcome: 'signature_invalid', step: 1, index: 0 });
  const child = { alg: 'EdDSA', c14n: 'JCS', jwk: kit.holders[1].publicJwk, typ: 'at+jwt' };
  assert.deepEqual(outcome(kit.chain(kit.claims(), { header: { 2: child } }), state), { outcome: 'signature_invalid', step: 1, index: 2 });
});

test('step 5: a token is outside its window at its exp: a clock at DT_2.exp is expired at DT_2, and a clock one second before it is valid', () => {
  const cs = kit.claims();
  const chain = kit.chain(cs);
  assert.deepEqual(outcome(chain, { ...kit.state, clockNumericDate: cs[2].exp }), { outcome: 'expired', step: 5, index: 2 });
  assert.deepEqual(outcome(chain, { ...kit.state, clockNumericDate: cs[2].exp - 1 }), { outcome: 'valid', step: null, index: null });
});

test('step 5: a token is outside its window before its nbf: DT_2.nbf ten seconds after the clock is expired at DT_2, and DT_2.nbf equal to the clock is valid', () => {
  const now = kit.state.clockNumericDate;
  const cs = kit.claims();
  cs[2].nbf = now + 10;
  assert.deepEqual(outcome(kit.chain(cs)), { outcome: 'expired', step: 5, index: 2 });
  cs[2].nbf = now;
  assert.deepEqual(outcome(kit.chain(cs)), { outcome: 'valid', step: null, index: null });
});

test('step 7: a token that carries a status reference is status_unknown, since this verifier holds no status list', () => {
  const cs = kit.claims();
  cs[1].status = { status_list: { idx: 7, uri: 'https://status.examplebank.test/lists/1' } };
  assert.deepEqual(outcome(kit.chain(cs)), { outcome: 'status_unknown', step: 7, index: 1 });
});

test('rule 5: a child with no del_max_depth holds its parent\'s value, so the chain is valid, and a grandchild above that value is not_narrower', () => {
  const cs = kit.claims();
  delete cs[1].del_max_depth;
  delete cs[2].del_max_depth;
  assert.deepEqual(outcome(kit.chain(cs)), { outcome: 'valid', step: null, index: null });
  cs[2].del_max_depth = 4;
  assert.deepEqual(outcome(kit.chain(cs)), { outcome: 'not_narrower', step: 4, index: 2 });
});

test('step 3 as written bounds the chain by DT_0.del_max_depth: DT_1 and DT_2 carry 2, DT_0 carries 3, and the chain of three tokens is valid', () => {
  const cs = kit.claims();
  cs[1].del_max_depth = 2;
  cs[2].del_max_depth = 2;
  assert.deepEqual(outcome(kit.chain(cs)), { outcome: 'valid', step: null, index: null });
});

test('a constraint object with two members beside "key", neither a type this verifier implements, is malformed', () => {
  const cs = kit.claims();
  cs[0].authorization_details[0].constraints.push({ key: 'settlement', x_window: 'same_day', x_zone: 'utc' });
  assert.deepEqual(outcome(kit.chain(cs)), { outcome: 'malformed', step: 'parse', index: 0 });
});

test('a constraint of an unknown type that a child adds narrows the chain: the chain is valid and the leaf names the type step 8 would deny on', () => {
  const cs = kit.claims();
  cs[2].authorization_details[0].constraints.push({ key: 'settlement', x_settlement_window: 'same_day' });
  const r = verify(kit.chain(cs), kit.state);
  assert.equal(r.outcome, 'valid', r.detail);
  assert.deepEqual(r.leaf.unknownConstraintTypes, [{ key: 'settlement', type: 'x_settlement_window' }]);
});

test('a chain in the claim layout of the -01 (no cnf, no client_id, aud null) is malformed under the -03: one longer than its del_max_depth gives malformed, not depth_invalid', () => {
  const cs = kit.claims().map((c) => {
    const { cnf, client_id: clientId, ...rest } = c;
    assert.ok(cnf && clientId);
    return { ...rest, aud: null, del_max_depth: 2 };
  });
  assert.deepEqual(outcome(kit.chain(cs)), { outcome: 'malformed', step: 'parse', index: 0 });
});
