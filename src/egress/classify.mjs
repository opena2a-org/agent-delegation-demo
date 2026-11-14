// Reads the egress counter's file for one run and sorts its lines.
//
// In tree: a Unix socket under the run directory, or the literal 127.0.0.1
// or ::1 with one of the run's listener ports. Outbound attempt: every other
// connect, every name lookup, every UDP send. A lookup of the literal
// 127.0.0.1 or ::1 is listed apart: Node.js makes one inside listen() on that
// address and answers it without a resolver call (inside the block, where
// the resolver socket is refused, it still returns the address). It is
// neither counted as an attempt nor folded into the in tree count.
//
// The count reads "not measured", never 0, when a process tried to load a
// native module, a started process left no hello line, a process ran with
// QUIC enabled, or the file is missing or cannot be read. The offline check
// adds its two network controls, its two deny form controls and a rerun that
// started and returned no complete answer to that list.

import fs from 'node:fs';
import path from 'node:path';

export const COUNTER_CONTROL = Object.freeze({ host: '192.0.2.1', port: 9 });
export const OWN_ADDRESS_PORT = 9;
// Stands in for this machine's own address wherever a line would carry it.
export const OWN_ADDRESS_WORDS = "this machine's own address";
const LOOPBACK = new Set(['127.0.0.1', '::1']);
const LOOKUP_FNS = new Set(['dns.lookup', 'dns.promises.lookup']);

// The closed list of reasons a count reads "not measured", in the order that
// picks the one shown when several hold: the earliest that holds. The result
// records every reason that holds.
export const NOT_MEASURED = Object.freeze({
  countRecord: 'the count record was missing or unreadable',
  noAddress: 'no IPv4 address was found besides loopback',
  counterControl: 'the control to 192.0.2.1 failed',
  addressControl: "the control to this machine's address failed",
  storeControl: 'the control reading a test file failed',
  execControl: 'the control running a test program failed',
  nativeModule: 'a process tried to load a native module',
  uncounted: 'a process ran uncounted',
  quic: 'a process started with the QUIC flag',
  rerunStopped: 'the rerun ended without four decisions',
});

// The closed list of reasons the offline check reads "not run", one for each
// of the three ways the sandbox never applied: no sandbox-exec on this
// system, a refusal because the demo already runs inside another sandbox,
// or any other end before the rerun's root process wrote its hello line or
// answered. The scenarios were not rerun and nothing was counted.
export const NOT_RUN = Object.freeze({
  noSandbox: 'no macOS sandbox on this system',
  outerSandbox: 'the demo is already inside another sandbox',
  notApplied: 'the sandbox could not be applied',
});

// How sandbox-exec's stderr starts when it may not apply a profile, as when
// the process that runs it already runs under a profile that restricts
// something; it then exits 71.
export const SANDBOX_APPLY_REFUSED = 'sandbox-exec: sandbox_apply:';

// One reason for each way sandbox-exec ends before the rerun's root process
// writes its hello line: the system finds nothing to start (ENOENT); it
// refuses to apply the profile (exit 71 with the sandbox_apply line); any
// other end, a profile that does not parse (exit 65) included.
export function notRunReason({ spawnError = null, exitCode = null, stderr = null } = {}) {
  if (spawnError === 'ENOENT') return NOT_RUN.noSandbox;
  if (exitCode === 71 && String(stderr ?? '').startsWith(SANDBOX_APPLY_REFUSED)) return NOT_RUN.outerSandbox;
  return NOT_RUN.notApplied;
}

// The same ends, for the launcher's probe and for each part the launcher
// starts under its profile, named by the key of the reason above that names
// the same cause: the launcher refuses the start with that cause's lines. An
// exec of sandbox-exec that this process may not make (EPERM) has the cause
// of exit 71 here: the terminal runs inside another sandbox.
export function launcherRefusalCause({ spawnError = null, exitCode = null, stderr = null } = {}) {
  if (spawnError === 'EPERM') return 'outerSandbox';
  if (spawnError === 'ENOENT') return 'noSandbox';
  if (exitCode === 71 && String(stderr ?? '').startsWith(SANDBOX_APPLY_REFUSED)) return 'outerSandbox';
  return 'notApplied';
}

const ORDER = Object.values(NOT_MEASURED);

// Every reason the guards hold, once each, in the closed list's order. The
// earliest of them is the one shown.
export function reasonsInOrder(guards) {
  const held = new Set(guards.map((g) => g.reason));
  for (const r of held) if (!ORDER.includes(r)) throw new Error(`a guard reason outside the closed list: ${r}`);
  return ORDER.filter((r) => held.has(r));
}

