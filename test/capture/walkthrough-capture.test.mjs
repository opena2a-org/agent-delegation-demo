// The walkthrough capture script, run for real from this clone in the
// installed Chrome. A run that fails in each of the four ways the script's
// faults seam makes exits 1 and leaves docs/captures as the commit holds it.
// Each still's sidecar carries its alt at the top level as well as under
// image. Ctrl+C, or a SIGTERM, removes the run's own directory and nothing
// else, and the script exits non-zero. The --record refusals and the broker
// socket path are checked in test/walkthrough-capture.test.mjs.
//
// Each capture runs in a process of its own, the script itself or
// test/support/capture-fault.mjs for a run with a fault, and each has a time
// limit. A capture needs an unmodified clone, so the tests here are skipped
// in a clone with changes. The --record run is skipped when Playwright's
// ffmpeg build is not in the Playwright cache (install it with node
// scripts/install-playwright-ffmpeg.mjs, or point PLAYWRIGHT_BROWSERS_PATH
// at a cache that holds it) or when ffmpeg or ffprobe is not on PATH.
//
// The file is of the launcher shape (test/support/shapes.mjs), and loads no
// package. The read of Playwright's registry starts none of the demo's
// parts, so it runs under one profile with the boundary's terms. A capture
// starts the demo's parts under their own profiles, and a process inside a
// profile cannot apply a different one, so the script runs outside every
// profile, and it loads playwright-core and drives the browser there.
//
// npm run test:capture runs this file with no runner limit: each test here
// names a limit above the sum of the waits it holds, and its own named
// failure arrives before the runner's would. npm test gives a test 120000 ms
// and does not reach this directory.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildInfo } from '../../src/build-info.mjs';
import { SANDBOX_EXEC, realExecPath, resolveProfilePaths } from '../../src/orchestrator/sandbox.mjs';
import { outerProfileText } from '../support/profiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'docs/demo/walkthrough.demo.mjs');
const DRIVER = path.join(ROOT, 'test/support/capture-fault.mjs');
const REGISTRY_READ = path.join(ROOT, 'test/support/ffmpeg-build.mjs');
const INSTALL = 'node scripts/install-playwright-ffmpeg.mjs';

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
// A capture child's TMPDIR. npm start makes the demo's run directory in it,
// and the bank's broker listens at <run directory>/sock/broker.sock. It sits
// under /tmp, not os.tmpdir(): under macOS's own TMPDIR that path comes to
// 110 bytes. Each one is removed once the file's tests have run.
const captureTmps = [];
const captureTmp = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join('/tmp', 'walk-tmp-')));
  captureTmps.push(dir);
  return dir;
};
after(() => { for (const dir of captureTmps) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const porcelain = (...paths) => execFileSync('git', ['-C', ROOT, 'status', '--porcelain', ...(paths.length ? ['--', ...paths] : [])], { encoding: 'utf8' });
// A directory's entries, or null when it does not exist.
const entries = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort() : null);
const isExecutable = (f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } };
const onPath = (name, PATH = process.env.PATH ?? '') => PATH.split(path.delimiter).filter(Boolean).some((d) => isExecutable(path.join(d, name)));

// A process that loads a package and starts none of the demo's parts: one
// profile with the boundary's terms and no outbound network.
const PROFILE = resolveProfilePaths(outerProfileText(['(deny network-outbound)']));
const underProfile = (...argv) => ['-p', PROFILE, realExecPath(), ...argv];

// Where Playwright's own registry looks for its ffmpeg build, read from the
// installed playwright-core, not from the script under test.
const registryEnv = { HOME: process.env.HOME, PATH: process.env.PATH };
if (process.env.PLAYWRIGHT_BROWSERS_PATH) registryEnv.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
const { registryDirectory, ffmpegBuild } = JSON.parse(execFileSync(SANDBOX_EXEC, underProfile(REGISTRY_READ), { cwd: ROOT, env: registryEnv, encoding: 'utf8', timeout: 60000 }));

const build = buildInfo(ROOT);
const CAPTURE = build.fromGit && !build.modified && porcelain('docs/captures') === ''
  ? {}
  : { skip: 'a capture needs an unmodified clone whose docs/captures is as the commit holds it' };
const RECORD = CAPTURE.skip ? CAPTURE
  : !isExecutable(ffmpegBuild) ? { skip: `--record needs Playwright's ffmpeg build at ${ffmpegBuild}: ${INSTALL}` }
  : !onPath('ffmpeg') || !onPath('ffprobe') ? { skip: '--record needs ffmpeg and ffprobe on PATH' }
  : {};

