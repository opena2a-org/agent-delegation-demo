// Lint of the copy deck (src/view/copy.json) against the claim rules and the length rules,
// and of every string a reader meets in the repository against the offline claim scope.
// Usage: node test/copy/lint.mjs   (prints a report; exit 1 on any refusal)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LABELS, GLOBAL, SCREENS, NARRATION } from './copy-source.mjs';

const refusals = [];
const notes = [];
const labelSet = new Set(Object.values(LABELS));

// Collect every user-facing string with a path, skipping non-text keys.
const SKIP = new Set(['id', 'route', 'side', 'tone', 'chip', 'mailto', 'screen', 'action']);
const strings = [];
function walk(v, path) {
  if (typeof v === 'string') { strings.push({ path, s: v }); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!SKIP.has(k)) walk(x, path ? `${path}.${k}` : k);
}
walk(GLOBAL, 'GLOBAL'); walk(SCREENS, 'SCREENS'); walk(NARRATION.map(n => n.text), 'NARRATION');

// Code tokens rendered in the mono face, exempt from the hyphen rule.
const CODE = /\{[a-zA-Z0-9]+\}|https?:\/\/\S+|info@opena2a\.org|\b(creditorAccounts|maximumIndividualAmount|periodicLimits|validToDateTime|atx-verify|secretless-ai|aap-conformance|agent-banking-delegation-demo|agent-delegation-demo|customer\.a|customer\.b)\b|git clone|npm start/g;
const BANNED = [
  [/\bonly\b/i, 'the word "only" (brief: no "only" language)'],
  [/\bfirst\b/i, 'the word "first" (brief: no "first" language)'],
  [/production ready/i, '"production ready"'], [/bank grade/i, '"bank grade"'],
  [/\bguarantee/i, 'guarantee'], [/\bsecure\b/i, '"secure" as a claim'], [/\bprevent/i, 'prevent'],
  [/(blocks|stops|detects|prevents|defeats)\s+(the\s+)?prompt injection/i, 'never "blocks prompt injection"'],
  [/\b(just|simply|easy|easily|seamless|powerful|revolutionary|unlock|leading|world class|best)\b/i, 'marketing or minimizing word'],
  [/!/, 'exclamation mark'], [/\b(trust score|trust level|tier)\b/i, 'trust level or tier (never shown)'],
  [/\b(vs\.?|versus|compared to|unlike)\b/i, 'comparison wording'],
  [/\d+(\.\d+)?\s?%/, 'a percentage (no defense rate figures)'],
];
const ALLOWED_CHARS = /^[\x20-\x7E·]*$/;

for (const { path, s } of strings) {
  const isLabel = labelSet.has(s);
  if (!ALLOWED_CHARS.test(s)) refusals.push(`${path}: character outside printable ASCII and U+00B7: ${JSON.stringify([...s].filter(c => !/[\x20-\x7E·]/.test(c)).join(''))}`);
  if (/[–—]| -- /.test(s)) refusals.push(`${path}: dash`);
  const bare = s.replace(CODE, 'X');
  if (/[A-Za-z]-[A-Za-z]/.test(bare)) (isLabel ? notes : refusals).push(`${path}: hyphen connector outside a code token: "${bare.match(/\S*[A-Za-z]-[A-Za-z]\S*/)[0]}"${isLabel ? ' (binding label, rendered as a code token)' : ''}`);
  for (const [re, why] of BANNED) {
    if (re.test(s) && !(re.source.includes('prompt injection') && /including those triggered by prompt injection/.test(s))) (isLabel ? notes : refusals).push(`${path}: ${why}: "${s.slice(0, 90)}"${isLabel ? ' (binding label)' : ''}`);
  }
  if (/prompt injection/i.test(s) && !/blocks unauthorized actions, including those triggered by prompt injection/.test(s)) refusals.push(`${path}: "prompt injection" outside the approved phrase`);
  if (/\b(you|your|yours)\b/i.test(s) && !isLabel && !/^(SCREENS\[7\]\.cta\.text|NARRATION\[10\])$/.test(path)) refusals.push(`${path}: second person outside the binding labels and the CTA: "${s.slice(0, 80)}"`);
}

