// A test's stand in for sandbox-exec applies the profile it is handed before
// it execs the process that runs the demo's code: the stand in root, which
// imports the demo's channel, or Node.js with the counter that NODE_OPTIONS
// loads. Read as code, every stand in line in the test tree that execs "$3"
// does so through sandbox-exec -f "$2". Each such line is then started the
// way the offline check starts its root (-f, the rerun's profile file,
// Node.js and the rerun file, with the check's environment), and the kernel
// reads its process sandboxed, from outside, at the moment the process shows
// it runs the demo's code: when the counter's hello line appears, and when
// the stand in root has answered ready and still waits. In the same reading
// the runner reads unsandboxed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childEnv } from '../src/orchestrator/env.mjs';
import { freeLoopbackPort } from '../src/orchestrator/ports.mjs';
import { componentProfile, realExecPath, sandboxStatus, writeProfile } from '../src/orchestrator/sandbox.mjs';
import { scan, trackedFiles } from './support/closure.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); a stand in applies the profile it is handed';
const READER = path.join(ROOT, 'test', 'support', 'pid-sandboxed.py');
const RERUN = path.join(ROOT, 'src', 'egress', 'rerun.mjs');
const STAND_IN_ROOT = path.join(ROOT, 'test', 'fixtures', 'egress', 'stand-in-root.mjs');
const APPLIED = 'sandbox-exec -f "$2" "$3"';
// This file names the stand in form in its own literals, so the walk leaves
// it out.
const SELF = 'test/stand-in-profile.test.mjs';
const code = [...trackedFiles(ROOT)].filter((f) => f !== SELF && f.startsWith('test/') && /\.(mjs|cjs|js)$/.test(f)).sort();

// Every code literal in the test tree that holds "$3": the stand in lines.
function standInLines(reader = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')) {
  const found = [];
  for (const f of code) for (const l of scan(reader(f)).literals) if (l.value.includes('"$3"')) found.push({ file: f, ...l });
  return found;
}

test('every stand in line that execs "$3" does so through sandbox-exec -f "$2", and the walk flags a line that does not', (t) => {
  const lines = standInLines();
  t.diagnostic(lines.map((l) => `${l.file}:${l.line}`).join(', '));
  assert.ok(lines.length > 0);
  assert.deepEqual(lines.filter((l) => !l.value.includes(APPLIED)).map((l) => `${l.file}:${l.line}`), []);
  const before = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replaceAll(`/usr/bin/sandbox-exec -f "$2" "$3"`, '"$3"');
  assert.equal(standInLines(before).filter((l) => !l.value.includes(APPLIED)).length, lines.length, 'each line, written without the apply, is flagged');
});

// The line's own text, with each ${...} part filled as its test fills it.
function instantiate(l, values) {
  let i = 0;
  return l.value.replace(/\$\{\}/g, () => {
    const expr = l.exprs[i];
    i += 1;
    if (!Object.hasOwn(values, expr)) throw new Error(`${l.file}:${l.line}: no value for \${${expr}}`);
    return values[expr];
  });
}

test('the process each stand in execs reads sandboxed in the kernel while it runs, and the runner reads unsandboxed in the same reading', async (t) => {
  assert.equal(sandboxStatus().available, true, PRE);
  const lines = standInLines();
  assert.ok(lines.length > 0);
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/bank-demo-test-'));
  try {
    const unread = [];
    for (const [n, l] of lines.entries()) {
      const runDir = path.join(dir, `run-${n}`);
      const offlineDir = path.join(runDir, 'offline');
      const sentinelDir = path.join(offlineDir, 'sentinel');
      const home = path.join(offlineDir, 'home');
      for (const d of [runDir, offlineDir, sentinelDir, home]) fs.mkdirSync(d, { mode: 0o700 });
      const ports = [await freeLoopbackPort(), await freeLoopbackPort(), await freeLoopbackPort()];
      const profileFile = writeProfile(path.join(runDir, 'egress.sb'), componentProfile({ runId: `k${n}`, execPath: realExecPath(), tcpPorts: ports, unixSubpath: runDir, sentinelDir }));
      const standIn = path.join(runDir, 'sandbox-exec');
      const line = l.template ? instantiate(l, { STAND_IN_ROOT, pidFile: path.join(runDir, 'pid') }) : l.value;
      fs.writeFileSync(standIn, ['#!/bin/sh', line, ''].join('\n'), { mode: 0o700 });
      const egressLog = path.join(runDir, 'egress.jsonl');
      // The counter loads unless the line drops NODE_OPTIONS; the stand in
      // root answers a request on its stdin.
      const counter = !line.includes('-u NODE_OPTIONS');
      const root = line.includes(STAND_IN_ROOT);
      const r = spawnSync('/usr/bin/python3', ['-I', READER], {
        input: JSON.stringify({ argv: [standIn, '-f', profileFile, realExecPath(), RERUN], env: childEnv({ home, egressLog }), cwd: offlineDir, control: process.pid, helloFile: counter ? egressLog : null, ask: root ? JSON.stringify({ id: 1, op: 'ready' }) : null, timeoutSeconds: 60 }),
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LANG: 'C', TZ: 'UTC' },
        timeout: 120000,
      });
      assert.equal(r.status, 0, r.stderr);
      const reading = JSON.parse(r.stdout.trim().split('\n').pop());
      t.diagnostic(`${l.file}:${l.line} hello ${reading.hello} answer ${reading.answer} readings ${JSON.stringify(reading.readings)} exit ${reading.exitCode} control ${reading.control}`);
      assert.equal(reading.control, 0, 'the runner reads unsandboxed in the same reading');
      assert.ok(counter || root, `${l.file}:${l.line}: neither witness applies`);
      if ((counter && reading.hello !== 1) || (root && reading.answer !== 1)) unread.push(`${l.file}:${l.line}`);
    }
    assert.deepEqual(unread, [], 'a stand in whose process never read sandboxed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
