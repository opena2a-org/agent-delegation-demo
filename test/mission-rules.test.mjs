import './support/outer-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, computeAnchor, deriveUnderMission, missionState, rfc3339Ms } from '../src/bank/mission.mjs';

// The bank's Mission rules (src/bank/mission.mjs) against the Appendix D
// vectors of draft-mcguinness-oauth-mission-02, and the derivation fixtures
// in conformance/mission. The payment API fixtures run in
// mission-payment-api.test.mjs.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'conformance', 'mission');
const json = (rel) => JSON.parse(fs.readFileSync(path.join(DIR, rel), 'utf8'));
const vectors = json('vectors/appendix-d-integrity-anchors.json');
const numbers = json('vectors/jcs-number-serialization.json');
const schema = json('schemas/mission-fixture-v1.schema.json');
const manifest = fs.readFileSync(path.join(DIR, 'MANIFEST.sha256'), 'utf8').trim().split('\n').map((line) => {
  const m = /^([0-9a-f]{64}) {2}(fixtures\/[a-z0-9-]+\.json)$/.exec(line);
  assert.ok(m, `a MANIFEST.sha256 line in the sha256sum form: ${line}`);
  return { sha256: m[1], rel: m[2] };
});
const fixtures = manifest.map(({ rel }) => ({ rel, doc: json(rel) }));
const derivations = fixtures.filter((f) => f.doc.derivation);

test('Appendix D: the vectors file holds the six vectors the draft prints', () => {
  assert.deepEqual(vectors.vectors.map((v) => v.name), [
    'd1-intent', 'd2-authority-set', 'd3-intent-flat-purpose', 'd4-authority-set-delegation', 'd5-proposed-authority', 'd6-authority-entry',
  ]);
});

for (const v of vectors.vectors) {
  test(`Appendix D ${v.name}: the bank's canonical form gives the printed bytes, and ${v.anchor} the printed anchor`, () => {
    assert.equal(canonicalize({ typ: v.typ, iss: v.iss, value: v.value }), v.canonical);
    assert.equal(computeAnchor(v.typ, v.iss, v.value), v.digest);
  });
}

test('the canonical form writes each double as ECMAScript does, and refuses what is not I-JSON', () => {
  for (const n of numbers.numbers) assert.equal(canonicalize(Buffer.from(n.ieee754, 'hex').readDoubleBE(0)), n.serialized, n.ieee754);
  assert.throws(() => canonicalize({ goal: '\ud800' }), /lone surrogate/);
  assert.throws(() => canonicalize({ max_depth: Number.POSITIVE_INFINITY }), /not finite/);
  assert.throws(() => canonicalize({ at: new Date(0) }), /not in the JSON data model/);
});

test('an impossible instant is no valid expires_at, and a stored active Mission with one is not active', () => {
  const at = new Date('2026-03-01T12:00:00Z');
  // Date.parse rolls each of these over to a later instant (2026-02-30 reads
  // as 2026-03-02, 24:00:00 as the next day), which is after `at`: read that
  // way, the Mission would be active.
  const rolledOver = ['2026-02-30T00:00:00Z', '2026-02-31T23:59:59Z', '2026-04-31T00:00:00Z', '2026-11-14T24:00:00Z', '2026-02-29T13:00:00Z', '2100-02-29T00:00:00Z'];
  // Date.parse refuses these itself; the field check refuses them as well.
  const outOfRange = ['2026-11-14T23:60:00Z', '2026-11-14T23:59:60Z', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z', '2026-11-00T00:00:00Z'];
  for (const expires_at of [...rolledOver, ...outOfRange]) {
    assert.ok(Number.isNaN(rfc3339Ms(expires_at)), expires_at);
    assert.deepEqual(missionState({ state: 'active', expires_at }, at), { active: false, category: 'NOT_ACTIVE', reason: 'the Mission record has no valid expires_at' }, expires_at);
  }
  // A leap day that exists is a valid instant, in a leap year of either rule.
  assert.equal(rfc3339Ms('2028-02-29T00:00:00Z'), Date.UTC(2028, 1, 29));
  assert.equal(rfc3339Ms('2000-02-29T23:59:59.500+01:00'), Date.UTC(2000, 1, 29, 22, 59, 59, 500));
  assert.deepEqual(missionState({ state: 'active', expires_at: '2028-02-29T00:00:00Z' }, at), { active: true });
});

test('the fixture manifest names every fixture file with its sha256', () => {
  const files = fs.readdirSync(path.join(DIR, 'fixtures')).filter((f) => f.endsWith('.json')).map((f) => `fixtures/${f}`).sort();
  assert.deepEqual(manifest.map((m) => m.rel), files);
  for (const m of manifest) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, m.rel))).digest('hex');
    assert.equal(sha, m.sha256, m.rel);
  }
});

test('every fixture holds the layout its schema names, and the README counts them as they are', () => {
  const top = Object.keys(schema.properties);
  const expectedKeys = Object.keys(schema.properties.expected.properties);
  const categories = schema.properties.expected.properties.rejectCategory.enum;
  const name = new RegExp(schema.properties.name.pattern);
  for (const { rel, doc } of fixtures) {
    for (const k of schema.required) assert.ok(k in doc, `${rel}: ${k}`);
    for (const k of Object.keys(doc)) assert.ok(top.includes(k), `${rel}: ${k} is not in the layout`);
    assert.equal(('request' in doc) + ('derivation' in doc), 1, `${rel}: one object under test`);
    assert.match(doc.name, name, rel);
    assert.equal(`fixtures/${doc.name.slice('mission-02/'.length)}.json`, rel);
    assert.deepEqual(doc.keypairRefs, [], rel);
    for (const k of schema.properties.verifierState.required) assert.ok(k in doc.verifierState, `${rel}: verifierState.${k}`);
    for (const k of Object.keys(doc.expected)) assert.ok(expectedKeys.includes(k), `${rel}: expected.${k}`);
    if (doc.expected.verifyResult === 'REJECT') {
      assert.ok(categories.includes(doc.expected.rejectCategory), `${rel}: ${doc.expected.rejectCategory}`);
      assert.ok(doc.expected.reasonContains, rel);
    } else {
      assert.equal(doc.expected.verifyResult, 'ACCEPT', rel);
      assert.equal('rejectCategory' in doc.expected || 'reasonContains' in doc.expected, false, rel);
    }
  }
  const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
  const line = `${fixtures.length} fixtures: ${fixtures.length - derivations.length} for the payment API, ${derivations.length} for the derivation rule.`;
  assert.ok(readme.includes(line), line);
});

for (const { doc } of derivations) {
  const e = doc.expected;
  test(`${doc.name}: ${e.verifyResult === 'ACCEPT' ? 'derived' : `refused with ${e.error}, ${e.rejectCategory}`}`, () => {
    const s = doc.verifierState;
    const mission = s.missions.find((m) => m.id === doc.derivation.missionId);
    const r = deriveUnderMission({
      mission,
      requested: doc.derivation.authorization_details,
      now: new Date(Date.parse(s.clockRfc3339)),
      narrowing: s.declaredNarrowing,
    });
    if (e.verifyResult === 'ACCEPT') {
      assert.equal(r.derived, true, r.reason);
      assert.deepEqual(r.entries, doc.derivation.authorization_details);
    } else {
      assert.equal(r.derived, false);
      assert.equal(r.error, e.error);
      assert.equal(r.category, e.rejectCategory);
      assert.ok(r.reason.includes(e.reasonContains), r.reason);
    }
  });
}
