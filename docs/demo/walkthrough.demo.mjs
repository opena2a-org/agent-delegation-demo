#!/usr/bin/env node
// The walkthrough capture. It starts the demo with npm start in the clone it
// sits in, drives it in the installed Chrome with real clicks and keys, and
// takes the nine stills (--stills) or the recording (--record).
//
//   node docs/demo/walkthrough.demo.mjs --stills --records <directory outside the clone>
//   node docs/demo/walkthrough.demo.mjs --record --records <directory outside the clone>
//
// Into the clone it writes capture outputs under docs/captures/ and nothing
// else: the nine stills and the npm start text (--stills), the chapter 3 GIF
// and the two caption tracks (--record). What describes them goes to
// captures/ under the records directory: each still's sidecar and proof, the
// npm start sidecar, and the recording with its sidecar. The proofs of
// stills 00 to 06 check the bank's state, read from the demo's API before the
// step and after it, and the run's records or the offline check result; the
// proof of 07 checks the page's contact address, and the proofs of 07 and 08
// compare the page's text with the copy file the demo serves. Each proof also
// compares values the page shows, such as the build in its footer, with the
// API. Outputs are staged in the run's own directory, outside the clone.
// They move into place when every proof holds, the page asked for no address
// other than 127.0.0.1, the TCP listeners of the processes under this script
// are on loopback when the page opens and again when the tour ends, and
// every file is within its limit; otherwise the run exits 1, keeps none of
// them, and leaves the files already under docs/captures/ and in the records
// directory as they were. The demo starts new processes for each run and for
// the offline check, and the listeners of processes that start and stop
// between those two samples are not checked.
//
// --record also needs Playwright's own ffmpeg build in the Playwright cache,
// which records the browser's video, and ffmpeg and ffprobe on PATH, which
// encode and measure the recording; an ffmpeg on PATH does not stand in for
// Playwright's build. The script checks for the three, and runs Playwright's
// build with -version, before it starts anything, and exits 1 with one line
// for each that is missing or, for the build, does not exit 0. Ctrl+C, or a
// SIGTERM, stops the demo the run started, removes the run's own directory
// and exits 130 or 143.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import zlib from 'node:zlib';
import { buildInfo } from '../../src/build-info.mjs';
import { fill } from '../../src/view/fill.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = 'docs/demo/walkthrough.demo.mjs';
const NARRATION = 'docs/demo/walkthrough.narration.json';
const CAPTURES = 'docs/captures';
const GIF = 'walkthrough-fake-invoice.gif';
const GIF_CHAPTER = 'Fake invoice';
const VIEWPORT = { width: 1440, height: 900 };
// The line that installs Playwright's ffmpeg build, as the README prints it.
export const FFMPEG_INSTALL = 'node scripts/install-playwright-ffmpeg.mjs';

export const SHOTS = Object.freeze([
  { slug: '00-overview', screen: 'overview', step: 's00', scenario: null },
  { slug: '01-setup', screen: 'setup', step: 's01', scenario: null },
  { slug: '02-scenario-1-normal-bill', screen: 's1', step: 's02', scenario: 1 },
  { slug: '03-scenario-2-fake-invoice', screen: 's2', step: 's04', scenario: 2 },
  { slug: '04-scenario-3-stop-one-agent', screen: 's3', step: 's05', scenario: 3 },
  { slug: '05-scenario-4-dispute', screen: 's4', step: 's07', scenario: 4 },
  { slug: '06-offline-check', screen: 'offline', step: 's08', scenario: null },
  { slug: '07-summary', screen: 'summary', step: 's09', scenario: null },
  { slug: '08-summary-limits', screen: 'summary', step: 's11', scenario: null },
]);

export const CAPS = Object.freeze({
  stillBytes: 600000, stillWidth: 2880, stillHeight: 1800,
  gifBytes: 3000000, gifSeconds: 45, gifWidth: 1100,
  recordingSeconds: 180, recordingBytesPerMinute: 6500000,
});

class Refusal extends Error {
  constructor(lines, exitCode = 2) {
    super(lines.join('\n'));
    this.lines = lines;
    this.exitCode = exitCode;
  }
}

const USAGE = 'Usage: node docs/demo/walkthrough.demo.mjs --stills|--record --records <directory outside the clone>';

// The real path of p, resolving the part of it that exists.
function realish(p) {
  let head = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(head)) {
    rest.unshift(path.basename(head));
    head = path.dirname(head);
  }
  return path.join(fs.realpathSync(head), ...rest);
}

export function parseArgs(argv, root = ROOT) {
  let mode = null;
  let records = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stills' || a === '--record') {
      if (mode) throw new Refusal(['Give one mode, --stills or --record.', USAGE]);
      mode = a.slice(2);
    } else if (a === '--records') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Refusal(['--records needs a directory outside the clone.', USAGE]);
      records = path.resolve(v);
    } else {
      throw new Refusal([`Unknown argument: ${a}`, USAGE]);
    }
  }
  if (!mode) throw new Refusal(['Give a mode, --stills or --record.', USAGE]);
  if (!records) throw new Refusal(['--records is required; it has no default.', USAGE]);
  const rel = path.relative(fs.realpathSync(root), realish(records));
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (!outside) throw new Refusal([`The records directory ${records} is inside the clone. Records never sit in the repository.`, 'Fix: pass a directory outside the clone to --records.']);
  return { mode, records };
}

// The files a mode writes: into the clone, under docs/captures/, and into
// the records directory, under captures/.
export function outputMap(mode) {
  if (mode === 'stills') {
    return {
      clone: [...SHOTS.map((s) => `${CAPTURES}/${s.slug}.png`), `${CAPTURES}/npm-start.txt`],
      records: [...SHOTS.flatMap((s) => [`captures/${s.slug}.json`, `captures/${s.slug}.proof.json`]), 'captures/npm-start.json'],
    };
  }
  if (mode === 'record') {
    return {
      clone: [`${CAPTURES}/${GIF}`, `${CAPTURES}/walkthrough.captions.vtt`, `${CAPTURES}/walkthrough.chapters.vtt`],
      records: ['captures/walkthrough.json', 'captures/walkthrough.mp4'],
    };
  }
  throw new Error(`unknown mode ${mode}`);
}

