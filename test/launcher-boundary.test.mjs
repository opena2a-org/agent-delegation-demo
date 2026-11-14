// The launcher's process loads node: built-ins and the demo's own files under
// bin/ and src/, and nothing else. A walk of its module graph from
// bin/start.mjs, read as text, finds no bare specifier and no import or
// require whose argument is not a literal, which is what makes the walk
// complete. A package import added to any file of the graph, or an import of
// the bank's broker, turns it red. No file of the graph names a sandbox mode,
// so every run the launcher's process creates takes the run's default. The
// refusal lines of the start checks are written once, in one module whose
// name and specifier name neither the sandbox nor the offline check, and the
// platforms it starts on are the families the README lists.
//
// The same holds for every process that starts parts under their profiles:
// each package.json script whose file's graph reaches the orchestrator is a
// root, npm start and npm run scenarios today, and each root is walked.
// Before the checks pass a root evaluates its static imports and those of the
// start checks, and that set holds neither the orchestrator nor the scenario
// engine. A script that starts parts is exactly node <file>.
//
// This file imports node: modules and nothing else: it reads the demo's
// files as text and runs none of them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'bin/start.mjs');
const CHECKS = path.join(ROOT, 'src/start/checks.mjs');
const OWN = [path.join(ROOT, 'bin') + path.sep, path.join(ROOT, 'src') + path.sep];
const rel = (f) => path.relative(ROOT, f);

// A file's code with its comments removed, each string literal replaced by
// "@<n>" (its value is strings[n]), each template literal with a ${...} part
// by __template__, and each regular expression literal by __regex__: an
// import( or require( inside a string, a comment or a pattern is not code.
function scan(text) {
  let src = '';
  const strings = [];
  let i = 0;
  const regexMayStart = () => {
    const before = src.trimEnd();
    return before === '' || '(,=:[!&|?{};+-*%<>~^'.includes(before.at(-1)) || /\b(return|typeof|case|in|of|delete|void|throw|new|await|yield)$/.test(before);
  };
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; src += ' '; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      let v = '';
      while (j < text.length && text[j] !== c && text[j] !== '\n') {
        if (text[j] === '\\') { v += text[j + 1] ?? ''; j += 2; } else { v += text[j]; j += 1; }
      }
      strings.push(v);
      src += `"@${strings.length - 1}"`;
      i = j + 1;
      continue;
    }
    if (c === '`') {
      let j = i + 1;
      let v = '';
      let depth = 0;
      let parts = false;
      while (j < text.length) {
        if (text[j] === '\\') { v += text[j + 1] ?? ''; j += 2; continue; }
        if (depth === 0 && text[j] === '`') break;
        if (text[j] === '$' && text[j + 1] === '{') { parts = true; depth += 1; j += 2; continue; }
        if (depth > 0 && text[j] === '{') depth += 1;
        if (depth > 0 && text[j] === '}') depth -= 1;
        v += text[j];
        j += 1;
      }
      if (parts) src += '__template__';
      else { strings.push(v); src += `"@${strings.length - 1}"`; }
      i = j + 1;
      continue;
    }
    if (c === '/' && regexMayStart()) {
      let j = i + 1;
      let inClass = false;
      while (j < text.length && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) break;
        j += 1;
      }
      j += 1;
      while (j < text.length && /[a-z]/i.test(text[j])) j += 1;
      src += ' __regex__ ';
      i = j;
      continue;
    }
    src += c;
    i += 1;
  }
  return { src, strings };
}

