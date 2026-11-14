// The offline check: the grant path scenarios run twice on fresh banks, once
// the way every run of the demo is made (the run as usual) and once under one
// macOS sandbox profile that refuses every network destination outside this
// machine (network blocked).
// The check compares the bank's decisions and counts every outbound attempt
// the blocked run's processes make.
//
// The blocked run is one run id, one run directory, one profile file
// (<runDir>/egress.sb) and one counter file (<runDir>/egress.jsonl). Its
// profile is written after its three loopback listener ports are fixed, with
// one allow line per port, never a wildcard. Before it starts, this process
// makes the outside halves of three controls: a connect to this machine's own
// address on the interface listed earliest that is up and not loopback,
// port 9, which must be answered; a read of a sentinel
// file under the same deny form as the credential store, which must succeed;
// and a run of a copy of /usr/bin/true under the exec deny form, which must
// succeed. Inside, each must be refused, and the root process's connect to
// 192.0.2.1 port 9 (a documentation address) must be refused and counted
// exactly once. Any other result makes the count read "not measured", never 0.
//
// Whether the rerun ran is decided by its root process: its hello line, or
// any answer from it, ready included, shows it started under its profile. The
// root is started before anything else, once, under its own profile, and
// waits there to be asked; the run as usual starts after it answers
// ready, never before. With neither (sandbox-exec missing, refused because
// this process already runs under a profile, or ended for any other reason)
// the check reads "not run", nothing else starts and nothing is counted.
// sandbox-exec is never started a second time, with or without a profile. How
// it ended (the spawn error or the exit code, and the line its stderr starts
// with) goes to the run log, <runDir>/offline/not-run.json, and never to the
// result. A rerun that started and returned no complete answer makes the
// count read "not measured" with the reason that it ended without four
// decisions, and every other reason that holds is recorded beside it. A
// complete answer has no error and a decision for each of the four
// scenarios and for the cross case; a rerun that stopped without an answer
// gave none. A network open run that throws after the root answered ready
// ends the check the same way: the rerun is not asked, and the check answers
// once the root and every process the open run started have ended. What the
// open run threw and how sandbox-exec ended go to the same run log, and never
// to the result. A network open run that returns without a decision for each
// of the four scenarios and for the cross case ends the check the same way,
// and the keys it lacked go to the same run log. A rerun that a deny form
// seen not refusing stopped (below)
// shows that control's reason instead, and the reason that it ended without
// four decisions is not recorded. A scenario is the same or different when
// both runs carry its decision and the rerun's answer was complete; a record
// without one compares no decision.
//
// The address of this machine is used for the two connects and nothing
// else. It is never returned, printed or written to a file by this module.
//
// A deny form seen not refusing (the sentinel read inside, or the copy of
// /usr/bin/true executed inside) stops the rerun before its scenarios and
// any extra process start, so no scenario carries a blocked decision and the
// count reads not measured. Before the rerun's root ends, a reader the caller
// gives is asked for its reading of that root. The result records what the
// reader returned, and whether the profile was edited.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Channel } from '../orchestrator/channel.mjs';
import { childEnv } from '../orchestrator/env.mjs';
import { holdLoopbackPorts } from '../orchestrator/ports.mjs';
import { makeRunDir } from '../orchestrator/run.mjs';
import { SANDBOX_EXEC, componentProfile, realExecPath, writeProfile } from '../orchestrator/sandbox.mjs';
import { OFFLINE_CHAIN, OFFLINE_SCENARIOS, offlineDecisions, runSteps } from '../scenarios/engine.mjs';
import { FICTIONAL_LINE, grantPathLabels } from '../scenarios/labels.mjs';
import { hasDecision } from '../view/offline-compare.mjs';
import { COUNTER_CONTROL, NOT_MEASURED, NOT_RUN, OWN_ADDRESS_PORT, OWN_ADDRESS_WORDS, notRunReason, readCounter, reasonsInOrder, summarize } from './classify.mjs';
import { connectOnce, execControl, ownAddress, readControl } from './controls.mjs';

const RERUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'rerun.mjs');
// How long the rerun's root process has to answer once sandbox-exec started.
const READY_MS = 30000;
// A host path in an error message or a stderr line; the result never carries one.
const hidePaths = (text) => String(text).replace(/\/[^\s'"]+/g, '<path>');

const mkdir700 = (p) => {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  fs.chmodSync(p, 0o700);
  return p;
};

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Key order is fixed by offlineDecisions, so equal decisions serialize alike.
const same = (a, b) => a !== null && b !== null && a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b);

// A scenario's decision from one run's decisions, or null: a missing key and
// an error record in its place are no decision.
const decisionOf = (decisions, scenario) => (decisions && hasDecision(decisions[scenario]) ? decisions[scenario] : null);

// A complete answer from the network open run has a decision for each of
// these, in the shipped chain's order: the four scenarios and the cross case.
const OPEN_RUN_KEYS = ['1', '2', 'cross', '3', '4'];

// The reason shown when no deny form stopped the rerun. A rerun that started
// and returned no complete answer shows that it ended without four
// decisions, and every other reason that holds is recorded beside it;
// otherwise the earliest that holds, in the closed list's order.
const shownReason = (reasons) => (reasons.includes(NOT_MEASURED.rerunStopped) ? NOT_MEASURED.rerunStopped : reasons[0]);

const outsideWord = (ok) => (ok ? 'reachable outside' : 'not reachable outside');
function insideWord(outcome) {
  if (outcome === 'EPERM') return 'refused inside';
  if (outcome === 'timeout') return 'not answered inside';
  return 'reachable inside';
}

// A deny form seen not refusing, read from the control's outcome and never
// from the row's words: the read under the store deny form succeeded, or the
// copy under the exec deny form was executed (it ran, or it exited with a
// status). The rerun applies the same test to its two controls before it
// starts anything else.
const storeFormNotRefusing = (outcome) => outcome === 'read';
const execFormNotRefusing = (outcome) => outcome === 'ran' || (typeof outcome === 'string' && outcome.startsWith('exit '));

// The reason of a result's store or exec control row whose deny form was
// seen not refusing, the store row's when both were, read from
// controls[].insideOutcome; null when neither was.
export function formNotRefusingReason(result) {
  for (const row of result?.controls ?? []) {
    if (row.id === 'store deny form' && storeFormNotRefusing(row.insideOutcome)) return NOT_MEASURED.storeControl;
    if (row.id === 'exec deny form' && execFormNotRefusing(row.insideOutcome)) return NOT_MEASURED.execControl;
  }
  return null;
}

function base(extra = {}) {
  return {
    check: 'offline',
    platform: `${process.platform} ${os.release()}`,
    ...extra,
    labels: grantPathLabels('offline'),
    fictionalLine: FICTIONAL_LINE,
  };
}

// No count, no placeholder in its place and no decision labelled same. The
// run id names the run log, which holds how sandbox-exec ended; the result
// never does.
function notRun(reason, runId = null) {
  return base({
    status: 'not run',
    reason,
    reasons: [reason],
    ...(runId ? { runId } : {}),
    controls: [],
    outcomes: OFFLINE_SCENARIOS.map((scenario) => ({ scenario, open: null, blocked: null, same: null })),
    allSame: false,
    egressAttempts: null,
  });
}

// Whether the rerun's root process wrote its hello line, which it does as it
// starts under its profile with the counter loaded. sandbox-exec starts the
// rerun in its own place, so the root keeps sandbox-exec's pid. With no
// counter file there is nothing to read.
function wroteHello(file, pid) {
  if (!fs.existsSync(file)) return false;
  return readCounter(file).lines.some((l) => l.kind === 'hello' && l.main && l.pid === pid);
}

function writeRunLog(offlineDir, record) {
  fs.writeFileSync(path.join(offlineDir, 'not-run.json'), `${JSON.stringify({ status: 'not run', ...record })}\n`, { mode: 0o600 });
}

// What the network open run threw, for the run log: the error's name, its
// code or null, its message with host paths hidden and this machine's address
// replaced, and the open run's own run id when the check holds it.
function openRunRecord({ error, runId }, target) {
  let message = hidePaths(typeof error?.message === 'string' ? error.message : error);
  if (target) message = message.split(target.address).join(OWN_ADDRESS_WORDS);
  return { error: typeof error?.name === 'string' ? error.name : null, code: error?.code ?? null, message, runId: runId ?? null };
}

// Starts sandbox-exec once with the rerun's profile. A spawn the system
// refuses ends in an error event and no exit event, so it is settled before
// the channel opens. end() stops the root process and says how sandbox-exec
// ended, with the line its stderr starts with.
async function startRoot({ sandboxExec, profileFile, execPath, env, cwd }) {
  const child = spawn(sandboxExec, ['-f', profileFile, execPath, RERUN], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let spawnError = null;
  child.on('error', (err) => { spawnError ??= err; });
  await new Promise((resolve) => { child.once('spawn', resolve); child.once('error', resolve); });
  if (spawnError) {
    const end = { spawnError: spawnError.code ?? 'unknown', exitCode: null, signal: null, stderr: null };
    return { pid: null, channel: null, end: async () => end };
  }
  let stderr = '';
  child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk.toString('utf8'); });
  const closed = new Promise((resolve) => { child.once('close', resolve); });
  const channel = new Channel(child, { name: 'offline rerun', stderrLog: path.join(cwd, 'stderr.log') });
  const end = async () => {
    const exited = await channel.stop();
    // Its stderr is read to the end before the line it starts with is judged.
    await Promise.race([closed, new Promise((resolve) => { setTimeout(resolve, 2000).unref(); })]);
    return { spawnError: null, exitCode: exited.code ?? null, signal: exited.signal ?? null, stderr: stderr.split('\n')[0] || null };
  };
  return { pid: child.pid, channel, end };
}