// What keeps a run's outputs out: a proof that did not hold, a request that
// left 127.0.0.1, a file over its limit. One line each.
export function problems({ proofs = [], outside = [], files = [] }) {
  const found = [];
  for (const p of proofs) {
    const failed = [...(p.assertions ?? []), ...(p.domEqualsState ?? [])].filter((r) => r.pass !== true).map((r) => r.name ?? r.field);
    if (p.ok !== true || failed.length) found.push(`${p.slug}: the proof does not hold${failed.length ? ` (${failed.join('; ')})` : ''}`);
  }
  if (outside.length) found.push(`the page asked for ${outside.length} address${outside.length === 1 ? '' : 'es'} other than 127.0.0.1: ${[...new Set(outside)].join(', ')}`);
  for (const f of files) {
    if (f.kind === 'still') {
      if (f.bytes > CAPS.stillBytes) found.push(`${f.name}: ${f.bytes} bytes, over the limit of ${CAPS.stillBytes}`);
      else if (f.widthPx !== CAPS.stillWidth || f.heightPx !== CAPS.stillHeight) found.push(`${f.name}: ${f.widthPx}x${f.heightPx} pixels, not ${CAPS.stillWidth}x${CAPS.stillHeight}`);
    } else if (f.kind === 'gif') {
      if (f.bytes > CAPS.gifBytes) found.push(`${f.name}: ${f.bytes} bytes, over the limit of ${CAPS.gifBytes}`);
      else if (f.widthPx > CAPS.gifWidth) found.push(`${f.name}: ${f.widthPx} pixels wide, over ${CAPS.gifWidth}`);
      else if (!(f.seconds <= CAPS.gifSeconds)) found.push(`${f.name}: ${f.seconds} s, over ${CAPS.gifSeconds} s`);
    } else if (f.kind === 'recording') {
      if (!(f.seconds < CAPS.recordingSeconds)) found.push(`${f.name}: ${f.seconds} s, not under ${CAPS.recordingSeconds} s`);
      else if (f.bytes > (CAPS.recordingBytesPerMinute * f.seconds) / 60) found.push(`${f.name}: ${f.bytes} bytes in ${f.seconds} s, over the limit of ${CAPS.recordingBytesPerMinute} bytes a minute`);
    }
  }
  return found;
}

// Move a run's staged outputs into place, or, when anything is wrong, keep
// none of them: the staged files are removed, and the files already under
// docs/captures/ and in the records directory, the committed captures among
// them, are left as they were.
export function settle({ mode, root, records, stage, problems: found, log = (l) => process.stderr.write(`${l}\n`) }) {
  const map = outputMap(mode);
  const want = [...map.clone.map((r) => `clone/${r}`), ...map.records.map((r) => `records/${r}`)];
  const place = (k) => (k.startsWith('clone/') ? path.join(root, k.slice(6)) : path.join(records, k.slice(8)));
  const all = [...found];
  if (all.length === 0) {
    const staged = fs.existsSync(stage)
      ? fs.readdirSync(stage, { recursive: true }).filter((f) => !fs.statSync(path.join(stage, f)).isDirectory()).map((f) => f.split(path.sep).join('/'))
      : [];
    for (const f of staged) if (!want.includes(f)) all.push(`${f}: not an output of --${mode}`);
    for (const k of want) if (!staged.includes(k)) all.push(`${k}: missing`);
  }
  if (all.length) {
    fs.rmSync(stage, { recursive: true, force: true });
    for (const l of all) log(l);
    log(`No output file of --${mode} was kept; ${CAPTURES}/ and the records directory are as they were.`);
    return 1;
  }
  for (const k of want) {
    fs.mkdirSync(path.dirname(place(k)), { recursive: true });
    fs.copyFileSync(path.join(stage, k), place(k));
  }
  fs.rmSync(stage, { recursive: true, force: true });
  return 0;
}

