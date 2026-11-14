#!/usr/bin/env node
// Installs Playwright's own ffmpeg build, which --record of
// docs/demo/walkthrough.demo.mjs needs to record the browser, where the
// installed playwright-core looks for it: in the Playwright cache, or under
// PLAYWRIGHT_BROWSERS_PATH when it is set.
//
//   node scripts/install-playwright-ffmpeg.mjs
//
// The download addresses, the build's directory and its executable come from
// the installed playwright-core's registry: the values
// `npx playwright-core install ffmpeg` uses, PLAYWRIGHT_DOWNLOAD_HOST
// included. On Node.js 26.12.1 that command stops partway through unpacking
// the archive and does not return, leaving the executable cut short; this
// script takes the same build from the same addresses with Node.js's own
// fetch and zlib.
//
// The archive is fetched one address after another until one answers 200
// with the whole body. Each file it unpacks must equal the archive's central
// directory listing in size and CRC-32, and the files go to a new directory
// beside the build's, where the executable must exit 0 with -version. That
// directory then takes the build's place, holding the INSTALLATION_COMPLETE
// marker Playwright's own install writes, and the .links entry for this
// playwright-core is written as Playwright's install writes it, so a later
// Playwright install keeps the build. When any of that does not hold, the
// script exits 1 and the build's place is as it was. It writes in the
// Playwright cache, or under PLAYWRIGHT_BROWSERS_PATH, and nowhere else.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

export const MARKER = 'INSTALLATION_COMPLETE';
// A download that sends no data for this long is given up, as Playwright's
// own downloader gives up a silent socket.
const IDLE_MS = 30000;
const VERSION_MS = 15000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

const END_RECORD = 0x06054b50;
const CENTRAL_RECORD = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

export class InstallError extends Error {
  constructor(lines) {
    super(lines.join('\n'));
    this.lines = lines;
  }
}

const hex = (n) => n.toString(16).padStart(8, '0');

