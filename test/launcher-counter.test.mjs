// npm start and the egress counter. An inherited NODE_OPTIONS is refused
// before the counter loads. The launcher has the counter in its own process
// before it loads a module from a file, starts a process or opens a client
// socket; every process it starts loads the counter through NODE_OPTIONS,
// from a clone path with a space or a double quote as well; and their lines
// go to one counter file. The dependency check evaluates no package. The
// terminal shows npm's header, the three ready lines and Stopped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NOT_MEASURED, readCounter, summarize } from '../src/egress/classify.mjs';
import { childEnv, counterOption } from '../src/orchestrator/env.mjs';
import { freeLoopbackPort } from '../src/orchestrator/ports.mjs';
import { SANDBOX_EXEC, writeProfile } from '../src/orchestrator/sandbox.mjs';
import { outerProfileText } from './support/profiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const NPM_HEADER = ['', `> ${PKG.name}@${PKG.version} start`, '> node bin/start.mjs', ''];
const BUILD_LINE = /^Agent banking delegation demo, build ([0-9a-f]{7}( \(modified\))?|not from a git clone)$/;
const READY_END = 'Press Ctrl+C to stop.';
const REFUSAL = [
  'NODE_OPTIONS is set in this terminal. The demo sets its own NODE_OPTIONS to load a connection counter into every process it starts, and does not run with other Node.js options.',
  'Fix: env -u NODE_OPTIONS npm start',
];
const STACK = /^\s+at |node:internal/m;
const MARKER = 'FAKE-DEPENDENCY-EVALUATED';
const SECOND = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Scratch directories are made under /tmp: a run directory holds the broker's
// Unix socket, and a socket path has a length limit. Each has its own HOME,
// npm cache and TMPDIR, so the launcher's counter file is found in it.
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

// Runs a command in its own process group, as a terminal does. It resolves
// with the exit, or, with untilReady, with stop() once the ready lines are
// out; stop() sends Ctrl+C to the group. A command that reaches the ready
// lines while the caller waits for its exit is stopped, so a refusal that
// does not come fails at once.
function run(cmd, args, { cwd = ROOT, env, untilReady = false }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let err = '';
    let ready = false;
    const signal = (sig) => {
      try { process.kill(-child.pid, sig); } catch { /* the group has ended */ }
    };
    const timer = setTimeout(() => signal('SIGKILL'), 120 * SECOND);
    const closed = new Promise((done) => child.on('close', (code, sig) => {
      clearTimeout(timer);
      done({ code, signal: sig, out, err });
    }));
    const stop = () => {
      signal('SIGINT');
      return closed;
    };
    child.stdout.on('data', (c) => {
      out += c;
      if (ready || !out.includes(READY_END)) return;
      ready = true;
      if (untilReady) resolve({ pid: child.pid, out: () => out, err: () => err, stop });
      else stop();
    });
    child.stderr.on('data', (c) => { err += c; });
    closed.then(resolve);
  });
}

const launcher = (root = ROOT, execArgv = []) => [...execArgv, path.join(root, 'bin/start.mjs')];

// A copy of the clone under dest, with the installed packages linked in.
function copyClone(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const d of ['bin', 'src', 'vendor', 'fixtures']) fs.cpSync(path.join(ROOT, d), path.join(dest, d), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dest, f));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dest, 'node_modules'));
  return dest;
}

// A preload, loaded ahead of the launcher, that notes each module the process
// loads from a file, each process it starts and each client socket it opens,
// with whether the egress counter was loaded at that moment.
function writeProbe(dir) {
  const file = path.join(dir, 'probe.cjs');
  const out = path.join(dir, 'probe.jsonl');
  fs.writeFileSync(file, `'use strict';
const fs = require('node:fs');
const mod = require('node:module');
const note = (what, args) => fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify({ what, args, counter: globalThis.__demoEgressCounterLoaded === true }) + '\\n');
const own = (url) => /\\/(bin\\/start\\.mjs|src\\/egress\\/counter\\.cjs|empty\\.cjs)$/.test(url);
if (typeof mod.registerHooks === 'function') {
  mod.registerHooks({
    load(url, context, nextLoad) {
      if (url.startsWith('file:') && !own(url)) note('load ' + url);
      return nextLoad(url, context);
    },
  });
} else {
  note('hooks unavailable');
}
const cp = require('node:child_process');
for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const orig = cp[fn];
  cp[fn] = function (...args) { note(fn, fn === 'spawnSync' ? [args[0], args[1]] : undefined); return orig.apply(this, args); };
}
const net = require('node:net');
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) { note('connect'); return connect.apply(this, args); };
`);
  const notes = () => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { file, notes };
}