// Length rules (characters, words), per field kind.
const words = s => s.split(/\s+/).filter(Boolean).length;
const LIMITS = { h1: [50, 12], outcome: [22, 4], why: [64, 14], result: [120, 22], sub: [110, 18], subB: [110, 18], lead: [200, 40], answer: [140, 25] };
for (const { path, s } of strings) {
  const key = path.split('.').pop().replace(/\[\d+\]$/, '');
  if (LIMITS[key]) {
    const [c, w] = LIMITS[key];
    if (s.length > c || words(s) > w) refusals.push(`${path}: ${key} is ${s.length} characters and ${words(s)} words (limit ${c} and ${w}): "${s}"`);
  }
}
for (const c of GLOBAL.chips) if (c.length > 16) refusals.push(`chip "${c}" over 16 characters`);
// The executive layer (headlines and outcome phrases) carries no engineer term.
const AVOID = /\b(AAP|AIP|ATX|CGT|RFC|JWT|token|tokens|broker|CRL|Ed25519|bearer|DID|API|loopback|egress|consent record|credential)\b/i;
for (const { path, s } of strings) { const key = path.split('.').pop(); if ((key === 'h1' || key === 'outcome') && AVOID.test(s)) refusals.push(`${path}: engineer term in the executive layer: "${s}"`); }
for (const b of Object.values(GLOBAL.buttons)) if (b.length > 22) refusals.push(`button "${b}" over 22 characters`);

