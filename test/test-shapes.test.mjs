// Each test file runs in exactly one shape (test/support/shapes.mjs), and its
// import closure holds what that shape allows. A file of the outer shape
// names ./support/outer-profile.mjs in its leading import, and so runs under
// one outer profile; every other file runs outside every profile, so its
// closure holds no package from node_modules. In every closure, each import
// and require has a literal argument and each relative specifier resolves to
// a tracked file. The closure is read as code: comments, strings, templates
// and regular expressions are not imports. The kernel witness, which a
// headless rerun starts with no profile, is held to the same reading, and
// its closure holds no file of the bank or the agents.
//
// This file imports node: modules and test support files that read the
// repository as text, and runs none of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closureOf, leadingImport, trackedFiles } from './support/closure.mjs';
import { SHAPES } from './support/shapes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = './support/outer-profile.mjs';
const WITNESS = 'scripts/checks/sandbox-witness.mjs';
const tracked = trackedFiles(ROOT);
const runners = [...tracked].filter((f) => /^test\/(?:[^/]+\/)*[^/]+\.test\.mjs$/.test(f)).sort();
const nameOf = (f) => f.slice('test/'.length, -'.test.mjs'.length);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A runner with an outer profile: its leading import is the guard.
const outer = (f, text = read(f)) => leadingImport(text) === GUARD;

// What the import census flags for one runner: a package in a runner with
// no outer profile, an import or require with an argument that is not a
// literal, and a relative specifier that resolves to no tracked file.
function census(f, { files = tracked, reader = read } = {}) {
  const c = closureOf(f, { root: ROOT, tracked: files, read: reader });
  const flagged = [...c.computed, ...c.missing];
  if (!outer(f, reader(f))) flagged.push(...c.bare);
  return { closure: c, flagged };
}

test('every tracked test file has exactly one shape, and every shape names a tracked test file', () => {
  assert.ok(runners.length > 0);
  assert.deepEqual(runners.map(nameOf).filter((n) => !Object.hasOwn(SHAPES, n)), [], 'a test file with no shape');
  assert.deepEqual(Object.keys(SHAPES).filter((n) => !runners.includes(`test/${n}.test.mjs`)), [], 'a shape with no tracked test file');
  for (const [n, shape] of Object.entries(SHAPES)) assert.ok(['launcher', 'outer', 'plain'].includes(shape), `${n}: ${shape}`);
});

test('a test file of the outer shape names the outer profile in its leading import, and no other test file reaches it', () => {
  const missing = [];
  const reaching = [];
  for (const f of runners) {
    const shape = SHAPES[nameOf(f)];
    if (shape === 'outer' && !outer(f)) missing.push(f);
    if (shape !== 'outer' && closureOf(f, { root: ROOT, tracked, read }).files.includes('test/support/outer-profile.mjs')) reaching.push(f);
  }
  assert.deepEqual(missing, [], 'a test file of the outer shape whose leading import is not the outer profile');
  assert.deepEqual(reaching, [], 'a test file of another shape that reaches the outer profile');
});

test('the import census: no package in a runner with no outer profile, no import or require with an argument that is not a literal, and no relative specifier that resolves to no tracked file', (t) => {
  const failing = {};
  for (const f of runners) {
    const { flagged } = census(f);
    if (flagged.length > 0) failing[f] = flagged;
  }
  t.diagnostic(`${runners.length} runners, ${Object.keys(failing).length} flagged`);
  assert.deepEqual(failing, {});
});

test('the import census flags what it reads: a package import, one after a comment, a string, a template and a pattern, a computed import and require, a specifier with no tracked file, and the page module\'s package, and leaves the launcher boundary check clean', () => {
  const fixtures = {
    'test/fixture-bare.test.mjs': "import { test } from 'node:test';\nimport chalk from 'chalk';\n",
    'test/fixture-after.test.mjs': [
      "import { test } from 'node:test';",
      "// import a from 'commented-package';",
      "const s = \"import b from 'string-package'\";",
      "const tpl = `require('template-package')`;",
      "const re = /import\\('pattern-package'\\)/;",
      "import late from 'late-package';",
      '',
    ].join('\n'),
    'test/fixture-computed.test.mjs': "const n = 1;\nawait import(`./part-${n}.mjs`);\nrequire(name);\n",
    'test/fixture-missing.test.mjs': "import { x } from './support/no-such-file.mjs';\n",
    'test/fixture-guarded.test.mjs': "import './support/outer-profile.mjs';\nimport chalk from 'chalk';\n",
  };
  const files = new Set([...tracked, ...Object.keys(fixtures)]);
  const reader = (rel) => fixtures[rel] ?? read(rel);
  const flagged = (f) => census(f, { files, reader }).flagged;
  assert.deepEqual(flagged('test/fixture-bare.test.mjs'), ['test/fixture-bare.test.mjs: chalk']);
  assert.deepEqual(flagged('test/fixture-after.test.mjs'), ['test/fixture-after.test.mjs: late-package']);
  assert.deepEqual(flagged('test/fixture-computed.test.mjs'), ['test/fixture-computed.test.mjs: import(__template__)', 'test/fixture-computed.test.mjs: require(name)']);
  assert.deepEqual(flagged('test/fixture-missing.test.mjs'), ['test/fixture-missing.test.mjs: ./support/no-such-file.mjs']);
  assert.deepEqual(flagged('test/fixture-guarded.test.mjs'), [], 'a package in a runner with an outer profile');
  assert.deepEqual(closureOf('test/support/page.mjs', { root: ROOT, tracked, read }).bare, ['test/support/page.mjs: playwright-core']);
  assert.deepEqual(census('test/launcher-boundary.test.mjs').flagged, []);
});

test('the three page runners: no package in their closure', () => {
  for (const f of ['test/offline-compare.test.mjs', 'test/view-offline-states.test.mjs', 'test/view-pages.test.mjs']) {
    const c = closureOf(f, { root: ROOT, tracked, read });
    assert.deepEqual(c.bare, [], f);
    assert.equal(c.files.includes('test/support/page.mjs'), false, `${f} reaches the page module`);
  }
});

test('a file of the plain shape: no file of the demo and no package in its closure', () => {
  for (const f of runners.filter((r) => SHAPES[nameOf(r)] === 'plain')) {
    const c = closureOf(f, { root: ROOT, tracked, read });
    assert.deepEqual(c.files.filter((x) => x.startsWith('src/') || x.startsWith('bin/')), [], f);
    assert.deepEqual(c.bare, [], f);
  }
});

test('the kernel witness, started with no profile: node: built-ins and the demo\'s own files, no package, and no file of the bank or the agents', (t) => {
  const c = closureOf(WITNESS, { root: ROOT, tracked, read });
  t.diagnostic(`${c.files.length} files: ${c.files.join(', ')}`);
  assert.deepEqual([...c.bare, ...c.computed, ...c.missing], []);
  assert.deepEqual(c.files.filter((x) => x.startsWith('src/bank/') || x.startsWith('src/agent/')), []);
});
