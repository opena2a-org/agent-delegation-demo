// npm start and npm run scenarios start every part under its own profile, or
// start nothing. Each refuses a platform the README does not list the way npm
// start refuses Windows. Then one probe process starts under a profile of its
// own before every other check. A terminal inside another sandbox (exit 71,
// or an exec of sandbox-exec it may not make), a Mac without sandbox-exec and
// a profile macOS refuses each end in lines that name the cause and a Fix
// line that is not the failing command alone: exit 1, no Ready line, no part
// started and nothing listening. On macOS no run starts a part without its
// profile, and a part whose profile was not applied stops the demo with the
// same lines. The witness reads, from outside, the kernel's record of the
// launcher and of each process it started under a profile.
//
// Each refusal is read from a run whose input breaks the rule: a preload in
// the launcher's own process sets the platform, or points sandbox-exec at a
// file that does not exist or at a stand-in, or an outer profile holds the
// launcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as classify from '../src/egress/classify.mjs';
import { freeLoopbackPort, portIsFree } from '../src/orchestrator/ports.mjs';
import { DemoRun } from '../src/orchestrator/run.mjs';
import { componentProfile, realExecPath, resolvedPath, writeProfile } from '../src/orchestrator/sandbox.mjs';
import { witness, witnessLines } from '../scripts/checks/sandbox-witness.mjs';
import { outerProfileText } from './support/profiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const NPM = process.env.PATH.split(path.delimiter).map((d) => path.join(d, 'npm')).find((f) => fs.existsSync(f));
const SECOND = 1000;
const READY_END = 'Press Ctrl+C to stop.';
const STACK = /^\s+at |node:internal|Error:/m;
const SCRIPTS = { start: ['bin/start.mjs', ['start']], scenarios: ['src/runner/text.mjs', ['run', 'scenarios']] };
const header = (script) => ['', `> ${PKG.name}@${PKG.version} ${script}`, `> node ${SCRIPTS[script][0]}`, ''];
const PARTS = ['bank', 'agent-a-billpay', 'agent-a-budget', 'agent-b-billpay', 'agent-b-budget'];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const PLATFORM_FIX = 'Fix: run it on a platform listed under Requirements in the README.';
const OUTER = [
  'This terminal is inside another sandbox, so the demo cannot start its parts in their own macOS sandboxes.',
  'Fix: open a terminal window that is not inside another sandbox, then run: npm start',
];
const NO_SANDBOX_EXEC = [
  'This Mac has no /usr/bin/sandbox-exec, which the demo needs to start its parts in their own sandboxes.',
  'Fix: run it on a Mac with the macOS version the README lists.',
];
const refusedLines = (part) => new RegExp(`^macOS refused the sandbox profile of ${part}, so the demo did not start\\.\\nLog: (\\S+)\\nFix: run it on a Mac with the macOS version the README lists\\.\\n$`);
const STAND_IN_LINE = 'sandbox-exec: stand-in: the profile does not parse';
const APPLY_LINE = 'sandbox-exec: sandbox_apply: Operation not permitted';

// The start checks' module and the two it imports load before any other
// file of the demo.
const START_CHECK_LOADS = ['src/start/checks.mjs', 'src/orchestrator/sandbox.mjs', 'src/egress/classify.mjs']
  .map((f) => pathToFileURL(path.join(fs.realpathSync(ROOT), f)).href);

// Scratch directories are made under /tmp, as the run directories' socket
// paths need, each with its own HOME, npm cache and TMPDIR.
function scratch() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'bank-demo-t-'));
  for (const d of ['home', 'npm-cache', 'tmp']) fs.mkdirSync(path.join(dir, d));
  return dir;
}

const baseEnv = (dir, extra = {}) => ({
  PATH: process.env.PATH,
  HOME: path.join(dir, 'home'),
  TMPDIR: path.join(dir, 'tmp'),
  LANG: 'C',
  TZ: 'UTC',
  npm_config_cache: path.join(dir, 'npm-cache'),
  npm_config_update_notifier: 'false',
  ...extra,
});

const tmpEntries = (dir) => fs.readdirSync(path.join(dir, 'tmp'));
// What a run through npm leaves there, but npm's own module compile cache.
const demoEntries = (dir) => tmpEntries(dir).filter((e) => e !== 'node-compile-cache');
const clearTmp = (dir) => { for (const e of tmpEntries(dir)) fs.rmSync(path.join(dir, 'tmp', e), { recursive: true, force: true }); };

function childPids(pid) {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Where a start reaches the ready lines it should have refused, the kernel's
// record of its parts says whether they run under a profile.
function partsReading(pid) {
  const parts = childPids(pid);
  if (parts.length === 0) return 'no part is running';
  const seen = witness({ targets: parts.map((p, i) => ({ name: `part ${i + 1}`, pid: p })), controlPid: pid });
  return `sandbox_check(pid, NULL, 0) reads ${seen.targets.map((x) => x.readings.sandboxed).join(', ')} for its ${parts.length} parts`;
}

// Runs a command in its own process group, as a terminal does. It resolves
// with the exit; with untilReady, with stop() and closed once the ready lines
// are out. A command that reaches the ready lines while the caller waits for
// its exit is read by onReady and stopped, so a refusal that does not come
// fails at once.
function run(cmd, args, { cwd = ROOT, env, untilReady = false, onReady = null, onSpawn = null }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (onSpawn) onSpawn(child.pid);
    let out = '';
    let err = '';
    let ready = false;
    let seen = null;
    const signal = (sig) => {
      try { process.kill(-child.pid, sig); } catch { /* the group has ended */ }
    };
    const timer = setTimeout(() => signal('SIGKILL'), 150 * SECOND);
    const closed = new Promise((done) => child.on('close', (code, sig) => {
      clearTimeout(timer);
      done({ pid: child.pid, code, signal: sig, out, err, ready, seen });
    }));
    const stop = () => {
      signal('SIGINT');
      return closed;
    };
    child.stdout.on('data', (c) => {
      out += c;
      if (ready || !out.includes(READY_END)) return;
      ready = true;
      if (untilReady) {
        resolve({ pid: child.pid, out: () => out, err: () => err, stop, closed });
        return;
      }
      try { seen = onReady ? onReady(child.pid) : null; } catch (e) { seen = `the reading failed (${e.message})`; }
      stop();
    });
    child.stderr.on('data', (c) => { err += c; });
    closed.then(resolve);
  });
}

