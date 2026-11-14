// The rules around the offline check that hold in the source: one reason for
// each way sandbox-exec ends before the rerun starts, the view server alone
// starts the rerun, the view server alone names the check's options and sets
// neither open nor chain, no step asks for elevation, the launcher does not
// check for the sandbox, and the rerun's profile carries the credential store
// denies under the account's own home and the keychain tool's own exec deny
// rule, beside the exec deny form. These need no sandbox, so they also run on
// Linux.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as classify from '../src/egress/classify.mjs';
import { componentProfile } from '../src/orchestrator/sandbox.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function filesUnder(rel) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(child));
    else out.push(child);
  }
  return out;
}

test('each way sandbox-exec ends before the hello line has one reason: ENOENT; exit 71 with the sandbox_apply line; any other end, 65 included', () => {
  const { notRunReason } = classify;
  assert.equal(typeof notRunReason, 'function', 'one function maps how sandbox-exec ended to its reason');
  const apply = 'sandbox-exec: sandbox_apply: Operation not permitted';
  assert.equal(notRunReason({ spawnError: 'ENOENT' }), 'no macOS sandbox on this system');
  assert.equal(notRunReason({ exitCode: 71, stderr: apply }), 'the demo is already inside another sandbox');
  for (const end of [
    { spawnError: 'EACCES' },
    { exitCode: 71, stderr: 'sandbox-exec: something else' },
    { exitCode: 71, stderr: null },
    { exitCode: 65, stderr: "sandbox-exec: syntax error: expecting ')'" },
    { exitCode: 65, stderr: apply },
    { exitCode: 0, stderr: null },
    { exitCode: 1, stderr: null },
    { exitCode: null, signal: 'SIGKILL', stderr: null },
  ]) {
    assert.equal(notRunReason(end), 'the sandbox could not be applied', JSON.stringify(end));
  }
  assert.deepEqual(Object.values(classify.NOT_RUN ?? {}), ['no macOS sandbox on this system', 'the demo is already inside another sandbox', 'the sandbox could not be applied']);
});

test('the view server alone starts the rerun: no other module, script or command calls the offline check or names the rerun file', () => {
  const sources = [...filesUnder('src'), ...filesUnder('bin'), ...filesUnder('scripts')].filter((f) => /\.(mjs|cjs|js|sh)$/.test(f));
  const callers = sources.filter((f) => /runOfflineCheck(WithRun)?\(/.test(read(f)) && f !== path.join('src', 'egress', 'offline.mjs'));
  assert.deepEqual(callers, [path.join('src', 'server', 'main.mjs')]);
  const importers = sources.filter((f) => /from '[./]*(egress\/)?offline\.mjs'/.test(read(f)));
  assert.deepEqual(importers, [path.join('src', 'server', 'main.mjs')]);
  const rerunNamed = sources.filter((f) => read(f).includes('rerun.mjs'));
  assert.deepEqual(rerunNamed.sort(), [path.join('src', 'egress', 'offline.mjs'), path.join('src', 'egress', 'rerun.mjs')]);
  const scripts = Object.values(JSON.parse(read('package.json')).scripts).join('\n');
  assert.equal(/offline|rerun|sandbox/.test(scripts), false, scripts);
});

// The paths, sorted, whose text names the offline check's options.
function offlineOptionsNamers(pairs) {
  return pairs.filter(([, text]) => /\bofflineOptions\b/.test(text)).map(([f]) => f).sort();
}

test('B9 (p): the view server alone names the offline check\'s options and sets neither open nor chain; a launcher that set one would be named', () => {
  const pairs = [...filesUnder('src'), ...filesUnder('bin'), ...filesUnder('scripts')].filter((f) => /\.(mjs|cjs|js|sh)$/.test(f)).map((f) => [f, read(f)]);
  const server = path.join('src', 'server', 'main.mjs');
  assert.deepEqual(offlineOptionsNamers(pairs), [server]);
  const text = read(server);
  assert.equal(/\bopen\s*:\s*false/.test(text), false, 'the view server sets open: false');
  assert.equal(/\bchain\s*:/.test(text), false, 'the view server sets a chain');
  // The rule's own red: a launcher that passed open: false to the view
  // server would be named beside it.
  const launcher = [path.join('bin', 'start.mjs'), 'new ViewServer({ port, offlineOptions: { open: false } })'];
  assert.deepEqual(offlineOptionsNamers([...pairs, launcher]), [path.join('bin', 'start.mjs'), server]);
});

test('no step of the demo asks for elevation: none of sudo, osascript, pfctl, tcpdump or authopen in src or package.json', () => {
  for (const f of [...filesUnder('src'), 'package.json']) {
    const hits = read(f).split('\n').filter((line) => /sudo|osascript|pfctl|tcpdump|authopen/.test(line));
    assert.deepEqual(hits, [], f);
  }
});

test('npm start does not check for the sandbox at start: bin/start.mjs names neither the sandbox nor the egress modules', () => {
  const launcher = read('bin/start.mjs');
  assert.equal(/sandbox/i.test(launcher), false);
  // The launcher loads the connection counter and names the counter's file;
  // it names no other egress module.
  assert.deepEqual(launcher.match(/[\w./-]*egress[\w./-]*/g), ['src/egress/counter.cjs', 'egress.jsonl']);
});

test('the rerun profile: the credential store denies under the account home whatever HOME says, the exec deny form, exec allowed for this Node.js and nothing else, the keychain tool refused again in a rule of its own, and no wildcard port', () => {
  const home = fs.realpathSync(os.userInfo().homedir);
  const saved = process.env.HOME;
  process.env.HOME = path.join(os.tmpdir(), 'not-the-account-home');
  let profile;
  try {
    profile = componentProfile({
      runId: 'r1',
      execPath: '/opt/node/bin/node',
      tcpPorts: [4100, 4101, 4102],
      unixSubpath: '/r/run',
      sentinelDir: '/r/run/offline/sentinel',
    });
  } finally {
    process.env.HOME = saved;
  }
  const count = (s) => profile.split(s).length - 1;
  assert.ok(count('.secretless-ai') >= 1);
  assert.ok(count('Library/Keychains') >= 1);
  assert.ok(count('/usr/bin/security') >= 1);
  assert.equal(count('localhost:*'), 0);
  assert.equal(profile.includes('not-the-account-home'), false);
  const lines = profile.trim().split('\n');
  assert.ok(lines.includes(`(deny file-read* file-write* (subpath "${home}/.secretless-ai") (subpath "${home}/Library/Keychains") (subpath "/r/run/offline/sentinel"))`));
  assert.ok(lines.includes('(deny process-exec (literal "/usr/bin/security"))'));
  const allowExec = lines.filter((l) => l.startsWith('(allow process-exec'));
  assert.deepEqual(allowExec, ['(allow process-exec (literal "/opt/node/bin/node"))']);
  // In order: the exec deny form, this Node.js, the keychain tool. No exec
  // rule names anything else, so the offline rerun's exec control, a copy of
  // /usr/bin/true, is refused by the exec deny form alone.
  assert.deepEqual(lines.filter((l) => l.includes('process-exec')), [
    '(deny process-exec (with message "bank-demo-r1-exec"))',
    '(allow process-exec (literal "/opt/node/bin/node"))',
    '(deny process-exec (literal "/usr/bin/security"))',
  ]);
  assert.equal(lines.some((l) => l.startsWith('(allow') && l.includes('sandbox-exec')), false);
  // The writer reads the home directory from the user database, never from
  // HOME.
  assert.equal(/os\.homedir\(|process\.env\.HOME/.test(read('src/orchestrator/sandbox.mjs')), false);
});
