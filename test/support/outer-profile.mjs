// The outer profile of a test file of the outer shape (./shapes.mjs): a file
// that imports the demo's code or a package and starts no child under a
// profile of its own. The file names this module in its leading import, so
// this module is evaluated before any other module of the file.
//
// Outside a profile, it writes the test harness's profile, checks its two
// controls outside it (the sentinel reads, the exec control runs), starts
// the same file again under it with the same Node.js options and the same
// standard streams, and ends with that process's exit code. The file's other
// modules are linked in this process but evaluated inside the profile and
// nowhere else. Inside, it checks that the profile refuses the credential
// store path, the sentinel and the exec control before the file's tests run.
// Without a sandbox the file does not run.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SANDBOX_EXEC, harnessProfile, realExecPath, realHome, refuseLinkedStore, sandboxStatus, writeProfile } from '../../src/orchestrator/sandbox.mjs';
import { shapeOf } from './shapes.mjs';

const INSIDE = 'BANK_DEMO_OUTER_PROFILE';
const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); this test file runs inside its outer profile and nowhere else';

const file = fs.realpathSync(process.argv[1] ?? '');
const name = path.basename(file).replace(/\.test\.mjs$/, '');
if (shapeOf(name) !== 'outer') throw new Error(`${path.basename(file)} is not a test file of the outer shape, so it does not run under the outer profile`);

const refused = (fn) => {
  try {
    fn();
    return false;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

if (process.env[INSIDE]) {
  const { sentinel, execControl } = JSON.parse(process.env[INSIDE]);
  const held = {
    'the credential store path': refused(() => fs.lstatSync(path.join(realHome(), 'Library', 'Keychains'))),
    'the sentinel': refused(() => fs.readFileSync(sentinel)),
    'the exec control': spawnSync(execControl, [], { stdio: 'ignore' }).error?.code === 'EPERM',
  };
  const open = Object.keys(held).filter((k) => !held[k]);
  if (open.length > 0) throw new Error(`the outer profile is not applied: ${open.join(', ')} not refused`);
} else {
  if (!sandboxStatus().available) throw new Error(PRE);
  // A deny rule names the path, not its target: each store path is a
  // directory or absent, never a symbolic link.
  refuseLinkedStore();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-outer-')));
  let status = 1;
  try {
    const sentinelDir = path.join(dir, 'sentinel');
    fs.mkdirSync(sentinelDir, { mode: 0o700 });
    const sentinel = path.join(sentinelDir, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'outer profile sentinel\n', { mode: 0o600 });
    const execControl = path.join(dir, 'true');
    fs.copyFileSync('/usr/bin/true', execControl);
    fs.chmodSync(execControl, 0o700);
    fs.readFileSync(sentinel);
    if (spawnSync(execControl, [], { stdio: 'ignore' }).status !== 0) throw new Error('the exec control does not run outside the profile');
    const profile = writeProfile(path.join(dir, 'outer.sb'), harnessProfile({ runId: crypto.randomBytes(4).toString('hex'), sentinelDir, execControl }));
    const r = spawnSync(SANDBOX_EXEC, ['-f', profile, realExecPath(), ...process.execArgv, file], {
      stdio: 'inherit',
      env: { ...process.env, [INSIDE]: JSON.stringify({ sentinel, execControl }) },
    });
    status = r.status ?? 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(status);
}