const isExecutable = (f) => {
  try {
    fs.accessSync(f, fs.constants.X_OK);
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

// How Playwright's build answers -version: null when it exits 0, otherwise
// what happened, in words. A build cut short does not start: the kernel
// refuses a Mach-O file that ends early, and spawn reports it as a numbered
// error that names neither ffmpeg nor the install.
function versionAnswer(file, timeoutMs = 15000) {
  const r = spawnSync(file, ['-version'], { stdio: 'ignore', timeout: timeoutMs });
  if (r.error?.code === 'ETIMEDOUT') return `does not finish within ${timeoutMs / 1000} s`;
  if (r.error) return 'does not start';
  if (r.signal) return `is stopped by ${r.signal}`;
  return r.status === 0 ? null : `exits ${r.status}`;
}

// What --record needs besides Chrome, one line for each that is missing:
// Playwright's own ffmpeg build, which records the browser's video, at the
// path the installed playwright-core's registry names (in the Playwright
// cache, or under PLAYWRIGHT_BROWSERS_PATH when it is set); and ffmpeg and
// ffprobe on PATH, which encode and measure the recording. An ffmpeg on
// PATH does not stand in for Playwright's build. A build that is there but
// does not exit 0 with -version, such as one an install left cut short, gets
// a line with its size and the install line, so the run stops here and not
// when the browser starts recording.
export async function missingForRecord({ PATH = process.env.PATH ?? '' } = {}) {
  const m = await import('playwright-core/lib/server/registry/index');
  const file = (m.registry ?? m.default.registry).findExecutable('ffmpeg')?.executablePath();
  const lines = [];
  if (!file) lines.push('--record needs Playwright\'s own ffmpeg build, and the installed playwright-core has none for this platform.');
  else if (!isExecutable(file)) lines.push(`--record needs Playwright's own ffmpeg build at ${file}, and it is not there; an ffmpeg on PATH does not stand in for it. Install it from the clone with: ${FFMPEG_INSTALL}`);
  else {
    const how = versionAnswer(file);
    if (how) lines.push(`--record needs Playwright's own ffmpeg build at ${file}, and the file there, ${fs.statSync(file).size} bytes, ${how} when run with -version. Install it again from the clone with: ${FFMPEG_INSTALL}`);
  }
  const absent = ['ffmpeg', 'ffprobe'].filter((t) => !PATH.split(path.delimiter).filter(Boolean).some((d) => isExecutable(path.join(d, t))));
  if (absent.length) lines.push(`--record needs ${absent.join(' and ')} on PATH to encode and measure the recording, and ${absent.length === 1 ? 'it is' : 'they are'} not there. Fix: install ffmpeg with its ffprobe, then run again.`);
  return lines;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Closing the browser waits for its process to end and for every process
// that holds the browser's output open. A Chrome crash handler that outlives
// the browser can hold that output open without end, so the wait has a
// limit.
const closeBrowser = (browser) => Promise.race([browser.close().catch(() => {}), sleep(15000)]);
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG' || buf.toString('latin1', 12, 16) !== 'IHDR') return { widthPx: null, heightPx: null };
  return { widthPx: buf.readUInt32BE(16), heightPx: buf.readUInt32BE(20) };
}

// A PNG's rows, unfiltered: 8-bit RGB or RGBA, not interlaced.
function pngPixels(buf) {
  const parts = [];
  for (let o = 8; o + 8 <= buf.length;) {
    const len = buf.readUInt32BE(o);
    parts.push({ type: buf.toString('latin1', o + 4, o + 8), data: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
  }
  const ihdr = parts.find((c) => c.type === 'IHDR').data;
  const [width, height, depth, color, interlace] = [ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9], ihdr[12]];
  const bpp = { 2: 3, 6: 4 }[color];
  if (depth !== 8 || !bpp || interlace !== 0) throw new Error(`unexpected PNG: depth ${depth}, colour type ${color}, interlace ${interlace}`);
  const stride = width * bpp;
  const f = zlib.inflateSync(Buffer.concat(parts.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const t = f[y * (stride + 1)];
    const src = f.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = raw.subarray(y * stride, (y + 1) * stride);
    const up = y ? raw.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = up[x];
      const c = x >= bpp ? up[x - bpp] : 0;
      const pp = a + b - c;
      const paeth = Math.abs(pp - a) <= Math.abs(pp - b) && Math.abs(pp - a) <= Math.abs(pp - c) ? a : Math.abs(pp - b) <= Math.abs(pp - c) ? b : c;
      out[x] = (src[x] + [0, a, b, (a + b) >> 1, paeth][t]) & 255;
    }
  }
  return { parts, raw, stride, height };
}

// The browser's PNG, encoded again without loss: every row stored with
// filter None and deflated at level 9, which keeps a screen of text within
// the size limit. The pixels of the two files are compared before use.
function repack(buf) {
  const { parts, raw, stride, height } = pngPixels(buf);
  const rows = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const kept = parts.filter((c) => c.type !== 'IDAT' && c.type !== 'IEND').map((c) => chunk(c.type, c.data));
  const out = Buffer.concat([buf.subarray(0, 8), ...kept, chunk('IDAT', zlib.deflateSync(rows, { level: 9, memLevel: 9 })), chunk('IEND', Buffer.alloc(0))]);
  const same = sha256(pngPixels(out).raw) === sha256(raw);
  return { png: same ? out : buf, pixelSha256: sha256(raw), repacked: same };
}

function probe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,pix_fmt,width,height', '-of', 'json', file], { encoding: 'utf8' }));
  const s = j.streams[0] ?? {};
  return { seconds: Number(j.format.duration), widthPx: s.width, heightPx: s.height, codec: s.codec_name, pixFmt: s.pix_fmt ?? null };
}

// Every process under this one and the TCP addresses each listens on.
function listeners() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }).split('\n').map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), comm: path.basename(m[3].trim()) }));
  const tree = new Set([process.pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); grew = true; }
  }
  tree.delete(process.pid);
  return rows.filter((r) => tree.has(r.pid)).map((r) => {
    let out = '';
    try { out = execFileSync('lsof', ['-nP', '-a', '-p', String(r.pid), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { out = ''; }
    return { pid: r.pid, comm: r.comm, addresses: out.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)) };
  });
}
const notLoopback = (procs) => procs.flatMap((p) => p.addresses.filter((a) => !/^(127\.0\.0\.1|\[::1\]):\d+$/.test(a)).map((a) => `${p.comm} (pid ${p.pid}) listens on ${a}, not loopback`));

// The demo, started with its one start command. Its stdout up to the Ready
// output is the npm start text capture. live holds the child from the
// moment it starts, so a stop by signal can end it.
async function startDemo(root, live) {
  if (live.signal) throw new Refusal([`Stopped by ${live.signal} before the demo started.`], 1);
  const env = { ...process.env };
  delete env.PORT;
  const child = spawn('npm', ['start'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [];
  child.stdout.on('data', (d) => out.push(d));
  child.stderr.on('data', () => {});
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  live.demo = { child, exited };
  const READY = 'Press Ctrl+C to stop.\n';
  const deadline = Date.now() + 120000;
  while (!Buffer.concat(out).toString('utf8').includes(READY)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill('SIGINT');
      throw new Refusal([`npm start did not reach its Ready line: ${JSON.stringify(Buffer.concat(out).toString('utf8'))}`], 1);
    }
    await sleep(100);
  }
  const all = Buffer.concat(out);
  const text = all.subarray(0, all.indexOf(READY) + READY.length);
  const port = Number(/Open http:\/\/127\.0\.0\.1:(\d+)\//.exec(text.toString('utf8'))[1]);
  return {
    child, text, base: `http://127.0.0.1:${port}`,
    async stop() {
      child.kill('SIGINT');
      const end = await exited;
      return { ...end, after: Buffer.concat(out).subarray(text.length).toString('utf8') };
    },
  };
}

async function api(base, route) {
  const res = await fetch(`${base}${route}`, { headers: { Accept: 'application/json' } });
  return res.status === 200 ? res.json() : null;
}

async function newContext(browser, { scale, reducedMotion, recordDir }) {
  const ctx = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: scale, colorScheme: 'light', reducedMotion,
    ...(recordDir ? { recordVideo: { dir: recordDir, size: VIEWPORT } } : {}),
  });
  ctx.outside = [];
  await ctx.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' && (u.protocol === 'http:' || u.protocol === 'ws:')) return route.continue();
    ctx.outside.push(u.origin);
    return route.abort();
  });
  return ctx;
}

const screenState = (page) => page.evaluate(() => document.querySelector('main').dataset.state);
async function settled(page) {
  await page.waitForFunction(() => ['done', 'mismatch', 'error'].includes(document.querySelector('main')?.dataset.state), null, { timeout: 240000 });
  await page.evaluate(() => document.fonts.ready);
  const s = await screenState(page);
  if (s !== 'done') throw new Refusal([`The screen at ${new URL(page.url()).pathname} ended in state ${s}: ${await page.evaluate(() => document.querySelector('main').dataset.failed ?? '')}`], 1);
}

