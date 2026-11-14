// The re-pin arms on the pinned verifier. The bank's accept rule reads the
// verifier's stdout, and that reading is a contract for the bytes pinned in
// vendor/pins.json and no others. So these arms run on the vendored file
// before any test that uses the pin (this file sorts ahead of every other in
// the test script's pattern), and a re-pin runs them again and updates this
// table in the same change.
// The expected values are the ones measured at the pin a4ab3d9e27bf. Each
// cell runs inside the sandbox profile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSandboxed } from './support/sandboxed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cells = runSandboxed(path.join(HERE, 'support/verifier-arms.mjs'));
const o = cells.json;

const PASS = 'summary: 1 pass, 0 fail (1 fixtures)';
const FAIL = 'summary: 0 pass, 1 fail (1 fixtures)';
const BAD_SIGNATURE = 'observed: REJECT[BAD_SIGNATURE';

// exitCode, the observed lines (equal, or by prefix), the summary line, the
// bank's input check, and the bank's accept rule on the verifier's output.
const EXPECTED = {
  v1: { name: 'valid token, expected ACCEPT', exitCode: 0, observed: ['observed: ACCEPT'], summary: PASS, inputSound: true, accepted: true },
  v2: { name: 'signature altered, expected ACCEPT', exitCode: 1, observedPrefix: [BAD_SIGNATURE], summary: FAIL, inputSound: true, accepted: false },
  v3: { name: 'signature altered, expected removed', exitCode: 0, observedPrefix: [BAD_SIGNATURE], summary: PASS, inputSound: false, accepted: false },
  v4: { name: 'signature altered, expected ACCEPTED', exitCode: 0, observedPrefix: [BAD_SIGNATURE], summary: PASS, inputSound: false, accepted: false },
  v5a: { name: 'valid token past its exp, clock removed', exitCode: 0, observed: ['observed: ACCEPT'], summary: PASS, inputSound: false, accepted: true },
  v5b: { name: 'valid token past its exp, clock set to now', exitCode: 1, observedPrefix: ['observed: REJECT[EXPIRED'], summary: FAIL, inputSound: true, accepted: false },
  G: { name: 'header member named with an observed: ACCEPT line, expected removed', exitCode: 0, observedPrefix: ['observed: REJECT[UNKNOWN_HEADER_PARAM: header: unknown header parameter "x', 'observed: ACCEPT'], summary: PASS, inputSound: false, accepted: false },
};

test('the arms ran on the vendored verifier at its pinned bytes, and this table was measured at that pin', () => {
  assert.equal(cells.status, 0, cells.stderr);
  assert.ok(o);
  assert.equal(o.vendoredSha256Matches, true);
  assert.equal(o.pinnedCommit.slice(0, 12), 'a4ab3d9e27bf', 'a re-pin runs these arms again and updates this table in the same change');
  assert.deepEqual(Object.keys(o.arms), Object.keys(EXPECTED));
});

for (const [arm, e] of Object.entries(EXPECTED)) {
  test(`arm ${arm}, ${e.name}: exit ${e.exitCode}, ${e.summary.slice('summary: '.length)}; input ${e.inputSound ? 'sound' : 'refused'}, accept rule ${e.accepted ? 'accepts' : 'refuses'}`, () => {
    const a = o.arms[arm];
    assert.equal(a.exitCode, e.exitCode);
    if (e.observed) assert.deepEqual(a.observed, e.observed);
    else {
      assert.equal(a.observed.length, e.observedPrefix.length, JSON.stringify(a.observed));
      e.observedPrefix.forEach((p, i) => assert.ok(a.observed[i].startsWith(p), a.observed[i]));
    }
    assert.equal(a.summary, e.summary);
    assert.equal(a.inputSound, e.inputSound);
    assert.equal(a.accepted, e.accepted);
  });
}

test('the bank accepts one arm, v1: an input it wrote itself, with an output that reads ACCEPT once', () => {
  const bankAccepts = Object.entries(o.arms).filter(([, a]) => a.inputSound && a.accepted).map(([arm]) => arm);
  assert.deepEqual(bankAccepts, ['v1']);
});
