// A run directory given to the launcher is used by its resolved path, as a
// made one is: the grant path agent's sandbox profile names the broker
// socket's directory by path, and the sandbox matches the socket's resolved
// path. Here the given directory is a symbolic link to a made one.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INVOICES } from '../src/config.mjs';
import { DemoRun, makeRunDir } from '../src/orchestrator/run.mjs';

const R = {};
let run;
let link;

before(async () => {
  const real = makeRunDir('bank-demo-linked-');
  link = path.join(fs.realpathSync(os.tmpdir()), `bank-demo-link-${crypto.randomBytes(6).toString('hex')}`);
  fs.symlinkSync(real, link);
  R.real = real;
  run = await DemoRun.create({ runDir: link });
  R.runDir = run.runDir;
  R.sockDir = run.dirs.sock;
  R.sandbox = run.sandbox;
  const profile = path.join(run.dirs.profiles, 'agent-b-billpay.sb');
  R.profile = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : null;
  assert.equal(await run.customerSignIn('B'), true);
  await run.approve('billpay');
  R.grant = JSON.parse(fs.readFileSync(path.join(run.agentDir('B', 'billpay'), 'grant.json'), 'utf8'));
  R.paid = await run.agentTask('B', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
});

after(async () => {
  if (run) await run.stop();
  if (link) fs.unlinkSync(link);
});

test('a run directory given as a symbolic link is used by its resolved path', () => {
  assert.notEqual(R.real, link);
  assert.equal(R.runDir, R.real);
  assert.equal(R.sockDir, path.join(R.real, 'sock'));
  assert.equal(R.grant.socketPath, path.join(R.real, 'sock', 'broker.sock'));
});

test('the grant path agent\'s profile allows the broker socket directory by its resolved path, and never by the link', () => {
  assert.equal(R.sandbox.applied, true, 'precondition: /usr/bin/sandbox-exec (macOS); this check needs the OS sandbox and does not run without it');
  assert.ok(R.profile.includes(`(allow network-outbound (remote unix-socket (subpath "${path.join(R.real, 'sock')}")))`));
  assert.equal(R.profile.includes(link), false);
});

test('with that run directory, the grant path agent reaches the broker over its socket under its sandbox, and City Water is paid', () => {
  assert.equal(R.paid.answer.step, 'bank');
  assert.equal(R.paid.answer.status, 200);
});
