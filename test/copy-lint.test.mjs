// The copy lint's offline claim scope (test/copy/lint.mjs): its patterns
// refuse each sentence that breaks the claim scope and pass each sentence
// written for the screens, the launcher and the README; it reads every file in
// its scope; a count that was not measured names one reason of the closed list
// and prints no digit in the count's place; the harness never reads the macOS
// log; and the offline screen names neither the browser nor the page. Each
// test that expects a refusal feeds an input that breaks the rule.

import './support/outer-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFFLINE_MUST_NOT,
  OFFLINE_SCOPE_FILES,
  browserOrPageFindings,
  copyStrings,
  macosLogReads,
  markdownStrings,
  offlineClaimFindings,
  screenSixStrings,
} from './copy/lint.mjs';
import { NOT_MEASURED } from '../src/egress/classify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const claims = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/copy/offline-claims.json'), 'utf8'));
const COPY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));

for (const s of claims.violating) {
  test(`offline claim lint refuses: "${s}"`, () => {
    assert.notDeepEqual(offlineClaimFindings(s), []);
  });
}

test('offline claim lint: 20 of 20 sentences that break the claim scope are refused, and each pattern refuses at least one of them', () => {
  assert.equal(claims.violating.length, 20);
  assert.equal(claims.violating.filter((s) => offlineClaimFindings(s).length).length, 20);
  for (const [, why] of OFFLINE_MUST_NOT) assert.ok(claims.violating.some((s) => offlineClaimFindings(s).includes(why)), why);
});

test('offline claim lint: none of the 77 sentences written for the screens, the launcher and the README is refused', () => {
  assert.equal(claims.admitted.length, 77);
  const refused = claims.admitted.filter((s) => offlineClaimFindings(s).length).map((s) => `${s.slice(0, 60)}: ${offlineClaimFindings(s).join('; ')}`);
  assert.deepEqual(refused, []);
});

test('offline claim lint: the names of the check may stay, and "offline" as a statement does not', () => {
  for (const s of ['Offline check', 'Run offline check', 'Click Run offline check to start the offline check.']) assert.deepEqual(offlineClaimFindings(s), [], s);
  assert.notDeepEqual(offlineClaimFindings('The offline check ran offline.'), []);
});

test('offline claim lint: the launcher refusal that names Windows is refused by item 6, which is why the launcher source is outside the scope', () => {
  const windows = 'This demo does not run on Windows.';
  assert.ok(fs.readFileSync(path.join(ROOT, 'bin/start.mjs'), 'utf8').includes(windows));
  assert.deepEqual(offlineClaimFindings(windows), ['item 6: a platform not measured']);
  assert.equal(OFFLINE_SCOPE_FILES.includes('bin/start.mjs'), false);
});