// An entry name that stays inside the directory it unpacks into: relative,
// with no empty, "." or ".." segment, no backslash and no NUL.
export function safeName(name) {
  if (typeof name !== 'string' || name === '' || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return name.replace(/\/$/, '').split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// The archive's entries, each read where its central directory record puts
// it and unpacked to the size and CRC-32 that record gives. Throws an
// InstallError naming what does not hold.
export function readArchive(buf) {
  const refuse = (why) => new InstallError([`The archive does not read as a whole zip file: ${why}.`]);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === END_RECORD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw refuse('it has no end of central directory record');
  const count = buf.readUInt16LE(end + 10);
  const listingBytes = buf.readUInt32LE(end + 12);
  const listingAt = buf.readUInt32LE(end + 16);
  if (count === 0xffff || listingBytes === 0xffffffff || listingAt === 0xffffffff) throw refuse('it is a ZIP64 archive, which this script does not read');
  if (listingAt + listingBytes > end) throw refuse(`its central directory, ${listingBytes} bytes at ${listingAt}, runs past its end record at ${end}`);
  const entries = [];
  let unpacked = 0;
  for (let k = 0, p = listingAt; k < count; k++) {
    if (p + 46 > listingAt + listingBytes || buf.readUInt32LE(p) !== CENTRAL_RECORD) throw refuse(`entry ${k + 1} of ${count} is not in its central directory`);
    const madeOnUnix = buf.readUInt16LE(p + 4) >> 8 === 3;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const packed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameBytes = buf.readUInt16LE(p + 28);
    const attrs = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameBytes);
    p += 46 + nameBytes + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (!safeName(name)) throw refuse(`entry ${JSON.stringify(name)} names a path outside the directory it unpacks into`);
    const mode = madeOnUnix ? attrs >>> 16 : 0;
    const type = mode & 0o170000;
    if (type !== 0 && type !== 0o100000 && type !== 0o040000) throw refuse(`entry ${name} is neither a file nor a directory`);
    if (name.endsWith('/') || type === 0o040000) {
      entries.push({ name: name.replace(/\/$/, ''), dir: true });
      continue;
    }
    if (flags & 1) throw refuse(`entry ${name} is encrypted`);
    if (method !== 0 && method !== 8) throw refuse(`entry ${name} uses compression method ${method}, neither stored nor deflated`);
    unpacked += size;
    if (unpacked > MAX_UNPACKED_BYTES) throw refuse(`its entries unpack to more than ${MAX_UNPACKED_BYTES} bytes`);
    if (local + 30 > listingAt || buf.readUInt32LE(local) !== LOCAL_HEADER) throw refuse(`entry ${name} has no local header at ${local}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + packed > listingAt) throw refuse(`the ${packed} bytes of entry ${name} run past the start of its central directory`);
    let data;
    try {
      const raw = buf.subarray(start, start + packed);
      data = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
    } catch (err) {
      throw refuse(`entry ${name} does not unpack to the ${size} bytes its listing gives (${err.code ?? err.message})`);
    }
    if (data.length !== size) throw refuse(`entry ${name} unpacks to ${data.length} bytes, and its listing gives ${size}`);
    const sum = zlib.crc32(data) >>> 0;
    if (sum !== crc) throw refuse(`entry ${name} has CRC-32 ${hex(sum)}, and its listing gives ${hex(crc)}`);
    entries.push({ name, dir: false, size, mode: mode & 0o777, data });
  }
  return entries;
}

const reason = (err) => (err?.cause ? `${err.message}: ${err.cause.code ?? err.cause.message}` : (err?.message ?? String(err)));

// One address's whole body, or an Error that says what came instead.
async function fetchWhole(url, { fetchImpl, idleMs }) {
  const ac = new AbortController();
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ac.abort(new Error(`no data for ${idleMs / 1000} s`)), idleMs);
  };
  let declared = null;
  let got = 0;
  arm();
  try {
    const res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow' });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const encoded = (res.headers.get('content-encoding') ?? 'identity') !== 'identity';
    declared = !encoded && res.headers.get('content-length') !== null ? Number(res.headers.get('content-length')) : null;
    const chunks = [];
    for await (const chunk of res.body) {
      arm();
      got += chunk.length;
      if (got > MAX_ARCHIVE_BYTES) throw new Error(`more than ${MAX_ARCHIVE_BYTES} bytes`);
      chunks.push(chunk);
    }
    if (declared !== null && got !== declared) throw new Error(`the body ended after ${got} of ${declared} bytes`);
    return Buffer.concat(chunks);
  } catch (err) {
    if (ac.signal.aborted) throw new Error(`${ac.signal.reason.message}, after ${got}${declared === null ? '' : ` of ${declared}`} bytes`);
    if (declared !== null && got < declared && !/^the body ended/.test(err.message)) throw new Error(`the body ended after ${got} of ${declared} bytes (${reason(err)})`);
    throw new Error(reason(err));
  } finally {
    clearTimeout(timer);
  }
}

// The archive from the earliest address in the list that gives all of it.
export async function fetchArchive(urls, { fetchImpl = globalThis.fetch, idleMs = IDLE_MS, log = () => {} } = {}) {
  const tried = [];
  for (const url of urls) {
    log(`Downloading ${url}`);
    try {
      return { url, buf: await fetchWhole(url, { fetchImpl, idleMs }) };
    } catch (err) {
      log(`  ${err.message}`);
      tried.push(`  ${url}: ${err.message}`);
    }
  }
  throw new InstallError(['No address gave the whole archive:', ...tried]);
}

// How a file answers -version: { how: null, line } when it exits 0, with the
// leading line it printed, otherwise { how } in words. A build cut short does
// not start: the kernel refuses a Mach-O file that ends early.
export function versionAnswer(file, timeoutMs = VERSION_MS) {
  const r = spawnSync(file, ['-version'], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error?.code === 'ETIMEDOUT') return { how: `does not finish within ${timeoutMs / 1000} s` };
  if (r.error) return { how: 'does not start' };
  if (r.signal) return { how: `is stopped by ${r.signal}` };
  if (r.status !== 0) return { how: `exits ${r.status}` };
  return { how: null, line: (r.stdout ?? '').split('\n')[0].trim() };
}

const fileSize = (f) => {
  try {
    const st = fs.statSync(f);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
};

// The build already at the directory: { ok: true, size } when its marker is
// there and its executable exits 0 with -version, otherwise { ok: false,
// why }, with why null when the directory does not exist.
export function buildInPlace(directory, executable) {
  if (!fs.existsSync(directory)) return { ok: false, why: null };
  const size = fileSize(executable);
  const rel = path.relative(directory, executable);
  if (size === null) return { ok: false, why: `it holds no ${rel}` };
  const v = versionAnswer(executable);
  if (v.how) return { ok: false, why: `${rel}, ${size} bytes, ${v.how} when run with -version` };
  if (!fs.existsSync(path.join(directory, MARKER))) return { ok: false, why: `it has no ${MARKER} marker` };
  return { ok: true, size };
}

// The .links entry Playwright's own install writes: a file named for the
// SHA-1 of the playwright-core package path, holding that path. The hash
// names the file and checks nothing.
function writeLink(linksDir, packagePath) {
  fs.mkdirSync(linksDir, { recursive: true });
  fs.writeFileSync(path.join(linksDir, crypto.createHash('sha1').update(packagePath).digest('hex')), packagePath);
}

// Move the staged directory into the build's place. A directory already
// there is moved aside, and back again when the move does not happen.
function place(stage, directory) {
  let aside = null;
  if (fs.existsSync(directory)) {
    aside = `${stage}-replaced`;
    fs.renameSync(directory, aside);
  }
  try {
    fs.renameSync(stage, directory);
  } catch (err) {
    if (aside) fs.renameSync(aside, directory);
    throw err;
  }
  if (aside) fs.rmSync(aside, { recursive: true, force: true });
}

// Staged directories to remove when a signal stops the script.
const staged = new Set();

// Install the build. Returns 0 when it is in place and exits 0 with
// -version; throws an InstallError otherwise, with the build's place as it
// was.
export async function install({ urls, directory, executable, linksDir, packagePath, fetchImpl = globalThis.fetch, idleMs = IDLE_MS, out = (l) => process.stdout.write(`${l}\n`) }) {
  const rel = path.relative(directory, executable);
  if (!safeName(rel.split(path.sep).join('/'))) throw new InstallError([`The executable ${executable} is not inside the build's directory ${directory}.`]);
  out(`Playwright's ffmpeg build goes to ${directory}`);
  const present = buildInPlace(directory, executable);
  if (present.ok) {
    writeLink(linksDir, packagePath);
    out(`It is in place: ${executable}, ${present.size} bytes, exits 0 with -version.`);
    return 0;
  }
  if (present.why) out(`The directory holds an incomplete build (${present.why}); a build that passes the checks below replaces it.`);
  const { url, buf } = await fetchArchive(urls, { fetchImpl, idleMs, log: out });
  const entries = readArchive(buf);
  const files = entries.filter((e) => !e.dir);
  const exe = files.find((e) => e.name === rel.split(path.sep).join('/'));
  if (!exe) throw new InstallError([`The archive from ${url} holds no ${rel}, the file playwright-core runs.`]);
  out(`${buf.length} bytes, ${files.length} files, each equal to the archive's listing in size and CRC-32: ${files.map((e) => `${e.name} ${e.size} bytes`).join(', ')}`);
  const parent = path.dirname(directory);
  fs.mkdirSync(parent, { recursive: true });
  const stage = fs.mkdtempSync(path.join(parent, `.${path.basename(directory)}-install-`));
  staged.add(stage);
  try {
    // mkdtemp makes the directory 0700; Playwright's own install leaves its
    // build directories 0755.
    fs.chmodSync(stage, 0o755);
    for (const e of entries.filter((x) => x.dir)) fs.mkdirSync(path.join(stage, e.name), { recursive: true });
    for (const e of files) {
      const to = path.join(stage, e.name);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, e.data, { mode: e.mode || 0o644 });
    }
    const stagedExe = path.join(stage, rel);
    fs.chmodSync(stagedExe, 0o755);
    const onDisk = fileSize(stagedExe);
    if (onDisk !== exe.size) throw new InstallError([`${rel} holds ${onDisk} bytes on disk, and the archive's listing gives ${exe.size}.`]);
    const v = versionAnswer(stagedExe);
    if (v.how) throw new InstallError([`${rel} from ${url}, ${onDisk} bytes, ${v.how} when run with -version, so it is not put in place.`]);
    out(`${rel} exits 0 with -version: ${v.line}`);
    fs.writeFileSync(path.join(stage, MARKER), '');
    place(stage, directory);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
    staged.delete(stage);
  }
  writeLink(linksDir, packagePath);
  out(`Installed ${executable}, ${exe.size} bytes.`);
  return 0;
}

// What the installed playwright-core's registry names for its ffmpeg build.
async function fromRegistry() {
  let m;
  try {
    m = await import('playwright-core/lib/server/registry/index');
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    throw new InstallError(['This script reads the installed playwright-core, and the clone has none. Run npm ci in the clone, then run it again.']);
  }
  const registry = m.registry ?? m.default.registry;
  const registryDirectory = m.registryDirectory ?? m.default.registryDirectory;
  let ffmpeg = null;
  try {
    ffmpeg = registry.findExecutable('ffmpeg');
  } catch {
    ffmpeg = null;
  }
  const executable = ffmpeg?.executablePath?.();
  if (!executable || !ffmpeg.downloadURLs?.length) throw new InstallError(['The installed playwright-core names no ffmpeg build for this platform.']);
  const packagePath = path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
  return { urls: ffmpeg.downloadURLs, directory: ffmpeg.directory, executable, linksDir: path.join(registryDirectory, '.links'), packagePath };
}

export async function main() {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    process.on(signal, () => {
      for (const s of staged) fs.rmSync(s, { recursive: true, force: true });
      process.exit(code);
    });
  }
  let where = null;
  try {
    where = await fromRegistry();
    return await install(where);
  } catch (err) {
    // An error of the file system, such as a cache directory this user
    // cannot write, is printed as its message, in place of a stack trace.
    const lines = err instanceof InstallError ? err.lines : [err?.message ?? String(err)];
    for (const l of lines) process.stderr.write(`${l}\n`);
    if (where) process.stderr.write(`Nothing was put in place; ${where.directory} is as it was.\n`);
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const code = await main();
  await new Promise((r) => process.stdout.write('', r));
  await new Promise((r) => process.stderr.write('', r));
  process.exit(code);
}
