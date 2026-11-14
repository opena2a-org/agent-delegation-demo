// scripts/install-playwright-ffmpeg.mjs, the install line of the --record
// route, with no network beyond this machine. The archive checks run on
// archives built here; the script itself runs as a reader runs it, with
// PLAYWRIGHT_BROWSERS_PATH and HOME of its own and PLAYWRIGHT_DOWNLOAD_HOST
// naming a server on 127.0.0.1, so the installed playwright-core's registry
// gives it that server's address and the path the build has on its own
// hosts. The build in these archives is a stand-in that exits 0 with
// -version, or one that exits 3.

import './support/outer-profile.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { MARKER, readArchive, safeName } from '../scripts/install-playwright-ffmpeg.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/install-playwright-ffmpeg.mjs');

// What the installed playwright-core names for its ffmpeg build: the
// executable's path inside the build's directory, that directory's name, the
// download paths, and the package path its .links entry holds.
const m = await import('playwright-core/lib/server/registry/index');
const ffmpeg = (m.registry ?? m.default.registry).findExecutable('ffmpeg');
const EXE = path.relative(ffmpeg.directory, ffmpeg.executablePath());
const BUILD_DIR = path.basename(ffmpeg.directory);
const DOWNLOAD_PATHS = ffmpeg.downloadURLs.map((u) => new URL(u).pathname);
const PACKAGE = path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
const LINK = crypto.createHash('sha1').update(PACKAGE).digest('hex');

const made = [];
const tmp = (prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const listed = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort() : null);
const porcelain = () => execFileSync('git', ['-C', ROOT, 'status', '--porcelain'], { encoding: 'utf8' });

const STAND_IN = Buffer.from('#!/bin/sh\necho "ffmpeg version stand-in"\nexit 0\n');
const EXITS_THREE = Buffer.from('#!/bin/sh\nexit 3\n');
const LICENSE = Buffer.from('A license text that sits beside the build.\n'.repeat(40));

