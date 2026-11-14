// Checks on the test scripts in package.json. On Node 22 and 24, node --test
// runs a bare directory argument as a module and stops with a module not
// found error before a test file loads; a quoted file pattern is expanded by
// node itself. npm test is the suite a push runs, with a runner limit for
// each test. npm run test:capture runs the walkthrough captures, each of
// which names its own limit above that one, with no runner limit. Each test
// file under test/ is reached by exactly one of the two scripts, no test in
// a file npm test reaches names a limit above its runner limit, and each
// test in a file npm run test:capture reaches names one above it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cellLimits } from './support/cell-limits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const words = pkg.scripts.test.split(' ');
const positionals = words.slice(2).filter((w) => !w.startsWith('--'));

// The part of node --test's pattern language the script uses: `*` stands for
// a run of characters other than `/`, and `**/` for zero or more directories.
const matcher = (pattern) => {
  const levels = pattern.split('**/').map((level) =>
    level.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'));
  return new RegExp(`^${levels.join('(?:.*/)?')}$`);
};

test('the test script hands node --test a quoted file pattern, not a directory', () => {
  assert.equal(words[0], 'node');
  assert.equal(words[1], '--test');
  assert.ok(positionals.length >= 1, 'the script names a pattern');
  for (const word of positionals) {
    assert.match(word, /^'test\/\S*\*\S*\.test\.mjs'$/, `${word}: a single-quoted pattern under test/ ending in .test.mjs`);
  }
});

// A script's words, its file patterns, and its runner limit in ms.
const argv = (name) => (pkg.scripts[name] ?? '').split(' ').filter(Boolean);
const patterns = (name) => argv(name).slice(2).filter((w) => !w.startsWith('--'));
const runnerLimit = (name) => {
  const word = argv(name).find((w) => w.startsWith('--test-timeout='));
  return word === undefined ? null : Number(word.slice('--test-timeout='.length));
};

// Each test file under test/, and the ones a script's patterns reach.
const testFiles = fs.readdirSync(path.join(ROOT, 'test'), { recursive: true })
  .map((rel) => rel.split(path.sep).join('/'))
  .filter((rel) => rel.endsWith('.test.mjs') && fs.statSync(path.join(ROOT, 'test', rel)).isFile())
  .map((rel) => `test/${rel}`)
  .sort();
const reachedBy = (name) => {
  const matchers = patterns(name).map((word) => matcher(word.slice(1, -1)));
  return testFiles.filter((file) => matchers.some((re) => re.test(file)));
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const shown = (file, c) => `${file}:${c.line} ${c.unread !== undefined ? `limit unread: ${c.unread}` : c.limit === null ? 'no limit named' : `limit ${c.limit} ms`}`;

test('the test:capture script hands node --test a quoted file pattern, runs one file at a time, ends by itself, and names no runner limit', () => {
  const w = argv('test:capture');
  assert.equal(w[0], 'node');
  assert.equal(w[1], '--test');
  assert.ok(w.includes('--test-concurrency=1'), 'one file at a time');
  assert.ok(w.includes('--test-force-exit'), 'the run ends by itself');
  assert.equal(runnerLimit('test:capture'), null, 'each test it runs names its own limit');
  assert.ok(patterns('test:capture').length >= 1, 'the script names a pattern');
  for (const word of patterns('test:capture')) {
    assert.match(word, /^'test\/\S*\*\S*\.test\.mjs'$/, `${word}: a single-quoted pattern under test/ ending in .test.mjs`);
  }
});

test('each test file under test/ is reached by exactly one of the test and test:capture scripts', () => {
  const self = path.relative(ROOT, fileURLToPath(import.meta.url)).split(path.sep).join('/');
  assert.ok(testFiles.includes(self), `${self} is in the walk`);
  const gate = new Set(reachedBy('test'));
  const capture = new Set(reachedBy('test:capture'));
  const wrong = testFiles.filter((file) => gate.has(file) === capture.has(file)).map((file) => `${file}: ${gate.has(file) ? 'both' : 'neither'}`);
  assert.deepEqual(wrong, [], `each file is reached by ${patterns('test').join(' ')} or by ${patterns('test:capture').join(' ')}`);
});

test('no test in a file the test script reaches names a limit above the script\'s --test-timeout', (t) => {
  const bound = runnerLimit('test');
  assert.ok(Number.isInteger(bound) && bound > 0, 'the test script names --test-timeout');
  const over = [];
  let cells = 0;
  let named = 0;
  for (const file of reachedBy('test')) {
    for (const c of cellLimits(read(file))) {
      cells += 1;
      if (c.unread === undefined && c.limit !== null) named += 1;
      if (c.unread !== undefined || (c.limit !== null && c.limit > bound)) over.push(shown(file, c));
    }
  }
  t.diagnostic(`${reachedBy('test').length} files, ${cells} tests read, ${named} name a limit, runner limit ${bound} ms`);
  assert.ok(cells > 0, 'the reading found tests');
  assert.deepEqual(over, [], `a test npm test reaches whose limit is above ${bound} ms or could not be read`);
});

test('each test in a file the test:capture script reaches names a limit above the test script\'s --test-timeout, so a test that fits it stays under npm test', (t) => {
  const bound = runnerLimit('test');
  const files = reachedBy('test:capture');
  assert.ok(files.length > 0, 'the test:capture script reaches a test file');
  const fits = [];
  for (const file of files) {
    const cells = cellLimits(read(file));
    assert.ok(cells.length > 0, `${file}: the reading found tests`);
    for (const c of cells) {
      t.diagnostic(shown(file, c));
      if (c.unread !== undefined || c.limit === null || c.limit <= bound) fits.push(shown(file, c));
    }
  }
  assert.deepEqual(fits, [], `a test npm run test:capture reaches whose limit is not above ${bound} ms`);
});

test('the limit reading reads what it is given: a literal, a spread in order, a helper over the file\'s constants and helpers, the larger branch, none for a test with none, a gate with none or a limit in its body, unread for options it cannot evaluate, and no test in a comment, a string or a method of another object', () => {
  const text = [
    "import { test } from 'node:test';",
    'const STOP_MS = 60000;',
    'const limit = (gate, waitsMs) => ({ ...gate, timeout: waitsMs + STOP_MS + 10000 });',
    'const minutes = (n) => n * 60000;',
    "const GATE = ready() ? {} : { skip: 'not ready' };",
    "test('waits', limit(GATE, minutes(4)), async () => {});",
    "test('sums', limit(GATE, 60000 + 240000), async () => {});",
    "test('literal', { timeout: 10000 }, () => {});",
    "test('body', () => { spawnSync('x', [], { timeout: 900000 }); });",
    "test('gate', GATE, () => {});",
    "test('branches', ready() ? { timeout: 5000 } : { timeout: 700000 }, () => {});",
    "test('spread', { timeout: 1000, ...{ timeout: 2000 } }, () => {});",
    "test('call', { timeout: later() }, () => {});",
    "// test('comment', { timeout: 999999 }, () => {});",
    "const s = \"test('string', { timeout: 999999 }, () => {})\";",
    "[/x/].some((re) => re.test('x'));",
    "test.skip('skipped', { timeout: 130000 }, () => {});",
    "describe('group', { timeout: 600000 }, () => {});",
  ].join('\n');
  assert.deepEqual(cellLimits(text), [
    { line: 6, name: 'waits', limit: 310000 },
    { line: 7, name: 'sums', limit: 370000 },
    { line: 8, name: 'literal', limit: 10000 },
    { line: 9, name: 'body', limit: null },
    { line: 10, name: 'gate', limit: null },
    { line: 11, name: 'branches', limit: 700000 },
    { line: 12, name: 'spread', limit: 2000 },
    { line: 13, name: 'call', unread: 'later()' },
    { line: 17, name: 'skipped', limit: 130000 },
    { line: 18, name: 'group', limit: 600000 },
  ]);
});
