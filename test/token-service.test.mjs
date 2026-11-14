// The token service's accept rule and its jti store, each cell run inside the
// sandbox profile with real broker tokens from the reference implementation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSandboxed } from './support/sandboxed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cells = runSandboxed(path.join(HERE, 'support/token-cells.mjs'));
const o = cells.json;

test('token cells ran', () => {
  assert.equal(cells.status, 0, cells.stderr);
  assert.ok(o);
});

test('a valid broker token is accepted', () => assert.equal(o.valid, true));
test('a token with a forged signature is refused', () => assert.equal(o.forgedSignature, false));
test('an expired token is refused, with the clock set to the bank time', () => assert.equal(o.expired, false));
test('a token signed under an unknown key id is refused', () => assert.equal(o.unknownKid, false));
test('a replayed jti is refused', () => assert.equal(o.replay, false));
test('a replayed jti is refused after the service restarts (the jti store survives)', () => assert.equal(o.replayAfterRestart, false));
test('the writer always writes a sound input: cgt, expected ACCEPT, the bank clock, one key', () => assert.equal(o.writerOutputSound, true));
test('an input with no expected outcome is refused before the verifier runs', () => assert.equal(o.noExpectedSound, false));
test('an input that expects ACCEPTED is refused before the verifier runs', () => assert.equal(o.acceptedSpellingSound, false));
test('an input with no clock is refused before the verifier runs', () => assert.equal(o.noClockSound, false));
test('an input with a second key is refused before the verifier runs', () => assert.equal(o.twoKeysSound, false));
test('exit 0 alone is not acceptance: a matched REJECT exits 0 and is refused', () => {
  assert.equal(o.expectsRejectExit, 0);
  assert.equal(o.expectsRejectAccepted, false);
});
test('output without an observed line is refused', () => assert.equal(o.noObservedLineAccepted, false));
test('a real ACCEPT run passes the accept rule', () => assert.equal(o.validRunAccepted, true));
test('an "observed: ACCEPT" line printed inside a reject reason is not acceptance: with no expected outcome the run exits 0 and holds exactly one such line, and the accept rule refuses it', () => {
  const run = o.headerMemberRun;
  assert.ok(run, 'the header member cell ran');
  assert.equal(run.exitCode, 0);
  assert.equal(run.stdout.split('\n').filter((l) => l.trim() === 'observed: ACCEPT').length, 1);
  assert.equal(o.headerMemberAccepted, false);
});
test('no verifier input file (it holds a token) is left behind', () => assert.equal(o.inputFilesLeft, 0));
test('the refusal codes: a failed verification exits non zero, a replay is named', () => {
  assert.deepEqual(o.exchangeCodes, ['issued', 'exit', 'exit', 'exit', 'replay', 'replay']);
});
test('a wrong grant type, subject token type or requested token type is refused before the verifier runs; the same token is then accepted', () => {
  assert.equal(o.wrongGrantType, false);
  assert.equal(o.wrongSubjectTokenType, false);
  assert.equal(o.wrongRequestedTokenType, false);
  assert.equal(o.shapedTokenAcceptedAfter, true);
});
test('a token whose aud claim is not this service is refused', () => assert.equal(o.claimsAudMismatch, false));
test('an audience parameter that is not this service is refused', () => assert.equal(o.audienceParamMismatch, false));
test('a scope parameter that is not the token scope is refused', () => assert.equal(o.scopeParamMismatch, false));
test('the refusal codes of those cells: request for the shape, audience or scope for a mismatch', () => {
  assert.deepEqual(o.shapeCodes, ['request', 'request', 'request', 'issued', 'audience or scope', 'audience or scope', 'audience or scope']);
});
test('an access token is redeemed once: the second redeem returns nothing', () => {
  assert.equal(o.redeemOnce, true);
  assert.equal(o.redeemTwice, false);
});
test('an access token presented 61 seconds after issue is refused', () => assert.equal(o.redeemAfterExpiry, false));
