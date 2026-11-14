// The two checks npm start and npm run scenarios run before every other one:
// the platform, then a probe that starts one Node.js process under a profile
// of its own, the way each part of the demo is started. And the lines of each
// refusal that names the platform, or why the parts cannot start under their
// profiles.
//
// The probe's profile is written for this probe alone by the parts' profile
// writer, with a fresh run id in its messages and every path in it resolved.
// Under it, sandbox-exec runs node -e '' with NODE_OPTIONS removed from the
// environment, so the probe loads neither the connection counter nor an
// inherited preload. The profile file is removed after the probe. Exit 0
// continues. Any other end refuses, with its cause read as the offline check
// reads the rerun's (src/egress/classify.mjs): the terminal is inside another
// sandbox (exit 71 with the sandbox_apply line, or an exec of sandbox-exec
// this process may not make), there is no sandbox-exec, or macOS refused the
// profile (any other end), whose refusal names a 0600 file holding
// sandbox-exec's stderr.
//
// After the probe both scripts run the next checks in the launcher's order,
// each written here once so the two print the same lines: the Node.js
// version, an inherited NODE_OPTIONS, then the dependencies. Each returns the
// lines of its refusal, or null.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launcherRefusalCause } from '../egress/classify.mjs';
import { SANDBOX_EXEC, componentProfile, realExecPath, writeProfile } from '../orchestrator/sandbox.mjs';

// The platform families the README lists under Requirements. A platform joins
// this list in the change that adds it to the README.
export const PLATFORMS = Object.freeze(['darwin']);

const PLATFORM_NAMES = Object.freeze({ win32: 'Windows' });

// The parts of a run, by the name the run gives each.
export const PART_NAMES = Object.freeze({
  bank: 'The bank',
  'agent-a-billpay': 'The password path bill pay agent',
  'agent-a-budget': 'The password path budget agent',
  'agent-b-billpay': 'The grant path bill pay agent',
  'agent-b-budget': 'The grant path budget agent',
});

// The parts the probe stands in for, in its refusal.
const PROBE_PARTS = "the demo's parts";

const FIX_MAC = 'Fix: run it on a Mac with the macOS version the README lists.';

export function platformLines(platform) {
  const name = PLATFORM_NAMES[platform] ?? String(platform).replace(/[^\x20-\x7e]/g, '?');
  return [`This demo does not run on ${name}.`, 'Fix: run it on a platform listed under Requirements in the README.'];
}

// The lines of a refusal, by the key of its cause (src/egress/classify.mjs
// NOT_RUN): what failed, then a Fix line that does not repeat the failing
// command alone.
export function refusalLines(key, { part = PROBE_PARTS, log = null } = {}) {
  if (key === 'outerSandbox') {
    return [
      'This terminal is inside another sandbox, so the demo cannot start its parts in their own macOS sandboxes.',
      'Fix: open a terminal window that is not inside another sandbox, then run: npm start',
    ];
  }
  if (key === 'noSandbox') {
    return ['This Mac has no /usr/bin/sandbox-exec, which the demo needs to start its parts in their own sandboxes.', FIX_MAC];
  }
  return [`macOS refused the sandbox profile of ${part}, so the demo did not start.`, `Log: ${log}`, FIX_MAC];
}

// The refusal for a part of a run whose profile was not applied
// (ProfileNotApplied, src/orchestrator/sandbox.mjs), or null for any other
// error.
export function notAppliedLines(err) {
  if (err?.code !== 'PROFILE_NOT_APPLIED') return null;
  const name = PART_NAMES[err.part] ?? err.part ?? PROBE_PARTS;
  return refusalLines(err.key, { part: name.charAt(0).toLowerCase() + name.slice(1), log: err.log });
}

function ending({ spawnError, status, signal }) {
  if (spawnError) return `sandbox-exec did not start (${spawnError}).\n`;
  if (signal) return `sandbox-exec ended on ${signal}.\n`;
  return `sandbox-exec ended with exit ${status}.\n`;
}

// One probe. It returns the probe's pid, how it ended and when, and for a
// probe that did not end with 0, the key of the cause and the log file of a
// profile macOS refused.
export function probe({ sandboxExec = SANDBOX_EXEC, execPath = realExecPath(), env = process.env } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-probe-')));
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'probe.sb');
  const probeEnv = { ...env };
  delete probeEnv.NODE_OPTIONS;
  let r;
  try {
    writeProfile(file, componentProfile({ runId: crypto.randomBytes(8).toString('hex'), execPath }));
    r = spawnSync(sandboxExec, ['-f', file, execPath, '-e', ''], { env: probeEnv, stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
  } finally {
    fs.rmSync(file, { force: true });
  }
  const end = {
    pid: r.pid > 0 ? r.pid : null,
    status: r.status,
    signal: r.signal,
    spawnError: r.error?.code ?? null,
    t: Date.now(),
  };
  const stderr = r.stderr ? r.stderr.toString('utf8') : '';
  if (end.status === 0 && !end.spawnError) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ...end, key: null, log: null };
  }
  const key = launcherRefusalCause({ spawnError: end.spawnError, exitCode: end.status, stderr: stderr.split('\n')[0] || null });
  if (key !== 'notApplied') {
    fs.rmSync(dir, { recursive: true, force: true });
    return { ...end, key, log: null };
  }
  const log = path.join(dir, 'sandbox-exec.log');
  fs.writeFileSync(log, stderr || ending(end), { mode: 0o600 });
  return { ...end, key, log };
}

// The platform, then the probe: { refusal } with the lines to print before
// exiting 1, or { probe } with the probe's pid, status and end time.
export function firstChecks() {
  if (!PLATFORMS.includes(process.platform)) return { refusal: platformLines(process.platform) };
  const p = probe();
  if (p.key) return { refusal: refusalLines(p.key, { log: p.log }) };
  return { probe: { pid: p.pid, status: p.status, t: p.t } };
}

const MIN_NODE = [22, 12, 0];

export function nodeVersionLines(version = process.versions.node) {
  const v = version.split('.').map(Number);
  const tooOld = v[0] < MIN_NODE[0] || (v[0] === MIN_NODE[0] && (v[1] < MIN_NODE[1] || (v[1] === MIN_NODE[1] && v[2] < MIN_NODE[2])));
  if (!tooOld) return null;
  return [`This demo needs Node.js 22.12.0 or later. This is Node.js ${version}.`, 'Fix: install Node.js 22.12.0 or later, then run: npm ci && npm start'];
}

// An inherited NODE_OPTIONS is refused, never merged and never replaced: a
// preload in it would run in every demo process. Any value that is not empty
// is refused, before the script that was run loads its other modules. The
// refusal names the variable and never prints its value, and its Fix clears
// the variable for that script.
export function nodeOptionsLines(script, env = process.env) {
  if (!env.NODE_OPTIONS) return null;
  return [
    'NODE_OPTIONS is set in this terminal. The demo sets its own NODE_OPTIONS to load a connection counter into every process it starts, and does not run with other Node.js options.',
    `Fix: env -u NODE_OPTIONS ${script}`,
  ];
}

// Each package is resolved, not evaluated.
export function dependencyLines() {
  for (const dep of ['secretless-ai/dist/broker/index.js', '@opena2a/atx-verify', '@noble/post-quantum/ml-dsa.js']) {
    try {
      import.meta.resolve(dep);
    } catch {
      return ['Dependencies are not installed.', 'Fix: npm ci'];
    }
  }
  return null;
}