// A zip archive of the files given, each deflated, with its central
// directory. A file may give a listed size or a CRC-32 other than its own,
// as an archive cut short or changed in transit would carry.
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data, mode = 0o644, listedSize = data.length, crc = zlib.crc32(data) } of files) {
    const nameBuf = Buffer.from(name);
    const packed = zlib.deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(listedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(8, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(listedSize, 24);
    record.writeUInt16LE(nameBuf.length, 28);
    record.writeUInt32LE(((0o100000 | mode) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, packed);
    central.push(record, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const listing = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(listing.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, listing, end]);
}

const build = (exe = STAND_IN, extra = {}) => zip([{ name: EXE, data: exe, mode: 0o755, ...extra }, { name: 'COPYING.LGPLv2.1', data: LICENSE }]);

// A server on 127.0.0.1 that answers every request with the handler given,
// and keeps the paths it was asked for.
async function serve(handler) {
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url);
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { asked, host: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}
const zipBody = (body) => (req, res) => {
  res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length });
  res.end(body);
};

// One run of the script as a reader types it, from the clone, with a HOME,
// a TMPDIR and a PLAYWRIGHT_BROWSERS_PATH of its own.
async function install(host, { browsers = tmp('ffmpeg-browsers-') } = {}) {
  const env = { HOME: tmp('ffmpeg-home-'), TMPDIR: tmp('ffmpeg-tmp-'), PATH: process.env.PATH, LANG: 'en_US.UTF-8', PLAYWRIGHT_BROWSERS_PATH: browsers, PLAYWRIGHT_DOWNLOAD_HOST: host };
  const before = porcelain();
  const child = spawn(process.execPath, [SCRIPT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const status = await new Promise((r) => child.on('close', r));
  return { status, stdout, stderr, browsers, home: listed(env.HOME), tmpdir: listed(env.TMPDIR), porcelainBefore: before, porcelainAfter: porcelain() };
}

test('archive: a whole archive reads back file for file, and an entry name that leaves its directory is refused', () => {
  const entries = readArchive(build());
  assert.deepEqual(entries.map((e) => [e.name, e.size, e.mode]), [[EXE, STAND_IN.length, 0o755], ['COPYING.LGPLv2.1', LICENSE.length, 0o644]]);
  assert.deepEqual(entries[0].data, STAND_IN);
  for (const bad of ['../ffmpeg-mac', 'a/../../b', '/usr/local/bin/ffmpeg', 'C:/ffmpeg.exe', 'a\\b', '', 'a//b']) assert.equal(safeName(bad), false, bad);
  for (const good of ['ffmpeg-mac', 'lib/ffmpeg', 'dir/']) assert.equal(safeName(good), true, good);
  assert.throws(() => readArchive(zip([{ name: '../ffmpeg-mac', data: STAND_IN }])), /names a path outside the directory it unpacks into/);
});

test('archive: a download cut short, an entry shorter than its listing and an entry whose CRC-32 differs are each refused, naming what does not hold', () => {
  const whole = build();
  assert.throws(() => readArchive(whole.subarray(0, Math.floor(whole.length / 2))), (err) => {
    assert.deepEqual(err.lines, ['The archive does not read as a whole zip file: it has no end of central directory record.']);
    return true;
  });
  assert.throws(() => readArchive(build(STAND_IN, { listedSize: STAND_IN.length + 1000 })), (err) => {
    assert.match(err.lines[0], new RegExp(`entry ${EXE} unpacks to ${STAND_IN.length} bytes, and its listing gives ${STAND_IN.length + 1000}\\.$`));
    return true;
  });
  assert.throws(() => readArchive(build(STAND_IN, { crc: (zlib.crc32(STAND_IN) ^ 1) >>> 0 })), /has CRC-32 [0-9a-f]{8}, and its listing gives [0-9a-f]{8}\.$/);
});

test('install: the script fetches the registry\'s path from PLAYWRIGHT_DOWNLOAD_HOST, puts the build, its marker and its .links entry in place, and writes nothing outside PLAYWRIGHT_BROWSERS_PATH', async () => {
  const server = await serve(zipBody(build()));
  try {
    const r = await install(server.host);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    assert.equal(server.asked.length, 1);
    assert.match(server.asked[0], /\.zip$/);
    for (const p of DOWNLOAD_PATHS) assert.ok(p.endsWith(server.asked[0]), `${p} ends with ${server.asked[0]}`);
    const exe = path.join(r.browsers, BUILD_DIR, EXE);
    assert.equal(fs.statSync(exe).size, STAND_IN.length);
    assert.equal(fs.statSync(exe).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(r.browsers, BUILD_DIR)).mode & 0o777, 0o755);
    assert.deepEqual(listed(r.browsers), ['.links', path.join('.links', LINK), BUILD_DIR, path.join(BUILD_DIR, 'COPYING.LGPLv2.1'), path.join(BUILD_DIR, EXE), path.join(BUILD_DIR, MARKER)].sort());
    assert.equal(fs.readFileSync(path.join(r.browsers, '.links', LINK), 'utf8'), PACKAGE);
    assert.ok(r.stdout.includes(`${EXE} exits 0 with -version: ffmpeg version stand-in`), r.stdout);
    assert.ok(r.stdout.trim().endsWith(`Installed ${exe}, ${STAND_IN.length} bytes.`), r.stdout);
    assert.deepEqual([r.home, r.tmpdir], [[], []], 'HOME and TMPDIR');
    assert.equal(r.porcelainAfter, r.porcelainBefore);
  } finally {
    await server.close();
  }
});

test('install: an archive cut short, a body cut short, an HTTP error and a build that does not exit 0 with -version each exit 1 and leave PLAYWRIGHT_BROWSERS_PATH as it was', async () => {
  const whole = build();
  const cases = {
    'archive cut short': [zipBody(whole.subarray(0, whole.length - 30)), /The archive does not read as a whole zip file: /],
    'body cut short': [(req, res) => {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': whole.length });
      res.write(whole.subarray(0, Math.floor(whole.length / 2)), () => res.socket.destroy());
    }, new RegExp(`the body ended after [0-9]+ of ${whole.length} bytes`)],
    'HTTP 404': [(req, res) => { res.writeHead(404); res.end('not here\n'); }, /: HTTP 404$/m],
    'exits 3': [zipBody(build(EXITS_THREE)), new RegExp(`${EXE} from \\S+, ${EXITS_THREE.length} bytes, exits 3 when run with -version, so it is not put in place\\.`)],
  };
  for (const [name, [handler, said]] of Object.entries(cases)) {
    const server = await serve(handler);
    try {
      const r = await install(server.host);
      assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, said, name);
      assert.ok(r.stderr.trim().endsWith(`Nothing was put in place; ${path.join(r.browsers, BUILD_DIR)} is as it was.`), `${name}: ${r.stderr}`);
      assert.deepEqual(listed(r.browsers), [], name);
      assert.deepEqual([r.home, r.tmpdir], [[], []], name);
      assert.equal(r.porcelainAfter, r.porcelainBefore, name);
    } finally {
      await server.close();
    }
  }
});

test('install: a PLAYWRIGHT_BROWSERS_PATH this user cannot write exits 1 with the file system\'s message, no stack trace, and the directory as it was', async () => {
  const server = await serve(zipBody(build()));
  const browsers = tmp('ffmpeg-browsers-');
  fs.chmodSync(browsers, 0o555);
  try {
    const r = await install(server.host, { browsers });
    assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^EACCES: permission denied, mkdtemp /m);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
    assert.ok(r.stderr.trim().endsWith(`Nothing was put in place; ${path.join(browsers, BUILD_DIR)} is as it was.`), r.stderr);
    assert.deepEqual(listed(browsers), []);
  } finally {
    fs.chmodSync(browsers, 0o755);
    await server.close();
  }
});

test('install: a build an install left cut short is replaced, and a whole build already in place is kept with no download', async () => {
  const server = await serve(zipBody(build()));
  try {
    const browsers = tmp('ffmpeg-browsers-');
    fs.mkdirSync(path.join(browsers, BUILD_DIR));
    fs.writeFileSync(path.join(browsers, BUILD_DIR, EXE), fs.readFileSync('/usr/bin/true').subarray(0, 4096), { mode: 0o755 });
    const r = await install(server.host, { browsers });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`The directory holds an incomplete build \\(${EXE}, 4096 bytes, (does not start|is stopped by SIG[A-Z]+|exits [0-9]+) when run with -version\\)`));
    assert.deepEqual(fs.readFileSync(path.join(browsers, BUILD_DIR, EXE)), STAND_IN);
    assert.deepEqual(listed(browsers), ['.links', path.join('.links', LINK), BUILD_DIR, path.join(BUILD_DIR, 'COPYING.LGPLv2.1'), path.join(BUILD_DIR, EXE), path.join(BUILD_DIR, MARKER)].sort());
    assert.equal(server.asked.length, 1);
    const again = await install(server.host, { browsers });
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, new RegExp(`It is in place: \\S+${EXE}, ${STAND_IN.length} bytes, exits 0 with -version\\.`));
    assert.equal(server.asked.length, 1, 'no second download');
  } finally {
    await server.close();
  }
});