// Narration length rules (2026-10-19): 2.5 words per second, at most 28 words and two
// sentences per step, no sentence over 20 words, no URL, path, version or code token.
let total = 0, holds = 0;
const narr = [];
for (const n of NARRATION) {
  const w = words(n.text); total += w;
  const sentences = n.text.split(/(?<=[.;?])\s+/).filter(Boolean);
  const longest = Math.max(...n.text.split(/(?<=[.?])\s+/).map(words));
  const hold = Math.max(3, w / 2.5 + 0.5); holds += hold;
  narr.push(`${n.id} ${String(w).padStart(2)} words  ${n.text.split(/(?<=[.?])\s+/).length} sentences  longest ${longest}  hold ${hold.toFixed(1)} s`);
  if (w > 28) refusals.push(`${n.id}: ${w} words (limit 28)`);
  if (n.text.split(/(?<=[.?])\s+/).length > 2) refusals.push(`${n.id}: more than two sentences`);
  if (longest > 20) refusals.push(`${n.id}: a sentence of ${longest} words (limit 20)`);
  if (/https?:|@|\/|\b\d+\.\d+\.\d+\b|`/.test(n.text)) refusals.push(`${n.id}: URL, address, path or version token`);
}

if (total > 240) refusals.push(`narration total ${total} words (limit 240)`);

// Offline claim scope: the claims the offline check cannot support, as patterns.
export const OFFLINE_NAMES = /\b(Run offline check|Offline check|offline check)\b/g; // names that may stay (item 1)
export const OFFLINE_MUST_NOT = [
  [/\boffline\b/i, 'item 1: "offline" as a statement (OFFLINE_NAMES is removed before this test)'],
  [/\bair[\s-]?gap(ped)?\b|\bdisconnected\b|\bno network\b/i, 'item 1: air gapped, disconnected, no network'],
  [/\ball (outbound )?(network )?traffic\b|\bnothing left (the|this) machine\b|\bzero packets\b|\bno DNS quer(y|ies)\b/i, 'item 2'],
  [/\bOpenA2A\b[^.]*\b(down|outage|taken offline|simulat\w*|failing)\b/i, 'item 4'],
  [/\b(Linux|Windows|Ubuntu|Debian|Fedora|WSL)\b/, 'item 6: a platform not measured'],
  [/\bproven\b|\bverified offline\b|\bguarantee/i, 'item 7'],
];

// A string's findings against the must-not list. Code is not a claim, so a
// code span and the code tokens of the text rules above are taken out first,
// as these patterns were measured; then the names of the check go, and
// each pattern is tested on what a reader reads.
export function offlineClaimFindings(s) {
  const prose = s.replace(/`[^`]*`/g, 'X').replace(CODE, 'X').replace(OFFLINE_NAMES, '');
  return OFFLINE_MUST_NOT.filter(([re]) => re.test(prose)).map(([, why]) => why);
}

// The strings a reader meets in a Markdown text: every line that holds text,
// with its own line number, and every paragraph or list item that wraps, its
// lines joined by a space and keyed to the line it starts on, so a sentence
// split across a line break is read whole and a refusal still names one line.
export function markdownStrings(text, name) {
  const out = [];
  let open = null;
  let fenced = false;
  const close = () => { if (open && open.lines > 1) out.push({ path: open.path, s: open.s }); open = null; };
  text.split('\n').forEach((line, i) => {
    const at = `${name}:${i + 1}`;
    if (line.trim()) out.push({ path: at, s: line });
    const fence = /^\s*(```|~~~)/.test(line);
    if (fence || fenced || /^\s{0,3}(#{1,6}\s|\|)/.test(line) || !line.trim()) {
      close();
      if (fence) fenced = !fenced;
      return;
    }
    if (/^\s*([-*+]|\d+[.)])\s/.test(line)) close();
    if (open) { open.s += ` ${line.trim()}`; open.lines += 1; }
    else open = { path: at, s: line, lines: 1 };
  });
  close();
  return out;
}

// The values of copy.json, every string but an id or a route. A narration
// step's `screen` holds the id of the screen it plays over, so it goes with
// the ids it names.
const NOT_READ = new Set(['id', 'route', 'screen']);
export function copyStrings(value, name) {
  const out = [];
  const walk = (v, p) => {
    if (typeof v === 'string') out.push({ path: `${name} ${p}`, s: v });
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!NOT_READ.has(k)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(value, '');
  return out;
}

// The scope: every string a reader meets in the repository. The launcher's
// source is not in it. The narration is NARRATION in copy.json, read with its
// values; this repository has no captions sidecar.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOCS = path.join(ROOT, 'docs');
const docs = fs.existsSync(DOCS) ? fs.readdirSync(DOCS, { recursive: true }).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`).sort() : [];
export const OFFLINE_SCOPE_FILES = ['README.md', 'fixtures/README.md', 'vendor/VENDORED.md', ...docs, 'src/view/copy.json'];
const scope = [];
for (const f of OFFLINE_SCOPE_FILES) {
  const file = path.join(ROOT, f);
  if (!fs.existsSync(file)) { refusals.push(`offline claim scope: ${f} is missing`); continue; }
  const text = fs.readFileSync(file, 'utf8');
  scope.push(...(f.endsWith('.json') ? copyStrings(JSON.parse(text), f) : markdownStrings(text, f)));
}
for (const { path: p, s } of scope) for (const why of offlineClaimFindings(s)) refusals.push(`${p}: offline claim scope, ${why}: "${s.slice(0, 90)}"`);

// Item 3: the harness never reads the macOS log, so no `log show` and no
// `log stream` in src or scripts. The search written as
// git grep -n -E '\blog (show|stream)\b' matches nothing in any tree, because
// `\b` is not a word boundary in the POSIX syntax -E selects. The bracket
// classes below are the same words in the syntax git applies, and the test
// beside this one plants a line that both forms must find.
const LOG_READ = '(^|[^[:alnum:]_])log (show|stream)([^[:alnum:]_]|$)';
export function macosLogReads(root) {
  const r = spawnSync('git', ['-C', root, 'grep', '-n', '-E', LOG_READ, '--', 'src', 'scripts'], { encoding: 'utf8' });
  if (r.status === 1 && !r.stdout) return [];
  if (r.status !== 0) return [`the search did not run: ${(r.stderr || String(r.error ?? '')).trim()}`];
  return r.stdout.trim().split('\n');
}
const logReads = macosLogReads(ROOT);
for (const hit of logReads) refusals.push(`offline claim item 3, the harness reads the macOS log: ${hit}`);

// Item 5, the screen half: screen 6's strings name neither the browser nor the
// page. They are the offline screen, the words it shows from RULED_EXTRA and
// the narration over it.
const BROWSER_OR_PAGE = /\b(browser|page)s?\b/i;
export function screenSixStrings(copy) {
  return [
    ...copyStrings(copy.SCREENS.find((s) => s.id === 'offline'), 'SCREENS offline'),
    ...Object.entries(copy.RULED_EXTRA).filter(([k]) => k.startsWith('offline')).flatMap(([k, v]) => copyStrings(v, `RULED_EXTRA.${k}`)),
    ...copy.NARRATION.filter((n) => n.screen.split('#')[0] === 'offline').map((n) => ({ path: `NARRATION ${n.id}`, s: n.text })),
  ];
}
export function browserOrPageFindings(copy) {
  return screenSixStrings(copy).filter(({ s }) => BROWSER_OR_PAGE.test(s));
}
const COPY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
const screenSix = browserOrPageFindings(COPY);
for (const { path: p, s } of screenSix) refusals.push(`${p}: offline claim item 5, screen 6 names the browser or the page: "${s.slice(0, 90)}"`);

// The report runs when this file is run, not when a test imports it.
const runAsScript = (() => {
  try { return fs.realpathSync(path.resolve(process.argv[1] ?? '')) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();

if (runAsScript) {
  console.log(`strings checked: ${strings.length} (binding labels among them: ${strings.filter(x => labelSet.has(x.s)).length})`);
  console.log('narration:'); narr.forEach(l => console.log('  ' + l));
  console.log(`narration total: ${total} words, holds ${holds.toFixed(1)} s`);
  console.log(`offline claim scope: ${OFFLINE_SCOPE_FILES.join(', ')} (${scope.length} strings; the narration is read in src/view/copy.json; no captions sidecar)`);
  console.log(`offline claim item 3: macOS log reads in src and scripts: ${logReads.length}`);
  console.log(`offline claim item 5: screen 6 strings that name the browser or the page: ${screenSix.length} of ${screenSixStrings(COPY).length}`);
  console.log(`notes (not refusals): ${notes.length}`); notes.forEach(n => console.log('  NOTE ' + n));
  console.log(`refusals: ${refusals.length}`); refusals.forEach(r => console.log('  REFUSE ' + r));
  process.exit(refusals.length ? 1 : 0);
}