// A child's HOME is a directory of its own, so the Playwright cache the gate
// above read is named for it: with PLAYWRIGHT_BROWSERS_PATH unset, the cache
// under that HOME holds nothing and --record refuses.
function childEnv(extra = {}) {
  return { HOME: tmp('walk-home-'), PATH: process.env.PATH, LANG: 'en_US.UTF-8', npm_config_update_notifier: 'false', PLAYWRIGHT_BROWSERS_PATH: registryDirectory, ...extra };
}

// The most a test with a capture waits, as the runner's limit for that test:
// the waits it names, the stop after them, and a margin, in ms.
const STOP_MS = 60000;
const limit = (gate, waitsMs) => ({ ...gate, timeout: waitsMs + STOP_MS + 10000 });
const minutes = (n) => n * 60000;

// One capture run with one fault, in a process of its own: the driver calls
// the script's run() with the fault named. How it ended, what it printed,
// what git says of docs/captures after it, the records directory, any
// directory of the run's own left in its TMPDIR, and the sidecars it wrote.
async function faultRun(name, minutes) {
  const T = captureTmp();
  const out = tmp('walk-out-');
  const records = path.join(out, 'records');
  const sidecarsFile = path.join(out, 'sidecars.json');
  const before = porcelain('docs/captures');
  const child = spawn(process.execPath, [DRIVER, name, records, sidecarsFile], { cwd: ROOT, env: childEnv({ TMPDIR: T }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let printed = '';
  child.stdout.on('data', (d) => { printed += d; });
  child.stderr.on('data', (d) => { printed += d; });
  const end = await within(new Promise((r) => child.on('exit', (code, signal) => r({ code, signal }))), minutes * 60000);
  await stopGroup(child);
  return {
    end, printed, before, minutes,
    captures: porcelain('docs/captures'),
    records: entries(records),
    ownLeft: fs.readdirSync(T).filter((n) => n.startsWith('walkthrough-')),
    sidecars: fs.existsSync(sidecarsFile) ? JSON.parse(fs.readFileSync(sidecarsFile, 'utf8')) : null,
  };
}

function failedClosed(r, problem) {
  assert.ok(r.end, `the run did not end within ${r.minutes} minutes: ${r.printed.slice(-1500)}`);
  assert.equal(r.end.code, 1, r.printed);
  assert.equal(r.captures, r.before, 'git status --porcelain -- docs/captures: the run changed it');
  assert.equal(r.captures, '', 'git status --porcelain -- docs/captures');
  assert.match(r.printed, problem);
  assert.equal(r.records, null, 'the records directory: the run created it');
  assert.deepEqual(r.ownLeft, [], 'directories of the run left in its TMPDIR');
}

const OUTSIDE = /address(es)? other than 127\.0\.0\.1: http:\/\/192\.0\.2\.1/;

test('fail closed, --stills: a proof that does not hold exits 1, and docs/captures is as the commit holds it', limit(CAPTURE, minutes(4)), async () => {
  failedClosed(await faultRun('stills-proof', 4), /02-scenario-1-normal-bill: the proof does not hold/);
});

// The over-the-limit run also writes every still's sidecar as the script
// generates it, for the sidecar test below, which reads them whether or not
// the run ended.
let overLimit = null;
const overLimitRun = () => (overLimit ??= faultRun('stills-over-limit', 4));

test('fail closed, --stills: a still over its size limit exits 1, and docs/captures is as the commit holds it', limit(CAPTURE, minutes(4)), async () => {
  failedClosed(await overLimitRun(), /03-scenario-2-fake-invoice\.png: \d+ bytes, over the limit of 600000/);
});

test('fail closed, --stills: a request that leaves 127.0.0.1 exits 1, and docs/captures is as the commit holds it', limit(CAPTURE, minutes(4)), async () => {
  failedClosed(await faultRun('stills-request', 4), OUTSIDE);
});

test('fail closed, --record: a request that leaves 127.0.0.1 exits 1, and docs/captures is as the commit holds it', limit(RECORD, minutes(8)), async () => {
  failedClosed(await faultRun('record-request', 8), OUTSIDE);
});

test('sidecar: each still\'s sidecar has its alt at the top level, equal to image.alt, beside image', limit(CAPTURE, minutes(4)), async () => {
  const { sidecars } = await overLimitRun();
  assert.ok(sidecars, 'the run wrote its sidecars');
  const stills = fs.readdirSync(path.join(ROOT, 'docs/captures')).filter((f) => f.endsWith('.png'));
  assert.deepEqual(Object.keys(sidecars).sort(), stills.map((f) => f.replace(/\.png$/, '.json')).sort());
  for (const [name, side] of Object.entries(sidecars)) {
    assert.deepEqual(Object.keys(side).sort(), ['alt', 'image'], name);
    assert.equal(typeof side.alt, 'string', name);
    assert.ok(side.alt.length > 0 && side.alt.length <= 160, `${name}: ${side.alt}`);
    assert.equal(side.alt, side.image.alt, name);
  }
});

// The script started in its own process group, as a shell starts a command,
// with TMPDIR set to a directory of the test's, where a directory named like
// another run's sits from the start.
const ANOTHER = 'walkthrough-run-another';
function startCapture(records) {
  const T = captureTmp();
  fs.mkdirSync(path.join(T, ANOTHER));
  fs.writeFileSync(path.join(T, ANOTHER, 'kept'), 'kept\n');
  const child = spawn(process.execPath, [SCRIPT, '--stills', '--records', records], { cwd: ROOT, env: childEnv({ TMPDIR: T }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const ended = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal, out: () => out })));
  return { T, child, ended, own: () => fs.readdirSync(T).find((n) => n.startsWith('walkthrough-') && n !== ANOTHER) };
}

async function until(fn, ms, stop = () => false) {
  for (const end = Date.now() + ms; ;) {
    const v = fn();
    if (v || stop() || Date.now() > end) return v || null;
    await sleep(50);
  }
}
const groupGone = (pgid, ms) => until(() => { try { process.kill(-pgid, 0); return false; } catch (err) { return err.code === 'ESRCH'; } }, ms);
const within = (p, ms) => Promise.race([p, sleep(ms).then(() => null)]);

// Whatever of the run is left after a test: the group is sent SIGINT, as a
// terminal's Ctrl+C sends it, so the demo stops on its own path.
async function stopGroup(child) {
  if (await groupGone(child.pid, 0)) return;
  try { process.kill(-child.pid, 'SIGINT'); } catch {}
  if (await groupGone(child.pid, STOP_MS)) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

function leftAsTheyWere(c, own, before, records) {
  assert.equal(fs.existsSync(path.join(c.T, own)), false, `the run's own directory ${own} is still there`);
  assert.deepEqual(entries(path.join(c.T, ANOTHER)), ['kept'], 'the other directory is left as it was');
  assert.equal(porcelain(), before, 'git status --porcelain after the stop');
  assert.equal(entries(records), null, 'the records directory: the run created it');
}

// The script makes stage/ in its own directory after its synchronous git
// rev-parse HEAD. A SIGINT that lands on that call ends git, and the script
// then exits 1, so the SIGINT goes once stage/ is there.
test('Ctrl+C: SIGINT to the process group once the run\'s own directory holds stage/ removes that directory and nothing else, and the script exits 130', limit(CAPTURE, 60000 + 120000), async () => {
  const records = path.join(tmp('walk-out-'), 'records');
  const before = porcelain();
  const c = startCapture(records);
  try {
    const own = await until(() => { const o = c.own(); return o && fs.existsSync(path.join(c.T, o, 'stage')) ? o : null; }, 60000, () => c.child.exitCode !== null);
    assert.ok(own, `the run made a directory of its own in TMPDIR, with stage/ in it (its own directory: ${c.own() ?? 'none'})`);
    process.kill(-c.child.pid, 'SIGINT');
    const end = await within(c.ended, 120000);
    assert.ok(end, 'the script ended after SIGINT');
    leftAsTheyWere(c, own, before, records);
    assert.equal(end.code, 130, `exit ${end.code}, signal ${end.signal}: ${end.out()}`);
  } finally {
    await stopGroup(c.child);
  }
});

test('SIGTERM to the script alone, once the overview still is staged: the demo it started stops, its own directory is removed, nothing else is, and it exits 143', limit(CAPTURE, 60000 + 240000 + 120000 + 30000), async () => {
  const records = path.join(tmp('walk-out-'), 'records');
  const before = porcelain();
  const c = startCapture(records);
  try {
    const own = await until(c.own, 60000, () => c.child.exitCode !== null);
    assert.ok(own, 'the run made a directory of its own in TMPDIR');
    const staged = await until(() => ['stage/clone', 'clone'].map((p) => path.join(c.T, own, p, 'docs/captures/00-overview.png')).find((f) => fs.existsSync(f)), 240000, () => c.child.exitCode !== null);
    assert.ok(staged, 'the overview still was staged');
    c.child.kill('SIGTERM');
    const end = await within(c.ended, 120000);
    assert.ok(end, 'the script ended after SIGTERM');
    leftAsTheyWere(c, own, before, records);
    assert.equal(end.code, 143, `exit ${end.code}, signal ${end.signal}: ${end.out()}`);
    assert.equal(await groupGone(c.child.pid, 30000), true, 'a process the run started is still running');
  } finally {
    await stopGroup(c.child);
  }
});
