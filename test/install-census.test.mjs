// The installed tree has nothing to run at install time: no package declares
// an install script, none carries a binding.gyp, the root declares no install
// hook, and the lockfile flags no install script. The same walker, in the
// same run, counts 2 on a fixture tree that has one of each, so a walk that
// saw nothing is never read as a clean tree.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_INSTALL_STEPS, censusLine, controlProblems, installCensus, writeCensusFixture } from './support/census.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-census-'));
  try {
    return fn(writeCensusFixture(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('install census: scripts 0, gyp 0, lockfile flags 0 on the installed tree, and 2 on the fixture tree in the same run', (t) => {
  const demo = installCensus(ROOT);
  t.diagnostic(`installed tree: ${censusLine(demo)}`);
  assert.deepEqual(demo.scripted, []);
  assert.deepEqual(demo.gyp, []);
  assert.deepEqual(demo.lockfileFlags, []);
  assert.deepEqual(demo.rootHooks, []);
  assert.deepEqual(demo.noManifest, []);

  // The walk reached the installed tree: every installed lockfile entry has
  // a walked directory, and every walked directory has a lockfile entry.
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const required = Object.entries(lock.packages).filter(([k, v]) => k !== '' && v.optional !== true).map(([k]) => k);
  assert.ok(required.length > 0);
  for (const k of required) assert.ok(demo.packages.includes(k), `${k} is installed and walked`);
  for (const p of demo.packages) assert.ok(Object.hasOwn(lock.packages, p), `${p} has a lockfile entry`);

  const fixture = withFixture((dir) => installCensus(dir));
  t.diagnostic(`fixture tree: ${fixture.installSteps} (${censusLine(fixture)})`);
  assert.equal(fixture.installSteps, FIXTURE_INSTALL_STEPS);
  assert.deepEqual(controlProblems(fixture), []);
});

test('install census mutants: a walker that reads the lockfile alone counts 1 on the fixture, and so does one that skips nested node_modules; each fails the control', () => {
  withFixture((dir) => {
    const lockfileAlone = (root) => {
      const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
      return { installSteps: Object.entries(lock.packages).filter(([k, v]) => k !== '' && v.hasInstallScript === true).length };
    };
    const topLevelAlone = (root) => {
      const c = installCensus(root);
      const top = (p) => p.split('/node_modules/').length === 1;
      return { installSteps: new Set([...c.scripted, ...c.gyp].filter(top)).size };
    };
    for (const [name, walker] of [['lockfile alone', lockfileAlone], ['top level alone', topLevelAlone]]) {
      const c = walker(dir);
      assert.equal(c.installSteps, 1, name);
      assert.notDeepEqual(controlProblems(c), [], name);
    }
  });
});
