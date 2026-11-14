// The walkthrough capture script's --record refusals, run for real from this
// clone: when Playwright's own ffmpeg build or ffmpeg and ffprobe are
// missing, or the build is there but cut short, --record names what it needs
// and exits 1 before it starts anything, having created and deleted no file.
// A capture child's broker socket path fits in the 104 bytes macOS takes for
// a unix socket.
//
// The captures themselves (a run that fails in each of the four ways the
// script's faults seam makes, the stills' sidecars, Ctrl+C and SIGTERM) are
// in test/capture/walkthrough-capture.test.mjs, and npm run test:capture
// runs them. Each names a limit above the waits it holds, longer than the
// 120000 ms npm test gives a test, so npm test does not reach that file.
//
// The file is of the launcher shape (test/support/shapes.mjs), and loads no
// package. The two --record refusals and the read of Playwright's registry
// start none of the demo's parts, so each runs under one profile with the
// boundary's terms.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SANDBOX_EXEC, realExecPath, resolveProfilePaths } from '../src/orchestrator/sandbox.mjs';
import { outerProfileText } from './support/profiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'docs/demo/walkthrough.demo.mjs');
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
const porcelain = (...paths) => execFileSync('git', ['-C', ROOT, 'status', '--porcelain', ...(paths.length ? ['--', ...paths] : [])], { encoding: 'utf8' });
// A directory's entries, or null when it does not exist.
const entries = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort() : null);

// A process that loads a package and starts none of the demo's parts: one
// profile with the boundary's terms and no outbound network.
const PROFILE = resolveProfilePaths(outerProfileText(['(deny network-outbound)']));
const underProfile = (...argv) => ['-p', PROFILE, realExecPath(), ...argv];

// Where Playwright's own registry looks for its ffmpeg build, read from the
// installed playwright-core, not from the script under test.
const registryEnv = { HOME: process.env.HOME, PATH: process.env.PATH };
if (process.env.PLAYWRIGHT_BROWSERS_PATH) registryEnv.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH;
const { registryDirectory, ffmpegBuildInCache } = JSON.parse(execFileSync(SANDBOX_EXEC, underProfile(REGISTRY_READ), { cwd: ROOT, env: registryEnv, encoding: 'utf8', timeout: 60000 }));

// Executables that stand in for a tool. The check never runs a stand-in on
// PATH. It runs Playwright's build with -version, so a stand-in for the
// build is given a body that exits 0.
const NOT_THE_TOOL = '#!/bin/sh\necho "stand-in, not the tool" >&2\nexit 1\n';
const EXITS_ZERO = '#!/bin/sh\nexit 0\n';
function stubs(dir, names, body = NOT_THE_TOOL) {
  for (const n of names) {
    fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true });
    fs.writeFileSync(path.join(dir, n), body, { mode: 0o755 });
  }
  return dir;
}

// A child's HOME is a directory of its own, so the Playwright cache the
// registry read above found is named for it: with PLAYWRIGHT_BROWSERS_PATH
// unset, the cache under that HOME holds nothing and --record refuses.
function childEnv(extra = {}) {
  return { HOME: tmp('walk-home-'), PATH: process.env.PATH, LANG: 'en_US.UTF-8', npm_config_update_notifier: 'false', PLAYWRIGHT_BROWSERS_PATH: registryDirectory, ...extra };
}

