// Checks of README.md against the sources it repeats: the summary screen's
// Run it yourself block and limits list, the pin file, the lockfile and the
// committed captures' sidecars. Each check takes the README's text, so a
// test can hand it a changed copy and see the check fail. Each returns a
// list of problems; empty is a pass.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { COPY, FILLS, label } from '../../src/scenarios/labels.mjs';
import { fill } from '../../src/view/fill.mjs';

const read = (rel) => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
export const README = () => read('README.md');
export const PACKAGE = JSON.parse(read('package.json'));
export const PINS = JSON.parse(read('vendor/pins.json'));
export const SUMMARY = COPY.SCREENS.find((s) => s.id === 'summary');

// The fills the view server gives the summary screen.
export const VIEW_FILLS = Object.freeze({ ...FILLS, startCommand: PACKAGE.scripts && PACKAGE.scripts.start ? 'npm start' : null });

// The summary's limits items as the screen prints them: a binding label by
// its printable words, any other item with its fills in place.
export function screenLimits() {
  return SUMMARY.limits.items.map((item) => {
    const id = Object.keys(COPY.LABELS).find((k) => COPY.LABELS[k] === item);
    if (!id) return fill(item, VIEW_FILLS);
    const l = label(id);
    return l.printable ? l.text : null;
  });
}

const FENCE = /^(```|~~~)/;

// Every fenced block: { open, close, info, lines } with 0-based line indexes.
export function fencedBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(```|~~~)(.*)$/.exec(lines[i]);
    if (!m) continue;
    const close = lines.findIndex((l, k) => k > i && l === m[1]);
    if (close < 0) { blocks.push({ open: i, close: -1, info: m[2], lines: lines.slice(i + 1) }); break; }
    blocks.push({ open: i, close, info: m[2], lines: lines.slice(i + 1, close) });
    i = close;
  }
  return blocks;
}

// The Run it yourself block: the README's earliest fenced block is an `sh`
// block whose lines, joined with LF, are the summary's selfCode after fills;
// it closes at line 30 or above; the start script exists; no line tells a
// reader to run npm install; the file has LF line ends and no CR.
export function blockEquality(text, { pkg = PACKAGE } = {}) {
  const problems = [];
  if (text.includes('\r')) problems.push('README.md carries a CR');
  const top = fencedBlocks(text.replace(/\r/g, ''))[0];
  if (!top) return [...problems, 'no fenced block'];
  if (top.info !== 'sh') problems.push(`the earliest fenced block is "${top.info}", not the sh block`);
  const expected = SUMMARY.cta.selfCode.map((l) => fill(l, VIEW_FILLS)).join('\n');
  if (top.lines.join('\n') !== expected) problems.push(`the earliest fenced block differs from selfCode: ${JSON.stringify(top.lines)}`);
  if (top.close < 0 || top.close + 1 > 30) problems.push(`the earliest fenced block closes at line ${top.close + 1}, after line 30`);
  if (!(pkg.scripts && pkg.scripts.start)) problems.push('package.json has no start script');
  if (/npm install/.test(text)) problems.push('README.md tells a reader to run npm install');
  return problems;
}

// The requirements line: the ruled pattern, with the
// platform named by its product version and its architecture, the walk
// record's `sw_vers -productVersion` and `uname -m` values.
export const REQUIREMENTS = /^Requirements: macOS, git, Node\.js 22\.12\.0 or later and a browser\. Checked on macOS [0-9.]+ (arm64|x86_64) with Node\.js [0-9.]+ in Chrome [0-9.]+, [0-9]{4}-[0-9]{2}-[0-9]{2}\.$/;
export const READY = /^Ready\. Open http:\/\/127\.0\.0\.1:[0-9]+\/ in a browser\.$/;

// The committed captures' sidecars sit in the records directory, outside the
// clone; test/fixtures/capture-sidecars.json keeps, for each file under
// docs/captures/ a sidecar describes, the sha256 and the Chrome version the
// sidecar records.
export const CAPTURE_SIDECARS = JSON.parse(read('test/fixtures/capture-sidecars.json'));
const fileSha256 = (rel) => crypto.createHash('sha256').update(fs.readFileSync(new URL(`../../${rel}`, import.meta.url))).digest('hex');

// The files under docs/captures/ that the browser's runs describe in a
// sidecar: the stills, the GIF and its two tracks. The sidecar of
// npm-start.txt records no browser.
export function browserCaptures() {
  return fs.readdirSync(new URL('../../docs/captures/', import.meta.url)).filter((f) => /\.(png|gif|vtt)$/.test(f)).sort().map((f) => `docs/captures/${f}`);
}

// The requirements line's Chrome version against the captures' sidecars:
// every file the browser's runs describe has a row, each row's sha256 is the
// committed file's, the rows name one Chrome version, and the requirements
// line names that version.
export function captureChrome(text, { rows = CAPTURE_SIDECARS.rows, files = browserCaptures(), hashOf = fileSha256 } = {}) {
  const problems = [];
  const named = rows.map((r) => r.file);
  for (const f of files) if (!named.includes(f)) problems.push(`${f} has no sidecar row`);
  for (const r of rows) {
    const sum = files.includes(r.file) ? hashOf(r.file) : null;
    if (sum !== r.sha256) problems.push(`${r.file}: ${sum === null ? 'not under docs/captures' : `sha256 ${sum}`}, and its sidecar row records ${r.sha256}; rewrite the row from the new ${r.sidecar}`);
  }
  const versions = [...new Set(rows.map((r) => r.chromeVersion))];
  if (versions.length !== 1) problems.push(`the sidecar rows name ${versions.length} Chrome versions: ${versions.join(', ')}`);
  const line = text.split('\n').find((l) => REQUIREMENTS.test(l));
  const chrome = line ? / in Chrome ([0-9.]+), /.exec(line)?.[1] : null;
  if (!chrome) problems.push('no requirements line names a Chrome version');
  else if (versions.length === 1 && chrome !== versions[0]) problems.push(`the requirements line names Chrome ${chrome}, and the captures' sidecars name ${versions[0]}`);
  return problems;
}

