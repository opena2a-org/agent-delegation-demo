// What every answer of the offline check that was not run holds: one reason
// from the closed list, no count and no placeholder in its place, no decision
// labelled same, and a result line with no digit, 0 included. How
// sandbox-exec ended (the spawn error or the exit code, and the line its
// stderr starts with) is in the run log in the run directory, and in no
// string of the answer.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { offlineBlock } from '../../src/runner/offline-text.mjs';

// The three reasons, byte for byte as the screen prints them.
export const NO_SANDBOX = 'no macOS sandbox on this system';
export const OUTER = 'the demo is already inside another sandbox';
export const NOT_APPLIED = 'the sandbox could not be applied';

const NEEDS = {
  [NO_SANDBOX]: 'Why: the check needs the macOS sandbox; see Requirements in the README.',
  [OUTER]: 'Why: the check needs a terminal outside any other sandbox.',
  [NOT_APPLIED]: 'Why: the check needs its own sandbox, and macOS refused it.',
};

export function assertNotRun(r, reason) {
  assert.equal(r.status, 'not run');
  assert.equal(r.reason, reason);
  assert.deepEqual(r.reasons, [reason]);
  assert.equal(r.egressAttempts, null);
  assert.equal(r.allSame, false);
  assert.deepEqual(r.controls, []);
  for (const o of r.outcomes) assert.deepEqual([o.open, o.blocked, o.same], [null, null, null], `scenario ${o.scenario}`);
  for (const key of ['egress', 'decision2', 'openRun', 'detail', 'profileSha256']) assert.equal(key in r, false, `${key} in an answer that was not run`);
  const lines = offlineBlock(r).split('\n');
  assert.deepEqual(lines, ['Offline check: Not run', `  The four scenarios were not rerun (${reason}).`, `  ${NEEDS[reason]}`]);
  for (const line of lines) assert.equal(/\d/.test(line), false, `a digit in "${line}"`);
}

export function readRunLog(runDir) {
  return JSON.parse(fs.readFileSync(path.join(runDir, 'offline', 'not-run.json'), 'utf8'));
}

// No field of the answer holds how sandbox-exec ended, no string names
// sandbox-exec, an exit or the stderr line, and no number is the exit code.
export function assertEndNotInAnswer(r, { exitCode = null, stderr = null } = {}) {
  JSON.stringify(r, (key, value) => {
    assert.equal(/exit|stderr|signal|spawn|detail/i.test(key), false, `a field named ${key}`);
    if (typeof value === 'string') {
      assert.equal(value.includes('sandbox-exec'), false, value);
      assert.equal(/\bexit\b/.test(value), false, value);
      if (stderr) assert.equal(value.includes(stderr), false, value);
    }
    if (typeof value === 'number' && exitCode !== null) assert.notEqual(value, exitCode, `the exit code in ${key}`);
    return value;
  });
}