// A preload for the launcher's own process (node --require), as the Windows
// refusal test uses. It notes each file a module loads from and each process
// started, with the command it was asked for and the one it got. It can set
// the platform or the Node.js version, point sandbox-exec at another file
// (every call, or just the nth spawn of sandbox-exec), and make the sandbox's
// status read "no sandbox" by answering that /usr/bin/sandbox-exec does not
// exist. With spawned it also notes the pid of each process spawn() started,
// and its profile file when sandbox-exec started it.
let preloads = 0;
function preload(dir, { platform = null, nodeVersion = null, redirect = null, nth = null, noSandboxStatus = false, spawned = false } = {}) {
  preloads += 1;
  const file = path.join(dir, `preload-${preloads}.cjs`);
  const notesFile = path.join(dir, `preload-${preloads}.jsonl`);
  const lines = [
    "'use strict';",
    "const fs = require('node:fs');",
    `const note = (rec) => fs.appendFileSync(${JSON.stringify(notesFile)}, JSON.stringify(rec) + '\\n');`,
  ];
  if (platform) lines.push(`Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });`);
  if (nodeVersion) lines.push(`Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(nodeVersion)} });`);
  lines.push(
    "const mod = require('node:module');",
    "if (typeof mod.registerHooks === 'function') mod.registerHooks({ load(url, context, next) { if (url.startsWith('file:')) note({ load: url }); return next(url, context); } });",
    "else note({ hooks: 'unavailable' });",
    "const cp = require('node:child_process');",
    'let starts = 0;',
    "for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {",
    '  const orig = cp[fn];',
    '  cp[fn] = function (cmd, ...rest) {',
    '    let to = cmd;',
    `    if (cmd === ${JSON.stringify(SANDBOX_EXEC)}) {`,
    "      if (fn === 'spawn') starts += 1;",
    `      const redirect = ${JSON.stringify(redirect)};`,
    `      const nth = ${JSON.stringify(nth)};`,
    "      if (redirect !== null && (nth === null || (fn === 'spawn' && starts === nth))) to = redirect;",
    "      if (fn === 'spawnSync' && Array.isArray(rest[0]) && rest[0][0] === '-f') {",
    "        let profile = null;",
    "        try { profile = fs.readFileSync(rest[0][1], 'utf8'); } catch { profile = null; }",
    "        note({ probe: rest[0].slice(1), profile, nodeOptions: rest[1] && rest[1].env ? Object.hasOwn(rest[1].env, 'NODE_OPTIONS') : null });",
    '      }',
    '    }',
    "    note({ fn, cmd: typeof cmd === 'string' ? cmd : null, to: typeof to === 'string' ? to : null });",
    '    const out = orig.call(this, to, ...rest);',
    `    if (${JSON.stringify(spawned)} && fn === 'spawn' && out && out.pid) note({ spawned: out.pid, profile: cmd === ${JSON.stringify(SANDBOX_EXEC)} && Array.isArray(rest[0]) && rest[0][0] === '-f' ? rest[0][1] : null });`,
    '    return out;',
    '  };',
    '}',
  );
  if (noSandboxStatus) lines.push(`const exists = fs.existsSync; fs.existsSync = function (p) { return p === ${JSON.stringify(SANDBOX_EXEC)} ? false : exists.call(this, p); };`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const notes = () => (fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { file, notes };
}

// A stand-in for sandbox-exec: it writes one line to stderr and exits.
function standIn(dir, name, line, code) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${line}' >&2\nexit ${code}\n`, { mode: 0o700 });
  return file;
}

// Profiles that hold the launcher, each different from its probe's and each
// with the boundary's terms: the walk's probe form (a deny rule with a token
// new for each walk), one that refuses exec of sandbox-exec, and one with
// the parts' own terms.
function outerProfile(dir, kind) {
  const file = path.join(dir, `outer-${kind}-${crypto.randomBytes(4).toString('hex')}.sb`);
  if (kind === 'walk') writeProfile(file, outerProfileText([`(deny file-read* (literal "/private/tmp/p5-probe-${crypto.randomBytes(8).toString('hex')}"))`]));
  else if (kind === 'no-exec') writeProfile(file, outerProfileText([`(deny process-exec (literal "${SANDBOX_EXEC}"))`]));
  else writeProfile(file, componentProfile({ runId: crypto.randomBytes(4).toString('hex'), execPath: realExecPath() }));
  return file;
}

const started = (notes) => notes.filter((n) => n.fn);
const probeCalls = (notes) => notes.filter((n) => n.fn === 'spawnSync' && n.cmd === SANDBOX_EXEC);

function startCounterFile(dir) {
  const starts = tmpEntries(dir).filter((d) => d.startsWith('bank-demo-start-'));
  assert.equal(starts.length, 1, `start directories: ${starts.join(' ')}`);
  return path.join(dir, 'tmp', starts[0], 'egress.jsonl');
}

// The pids a start or a scenarios run started, from the counter files under
// its temporary directory: the launcher's own lines for each process it
// started, and the hello line of each process whose parent it is.
function launcherStarts(dir, pid) {
  const pids = new Set();
  for (const d of tmpEntries(dir).filter((x) => x.startsWith('bank-demo-start-') || x.startsWith('bank-demo-run-'))) {
    const file = path.join(dir, 'tmp', d, 'egress.jsonl');
    if (!fs.existsSync(file)) continue;
    for (const l of classify.readCounter(file).lines) {
      if (l.kind === 'child' && l.pid === pid && Number.isInteger(l.childPid) && l.childPid > 0) pids.add(l.childPid);
      if (l.kind === 'hello' && l.main && l.ppid === pid) pids.add(l.pid);
    }
  }
  return [...pids];
}

test('platforms: npm start and npm run scenarios refuse linux, freebsd and plan9 with two lines that name the platform and exit 1, with no stack, no package loaded, nothing loaded from src/ but the start checks, no process started and nothing listening; Windows keeps its two lines in both', async () => {
  const dir = scratch();
  try {
    const problems = [];
    for (const platform of ['linux', 'freebsd', 'plan9', 'win32']) {
      const want = `This demo does not run on ${platform === 'win32' ? 'Windows' : platform}.\n${PLATFORM_FIX}\n`;
      for (const script of ['start', 'scenarios']) {
        const label = `${script} on ${platform}`;
        const port = await freeLoopbackPort();
        const pre = preload(dir, { platform });
        const r = await run(process.execPath, ['--require', pre.file, path.join(ROOT, SCRIPTS[script][0])], { env: baseEnv(dir, { PORT: String(port) }), onReady: partsReading });
        const notes = pre.notes();
        if (r.ready) problems.push(`${label}: reached the ready lines; ${r.seen}`);
        if (r.code !== 1) problems.push(`${label}: exit ${r.code}`);
        if (r.out !== want) problems.push(`${label}: printed ${JSON.stringify(r.out.slice(0, 160))}`);
        if (r.err !== '' || STACK.test(r.out)) problems.push(`${label}: stderr ${JSON.stringify(r.err.slice(0, 160))}`);
        const s = started(notes);
        if (s.length) problems.push(`${label}: started ${s.length} processes, ${s.filter((n) => n.cmd !== SANDBOX_EXEC).length} of them without sandbox-exec`);
        const packages = notes.filter((n) => n.load && n.load.includes('/node_modules/'));
        if (packages.length) problems.push(`${label}: loaded ${packages.length} files under node_modules`);
        const entry = pathToFileURL(path.join(fs.realpathSync(ROOT), SCRIPTS[script][0])).href;
        const fromSrc = notes.filter((n) => n.load && n.load.includes('/src/') && n.load !== entry && !START_CHECK_LOADS.includes(n.load));
        if (fromSrc.length) problems.push(`${label}: loaded ${fromSrc.length} other files from src/ before it refused`);
        const left = tmpEntries(dir);
        if (left.length) problems.push(`${label}: left ${left.length} entries in its temporary directory`);
        clearTmp(dir);
        if (!(await portIsFree(port))) problems.push(`${label}: port ${port} is in use`);
      }
    }
    assert.deepEqual(problems, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('order: the platform check comes before the probe, and the probe before the Node.js version, NODE_OPTIONS, dependency, port and argument checks', async () => {
  const dir = scratch();
  const busy = net.createServer();
  try {
    const clone = path.join(dir, 'clone');
    for (const d of ['bin', 'src']) fs.cpSync(path.join(ROOT, d), path.join(clone, d), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(clone, 'package.json'));
    await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
    const empty = path.join(dir, 'empty.cjs');
    fs.writeFileSync(empty, '');
    const env = baseEnv(dir, { PORT: String(busy.address().port), NODE_OPTIONS: `--require ${empty}` });
    const outer = outerProfile(dir, 'walk');
    const old = preload(dir, { nodeVersion: '22.11.0' });
    const all = await run(SANDBOX_EXEC, ['-f', outer, realExecPath(), '--require', old.file, path.join(clone, 'bin/start.mjs'), '--an-argument'], { cwd: clone, env });
    assert.equal(all.code, 1, all.out + all.err);
    assert.equal(all.out, `${OUTER.join('\n')}\n`, 'the probe refuses before the other checks');
    assert.equal(all.err, '');
    for (const script of ['start', 'scenarios']) {
      const linux = preload(dir, { platform: 'linux' });
      const p = await run(SANDBOX_EXEC, ['-f', outer, realExecPath(), '--require', linux.file, path.join(clone, SCRIPTS[script][0])], { cwd: clone, env });
      assert.equal(p.out, `This demo does not run on linux.\n${PLATFORM_FIX}\n`, `${script}: the platform check runs before every other check`);
      assert.deepEqual(started(linux.notes()), [], `${script}: no probe on a platform the README does not list`);
    }
    assert.deepEqual(tmpEntries(dir), []);
  } finally {
    busy.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// After the probe both scripts check the Node.js version, then an inherited
// NODE_OPTIONS, then the dependencies, with the launcher's lines. The NODE_OPTIONS
// Fix clears the variable for the script that was run.
const NODE_OPTIONS_SET = 'NODE_OPTIONS is set in this terminal. The demo sets its own NODE_OPTIONS to load a connection counter into every process it starts, and does not run with other Node.js options.';
const RUN_AS = { start: 'npm start', scenarios: 'npm run scenarios' };

// A refusal after the probe: two lines, exit 1, no stack, the probe the one
// process started, no package loaded and nothing loaded from src/ but the
// entry, the start checks and the files in also.
function laterRefusalProblems(label, r, notes, want, { root = ROOT, script, also = [] }) {
  const problems = [];
  if (r.ready) problems.push(`${label}: reached the ready lines; ${r.seen}`);
  if (r.code !== 1) problems.push(`${label}: exit ${r.code}`);
  if (r.out !== want) problems.push(`${label}: printed ${JSON.stringify(r.out.slice(0, 200))}`);
  if (r.err !== '' || STACK.test(r.out)) problems.push(`${label}: stderr ${JSON.stringify(r.err.slice(0, 160))}`);
  const s = started(notes);
  if (s.length !== 1 || probeCalls(notes).length !== 1) problems.push(`${label}: started ${s.length} processes (${s.map((n) => n.fn).join(' ')})`);
  const packages = notes.filter((n) => n.load && n.load.includes('/node_modules/'));
  if (packages.length) problems.push(`${label}: loaded ${packages.length} files under node_modules`);
  const real = fs.realpathSync(root);
  const allowed = [SCRIPTS[script][0], 'src/start/checks.mjs', 'src/orchestrator/sandbox.mjs', 'src/egress/classify.mjs', ...also].map((f) => pathToFileURL(path.join(real, f)).href);
  const fromSrc = notes.filter((n) => n.load && n.load.includes('/src/') && !allowed.includes(n.load));
  if (fromSrc.length) problems.push(`${label}: loaded ${fromSrc.length} other files from src/ before it refused`);
  return problems;
}

test('NODE_OPTIONS: with NODE_OPTIONS=--no-deprecation, a value that names no file, npm start and npm run scenarios each print two lines that name the variable and never its value, with a Fix that clears it for the script that was run, and exit 1; no part starts and nothing loads from src/ but the entry and the start checks', async () => {
  const dir = scratch();
  try {
    assert.ok(NPM, 'npm on PATH');
    const problems = [];
    for (const script of ['start', 'scenarios']) {
      const lines = [NODE_OPTIONS_SET, `Fix: env -u NODE_OPTIONS ${RUN_AS[script]}`];
      const port = await freeLoopbackPort();
      const env = baseEnv(dir, { PORT: String(port), NODE_OPTIONS: '--no-deprecation' });
      const pre = preload(dir);
      const r = await run(process.execPath, ['--require', pre.file, path.join(ROOT, SCRIPTS[script][0])], { env, onReady: partsReading });
      problems.push(...laterRefusalProblems(script, r, pre.notes(), `${lines.join('\n')}\n`, { script }));
      if (r.out.includes('--no-deprecation')) problems.push(`${script}: printed the value`);
      const left = tmpEntries(dir);
      if (left.length) problems.push(`${script}: left ${left.join(' ')} in its temporary directory`);
      clearTmp(dir);
      // Through npm: its header, then the same two lines.
      const n = await run(NPM, SCRIPTS[script][1], { env, onReady: partsReading });
      if (n.ready) problems.push(`npm ${script}: reached the ready lines; ${n.seen}`);
      if (n.code !== 1) problems.push(`npm ${script}: exit ${n.code}`);
      if (n.out !== [...header(script), ...lines, ''].join('\n')) problems.push(`npm ${script}: printed ${JSON.stringify(n.out.slice(-200))}`);
      if (n.err !== '' || STACK.test(n.out)) problems.push(`npm ${script}: stderr ${JSON.stringify(n.err.slice(0, 160))}`);
      const npmLeft = demoEntries(dir);
      if (npmLeft.length) problems.push(`npm ${script}: left ${npmLeft.join(' ')} in its temporary directory`);
      clearTmp(dir);
      if (!(await portIsFree(port))) problems.push(`${script}: port ${port} is in use`);
    }
    assert.deepEqual(problems, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('both scripts: a Node.js version before 22.12.0 is refused by npm start and npm run scenarios with the same two lines, after the probe and before the NODE_OPTIONS check, and nothing loads from src/ but the entry and the start checks', async () => {
  const dir = scratch();
  try {
    const problems = [];
    const want = 'This demo needs Node.js 22.12.0 or later. This is Node.js 22.11.0.\nFix: install Node.js 22.12.0 or later, then run: npm ci && npm start\n';
    for (const script of ['start', 'scenarios']) {
      const port = await freeLoopbackPort();
      const pre = preload(dir, { nodeVersion: '22.11.0' });
      const r = await run(process.execPath, ['--require', pre.file, path.join(ROOT, SCRIPTS[script][0])], { env: baseEnv(dir, { PORT: String(port), NODE_OPTIONS: '--no-deprecation' }), onReady: partsReading });
      problems.push(...laterRefusalProblems(script, r, pre.notes(), want, { script }));
      const left = tmpEntries(dir);
      if (left.length) problems.push(`${script}: left ${left.join(' ')} in its temporary directory`);
      clearTmp(dir);
      if (!(await portIsFree(port))) problems.push(`${script}: port ${port} is in use`);
    }
    assert.deepEqual(problems, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('both scripts: in a clone with no dependencies installed, npm start and npm run scenarios refuse with the same two lines after the probe, and no part starts', async () => {
  const dir = scratch();
  try {
    const clone = path.join(dir, 'clone');
    for (const d of ['bin', 'src']) fs.cpSync(path.join(ROOT, d), path.join(clone, d), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(clone, 'package.json'));
    const problems = [];
    for (const script of ['start', 'scenarios']) {
      const port = await freeLoopbackPort();
      const pre = preload(dir);
      const r = await run(process.execPath, ['--require', pre.file, path.join(clone, SCRIPTS[script][0])], { cwd: clone, env: baseEnv(dir, { PORT: String(port) }), onReady: partsReading });
      // The launcher loads its connection counter before this check.
      const also = script === 'start' ? ['src/egress/counter.cjs'] : [];
      problems.push(...laterRefusalProblems(script, r, pre.notes(), 'Dependencies are not installed.\nFix: npm ci\n', { root: clone, script, also }));
      const left = tmpEntries(dir);
      if (left.length) problems.push(`${script}: left ${left.join(' ')} in its temporary directory`);
      clearTmp(dir);
      if (!(await portIsFree(port))) problems.push(`${script}: port ${port} is in use`);
    }
    assert.deepEqual(problems, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: node -e '' under a profile of the parts' form written for the probe alone, with a fresh run id in its messages and every path resolved, with NODE_OPTIONS removed from its environment; its profile file is removed after it", async () => {
  const dir = scratch();
  try {
    const empty = path.join(dir, 'empty.cjs');
    fs.writeFileSync(empty, '');
    const ids = [];
    for (let i = 0; i < 2; i += 1) {
      const pre = preload(dir);
      const r = await run(process.execPath, ['--require', pre.file, path.join(ROOT, 'bin/start.mjs')], { env: baseEnv(dir, { PORT: String(await freeLoopbackPort()), NODE_OPTIONS: `--require ${empty}` }) });
      assert.equal(r.code, 1, r.out + r.err);
      assert.ok(r.out.startsWith('NODE_OPTIONS is set in this terminal.'), r.out);
      const probes = pre.notes().filter((n) => n.probe);
      assert.equal(probes.length, 1, 'one probe');
      const [{ probe, profile, nodeOptions }] = probes;
      assert.equal(nodeOptions, false, 'NODE_OPTIONS is removed from the probe environment');
      assert.match(probe[0], /\/bank-demo-probe-[^/]+\/probe\.sb$/);
      assert.deepEqual(probe.slice(1), [realExecPath(), '-e', '']);
      assert.equal(fs.existsSync(probe[0]), false, 'the probe profile file is removed');
      const id = /\(deny network-outbound \(with message "bank-demo-([0-9a-f]{16})"\)\)/.exec(profile)?.[1];
      assert.ok(id, 'a fresh run id in its messages');
      ids.push(id);
      assert.ok(profile.includes(`(allow process-exec (literal "${realExecPath()}"))`));
      for (const m of profile.matchAll(/\((?:subpath|literal) "((?:[^"\\]|\\.)*)"\)/g)) {
        const p = m[1].replace(/\\(.)/g, '$1');
        assert.equal(resolvedPath(p), p, 'every path in the probe profile is written resolved');
      }
      assert.deepEqual(tmpEntries(dir), []);
    }
    assert.notEqual(ids[0], ids[1], 'each start writes a profile of its own');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inside another sandbox: under an outer profile of the walk form (exit 71) and under one that refuses exec of sandbox-exec (EPERM), npm start and npm run scenarios print the two lines and exit 1, with no Ready line, nothing left in the temporary directory and nothing listening; npm start with no outer profile reaches the ready lines', async () => {
  const dir = scratch();
  try {
    assert.ok(NPM, 'npm on PATH');
    const problems = [];
    for (const kind of ['walk', 'no-exec']) {
      const outer = outerProfile(dir, kind);
      for (const script of ['start', 'scenarios']) {
        const label = `${script} under the ${kind} profile`;
        const port = await freeLoopbackPort();
        const r = await run(SANDBOX_EXEC, ['-f', outer, NPM, ...SCRIPTS[script][1]], { env: baseEnv(dir, { PORT: String(port) }) });
        const want = [...header(script), ...OUTER, ''].join('\n');
        if (r.ready) problems.push(`${label}: reached the ready lines`);
        if (r.code !== 1) problems.push(`${label}: exit ${r.code}`);
        if (r.out !== want) problems.push(`${label}: printed ${JSON.stringify(r.out.slice(-200))}`);
        if (r.err !== '' || STACK.test(r.out)) problems.push(`${label}: stderr ${JSON.stringify(r.err.slice(0, 160))}`);
        const left = demoEntries(dir);
        if (left.length) problems.push(`${label}: left ${left.join(' ')} in its temporary directory`);
        clearTmp(dir);
        if (!(await portIsFree(port))) problems.push(`${label}: port ${port} is in use`);
      }
    }
    assert.deepEqual(problems, []);
    const fix = await run(NPM, ['start'], { env: baseEnv(dir, { PORT: String(await freeLoopbackPort()) }), untilReady: true });
    assert.ok(fix.stop, `${fix.out}${fix.err}`);
    const end = await fix.stop();
    assert.equal(end.code, 0, end.out + end.err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mutant 1: a launcher started inside a profile other than its probe's, of the walk form, of the form that refuses exec of sandbox-exec, or with the parts' own terms, exits 1 with the inside another sandbox lines; it started nothing but its probe, and afterwards no part, no run directory and no view listener exist", async () => {
  const dir = scratch();
  try {
    const problems = [];
    for (const kind of ['walk', 'no-exec', 'parts']) {
      const outer = outerProfile(dir, kind);
      const port = await freeLoopbackPort();
      const pre = preload(dir);
      const r = await run(SANDBOX_EXEC, ['-f', outer, realExecPath(), '--require', pre.file, path.join(ROOT, 'bin/start.mjs')], { env: baseEnv(dir, { PORT: String(port) }) });
      const notes = pre.notes();
      if (r.code !== 1) problems.push(`${kind}: exit ${r.code}`);
      if (r.out !== `${OUTER.join('\n')}\n`) problems.push(`${kind}: printed ${JSON.stringify(r.out.slice(0, 200))}`);
      if (r.err !== '') problems.push(`${kind}: stderr ${JSON.stringify(r.err.slice(0, 160))}`);
      const s = started(notes);
      if (s.length !== 1 || probeCalls(notes).length !== 1) problems.push(`${kind}: started ${s.length} processes (${s.map((n) => n.fn).join(' ')})`);
      const parts = launcherStarts(dir, r.pid);
      if (parts.some(alive)) problems.push(`${kind}: a part is still running`);
      const left = tmpEntries(dir);
      if (left.length) problems.push(`${kind}: left ${left.length} entries in its temporary directory`);
      clearTmp(dir);
      if (!(await portIsFree(port))) problems.push(`${kind}: port ${port} is in use`);
    }
    assert.deepEqual(problems, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('no sandbox-exec: with the sandbox-exec path pointed at a file that does not exist, npm start and npm run scenarios print the two lines and exit 1, starting no part', async () => {
  const dir = scratch();
  try {
    const missing = path.join(dir, 'absent', 'sandbox-exec');
    const problems = [];
    for (const script of ['start', 'scenarios']) {
      const port = await freeLoopbackPort();
      const pre = preload(dir, { redirect: missing });
      const r = await run(process.execPath, ['--require', pre.file, path.join(ROOT, SCRIPTS[script][0])], { env: baseEnv(dir, { PORT: String(port) }), onReady: partsReading });
      const notes = pre.notes();
      if (r.ready) problems.push(`${script}: reached the ready lines; ${r.seen}`);
      if (r.code !== 1) problems.push(`${script}: exit ${r.code}`);
      if (r.out !== `${NO_SANDBOX_EXEC.join('\n')}\n`) problems.push(`${script}: printed ${JSON.stringify(r.out.slice(0, 200))}`);
      if (r.err !== '' || STACK.test(r.out)) problems.push(`${script}: stderr ${JSON.stringify(r.err.slice(0, 160))}`);
      const s = started(notes);
      if (s.length !== 1 || probeCalls(notes).length !== 1 || s[0].to !== missing) problems.push(`${script}: started ${s.length} processes (${s.map((n) => n.fn).join(' ')})`);
      const left = tmpEntries(dir);
      if (left.length) problems.push(`${script}: left ${left.length} entries in its temporary directory`);
      clearTmp(dir);
      if (!(await portIsFree(port))) problems.push(`${script}: port ${port} is in use`);
    }
    assert.deepEqual(problems, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('profile refused: with a sandbox-exec stand-in that exits 65 with one line, npm start and npm run scenarios print the three lines, the Log file is 0600 and holds that line, and no part starts', async () => {
  const dir = scratch();
  try {
    const fake = standIn(dir, 'sandbox-exec-65', STAND_IN_LINE, 65);
    const problems = [];
    for (const script of ['start', 'scenarios']) {
      const port = await freeLoopbackPort();
      const pre = preload(dir, { redirect: fake });
      const r = await run(process.execPath, ['--require', pre.file, path.join(ROOT, SCRIPTS[script][0])], { env: baseEnv(dir, { PORT: String(port) }), onReady: partsReading });
      const notes = pre.notes();
      const m = refusedLines("the demo's parts").exec(r.out);
      if (r.ready) problems.push(`${script}: reached the ready lines; ${r.seen}`);
      if (r.code !== 1) problems.push(`${script}: exit ${r.code}`);
      if (!m) problems.push(`${script}: printed ${JSON.stringify(r.out.slice(0, 200))}`);
      else {
        const log = m[1];
        if (!log.startsWith(path.join(dir, 'tmp') + path.sep)) problems.push(`${script}: the log is outside its temporary directory`);
        else if ((fs.statSync(log).mode & 0o777) !== 0o600) problems.push(`${script}: the log is not 0600`);
        else if (fs.readFileSync(log, 'utf8') !== `${STAND_IN_LINE}\n`) problems.push(`${script}: the log does not hold the stand-in's line`);
        else if (fs.readdirSync(path.dirname(log)).join(' ') !== 'sandbox-exec.log') problems.push(`${script}: the probe profile file was not removed`);
      }
      if (r.err !== '' || STACK.test(r.out)) problems.push(`${script}: stderr ${JSON.stringify(r.err.slice(0, 160))}`);
      const s = started(notes);
      if (s.length !== 1 || probeCalls(notes).length !== 1) problems.push(`${script}: started ${s.length} processes (${s.map((n) => n.fn).join(' ')})`);
      clearTmp(dir);
      if (!(await portIsFree(port))) problems.push(`${script}: port ${port} is in use`);
    }
    assert.deepEqual(problems, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('mutant 2: with sandboxStatus() reporting no sandbox on macOS, npm start and npm run scenarios refuse with the no sandbox-exec lines before any part starts', async () => {
  const dir = scratch();
  try {
    const problems = [];
    for (const script of ['start', 'scenarios']) {
      const port = await freeLoopbackPort();
      const pre = preload(dir, { noSandboxStatus: true });
      const r = await run(process.execPath, ['--require', pre.file, path.join(ROOT, SCRIPTS[script][0])], { env: baseEnv(dir, { PORT: String(port) }), onReady: partsReading });
      const notes = pre.notes();
      if (r.ready) problems.push(`${script}: reached the ready lines; ${r.seen}`);
      if (r.code !== 1) problems.push(`${script}: exit ${r.code}`);
      if (r.out !== `${NO_SANDBOX_EXEC.join('\n')}\n`) problems.push(`${script}: printed ${JSON.stringify(r.out.slice(0, 200))}`);
      if (r.err !== '' || STACK.test(r.out)) problems.push(`${script}: stderr ${JSON.stringify(r.err.slice(0, 160))}`);
      const parts = started(notes).filter((n) => n.fn !== 'spawnSync' || n.cmd !== SANDBOX_EXEC).filter((n) => n.cmd !== 'git');
      if (parts.length) problems.push(`${script}: started ${parts.length} parts`);
      const runs = tmpEntries(dir).filter((d) => d.startsWith('bank-demo-run-'));
      if (runs.length) problems.push(`${script}: made ${runs.length} run directories`);
      clearTmp(dir);
      if (!(await portIsFree(port))) problems.push(`${script}: port ${port} is in use`);
    }
    assert.deepEqual(problems, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('per-spawn: a part whose sandbox-exec ends before any answer stops the start with its cause: exit 65 names the part and its Log, exit 71 with the sandbox_apply line is the inside another sandbox cause; no Ready line, no part exit lines, no Fix: npm start, the parts already started are stopped and nothing listens', async () => {
  const dir = scratch();
  try {
    const cases = [
      { script: 'start', fake: standIn(dir, 'sandbox-exec-65', STAND_IN_LINE, 65), nth: 3, part: 'the password path budget agent' },
      { script: 'scenarios', fake: path.join(dir, 'sandbox-exec-65'), nth: 3, part: 'the password path budget agent' },
      { script: 'start', fake: standIn(dir, 'sandbox-exec-71', APPLY_LINE, 71), nth: 2, part: null },
    ];
    const problems = [];
    for (const c of cases) {
      const label = `${c.script}, spawn ${c.nth}`;
      const port = await freeLoopbackPort();
      const pre = preload(dir, { redirect: c.fake, nth: c.nth });
      const r = await run(process.execPath, ['--require', pre.file, path.join(ROOT, SCRIPTS[c.script][0])], { env: baseEnv(dir, { PORT: String(port) }) });
      if (r.ready) problems.push(`${label}: reached the ready lines`);
      if (r.code !== 1) problems.push(`${label}: exit ${r.code}`);
      if (/stopped unexpectedly|Fix: npm start\n/.test(r.out)) problems.push(`${label}: printed ${JSON.stringify(r.out.slice(0, 200))}`);
      if (c.part) {
        const m = refusedLines(c.part).exec(r.out);
        if (!m) problems.push(`${label}: printed ${JSON.stringify(r.out.slice(0, 200))}`);
        else if ((fs.statSync(m[1]).mode & 0o777) !== 0o600 || fs.readFileSync(m[1], 'utf8') !== `${STAND_IN_LINE}\n`) problems.push(`${label}: the log is not 0600 with the stand-in's line`);
      } else if (r.out !== `${OUTER.join('\n')}\n`) problems.push(`${label}: printed ${JSON.stringify(r.out.slice(0, 200))}`);
      if (r.err !== '' || STACK.test(r.out)) problems.push(`${label}: stderr ${JSON.stringify(r.err.slice(0, 160))}`);
      const spawns = started(pre.notes()).filter((n) => n.fn === 'spawn' && n.cmd === SANDBOX_EXEC).length;
      if (spawns !== c.nth) problems.push(`${label}: ${spawns} parts were started, not ${c.nth}`);
      const pids = launcherStarts(dir, r.pid);
      if (pids.length < c.nth - 1) problems.push(`${label}: ${pids.length} parts on record`);
      if (pids.some(alive)) problems.push(`${label}: a part it started is still running`);
      clearTmp(dir);
      if (!(await portIsFree(port))) problems.push(`${label}: port ${port} is in use`);
    }
    assert.deepEqual(problems, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('per-spawn after the ready lines: a scenario run whose part is not started under its profile stops the demo with the cause lines, and stops every part it started', async () => {
  const dir = scratch();
  try {
    const fake = standIn(dir, 'sandbox-exec-65', STAND_IN_LINE, 65);
    const port = await freeLoopbackPort();
    const pre = preload(dir, { redirect: fake, nth: PARTS.length + 1 });
    const r = await run(process.execPath, ['--require', pre.file, path.join(ROOT, 'bin/start.mjs')], { env: baseEnv(dir, { PORT: String(port) }), untilReady: true });
    assert.ok(r.stop, `${r.out}${r.err}`);
    const before = r.out();
    fetch(`http://127.0.0.1:${port}/api/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: 'setup' }) }).catch(() => {});
    const end = await Promise.race([r.closed, sleep(20 * SECOND).then(() => null)]);
    if (!end) {
      await r.stop();
      assert.fail('the demo kept running after a part was not started under its profile');
    }
    assert.equal(end.code, 1, end.out + end.err);
    const after = end.out.slice(before.length);
    const m = refusedLines('the bank').exec(after);
    assert.ok(m, JSON.stringify(after));
    assert.equal(fs.readFileSync(m[1], 'utf8'), `${STAND_IN_LINE}\n`);
    assert.equal(end.err, '');
    const pids = launcherStarts(dir, r.pid);
    assert.ok(pids.length >= PARTS.length, `${pids.length} parts on record`);
    assert.deepEqual(pids.filter(alive), [], 'every part it started is stopped');
    assert.equal(await portIsFree(port), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('witness: in one start and one scenarios run, sandbox_check(pid, NULL, 0) reads 0 for the launcher and for the scenarios process, the same-run unsandboxed controls, and 1 for every part they started, in each chain of the scenarios run, and for the offline rerun root, each with the store and keychain readings refused', async (t) => {
  const dir = scratch();
  try {
    const port = await freeLoopbackPort();
    const pre = preload(dir);
    const r = await run(process.execPath, ['--require', pre.file, path.join(ROOT, 'bin/start.mjs')], { env: baseEnv(dir, { PORT: String(port) }), untilReady: true });
    assert.ok(r.stop, `${r.out}${r.err}`);
    try {
      const tmp = path.join(dir, 'tmp');
      assert.deepEqual(tmpEntries(dir).filter((d) => d.startsWith('bank-demo-probe-')), [], 'the probe left no file');
      const runDirs = tmpEntries(dir).filter((d) => d.startsWith('bank-demo-run-')).map((d) => path.join(tmp, d));
      assert.equal(runDirs.length, 1);
      const lines = classify.readCounter(startCounterFile(dir)).lines;
      const pids = lines.filter((l) => l.kind === 'child' && l.pid === r.pid && l.file === SANDBOX_EXEC && l.childPid > 0).map((l) => l.childPid);
      assert.equal(pids.length, PARTS.length, 'each part started through sandbox-exec');
      const targets = pids.map((pid, i) => ({ name: PARTS[i], pid, profileFile: path.join(runDirs[0], 'profiles', `${PARTS[i]}.sb`) }));
      const seen = witness({ targets, sentinel: path.join(runDirs[0], 'control', 'sentinel'), controlPid: r.pid });
      for (const line of witnessLines(seen)) t.diagnostic(line);
      assert.equal(seen.control.process, 0, 'the launcher reads 0');
      for (const x of seen.targets) assert.equal(x.readings.sandboxed, 1, x.name);
      assert.equal(seen.verdict, 'pass', seen.problems.join('; '));

      // The offline rerun root: the launcher starts it under its own profile.
      const known = new Set(tmpEntries(dir));
      const offline = fetch(`http://127.0.0.1:${port}/api/offline`, { method: 'POST' }).then((res) => res.json());
      let root = null;
      for (let i = 0; i < 1200 && !root; i += 1) {
        for (const d of tmpEntries(dir).filter((x) => !known.has(x) && x.startsWith('bank-demo-run-'))) {
          const counter = path.join(tmp, d, 'egress.jsonl');
          if (!fs.existsSync(path.join(tmp, d, 'egress.sb')) || !fs.existsSync(counter)) continue;
          const hello = classify.readCounter(counter).lines.find((l) => l.kind === 'hello' && l.main && l.ppid === r.pid);
          if (hello) root = { pid: hello.pid, dir: path.join(tmp, d) };
        }
        if (!root) await sleep(50);
      }
      assert.ok(root, 'the rerun root wrote its hello line');
      const rerun = witness({
        targets: [{ name: 'offline rerun root', pid: root.pid, profileFile: path.join(root.dir, 'egress.sb') }],
        sentinel: path.join(root.dir, 'offline', 'sentinel'),
        controlPid: r.pid,
      });
      for (const line of witnessLines(rerun)) t.diagnostic(line);
      assert.equal(rerun.control.process, 0, 'the launcher reads 0');
      assert.equal(rerun.targets[0].readings.sandboxed, 1);
      assert.equal(rerun.verdict, 'pass', rerun.problems.join('; '));
      const result = await offline;
      assert.notEqual(result.status, 'not run', "the rerun's sandbox-exec applied its profile");
      // The launcher's own process loaded no file under node_modules.
      assert.deepEqual(pre.notes().filter((n) => n.load && n.load.includes('/node_modules/')).map((n) => n.load), []);
    } finally {
      const end = await r.stop();
      assert.equal(end.code, 0, end.out + end.err);
    }

    // The scenarios process starts the parts of both chains, each under its
    // own profile, and runs under none itself. Each part is read while it
    // runs, from its hello line in its chain's counter file.
    const before = new Set(tmpEntries(dir));
    const sp = preload(dir, { spawned: true });
    let spid = null;
    let done = null;
    const scenarios = run(process.execPath, ['--require', sp.file, path.join(ROOT, SCRIPTS.scenarios[0])], { env: baseEnv(dir), onSpawn: (p) => { spid = p; } });
    scenarios.then((x) => { done = x; });
    const chainDirs = () => tmpEntries(dir).filter((d) => !before.has(d) && d.startsWith('bank-demo-run-')).map((d) => path.join(dir, 'tmp', d));
    const partHellos = (runDir) => classify.readCounter(path.join(runDir, 'egress.jsonl')).lines.filter((l) => l.kind === 'hello' && l.main && l.ppid === spid);
    const readings = new Map();
    while (!done) {
      for (const runDir of chainDirs()) {
        let spawns;
        try { spawns = sp.notes().filter((n) => n.spawned); } catch { continue; }
        const fresh = partHellos(runDir).filter((h) => !readings.has(h.pid) && spawns.some((n) => n.spawned === h.pid));
        if (!fresh.length) continue;
        const targets = fresh.map((h) => {
          const profileFile = spawns.find((n) => n.spawned === h.pid).profile;
          return { name: profileFile ? path.basename(profileFile, '.sb') : 'a part started with no profile', pid: h.pid, ...(profileFile ? { profileFile } : {}) };
        });
        const sentinel = path.join(runDir, 'control', 'sentinel');
        const seen = witness({ targets, sentinel: fs.existsSync(sentinel) ? sentinel : null, controlPid: spid });
        for (const line of witnessLines(seen)) t.diagnostic(line);
        seen.targets.forEach((x, i) => readings.set(fresh[i].pid, { chain: path.basename(runDir), name: x.name, sandboxed: x.readings.sandboxed, control: seen.control.process, verdict: seen.verdict, problems: seen.problems }));
      }
      if (!done) await sleep(20);
    }
    assert.equal(done.code, 0, `${done.out.slice(-400)}${done.err.slice(-400)}`);
    const chains = chainDirs();
    assert.equal(chains.length, 2, `chains: ${chains.map((d) => path.basename(d)).join(' ')}`);
    for (const runDir of chains) {
      const pids = partHellos(runDir).map((h) => h.pid);
      assert.ok(pids.length > 0, `${path.basename(runDir)}: the chain yields no part pid`);
      for (const p of pids) {
        const x = readings.get(p);
        assert.ok(x, `${path.basename(runDir)}: part pid ${p} was not read while it ran`);
        t.diagnostic(`${x.chain} ${x.name} pid ${p}: sandbox_check reads ${x.sandboxed}, the scenarios process pid ${spid} reads ${x.control}, verdict ${x.verdict}`);
      }
    }
    for (const x of readings.values()) {
      assert.equal(x.control, 0, 'the scenarios process reads 0');
      assert.equal(x.sandboxed, 1, `${x.chain} ${x.name}`);
      assert.equal(x.verdict, 'pass', x.problems.join('; '));
    }
    assert.deepEqual(sp.notes().filter((n) => n.load && n.load.includes('/node_modules/')).map((n) => n.load), [], 'the scenarios process loaded no file under node_modules');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a run on macOS requires every profile unless the caller names another mode, and a part with no profile is never started', async () => {
  const run = new DemoRun({});
  try {
    assert.equal(run.sandboxRequired, true);
    assert.equal(run.sandbox.applied, true);
    await assert.rejects(Promise.resolve().then(() => run.spawn('bank', path.join(ROOT, 'src/bank/main.mjs'), { home: run.dirs.bankHome, cwd: run.dirs.bank })), /has no profile/);
    assert.equal(run.processes.length, 0, 'no process started');
  } finally {
    await run.stop();
    fs.rmSync(run.runDir, { recursive: true, force: true });
  }
  const off = new DemoRun({ sandbox: 'off' });
  try {
    assert.equal(off.sandboxRequired, false);
    assert.equal(off.sandbox.applied, false);
  } finally {
    fs.rmSync(off.runDir, { recursive: true, force: true });
  }
});

test('the launcher classifier names each cause by the key of the offline check reason with the same cause, and NOT_RUN keeps its three reasons', () => {
  const { NOT_RUN, SANDBOX_APPLY_REFUSED, launcherRefusalCause, notRunReason } = classify;
  assert.equal(typeof launcherRefusalCause, 'function');
  const cases = [
    [{ exitCode: 71, stderr: `${SANDBOX_APPLY_REFUSED} Operation not permitted` }, 'outerSandbox'],
    [{ spawnError: 'EPERM' }, 'outerSandbox'],
    [{ spawnError: 'ENOENT' }, 'noSandbox'],
    [{ exitCode: 65, stderr: STAND_IN_LINE }, 'notApplied'],
    [{ exitCode: 71, stderr: 'another line' }, 'notApplied'],
    [{ exitCode: null, stderr: null }, 'notApplied'],
    [{ spawnError: 'EACCES' }, 'notApplied'],
    [{ exitCode: 1, stderr: 'node: a line' }, 'notApplied'],
  ];
  for (const [end, key] of cases) assert.equal(launcherRefusalCause(end), key, JSON.stringify(end));
  // Where both read the same end, the launcher's key names the reason the
  // offline check gives. EPERM is the launcher's alone.
  for (const [end] of cases.filter(([e]) => e.spawnError !== 'EPERM')) assert.equal(NOT_RUN[launcherRefusalCause(end)], notRunReason(end), JSON.stringify(end));
  assert.deepEqual({ ...NOT_RUN }, {
    noSandbox: 'no macOS sandbox on this system',
    outerSandbox: 'the demo is already inside another sandbox',
    notApplied: 'the sandbox could not be applied',
  });
  assert.equal(Object.isFrozen(NOT_RUN), true);
});