// The screen's own strings, read from the page.
function readScreen(page) {
  return page.evaluate(() => {
    const t = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const main = document.querySelector('main');
    return {
      h1: t(main.querySelector('h1')), sub: t(main.querySelector('.sub')), answer: t(main.querySelector('.answer')),
      cols: [...main.querySelectorAll('article.col')].map((c) => ({ side: c.dataset.side, title: t(c.querySelector('.coltitle')), outcome: t(c.querySelector('.outcome')), text: t(c) })),
      footer: t(document.querySelector('.footer-prov')), text: t(main),
      limitsH2: t(main.querySelector('#limits h2')), limits: [...main.querySelectorAll('#limits li')].map((li) => ({ id: li.dataset.label, text: t(li) })),
      mailto: [...main.querySelectorAll('a[href^="mailto:"]')].map((a) => a.getAttribute('href')), pre: t(main.querySelector('#run-it-yourself pre')),
      lines: main.innerText.split('\n').filter((l) => l.trim()).length,
    };
  });
}

// The alt text, from the screen's own strings, in the caption grammar.
function altText(slug, s) {
  const stop = (x) => String(x ?? '').replace(/[.\s]+$/, '');
  if (slug === '00-overview') return `${stop(s.h1)}. ${s.answer}`;
  if (slug === '07-summary') return `${stop(s.h1)}. ${s.sub}`;
  if (slug === '08-summary-limits') {
    const head = `${stop(s.limitsH2)}. `;
    const item = s.limits[0]?.text ?? '';
    if ((head + item).length <= 160) return head + item;
    const sentence = /^.*?\.(?=\s|$)/.exec(item)?.[0] ?? item;
    return head + sentence;
  }
  const [a, b] = s.cols;
  if (slug === '06-offline-check') return `${stop(s.h1)}. Network open: ${stop(a?.outcome)}. Network blocked: ${stop(b?.outcome)}.`;
  return `${stop(s.h1)}. Path A: ${stop(a?.outcome)}. Path B: ${stop(b?.outcome)}.`;
}

const row = (name, expected, actual) => ({ name, expected, actual, pass: isDeepStrictEqual(expected, actual) });
const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const active = (st) => st.consents.filter((c) => c.status === 'active').map((c) => c.agentId).sort();
const rowsOf = (st, c) => st.ledger.filter((r) => r.customer === c);
const lastPayment = (st) => st.decisions.filter((d) => d.kind === 'payment').at(-1) ?? {};

