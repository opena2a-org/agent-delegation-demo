// Every path written into a sandbox profile is resolved before it is
// written: a rule whose path runs through a symbolic link (/tmp and /var on
// macOS) does not fire. The real home directory comes from the password
// database, the harness refuses to start when a credential store path is a
// symbolic link, and the sentinel and exec control paths go through the same
// resolving step as the store paths, so a writer that skips it shows up as a
// failed control.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as sandbox from '../src/orchestrator/sandbox.mjs';

const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); the controls run inside a sandbox profile and nowhere else';
const PATHS = /\((?:subpath|literal) "((?:[^"\\]|\\.)*)"\)/g;
const profilePaths = (text) => [...text.matchAll(PATHS)].map((m) => m[1].replace(/\\(.)/g, '$1'));

// A directory reached through the /tmp symbolic link.
function tmpAlias(prefix) {
  const dir = fs.mkdtempSync(`/tmp/${prefix}`);
  assert.notEqual(fs.realpathSync(dir), dir, 'precondition: /tmp is a symbolic link (macOS)');
  return dir;
}

function assertWrittenResolved(name, file, real) {
  const written = fs.readFileSync(file, 'utf8');
  const paths = profilePaths(written);
  assert.ok(paths.length >= 4, `${name}: ${paths.length} paths`);
  for (const p of paths) {
    assert.equal(sandbox.resolvedPath(p), p, `${name}: ${p}`);
    assert.equal(/^\/(tmp|var)\//.test(p), false, `${name}: ${p}`);
  }
  assert.ok(written.includes(`(subpath "${real}/sentinel")`), `${name}: the sentinel under its resolved path`);
}

test('resolvedPath: a path through /tmp resolves; a path that does not exist yet resolves its nearest existing parent and keeps the rest; a relative path is refused', () => {
  const dir = tmpAlias('bank-demo-resolve-');
  try {
    const real = fs.realpathSync(dir);
    assert.equal(sandbox.resolvedPath(dir), real);
    assert.equal(sandbox.resolvedPath(path.join(dir, 'not', 'yet')), path.join(real, 'not', 'yet'));
    assert.throws(() => sandbox.resolvedPath('relative/path'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real home directory comes from the password database, resolved, never from HOME', () => {
  const saved = process.env.HOME;
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-fake-home-'));
  try {
    process.env.HOME = fake;
    assert.equal(os.homedir(), fake);
    assert.equal(sandbox.realHome(), fs.realpathSync(os.userInfo().homedir));
    assert.notEqual(sandbox.realHome(), fs.realpathSync(fake));
  } finally {
    process.env.HOME = saved;
    fs.rmSync(fake, { recursive: true, force: true });
  }
});

test('the component profile, built from /tmp paths, is written naming resolved paths', () => {
  const dir = tmpAlias('bank-demo-c5-');
  try {
    for (const d of ['sentinel', 'sock', 'bank', 'home']) fs.mkdirSync(path.join(dir, d));
    const text = sandbox.componentProfile({
      runId: 'c5',
      execPath: process.execPath,
      tcpPorts: [9],
      unixSubpath: path.join(dir, 'sock'),
      denyReadSubpaths: [path.join(dir, 'bank')],
      home: path.join(dir, 'home'),
      sentinelDir: path.join(dir, 'sentinel'),
    });
    assertWrittenResolved('component', sandbox.writeProfile(path.join(dir, 'component.sb'), text), fs.realpathSync(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WR4: deniesWrite reads false on a component profile built with denyWriteSubpaths [] whose read rule names the bank directory, and true on one built with [<bank>]', () => {
  const bank = path.join(os.tmpdir(), 'bank-demo-wr4', 'bank');
  const built = (denyWriteSubpaths) => sandbox.componentProfile({
    runId: 'wr4',
    execPath: process.execPath,
    denyReadSubpaths: [bank],
    denyWriteSubpaths,
  });
  assert.equal(sandbox.deniesWrite(built([]), bank), false, 'built with []');
  assert.equal(sandbox.deniesWrite(built([bank]), bank), true, 'built with [<bank>]');
});

test('the harness profile, built from /tmp paths, is written naming resolved paths, with the store, the keychain tool and both controls', () => {
  const dir = tmpAlias('bank-demo-c5-');
  try {
    fs.mkdirSync(path.join(dir, 'sentinel'));
    fs.copyFileSync('/usr/bin/true', path.join(dir, 'true'));
    const text = sandbox.harnessProfile({ runId: 'c5', home: path.join(dir, 'home'), sentinelDir: path.join(dir, 'sentinel'), execControl: path.join(dir, 'true') });
    const file = sandbox.writeProfile(path.join(dir, 'harness.sb'), text);
    const real = fs.realpathSync(dir);
    assertWrittenResolved('harness', file, real);
    const written = fs.readFileSync(file, 'utf8');
    assert.ok(written.includes('(allow network-outbound (remote ip "localhost:*"))'));
    assert.ok(written.includes(`(deny process-exec (literal "/usr/bin/security") (literal "${real}/true"))`));
    assert.ok(sandbox.deniesReadWrite(written, `${real}/home/.secretless-ai`));
    assert.ok(sandbox.deniesReadWrite(written, `${real}/home/Library/Keychains`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the harness refuses to start when <real HOME>/.secretless-ai or <real HOME>/Library/Keychains is a symbolic link: an lstat type test that reads no entry and prints no name', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-home-'));
  // The link target cannot be listed: a check that read entries would stop
  // with EACCES instead of the refusal.
  const target = path.join(home, 'elsewhere');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'entry-name-never-printed'), 'x');
  fs.chmodSync(target, 0o000);
  const refusal = (label) => (err) => err.message.includes(`${label} is a symbolic link`) && !err.message.includes(home) && !err.message.includes('entry-name-never-printed');
  try {
    assert.doesNotThrow(() => sandbox.refuseLinkedStore(home), 'both absent');
    fs.mkdirSync(path.join(home, '.secretless-ai'));
    fs.mkdirSync(path.join(home, 'Library', 'Keychains'), { recursive: true });
    assert.doesNotThrow(() => sandbox.refuseLinkedStore(home), 'both directories');
    fs.rmdirSync(path.join(home, '.secretless-ai'));
    fs.symlinkSync(target, path.join(home, '.secretless-ai'));
    assert.throws(() => sandbox.refuseLinkedStore(home), refusal('<real HOME>/.secretless-ai'));
    fs.rmSync(path.join(home, '.secretless-ai'));
    fs.mkdirSync(path.join(home, '.secretless-ai'));
    fs.rmdirSync(path.join(home, 'Library', 'Keychains'));
    fs.symlinkSync(target, path.join(home, 'Library', 'Keychains'));
    assert.throws(() => sandbox.refuseLinkedStore(home), refusal('<real HOME>/Library/Keychains'));
    const { witness } = await import('../scripts/checks/sandbox-witness.mjs');
    assert.throws(() => witness({ targets: [], home }), refusal('<real HOME>/Library/Keychains'));
  } finally {
    fs.chmodSync(target, 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the sentinel and exec controls fire under the profile as written, and a profile writer that writes the unresolved /tmp paths fails both', () => {
  assert.equal(sandbox.sandboxStatus().available, true, PRE);
  const dir = tmpAlias('bank-demo-c5-');
  try {
    const sentinelDir = path.join(dir, 'sentinel');
    fs.mkdirSync(sentinelDir, { mode: 0o700 });
    const sentinelFile = path.join(sentinelDir, 'sentinel.txt');
    fs.writeFileSync(sentinelFile, 'sentinel\n', { mode: 0o600 });
    const execControl = path.join(dir, 'true');
    fs.copyFileSync('/usr/bin/true', execControl);
    fs.chmodSync(execControl, 0o700);
    const text = sandbox.harnessProfile({ runId: 'c5', sentinelDir, execControl });
    const written = sandbox.writeProfile(path.join(dir, 'written.sb'), text);
    // The mutant: the same profile text, written without the resolving step.
    const unresolved = path.join(dir, 'unresolved.sb');
    fs.writeFileSync(unresolved, text, { mode: 0o600 });
    assert.ok(fs.readFileSync(unresolved, 'utf8').includes(`(subpath "${sentinelDir}")`), 'the mutant names the /tmp path');
    const read = (profile) => spawnSync(sandbox.SANDBOX_EXEC, ['-f', profile, '/bin/cat', sentinelFile], { stdio: 'ignore' }).status;
    const exec = (profile) => spawnSync(sandbox.SANDBOX_EXEC, ['-f', profile, execControl], { stdio: 'ignore' }).status;
    assert.equal(spawnSync('/bin/cat', [sentinelFile], { stdio: 'ignore' }).status, 0, 'the sentinel reads outside');
    assert.equal(spawnSync(execControl, [], { stdio: 'ignore' }).status, 0, 'the exec control runs outside');
    assert.notEqual(read(written), 0, 'the sentinel is refused inside the profile as written');
    assert.equal(exec(written), 71, 'the exec control is refused inside the profile as written');
    assert.equal(read(unresolved), 0, 'mutant: the sentinel reads, so the sentinel control fails');
    assert.equal(exec(unresolved), 0, 'mutant: the exec control runs, so the exec control fails');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
