// The offline check's sorting of the egress counter's lines and its guards,
// the order that picks the reason shown, and the not run answer on a system
// without the sandbox. These need no sandbox and no network, so they also run
// on Linux.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyLine, summarize } from '../src/egress/classify.mjs';
import { runOfflineCheck } from '../src/egress/offline.mjs';
import { makeRunDir } from '../src/orchestrator/run.mjs';
import { offlineBlock } from '../src/runner/offline-text.mjs';

test('classification: the run\'s own sockets are in tree; names, other ports and UDP are attempts; a literal loopback lookup is listed apart', () => {
  const ctx = { ports: [4100, 4101], runDir: '/r/run' };
  assert.equal(classifyLine({ kind: 'tcp', host: '127.0.0.1', port: 4100 }, ctx), 'in tree');
  assert.equal(classifyLine({ kind: 'tcp', host: '::1', port: 4101 }, ctx), 'in tree');
  assert.equal(classifyLine({ kind: 'tcp', host: '127.0.0.1', port: 4102 }, ctx), 'attempt');
  assert.equal(classifyLine({ kind: 'tcp', host: 'localhost', port: 4100 }, ctx), 'attempt');
  assert.equal(classifyLine({ kind: 'ipc', path: '/r/run/sock/broker.sock' }, ctx), 'in tree');
  assert.equal(classifyLine({ kind: 'ipc', path: '/r/run-other/x.sock' }, ctx), 'attempt');
  assert.equal(classifyLine({ kind: 'ipc', path: '/var/run/mDNSResponder' }, ctx), 'attempt');
  assert.equal(classifyLine({ kind: 'udp', host: '127.0.0.1', port: 4100 }, ctx), 'attempt');
  assert.equal(classifyLine({ kind: 'dns', fn: 'dns.lookup', name: '127.0.0.1' }, ctx), 'literal lookup');
  assert.equal(classifyLine({ kind: 'dns', fn: 'dns.lookup', name: 'localhost' }, ctx), 'attempt');
  assert.equal(classifyLine({ kind: 'dns', fn: 'dns.resolve4', name: '127.0.0.1' }, ctx), 'attempt');
});

// The reasons, byte for byte as the screen prints them.
const COUNT_RECORD = 'the count record was missing or unreadable';
const NATIVE = 'a process tried to load a native module';
const UNCOUNTED = 'a process ran uncounted';
const QUIC = 'a process started with the QUIC flag';
const NO_SANDBOX = 'no macOS sandbox on this system';
const NO_SANDBOX_TEXT = [
  'Offline check: Not run',
  '  The four scenarios were not rerun (no macOS sandbox on this system).',
  '  Why: the check needs the macOS sandbox; see Requirements in the README.',
].join('\n');

const writeRecords = (dir, name, recs) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return f;
};
const hello = (pid, extra = {}) => ({ kind: 'hello', pid, main: true, execArgv: [], nodeOptions: '', ...extra });

test('guards: a missing or unreadable counter file, a started process with no hello line, QUIC and a native module each make the count not measured, each with its own reason', () => {
  const dir = makeRunDir('bank-demo-test-');
  const write = (name, recs) => writeRecords(dir, name, recs);
  const ctx = { ports: [], runDir: dir };
  const missing = summarize({ file: path.join(dir, 'none.jsonl'), ...ctx });
  assert.deepEqual([missing.status, missing.reason, missing.egressAttempts], ['not measured', COUNT_RECORD, null]);
  const orphan = summarize({ file: write('a.jsonl', [hello(1), { kind: 'child', pid: 1, childPid: 2 }]), ...ctx });
  assert.deepEqual([orphan.status, orphan.reason], ['not measured', UNCOUNTED]);
  const refusedExec = summarize({ file: write('b.jsonl', [hello(1), { kind: 'child', pid: 1, childPid: 0 }]), ...ctx });
  assert.deepEqual([refusedExec.status, refusedExec.egressAttempts, refusedExec.reasons], ['measured', 0, []]);
  const quic = summarize({ file: write('c.jsonl', [hello(1, { execArgv: ['--experimental-quic'] })]), ...ctx });
  assert.deepEqual([quic.status, quic.reason], ['not measured', QUIC]);
  const quicOption = summarize({ file: write('c2.jsonl', [hello(1, { nodeOptions: '--require x.cjs --experimental-quic' })]), ...ctx });
  assert.deepEqual([quicOption.status, quicOption.reason], ['not measured', QUIC]);
  const native = summarize({ file: write('d.jsonl', [hello(1), { kind: 'dlopen', pid: 1, filename: '/x.node' }]), ...ctx });
  assert.deepEqual([native.status, native.reason], ['not measured', NATIVE]);
  fs.writeFileSync(path.join(dir, 'e.jsonl'), '{"kind":"hello","pid":1,"main":true}\nnot json\n');
  const unreadable = summarize({ file: path.join(dir, 'e.jsonl'), ...ctx });
  assert.deepEqual([unreadable.status, unreadable.reason], ['not measured', COUNT_RECORD]);
});

test('several guards at once: the reason shown is the earliest in the closed list, and every reason that holds is recorded once, in that order', () => {
  const dir = makeRunDir('bank-demo-test-');
  // QUIC is seen before the native module and the two children with no
  // hello line, and still shows last.
  const file = writeRecords(dir, 'several.jsonl', [
    hello(1, { execArgv: ['--experimental-quic'] }),
    { kind: 'child', pid: 1, childPid: 2 },
    { kind: 'child', pid: 1, childPid: 3 },
    { kind: 'dlopen', pid: 1, filename: '/x.node' },
  ]);
  const s = summarize({ file, ports: [], runDir: dir });
  assert.equal(s.status, 'not measured');
  assert.equal(s.reason, NATIVE);
  assert.deepEqual(s.reasons, [NATIVE, UNCOUNTED, QUIC]);
  assert.equal(s.guards.length, 4);
  assert.equal(s.egressAttempts, null);
});

test('no sandbox-exec at the given path: the check reads not run, with the reason and what the check needs, no number, and no decision is labelled same', async () => {
  const r = await runOfflineCheck({ sandboxExec: '/nonexistent/sandbox-exec' });
  assert.equal(r.status, 'not run');
  assert.equal(r.reason, NO_SANDBOX);
  assert.deepEqual(r.reasons, [NO_SANDBOX]);
  assert.equal(r.egressAttempts, null);
  for (const o of r.outcomes) assert.equal(o.same, null);
  assert.equal(offlineBlock(r), NO_SANDBOX_TEXT);
  assert.equal(/\d/.test(offlineBlock(r)), false);
});

test('a sandbox-exec the system cannot start (its interpreter does not exist): the spawn fails with ENOENT and the check reads not run, no macOS sandbox', async () => {
  const dir = makeRunDir('bank-demo-test-');
  const unstartable = path.join(dir, 'sandbox-exec');
  fs.writeFileSync(unstartable, '#!/nonexistent/bank-demo-interpreter\n', { mode: 0o700 });
  const r = await runOfflineCheck({ sandboxExec: unstartable, open: false, timeoutMs: 5000 });
  assert.equal(r.status, 'not run');
  assert.equal(r.reason, NO_SANDBOX);
  assert.equal(offlineBlock(r), NO_SANDBOX_TEXT);
});
