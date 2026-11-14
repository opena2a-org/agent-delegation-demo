// The sandbox witness. For each process a run records, it reads the kernel's
// record from outside, while the process runs (sandbox_check, through
// sandbox-witness.py), and judges it:
//   - the process is sandboxed: sandbox_check(pid, NULL, 0) reads 1;
//   - file-read-data and file-write-data on each credential store path read
//     1 (refused), and process-exec* on the keychain tool reads 1;
//   - in the same reading, an unsandboxed process (the caller) reads 0 on the
//     same queries, and an allowed path reads 0 for the process.
// A reading of -1 could not be read: it is never taken as allowed or refused.
// A path that does not exist reads 1 for an unsandboxed process too, so a
// store reading counts when the unsandboxed control reads 0 on that path.
// Where a store path does not exist on this host, the process's reading on
// the sentinel stands in (it exists, under the same deny form), together with
// the profile file's text naming the resolved store path. Without one of the
// two, the reading is inconclusive, never a pass. The network has no reading
// here; it keeps its own neutral host control.
//
// For a harness that records pids:
//   node scripts/checks/sandbox-witness.mjs [--sentinel <dir>] <name>=<pid>[:<profile file>] ...
// prints one line per process and exits 0 on pass, 1 on fail and 2 when
// inconclusive. It prints no path, and reads nothing under the store paths.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOUNDARY_TERMS, deniesReadWrite, realHome, refuseLinkedStore, resolvedPath } from '../../src/orchestrator/sandbox.mjs';

export const PYTHON = '/usr/bin/python3';
export const READER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sandbox-witness.py');
const OPS = Object.freeze(['file-read-data', 'file-write-data']);
const KEYCHAIN = 'keychain tool';
const BY_SENTINEL = 'by the sentinel and the profile text';

// queries: [id, pid, operation or null, path or null]. results: id -> 1, 0 or -1.
export function readKernel(queries, { python = PYTHON } = {}) {
  const r = spawnSync(python, ['-I', READER], {
    input: JSON.stringify({ queries }),
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', TZ: 'UTC' },
    timeout: 30000,
  });
  if (r.error || r.status !== 0) {
    return { ok: false, reason: `the kernel reader did not run (${r.error?.code ?? `exit ${r.status}`}); precondition: ${python} (macOS Command Line Tools)` };
  }
  try {
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    return { ok: true, self: out.self, results: out.results };
  } catch {
    return { ok: false, reason: 'the kernel reader wrote no reading' };
  }
}

function storeEntry(home, rel) {
  const p = resolvedPath(path.join(home, rel));
  let exists = true;
  try {
    fs.lstatSync(p);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw new Error(`<real HOME>/${rel} could not be examined (${err.code ?? 'no code'})`);
    exists = false;
  }
  return { label: `<real HOME>/${rel}`, path: p, exists };
}

// targets: [{ name, pid, profileFile, allowed }]. allowed defaults to the
// profile file, then to the kernel reader script: paths no profile refuses.
export function witness({ targets, home = realHome(), sentinel = null, python = PYTHON, controlPid = process.pid }) {
  refuseLinkedStore(home);
  const store = BOUNDARY_TERMS.storePaths.map((rel) => storeEntry(home, rel));
  const sentinelPath = sentinel ? resolvedPath(sentinel) : null;
  const queries = [];
  for (const { key, pid } of [{ key: 'control', pid: controlPid }, ...targets.map((t, i) => ({ key: `t${i}`, pid: t.pid }))]) {
    queries.push([`${key}:sandboxed`, pid, null, null]);
    for (const s of store) for (const op of OPS) queries.push([`${key}:${s.label} ${op}`, pid, op, s.path]);
    queries.push([`${key}:${KEYCHAIN}`, pid, 'process-exec*', BOUNDARY_TERMS.keychainTool]);
    if (sentinelPath) queries.push([`${key}:sentinel`, pid, 'file-read-data', sentinelPath]);
  }
  targets.forEach((t, i) => {
    const allowed = resolvedPath(t.allowed ?? t.profileFile ?? READER);
    queries.push([`t${i}:allowed path`, t.pid, 'file-read-data', allowed]);
    queries.push([`control:allowed path ${i}`, controlPid, 'file-read-data', allowed]);
  });
  const k = readKernel(queries, { python });
  return judge({
    self: k.ok ? k.self : -1,
    results: k.ok ? k.results : {},
    readerProblem: k.ok ? null : k.reason,
    targets: targets.map((t) => ({ name: t.name, pid: t.pid })),
    store,
    sentinel: sentinelPath !== null,
    profileTexts: targets.map((t) => (t.profileFile && fs.existsSync(t.profileFile) ? fs.readFileSync(t.profileFile, 'utf8') : null)),
  });
}

