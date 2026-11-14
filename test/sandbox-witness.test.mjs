// The sandbox witness reads, from outside and while the processes run, the
// kernel's record of each process a run records (sandbox_check in
// libsystem_sandbox). Each process is sandboxed; reads and writes on the
// credential store paths and exec of the keychain tool are refused to it; an
// unsandboxed process reads 0 on the same queries and an allowed path reads
// 0. A reading of -1 is never taken as allowed or refused. A path that does
// not exist reads 1 for an unsandboxed process too, so a store reading counts
// when the unsandboxed control reads 0 on that path, and otherwise the
// sentinel reading with the profile text stands in, or the reading is
// inconclusive.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DemoRun, makeRunDir } from '../src/orchestrator/run.mjs';
import { SANDBOX_EXEC, componentProfile, realExecPath, resolvedPath, sandboxStatus, writeProfile } from '../src/orchestrator/sandbox.mjs';
import { judge, readKernel, witness, witnessLines } from '../scripts/checks/sandbox-witness.mjs';

const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); the witness reads the kernel record of sandboxed processes';
const PATHS = /\((?:subpath|literal) "((?:[^"\\]|\\.)*)"\)/g;
const STORE_READ = '<real HOME>/.secretless-ai file-read-data';

// A process that runs no demo or package code: it writes one line and waits.
// The mutant launcher starts it where the bank would run.
const STAND_IN = ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1 << 30);"];
function startStandIn(profileFile) {
  const execPath = realExecPath();
  const [cmd, args] = profileFile ? [SANDBOX_EXEC, ['-f', profileFile, execPath, ...STAND_IN]] : [execPath, STAND_IN];
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LANG: 'C', TZ: 'UTC' } });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const ready = new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    exited.then((code) => reject(new Error(`the stand-in exited (${code})`)));
  });
  return { pid: child.pid, ready, stop: () => { child.kill('SIGTERM'); return exited; } };
}

function scratch() {
  const dir = makeRunDir('bank-demo-test-');
  const sentinel = path.join(dir, 'control', 'sentinel');
  fs.mkdirSync(sentinel, { recursive: true, mode: 0o700 });
  return { dir, sentinel };
}

test('witness over a run: each recorded process is sandboxed, with the store paths and the keychain tool refused to it, read from outside with the unsandboxed control at 0 and an allowed path at 0', async (t) => {
  assert.equal(sandboxStatus().available, true, PRE);
  const run = await DemoRun.create();
  try {
    const targets = run.pids().map(({ name, pid }) => ({ name, pid, profileFile: path.join(run.dirs.profiles, `${name}.sb`) }));
    assert.deepEqual(targets.map((x) => x.name).sort(), ['agent-a-billpay', 'agent-a-budget', 'agent-b-billpay', 'agent-b-budget', 'bank']);
    const seen = witness({ targets, sentinel: run.dirs.sentinel });
    for (const line of witnessLines(seen)) t.diagnostic(line);
    assert.equal(seen.verdict, 'pass', seen.problems.join('; '));
    for (const x of targets) {
      for (const m of fs.readFileSync(x.profileFile, 'utf8').matchAll(PATHS)) {
        const p = m[1].replace(/\\(.)/g, '$1');
        assert.equal(resolvedPath(p), p, `${x.name}: a profile path is written resolved`);
      }
    }
  } finally {
    await run.stop();
  }
});

test('witness mutant: a launcher that starts the bank without its profile fails it, because sandbox_check(pid, NULL, 0) reads 0', async (t) => {
  assert.equal(sandboxStatus().available, true, PRE);
  const { dir, sentinel } = scratch();
  const profileFile = writeProfile(path.join(dir, 'bank.sb'), componentProfile({ runId: 'witness', execPath: realExecPath(), sentinelDir: sentinel }));
  const withProfile = startStandIn(profileFile);
  const withoutProfile = startStandIn(null);
  try {
    await Promise.all([withProfile.ready, withoutProfile.ready]);
    const seen = witness({
      targets: [
        { name: 'bank under its profile', pid: withProfile.pid, profileFile },
        { name: 'bank started without its profile', pid: withoutProfile.pid, profileFile },
      ],
      sentinel,
    });
    for (const line of witnessLines(seen)) t.diagnostic(line);
    assert.equal(seen.targets[0].verdict, 'pass');
    assert.equal(seen.targets[1].verdict, 'fail');
    assert.equal(seen.targets[1].readings.sandboxed, 0);
    assert.equal(seen.verdict, 'fail');
  } finally {
    await withProfile.stop();
    await withoutProfile.stop();
  }
});

