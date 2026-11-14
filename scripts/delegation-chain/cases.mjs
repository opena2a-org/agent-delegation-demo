// The delegation chain cases: a valid chain of two hops (DT_0, DT_1, DT_2)
// under one customer's grant, and variants of it, each changed in one place
// and signed again, that a verifier of draft-asor-wimse-agent-delegation-chain-03
// must refuse, each with the outcome name of the draft's Table 2 it must give.
//
// buildCases() makes fresh keys on every call, so the committed fixtures and
// a call made inside a test carry different bytes and the same outcomes.
// Every customer, account, payee and payment here is fictional; every domain
// ends in .test.

import crypto from 'node:crypto';
import { childHeader, makeKey, mint, parHash, rootHeader } from './mint.mjs';

export const DRAFT = 'draft-asor-wimse-agent-delegation-chain-03';
export const DRAFT_REF = 'https://datatracker.ietf.org/doc/html/draft-asor-wimse-agent-delegation-chain-03';
export const CLOCK = 1794614400; // 2026-11-14T00:00:00Z
export const ROOT_KID = 'examplebank-chain-root-1';
const SUB = 'DEMO-CUST-0000A';
const OTHER_SUB = 'DEMO-CUST-0000B';
const AGENTS = ['demo_billpay_agent', 'demo_utilities_agent', 'demo_power_bill_agent'];

// The keys of one set of cases, and a minter for chains under them. A child
// DT_i is signed by the holder of DT_{i-1}: the key whose thumbprint
// DT_{i-1}.cnf names, carried in DT_i's protected header as "jwk".
export function makeKit() {
  const root = makeKey();
  const holders = AGENTS.map(() => makeKey());
  const state = {
    clockNumericDate: CLOCK,
    acceptedAlgorithms: ['Ed25519'],
    keys: [{ kid: ROOT_KID, alg: 'Ed25519', publicJwk: root.publicJwk }],
  };

  const constraints = [
    [
      { key: 'amount_cents', max: 25000 },
      { key: 'amount_cents', min: 100 },
      { key: 'amount_cents', max_subtree: 50000 },
      { key: 'creditor_account', one_of: ['DEMO-0000-1180', 'DEMO-0000-6342', 'DEMO-0000-2208'] },
      { key: 'creditor_account', not_one_of: ['DEMO-0000-4417'] },
      { key: 'memo', prefix: 'DEMO-' },
      { key: 'egress', rank: 'internal', order: ['none', 'internal', 'any'] },
      { key: 'payments', max_lifetime: 10 },
    ],
    [
      { key: 'amount_cents', max: 20000 },
      { key: 'amount_cents', min: 100 },
      { key: 'amount_cents', max_subtree: 40000 },
      { key: 'creditor_account', one_of: ['DEMO-0000-1180', 'DEMO-0000-6342'] },
      { key: 'creditor_account', not_one_of: ['DEMO-0000-4417'] },
      { key: 'memo', prefix: 'DEMO-BILL-' },
      { key: 'egress', rank: 'internal', order: ['none', 'internal', 'any'] },
      { key: 'payments', max_lifetime: 5 },
    ],
    [
      { key: 'amount_cents', max: 12000 },
      { key: 'amount_cents', min: 500 },
      { key: 'amount_cents', max_subtree: 12000 },
      { key: 'creditor_account', one_of: ['DEMO-0000-6342'] },
      { key: 'creditor_account', not_one_of: ['DEMO-0000-4417', 'DEMO-0000-1180'] },
      { key: 'memo', prefix: 'DEMO-BILL-POWER-' },
      { key: 'egress', rank: 'none', order: ['none', 'internal', 'any'] },
      { key: 'payments', max_lifetime: 1 },
    ],
  ];
  const scopes = [['balance.read', 'payment.billpay.*', 'statements'], ['payment.billpay.*', 'statements'], ['payment.billpay.metro_power']];
  const exp = [CLOCK + 3600, CLOCK + 1800, CLOCK + 900];
  const aud = [['https://payments.examplebank.test', 'https://statements.examplebank.test'], 'https://payments.examplebank.test', 'https://payments.examplebank.test'];

  // The claims of the valid chain, a fresh copy on every call.
  const claims = () => AGENTS.map((agent, i) => ({
    iss: i === 0 ? 'https://broker.examplebank.test' : AGENTS[i - 1],
    sub: SUB,
    aud: structuredClone(aud[i]),
    client_id: agent,
    iat: CLOCK - 300,
    nbf: CLOCK - 300,
    exp: exp[i],
    jti: crypto.randomUUID(),
    cnf: { jkt: holders[i].jkt },
    del_depth: i,
    del_max_depth: 3,
    authorization_details: [{ type: 'agent_delegation', scopes: [...scopes[i]], constraints: structuredClone(constraints[i]) }],
  }));

  // Mint a chain from claim objects. par_hash is set on every DT_i, i > 0,
  // to the digest of the token before it, unless opts.noParHash names i or
  // opts.parent[i] names another parent token. opts.signer[i] and
  // opts.header[i] replace the signing key and the protected header of DT_i;
  // opts.payloadText[i] replaces DT_i's payload with text signed byte for byte.
  const chain = (cs, opts = {}) => {
    const tokens = [];
    cs.forEach((c, i) => {
      const payload = { ...c };
      if (i > 0 && !(opts.noParHash ?? []).includes(i)) payload.par_hash = parHash(opts.parent?.[i] ?? tokens[i - 1]);
      const signer = opts.signer?.[i] ?? (i === 0 ? root : holders[i - 1]);
      const header = opts.header?.[i] ?? (i === 0 ? rootHeader(ROOT_KID) : childHeader(signer));
      tokens.push(mint({ header, payload: opts.payloadText?.[i] ?? payload, key: signer }));
    });
    return tokens;
  };

  return { root, holders, state, claims, chain };
}