// One --record run as a reader types it, with the environment given; what it
// printed, and every directory it could have written to, before and after.
function recordRefusal({ PATH, browsers }) {
  const env = childEnv({ PATH, TMPDIR: tmp('walk-tmp-'), PLAYWRIGHT_BROWSERS_PATH: browsers });
  const records = path.join(tmp('walk-out-'), 'records');
  const watched = [env.HOME, env.TMPDIR, browsers, records];
  const before = { porcelain: porcelain(), dirs: watched.map(entries) };
  const r = spawnSync(SANDBOX_EXEC, underProfile(SCRIPT, '--record', '--records', records), { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  return { ...r, lines: r.stderr.split('\n').filter(Boolean), before, after: { porcelain: porcelain(), dirs: watched.map(entries) } };
}

test('--record: with Playwright\'s ffmpeg build missing, one line names the file it looks for and the install command, and the run exits 1 having created and deleted no file', () => {
  const browsers = tmp('walk-browsers-');
  const r = recordRefusal({ PATH: `${stubs(tmp('walk-path-'), ['ffmpeg', 'ffprobe'])}${path.delimiter}${process.env.PATH}`, browsers });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.after.porcelain, r.before.porcelain, 'git status --porcelain after the run');
  assert.equal(r.lines.length, 1, r.stderr);
  const named = /Playwright's own ffmpeg build at (\S+?), /.exec(r.lines[0])?.[1];
  assert.equal(named, path.join(browsers, ffmpegBuildInCache), r.lines[0]);
  assert.equal(fs.existsSync(named), false);
  assert.ok(r.lines[0].includes(INSTALL), r.lines[0]);
  assert.match(r.lines[0], /an ffmpeg on PATH does not stand in for it/);
  assert.equal(r.stdout, '');
  assert.deepEqual(r.after.dirs, r.before.dirs, 'HOME, TMPDIR, the Playwright cache and the records directory');
  assert.deepEqual(r.after.dirs, [[], [], [], null]);
});

// A build an install left cut short: the leading 4096 bytes of a Mach-O
// executable, a file of the wrong size that the kernel refuses to start, as
// it refused the ffmpeg build `npx playwright-core install ffmpeg` left at
// 2403818 of its 2580312 bytes on Node.js 26.12.1. The check runs it with
// -version, and its line names the file, its size and the install line, in
// place of the numbered spawn error the browser's recorder would report.
test('--record: with Playwright\'s ffmpeg build cut short, one line names the file, its size and the install line, and the run exits 1 having created and deleted no file', () => {
  const browsers = tmp('walk-browsers-');
  const build = path.join(browsers, ffmpegBuildInCache);
  fs.mkdirSync(path.dirname(build), { recursive: true });
  fs.writeFileSync(build, fs.readFileSync('/usr/bin/true').subarray(0, 4096), { mode: 0o755 });
  const bytes = fs.readFileSync(build);
  const r = recordRefusal({ PATH: `${stubs(tmp('walk-path-'), ['ffmpeg', 'ffprobe'])}${path.delimiter}${process.env.PATH}`, browsers });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.after.porcelain, r.before.porcelain, 'git status --porcelain after the run');
  assert.equal(r.lines.length, 1, r.stderr);
  const named = /Playwright's own ffmpeg build at (\S+?), /.exec(r.lines[0])?.[1];
  assert.equal(named, build, r.lines[0]);
  assert.match(r.lines[0], /, and the file there, 4096 bytes, (does not start|is stopped by SIG[A-Z]+|exits [0-9]+) when run with -version\. /);
  assert.ok(r.lines[0].endsWith(`Install it again from the clone with: ${INSTALL}`), r.lines[0]);
  // The temporary path is random and could hold -88 itself, so it is taken
  // out before the error number is looked for.
  assert.doesNotMatch(r.stderr.split(build).join('<build>'), /-88|Unknown system error|spawn/);
  assert.equal(r.stdout, '');
  assert.deepEqual(r.after.dirs, r.before.dirs, 'HOME, TMPDIR, the Playwright cache and the records directory');
  assert.deepEqual(fs.readFileSync(build), bytes, 'the build is left as it was');
});

test('--record: with ffmpeg and ffprobe missing from PATH, one line names them, and the run exits 1 having created and deleted no file', () => {
  const browsers = stubs(tmp('walk-browsers-'), [ffmpegBuildInCache], EXITS_ZERO);
  const r = recordRefusal({ PATH: tmp('walk-path-'), browsers });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.after.porcelain, r.before.porcelain, 'git status --porcelain after the run');
  assert.equal(r.lines.length, 1, r.stderr);
  assert.match(r.lines[0], /^--record needs ffmpeg and ffprobe on PATH/);
  assert.equal(r.stdout, '');
  assert.deepEqual(r.after.dirs, r.before.dirs, 'HOME, TMPDIR, the Playwright cache and the records directory');
});

// macOS takes a unix socket path of at most 104 bytes, and Node 24 refuses
// to listen on a longer one: the demo then stops before its Ready line.
test('a capture child\'s broker socket path is at most 104 bytes', () => {
  const socket = path.join(captureTmp(), 'bank-demo-run-XXXXXX', 'sock', 'broker.sock');
  assert.ok(Buffer.byteLength(socket) <= 104, `${Buffer.byteLength(socket)} bytes: ${socket}`);
});