// The counter wrote this machine's address on the decision 3 line. Once the
// lines are sorted, the file keeps a placeholder in its place, so no copy of
// the run directory carries the address.
function hideOwnAddress(egressLog, target) {
  if (!target || !fs.existsSync(egressLog)) return;
  const text = fs.readFileSync(egressLog, 'utf8');
  fs.writeFileSync(egressLog, text.split(JSON.stringify(target.address)).join(JSON.stringify(OWN_ADDRESS_WORDS)), { mode: 0o600 });
}

// The run id of a network open run that threw after its run started, by the
// error it threw, for the run log. The error itself is left as it was thrown.
const openRunIds = new WeakMap();

// The network open run. A throw after runSteps returned its run keeps that
// run's id; a throw inside a step is stopped by runSteps, and a start that
// failed by DemoRun.create.
async function openRun(chain, origins) {
  const o = await runSteps(chain, { origins }, 'offline');
  return openRunAnswer(o).catch((error) => {
    if (Object(error) === error) openRunIds.set(error, o.run.runId);
    throw error;
  });
}

// The run is stopped on every path out of here, before its counter file is
// read.
async function openRunAnswer(o) {
  let decisions;
  try {
    decisions = offlineDecisions(o.result.steps);
  } finally {
    await o.run.stop();
  }
  const { runId, runDir, egressLog } = o.run;
  const ports = Object.values(o.run.ports);
  const egress = summarize({ file: egressLog, ports, runDir });
  return {
    runId,
    decisions,
    // The bank and the four agent processes, both paths. The process that
    // started them makes the customers' requests to the bank's loopback port
    // and nothing else; it is not counted here.
    egress: { scope: 'the bank and the agent processes of both paths', status: egress.status, reason: egress.reason, egressAttempts: egress.egressAttempts, attempts: egress.attempts },
  };
}

export async function runOfflineCheck(options = {}) {
  return (await runOfflineCheckWithRun(options)).result;
}

