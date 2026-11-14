// Run a test helper script as its own Node.js process, with an explicit
// environment, under the same profile form the bank runs under: outbound
// network limited to the listed loopback ports and Unix sockets under its
// directory, exec limited to this Node.js binary, the credential store paths
// under the real home directory refused.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnv } from '../../src/orchestrator/env.mjs';
import { makeRunDir } from '../../src/orchestrator/run.mjs';
import { SANDBOX_EXEC, componentProfile, realExecPath, refuseLinkedStore, sandboxStatus, writeProfile } from '../../src/orchestrator/sandbox.mjs';

// A cell runs the broker's, the verifier's or the audit log's code, and a
// broker mutant would reach the credential resolver: it never runs outside
// the profile. The test fails with this precondition instead.
const PRECONDITION = 'precondition: /usr/bin/sandbox-exec (macOS); this cell runs inside the sandbox profile and nowhere else';

function cell(script, { args, env, tcpPorts }) {
  const dir = makeRunDir('bank-demo-test-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const execPath = realExecPath();
  if (!sandboxStatus().available) return { dir, home, command: null };
  // A cell starts when each credential store path is a directory or absent,
  // never a symbolic link: a deny rule names the path, not its target.
  refuseLinkedStore();
  const file = writeProfile(path.join(dir, 'cell.sb'), componentProfile({ runId: 'test', execPath, tcpPorts, unixSubpath: dir }));
  return { dir, home, command: [SANDBOX_EXEC, ['-f', file, execPath, script, dir, ...args], { env: { ...childEnv({ home }), ...env }, cwd: dir }] };
}

export function runSandboxed(script, { args = [], env = {}, tcpPorts = [], timeoutMs = 60000 } = {}) {
  const { dir, home, command } = cell(script, { args, env, tcpPorts });
  if (!command) return { sandboxed: false, dir, home, status: null, stderr: PRECONDITION, json: null };
  const [cmd, argv, opts] = command;
  const r = spawnSync(cmd, argv, { ...opts, encoding: 'utf8', timeout: timeoutMs });
  const last = (r.stdout || '').trim().split('\n').pop();
  let json = null;
  try { json = JSON.parse(last); } catch { json = null; }
  return { sandboxed: true, dir, home, status: r.status, stderr: r.stderr, json };
}

// The same cell, left running: the script writes one JSON line when it is
// ready and runs until its stdin closes. ready holds that line; stop closes
// stdin and resolves with the exit code.
export async function startSandboxed(script, { args = [], env = {}, tcpPorts = [], timeoutMs = 60000 } = {}) {
  const { dir, home, command } = cell(script, { args, env, tcpPorts });
  if (!command) throw new Error(PRECONDITION);
  const [cmd, argv, opts] = command;
  const child = spawn(cmd, argv, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  const ready = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`no ready line within ${timeoutMs} ms: ${stderr}`)), timeoutMs);
    child.stdout.on('data', (c) => {
      out += c;
      const nl = out.indexOf('\n');
      if (nl < 0) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(out.slice(0, nl))); } catch (err) { reject(err); }
    });
    exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`the cell exited (${code}) before its ready line: ${stderr}`));
    });
  });
  return {
    dir,
    home,
    pid: child.pid,
    ready,
    stop: () => {
      child.stdin.end();
      return exited;
    },
  };
}
