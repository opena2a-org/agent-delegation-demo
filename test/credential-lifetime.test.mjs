// The pinned credential verifier, @opena2a/atx-verify at the version in
// package.json, on two credentials the demo's generator signs: one issued
// eight days before the verifier's clock, and a control identical except that
// it was issued one day before. Both expire one day after the clock. At this
// pin both are accepted: the verifier bounds a credential by its expiry time
// alone. EXPIRED on the eight day credential with the control accepted means
// the verifier has gained ATX's seven day limit, and the limit line that
// describes it is rewritten in the same change; any other result is a broken
// check.

import './support/outer-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalAtxVerifier } from '@opena2a/atx-verify';
import { loadTrust } from '../src/bank/broker.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));
const pins = JSON.parse(read('vendor/pins.json'));
const pkg = JSON.parse(read('package.json'));
const installed = JSON.parse(read('node_modules/@opena2a/atx-verify/package.json'));
const EIGHT = 'test/fixtures/atx-lifetime/lifetime-issued-8-days-before.atx.json';
const ONE = 'test/fixtures/atx-lifetime/lifetime-issued-1-day-before.atx.json';
const eight = JSON.parse(read(EIGHT));
const one = JSON.parse(read(ONE));
const NOW = Date.parse('2026-05-23T00:00:00Z');
const DAY = 86400 * 1000;
const trust = loadTrust(path.join(ROOT, 'fixtures/issuer/trust.json'));
const verifyAt = (credential, at) => new LocalAtxVerifier({ ...trust, now: () => new Date(at) }).verify(credential);
const verdict = (v) => (v.valid ? 'ACCEPT' : v.rejectCategory);

test('the two credentials are the generator\'s, at the pin record, and identical except issuedAt and the signature', () => {
  assert.equal(installed.version, pkg.dependencies['@opena2a/atx-verify'], 'the installed verifier is the version package.json pins');
  for (const rel of [EIGHT, ONE]) {
    assert.equal(crypto.createHash('sha256').update(read(rel)).digest('hex'), pins.atxConformance.lifetimeCheckCredentials[rel], rel);
  }
  assert.equal(Date.parse(eight.issuedAt), NOW - 8 * DAY);
  assert.equal(Date.parse(one.issuedAt), NOW - 1 * DAY);
  for (const c of [eight, one]) assert.equal(Date.parse(c.expiresAt), NOW + 1 * DAY);
  const rest = ({ issuedAt: _i, signatures: _s, ...r }) => r;
  assert.deepEqual(rest(eight), rest(one));
});

test('credential lifetime at this pin: a credential issued eight days before the verifier\'s clock is accepted, beside its control issued one day before', () => {
  const control = verdict(verifyAt(one, NOW));
  const longer = verdict(verifyAt(eight, NOW));
  assert.equal(control, 'ACCEPT', 'the control must be accepted, or the check is broken');
  assert.notEqual(longer, 'EXPIRED', 'the verifier now refuses a credential older than seven days: rewrite the credential lifetime limit line in this change');
  assert.equal(longer, 'ACCEPT', `${longer} is neither result this check knows: the check is broken`);
});

test('the clock is the one the check sets: two days after it, both credentials are refused as EXPIRED', () => {
  assert.equal(verdict(verifyAt(one, NOW + 2 * DAY)), 'EXPIRED');
  assert.equal(verdict(verifyAt(eight, NOW + 2 * DAY)), 'EXPIRED');
});
