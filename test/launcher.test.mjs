// npm start: the checks run before anything loads, each refusal names a fix
// that clears it, the ready output is three plain lines, and a stop leaves
// nothing listening.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeLoopbackPort, portIsFree } from '../src/orchestrator/ports.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = () => ({ PATH: process.env.PATH, HOME: os.tmpdir(), LANG: 'C', TZ: 'UTC' });

function launch({ root = ROOT, args = [], extraEnv = {}, preload = null, untilReady = false }) {
  return new Promise((resolve) => {
    const argv = [...(preload ? ['--require', preload] : []), path.join(root, 'bin/start.mjs'), ...args];
    const child = spawn(process.execPath, argv, { cwd: root, env: { ...env(), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => {
      out += c;
      if (untilReady && out.includes('Press Ctrl+C to stop.')) resolve({ child, out, err });
    });
    child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

// The way a terminal delivers Ctrl+C: SIGINT to every process of the
// foreground group at once, the launcher and each component.
function launchGroup(port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/start.mjs')], {
      cwd: ROOT,
      env: { ...env(), PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let out = '';
    const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
    child.stdout.on('data', (c) => {
      out += c;
      if (out.includes('Press Ctrl+C to stop.')) resolve({ child, exited, output: () => out });
    });
  });
}

function stopAndWait(child) {
  return new Promise((resolve) => {
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('exit', (code) => resolve({ code, out }));
    child.kill('SIGTERM');
  });
}

const preload = (body) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-preload-')), 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
};
const noStack = (s) => assert.equal(/\n\s+at |Error:|node:internal/.test(s), false, s);

test('the launcher imports node: modules and nothing else', () => {
  const imports = fs.readFileSync(path.join(ROOT, 'bin/start.mjs'), 'utf8').split('\n').filter((l) => /^import .* from '/.test(l));
  assert.ok(imports.length > 0);
  for (const l of imports) assert.match(l, /from 'node:[a-z_/]+';$/);
});

test('refusal: Windows', async () => {
  const r = await launch({ preload: preload("Object.defineProperty(process, 'platform', { value: 'win32' });") });
  assert.equal(r.code, 1);
  assert.equal(r.out, 'This demo does not run on Windows.\nFix: run it on a platform listed under Requirements in the README.\n');
  noStack(r.out + r.err);
});

test('refusal: Node.js older than 22.12.0', async () => {
  const r = await launch({ preload: preload("Object.defineProperty(process.versions, 'node', { value: '22.11.0' });") });
  assert.equal(r.code, 1);
  assert.equal(r.out, 'This demo needs Node.js 22.12.0 or later. This is Node.js 22.11.0.\nFix: install Node.js 22.12.0 or later, then run: npm ci && npm start\n');
  noStack(r.out + r.err);
});

test('refusal: dependencies not installed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-nodeps-'));
  for (const d of ['bin', 'src', 'vendor', 'fixtures']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  const r = await launch({ root: dir, extraEnv: { PORT: String(await freeLoopbackPort()) } });
  assert.equal(r.code, 1);
  assert.equal(r.out, 'Dependencies are not installed.\nFix: npm ci\n');
  noStack(r.out + r.err);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('refusal: port in use, and the suggested port clears it', async () => {
  const busy = net.createServer();
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  const p = busy.address().port;
  const r = await launch({ extraEnv: { PORT: String(p) } });
  busy.close();
  assert.equal(r.code, 1);
  const lines = r.out.trimEnd().split('\n');
  assert.equal(lines[0], `Port ${p} on 127.0.0.1 is in use, possibly by an earlier run of this demo.`);
  const m = /^Fix: stop that run with Ctrl\+C in its terminal, or run: PORT=([0-9]+) npm start$/.exec(lines[1]);
  assert.ok(m, lines[1]);
  noStack(r.out + r.err);
  const ok = await launch({ extraEnv: { PORT: m[1] }, untilReady: true });
  assert.ok(ok.child, ok.out);
  const stopped = await stopAndWait(ok.child);
  assert.equal(stopped.code, 0);
});

test('refusal: arguments', async () => {
  const r = await launch({ args: ['--port', '1'], extraEnv: { PORT: String(await freeLoopbackPort()) } });
  assert.equal(r.code, 1);
  assert.match(r.out, /^npm start takes no arguments\.\nFix: npm start, or to change the port: PORT=[0-9]+ npm start\n$/);
  noStack(r.out + r.err);
});

test('ready: three plain lines after every component answers, then Ctrl+C stops everything and frees the port', async () => {
  const p = await freeLoopbackPort();
  const r = await launch({ extraEnv: { PORT: String(p) }, untilReady: true });
  const lines = r.out.trimEnd().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Agent banking delegation demo, build ([0-9a-f]{7}( \(modified\))?|not from a git clone)$/);
  assert.equal(lines[1], `Ready. Open http://127.0.0.1:${p}/ in a browser.`);
  assert.equal(lines[2], 'Press Ctrl+C to stop.');
  assert.equal(/\x1b\[/.test(r.out), false);
  const health = await (await fetch(`http://127.0.0.1:${p}/health`)).json();
  assert.equal(health.ok, true);
  const stopped = await stopAndWait(r.child);
  assert.equal(stopped.code, 0);
  assert.equal(stopped.out, 'Stopped.\n');
  assert.equal(await portIsFree(p), true);
});

test('Ctrl+C as a terminal sends it, to every process at once: the demo prints Stopped., exits 0 and frees the port', async () => {
  const p = await freeLoopbackPort();
  const r = await launchGroup(p);
  const children = execFileSync('pgrep', ['-P', String(r.child.pid)], { encoding: 'utf8' }).trim().split('\n');
  assert.ok(children.length >= 5, `${children.length} components`);
  process.kill(-r.child.pid, 'SIGINT');
  const end = await r.exited;
  assert.equal(end.code, 0);
  assert.equal(r.output().split('Press Ctrl+C to stop.\n')[1], 'Stopped.\n');
  assert.equal(await portIsFree(p), true);
});

test('a component that ends while the demo runs is reported with its name, its exit and its log, and the demo exits 1', async () => {
  const p = await freeLoopbackPort();
  const r = await launchGroup(p);
  const children = execFileSync('pgrep', ['-P', String(r.child.pid)], { encoding: 'utf8' }).trim().split('\n').map(Number);
  process.kill(children.at(-1), 'SIGKILL');
  const end = await r.exited;
  assert.equal(end.code, 1);
  const after = r.output().split('Press Ctrl+C to stop.\n')[1];
  assert.match(after, /^The (bank|password path (bill pay|budget) agent|grant path (bill pay|budget) agent) stopped unexpectedly \(exit SIGKILL\)\. The demo has stopped\.\nLog: \S+stderr\.log\nFix: npm start\n$/);
  assert.equal(await portIsFree(p), true);
});

test('footer: a file under docs/captures does not mark the build modified; any other change does', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-clone-'));
  execFileSync('git', ['clone', '-q', ROOT, dir]);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  fs.appendFileSync(path.join(dir, '.git/info/exclude'), 'node_modules\n');
  fs.mkdirSync(path.join(dir, 'docs/captures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/captures/probe.txt'), 'capture\n');
  const clean = await launch({ root: dir, extraEnv: { PORT: String(await freeLoopbackPort()) }, untilReady: true });
  assert.ok(clean.child, clean.out + clean.err);
  assert.match(clean.out.split('\n')[0], /^Agent banking delegation demo, build [0-9a-f]{7}$/);
  await stopAndWait(clean.child);
  fs.writeFileSync(path.join(dir, 'probe.txt'), 'change\n');
  const dirty = await launch({ root: dir, extraEnv: { PORT: String(await freeLoopbackPort()) }, untilReady: true });
  assert.match(dirty.out.split('\n')[0], /^Agent banking delegation demo, build [0-9a-f]{7} \(modified\)$/);
  await stopAndWait(dirty.child);
  fs.rmSync(dir, { recursive: true, force: true });
});