export function readCounter(file) {
  if (!file || !fs.existsSync(file)) return { ok: false, lines: [], error: 'missing' };
  const lines = [];
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!raw) continue;
    let line;
    try { line = JSON.parse(raw); } catch { return { ok: false, lines, error: 'unreadable' }; }
    if (!line || typeof line !== 'object' || !Number.isInteger(line.pid) || typeof line.kind !== 'string') {
      return { ok: false, lines, error: 'unreadable' };
    }
    lines.push(line);
  }
  return { ok: true, lines, error: null };
}

function under(p, dir) {
  const r = path.resolve(String(p));
  return r.startsWith(`${dir}${path.sep}`);
}

export function classifyLine(line, { ports, runDir }) {
  switch (line.kind) {
    case 'hello':
    case 'child':
      return 'process';
    case 'dlopen':
      return 'native module';
    case 'ipc':
      return under(line.path, runDir) ? 'in tree' : 'attempt';
    case 'tcp':
      return LOOPBACK.has(line.host) && ports.includes(line.port) ? 'in tree' : 'attempt';
    case 'dns':
      return LOOKUP_FNS.has(line.fn) && LOOPBACK.has(line.name) ? 'literal lookup' : 'attempt';
    default:
      return 'attempt';
  }
}

const quic = (hello) => (hello.execArgv ?? []).some((a) => String(a).startsWith('--experimental-quic'))
  || String(hello.nodeOptions ?? '').includes('--experimental-quic');

// controls: the calls the harness itself makes from the rerun's root
// process, [{ id, pid, host, port }]. Their lines are reported apart and
// never counted. redact: addresses that are never returned (this machine's
// own address).
export function summarize({ file, ports, runDir, controls = [], redact = [] }) {
  const read = readCounter(file);
  const out = {
    status: 'measured',
    reason: null,
    reasons: [],
    guards: [],
    egressAttempts: null,
    attempts: [],
    inTree: 0,
    literalLookups: 0,
    controlLines: Object.fromEntries(controls.map((c) => [c.id, 0])),
    processes: 0,
    workerThreads: 0,
    lines: read.lines.length,
  };
  const guard = (reason, detail) => out.guards.push({ reason, detail });
  if (!read.ok) guard(NOT_MEASURED.countRecord, `the counter file is ${read.error}`);
  const hello = new Map();
  const started = [];
  const names = new Map();
  for (const line of read.lines) {
    if (line.kind === 'hello') {
      if (line.main) {
        hello.set(line.pid, line);
        names.set(line.pid, line.argv1 ?? null);
        out.processes += 1;
      } else {
        out.workerThreads += 1;
      }
      if (quic(line)) guard(NOT_MEASURED.quic, `process ${line.pid} runs with QUIC enabled`);
    }
  }
  for (const line of read.lines) {
    const cls = classifyLine(line, { ports, runDir });
    if (cls === 'process') {
      // A spawn the system refused at exec returns pid 0: no process ran.
      if (line.kind === 'child' && Number.isInteger(line.childPid) && line.childPid > 0) started.push(line.childPid);
      continue;
    }
    if (cls === 'native module') { guard(NOT_MEASURED.nativeModule, `process ${line.pid} loaded a native module`); continue; }
    if (cls === 'in tree') { out.inTree += 1; continue; }
    if (cls === 'literal lookup') { out.literalLookups += 1; continue; }
    const ctl = controls.find((c) => c.pid === line.pid && line.kind === 'tcp' && line.host === c.host && line.port === c.port);
    if (ctl) { out.controlLines[ctl.id] += 1; continue; }
    out.attempts.push({
      pid: line.pid,
      process: names.get(line.pid) ?? null,
      kind: line.kind,
      fn: line.fn ?? null,
      host: redact.includes(line.host) ? OWN_ADDRESS_WORDS : line.host ?? null,
      port: line.port ?? null,
      name: line.name ?? null,
      path: line.path ?? null,
    });
  }
  for (const pid of started) if (!hello.has(pid)) guard(NOT_MEASURED.uncounted, `process ${pid} left no hello line`);
  out.helloPids = [...hello.keys()];
  out.roots = out.helloPids.filter((pid) => !started.includes(pid));
  if (out.guards.length) {
    out.status = 'not measured';
    out.reasons = reasonsInOrder(out.guards);
    out.reason = out.reasons[0];
  } else {
    out.egressAttempts = out.attempts.length;
  }
  return out;
}