// The bank's state before and after the step, and what the screen shows of it.
const flat = (x) => String(x ?? '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
function proofRows(slug, { before, after, records, offline, copy, labels, fills, screen, clickedAt }) {
  const A = after.customers.A;
  const B = after.customers.B;
  const a = [];
  if (slug === '00-overview' || slug === '01-setup') {
    a.push(row('Customer A balance, cents', 480000, A.balanceCents), row('Customer B balance, cents', 480000, B.balanceCents));
    a.push(row('approved payees, A and B', [3, 3], [A.payees.length, B.payees.length]), row('ledger rows', 0, after.ledger.length));
  }
  if (slug === '00-overview') a.push(row('Path B consents in force', ['demo_budget_agent'], active(after)));
  if (slug === '01-setup') {
    const c = after.consents.find((x) => x.customer === 'B' && x.agentId === 'demo_billpay_agent') ?? {};
    a.push(row('bill pay consent before the click', false, before.consents.some((x) => x.agentId === 'demo_billpay_agent')));
    a.push(row('bill pay consent status', 'active', c.status));
    a.push(row('consent payees are the approved payees', B.payees.map((p) => p.account ?? p.payeeAccount ?? Object.values(p)[1]), c.terms?.creditorAccounts));
    a.push(row('consent limit per payment', { amount: '250.00', currency: 'USD' }, c.terms?.maximumIndividualAmount));
    a.push(row('consent monthly limit', '500.00', c.terms?.periodicLimits?.[0]?.amount));
    a.push(row('consent end date present', true, Boolean(c.terms?.validToDateTime)));
    a.push(row('consent approved after the click', true, typeof c.approvedAt === 'string' && c.approvedAt >= clickedAt));
  }
  if (slug === '02-scenario-1-normal-bill') {
    for (const who of ['A', 'B']) {
      const r = rowsOf(after, who);
      a.push(row(`${who}: ledger rows`, 1, r.length), row(`${who}: payee, account, amount`, ['City Water', 'DEMO-0000-1180', 8640], [r[0]?.payeeName, r[0]?.payeeAccount, r[0]?.amountCents]));
    }
    a.push(row('balances, cents', [471360, 471360], [A.balanceCents, B.balanceCents]));
    const d = lastPayment(after);
    a.push(row('B decision', 'allowed', d.decision), row('B decision fields that did not pass', [], (d.fields ?? []).filter((f) => f.result !== 'passed').map((f) => f.field)));
  }
  if (slug === '03-scenario-2-fake-invoice') {
    const toA = rowsOf(after, 'A').filter((r) => r.payeeAccount === 'DEMO-0000-4417');
    a.push(row('A: rows to account 4417', [24000], toA.map((r) => r.amountCents)));
    a.push(row('A: payee 4417 added', true, A.payees.some((p) => JSON.stringify(p).includes('DEMO-0000-4417'))), row('A balance, cents', 447360, A.balanceCents));
    a.push(row('B: rows to account 4417', 0, rowsOf(after, 'B').filter((r) => r.payeeAccount === 'DEMO-0000-4417').length), row('B balance, cents', 471360, B.balanceCents));
    a.push(row('B payees unchanged', before.customers.B.payees, B.payees));
    const d = lastPayment(after);
    a.push(row('B decision', ['refused', 'creditorAccounts'], [d.decision, d.failingField]));
    a.push(row('B fields other than creditorAccounts', [], (d.fields ?? []).filter((f) => f.field !== 'creditorAccounts' && f.result !== 'passed').map((f) => f.field)));
  }
  if (slug === '04-scenario-3-stop-one-agent') {
    const events = (c) => after.accountLog.filter((l) => l.customer === c).map((l) => l.event);
    a.push(row('A: password changed', true, events('A').includes('password changed')), row('A: sessions in force', 0, A.activeSessions.length));
    a.push(row('A: agent sign ins refused after the change', 2, events('A').filter((e) => e === 'sign in refused').length));
    a.push(row('B: consents in force', ['demo_budget_agent'], active(after)), row('B: consent withdrawn', true, events('B').includes('consent withdrawn')));
    a.push(row('B: broker restarted for the bill pay agent', true, (records?.restarts ?? []).some((r) => r.reason === 'withdraw' && r.role === 'billpay')));
    const last = after.decisions.at(-1) ?? {};
    a.push(row('B: budget agent read after the withdrawal', ['balance', 'allowed', 'demo_budget_agent'], [last.kind, last.decision, last.agentId]));
    a.push(row('B: customer session in force', true, B.activeSessions.length > 0));
  }
  if (slug === '05-scenario-4-dispute') {
    const logA = after.accountLog.filter((l) => l.customer === 'A');
    a.push(row('A: sign in by password and payment logged', [true, true], [logA.some((l) => l.event === 'sign in' && l.method === 'password'), logA.some((l) => l.event === 'payment')]));
    a.push(row('A: log rows naming an agent', 0, logA.filter((l) => 'agentId' in l).length));
    a.push(row('B: audit log verifies', true, records?.audit?.verification?.valid));
    const water = rowsOf(after, 'B').find((r) => r.payeeAccount === 'DEMO-0000-1180') ?? {};
    a.push(row('B: water payment row names the agent and consent', ['demo_billpay_agent', true], [water.agentId, typeof water.consentId === 'string']));
    a.push(row('B: audit entries naming the bill pay agent', true, (records?.audit?.entries ?? []).some((e) => e.agentId === 'demo_billpay_agent')));
    a.push(row('B: scenario 2 refusal on record', true, after.decisions.some((d) => d.decision === 'refused' && d.failingField === 'creditorAccounts')));
  }
  if (slug === '06-offline-check') {
    a.push(row('offline check measured', 'measured', offline?.status));
    a.push(row('outbound attempts: grant path rerun, password path runs', [0, 0], [offline?.egressAttempts, offline?.openRun?.egress?.egressAttempts]));
    a.push(row('control attempt to 192.0.2.1 counted once and refused', ['192.0.2.1 port 9', 1, true], [offline?.decision2?.target, offline?.decision2?.lines, offline?.decision2?.pass]));
    a.push(row('every control passes', true, (offline?.controls ?? []).length > 0 && offline.controls.every((c) => c.pass === true)));
    a.push(row('four grant path decisions, the same as the open run', [4, true], [(offline?.outcomes ?? []).filter((o) => o.same === true).length, offline?.allSame]));
  }
  if (slug === '07-summary') {
    const cta = copy.SCREENS.find((s) => s.id === 'summary').cta;
    a.push(row('contact address', ['mailto:info@opena2a.org?subject=agent%20channel'], [...new Set(screen.mailto)]));
    a.push(row('run it yourself block, clone URL included', flat(cta.selfCode.map((x) => fill(x, fills)).join(' ')), screen.pre));
  }
  if (slug === '08-summary-limits') {
    const items = copy.SCREENS.find((s) => s.id === 'summary').limits.items;
    a.push(row('limits items on screen', items.length, screen.limits.length));
    const byId = new Map(labels.map((l) => [l.id, l.text]));
    a.push(row('labelled limits items whose text differs from the label', [], screen.limits.filter((l) => l.id && flat(byId.get(l.id)) !== l.text).map((l) => l.id)));
  }
  return a;
}

function domRows(slug, { screen, build, after, runId }) {
  const d = [];
  const shown = /Build ([0-9a-f]{7})/.exec(screen.footer ?? '');
  d.push({ field: 'footer build', dom: shown ? shown[0] : screen.footer, state: build.fromGit && !build.modified ? `Build ${build.sha7}` : null, pass: Boolean(shown) && build.fromGit && !build.modified && shown[1] === build.sha7 && !/modified/i.test(screen.footer) });
  if (slug !== '00-overview') d.push({ field: 'footer run', dom: screen.footer, state: runId.slice(0, 4), pass: new RegExp(`\\b${runId.slice(0, 4)}\\b`).test(screen.footer ?? '') });
  if (/^0[23]-/.test(slug)) {
    for (const col of screen.cols) {
      const cents = after.customers[col.side]?.balanceCents;
      if (cents === undefined) continue;
      d.push({ field: `${col.side} balance`, dom: col.text.includes(usd(cents)) ? usd(cents) : null, state: usd(cents), pass: col.text.includes(usd(cents)) });
    }
  }
  if (slug === '03-scenario-2-fake-invoice') {
    const b = screen.cols.find((c) => c.side === 'B');
    d.push({ field: 'B failing field', dom: b?.text.includes('creditorAccounts') ? 'creditorAccounts' : null, state: lastPayment(after).failingField, pass: Boolean(b?.text.includes(lastPayment(after).failingField)) });
  }
  return d;
}

// The presenter order: each step's screen, how it is reached and its action.
// act(step) performs the step's action with real input and returns when the
// screen has settled.
async function tour(page, base, { act, at, faults }) {
  const nav = async (fn, route) => { await fn(); await page.waitForURL(`${base}${route}`); await page.waitForFunction(() => document.querySelector('main')?.dataset.state !== 'loading'); };
  const task = (action) => page.locator(`main section.task [data-action="${action}"]`).nth(0);
  await page.goto(`${base}/`);
  await settled(page);
  if (faults.page) await faults.page(page);
  await at('s00', null);
  await nav(() => act.click(page.locator('main a[data-action="next"]').nth(0)), '/setup');
  await at('s01', () => act.click(page.locator('main [data-action="run"]').nth(0)));
  await nav(() => act.key('ArrowRight'), '/scenario/1');
  await at('s02', () => act.click(task('run')));
  await nav(() => act.click(task('next')), '/scenario/2');
  await at('s03', () => act.hover(page.locator('main .hiddenline').nth(0)), false);
  await at('s04', () => act.click(task('run')));
  await nav(() => act.click(task('next')), '/scenario/3');
  await at('s05', () => act.click(task('run')));
  await at('s06', () => act.hover(page.locator('main article.col[data-side="B"]').nth(0)), false);
  await nav(() => act.click(task('next')), '/scenario/4');
  await at('s07', () => act.click(task('run')));
  await nav(() => act.click(task('next')), '/offline');
  await at('s08', () => act.click(task('run')));
  await nav(() => act.click(task('next')), '/summary');
  await at('s09', null);
  await at('s10', () => act.hover(page.locator('main a[href^="mailto:"]').nth(0)), false);
  await at('s11', () => act.scrollTo(page.locator('#limits')), false);
}

function vttTime(s) {
  const ms = Math.round(s * 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
}

function vtt(cues) {
  return `WEBVTT\n\n${cues.map((c) => `${c.id}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}\n`).join('\n')}`;
}

// Ctrl+C, or a SIGTERM, while a run is under way: the demo the run started
// is stopped and waited for, the browser is closed, and the run's own
// directory, and nothing else, is removed; the script then exits 128 plus
// the signal's number, 130 or 143. The clone and the records directory are
// left as they were. A second signal does not wait for the demo or the
// browser. Returns the function that takes the handlers off again.
function stopOnSignals(live) {
  const leave = (signal) => {
    if (live.runDir) fs.rmSync(live.runDir, { recursive: true, force: true });
    process.exit(128 + os.constants.signals[signal]);
  };
  const onSignal = (signal) => {
    if (live.signal) return leave(signal);
    live.signal = signal;
    process.stderr.write(`Stopped by ${signal}: stopping the demo this run started and removing the run's own directory. No output file is kept.\n`);
    live.stopped = (async () => {
      try {
        const stopAll = async () => {
          if (live.demo) {
            live.demo.child.kill('SIGINT');
            await live.demo.exited;
          }
          if (live.browser) await closeBrowser(live.browser);
        };
        await Promise.race([stopAll(), sleep(30000)]);
      } finally {
        leave(signal);
      }
    })();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return () => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
}

// One run, in a directory of its own outside the clone that holds the
// staged outputs, the browser's video and the GIF before it is measured.
// The directory is removed when the run ends, whatever the outcome, and on
// Ctrl+C or a SIGTERM; the handlers are on before it is made.
async function capture(mode, { root, records, faults }) {
  const build = buildInfo(root);
  if (!build.fromGit || build.modified) throw new Refusal([`The clone's build is ${build.fromGit ? 'modified' : 'not from a git clone'}; captures are taken from an unmodified clone.`, 'Fix: run from a fresh clone of the commit to capture.'], 1);
  const live = { signal: null, stopped: null, runDir: null, demo: null, browser: null };
  const offSignals = stopOnSignals(live);
  try {
    live.runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-run-')));
    return await takeCaptures(mode, { root, records, faults, build, live });
  } finally {
    if (live.runDir) fs.rmSync(live.runDir, { recursive: true, force: true });
    offSignals();
    // A stop by signal ends the process itself, once the demo has stopped.
    if (live.stopped) await live.stopped;
  }
}

async function takeCaptures(mode, { root, records, faults, build, live }) {
  const builtFrom = git(root, ['rev-parse', 'HEAD']);
  const scriptSha256 = sha256(fs.readFileSync(path.join(root, SCRIPT)));
  const narration = JSON.parse(fs.readFileSync(path.join(root, NARRATION), 'utf8'));
  const stage = path.join(live.runDir, 'stage');
  fs.mkdirSync(stage);
  const put = (where, rel, buf) => {
    const out = faults.bytes ? faults.bytes(path.basename(rel), buf) : buf;
    fs.mkdirSync(path.dirname(path.join(stage, where, rel)), { recursive: true });
    fs.writeFileSync(path.join(stage, where, rel), out);
    return out;
  };
  const found = [];
  const files = [];
  const proofs = [];
  let outside = [];
  const { chromium } = await import('playwright-core');
  const ranAtUtc = new Date().toISOString();
  let demo = null;
  let browser = null;
  let recordDir = null;
  let procs = [];
  try {
    demo = await startDemo(root, live);
    const launcherLine = demo.text.toString('utf8').split('\n').find((l) => l !== '' && !l.startsWith('> '));
    if (launcherLine !== `Agent banking delegation demo, build ${build.sha7}`) found.push(`npm start printed "${launcherLine}", not the unmodified build ${build.sha7}`);
    // Headless Chrome records frames the height of its window, not of the
    // emulated viewport: a window of another size leaves a grey band where
    // the bottom of the screen should be. Playwright's own SIGINT and
    // SIGTERM handlers are off: its SIGINT handler exits once the browser
    // has closed, before this script has stopped the demo and removed its
    // run directory, and its SIGTERM handler closes the browser and leaves
    // the run going.
    browser = await chromium.launch({ channel: 'chrome', headless: true, handleSIGINT: false, handleSIGTERM: false, args: [`--window-size=${VIEWPORT.width},${VIEWPORT.height}`] });
    live.browser = browser;
    const chromeVersion = browser.version();
    recordDir = mode === 'record' ? path.join(live.runDir, 'video') : null;
    if (recordDir) fs.mkdirSync(recordDir);
    const ctx = await newContext(browser, mode === 'stills' ? { scale: 2, reducedMotion: 'reduce' } : { scale: 1, reducedMotion: 'no-preference', recordDir });
    const { copy, labels, fills } = await api(demo.base, '/api/copy');
    const t0 = performance.now();
    const page = await ctx.newPage();
    procs = listeners();
    if (mode === 'stills') {
      const shots = new Map(SHOTS.map((s) => [s.step, s]));
      const act = {
        click: (l) => l.click(), key: (k) => page.keyboard.press(k), hover: async () => {},
        scrollTo: async (l) => { const box = await l.boundingBox(); await page.mouse.move(720, 450); await page.mouse.wheel(0, box.y); await page.waitForFunction(() => Math.abs(document.querySelector('#limits').getBoundingClientRect().top) < 2 || window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1); },
      };
      await tour(page, demo.base, {
        act, faults,
        at: async (step, action, waits = true) => {
          const shot = shots.get(step);
          const beforeState = await api(demo.base, '/api/state');
          const clickedAt = new Date().toISOString();
          if (action) { await action(); if (waits) await settled(page); }
          if (!shot) return;
          const { png, pixelSha256, repacked } = repack(await page.screenshot({ type: 'png', scale: 'device', animations: 'disabled', caret: 'hide' }));
          const screen = await readScreen(page);
          const st = await api(demo.base, '/api/state');
          const after = faults.state ? faults.state(shot.slug, st.state) : st.state;
          const [records, offline, apiBuild] = await Promise.all([api(demo.base, '/api/records'), api(demo.base, '/api/offline'), api(demo.base, '/api/build')]);
          const assertions = proofRows(shot.slug, { before: beforeState.state, after, records, offline, copy, labels, fills, screen, clickedAt });
          const domEqualsState = domRows(shot.slug, { screen, build: apiBuild.build, after, runId: st.runId });
          const ok = [...assertions, ...domEqualsState].every((r) => r.pass === true);
          const proof = {
            slug: shot.slug, scenario: shot.scenario, buildSha: builtFrom, runId: st.runId, ranAtUtc: new Date().toISOString(),
            before: { runId: beforeState.runId, state: beforeState.state }, after: { runId: st.runId, state: after, records, offline },
            assertions, domEqualsState, ok,
            summary: `${assertions.filter((r) => r.pass).length} of ${assertions.length} bank state rows and ${domEqualsState.filter((r) => r.pass).length} of ${domEqualsState.length} screen values hold`,
          };
          proofs.push(proof);
          const proofBuf = Buffer.from(`${JSON.stringify(proof, null, 2)}\n`);
          const still = put('clone', `${CAPTURES}/${shot.slug}.png`, png);
          const size = pngSize(still);
          files.push({ name: `${shot.slug}.png`, kind: 'still', bytes: still.length, ...size });
          const alt = altText(shot.slug, screen);
          if (alt.length > 160) found.push(`${shot.slug}: alt text is ${alt.length} characters, over 160`);
          put('records', `captures/${shot.slug}.proof.json`, proofBuf);
          const sidecar = {
            image: {
              file: `${shot.slug}.png`, sha256: sha256(still), bytes: still.length, ...size, viewport: '1440x900', deviceScale: 2, colorScheme: 'light', reducedMotion: 'reduce',
              chromeVersion, script: SCRIPT, scriptSha256, stepId: step, builtFrom, modified: build.modified, ranAtUtc: proof.ranAtUtc,
              route: new URL(page.url()).pathname + (shot.slug === '08-summary-limits' ? '#limits' : ''), proof: `${shot.slug}.proof.json`, proofSha256: sha256(proofBuf),
              ariaSnapshot: await page.locator('main').ariaSnapshot(), alt, footer: screen.footer, pixelSha256,
              encoding: repacked ? 'the browser screenshot, rows stored with filter None and deflated at level 9; pixels unchanged' : 'the browser screenshot as taken',
            },
            // The alt also sits at the top level, beside image.
            alt,
          };
          put('records', `captures/${shot.slug}.json`, Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`));
        },
      });
    } else {
      const steps = [];
      let mouse = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };
      const glide = async (l) => {
        const box = await l.boundingBox();
        const to = { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 40) };
        for (let i = 1; i <= 25; i++) { await page.mouse.move(mouse.x + ((to.x - mouse.x) * i) / 25, mouse.y + ((to.y - mouse.y) * i) / 25); await sleep(24); }
        mouse = to;
      };
      const act = {
        click: async (l) => { await glide(l); await sleep(300); await l.click(); },
        key: (k) => page.keyboard.press(k),
        hover: glide,
        scrollTo: async (l) => { const box = await l.boundingBox(); for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, box.y / 20); await sleep(30); } },
      };
      await ctx.addInitScript(() => {
        const add = () => {
          if (document.getElementById('walkthrough-cursor')) return;
          const c = document.createElement('div');
          c.id = 'walkthrough-cursor';
          c.setAttribute('aria-hidden', 'true');
          Object.assign(c.style, { position: 'fixed', left: '-10px', top: '-10px', width: '20px', height: '20px', borderRadius: '50%', background: 'rgba(6, 182, 212, 0.85)', boxShadow: '0 0 0 2px #0e7490', pointerEvents: 'none', zIndex: '2147483647', transform: 'translate(-100px, -100px)' });
          document.documentElement.appendChild(c);
          addEventListener('mousemove', (e) => { c.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, true);
          addEventListener('mousedown', (e) => {
            const r = document.createElement('div');
            Object.assign(r.style, { position: 'fixed', left: `${e.clientX - 18}px`, top: `${e.clientY - 18}px`, width: '36px', height: '36px', borderRadius: '50%', border: '2px solid #0e7490', pointerEvents: 'none', zIndex: '2147483646' });
            document.documentElement.appendChild(r);
            setTimeout(() => r.remove(), 300);
          }, true);
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
      });
      const byId = new Map(narration.steps.map((s) => [s.id, s]));
      const now = () => (performance.now() - t0) / 1000;
      // A wait for a run longer than 1.5 s is cut down to one second of its
      // running state, so the length of the recording does not depend on
      // how fast the machine starts the demo's processes; the sidecar names
      // each cut and sets waitsShortened.
      const cuts = [];
      let lines = 0;
      let lastPath = null;
      await tour(page, demo.base, {
        act, faults,
        at: async (step, action, waits = true) => {
          const pathNow = new URL(page.url()).pathname;
          if (pathNow !== lastPath) { lines = 0; lastPath = pathNow; await page.mouse.move(mouse.x, mouse.y); }
          const startSeconds = now();
          if (action) {
            await action();
            const from = now();
            if (waits) await settled(page);
            const to = now();
            if (waits && to - from > 1.5) cuts.push({ step, fromSeconds: from + 1, toSeconds: to - 0.3 });
          }
          const screen = await readScreen(page);
          const ariaSnapshot = await page.locator('main').ariaSnapshot();
          const newLines = Math.max(0, screen.lines - lines);
          lines = screen.lines;
          const n = byId.get(step);
          const hold = Math.min(12, Math.max(3, n.holdSeconds, newLines / 4));
          await sleep(hold * 1000);
          steps.push({ id: step, screen: n.screen, chapter: n.chapter, route: pathNow, startSeconds, holdSeconds: Number(hold.toFixed(2)), newLines, footer: screen.footer, ariaSnapshot });
        },
      });
      // The recording runs from the overview on screen to the end of the
      // last hold: the blank page before it and the close after it are cut.
      const lead = steps[0].startSeconds;
      const tail = now();
      const kept = [];
      let from = lead;
      for (const c of cuts) { kept.push([from, c.fromSeconds]); from = c.toSeconds; }
      kept.push([from, tail]);
      const onVideo = (raw) => kept.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(raw, b) - a), 0);
      for (const st of steps) st.startSeconds = Number(onVideo(st.startSeconds).toFixed(3));
      procs = [...procs, ...listeners()];
      const video = page.video();
      await page.close();
      await ctx.close();
      outside = ctx.outside;
      const webm = await video.path();
      const mp4 = path.join(stage, 'encode.mp4');
      const graph = `${kept.map(([a, b], i) => `[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[k${i}]`).join(';')};${kept.map((_, i) => `[k${i}]`).join('')}concat=n=${kept.length}:v=1:a=0[v]`;
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', webm, '-filter_complex', graph, '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', '25', '-movflags', '+faststart', mp4]);
      const mp4Buf = put('records', 'captures/walkthrough.mp4', fs.readFileSync(mp4));
      fs.rmSync(mp4);
      const m = probe(path.join(stage, 'records/captures/walkthrough.mp4'));
      files.push({ name: 'walkthrough.mp4', kind: 'recording', bytes: mp4Buf.length, ...m });
      if (m.codec !== 'h264' || m.pixFmt !== 'yuv420p' || m.widthPx !== VIEWPORT.width || m.heightPx !== VIEWPORT.height) found.push(`walkthrough.mp4: ${m.codec} ${m.pixFmt} ${m.widthPx}x${m.heightPx}, not h264 yuv420p 1440x900`);
      const ends = steps.map((s, i) => (i + 1 < steps.length ? steps[i + 1].startSeconds : m.seconds));
      const captions = vtt(steps.map((s, i) => ({ id: s.id, start: s.startSeconds, end: ends[i], text: byId.get(s.id).text })));
      const chapters = [];
      for (const [i, s] of steps.entries()) {
        if (chapters.at(-1)?.title === s.chapter) chapters.at(-1).end = ends[i];
        else chapters.push({ id: `chapter-${chapters.length + 1}`, title: s.chapter, start: s.startSeconds, end: ends[i], steps: [] });
        chapters.at(-1).steps.push(s.id);
      }
      const capBuf = put('clone', `${CAPTURES}/walkthrough.captions.vtt`, Buffer.from(captions));
      const chapBuf = put('clone', `${CAPTURES}/walkthrough.chapters.vtt`, Buffer.from(vtt(chapters.map((c) => ({ ...c, text: c.title })))));
      const ch = chapters.find((c) => c.title === GIF_CHAPTER);
      const gifTmp = path.join(live.runDir, 'walkthrough.gif');
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(ch.start), '-t', String(ch.end - ch.start), '-i', path.join(stage, 'records/captures/walkthrough.mp4'), '-vf', `fps=8,scale=${CAPS.gifWidth}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`, '-loop', '0', gifTmp]);
      const gifBuf = put('clone', `${CAPTURES}/${GIF}`, fs.readFileSync(gifTmp));
      fs.rmSync(gifTmp);
      const g = probe(path.join(stage, 'clone', CAPTURES, GIF));
      files.push({ name: GIF, kind: 'gif', bytes: gifBuf.length, widthPx: g.widthPx, heightPx: g.heightPx, seconds: g.seconds });
      const sidecar = {
        video: {
          file: 'walkthrough.mp4', sha256: sha256(mp4Buf), bytes: mp4Buf.length, widthPx: m.widthPx, heightPx: m.heightPx, durationSeconds: m.seconds, codec: m.codec, pixFmt: m.pixFmt, faststart: true,
          viewport: '1440x900', deviceScale: 1, colorScheme: 'light', reducedMotion: 'no-preference', chromeVersion, ffmpeg: execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0],
          script: SCRIPT, scriptSha256, builtFrom, modified: build.modified, ranAtUtc, narration: NARRATION, narrationSha256: sha256(fs.readFileSync(path.join(root, NARRATION))), waitsShortened: cuts.length > 0,
          cuts: cuts.map((c) => ({ step: c.step, fromSeconds: Number((c.fromSeconds - lead).toFixed(3)), removedSeconds: Number((c.toSeconds - c.fromSeconds).toFixed(3)) })),
          steps, chapters: chapters.map(({ id, title, start, end, steps: s }) => ({ id, title, startSeconds: start, endSeconds: Number(end.toFixed(3)), steps: s })),
          gif: { file: GIF, chapter: GIF_CHAPTER, sha256: sha256(gifBuf), bytes: gifBuf.length, widthPx: g.widthPx, heightPx: g.heightPx, durationSeconds: g.seconds },
          tracks: [{ file: 'walkthrough.captions.vtt', kind: 'captions', label: 'Narration', srclang: 'en', sha256: sha256(capBuf) }, { file: 'walkthrough.chapters.vtt', kind: 'chapters', sha256: sha256(chapBuf) }],
          capturedSeconds: { from: Number(lead.toFixed(3)), to: Number(tail.toFixed(3)) }, requestsOutside: outside.length, listeners: procs,
        },
      };
      put('records', 'captures/walkthrough.json', Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`));
    }
    if (mode === 'stills') {
      procs = [...procs, ...listeners()];
      await ctx.close();
      outside = ctx.outside;
    }
  } catch (err) {
    found.push(err instanceof Refusal ? err.lines.join(' ') : String(err.stack ?? err));
  } finally {
    if (browser) await closeBrowser(browser);
    if (recordDir) fs.rmSync(recordDir, { recursive: true, force: true });
  }
  if (!demo) return settle({ mode, root, records, stage, problems: found });
  const stopped = await demo.stop();
  if (stopped.after !== 'Stopped.\n') found.push(`npm start printed ${JSON.stringify(stopped.after)} after Ctrl+C, not "Stopped."`);
  found.push(...notLoopback(procs));
  if (mode === 'stills' && found.length === 0) {
    const txt = put('clone', `${CAPTURES}/npm-start.txt`, demo.text);
    const side = {
      text: {
        file: 'npm-start.txt', sha256: sha256(txt), bytes: txt.length, command: 'npm start', capturedThrough: 'Press Ctrl+C to stop.', afterCtrlC: stopped.after, exit: { code: stopped.code, signal: stopped.signal },
        builtFrom, modified: build.modified, ranAtUtc, script: SCRIPT, scriptSha256, node: process.version, npm: execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim(), platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        listeners: procs,
      },
    };
    put('records', 'captures/npm-start.json', Buffer.from(`${JSON.stringify(side, null, 2)}\n`));
  }
  found.push(...problems({ proofs, outside, files }));
  if (live.signal) found.push(`stopped by ${live.signal} before the run ended`);
  return settle({ mode, root, records, stage, problems: found });
}

// faults are for the tests of failing closed, and the command line never
// sets them: each changes one input of a real run (the bank state a proof
// reads, a request the page makes, the bytes of an output) so a test can see
// the run exit 1, keep no output file and leave the committed captures as
// they were.
export async function run({ argv = process.argv.slice(2), root = ROOT, faults = {} } = {}) {
  try {
    const { mode, records } = parseArgs(argv, root);
    if (mode === 'record') {
      const missing = await missingForRecord();
      if (missing.length) throw new Refusal(missing, 1);
    }
    const code = await capture(mode, { root, records, faults });
    if (code === 0) process.stdout.write(`--${mode}: ${outputMap(mode).clone.length} files in ${CAPTURES}/, ${outputMap(mode).records.length} in ${path.join(records, 'captures')}/\n`);
    return code;
  } catch (err) {
    if (err instanceof Refusal) {
      for (const l of err.lines) process.stderr.write(`${l}\n`);
      return err.exitCode;
    }
    process.stderr.write(`${err.stack ?? err}\n`);
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const code = await run();
  // A process outside the run, such as a Chrome crash handler that outlives
  // the browser, can hold one of this process's handles open; the script
  // exits once its own output is written instead of waiting on it.
  await new Promise((r) => process.stdout.write('', r));
  await new Promise((r) => process.stderr.write('', r));
  process.exit(code);
}