// The same, with the blocked run's directory for the tests. The directory
// is never part of the result: it holds a host path. readWitness, when
// given, is called as readWitness({ pid, profileFile }) with the rerun's root
// and its profile file when a deny form was seen not refusing, before the
// root ends; the result records what it returned as witness.
export async function runOfflineCheckWithRun({
  sandboxExec = SANDBOX_EXEC,
  editProfile = null,
  readWitness = null,
  extraScripts = [],
  chain = OFFLINE_CHAIN,
  open = true,
  origins = [],
  interfaces = undefined,
  connect = connectOnce,
  timeoutMs = 240000,
} = {}) {
  // Not macOS: there is no macOS sandbox, and nothing is started.
  if (process.platform !== 'darwin') {
    return { result: notRun(NOT_RUN.noSandbox), runDir: null, egressLog: null };
  }

  const runId = crypto.randomBytes(4).toString('hex');
  const runDir = makeRunDir();
  // The blocked run's ports stay taken until just before its bank listens on
  // them, so the open run is not handed one of them meanwhile.
  const held = await holdLoopbackPorts(3);
  const [online, resource, token] = held.ports;
  const ports = { online, resource, token };
  const offlineDir = mkdir700(path.join(runDir, 'offline'));
  const sentinelDir = mkdir700(path.join(offlineDir, 'sentinel'));
  const sentinelFile = path.join(sentinelDir, 'sentinel.txt');
  fs.writeFileSync(sentinelFile, 'offline check sentinel\n', { mode: 0o600 });
  const execCopy = path.join(offlineDir, 'true');
  fs.copyFileSync('/usr/bin/true', execCopy);
  fs.chmodSync(execCopy, 0o700);
  const home = mkdir700(path.join(offlineDir, 'home'));
  const egressLog = path.join(runDir, 'egress.jsonl');
  const execPath = realExecPath();
  const target = ownAddress(interfaces);

  const generated = componentProfile({ runId, execPath, tcpPorts: [online, resource, token], unixSubpath: runDir, sentinelDir });
  const profile = editProfile ? editProfile(generated) : generated;
  // Edited when the profile the rerun runs under is not the generated text.
  const profileEdited = profile !== generated;
  const profileFile = writeProfile(path.join(runDir, 'egress.sb'), profile);

  // The rerun's root process before anything else, once, under its own
  // profile. It answers ready after the counter wrote its hello line, then
  // waits to be asked.
  const root = await startRoot({ sandboxExec, profileFile, execPath, env: childEnv({ home, egressLog }), cwd: offlineDir });
  let failure = null;
  let ready = false;
  if (root.channel) {
    try {
      await root.channel.call('ready', {}, { timeoutMs: READY_MS });
      ready = true;
    } catch (err) {
      failure = err.remote ? err.message : 'no answer';
    }
  }

  let opened = null;
  // What the network open run threw, when it threw; the rerun is then not
  // asked.
  let openThrew = null;
  let outside = null;
  let inside = null;
  if (ready) {
    try {
      opened = open ? await openRun(chain, origins) : null;
    } catch (error) {
      // Kept for the run log and not thrown again; the check answers below.
      openThrew = { error, runId: openRunIds.get(error) ?? null };
    }
    await held.release();
  }
  // A network open run that returned without a decision for each of the four
  // scenarios and for the cross case has not completed: the rerun is not
  // asked, and the check ends the way it ends when the open run threw. The
  // keys it lacked go to the run log, never to the result.
  const openLacks = opened ? OPEN_RUN_KEYS.filter((k) => decisionOf(opened.decisions, k) === null) : [];
  const openShort = openLacks.length > 0;
  if (ready && !openThrew && !openShort) {
    // Outside halves, immediately before the rerun starts. The tests pass a
    // stand in timing for the connect to this machine's own address.
    outside = {
      network: target ? await connect(target.address, OWN_ADDRESS_PORT) : null,
      sentinel: readControl(sentinelFile),
      exec: execControl(execCopy),
    };
    try {
      inside = await root.channel.call('rerun', {
        chain,
        runId,
        runDir,
        ports,
        offlineDir,
        egressLog,
        sentinelFile,
        execControl: execCopy,
        ownAddress: target ? target.address : null,
        extraScripts,
      }, { timeoutMs });
    } catch (err) {
      inside = null;
      failure = err.remote ? err.message : 'no answer';
    }
  }
  await held.release();
  // A deny form seen not refusing: the caller's reader reads the rerun's
  // root while it still runs under the profile, and the root ends after.
  let witness = null;
  if (inside && readWitness && (storeFormNotRefusing(inside.sentinel?.outcome) || execFormNotRefusing(inside.exec?.outcome))) {
    try {
      witness = (await readWitness({ pid: root.pid, profileFile })) ?? null;
    } catch {
      witness = null;
    }
  }
  const end = await root.end();
  const redact = target ? [target.address] : [];
  if (!inside) {
    // With no hello line and no answer, the rerun did not run: one reason,
    // and how sandbox-exec ended goes to the run log and nowhere else. A
    // root that answered ready started under its profile, with or without
    // its hello line.
    if (!wroteHello(egressLog, root.pid) && !ready) {
      const reason = notRunReason(end);
      writeRunLog(offlineDir, { runId, reason, ...end });
      return { result: notRun(reason, runId), runDir, egressLog };
    }
    const exit = end.exitCode !== null ? `exit ${end.exitCode}` : `signal ${end.signal ?? 'none'}`;
    // The rerun started and stopped before it answered, or was stopped before
    // it was asked because the network open run threw or returned without a
    // complete answer. What its processes wrote is still read, and the count
    // reads not measured.
    const rootControls = [{ id: 'decision2', pid: root.pid, ...COUNTER_CONTROL }];
    if (target) rootControls.push({ id: 'decision3', pid: root.pid, host: target.address, port: OWN_ADDRESS_PORT });
    const egress = summarize({ file: egressLog, ports: [online, resource, token], runDir, controls: rootControls, redact });
    hideOwnAddress(egressLog, target);
    // When the open run threw, how sandbox-exec ended goes to the run log and
    // nowhere else.
    const detail = openThrew || openShort ? 'the rerun was stopped before it was asked' : `the rerun stopped without an answer (${exit}, ${hidePaths(failure)})`;
    const guards = [...egress.guards, { reason: NOT_MEASURED.rerunStopped, detail }];
    const reasons = reasonsInOrder(guards);
    const result = base({
      status: 'not measured',
      reason: shownReason(reasons),
      reasons,
      runId,
      controls: [],
      outcomes: OFFLINE_SCENARIOS.map((scenario) => ({ scenario, open: decisionOf(opened && opened.decisions, scenario), blocked: null, same: null })),
      extra: [{ scenario: 'cross', open: decisionOf(opened && opened.decisions, 'cross'), blocked: null, same: null }],
      allSame: false,
      egressAttempts: null,
      decision2: null,
      egress: {
        status: 'not measured',
        guards,
        attempts: egress.attempts,
        inTree: egress.inTree,
        literalLookups: egress.literalLookups,
        processes: egress.processes,
        workerThreads: egress.workerThreads,
        lines: egress.lines,
      },
      // A rerun that was not asked did not fail.
      rerunError: failure === null ? null : hidePaths(failure),
      openRun: opened ? { runId: opened.runId, egress: opened.egress } : null,
      profileSha256: sha256(profile),
      profileLines: profile.trim().split('\n').length,
      profileEdited,
      witness,
    });
    // One record of this ending, before the check answers: its status and
    // reason, what the open run threw or the keys the open run's answer
    // lacked, and how sandbox-exec ended once the check stopped it.
    if (openThrew || openShort) writeRunLog(offlineDir, { status: result.status, runId, reason: result.reason, openRun: openThrew ? openRunRecord(openThrew, target) : { error: null, code: null, message: null, runId: opened.runId, missing: openLacks }, ...end });
    return { result, runDir, egressLog };
  }

  const controls = [{ id: 'decision2', pid: inside.pid, ...COUNTER_CONTROL }];
  if (target) controls.push({ id: 'decision3', pid: inside.pid, host: target.address, port: OWN_ADDRESS_PORT });
  const egress = summarize({ file: egressLog, ports: [online, resource, token], runDir, controls, redact });
  const guards = [...egress.guards];
  hideOwnAddress(egressLog, target);

  // Decision 2: refused within 2 s, counted exactly once, from a counted process.
  const d2 = inside.decision2;
  const decision2 = {
    target: `${COUNTER_CONTROL.host} port ${COUNTER_CONTROL.port}`,
    inside: insideWord(d2.outcome),
    outcome: d2.outcome,
    ms: d2.ms,
    lines: egress.controlLines.decision2,
    hello: egress.helloPids.includes(inside.pid),
  };
  decision2.pass = d2.outcome === 'EPERM' && d2.ms <= 2000 && decision2.lines === 1 && decision2.hello;
  if (!decision2.pass) guards.push({ reason: NOT_MEASURED.counterControl, detail: 'the 192.0.2.1 control was not refused and counted once' });

  // Decision 3 and the two sibling controls: the three control rows, printed
  // before the outcomes.
  const net = { id: 'network', control: `${OWN_ADDRESS_WORDS}, port ${OWN_ADDRESS_PORT}` };
  if (!target) {
    Object.assign(net, { interface: null, outside: 'not run', inside: 'not run', pass: false, note: 'no network interface besides loopback' });
    guards.push({ reason: NOT_MEASURED.noAddress, detail: 'no network interface besides loopback' });
  } else {
    const answered = outside.network.outcome === 'connected' || outside.network.outcome === 'ECONNREFUSED';
    const d3 = inside.decision3;
    Object.assign(net, {
      interface: target.interface,
      outside: answered ? outsideWord(true) : outside.network.outcome === 'timeout' ? 'not answered outside' : outsideWord(false),
      outsideOutcome: outside.network.outcome,
      inside: insideWord(d3.outcome),
      insideOutcome: d3.outcome,
      lines: egress.controlLines.decision3,
    });
    // Two halves: outside, an answer from the host within 2 s; inside,
    // refused and counted once. The detail names the half that failed.
    const outsideHalf = answered && outside.network.ms <= 2000;
    const insideHalf = d3.outcome === 'EPERM' && net.lines === 1;
    net.pass = outsideHalf && insideHalf;
    if (!outsideHalf) guards.push({ reason: NOT_MEASURED.addressControl, detail: 'own address did not answer outside the block within 2 s' });
    else if (!insideHalf) guards.push({ reason: NOT_MEASURED.addressControl, detail: 'own address was not refused and counted once inside the block' });
  }
  const sentinel = {
    id: 'store deny form',
    control: 'a sentinel directory under the credential store deny form',
    outside: outsideWord(outside.sentinel.outcome === 'read'),
    outsideOutcome: outside.sentinel.outcome,
    inside: inside.sentinel.outcome === 'read' ? 'reachable inside' : insideWord(inside.sentinel.outcome),
    insideOutcome: inside.sentinel.outcome,
  };
  sentinel.pass = outside.sentinel.outcome === 'read' && inside.sentinel.outcome === 'EPERM';
  const exec = {
    id: 'exec deny form',
    control: 'a copy of /usr/bin/true under the exec deny form',
    outside: outsideWord(outside.exec.outcome === 'ran'),
    outsideOutcome: outside.exec.outcome,
    inside: inside.exec.outcome === 'ran' ? 'reachable inside' : insideWord(inside.exec.outcome),
    insideOutcome: inside.exec.outcome,
  };
  exec.pass = outside.exec.outcome === 'ran' && inside.exec.outcome === 'EPERM';
  for (const [row, reason] of [[sentinel, NOT_MEASURED.storeControl], [exec, NOT_MEASURED.execControl]]) {
    if (!row.pass) guards.push({ reason, detail: `${row.control}: ${row.outside}, ${row.inside}` });
  }

  const blocked = inside.decisions;
  // A scenario is the same or different when both runs carry its decision;
  // a missing decision is never different.
  const outcomes = OFFLINE_SCENARIOS.map((scenario) => {
    const o = decisionOf(opened && opened.decisions, scenario);
    const b = decisionOf(blocked, scenario);
    return { scenario, open: o, blocked: b, same: o && b ? same(o, b) : null };
  });
  const cross = {
    scenario: 'cross',
    open: decisionOf(opened && opened.decisions, 'cross'),
    blocked: decisionOf(blocked, 'cross'),
  };
  cross.same = cross.open && cross.blocked ? same(cross.open, cross.blocked) : null;
  // A deny form seen not refusing withheld the scenarios: that row's reason
  // shows, and the rerun is not said to have ended without four decisions.
  const formStop = storeFormNotRefusing(inside.sentinel.outcome) || execFormNotRefusing(inside.exec.outcome);
  // A complete answer has no error and a decision for each of the four
  // scenarios and for the cross case. Without one, the rerun ended without
  // four decisions and what it counted is not a count; the detail names what
  // the answer lacked.
  const lacked = [
    inside.error != null && 'with an error',
    outcomes.some((o) => o.blocked === null) && 'without a decision for each of the four scenarios',
    cross.blocked === null && 'without a decision for the cross case',
  ].filter(Boolean);
  if (!formStop && lacked.length > 0) {
    guards.push({ reason: NOT_MEASURED.rerunStopped, detail: `the rerun answered ${lacked.join(' and ')}` });
  }
  // A record without a complete answer, or stopped by a deny form, keeps what
  // the rerun returned and compares none of it.
  const compared = !formStop && lacked.length === 0;
  if (!compared) {
    for (const o of outcomes) o.same = null;
    cross.same = null;
  }

  const measured = guards.length === 0;
  const reasons = reasonsInOrder(guards);
  const result = base({
    status: measured ? 'measured' : 'not measured',
    reason: measured ? null : formStop ? formNotRefusingReason({ controls: [net, sentinel, exec] }) : shownReason(reasons),
    reasons,
    runId,
    controls: [net, sentinel, exec],
    outcomes,
    extra: [cross],
    allSame: compared && outcomes.every((o) => o.same === true),
    egressAttempts: measured ? egress.egressAttempts : null,
    decision2,
    egress: {
      status: measured ? 'measured' : 'not measured',
      guards,
      attempts: egress.attempts,
      inTree: egress.inTree,
      literalLookups: egress.literalLookups,
      processes: egress.processes,
      workerThreads: egress.workerThreads,
      lines: egress.lines,
    },
    rerunError: inside.error,
    extraProcesses: inside.extra,
    openRun: opened ? { runId: opened.runId, egress: opened.egress } : null,
    profileSha256: sha256(profile),
    profileLines: profile.trim().split('\n').length,
    profileEdited,
    witness,
  });
  return { result, runDir, egressLog };
}