// The start checks come before the counter: their module and the two modules
// it imports (the profile writer and the classifier) load, and their probe
// starts, node -e '' under its own profile through sandbox-exec. These notes
// are named one by one; every other load, start and connect is checked as
// before.
const START_CHECK_LOADS = ['src/start/checks.mjs', 'src/orchestrator/sandbox.mjs', 'src/egress/classify.mjs']
  .map((f) => `load ${pathToFileURL(path.join(fs.realpathSync(ROOT), f)).href}`);
const probeSpawn = (n) => n.what === 'spawnSync' && Array.isArray(n.args) && n.args[0] === '/usr/bin/sandbox-exec'
  && Array.isArray(n.args[1]) && n.args[1].length === 5 && n.args[1][0] === '-f' && /\/bank-demo-probe-[^/]+\/probe\.sb$/.test(n.args[1][1])
  && n.args[1][2] === fs.realpathSync(process.execPath) && n.args[1][3] === '-e' && n.args[1][4] === '';
const startCheck = (n) => START_CHECK_LOADS.includes(n.what) || probeSpawn(n);

// The launcher's counter file: the run directory of this start, under the
// scratch TMPDIR.
function startCounterFile(dir) {
  const tmp = path.join(dir, 'tmp');
  const starts = fs.readdirSync(tmp).filter((d) => d.startsWith('bank-demo-start-'));
  assert.equal(starts.length, 1, `start directories: ${starts.join(' ')}`);
  return path.join(tmp, starts[0], 'egress.jsonl');
}

// One counter file for the start: the launcher's hello line opens it, one
// hello line for each process it started and is running, each with the
// counter's NODE_OPTIONS, and no started process the reader counts as
// uncounted.
function checkOneCounterFile(file, { pid, counterPath }) {
  const read = readCounter(file);
  assert.equal(read.ok, true, read.error);
  assert.equal(read.lines[0]?.kind, 'hello', 'the file opens with a hello line');
  assert.equal(read.lines[0].pid, pid, "the file opens with the launcher's hello line");
  const hellos = read.lines.filter((l) => l.kind === 'hello' && l.main);
  const hello = new Map(hellos.map((l) => [l.pid, l]));
  assert.equal(hello.size, hellos.length, 'one hello line per process');
  assert.ok(hello.has(pid), 'a hello line for the launcher');
  const started = read.lines.filter((l) => l.kind === 'child' && l.pid === pid && Number.isInteger(l.childPid) && l.childPid > 0).map((l) => l.childPid);
  assert.ok(started.length >= 5, `${started.length} processes started by the launcher`);
  for (const p of started) assert.ok(hello.has(p), `process ${p} has a hello line`);
  const running = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').map(Number);
  assert.ok(running.length >= 5, `${running.length} components running`);
  for (const p of running) assert.ok(started.includes(p) && hello.has(p), `running process ${p} was started with a hello line`);
  for (const h of hello.values()) assert.equal(h.nodeOptions, counterOption(counterPath), `process ${h.pid}`);
  const summary = summarize({ file, ports: [], runDir: path.dirname(file) });
  assert.deepEqual(summary.guards.filter((g) => g.reason === NOT_MEASURED.uncounted), []);
}

// What a start leaves in npm start > file 2>&1: npm's header, the three ready
// lines, Stopped. after Ctrl+C, and at most a notice block npm writes at exit.
// Returns each way the file differs; none when it is right.
function plainStart(buf, { port, stopped }) {
  const problems = [];
  if (buf.includes(0x1b)) problems.push('an escape byte');
  const text = buf.toString('utf8');
  const addresses = text.match(/http:\/\/127\.0\.0\.1:[0-9]+/g) ?? [];
  if (addresses.length !== 1) problems.push(`${addresses.length} addresses`);
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (stopped) while (lines.length > 0 && /^npm notice\b/.test(lines.at(-1))) lines.pop();
  const want = [...NPM_HEADER, BUILD_LINE, `Ready. Open http://127.0.0.1:${port}/ in a browser.`, READY_END, ...(stopped ? ['Stopped.'] : [])];
  if (lines.length !== want.length) problems.push(`${lines.length} lines, not ${want.length}`);
  want.forEach((w, i) => {
    const l = lines[i] ?? null;
    const same = w instanceof RegExp ? l !== null && w.test(l) : l === w;
    if (!same) problems.push(`line ${i + 1}: ${JSON.stringify(l)}`);
  });
  return problems;
}