export function judge(raw) {
  const value = (id) => (Object.hasOwn(raw.results, id) ? raw.results[id] : -1);
  const problems = raw.readerProblem ? [raw.readerProblem] : [];
  const outside = raw.self === 0 && value('control:sandboxed') === 0;
  if (!raw.readerProblem && !outside) problems.push(`the witness is not outside every profile: the reader reads ${raw.self}, the control process ${value('control:sandboxed')}`);
  const targets = raw.targets.map((t, i) => {
    const key = `t${i}`;
    const readings = {};
    const failed = [];
    const unread = [];
    // A reading that must be 1, with the unsandboxed control at 0.
    const refused = (name, v, c) => {
      readings[name] = v;
      if (c !== 0) unread.push(`${name}: the unsandboxed control reads ${c}`);
      else if (v === 0) failed.push(`${name}: allowed`);
      else if (v !== 1) unread.push(`${name}: could not read`);
    };
    const sandboxed = value(`${key}:sandboxed`);
    readings.sandboxed = sandboxed;
    if (sandboxed === 0) failed.push('not sandboxed: sandbox_check(pid, NULL, 0) reads 0');
    else if (sandboxed !== 1) unread.push('sandboxed: could not read');
    if (raw.sentinel) refused('sentinel', value(`${key}:sentinel`), value('control:sentinel'));
    const sentinelHolds = raw.sentinel && value(`${key}:sentinel`) === 1 && value('control:sentinel') === 0;
    for (const s of raw.store) {
      for (const op of OPS) {
        const name = `${s.label} ${op}`;
        const v = value(`${key}:${name}`);
        const c = value(`control:${name}`);
        if (c === 0) refused(name, v, c);
        else if (!s.exists && c === 1 && sentinelHolds && raw.profileTexts[i] !== null && deniesReadWrite(raw.profileTexts[i], s.path)) readings[name] = BY_SENTINEL;
        else {
          readings[name] = v;
          unread.push(`${name}: the unsandboxed control reads ${c}, and no sentinel reading with the profile text stands in`);
        }
      }
    }
    refused(KEYCHAIN, value(`${key}:${KEYCHAIN}`), value(`control:${KEYCHAIN}`));
    const allowed = value(`${key}:allowed path`);
    const allowedControl = value(`control:allowed path ${i}`);
    readings['allowed path'] = allowed;
    if (allowed !== 0 || allowedControl !== 0) unread.push(`allowed path: reads ${allowed}, control ${allowedControl}; a reading that refuses an allowed path is not a reading`);
    for (const p of [...failed, ...unread]) problems.push(`${t.name}: ${p}`);
    const verdict = failed.length > 0 ? 'fail' : unread.length > 0 || !outside ? 'inconclusive' : 'pass';
    return { name: t.name, pid: t.pid, verdict, readings };
  });
  let verdict = 'pass';
  if (targets.some((t) => t.verdict === 'fail')) verdict = 'fail';
  else if (targets.length === 0 || !outside || targets.some((t) => t.verdict !== 'pass')) verdict = 'inconclusive';
  return { verdict, outside, control: { reader: raw.self, process: value('control:sandboxed') }, targets, problems, raw };
}

export function witnessLines(seen) {
  const fmt = (readings) => Object.entries(readings).map(([k, v]) => `${k} ${v}`).join(', ');
  return [
    `witness ${seen.verdict}; unsandboxed control: reader ${seen.control.reader}, process ${seen.control.process}`,
    ...seen.targets.map((t) => `${t.name} (pid ${t.pid}) ${t.verdict}: ${fmt(t.readings)}`),
    ...seen.problems.map((p) => `problem: ${p}`),
  ];
}

const USAGE = 'usage: node scripts/checks/sandbox-witness.mjs [--sentinel <dir>] <name>=<pid>[:<profile file>] ...';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let sentinel = null;
  const targets = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--sentinel' && args[i + 1]) {
      sentinel = args[i + 1];
      i += 1;
      continue;
    }
    const m = /^([^=]+)=([0-9]+)(?::(.+))?$/.exec(args[i]);
    if (!m) {
      console.error(USAGE);
      process.exit(2);
    }
    targets.push({ name: m[1], pid: Number(m[2]), profileFile: m[3] ?? null });
  }
  if (targets.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }
  let seen;
  try {
    seen = witness({ targets, sentinel });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  for (const line of witnessLines(seen)) console.log(line);
  process.exit({ pass: 0, fail: 1 }[seen.verdict] ?? 2);
}
