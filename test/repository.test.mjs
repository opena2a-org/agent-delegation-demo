// Checks over the repository's own files: the copy deck lint, the words the
// repository may not carry, and the absence of private key material.
// Patterns that name what they look for are built from fragments, so this
// file does not match itself.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const j = (...parts) => parts.join('');

function gitGrep(args) {
  const r = spawnSync('git', ['-C', ROOT, 'grep', '-n', ...args], { encoding: 'utf8' });
  if (r.status === 1) return [];
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim().split('\n');
}

function tracked() {
  return execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).trim().split('\n').filter((f) => fs.existsSync(path.join(ROOT, f)));
}

// A file is text unless a NUL byte sits in its leading 8000 bytes, the rule
// git itself uses. Compressed image data read as UTF-8 can hold a byte run
// that decodes as a dash, so the text matchers skip binary files.
function isTextFile(absPath) {
  const fd = fs.openSync(absPath, 'r');
  try {
    const buf = Buffer.alloc(8000);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return !buf.subarray(0, n).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

test('the copy deck lint passes: no refusal, narration within 240 words', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'test/copy/lint.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /refusals: 0/);
  const total = Number(/narration total: (\d+) words/.exec(r.stdout)[1]);
  assert.ok(total <= 240, String(total));
});

test('copy.json: eleven labels in their set words, each marked ruled, and L4 in its set words in every place it appears', () => {
  const copy = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
  const side = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.sidecar.json'), 'utf8'));
  assert.deepEqual(Object.keys(copy.LABELS), ['L1', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13']);
  assert.equal(side.strings['LABELS.L10'].status, 'ruled');
  assert.equal(side.strings['LABELS.L4'].status, 'ruled');
  for (const id of Object.keys(copy.LABELS)) {
    assert.equal(typeof copy.LABELS[id], 'string', id);
    assert.ok(copy.LABELS[id].length > 0, id);
    const status = side.strings[`LABELS.${id}`]?.status ?? 'ruled';
    assert.equal(status, 'ruled', id);
  }
  assert.equal(gitGrep(['-F', j('Bearer credential: anyone with', ' a copy')]).length, 0);

  const L4 = "Your consent at the bank names the agent. The agent gets a grant name and a shared broker token that can't act alone, never your password or account token.";
  assert.equal(copy.LABELS.L4, L4);
  assert.equal(side.strings['LABELS.L4'].status, 'ruled');
  let uses = 0;
  JSON.stringify(copy, (k, v) => { if (v === L4) uses += 1; return v; });
  assert.equal(uses, 3, 'L4, the setup screen note and the summary limits item');
});

test('the words on what the agent holds: no line says no bank token reaches it or never a bank credential, and a line on a grant name alone names the model', () => {
  assert.deepEqual(gitGrep(['-F', j('no bank password or token ', 'reaches it')]), []);
  const unqualified = gitGrep(['-i', '-E', j('never a bank cre', 'dential|on', 'ly a gra', 'nt name')]).filter((l) => !/model/i.test(l));
  assert.deepEqual(unqualified, []);
  const keys = fs.readFileSync(path.join(ROOT, 'fixtures/README.md'), 'utf8').replace(/\n/g, ' ');
  assert.equal(new RegExp(j('broker acc', 'ess token|access k', 'ey|cal', 'ler token')).test(keys), false, 'fixtures/README.md names the broker token by its one term');
});

test('no internal identifier in any tracked file', () => {
  const ids = j('(^|[^[:alnum:]_-])(S', 'W|B', 'KD|Q', 'GF|S', 'LS|O', 'PA)-[0-9]+([^[:alnum:]_-]|$)');
  const roles = j('\\b(C', 'DO|C', 'CO|C', 'PO|C', 'RO|C', 'ISO|C', 'SR|C', 'DS|C', 'DE|D', 'PO)\\b|[Cc]hief [A-Za-z]+ [Oo]fficer');
  const words = j('[Ff]inding (filed|F[1-6]([^[:alnum:]]|$))|communi', 'cations role|archi', 'tecture role|reliabi', 'lity role');
  assert.deepEqual(gitGrep(['-E', ids]), []);
  assert.deepEqual(gitGrep(['-E', roles]), []);
  assert.deepEqual(gitGrep(['-i', '-E', words]), []);
  // An empty result may be a wrong pattern rather than a clean tree, so the
  // words search runs once more over a tree that plants a line of its class,
  // and there it must find that line.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-words-'));
  fs.writeFileSync(path.join(dir, 'planted.md'), [j('The reliabi', 'lity role read the words.'), j('A note names a fin', 'ding filed last week.'), 'A clean line.', ''].join('\n'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'add', 'planted.md']);
  const r = spawnSync('git', ['-C', dir, 'grep', '-n', '-i', '-E', words], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').map((l) => l.split(':').slice(0, 2).join(':')), ['planted.md:1', 'planted.md:2']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the test issuer is not our authority', () => {
  assert.deepEqual(gitGrep(['-F', j('did:opena2a:authority:', 'opena2a.org')]), []);
});

// The package's main entry and its CLI are never imported. Over the whole
// tree the same pattern also finds two kinds of line that import nothing:
// the lockfile's record of the package's bin entry and the vendored file
// manifest's listing of that file. Those are reported, not hidden.
test('no code file imports the package entry or the CLI of the reference implementation', () => {
  const lines = gitGrep(['-E', j("from 'secret", "less-ai'|require\\('secret", "less-ai'\\)|dist/cli\\.js")]);
  const code = lines.filter((l) => /^[^:]+\.(mjs|cjs|js):/.test(l));
  assert.deepEqual(code, []);
  const other = lines.filter((l) => !/^[^:]+\.(mjs|cjs|js):/.test(l)).map((l) => l.split(':')[0]);
  for (const f of other) assert.ok(f === 'package-lock.json' || f.endsWith('.files.sha256'), f);
});

test('no private key material in the tracked tree or the vendored package', () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/upstream-vector-keys.json'), 'utf8'));
  const seedDigests = new Set(vectors.seedSha256);
  const counts = { pemHeaders: 0, jwkWithD: 0, keyFiles: 0, seeds: 0 };
  // The key-file name check covers every file; the text matchers cover text files.
  const scan = (name, absPath) => {
    if (/\.(key|pem|p12|pfx)$/.test(name)) counts.keyFiles += 1;
    if (!isTextFile(absPath)) return;
    const text = fs.readFileSync(absPath, 'utf8');
    counts.pemHeaders += (text.match(new RegExp(j('-----BEGIN [A-Z ]*', 'PRIVATE KEY-----'), 'g')) ?? []).length;
    for (const m of text.matchAll(/\{[^{}]*\}/g)) if (/"kty"\s*:/.test(m[0]) && /"d"\s*:/.test(m[0])) counts.jwkWithD += 1;
    for (const m of text.matchAll(/\b[0-9a-f]{64}\b/g)) if (seedDigests.has(crypto.createHash('sha256').update(m[0]).digest('hex'))) counts.seeds += 1;
  };
  for (const f of tracked()) if (!f.endsWith('.tgz')) scan(f, path.join(ROOT, f));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-unpack-'));
  const pins = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/pins.json'), 'utf8'));
  execFileSync('tar', ['-xzf', path.join(ROOT, pins.secretlessAi.tarball), '-C', dir]);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else scan(e.name, p);
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(counts, { pemHeaders: 0, jwkWithD: 0, keyFiles: 0, seeds: 0 });
});

test('the claim words: no dash, and neither barred word, in any file this repository authors', () => {
  const barred = new RegExp(j('\\b(on', 'ly|fir', 'st)\\b'), 'i');
  // The licenses are the Apache License text and the font's SIL Open Font
  // License text, not written here.
  const authored = tracked().filter((f) => !f.startsWith('vendor/aap-conformance/') && !f.endsWith('.tgz') && !f.endsWith('.files.sha256') && !['package-lock.json', 'test/copy/lint.mjs', 'LICENSE', 'src/view/fonts/OFL.txt'].includes(f));
  const offenders = [];
  for (const f of authored.filter((f) => isTextFile(path.join(ROOT, f)))) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (/[\u2013\u2014]/.test(text)) offenders.push(`${f}: dash`);
    const words = text.replace(/--name-only/g, '');
    if (barred.test(words)) offenders.push(`${f}: ${barred.exec(words)[0]}`);
  }
  assert.deepEqual(offenders, []);
});

test('no language model client and no optional package is installed', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const installed = fs.readdirSync(path.join(ROOT, 'node_modules')).flatMap((d) => (d.startsWith('@') ? fs.readdirSync(path.join(ROOT, 'node_modules', d)).map((x) => `${d}/${x}`) : [d]));
  for (const [k, v] of Object.entries(lock.packages)) if (v.optional) assert.equal(installed.includes(k.replace(/^node_modules\//, '')), false, k);
  assert.equal(installed.some((p) => /anthropic|openai|nanomind/i.test(p)), false);
});