test('NODE_OPTIONS set: the launcher prints two lines that name the variable and never its value, exits 1, and before it refuses loads nothing but the start checks, starts nothing but their probe and opens nothing', async () => {
  const dir = scratch();
  try {
    const empty = path.join(dir, 'empty.cjs');
    fs.writeFileSync(empty, '');
    const probe = writeProbe(dir);
    const env = baseEnv(dir, { NODE_OPTIONS: `--require ${empty}`, PORT: String(await freeLoopbackPort()) });
    const r = await run(process.execPath, launcher(ROOT, ['--require', probe.file]), { env });
    assert.equal(r.code, 1, r.out + r.err);
    assert.equal(r.out, `${REFUSAL.join('\n')}\n`);
    assert.equal(r.err, '');
    assert.equal(STACK.test(r.out + r.err), false);
    assert.equal((r.out + r.err).includes(empty), false);
    const notes = probe.notes().filter((n) => n.what !== 'hooks unavailable');
    assert.equal(notes.filter(probeSpawn).length, 1, 'the probe started once');
    assert.deepEqual(notes.filter((n) => !startCheck(n)).map((n) => n.what), []);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'the counter did not load');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NODE_OPTIONS set: the platform and Node.js checks come before its refusal', async () => {
  const dir = scratch();
  try {
    const empty = path.join(dir, 'empty.cjs');
    fs.writeFileSync(empty, '');
    const env = baseEnv(dir, { NODE_OPTIONS: `--require ${empty}`, PORT: String(await freeLoopbackPort()) });
    const cases = [
      ["Object.defineProperty(process, 'platform', { value: 'win32' });", 'This demo does not run on Windows.\n'],
      ["Object.defineProperty(process.versions, 'node', { value: '22.11.0' });", 'This demo needs Node.js 22.12.0 or later. This is Node.js 22.11.0.\n'],
    ];
    for (const [body, head] of cases) {
      const pre = path.join(dir, 'pre.cjs');
      fs.writeFileSync(pre, body);
      const r = await run(process.execPath, launcher(ROOT, ['--require', pre]), { env });
      assert.equal(r.code, 1, r.out + r.err);
      assert.ok(r.out.startsWith(head), r.out);
      assert.equal(r.out.includes('NODE_OPTIONS'), false, r.out);
      assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'the counter did not load');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("npm start with a --require preload in NODE_OPTIONS: npm's header, the two lines, exit 1; the Fix as printed reaches the ready lines", async () => {
  const dir = scratch();
  try {
    const empty = path.join(dir, 'empty.cjs');
    fs.writeFileSync(empty, '');
    const env = baseEnv(dir, { NODE_OPTIONS: `--require ${empty}`, PORT: String(await freeLoopbackPort()) });
    const refused = await run('npm', ['start'], { env });
    assert.equal(refused.code, 1, refused.out + refused.err);
    assert.equal(refused.out, [...NPM_HEADER, ...REFUSAL, ''].join('\n'));
    assert.equal(refused.err, '');
    assert.equal(STACK.test(refused.out + refused.err), false);
    assert.equal((refused.out + refused.err).includes(empty), false);
    const fix = await run('env', ['-u', 'NODE_OPTIONS', 'npm', 'start'], { env, untilReady: true });
    assert.ok(fix.stop, `${fix.out}${fix.err}`);
    assert.equal(fix.out().trimEnd().split('\n').at(-1), READY_END);
    const end = await fix.stop();
    assert.equal(end.code, 0, end.out + end.err);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the launcher loads the egress counter before it loads a module from a file, starts a process or opens a client socket, and one counter file holds a hello line for it and for every process it starts', async () => {
  const dir = scratch();
  try {
    const probe = writeProbe(dir);
    const r = await run(process.execPath, launcher(ROOT, ['--require', probe.file]), { env: baseEnv(dir, { PORT: String(await freeLoopbackPort()) }), untilReady: true });
    assert.ok(r.stop, `${r.out}${r.err}`);
    try {
      const notes = probe.notes();
      if (!notes.some((n) => n.what === 'hooks unavailable')) assert.ok(notes.some((n) => n.what.startsWith('load ')), 'modules loaded');
      assert.ok(notes.filter((n) => n.what === 'spawn').length >= 5, 'components started');
      assert.ok(notes.some((n) => n.what === 'connect'), 'client sockets opened');
      assert.equal(notes.filter(probeSpawn).length, 1, 'the probe started once');
      assert.equal(notes.filter(startCheck).some((n) => n.counter), false, 'the start checks ran before the counter loaded');
      assert.deepEqual(notes.filter((n) => !n.counter && n.what !== 'hooks unavailable' && !startCheck(n)).map((n) => n.what), []);
      const counterFile = startCounterFile(dir);
      checkOneCounterFile(counterFile, { pid: r.pid, counterPath: path.join(ROOT, 'src/egress/counter.cjs') });
      // The probe: its pid is recorded with exit status 0 before any
      // component starts. It ran before the counter loaded, so no counter line
      // names it; every process started after it has a hello line (above).
      const recordFile = path.join(path.dirname(counterFile), 'probe.json');
      assert.equal(fs.statSync(recordFile).mode & 0o777, 0o600);
      const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      assert.equal(record.status, 0);
      assert.ok(Number.isInteger(record.pid) && record.pid > 0, `probe pid ${record.pid}`);
      const lines = readCounter(counterFile).lines;
      const firstStart = lines.find((l) => l.kind === 'child' && l.pid === r.pid && Number.isInteger(l.childPid) && l.childPid > 0);
      assert.ok(firstStart && record.t <= firstStart.t, 'the probe is recorded before any component starts');
      assert.equal(lines.some((l) => l.pid === record.pid || l.childPid === record.pid), false, 'no counter line names the probe');
      const runDirs = fs.readdirSync(path.join(dir, 'tmp')).filter((d) => d.startsWith('bank-demo-run-'));
      assert.ok(runDirs.length > 0);
      for (const d of runDirs) assert.equal(fs.existsSync(path.join(dir, 'tmp', d, 'egress.jsonl')), false, `${d} has no counter file of its own`);
    } finally {
      const end = await r.stop();
      assert.equal(end.code, 0, end.out + end.err);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the counter option writes the path as a JSON string: a child loads the counter from a path with a space, a double quote or a backslash; with a space or a double quote, the bare path does not load', () => {
  const dir = scratch();
  try {
    // The child loads a copy of the counter, a file of the demo, so it runs
    // under a profile of its own with the boundary's terms.
    const profile = writeProfile(path.join(dir, 'counter.sb'), outerProfileText([]));
    for (const name of ['dir with space', 'dir"quote', 'dir\\backslash']) {
      const counterPath = path.join(dir, name, 'counter.cjs');
      fs.mkdirSync(path.dirname(counterPath));
      fs.copyFileSync(path.join(ROOT, 'src/egress/counter.cjs'), counterPath);
      assert.equal(counterOption(counterPath), `--require ${JSON.stringify(counterPath)}`);
      const egressLog = path.join(dir, name, 'egress.jsonl');
      const env = childEnv({ home: path.join(dir, 'home'), egressLog, counterPath });
      assert.equal(env.NODE_OPTIONS, counterOption(counterPath));
      const r = spawnSync(SANDBOX_EXEC, ['-f', profile, process.execPath, '-e', ''], { env, encoding: 'utf8' });
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.equal(r.stderr, '');
      assert.ok(readCounter(egressLog).lines.some((l) => l.kind === 'hello' && l.pid === r.pid && l.nodeOptions === counterOption(counterPath)), `${name}: a hello line for the child`);
      if (name.includes('backslash')) continue;
      const bare = spawnSync(process.execPath, ['-e', ''], { env: { ...env, NODE_OPTIONS: `--require ${counterPath}` }, encoding: 'utf8' });
      assert.notEqual(bare.status, 0, name);
      assert.equal(readCounter(egressLog).lines.some((l) => l.pid === bare.pid), false, `${name}: the bare path loads no counter`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the launcher from a clone under a path with a space, and from one with a double quote: it and every process it starts load the counter', async () => {
  for (const name of ['clone with space', 'clone"quote']) {
    const dir = scratch();
    try {
      const clone = copyClone(path.join(dir, name));
      const r = await run(process.execPath, launcher(clone), { cwd: clone, env: baseEnv(dir, { PORT: String(await freeLoopbackPort()) }), untilReady: true });
      assert.ok(r.stop, `${name}: ${r.out}${r.err}`);
      try {
        checkOneCounterFile(startCounterFile(dir), { pid: r.pid, counterPath: path.join(clone, 'src/egress/counter.cjs') });
      } finally {
        const end = await r.stop();
        assert.equal(end.code, 0, `${name}: ${end.out}${end.err}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("npm start > file 2>&1: after the ready lines, and again after Ctrl+C, the file holds npm's header, the three lines and Stopped., one address and no escape byte", async () => {
  const dir = scratch();
  const file = path.join(dir, 'start.txt');
  const port = await freeLoopbackPort();
  const fd = fs.openSync(file, 'w');
  const child = spawn('npm', ['start'], { cwd: ROOT, env: baseEnv(dir, { PORT: String(port) }), stdio: ['ignore', fd, fd], detached: true });
  fs.closeSync(fd);
  const closed = new Promise((done) => child.on('close', (code, signal) => done({ code, signal })));
  try {
    const t0 = Date.now();
    while (!fs.readFileSync(file, 'utf8').includes(READY_END) && Date.now() - t0 < 120 * SECOND) await sleep(200);
    assert.deepEqual(plainStart(fs.readFileSync(file), { port, stopped: false }), []);
    process.kill(-child.pid, 'SIGINT');
    const end = await closed;
    assert.equal(end.code, 0);
    assert.deepEqual(plainStart(fs.readFileSync(file), { port, stopped: true }), []);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group has ended */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the start output reader refuses a line more, an escape byte and a second address, and passes a notice block npm writes at exit', () => {
  const port = 7380;
  const good = [...NPM_HEADER, 'Agent banking delegation demo, build 0123abc', `Ready. Open http://127.0.0.1:${port}/ in a browser.`, READY_END, 'Stopped.', ''].join('\n');
  assert.deepEqual(plainStart(Buffer.from(good), { port, stopped: true }), []);
  assert.deepEqual(plainStart(Buffer.from(`${good}npm notice\nnpm notice A new version of npm is out\nnpm notice\n`), { port, stopped: true }), []);
  const bad = [
    good.replace('Stopped.', 'egress counter loaded\nStopped.'),
    good.replace('Ready.', '\x1b[1mReady.'),
    `${good}http://127.0.0.1:${port}/\n`,
    good.replace(READY_END, `${READY_END}\nnpm notice`),
  ];
  for (const b of bad) assert.notDeepEqual(plainStart(Buffer.from(b), { port, stopped: true }), [], JSON.stringify(b));
});

test('the launcher names neither the sandbox nor the offline check', () => {
  const text = fs.readFileSync(path.join(ROOT, 'bin/start.mjs'), 'utf8');
  assert.deepEqual(text.match(/sandbox|offline/gi) ?? [], []);
});

test('the dependency check resolves each package without evaluating it, and refuses a missing one with its two lines', async () => {
  const dir = scratch();
  try {
    const clone = path.join(dir, 'clone');
    for (const d of ['bin', 'src']) fs.cpSync(path.join(ROOT, d), path.join(clone, d), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(clone, 'package.json'));
    const entries = [];
    const fake = (name, entry, extra = {}) => {
      const pkg = path.join(clone, 'node_modules', name);
      fs.mkdirSync(path.dirname(path.join(pkg, entry)), { recursive: true });
      fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name, version: '0.0.0', ...extra }));
      fs.writeFileSync(path.join(pkg, entry), `process.stderr.write(${JSON.stringify(`${MARKER}\n`)});\n`);
      entries.push(path.join(pkg, entry));
    };
    fake('secretless-ai', 'dist/broker/index.js');
    fake('@opena2a/atx-verify', 'index.js', { main: 'index.js' });
    fake('@noble/post-quantum', 'ml-dsa.js');
    for (const e of entries) assert.equal(spawnSync(process.execPath, [e], { encoding: 'utf8' }).stderr, `${MARKER}\n`, `${e} writes the marker when it is evaluated`);

    const passed = await run(process.execPath, launcher(clone), { cwd: clone, env: baseEnv(dir, { PORT: 'x' }) });
    assert.equal(passed.code, 1, passed.out + passed.err);
    assert.match(passed.out, /^PORT must be a port number from 1 to 65535, not "x"\.\nFix: run: PORT=[0-9]+ npm start\n$/);
    assert.equal(passed.err, '');
    assert.equal((passed.out + passed.err).includes(MARKER), false);

    fs.rmSync(path.join(clone, 'node_modules', '@opena2a'), { recursive: true });
    const missing = await run(process.execPath, launcher(clone), { cwd: clone, env: baseEnv(dir, { PORT: String(await freeLoopbackPort()) }) });
    assert.equal(missing.code, 1, missing.out + missing.err);
    assert.equal(missing.out, 'Dependencies are not installed.\nFix: npm ci\n');
    assert.equal(missing.err, '');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'tmp')), [], 'a refusal leaves no start directory');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
