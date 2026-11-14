// The bank's broker never falls back to defaults under HOME, and its
// /resolve route can never hand out a credential. Each cell runs inside the
// sandbox profile; each mutant is built in the cell script, never in src.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSandboxed } from './support/sandboxed.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CELLS = path.join(HERE, 'support/broker-cells.mjs');

test('HOME witness: the bank broker creates nothing under an empty HOME', () => {
  const r = runSandboxed(CELLS, { args: ['home', 'bank'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.secretlessDirInHome, false);
  assert.equal(r.json.homeEntries, 0);
});

test('HOME witness mutant: a broker config without tokenFile makes $HOME/.secretless-ai appear', () => {
  const r = runSandboxed(CELLS, { args: ['home', 'no-token-file'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.secretlessDirInHome, true);
});

test('HOME witness, resolver case: a broker built without the refusing resolver creates the store under HOME', () => {
  const r = runSandboxed(CELLS, { args: ['home', 'no-resolver'] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.secretlessDirInHome, true);
  assert.ok(r.json.homeEntries > 0, `homeEntries ${r.json.homeEntries}`);
});

test('/resolve: the bank broker answers 404 for a name its policy allows, without the value', () => {
  const name = `CELL_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const value = crypto.randomBytes(12).toString('hex');
  const r = runSandboxed(CELLS, { args: ['resolve', 'bank', name], env: { [name]: value } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 404);
  assert.equal(r.json.bodyCarriesCanary, false);
});

test('/resolve mutant: a broker built without the refusing resolver answers 200 with the value', () => {
  const name = `CELL_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
  const value = crypto.randomBytes(12).toString('hex');
  const r = runSandboxed(CELLS, { args: ['resolve', 'no-resolver', name], env: { [name]: value } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.status, 200);
  assert.equal(r.json.bodyCarriesCanary, true);
});
