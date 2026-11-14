// Every profile text a test hands sandbox-exec, as a -f file or a -p string,
// carries the boundary's terms: reads and writes refused on the real home's
// .secretless-ai and Library/Keychains, read with deniesReadWrite, and exec
// refused for the keychain tool. Read four ways:
//   - as code: each profile a test writes by hand, a literal that opens with
//     (version 1), carries the terms in its own text;
//   - each profile builder the tests and the check use, run;
//   - the profile the offline check writes, as it wrote it, under the edits
//     the headless rerun applies;
//   - every profile the runners of the offline check's edits hand
//     sandbox-exec, the check's own profile under each edit included,
//     recorded as it is handed. In that run every such start is answered by
//     /usr/bin/false, so no profile is applied and nothing it would run
//     starts; the run's own results are not read.
// A profile with one term removed is flagged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOUNDARY_TERMS, KEYCHAIN_TOOL, componentProfile, deniesReadWrite, harnessProfile, realExecPath, realHome } from '../src/orchestrator/sandbox.mjs';
import { scan, trackedFiles } from './support/closure.mjs';
import { outerProfileText, pageCellProfile } from './support/profiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADLESS = path.join(ROOT, 'test', 'support', 'headless-offline.mjs');
const EDIT_RUNNERS = ['test/offline.test.mjs', 'test/offline-not-run.test.mjs', 'test/offline-deny-form-stop.test.mjs'];
// The builder writes its profile with a template whose terms are a part of
// it; it is read by running it. This file names the marker of a hand written
// profile in its own literals. The walk leaves both out.
const BUILDER = 'test/support/profiles.mjs';
const SELF = 'test/profile-terms.test.mjs';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = [...trackedFiles(ROOT)].filter((f) => f.startsWith('test/') && /\.(mjs|cjs|js)$/.test(f)).sort();

// The terms a profile text lacks, by name.
function missingTerms(text, home = realHome()) {
  const missing = BOUNDARY_TERMS.storePaths.filter((rel) => !deniesReadWrite(text, path.join(home, rel)));
  const exec = text.split('\n').some((line) => line.startsWith('(deny process-exec') && line.includes(`(literal "${KEYCHAIN_TOOL}")`));
  return exec ? missing : [...missing, KEYCHAIN_TOOL];
}

test('the judge flags a profile with one term removed, each term in turn', () => {
  const text = outerProfileText([]);
  assert.deepEqual(missingTerms(text), []);
  const home = realHome();
  for (const [rel, cut] of [
    ['.secretless-ai', (t) => t.replace(` (subpath "${path.join(home, '.secretless-ai')}")`, '')],
    ['Library/Keychains', (t) => t.replace(` (subpath "${path.join(home, 'Library/Keychains')}")`, '')],
    [KEYCHAIN_TOOL, (t) => t.replace(`(deny process-exec (literal "${KEYCHAIN_TOOL}"))\n`, '')],
  ]) {
    const mutant = cut(text);
    assert.notEqual(mutant, text, rel);
    assert.deepEqual(missingTerms(mutant), [rel], rel);
  }
  assert.deepEqual(missingTerms(text.replace('(deny file-read* file-write* ', '(deny file-write* ')), [...BOUNDARY_TERMS.storePaths], 'a write deny alone does not refuse reads');
});

test('every profile a test writes by hand carries the terms in its own text', (t) => {
  const home = realHome();
  const flagged = [];
  let seen = 0;
  for (const f of code.filter((x) => x !== BUILDER && x !== SELF)) {
    for (const l of scan(read(f)).literals) {
      if (!l.value.trimStart().startsWith('(version 1)')) continue;
      seen += 1;
      const missing = missingTerms(l.value, home);
      if (missing.length > 0) flagged.push(`${f}:${l.line}: ${missing.join(', ')}`);
    }
  }
  t.diagnostic(`${seen} hand written profiles, ${flagged.length} flagged`);
  assert.deepEqual(flagged, []);
  // The walk reads a hand written profile: one planted here is flagged.
  const planted = scan('const p = `(version 1)\\n(allow default)\\n(deny process-exec (literal "${x}"))\\n`;\n').literals;
  assert.equal(planted.length, 1);
  assert.deepEqual(missingTerms(planted[0].value, home), [...BOUNDARY_TERMS.storePaths, KEYCHAIN_TOOL]);
});