const constraintOf = (c, key, type) => c.authorization_details[0].constraints.find((k) => k.key === key && Object.hasOwn(k, type));
const detailOf = (c) => c.authorization_details[0];

// [file, description, draft sections, build(kit) -> chain, expected]
const CASES = [
  ['dc-compact-valid-two-hop',
    'A valid chain of two hops under the grant of customer DEMO-CUST-0000A: the root DT_0, signed under the trusted root key, names demo_billpay_agent; DT_1, signed by that agent\'s key, names demo_utilities_agent; DT_2, signed by that agent\'s key, names demo_power_bill_agent. Each child commits to its parent by par_hash and narrows its scopes, every constraint and its expiry. A verifier holding the chain and no request runs steps 1 to 5 and 7 and reports the chain valid, with steps 6 and 8 not performed.',
    ['3 Token Format', '4.1 Scope Syntax and Wildcards', '4.3 Subsumption Rules', '5 Chain Linkage', '6 Offline Verification Algorithm, steps 1 to 5 and 7', '6.1 What Verification Establishes'],
    (k) => k.chain(k.claims()),
    { verifyResult: 'ACCEPT', stepsNotPerformed: [6, 8] }],

  ['dc-compact-valid-unknown-constraint-byte-identical',
    'Every token carries a constraint of a type no verifier here implements, x_settlement_window, and each child carries it byte-identical in JCS to its parent\'s. Rule 2 cannot be evaluated for it; the byte-identical copy satisfies section 4.3 at step 4, so the chain is valid. Any action under it is denied at step 8 under the fail-closed rule of section 4.2, which a verifier with no request does not run.',
    ['4.2 Constraint Vocabulary', '4.3 Subsumption Rules'],
    (k) => k.chain(k.claims().map((c) => { detailOf(c).constraints.push({ key: 'settlement', x_settlement_window: 'same_day' }); return c; })),
    { verifyResult: 'ACCEPT', stepsNotPerformed: [6, 8], unknownConstraintTypes: [{ key: 'settlement', type: 'x_settlement_window' }] }],

  ['dc-compact-rule1-scope-not-covered',
    'DT_2 adds the literal scope payment.transfer.external, which no scope of DT_1 covers (rule 1).',
    ['4.1 Scope Syntax and Wildcards', '4.3 Subsumption Rules, rule 1', '6 step 4'],
    (k) => { const cs = k.claims(); detailOf(cs[2]).scopes.push('payment.transfer.external'); return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule1-wildcard-widened',
    'DT_2 carries the wildcard payment.*, wider than the wildcard payment.billpay.* of DT_1 (rule 1).',
    ['4.1 Scope Syntax and Wildcards', '4.3 Subsumption Rules, rule 1', '6 step 4'],
    (k) => { const cs = k.claims(); detailOf(cs[2]).scopes = ['payment.*']; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule1-segment-boundary',
    'DT_2 carries payment.billpayx.metro_power, which shares the characters payment.billpay with the wildcard payment.billpay.* of DT_1 but not the dot after them; wildcard coverage is segment-bounded, so the wildcard does not cover it (rule 1).',
    ['4.1 Scope Syntax and Wildcards', '4.3 Subsumption Rules, rule 1', '6 step 4'],
    (k) => { const cs = k.claims(); detailOf(cs[2]).scopes = ['payment.billpayx.metro_power']; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule1-wildcard-over-opaque',
    'DT_2 carries payment.billpay.MetroPower, an opaque scope (an upper case letter takes it out of the literal form) that begins with payment.billpay. under DT_1\'s wildcard payment.billpay.*; no wildcard scope covers an opaque scope (rule 1).',
    ['4.1 Scope Syntax and Wildcards', '4.3 Subsumption Rules, rule 1', '6 step 4'],
    (k) => { const cs = k.claims(); detailOf(cs[2]).scopes = ['payment.billpay.MetroPower']; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule1-opaque-over-wildcard',
    'DT_1 carries the wildcard statements.* where DT_0 carries the opaque scope statements; an opaque scope covers no wildcard scope (rule 1).',
    ['4.1 Scope Syntax and Wildcards', '4.3 Subsumption Rules, rule 1', '6 step 4'],
    (k) => { const cs = k.claims(); detailOf(cs[1]).scopes = ['payment.billpay.*', 'statements.*']; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 1 }],

  ['dc-compact-rule2-max-raised',
    'DT_2 raises the per action ceiling amount_cents max to 25000, above DT_1\'s 20000 (rule 2, "max").',
    ['4.2 Constraint Vocabulary', '4.3 Subsumption Rules, rule 2', '6 step 4'],
    (k) => { const cs = k.claims(); constraintOf(cs[2], 'amount_cents', 'max').max = 25000; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule2-min-lowered',
    'DT_2 lowers the floor amount_cents min to 50, below DT_1\'s 100 (rule 2, "min").',
    ['4.2 Constraint Vocabulary', '4.3 Subsumption Rules, rule 2', '6 step 4'],
    (k) => { const cs = k.claims(); constraintOf(cs[2], 'amount_cents', 'min').min = 50; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule2-max-subtree-raised',
    'DT_2 raises the per subtree bound amount_cents max_subtree to 45000, above DT_1\'s 40000 (rule 2, "max_subtree").',
    ['4.2 Constraint Vocabulary', '4.3 Subsumption Rules, rule 2', '6 step 4'],
    (k) => { const cs = k.claims(); constraintOf(cs[2], 'amount_cents', 'max_subtree').max_subtree = 45000; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule2-max-lifetime-raised',
    'DT_2 raises the per lifetime bound payments max_lifetime to 8, above DT_1\'s 5 (rule 2, "max_lifetime").',
    ['4.2 Constraint Vocabulary', '4.3 Subsumption Rules, rule 2', '6 step 4'],
    (k) => { const cs = k.claims(); constraintOf(cs[2], 'payments', 'max_lifetime').max_lifetime = 8; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule2-one-of-added',
    'DT_2 adds DEMO-0000-2208 to creditor_account one_of; DT_1\'s set does not hold it (rule 2, "one_of").',
    ['4.2 Constraint Vocabulary', '4.3 Subsumption Rules, rule 2', '6 step 4'],
    (k) => { const cs = k.claims(); constraintOf(cs[2], 'creditor_account', 'one_of').one_of.push('DEMO-0000-2208'); return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule2-not-one-of-dropped',
    'DT_2 empties creditor_account not_one_of, dropping DEMO-0000-4417, which DT_1 excludes (rule 2, "not_one_of").',
    ['4.2 Constraint Vocabulary', '4.3 Subsumption Rules, rule 2', '6 step 4'],
    (k) => { const cs = k.claims(); constraintOf(cs[2], 'creditor_account', 'not_one_of').not_one_of = []; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule2-prefix-shortened',
    'DT_2 sets memo prefix to DEMO-, which does not begin with DT_1\'s DEMO-BILL- (rule 2, "prefix").',
    ['4.2 Constraint Vocabulary', '4.3 Subsumption Rules, rule 2', '6 step 4'],
    (k) => { const cs = k.claims(); constraintOf(cs[2], 'memo', 'prefix').prefix = 'DEMO-'; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule2-rank-raised',
    'DT_2 raises egress rank to any, above DT_1\'s internal in the same order (rule 2, "rank").',
    ['4.2 Constraint Vocabulary', '4.3 Subsumption Rules, rule 2', '6 step 4'],
    (k) => { const cs = k.claims(); constraintOf(cs[2], 'egress', 'rank').rank = 'any'; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule2-rank-order-changed',
    'DT_2 keeps egress rank none but carries an order of four values where DT_1 carries three; the orders are not identical element for element (rule 2, "rank").',
    ['4.2 Constraint Vocabulary', '4.3 Subsumption Rules, rule 2', '6 step 4'],
    (k) => { const cs = k.claims(); constraintOf(cs[2], 'egress', 'rank').order = ['none', 'internal', 'partner', 'any']; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule2-no-cross-type',
    'DT_2 replaces its amount_cents max with an amount_cents max_lifetime of 12000. A max_lifetime does not satisfy a max of the same key in the parent, whatever their values, so DT_1\'s (amount_cents, max) has no counterpart in DT_2 (rules 2 and 3, no inference across constraint types).',
    ['4.2 Constraint Vocabulary', '4.3 Subsumption Rules, rules 2 and 3', '6 step 4'],
    (k) => {
      const cs = k.claims();
      const d = detailOf(cs[2]);
      d.constraints = d.constraints.map((c) => (c.key === 'amount_cents' && Object.hasOwn(c, 'max') ? { key: 'amount_cents', max_lifetime: 12000 } : c));
      return k.chain(cs);
    },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule2-unknown-constraint-changed',
    'Every token carries a constraint of the type x_settlement_window, which no verifier here implements; DT_2\'s value differs from DT_1\'s, so its JCS serialization is not byte-identical and the chain is not subsumed (section 4.3, a constraint type the verifier does not implement).',
    ['4.2 Constraint Vocabulary', '4.3 Subsumption Rules', '6 step 4'],
    (k) => k.chain(k.claims().map((c, i) => { detailOf(c).constraints.push({ key: 'settlement', x_settlement_window: i === 2 ? 'next_day' : 'same_day' }); return c; })),
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule3-constraint-dropped',
    'DT_2 drops creditor_account one_of, which DT_1 carries; absence means unbounded, which is not a subset (rule 3).',
    ['4.3 Subsumption Rules, rule 3', '6 step 4'],
    (k) => {
      const cs = k.claims();
      const d = detailOf(cs[2]);
      d.constraints = d.constraints.filter((c) => !(c.key === 'creditor_account' && Object.hasOwn(c, 'one_of')));
      return k.chain(cs);
    },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-rule4-expiry-extended',
    'DT_2 expires 60 seconds after DT_1; every token is inside its validity window at the clock, and the expiry is not monotonic (rule 4, checked at step 5).',
    ['4.3 Subsumption Rules, rule 4', '6 step 5'],
    (k) => { const cs = k.claims(); cs[2].exp = cs[1].exp + 60; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'expired', step: 5, index: 2 }],

  ['dc-compact-rule5-max-depth-raised',
    'DT_2 carries del_max_depth 4, above DT_1\'s 3 (rule 5).',
    ['3 Token Format, del_max_depth', '4.3 Subsumption Rules, rule 5', '6 step 4'],
    (k) => { const cs = k.claims(); cs[2].del_max_depth = 4; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'not_narrower', step: 4, index: 2 }],

  ['dc-compact-par-hash-reissued-parent',
    'DT_2 is presented with a re-issued DT_1 (same claims, a new jti, iat and exp, signed by the same holder and committing to DT_0) in place of the DT_1 instance DT_2 commits to (section 5).',
    ['3 Token Format, par_hash', '5 Chain Linkage', '6 step 2'],
    (k) => {
      const cs = k.claims();
      const [t0, , t2] = k.chain(cs);
      const again = { ...cs[1], jti: crypto.randomUUID(), iat: CLOCK - 60, exp: cs[1].exp + 300 };
      const [, t1Again] = k.chain([cs[0], again], { parent: { 1: t0 } });
      return [t0, t1Again, t2];
    },
    { verifyResult: 'REJECT', rejectCategory: 'par_hash_mismatch', step: 2, index: 2 }],

  ['dc-compact-par-hash-in-root',
    'DT_0 carries a par_hash, which section 3 says MUST be absent in DT_0.',
    ['3 Token Format, par_hash'],
    (k) => { const cs = k.claims(); cs[0].par_hash = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'malformed', step: 'parse', index: 0 }],

  ['dc-compact-par-hash-missing',
    'DT_1 carries no par_hash, which section 3 makes REQUIRED in every DT_i with i > 0.',
    ['3 Token Format, par_hash'],
    (k) => k.chain(k.claims(), { noParHash: [1] }),
    { verifyResult: 'REJECT', rejectCategory: 'malformed', step: 'parse', index: 1 }],

  ['dc-compact-depth-exceeds-max',
    'DT_0 allows a chain of at most two tokens (del_max_depth 2, and each child 2); the chain holds three, so n = 2 is not below DT_0.del_max_depth.',
    ['3 Token Format, del_max_depth', '6 step 3'],
    (k) => k.chain(k.claims().map((c) => ({ ...c, del_max_depth: 2 }))),
    { verifyResult: 'REJECT', rejectCategory: 'depth_invalid', step: 3, index: 2 }],

  ['dc-compact-depth-out-of-sequence',
    'DT_2 carries del_depth 1 at position 2.',
    ['3 Token Format, del_depth', '6 step 3'],
    (k) => { const cs = k.claims(); cs[2].del_depth = 1; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'depth_invalid', step: 3, index: 2 }],

  ['dc-compact-principal-altered',
    'DT_2 names the principal DEMO-CUST-0000B where DT_0 names DEMO-CUST-0000A.',
    ['3 Token Format, sub', '3.1 Principal and Acting Agent', '6 step 3'],
    (k) => { const cs = k.claims(); cs[2].sub = OTHER_SUB; return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'principal_altered', step: 3, index: 2 }],

  ['dc-compact-alg-not-accepted',
    'DT_2\'s protected header names the algorithm EdDSA, which is not on the verifier\'s list (Ed25519); the signature itself verifies under the key.',
    ['3 Token Format', '6 step 1'],
    (k) => k.chain(k.claims(), { header: { 2: { alg: 'EdDSA', c14n: 'JCS', jwk: k.holders[1].publicJwk, typ: 'at+jwt' } } }),
    { verifyResult: 'REJECT', rejectCategory: 'signature_invalid', step: 1, index: 2 }],

  ['dc-compact-child-signed-by-other-key',
    'DT_2 is signed by a key that is not the one DT_1.cnf names, and carries that key in its header.',
    ['6 step 1', '7 Holder Binding'],
    (k) => k.chain(k.claims(), { signer: { 2: makeKey() } }),
    { verifyResult: 'REJECT', rejectCategory: 'signature_invalid', step: 1, index: 2 }],

  ['dc-compact-root-untrusted-key',
    'DT_0 names the trusted root key\'s kid and is signed by another key.',
    ['6 step 1'],
    (k) => k.chain(k.claims(), { signer: { 0: makeKey() } }),
    { verifyResult: 'REJECT', rejectCategory: 'signature_invalid', step: 1, index: 0 }],

  ['dc-compact-detail-type-added',
    'DT_2 carries a second authorization detail, of the type payment_initiation, which DT_1 does not carry; a token carries exactly one detail, of the type agent_delegation (section 4.4).',
    ['4 Authority Representation', '4.4 Authorization Detail Types and the Verifier'],
    (k) => { const cs = k.claims(); cs[2].authorization_details.push({ type: 'payment_initiation', instructedAmount: { amount: '120.00', currency: 'USD' } }); return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'malformed', step: 'parse', index: 2 }],

  ['dc-compact-duplicate-constraint',
    'DT_1 carries two constraints with the key amount_cents and the type max.',
    ['4.2 Constraint Vocabulary'],
    (k) => { const cs = k.claims(); detailOf(cs[1]).constraints.push({ key: 'amount_cents', max: 15000 }); return k.chain(cs); },
    { verifyResult: 'REJECT', rejectCategory: 'malformed', step: 'parse', index: 1 }],
];

export const CASE_FILES = Object.freeze(CASES.map(([file]) => `${file}.json`));

export function buildCases() {
  const kit = makeKit();
  return CASES.map(([file, description, sections, build, expected]) => ({
    file: `${file}.json`,
    fixture: {
      name: `${DRAFT}/${file}`,
      description,
      fixtureType: 'dc',
      tokenForm: 'compact',
      spec: sections.map((section) => ({ id: DRAFT, ref: DRAFT_REF, section })),
      verifierState: structuredClone(kit.state),
      chain: build(kit),
      expected,
    },
  }));
}