test('offline claim scope: the README files, the vendored record, every document under docs and the values of copy.json, each present', () => {
  const docs = fs.readdirSync(path.join(ROOT, 'docs'), { recursive: true }).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`).sort();
  assert.deepEqual(OFFLINE_SCOPE_FILES, ['README.md', 'fixtures/README.md', 'vendor/VENDORED.md', ...docs, 'src/view/copy.json']);
  for (const f of OFFLINE_SCOPE_FILES) assert.equal(fs.existsSync(path.join(ROOT, f)), true, f);
});

test('offline claim scope: a breaking line in a scope file is refused with its file and line; a wrapped sentence is read whole, a heading and a table row on their own, and a code span is not a claim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-lint-'));
  const file = path.join(dir, 'README.md');
  fs.writeFileSync(file, [
    '# Agent banking delegation demo',
    '',
    'The demo runs offline.',
    'The still is `06-offline-check.png`.',
    'Then click Run offline check.',
    'Checked on Windows 11.',
    '',
    'All outbound',
    'network traffic is blocked.',
    '',
    '| Still | Name |',
    '| `06-offline-check` | Offline check |',
    '',
  ].join('\n'));
  const strings = markdownStrings(fs.readFileSync(file, 'utf8'), 'README.md');
  const refused = [...new Set(strings.filter(({ s }) => offlineClaimFindings(s).length).map((x) => x.path))];
  assert.deepEqual(refused, ['README.md:3', 'README.md:6', 'README.md:8']);
  assert.ok(strings.some(({ path: p, s }) => p === 'README.md:8' && s === 'All outbound network traffic is blocked.'), 'a wrapped sentence is read whole');
  // The still's file name and the shot list row carry the name of the check in
  // a code span, which is code, not a claim.
  assert.deepEqual(strings.filter(({ path: p }) => p === 'README.md:4' || p === 'README.md:12').flatMap(({ s }) => offlineClaimFindings(s)), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('offline claim scope: a screen id and a route are not strings a reader meets, and the words beside them are', () => {
  const read = copyStrings({ id: 'offline', route: '/offline', sub: 'A subhead.' }, 'X').map((x) => x.s);
  assert.deepEqual(read, ['A subhead.']);
  const narration = copyStrings({ id: 's08', screen: 'offline', text: 'A step.' }, 'X').map((x) => x.s);
  assert.deepEqual(narration, ['A step.']);
});

test('offline claim item 3: a count that was not measured names one reason of the closed list and no digit follows "attempts:"', () => {
  const X = COPY.RULED_EXTRA;
  const reasons = X.offlineNotMeasuredReasons;
  // The closed list is the classifier's own: the copy file carries its reasons
  // in its order, so a reason added to both is read here with no count to retype.
  assert.deepEqual(reasons, Object.values(NOT_MEASURED));
  for (const decisions of ['Each decision matched.', 'Not every decision matched.']) {
    for (const reason of reasons) {
      const line = `${decisions} ${X.offlineNotMeasured.replace('{reason}', reason)}`;
      assert.equal(line, `${decisions} Outbound connection attempts: not measured (${reason}).`);
      assert.equal(/attempts:\s*\d/.test(line), false, line);
    }
  }
  // The same check refuses a line that keeps a number in the count's place.
  assert.equal(/attempts:\s*\d/.test('Each decision matched. Outbound connection attempts: 0.'), true);
  assert.equal(/attempts:\s*\d/.test('Each decision matched. Outbound connection attempts: not measured ().'), false);
});

test('offline claim item 3: the harness never reads the macOS log, and the same search finds both reads in a tree that has them, a word that merely holds them aside', () => {
  assert.deepEqual(macosLogReads(ROOT), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-logread-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'reader.mjs'), [
    "execSync('log show --last 1m');",
    "execSync('log stream --style compact');",
    'const blog = showAll();',
    'const catalog = streamOf();',
    '',
  ].join('\n'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'add', 'src/reader.mjs']);
  const found = macosLogReads(dir);
  assert.deepEqual(found.map((l) => l.split(':').slice(0, 2).join(':')), ['src/reader.mjs:1', 'src/reader.mjs:2']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('offline claim item 5: screen 6 names neither the browser nor the page, and the same check refuses a copy that does', () => {
  assert.ok(screenSixStrings(COPY).length > 20, String(screenSixStrings(COPY).length));
  assert.deepEqual(browserOrPageFindings(COPY), []);
  const named = JSON.parse(JSON.stringify(COPY));
  named.SCREENS.find((s) => s.id === 'offline').card.label = 'The check, in the browser';
  assert.deepEqual(browserOrPageFindings(named).map((x) => x.s), ['The check, in the browser']);
});

test('the lint over the built strings: 0 refusals, and its report names each file of the offline claim scope and both scope items', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'test/copy/lint.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^refusals: 0$/m);
  for (const f of OFFLINE_SCOPE_FILES) assert.ok(r.stdout.includes(f), f);
  assert.match(r.stdout, /^offline claim item 3: macOS log reads in src and scripts: 0$/m);
  assert.match(r.stdout, /^offline claim item 5: screen 6 strings that name the browser or the page: 0 of \d+$/m);
});

test('the lint refuses a scope file that breaks the claim scope: it exits non zero and names the file and the line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-lint-tree-'));
  // A copy of the files the lint reads, with one breaking line added to a
  // scope file. The harness is not edited: the copy carries it as written.
  for (const f of ['src/view/copy.json', 'test/copy/lint.mjs', 'test/copy/copy-source.mjs', ...OFFLINE_SCOPE_FILES]) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  fs.appendFileSync(path.join(dir, 'README.md'), '\nNothing left the machine.\n');
  // Item 3's search is a git search, so the copy is a repository with its
  // sources tracked; it reads no macOS log, so that item passes there.
  fs.mkdirSync(path.join(dir, 'src', 'runner'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src/runner/offline-text.mjs'), path.join(dir, 'src/runner/offline-text.mjs'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'add', 'src', 'README.md']);
  const r = spawnSync(process.execPath, [path.join(dir, 'test/copy/lint.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /^refusals: 1$/m);
  assert.match(r.stdout, /REFUSE README\.md:\d+: offline claim scope, item 2: "Nothing left the machine\."/m);
  fs.rmSync(dir, { recursive: true, force: true });
});