// Every specifier a file names: static import and export ... from, a bare
// import, dynamic import(), require(), and a createRequire(...)(...) call
// whose argument is a constant this file sets to path.join(ROOT, '<file>'),
// with ROOT the repository root.
function specifiers(text, file) {
  const { src, strings } = scan(text);
  const literal = (arg) => {
    const m = /^\s*"@(\d+)"\s*$/.exec(arg);
    return m ? strings[Number(m[1])] : null;
  };
  const found = [];
  // A static import is linked, and its file evaluated, before any code of the
  // file that names it runs.
  for (const m of src.matchAll(/^\s*(?:import|export)\b[^;"]*?\bfrom\s*"@(\d+)"/gm)) found.push({ spec: strings[Number(m[1])], static: true });
  for (const m of src.matchAll(/^\s*import\s*"@(\d+)"/gm)) found.push({ spec: strings[Number(m[1])], static: true });
  for (const m of src.matchAll(/(?<![.\w$])import\s*\(([^()]*)\)/g)) {
    const s = literal(m[1]);
    found.push(s === null ? { nonLiteral: `import(${m[1].trim()})` } : { spec: s });
  }
  for (const m of src.matchAll(/(?<![.\w$])require\s*\(([^()]*)\)/g)) {
    const s = literal(m[1]);
    found.push(s === null ? { nonLiteral: `require(${m[1].trim()})` } : { spec: s });
  }
  for (const m of src.matchAll(/\bcreateRequire\s*\([^()]*\)\s*\(([^()]*)\)/g)) {
    const arg = m[1].trim();
    const s = literal(arg);
    if (s !== null) { found.push({ spec: s }); continue; }
    const bound = /^[A-Za-z_$][\w$]*$/.test(arg) ? new RegExp(`\\bconst\\s+${arg}\\s*=\\s*path\\.join\\(\\s*ROOT\\s*,\\s*"@(\\d+)"\\s*\\)`).exec(src) : null;
    const root = /\bconst\s+ROOT\s*=\s*path\.resolve\(\s*path\.dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)\s*,\s*"@(\d+)"\s*\)/.exec(src);
    const rootDir = root ? path.resolve(path.dirname(file), strings[Number(root[1])]) : null;
    if (bound && rootDir === ROOT) found.push({ file: path.join(ROOT, strings[Number(bound[1])]) });
    else found.push({ nonLiteral: `createRequire(...)(${arg})` });
  }
  return found;
}

// The graph from one file: the files it reaches, and each bare specifier,
// non-literal import and file outside bin/ and src/ it names. read lets a
// test hand in a changed text for a file. With staticOnly the walk follows
// static imports alone: the files evaluated before the entry's code runs.
function walk(entry, read = (f) => fs.readFileSync(f, 'utf8'), { staticOnly = false } = {}) {
  const files = [];
  const bare = [];
  const nonLiteral = [];
  const outside = [];
  const todo = [entry];
  while (todo.length) {
    const f = todo.shift();
    if (files.includes(f)) continue;
    files.push(f);
    if (f.endsWith('.json')) continue;
    for (const s of specifiers(read(f), f)) {
      if (staticOnly && !s.static) continue;
      if (s.nonLiteral) { nonLiteral.push(`${rel(f)}: ${s.nonLiteral}`); continue; }
      let target = s.file ?? null;
      if (!target) {
        if (s.spec.startsWith('node:')) continue;
        if (!s.spec.startsWith('./') && !s.spec.startsWith('../') && !s.spec.startsWith('/')) { bare.push(`${rel(f)}: ${s.spec}`); continue; }
        target = path.resolve(path.dirname(f), s.spec);
      }
      if (!OWN.some((d) => target.startsWith(d)) || !fs.existsSync(target)) { outside.push(`${rel(f)}: ${rel(target)}`); continue; }
      todo.push(target);
    }
  }
  return { files, bare, nonLiteral, outside };
}

test("the launcher's graph: node: built-ins and the demo's own files, with no package import and no non-literal import", (t) => {
  const g = walk(ENTRY);
  t.diagnostic(`${g.files.length} files, ${g.bare.length} package imports, ${g.nonLiteral.length} non-literal imports`);
  assert.deepEqual(g.bare, []);
  assert.deepEqual(g.nonLiteral, []);
  assert.deepEqual(g.outside, []);
  const files = g.files.map(rel);
  for (const f of ['bin/start.mjs', 'src/start/checks.mjs', 'src/server/main.mjs', 'src/orchestrator/run.mjs', 'src/egress/counter.cjs']) assert.ok(files.includes(f), `${f} is in the graph`);
  // The components and the rerun run in processes of their own, never here.
  for (const f of ['src/bank/main.mjs', 'src/bank/broker.mjs', 'src/bank/path-b.mjs', 'src/agent/main.mjs', 'src/egress/rerun.mjs']) assert.equal(files.includes(f), false, `${f} is not in the graph`);
});

test("the launcher's graph, mutant: a package import added to any file of the graph turns the walk red", () => {
  const { files } = walk(ENTRY);
  const line = "import { LocalAtxVerifier } from '@opena2a/atx-verify';\n";
  const missed = [];
  for (const target of files.filter((f) => !f.endsWith('.json'))) {
    const g = walk(ENTRY, (f) => (f === target ? line : '') + fs.readFileSync(f, 'utf8'));
    if (!g.bare.includes(`${rel(target)}: @opena2a/atx-verify`)) missed.push(rel(target));
  }
  assert.deepEqual(missed, []);
  assert.ok(files.length > 1);
});

test("the launcher's graph, mutant: an import of the bank's broker from any file of the graph brings package imports in", () => {
  const { files } = walk(ENTRY);
  const missed = [];
  for (const target of files.filter((f) => !f.endsWith('.json'))) {
    let spec = path.relative(path.dirname(target), path.join(ROOT, 'src/bank/broker.mjs'));
    if (!spec.startsWith('.')) spec = `./${spec}`;
    const g = walk(ENTRY, (f) => (f === target ? `import '${spec}';\n` : '') + fs.readFileSync(f, 'utf8'));
    if (!g.files.includes(path.join(ROOT, 'src/bank/broker.mjs')) || g.bare.length === 0) missed.push(rel(target));
  }
  assert.deepEqual(missed, []);
});

test('the walk reads past comments, strings and patterns, and counts a dynamic import or a require whose argument is not a literal', () => {
  const texts = new Map([[ENTRY, [
    "import fs from 'node:fs';",
    "// import x from 'left-pad';",
    "/* require('left-pad') */",
    "const s = 'import(\"in-a-string\")';",
    "const t = `require('in-a-template')`;",
    'const q = /"import\\("in-a-pattern"\\)/g;',
    'const m = await import(name);',
    'const r = require(`${x}`);',
    "await import('../src/walk-probe-absent.mjs');",
    "import pad from 'left-pad';",
    '',
  ].join('\n')]]);
  const g = walk(ENTRY, (file) => texts.get(file) ?? '');
  assert.deepEqual(g.bare, ['bin/start.mjs: left-pad']);
  assert.deepEqual(g.nonLiteral, ['bin/start.mjs: import(name)', 'bin/start.mjs: require(__template__)']);
  assert.deepEqual(g.outside, ['bin/start.mjs: src/walk-probe-absent.mjs'], 'a file that does not exist is not one of the demo files');
});

test("no file of the launcher's graph names a sandbox mode, so each run it creates takes the run's default, required on macOS; neither the mode nor the sandbox's status reads the environment", () => {
  const { files } = walk(ENTRY);
  const named = [];
  for (const f of files) {
    const { src, strings } = scan(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\bsandbox\s*:\s*(?:"@(\d+)"|__template__)/g)) named.push(`${rel(f)}: ${m[1] === undefined ? 'a template' : strings[Number(m[1])]}`);
  }
  assert.deepEqual(named, []);
  const run = fs.readFileSync(path.join(ROOT, 'src/orchestrator/run.mjs'), 'utf8');
  assert.match(run, /constructor\(\{ sandbox = process\.platform === 'darwin' \? 'required' : 'auto',/);
  for (const f of ['src/orchestrator/run.mjs', 'src/orchestrator/sandbox.mjs']) {
    assert.equal(/process\.env/.test(scan(fs.readFileSync(path.join(ROOT, f), 'utf8')).src), false, `${f} reads no environment variable`);
  }
});

// The draft lines of the platform refusal and of the three refusals that
// name why the parts cannot start under their profiles.
const DRAFTS = [
  'This demo does not run on ${',
  'Fix: run it on a platform listed under Requirements in the README.',
  'This terminal is inside another sandbox, so the demo cannot start its parts in their own macOS sandboxes.',
  'Fix: open a terminal window that is not inside another sandbox, then run: npm start',
  'This Mac has no /usr/bin/sandbox-exec, which the demo needs to start its parts in their own sandboxes.',
  'Fix: run it on a Mac with the macOS version the README lists.',
  'macOS refused the sandbox profile of ${',
  ', so the demo did not start.',
  'Log: ${log}',
];

function sourceFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { recursive: true })
    .map((f) => path.join(ROOT, dir, f))
    .filter((f) => /\.(mjs|cjs|js|json)$/.test(f) && fs.statSync(f).isFile());
}

test('the refusal lines of the start checks are written once, in src/start/checks.mjs, whose name and specifiers name neither the sandbox nor the offline check; the launcher keeps its Windows lines, its three ready lines and Stopped.', () => {
  const where = Object.fromEntries(DRAFTS.map((d) => [d, []]));
  for (const f of sourceFiles('src')) {
    const text = fs.readFileSync(f, 'utf8');
    for (const d of DRAFTS) for (let i = text.indexOf(d); i >= 0; i = text.indexOf(d, i + 1)) where[d].push(rel(f));
  }
  for (const d of DRAFTS) assert.deepEqual(where[d], ['src/start/checks.mjs'], d);
  assert.equal(/sandbox|offline/i.test(rel(CHECKS)), false);
  const start = fs.readFileSync(ENTRY, 'utf8');
  const text = fs.readFileSync(path.join(ROOT, 'src/runner/text.mjs'), 'utf8');
  assert.ok(start.includes("await import('../src/start/checks.mjs')"));
  assert.ok(text.includes("from '../start/checks.mjs'"));
  // The component exit lines keep their own Log line.
  for (const d of DRAFTS.slice(2, -1)) assert.equal(start.includes(d), false, `bin/start.mjs: ${d}`);
  for (const kept of [
    "refuse(['This demo does not run on Windows.', 'Fix: run it on a platform listed under Requirements in the README.']);",
    'process.stdout.write(`Agent banking delegation demo, ${launcherBuildLabel()}\\n`);',
    'process.stdout.write(`Ready. Open http://127.0.0.1:${port}/ in a browser.\\n`);',
    "process.stdout.write('Press Ctrl+C to stop.\\n');",
    "const stop = async (code, lines = ['Stopped.']) => {",
  ]) assert.ok(start.includes(kept), kept);
});

test('the start checks start on the platform families the README lists under Requirements, and on no other', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const requirements = /^Requirements: ([^.]*)\./m.exec(readme)?.[1];
  assert.ok(requirements, 'a Requirements line');
  const FAMILIES = { macOS: 'darwin', Linux: 'linux', Windows: 'win32', FreeBSD: 'freebsd' };
  const listed = Object.entries(FAMILIES).filter(([family]) => new RegExp(`\\b${family}\\b`).test(requirements)).map(([, p]) => p);
  const m = /export const PLATFORMS = Object\.freeze\(\[([^\]]*)\]\)/.exec(fs.readFileSync(CHECKS, 'utf8'));
  assert.ok(m, 'the start checks name their platforms');
  const platforms = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(platforms, listed);
  assert.deepEqual(platforms, ['darwin']);
});