test('a reading of -1 is never taken as allowed or refused: the process-exec spelling reads -1 for a sandboxed and a plain process, and a -1 in a judged reading is inconclusive', async () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const { dir, sentinel } = scratch();
  const profileFile = writeProfile(path.join(dir, 'bank.sb'), componentProfile({ runId: 'witness', execPath: realExecPath(), sentinelDir: sentinel }));
  const standIn = startStandIn(profileFile);
  try {
    await standIn.ready;
    const k = readKernel([
      ['sandboxed, process-exec', standIn.pid, 'process-exec', '/usr/bin/security'],
      ['plain, process-exec', process.pid, 'process-exec', '/usr/bin/security'],
      ['sandboxed, process-exec*', standIn.pid, 'process-exec*', '/usr/bin/security'],
      ['plain, process-exec*', process.pid, 'process-exec*', '/usr/bin/security'],
    ]);
    assert.equal(k.ok, true, k.reason);
    assert.deepEqual(k.results, { 'sandboxed, process-exec': -1, 'plain, process-exec': -1, 'sandboxed, process-exec*': 1, 'plain, process-exec*': 0 });
    const seen = witness({ targets: [{ name: 'stand-in', pid: standIn.pid, profileFile }], sentinel });
    assert.equal(seen.verdict, 'pass', seen.problems.join('; '));
    for (const id of ['t0:keychain tool', 't0:sandboxed', 'control:sandboxed', `control:${STORE_READ}`]) {
      const raw = structuredClone(seen.raw);
      raw.results[id] = -1;
      assert.equal(judge(raw).verdict, 'inconclusive', id);
    }
    const raw = structuredClone(seen.raw);
    raw.results['t0:sandboxed'] = 0;
    assert.equal(judge(raw).verdict, 'fail');
  } finally {
    await standIn.stop();
  }
});

test('a store path that does not exist reads 1 for an unsandboxed process too, so it does not count: the sentinel reading with the profile text stands in, and without them the witness is inconclusive', async (t) => {
  assert.equal(sandboxStatus().available, true, PRE);
  const { dir, sentinel } = scratch();
  const home = path.join(dir, 'home-without-a-store');
  fs.mkdirSync(home, { mode: 0o700 });
  const profileFile = writeProfile(path.join(dir, 'bank.sb'), componentProfile({ runId: 'witness', execPath: realExecPath(), home, sentinelDir: sentinel }));
  const standIn = startStandIn(profileFile);
  try {
    await standIn.ready;
    const target = { name: 'stand-in', pid: standIn.pid, profileFile };
    const seen = witness({ targets: [target], home, sentinel });
    for (const line of witnessLines(seen)) t.diagnostic(line);
    assert.equal(seen.raw.results[`control:${STORE_READ}`], 1, 'the unsandboxed control reads 1 on a path that does not exist');
    assert.equal(seen.targets[0].readings[STORE_READ], 'by the sentinel and the profile text');
    assert.equal(seen.verdict, 'pass', seen.problems.join('; '));
    assert.equal(witness({ targets: [target], home, sentinel: null }).verdict, 'inconclusive', 'no sentinel reading');
    const bare = path.join(dir, 'bare.sb');
    fs.writeFileSync(bare, fs.readFileSync(profileFile, 'utf8').replace(/ \(subpath "[^"]*\/(\.secretless-ai|Library\/Keychains)"\)/g, ''));
    assert.equal(witness({ targets: [{ ...target, profileFile: bare }], home, sentinel }).verdict, 'inconclusive', 'a profile text that does not name the store');
  } finally {
    await standIn.stop();
  }
});

test('witness mutant: a profile without the store deny fails it where the store path exists, and never passes', async (t) => {
  assert.equal(sandboxStatus().available, true, PRE);
  const { dir, sentinel } = scratch();
  const text = componentProfile({ runId: 'witness', execPath: realExecPath(), sentinelDir: sentinel }).replace(/ \(subpath "[^"]*\/(\.secretless-ai|Library\/Keychains)"\)/g, '');
  const profileFile = writeProfile(path.join(dir, 'bank.sb'), text);
  const standIn = startStandIn(profileFile);
  try {
    await standIn.ready;
    const seen = witness({ targets: [{ name: 'stand-in', pid: standIn.pid, profileFile }], sentinel });
    for (const line of witnessLines(seen)) t.diagnostic(line);
    assert.notEqual(seen.verdict, 'pass');
    if (seen.raw.results[`control:${STORE_READ}`] === 0) assert.equal(seen.verdict, 'fail');
  } finally {
    await standIn.stop();
  }
});
