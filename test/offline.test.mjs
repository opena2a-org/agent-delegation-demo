// The offline check: the grant path scenarios with every network destination
// outside this machine blocked by a macOS sandbox profile, the egress
// counter in every process, and the controls that must fire in the same run.
// Each test that expects a failure feeds an input that breaks one rule (a
// stray request, a widened profile, a native module, a counter file that
// cannot be read, a process without the counter, QUIC, a rerun that ends
// early, a profile that does not parse, a sandbox around the check); none
// edits the harness. Each reason the screen can show has its own input.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize } from '../src/egress/classify.mjs';
import { ownAddress } from '../src/egress/controls.mjs';
import { runOfflineCheck, runOfflineCheckWithRun } from '../src/egress/offline.mjs';
import { childEnv } from '../src/orchestrator/env.mjs';
import { makeRunDir } from '../src/orchestrator/run.mjs';
import { SANDBOX_EXEC, componentProfile, realExecPath, resolveProfilePaths, sandboxStatus, writeProfile } from '../src/orchestrator/sandbox.mjs';
import { offlineBlock } from '../src/runner/offline-text.mjs';
import { outerProfileText } from './support/profiles.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'egress');
const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); the offline check needs the OS sandbox and does not run without it';

// The reasons, byte for byte as the screen prints them, in the order that
// picks the one shown.
const REASON = Object.freeze({
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

// A count that was not measured: one result line, "Outbound connection
// attempts: not measured (<reason>).", after the sentence on the decisions
// when both runs returned a decision for each of the four scenarios and with
// no sentence on them otherwise, and no number after "attempts:" on any line
// of the check.
function assertNotMeasured(r, reason, reasons = [reason]) {
  assert.equal(r.status, 'not measured', PRE);
  assert.equal(r.reason, reason);
  assert.deepEqual(r.reasons, reasons);
  assert.equal(r.egressAttempts, null);
  const lines = offlineBlock(r).split('\n').map((l) => l.trim());
  const compared = r.outcomes.every((o) => o.open !== null && o.blocked !== null && typeof o.same === 'boolean');
  const decisions = compared ? `${r.allSame ? 'Each decision matched.' : 'Not every decision matched.'} ` : '';
  assert.deepEqual(lines.filter((l) => l.includes('Outbound connection attempts:')), [`${decisions}Outbound connection attempts: not measured (${reason}).`]);
  if (!compared) assert.deepEqual(lines.filter((l) => /matched/.test(l)), []);
  for (const l of lines) assert.equal(/attempts:\s*\d/.test(l), false, l);
}

// A reader in place of the kernel witness: it records the pid and profile
// file it was called with, and whether that process still ran then.
function witnessStandIn() {
  const calls = [];
  const read = ({ pid, profileFile }) => {
    let running = true;
    try { process.kill(pid, 0); } catch { running = false; }
    calls.push({ running, profileFile });
    return { standIn: calls.length };
  };
  return { read, calls };
}

// A deny form seen not refusing stops the rerun before its scenarios. It
// answered: its three control rows are there, and the 192.0.2.1 control
// was refused and counted once. It started no scenario, no extra process and
// no bank: no scenario carries a blocked decision, the blocked run's
// directory holds no bank directory, and the counter counted the rerun's
// root alone. The result records the profile as edited, and the reader was
// called once, with the rerun's profile file, while the root still ran.
function assertStoppedBeforeScenarios(r, runDir, witness) {
  assert.deepEqual(r.controls.map((c) => c.id), ['network', 'store deny form', 'exec deny form']);
  assert.equal(r.decision2.pass, true);
  for (const o of r.outcomes) assert.equal(o.blocked, null, `scenario ${o.scenario} has a blocked decision`);
  assert.equal(r.extra[0].blocked, null);
  assert.deepEqual(r.extraProcesses, []);
  assert.equal(fs.existsSync(path.join(runDir, 'bank')), false, 'a bank started under the profile');
  assert.equal(r.egress.processes, 1, 'a process besides the rerun\'s root was counted');
  assert.equal(r.profileEdited, true);
  assert.deepEqual(witness.calls, [{ running: true, profileFile: path.join(runDir, 'egress.sb') }]);
  assert.deepEqual(r.witness, { standIn: 1 });
}

// A check that was not run: the outcome, the result line with the reason,
// then what the check needs; no number anywhere and no decision labelled same.
function assertNotRun(r, text, reason, why) {
  assert.equal(r.status, 'not run', PRE);
  assert.equal(r.reason, reason);
  assert.deepEqual(r.reasons, [reason]);
  assert.equal(r.egressAttempts, null);
  for (const o of r.outcomes) assert.equal(o.same, null);
  assert.equal(text, ['Offline check: Not run', `  The four scenarios were not rerun (${reason}).`, `  ${why}`].join('\n'));
  assert.equal(/\d/.test(text), false, text);
}

const QUIC_OPTION = spawnSync(process.execPath, ['--experimental-quic', '-e', ''], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' }).status === 0;

let full;
let fullRunDir;

before(async () => {
  const r = await runOfflineCheckWithRun();
  full = r.result;
  fullRunDir = r.runDir;
});

test('offline check: the three control rows, each reachable outside and refused inside, come before the four outcomes', () => {
  assert.equal(full.status, 'measured', PRE);
  const keys = Object.keys(full);
  assert.ok(keys.indexOf('controls') < keys.indexOf('outcomes'));
  assert.deepEqual(full.controls.map((c) => c.id), ['network', 'store deny form', 'exec deny form']);
  for (const c of full.controls) {
    assert.equal(c.outside, 'reachable outside', c.control);
    assert.equal(c.inside, 'refused inside', c.control);
    assert.equal(c.insideOutcome, 'EPERM', c.control);
    assert.equal(c.pass, true, c.control);
  }
  assert.equal(full.controls[0].lines, 1);
  assert.deepEqual(full.outcomes.map((o) => o.scenario), ['1', '2', '3', '4']);
  const text = offlineBlock(full);
  const firstControl = text.indexOf(full.controls[0].control);
  const firstOutcome = text.indexOf('1 Normal bill');
  assert.ok(firstControl > 0 && firstOutcome > firstControl, 'control rows print before the outcomes');
  assert.equal(/reachable inside/.test(text), false);
});

test('offline check: the four grant path decisions with the network blocked match the open run, each read from the bank state', () => {
  for (const o of full.outcomes) assert.equal(o.same, true, `scenario ${o.scenario}`);
  assert.equal(full.allSame, true);
  const [s1, s2, s3, s4] = full.outcomes.map((o) => o.blocked);
  assert.equal(s1.outcome, 'paid');
  assert.deepEqual(s1.payment, { payee: 'City Water', amountCents: 8640 });
  assert.equal(s1.agent, 'Bill pay agent');
  assert.equal(s2.outcome, 'refused');
  assert.equal(s2.consentField, 'creditorAccounts');
  assert.equal(s2.payment, null);
  assert.equal(s2.balanceAfter, '$4,713.60');
  assert.deepEqual(s3.consents, [{ agent: 'Budget agent', status: 'active' }, { agent: 'Bill pay agent', status: 'withdrawn' }]);
  assert.deepEqual(s3.effects, [
    { who: 'Bill pay agent', outcome: 'refused by the broker' },
    { who: 'Budget agent', outcome: 'read the balance' },
    { who: 'Customer B', outcome: 'kept working' },
  ]);
  assert.equal(s4.outcome, 'agent on record');
  assert.equal(s4.agent, 'Bill pay agent');
  assert.equal(s4.signatureVerified, true);
  const cross = full.extra.find((e) => e.scenario === 'cross');
  assert.equal(cross.same, true);
  assert.equal(cross.blocked.outcome, 'refused');
  assert.equal(cross.blocked.consentField, 'agent');
});

test('offline check: 0 outbound attempts; the 192.0.2.1 control refused within 2 s and counted once, from a process that was counted', () => {
  assert.equal(full.egressAttempts, 0);
  assert.deepEqual(full.egress.attempts, []);
  assert.deepEqual(full.egress.guards, []);
  assert.equal(full.reason, null);
  assert.deepEqual(full.reasons, []);
  const d2 = full.decision2;
  assert.equal(d2.outcome, 'EPERM');
  assert.ok(d2.ms <= 2000, `${d2.ms} ms`);
  assert.equal(d2.lines, 1);
  assert.equal(d2.hello, true);
  assert.equal(d2.pass, true);
  // The root, the bank, four agents, and one verifier process per token check.
  assert.ok(full.egress.processes >= 6, `${full.egress.processes} processes`);
  assert.ok(full.egress.inTree > 0);
  assert.equal(full.openRun.egress.status, 'measured');
  assert.equal(full.openRun.egress.egressAttempts, 0);
});

test('offline check: the profile allows one loopback line per listener port and the run directory socket; nothing carries this machine\'s address', () => {
  const profile = fs.readFileSync(path.join(fullRunDir, 'egress.sb'), 'utf8');
  const remote = profile.match(/remote ip "[^"]+"/g);
  assert.equal(remote.length, 3);
  for (const r of remote) assert.match(r, /^remote ip "localhost:\d+"$/);
  assert.equal(profile.includes('localhost:*'), false);
  assert.ok(profile.includes(`(allow network-outbound (remote unix-socket (subpath "${fullRunDir}")))`));
  assert.ok(profile.includes(`(allow process-exec (literal "${realExecPath()}"))`));
  assert.match(profile, /\(deny file-read\* file-write\* \(subpath "[^"]+\/\.secretless-ai"\) \(subpath "[^"]+\/Library\/Keychains"\) \(subpath "[^"]+\/offline\/sentinel"\)\)/);
  const own = ownAddress();
  assert.ok(own, 'precondition: a network interface besides loopback');
  const counter = fs.readFileSync(path.join(fullRunDir, 'egress.jsonl'), 'utf8');
  assert.equal(counter.includes(JSON.stringify(own.address)), false);
  assert.equal(JSON.stringify(full).includes(own.address), false);
  assert.equal(offlineBlock(full).includes(own.address), false);
  assert.equal(JSON.stringify(full).includes(fullRunDir), false);
});

function runClassFixture() {
  const dir = makeRunDir('bank-demo-test-');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const log = path.join(dir, 'egress.jsonl');
  const execPath = realExecPath();
  const profile = writeProfile(path.join(dir, 'egress.sb'), componentProfile({ runId: 'class', execPath, tcpPorts: [], unixSubpath: dir }));
  const r = spawnSync(SANDBOX_EXEC, ['-f', profile, execPath, path.join(FIX, 'class-calls.mjs')], {
    env: childEnv({ home, egressLog: log }),
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
  });
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { dir, out: JSON.parse(r.stdout.trim().split('\n').pop()), lines };
}

test('counter classes inside the block: exactly one line per call, for TCP, fetch, UDP, both name lookups, a child with a replaced environment, a worker thread and a child that exits at once', () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const { dir, out, lines } = runClassFixture();
  const root = out.pid;
  const at = (pid, pred) => lines.filter((l) => l.pid === pid && pred(l));
  const tcp192 = (l) => l.kind === 'tcp' && l.host === '192.0.2.1';
  // Every call was refused by the block.
  assert.equal(out.tcp, 'EPERM');
  assert.equal(out.fetch, 'EPERM');
  assert.equal(out.udp, 'EPERM');
  assert.notEqual(out.lookup, 'resolved');
  assert.notEqual(out.resolve4, 'resolved');
  assert.equal(out.worker, 'EPERM');
  // fetch refuses port 9 itself: no socket call, so no line.
  assert.equal(out.fetchPort9, 'bad port');
  // The root process: one hello, the TCP connect and the fetch, one UDP send,
  // one lookup, one resolve4, two children.
  assert.equal(at(root, (l) => l.kind === 'hello' && l.main).length, 1);
  assert.deepEqual(at(root, (l) => tcp192(l) && l.thread === 0).map((l) => l.port).sort((a, b) => a - b), [9, 80]);
  assert.equal(at(root, (l) => l.kind === 'udp').length, 1);
  assert.equal(at(root, (l) => l.fn === 'dns.lookup').length, 1);
  assert.equal(at(root, (l) => l.fn === 'dns.resolve4').length, 1);
  const children = at(root, (l) => l.kind === 'child');
  assert.equal(children.length, 2);
  for (const c of children) {
    assert.equal(lines.filter((l) => l.pid === c.childPid && l.kind === 'hello').length, 1, 'the child loaded the counter');
    assert.equal(lines.filter((l) => l.pid === c.childPid && tcp192(l)).length, 1, 'one line for the child attempt');
  }
  // The worker thread: its own hello and its one attempt.
  assert.equal(at(root, (l) => l.kind === 'hello' && !l.main).length, 1);
  assert.equal(at(root, (l) => tcp192(l) && l.thread !== 0).length, 1);
  // Every one of those is an outbound attempt, and nothing else is.
  const s = summarize({ file: path.join(dir, 'egress.jsonl'), ports: [], runDir: dir });
  assert.equal(s.status, 'measured');
  assert.equal(s.egressAttempts, 8);
});

test('a stray request from a process inside the block: the count reads 1, never 0', async () => {
  // With the run as usual, so both runs return all four decisions and
  // the count shows.
  const r = await runOfflineCheck({ extraScripts: [path.join(FIX, 'stray-fetch.mjs')] });
  assert.equal(r.status, 'measured', PRE);
  assert.equal(r.egressAttempts, 1);
  assert.equal(r.egress.attempts[0].kind, 'tcp');
  assert.equal(r.egress.attempts[0].host, '192.0.2.1');
  assert.equal(r.egress.attempts[0].port, 80);
  assert.equal(r.egress.attempts[0].process, 'stray-fetch.mjs');
  const text = offlineBlock(r);
  assert.match(text, /Outbound connection attempts: 1\./);
  assert.equal(/Outbound connection attempts: 0/.test(text), false);
});

test('a profile widened to localhost:*: the own address control reads ECONNREFUSED inside and the count reads not measured', async () => {
  const widen = (p) => p
    .replace(/\(allow network-outbound \(remote ip "localhost:\d+"\)\)\n/g, '')
    .replace('(deny process-exec', '(allow network-outbound (remote ip "localhost:*"))\n(deny process-exec');
  const r = await runOfflineCheck({ open: false, editProfile: widen });
  assert.equal(r.controls[0].insideOutcome, 'ECONNREFUSED', PRE);
  assert.equal(r.controls[0].inside, 'reachable inside');
  assertNotMeasured(r, REASON.addressControl);
});

// A rerun under a profile whose allow for its own processes no longer covers
// them: what the rerun answers is no complete answer, so the count reads not
// measured, the rerun ended without four decisions, with no decision
// compared and how the rerun ended recorded, and the text has no number
// after "attempts:" and no word that states a comparison.
function assertAllowFailsClosed(r) {
  assert.equal(r.status, 'not measured', PRE);
  assert.equal(r.reason, REASON.rerunStopped);
  assert.equal(r.egressAttempts, null);
  for (const o of r.outcomes) assert.equal(o.same, null, `scenario ${o.scenario}`);
  assert.equal(r.extra[0].same, null, 'the cross case');
  assert.equal(typeof r.rerunError, 'string');
  assert.ok(r.rerunError.length > 0, 'how the rerun ended is recorded');
  const text = offlineBlock(r);
  for (const l of text.split('\n')) assert.equal(/attempts:\s*\d/.test(l), false, l);
  assert.equal(/matched|Same four decisions|\bsame\b|\bdifferent\b/i.test(text), false, text);
}

test('B9 (j): a profile whose unix socket allow names a sibling of the run directory, which does not cover it: the rerun cannot reach its own processes, and the count reads not measured, the rerun ended without four decisions, with no comparison and no count', async () => {
  let generated = null;
  const sibling = (p) => {
    generated = p;
    return p.replace(/^\(allow network-outbound \(remote unix-socket \(subpath "([^"]+)"\)\)\)$/m, (_, dir) => `(allow network-outbound (remote unix-socket (subpath "${dir}-elsewhere")))`);
  };
  const { result: r, runDir } = await runOfflineCheckWithRun({ open: false, editProfile: sibling });
  const written = fs.readFileSync(path.join(runDir, 'egress.sb'), 'utf8');
  const allows = (p) => p.split('\n').filter((l) => l.startsWith('(allow') && l.includes(`(subpath "${runDir}")`));
  assert.deepEqual(allows(generated), [`(allow network-outbound (remote unix-socket (subpath "${runDir}")))`], 'precondition: the profile allowed the run directory\'s sockets');
  assert.deepEqual(allows(written), [], 'the rewritten profile still allows the run directory');
  assert.ok(written.split('\n').includes(`(allow network-outbound (remote unix-socket (subpath "${runDir}-elsewhere")))`), 'the allow names the sibling');
  assert.notEqual(written, generated);
  assert.equal(r.profileEdited, true);
  assertAllowFailsClosed(r);
});

test('B9 (k): a profile whose allow for one of the run\'s ports names a port that is not one of them: the rerun cannot reach that listener, and the count never reads measured: not measured, the rerun ended without four decisions, with no comparison and no count', async () => {
  const PORT_ALLOW = /^\(allow network-outbound \(remote ip "localhost:(\d+)"\)\)$/gm;
  const ports = (p) => [...p.matchAll(PORT_ALLOW)].map((m) => Number(m[1]));
  // Port 1: no listener of the run binds it.
  const other = 1;
  let generated = null;
  const movePort = (p) => {
    generated = p;
    return p.replace(/^\(allow network-outbound \(remote ip "localhost:\d+"\)\)$/m, `(allow network-outbound (remote ip "localhost:${other}"))`);
  };
  const { result: r, runDir } = await runOfflineCheckWithRun({ open: false, editProfile: movePort });
  const listed = ports(generated);
  const written = fs.readFileSync(path.join(runDir, 'egress.sb'), 'utf8');
  assert.ok(listed.length > 0, 'precondition: the profile allowed the run\'s ports');
  assert.equal(listed.includes(other), false, 'precondition: the new port is one of the run\'s ports');
  assert.deepEqual(ports(written), [other, ...listed.slice(1)], 'one listed port replaced');
  assert.notEqual(written, generated);
  assertAllowFailsClosed(r);
});

test('this machine\'s own address answers outside the block later than 2 s, and inside it is refused and counted once: the count reads not measured, the control to this machine\'s address failed, and the detail names the outside half', async () => {
  const own = ownAddress();
  assert.ok(own, 'precondition: a network interface besides loopback');
  // A stand in timing for the outside half: an answer from the host, 2.5 s
  // after the connect.
  const calls = [];
  const late = async (host, port) => {
    calls.push({ own: host === own.address, port });
    return { outcome: 'ECONNREFUSED', ms: 2500 };
  };
  const r = await runOfflineCheck({ open: false, connect: late });
  assert.deepEqual(calls, [{ own: true, port: 9 }], 'the outside half connects once, to this machine\'s own address, port 9');
  const row = r.controls.find((c) => c.id === 'network');
  assert.deepEqual([row.outsideOutcome, row.insideOutcome, row.lines], ['ECONNREFUSED', 'EPERM', 1], PRE);
  assert.equal(row.pass, false);
  assertNotMeasured(r, REASON.addressControl);
  const details = r.egress.guards.filter((g) => g.reason === REASON.addressControl).map((g) => g.detail);
  assert.deepEqual(details, ['own address did not answer outside the block within 2 s']);
});

test('a native module load inside the block: the count reads not measured, a process tried to load a native module', async () => {
  const r = await runOfflineCheck({ open: false, extraScripts: [path.join(FIX, 'dlopen-missing.mjs')] });
  assertNotMeasured(r, REASON.nativeModule);
});

test('class B, store row: a profile without the sentinel deny: the store deny row reads reachable inside, the rerun answers with no decision and starts no bank, and the count reads not measured, the control reading a test file failed, with no rerun ended reason recorded', async () => {
  const drop = (p) => p.replace(/ \(subpath "[^"]*\/offline\/sentinel"\)/, '');
  const witness = witnessStandIn();
  const { result: r, runDir } = await runOfflineCheckWithRun({ open: false, editProfile: drop, readWitness: witness.read });
  const row = r.controls.find((c) => c.id === 'store deny form');
  assert.equal(row.inside, 'reachable inside', PRE);
  assert.equal(row.insideOutcome, 'read');
  assert.equal(row.pass, false);
  assertStoppedBeforeScenarios(r, runDir, witness);
  assertNotMeasured(r, REASON.storeControl);
});

test('class B, store row, no address besides loopback: a profile without the sentinel deny on a machine with no network interface besides loopback: the count reads not measured, the control reading a test file failed shows, no IPv4 address was found besides loopback is the earliest of its reasons, and no rerun ended reason is recorded', async () => {
  const drop = (p) => p.replace(/ \(subpath "[^"]*\/offline\/sentinel"\)/, '');
  const witness = witnessStandIn();
  const { result: r } = await runOfflineCheckWithRun({ open: false, editProfile: drop, readWitness: witness.read, interfaces: { lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] } });
  assert.equal(r.controls.find((c) => c.id === 'store deny form').insideOutcome, 'read', PRE);
  assert.equal(r.controls[0].outside, 'not run', PRE);
  assert.equal(r.reason, REASON.storeControl);
  assert.equal(r.reasons[0], REASON.noAddress);
  assert.equal(r.reasons.includes(REASON.rerunStopped), false);
  assertNotMeasured(r, REASON.storeControl, [REASON.noAddress, REASON.storeControl]);
});

test('class B, exec row: a profile that lets the copy of /usr/bin/true run: the exec deny row reads reachable inside, the rerun answers with no decision and starts no bank, and the count reads not measured, the control running a test program failed, with a process ran uncounted and no rerun ended reason recorded', async () => {
  const allow = (p) => {
    const dir = p.match(/\(remote unix-socket \(subpath "([^"]+)"\)\)/)[1];
    return `${p}(allow process-exec (literal "${dir}/offline/true"))\n`;
  };
  const witness = witnessStandIn();
  const { result: r, runDir } = await runOfflineCheckWithRun({ open: false, editProfile: allow, readWitness: witness.read });
  const row = r.controls.find((c) => c.id === 'exec deny form');
  assert.equal(row.inside, 'reachable inside', PRE);
  assert.equal(row.insideOutcome, 'ran');
  assert.equal(row.pass, false);
  assertStoppedBeforeScenarios(r, runDir, witness);
  // The copy of /usr/bin/true that ran loads no counter, so it is also a
  // process that ran uncounted.
  assertNotMeasured(r, REASON.execControl, [REASON.execControl, REASON.uncounted]);
});

test('class B, exec row: a profile without the exec deny form, the keychain tool still refused by name: the copy of /usr/bin/true runs inside, the rerun answers with no decision and starts no bank, and the count reads not measured, the control running a test program failed, with a process ran uncounted and no rerun ended reason recorded', async () => {
  // Drops the rule that refuses every exec but this Node.js, and no other line.
  const drop = (p) => {
    const out = p.replace(/^\(deny process-exec \(with message "[^"]+"\)\)\n/m, '');
    assert.notEqual(out, p, 'the profile has no exec deny form line to drop');
    assert.match(out, /^\(deny process-exec \(literal "\/usr\/bin\/security"\)/m);
    return out;
  };
  const witness = witnessStandIn();
  const { result: r, runDir } = await runOfflineCheckWithRun({ open: false, editProfile: drop, readWitness: witness.read });
  const row = r.controls.find((c) => c.id === 'exec deny form');
  assert.equal(row.inside, 'reachable inside', 'the exec control was refused by a rule other than the exec deny form');
  assert.equal(row.insideOutcome, 'ran');
  assert.equal(row.pass, false);
  assertStoppedBeforeScenarios(r, runDir, witness);
  assertNotMeasured(r, REASON.execControl, [REASON.execControl, REASON.uncounted]);
});

test('class B, store row: a reader that throws, on a profile without the sentinel deny: the check still answers, the rerun\'s root ends, the result records no witness reading, and the count reads not measured, the control reading a test file failed, with no rerun ended reason recorded', async () => {
  const drop = (p) => p.replace(/ \(subpath "[^"]*\/offline\/sentinel"\)/, '');
  const pids = [];
  const throwing = ({ pid }) => {
    pids.push(pid);
    throw new Error('the reader failed');
  };
  const r = await runOfflineCheck({ open: false, editProfile: drop, readWitness: throwing });
  assert.equal(r.controls.find((c) => c.id === 'store deny form').insideOutcome, 'read', PRE);
  assert.equal(pids.length, 1);
  assert.throws(() => process.kill(pids[0], 0), { code: 'ESRCH' }, 'the rerun\'s root still runs');
  assert.equal(r.witness, null);
  assertNotMeasured(r, REASON.storeControl);
});

test('a rerun that answers without a decision for each of the four scenarios: the count reads not measured, the rerun ended without four decisions, never a number', async () => {
  // A step the rerun cannot run, so its scenarios stop before scenario 1;
  // and a chain that ends after scenario 1. Each rerun still makes its
  // controls and answers.
  for (const chain of [['not-a-step'], ['setup', 'approve', '1']]) {
    const r = await runOfflineCheck({ open: false, chain });
    assert.equal(r.controls.length, 3, `${chain}: the rerun answered`);
    assert.ok(r.outcomes.some((o) => o.blocked === null), `${chain}: a scenario without a decision`);
    assertNotMeasured(r, REASON.rerunStopped);
  }
});

test('no network interface besides loopback: the count reads not measured, no IPv4 address was found besides loopback, never a number', async () => {
  const r = await runOfflineCheck({ open: false, interfaces: { lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] } });
  assert.equal(r.controls[0].outside, 'not run', PRE);
  assertNotMeasured(r, REASON.noAddress);
});

test('a counter file that cannot be read: the count record was missing or unreadable shows, and the controls whose lines it lost are recorded too', async () => {
  const r = await runOfflineCheck({ open: false, extraScripts: [path.join(FIX, 'counter-garbled.mjs')] });
  // Every line after the one that is not JSON is lost, the two control
  // connections among them.
  const held = ownAddress()
    ? [REASON.countRecord, REASON.counterControl, REASON.addressControl]
    : [REASON.countRecord, REASON.noAddress, REASON.counterControl];
  assertNotMeasured(r, REASON.countRecord, held);
});

test('a record without the hello line of the rerun\'s root process: the 192.0.2.1 control was not counted from a counted process, and the count reads not measured', async () => {
  const r = await runOfflineCheck({ open: false, extraScripts: [path.join(FIX, 'counter-replaced.mjs')] });
  assert.equal(r.decision2.hello, false, PRE);
  assert.equal(r.decision2.outcome, 'EPERM');
  assert.equal(r.decision2.pass, false);
  // The process that replaced the file lost its own hello line with it.
  assertNotMeasured(r, REASON.counterControl, [REASON.counterControl, REASON.uncounted]);
});

test('a process started without the egress counter (its NODE_OPTIONS replaced): the count reads not measured, a process ran uncounted', async () => {
  const r = await runOfflineCheck({ open: false, extraScripts: [path.join(FIX, 'uncounted-child.mjs')] });
  assertNotMeasured(r, REASON.uncounted);
});

test('a process with QUIC enabled on its command line: the count reads not measured, a process started with the QUIC flag', { skip: !QUIC_OPTION && 'this Node.js has no --experimental-quic option, so no process can enable QUIC' }, async () => {
  const r = await runOfflineCheck({ open: false, extraScripts: [path.join(FIX, 'quic-child.mjs')] });
  assertNotMeasured(r, REASON.quic);
});

test('the rerun ends after its hello line and before it answers: the count reads not measured, the rerun ended without four decisions', async () => {
  const r = await runOfflineCheck({ open: false, extraScripts: [path.join(FIX, 'end-rerun.mjs')] });
  assertNotMeasured(r, REASON.rerunStopped);
  assert.equal(r.decision2, null);
  assert.deepEqual(r.controls, []);
  for (const o of r.outcomes) assert.equal(o.blocked, null);
});

test('a sandbox profile that does not parse: sandbox-exec exits before the rerun writes its hello line, and the check reads not run, the sandbox could not be applied', async () => {
  const r = await runOfflineCheck({ open: false, editProfile: (p) => `${p}(not a rule\n` });
  assertNotRun(r, offlineBlock(r), 'the sandbox could not be applied', 'Why: the check needs its own sandbox, and macOS refused it.');
});

test('the check started by a process already inside another sandbox: the apply is refused, and the check reads not run, the demo is already inside another sandbox, with no count read', () => {
  assert.equal(sandboxStatus().available, true, PRE);
  const dir = makeRunDir('bank-demo-test-');
  const denied = path.join(dir, 'true');
  fs.copyFileSync('/usr/bin/true', denied);
  // A profile of the test's own: the exec of a copy of /usr/bin/true
  // refused, beside the boundary's terms.
  const outer = resolveProfilePaths(outerProfileText([`(deny process-exec (literal "${fs.realpathSync(denied)}"))`]));
  const run = spawnSync(SANDBOX_EXEC, ['-p', outer, process.execPath, path.join(FIX, 'outer-sandbox-check.mjs')], {
    env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: os.tmpdir(), LANG: 'C', TZ: 'UTC' },
    cwd: dir,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(run.status, 0, run.stderr);
  const { result, text } = JSON.parse(run.stdout.trim().split('\n').pop());
  assertNotRun(result, text, 'the demo is already inside another sandbox', 'Why: the check needs a terminal outside any other sandbox.');
  assert.equal('egress' in result, false);
});
