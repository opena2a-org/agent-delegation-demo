// The seeded control must fail when run alone: an arm that passed would mean
// the by-value check of test/path-b.test.mjs does not read that file. Each
// arm's failure must name the place and the kind of value, and the control's
// output must carry no 64 hex value: a failure names where, never the value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTROL = 'test/controls/seeded-broker-token-in-agent-log.mjs';
const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', CONTROL], { cwd: ROOT, encoding: 'utf8', env, timeout: 180000 });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const shown = () => out.replace(/[0-9a-f]{64}/g, '<64 hex>').slice(-3000);

test('the seeded control fails when run alone: both arms fail and none passes', () => {
  assert.equal(r.status, 1, shown());
  assert.match(out, /^# pass 0$/m, shown());
  assert.match(out, /^# fail 2$/m, shown());
});

test('arm 1 fails on the broker token in the bill pay agent\'s agent.log', () => {
  assert.match(out, /^not ok 1 - arm 1: /m, shown());
  assert.ok(out.includes('agent-b-billpay/agent.log (broker token)'), shown());
});

test('arm 2 fails on an access token in the bill pay agent\'s stderr.log', () => {
  assert.match(out, /^not ok 2 - arm 2: /m, shown());
  assert.ok(out.includes('agent-b-billpay/stderr.log (access token)'), shown());
});

test('the control\'s output carries no 64 hex value', () => {
  assert.equal(/[0-9a-f]{64}/.test(out), false);
});