test('each profile builder carries the terms: the tests\' own, the page cell\'s, the harness profile and a component profile in each form the tests use', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-terms-')));
  try {
    const execPath = realExecPath();
    const texts = {
      'outer, no lines': outerProfileText([]),
      'outer, one line': outerProfileText([`(deny process-exec (literal "${path.join(dir, 'true')}"))`]),
      'page cell': pageCellProfile(),
      harness: harnessProfile({ runId: 't', sentinelDir: path.join(dir, 'sentinel'), execControl: path.join(dir, 'true') }),
      component: componentProfile({ runId: 't', execPath }),
      'component, ports, socket and sentinel': componentProfile({ runId: 't', execPath, tcpPorts: [9], unixSubpath: dir, sentinelDir: path.join(dir, 'sentinel') }),
      'component, read and write denies': componentProfile({ runId: 't', execPath, denyReadSubpaths: [path.join(dir, 'r')], denyWriteSubpaths: [path.join(dir, 'w')] }),
    };
    for (const [name, text] of Object.entries(texts)) assert.deepEqual(missingTerms(text), [], name);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the profile the offline check writes, as it wrote it, under the edits the headless rerun applies', () => {
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/bank-demo-test-'));
  try {
    for (const [name, edits] of [['no edit', {}], ['loopback widened, sentinel dropped', { widenLoopback: true, dropSentinel: true }]]) {
      const home = path.join(dir, `${name.length}-home`);
      const tmp = path.join(dir, `${name.length}-tmp`);
      fs.mkdirSync(home, { mode: 0o700 });
      fs.mkdirSync(tmp, { mode: 0o700 });
      const r = spawnSync(realExecPath(), [HEADLESS, JSON.stringify({ sandboxExec: '/usr/bin/false', open: false, ...edits })], {
        env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: tmp, LANG: 'C', TZ: 'UTC' },
        cwd: dir,
        encoding: 'utf8',
        timeout: 240000,
      });
      assert.ok(r.stdout.trim(), `${name}: no answer from the headless rerun: ${r.stderr}`);
      const written = fs.readdirSync(tmp).map((n) => path.join(tmp, n, 'egress.sb')).filter((f) => fs.existsSync(f));
      assert.equal(written.length, 1, `${name}: one profile written`);
      assert.deepEqual(missingTerms(fs.readFileSync(written[0], 'utf8')), [], name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Records each profile handed to sandbox-exec, or to a stand in for it, in
// the runner's process, then starts /usr/bin/false in its place.
function recorder(file, log) {
  fs.writeFileSync(file, [
    "'use strict';",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const cp = require('node:child_process');",
    `const LOG = ${JSON.stringify(log)};`,
    "const site = () => { const s = new Error().stack.split('\\n').find((l) => l.includes('/test/') && !l.includes('.cjs')); return s ? s.trim() : null; };",
    "const handed = (cmd, args) => Array.isArray(args) && typeof args[1] === 'string' && (args[0] === '-f' || args[0] === '-p') && (path.basename(String(cmd)) === 'sandbox-exec' || String(args[3] ?? '').endsWith('rerun.mjs'));",
    "for (const fn of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {",
    '  const orig = cp[fn];',
    '  cp[fn] = function (cmd, args, ...rest) {',
    '    if (!handed(cmd, args)) return orig.call(this, cmd, args, ...rest);',
    '    let text = null;',
    "    if (args[0] === '-p') text = args[1]; else { try { text = fs.readFileSync(args[1], 'utf8'); } catch { text = null; } }",
    "    fs.appendFileSync(LOG, JSON.stringify({ fn, form: args[0], check: String(args[3] ?? '').endsWith('rerun.mjs'), text, site: site() }) + '\\n');",
    "    return orig.call(this, '/usr/bin/false', [], ...rest);",
    '  };',
    '}',
    '',
  ].join('\n'));
}

test('every profile the runners of the offline check\'s edits hand sandbox-exec carries the terms, the check\'s profile under each edit included', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-terms-')));
  try {
    const log = path.join(dir, 'handed.jsonl');
    const pre = path.join(dir, 'record.cjs');
    recorder(pre, log);
    spawnSync(process.execPath, ['--require', pre, '--test', '--test-concurrency=1', '--test-timeout=30000', ...EDIT_RUNNERS], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.userInfo().homedir, TMPDIR: os.tmpdir(), LANG: 'C', TZ: 'UTC' },
      encoding: 'utf8',
      timeout: 900000,
    });
    const handed = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    const edits = EDIT_RUNNERS.reduce((n, f) => n + (scan(read(f)).src.match(/\beditProfile\s*:/g) ?? []).length, 0);
    const checks = handed.filter((h) => h.check).length;
    t.diagnostic(`${handed.length} profiles handed, ${checks} of them the check's, ${edits} edit sites`);
    assert.ok(checks >= edits, `the run handed ${checks} check profiles for ${edits} edit sites`);
    assert.deepEqual(handed.map((h) => ({ site: h.site, missing: h.text === null ? ['unreadable'] : missingTerms(h.text) })).filter((h) => h.missing.length > 0), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
