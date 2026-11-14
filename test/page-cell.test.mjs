// The page tests' browser runs in a cell under its own profile. In the test
// tree, the page module is imported by the cell and by no other file, and
// playwright-core by the page module and by no other file; the cell is named
// in one start site, sandbox-exec with a profile file. Started without its
// profile, the cell ends with exit 3 before the page module or a package
// loads. Values cross the cell's channel as Playwright returned them. The
// browser runs in the cell with Playwright's defaults, which turn Chrome's
// own sandbox off (it cannot run inside another profile) and give Chrome a
// mock keychain (the profile refuses the keychain).
//
// This file starts the cell outside its profile on purpose, so the walk of
// start sites leaves it out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scan, specifiers, trackedFiles } from './support/closure.mjs';
import { launchChrome, newContext } from './support/page-remote.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'test/page-cell.test.mjs';
const CELL = path.join(ROOT, 'test', 'support', 'page-cell.mjs');
const PAGE = 'test/support/page.mjs';
const PAGE_RUNNERS = ['test/offline-compare.test.mjs', 'test/view-offline-states.test.mjs', 'test/view-pages.test.mjs'];
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = [...trackedFiles(ROOT)].filter((f) => f.startsWith('test/') && /\.(mjs|cjs|js)$/.test(f)).sort();

// Who imports what in the test tree: static imports, literal import() and
// literal require(), each relative specifier resolved.
function importers(reader = read) {
  const by = new Map();
  for (const f of code) {
    for (const s of specifiers(reader(f), f, ROOT)) {
      if (s.nonLiteral || (s.spec && s.spec.startsWith('node:'))) continue;
      const target = s.file ?? (s.spec.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(f), s.spec)) : s.spec);
      if (!by.has(target)) by.set(target, []);
      if (!by.get(target).includes(f)) by.get(target).push(f);
    }
  }
  return by;
}

// The start sites that name the cell, outside this file: each code literal
// that holds page-cell.mjs, with its line.
function cellSites(reader = read) {
  const sites = [];
  for (const f of code.filter((x) => x !== SELF)) {
    const text = reader(f);
    const lines = text.split('\n');
    for (const l of scan(text).literals) if (l.value.includes('page-cell.mjs')) sites.push({ file: f, line: l.line, text: lines[l.line - 1] });
  }
  return sites;
}

test('the page module is imported by the cell and by no other file, playwright-core by the page module and by no other file, and the cell is named in one start site: sandbox-exec with a profile file', () => {
  const by = importers();
  assert.deepEqual(by.get(PAGE), ['test/support/page-cell.mjs']);
  assert.deepEqual(by.get('playwright-core'), [PAGE]);
  const sites = cellSites();
  assert.equal(sites.length, 1, JSON.stringify(sites));
  assert.equal(sites[0].file, 'test/support/page-remote.mjs');
  assert.match(sites[0].text, /\bspawn\(SANDBOX_EXEC, \['-f', /);
});

test('the walk flags a page runner that imports the page module: the three page runners with their import line as it was', () => {
  const before = (rel) => (PAGE_RUNNERS.includes(rel) ? read(rel).replace("from './support/page-remote.mjs'", "from './support/page.mjs'") : read(rel));
  assert.deepEqual(importers(before).get(PAGE), [...PAGE_RUNNERS, 'test/support/page-cell.mjs'].sort());
});

test('started without its profile, the cell ends with exit 3 and says so, and neither the page module nor a package loads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-cell-'));
  try {
    const notes = path.join(dir, 'loads.jsonl');
    const preload = path.join(dir, 'loads.cjs');
    fs.writeFileSync(preload, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const mod = require('node:module');",
      `mod.registerHooks({ load(url, context, next) { fs.appendFileSync(${JSON.stringify(notes)}, url + '\\n'); return next(url, context); } });`,
      '',
    ].join('\n'));
    const r = spawnSync(process.execPath, ['--require', preload, CELL], {
      env: { PATH: '/usr/bin:/bin', HOME: os.userInfo().homedir, LANG: 'C', TZ: 'UTC' },
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(r.status, 3, r.stderr);
    assert.equal(r.stderr, 'the page cell is not inside its profile\n');
    assert.equal(r.stdout, '');
    const loaded = fs.readFileSync(notes, 'utf8').split('\n').filter((u) => u.startsWith('file:'));
    assert.deepEqual(loaded, [pathToFileURL(CELL).href], 'the cell alone loaded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('values cross the cell as Playwright returned them: -0, NaN, both infinities, undefined, null and the empty string', async () => {
  const browser = await launchChrome();
  try {
    const ctx = await newContext(browser);
    const page = await ctx.newPage();
    const values = [-0, NaN, Infinity, -Infinity, undefined, null, ''];
    const back = await page.evaluate((v) => v, values);
    assert.equal(back.length, values.length);
    values.forEach((v, i) => assert.ok(Object.is(back[i], v), `${i}: ${String(back[i])}`));
    assert.deepEqual(ctx.outside, []);
  } finally {
    await browser.close();
  }
});

// Playwright pushes --no-sandbox unless chromiumSandbox is true, and puts
// --use-mock-keychain in its switch list.
const SANDBOX_OFF = /if \(options\.chromiumSandbox !== true\)\s*\n\s*chromeArguments\.push\("--no-sandbox"\);/;
const MOCK_KEYCHAIN = /^\s*"--use-mock-keychain",?$/m;

test('the browser in the cell runs with Playwright\'s defaults: Chrome\'s own sandbox off and a mock keychain, and no file of the tests changes either', () => {
  const chromium = read('node_modules/playwright-core/lib/server/chromium/chromium.js');
  const switches = read('node_modules/playwright-core/lib/server/chromium/chromiumSwitches.js');
  assert.match(chromium, SANDBOX_OFF);
  assert.match(switches, MOCK_KEYCHAIN);
  assert.equal(SANDBOX_OFF.test(chromium.replace('chromeArguments.push("--no-sandbox");', '')), false, 'a copy without the flag fails the read');
  assert.equal(MOCK_KEYCHAIN.test(switches.replace(/^\s*"--use-mock-keychain",?\n/m, '')), false, 'a copy without the switch fails the read');
  for (const f of code) {
    const { src } = scan(read(f));
    assert.equal(/\b(chromiumSandbox|ignoreDefaultArgs)\b/.test(src), false, f);
  }
});