// The roots: every package.json script that runs node on a file whose graph
// reaches the orchestrator, which starts the parts. They are read from the
// scripts and never typed here, so a script added later is walked too.
const RUN = path.join(ROOT, 'src/orchestrator/run.mjs');
const ENGINE = path.join(ROOT, 'src/scenarios/engine.mjs');
const fromDisk = (f) => fs.readFileSync(f, 'utf8');
const PKG = () => fromDisk(path.join(ROOT, 'package.json'));

function roots(pkgText, read = fromDisk) {
  const found = [];
  for (const [script, command] of Object.entries(JSON.parse(pkgText).scripts ?? {})) {
    for (const word of command.split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ''))) {
      const file = path.join(ROOT, word);
      if (!/\.(mjs|cjs|js)$/.test(word) || !fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      if (walk(file, read).files.includes(RUN)) found.push({ script, command, file });
    }
  }
  return found;
}

// The files of a graph that import node:child_process.
function childProcessCensus(files, read = fromDisk) {
  return files.filter((f) => !f.endsWith('.json') && specifiers(read(f), f).some((s) => s.spec === 'node:child_process')).map(rel).sort();
}

// Each root's graph: no package import, no non-literal import, no file
// outside bin/ and src/ and neither of the bank's broker files. In the
// scenarios graph the start checks, for their probe, and the orchestrator,
// for the parts, are the two files that import node:child_process.
function rootProblems(pkgText, read = fromDisk) {
  const problems = [];
  for (const { script, file } of roots(pkgText, read)) {
    const g = walk(file, read);
    for (const b of g.bare) problems.push(`${script}: package import ${b}`);
    for (const n of g.nonLiteral) problems.push(`${script}: non-literal ${n}`);
    for (const o of g.outside) problems.push(`${script}: outside bin/ and src/ ${o}`);
    for (const f of ['src/bank/broker.mjs', 'src/bank/path-b.mjs']) if (g.files.includes(path.join(ROOT, f))) problems.push(`${script}: ${f} is in the graph`);
    if (script === 'scenarios') {
      const census = childProcessCensus(g.files, read);
      if (census.join(' ') !== 'src/orchestrator/run.mjs src/start/checks.mjs') problems.push(`scenarios: node:child_process is imported by ${census.join(', ')}`);
    }
  }
  return problems;
}