// The start block pin: no lead sentence before the four lines.
// A1 the last non-empty line above the earliest sh fence is the requirements
// line; A2 the line above it is empty; A3 no sentence of the summary's
// selfLead appears in the README; A4 the capture, the next fenced block
// after the sh block, shows the Ready line once.
export function startBlockPin(text) {
  const fails = [];
  const lines = text.split('\n');
  const fence = lines.findIndex((l) => /^(```|~~~)sh$/.test(l));
  if (fence < 0) return ['A1'];
  let j = fence - 1;
  while (j >= 0 && lines[j] === '') j--;
  if (j < 0 || !REQUIREMENTS.test(lines[j])) fails.push('A1');
  else if (j < 1 || lines[j - 1] !== '') fails.push('A2');
  const sentences = SUMMARY.cta.selfLead.split(/(?<=\.)\s+(?=[A-Z])/).map((s) => s.trim());
  if (sentences.some((s) => text.includes(s))) fails.push('A3');
  const close = lines.findIndex((l, k) => k > fence && /^(```|~~~)$/.test(l));
  const open2 = lines.findIndex((l, k) => k > close && FENCE.test(l));
  const close2 = lines.findIndex((l, k) => k > open2 && /^(```|~~~)$/.test(l));
  const capture = open2 > 0 && close2 > open2 ? lines.slice(open2 + 1, close2) : [];
  if (capture.filter((l) => READY.test(l)).length !== 1) fails.push('A4');
  return fails;
}

// The capture block: the fenced block that follows the sh block.
export function captureBlock(text) {
  const blocks = fencedBlocks(text);
  const sh = blocks.findIndex((b) => b.info === 'sh');
  return sh >= 0 && blocks[sh + 1] ? blocks[sh + 1] : null;
}

// The limits section, from its heading to the end of the file.
export function limitsSection(text) {
  const lines = text.split('\n');
  const start = lines.indexOf(`## ${SUMMARY.limits.h2}`);
  return start < 0 ? null : lines.slice(start).join('\n');
}

// The limits mirror: the README's last level 2 heading is the summary's
// limits heading, its top-level items equal the screen's items after fills
// in order and count, and every other line of the section is blank or
// indented.
export function limitsMirror(text, expected = screenLimits()) {
  const problems = [];
  const lines = text.split('\n');
  const h2 = lines.map((l, i) => [l, i]).filter(([l]) => /^## /.test(l));
  const last = h2.at(-1);
  if (!last || last[0] !== `## ${SUMMARY.limits.h2}`) {
    problems.push(`the last level 2 heading is ${JSON.stringify(last ? last[0] : null)}, not the limits heading`);
    return problems;
  }
  if (lines.slice(last[1] + 1).some((l) => /^# /.test(l))) problems.push('a level 1 heading follows the limits heading');
  const body = lines.slice(last[1] + 1);
  const items = body.filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
  for (const l of body) if (l !== '' && !l.startsWith('- ') && !l.startsWith('  ')) problems.push(`a line in the limits section is neither blank, an item nor indented: ${JSON.stringify(l.slice(0, 60))}`);
  if (items.length !== expected.length) problems.push(`${items.length} items, screen has ${expected.length}`);
  expected.forEach((e, i) => {
    if (e === null) problems.push(`screen item ${i + 1} is not printable`);
    else if (items[i] !== e) problems.push(`item ${i + 1} differs`);
  });
  return problems;
}

// The README's architecture sentence on the broker build, and the 5f form
// it becomes when the dependency is an exact npm version.
export function brokerWords(pkg = PACKAGE, pins = PINS) {
  const dep = pkg.dependencies['secretless-ai'];
  if (dep.startsWith('file:vendor/')) {
    return { form: 'unreleased', sentence: `The bank's broker is an unreleased local build of the AAP reference implementation from \`secretless-ai\` at commit \`${pins.secretlessAi.commit}\`: npm does not serve these bytes, and they carry no provenance attestation. [\`vendor/VENDORED.md\`](vendor/VENDORED.md) gives the commands that rebuild them.` };
  }
  return { form: 'released', sentence: `The bank's broker is the AAP reference implementation from \`secretless-ai\` ${dep}, installed from npm with its provenance attestation checked by \`npm audit signatures\`.` };
}

// The paths the README names and the tree lacks. A named path is a token,
// outside the links, that starts with one of the repository's top-level
// directories and a slash, in prose, a code span or a fenced block alike; a
// trailing slash names a directory. Empty is a pass.
export function missingPaths(text) {
  const root = new URL('../../', import.meta.url);
  const dirs = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'node_modules' && !d.name.startsWith('.'))
    .map((d) => d.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const token = new RegExp(`(?<![\\w/.-])(?:${dirs.join('|')})/[\\w./-]*[\\w/]`, 'g');
  const prose = text.replace(/\[[^\]]*\]\([^)]*\)/g, '');
  const named = [...prose.matchAll(token)].map((m) => m[0].replace(/\/$/, ''));
  return [...new Set(named)].filter((p) => !fs.existsSync(new URL(p, root)));
}

export const count = (text, s) => text.split(s).length - 1;