// The files that can be evaluated before the checks pass: the entry's static
// closure, with the static closure of the start checks, which each entry
// loads before any other file of the demo.
function preCheckSet(entry, read = fromDisk) {
  // A tree without the start checks adds none of their files, and fails the pin.
  const checks = fs.existsSync(CHECKS) ? walk(CHECKS, read, { staticOnly: true }).files : [];
  const files = new Set([...walk(entry, read, { staticOnly: true }).files, ...checks]);
  return [...files].map(rel).sort();
}

function preCheckProblems(pkgText, read = fromDisk) {
  const problems = [];
  for (const { script, file } of roots(pkgText, read)) {
    const set = preCheckSet(file, read);
    const want = [rel(file), 'src/egress/classify.mjs', 'src/orchestrator/sandbox.mjs', 'src/start/checks.mjs'].sort();
    if (set.join(' ') !== want.join(' ')) problems.push(`${script}: ${set.length} files before the checks pass: ${set.join(', ')}`);
    for (const f of [RUN, ENGINE]) if (set.includes(rel(f))) problems.push(`${script}: ${rel(f)} is evaluated before the checks pass`);
  }
  return problems;
}

// Every script that starts parts is exactly node <file>: no Node.js flag, so
// no preload or loader reaches the process that starts them.
function scriptFormProblems(pkgText, read = fromDisk) {
  return roots(pkgText, read)
    .filter(({ command, file }) => {
      const m = /^node ([^\s-]\S*)$/.exec(command);
      return !m || path.join(ROOT, m[1]) !== file;
    })
    .map(({ script, command }) => `${script}: ${command}`);
}

// A changed text for one file, the file on disk for every other.
const withText = (target, change) => (f) => (f === target ? change(fromDisk(f)) : fromDisk(f));

test('the roots are read from package.json, every script that runs node on a file whose graph reaches the orchestrator, start and scenarios today; each graph holds no package import, no non-literal import, no file outside bin/ and src/ and neither broker file, and in the scenarios graph the start checks and the orchestrator are the two files that import node:child_process', (t) => {
  const found = roots(PKG());
  t.diagnostic(`roots: ${found.map((r) => `${r.script} (${rel(r.file)}, ${walk(r.file).files.length} files)`).join(', ')}`);
  const scripts = found.map((r) => r.script);
  assert.ok(scripts.includes('start') && scripts.includes('scenarios'), `roots: ${scripts.join(' ')}`);
  assert.deepEqual(rootProblems(PKG()), []);
});

test("the files each root can evaluate before the checks pass, its static closure with the start checks', are the entry, src/start/checks.mjs, src/orchestrator/sandbox.mjs and src/egress/classify.mjs, never the orchestrator or the scenario engine", (t) => {
  for (const { script, file } of roots(PKG())) t.diagnostic(`${script}: ${preCheckSet(file).join(', ')}`);
  assert.deepEqual(preCheckProblems(PKG()), []);
});

test('every package.json script that starts parts is exactly node <file>, with no Node.js flag', () => {
  assert.ok(roots(PKG()).length >= 2);
  assert.deepEqual(scriptFormProblems(PKG()), []);
});

test('mutant m1: a package import prepended to src/runner/columns.mjs, a file of the scenarios graph, turns the roots check red', (t) => {
  const read = withText(path.join(ROOT, 'src/runner/columns.mjs'), (s) => `import 'left-pad';\n${s}`);
  t.diagnostic(`the walk from bin/start.mjs reads ${walk(ENTRY, read).bare.length} package imports`);
  const problems = rootProblems(PKG(), read);
  assert.ok(problems.includes('scenarios: package import src/runner/columns.mjs: left-pad'), problems.join('; '));
});

test("mutant m2: the scenario engine imported statically by the scenarios entry, in place of its dynamic import, turns the pre-check set red", (t) => {
  const entry = path.join(ROOT, 'src/runner/text.mjs');
  const dynamic = "const { STEP_TITLES, runChain } = await import('../scenarios/engine.mjs');";
  assert.ok(fromDisk(entry).includes(dynamic), 'the entry imports the engine after its checks');
  const read = withText(entry, (s) => s.replace(dynamic, "import { STEP_TITLES, runChain } from '../scenarios/engine.mjs';"));
  t.diagnostic(`the scenarios entry's static closure: ${walk(entry, read, { staticOnly: true }).files.length} files`);
  const problems = preCheckProblems(PKG(), read);
  for (const f of ['src/orchestrator/run.mjs', 'src/scenarios/engine.mjs']) assert.ok(problems.includes(`scenarios: ${f} is evaluated before the checks pass`), problems.join('; '));
});

test('mutant m2b: the orchestrator imported by the start checks turns the pre-check set red for every root', (t) => {
  const read = withText(CHECKS, (s) => `import '../orchestrator/run.mjs';\n${s}`);
  t.diagnostic(`the start checks' static closure: ${walk(CHECKS, read, { staticOnly: true }).files.length} files`);
  const problems = preCheckProblems(PKG(), read);
  for (const script of ['start', 'scenarios']) assert.ok(problems.includes(`${script}: src/orchestrator/run.mjs is evaluated before the checks pass`), problems.join('; '));
});

test('mutant m3: node:child_process imported by the scenario engine turns the scenarios census red', () => {
  const read = withText(ENGINE, (s) => `import { spawn } from 'node:child_process';\n${s}`);
  const problems = rootProblems(PKG(), read);
  assert.ok(problems.some((p) => p.startsWith('scenarios: node:child_process is imported by') && p.includes('src/scenarios/engine.mjs')), problems.join('; '));
});

test('mutant m4: a scenarios script with a Node.js flag before its file turns the script form red', () => {
  const pkg = JSON.parse(PKG());
  pkg.scripts.scenarios = 'node --require ./x.cjs src/runner/text.mjs';
  assert.deepEqual(scriptFormProblems(JSON.stringify(pkg)), ['scenarios: node --require ./x.cjs src/runner/text.mjs']);
});
