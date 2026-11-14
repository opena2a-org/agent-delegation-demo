// Checks on the pinned and vendored upstream code. Each reads the files as
// committed; none needs the network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rootHookKeys } from './support/census.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/pins.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// Every npm command run in the directory reads .npmrc, so it is these three
// lines byte for byte, each ending in a newline: no registry, auth or TLS
// line is ever added to it.
const NPMRC = 'engine-strict=true\nignore-scripts=true\nomit=optional\n';
const npmrcProblems = (dir) => (fs.readFileSync(path.join(dir, '.npmrc'), 'utf8') === NPMRC ? [] : [`${dir}/.npmrc is not the three pinned lines`]);

// Every install the repository runs: npm ci with --ignore-scripts and
// --omit=optional, inside an env -i environment, and no npm_config_ value
// read from the caller's environment.
const NPM_INSTALL = /\bnpm\s+(ci|install|i)\b/;
const CALLER_NPM_CONFIG = /\$\{?npm_config_|process\.env(\.|\[['"])npm_config_/i;
const SPAWN_NPM = /\b(spawn|spawnSync|execFile|execFileSync)\(\s*['"]npm['"][^;\n]*/g;
function installProblems(files) {
  const problems = [];
  for (const { name, text } of files) {
    if (CALLER_NPM_CONFIG.test(text)) problems.push(`${name}: an npm_config_ value read from the caller's environment`);
    for (const m of text.matchAll(SPAWN_NPM)) {
      if (!/['"](ci|install|i)['"]/.test(m[0])) continue;
      if (!m[0].includes('--ignore-scripts') || !m[0].includes('--omit=optional') || !m[0].includes('env:')) problems.push(`${name}: ${m[0].trim()}: an install without both flags and an explicit environment`);
    }
    if (!name.endsWith('.sh')) continue;
    // Shell functions whose body runs its arguments under env -i.
    const wrappers = [...text.matchAll(/^(\w+)\(\)\s*\{([\s\S]*?)^\}/gm)].filter((m) => /\benv -i\b/.test(m[2])).map((m) => m[1]);
    for (const line of text.split('\n')) {
      const code = line.trim();
      if (code.startsWith('#') || code.startsWith('echo ') || !NPM_INSTALL.test(code)) continue;
      if (!code.includes('--ignore-scripts') || !code.includes('--omit=optional')) problems.push(`${name}: ${code}: an install without --ignore-scripts --omit=optional`);
      if (!code.startsWith('env -i ') && !wrappers.some((w) => code.startsWith(`${w} `))) problems.push(`${name}: ${code}: an install outside env -i`);
    }
  }
  return problems;
}
function codeFiles(dirs) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(sh|mjs|cjs|js)$/.test(e.name)) out.push({ name: path.relative(ROOT, p), text: fs.readFileSync(p, 'utf8') });
    }
  };
  for (const d of dirs) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  return out;
}

test('verify.mjs: sha256 and git blob id equal the pin record', () => {
  const file = path.join(ROOT, pins.aapConformance.vendoredPath);
  assert.equal(sha256(file), pins.aapConformance.sha256);
  const blob = execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim();
  assert.equal(blob, pins.aapConformance.blob);
  const vendored = fs.readFileSync(path.join(ROOT, 'vendor/VENDORED.md'), 'utf8');
  assert.ok(vendored.includes(pins.aapConformance.sha256));
  assert.ok(fs.existsSync(path.join(path.dirname(file), 'LICENSE')));
});

test('@noble/post-quantum: one lockfile entry at 0.6.1 with the upstream integrity, and the same pin as aap-conformance', () => {
  const entries = Object.entries(lock.packages).filter(([k]) => k.endsWith('node_modules/@noble/post-quantum'));
  assert.equal(entries.length, 1);
  assert.equal(entries[0][1].version, '0.6.1');
  assert.equal(entries[0][1].integrity, 'sha512-+pormrDZwjRw05U8ADK4JpHejo87+gBd+muRBB/ozztH5yhDLMDF4jHQWN3NQQAsu1zBNPWTG0ZwVI0CR29H0A==');
  assert.equal(pkg.dependencies['@noble/post-quantum'], pins.aapConformance.noblePostQuantum);
  for (const dep of ['ciphers', 'curves', 'hashes']) {
    assert.equal(lock.packages[`node_modules/@noble/${dep}`].version, '2.2.0', dep);
  }
});

test('package.json: exact versions, private, engines floor, no lifecycle scripts', () => {
  assert.equal(/[\^~]/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')), false);
  assert.equal(pkg.private, true);
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.engines.node, '>=22.12.0');
  assert.deepEqual(rootHookKeys(pkg), []);
  assert.deepEqual(npmrcProblems(ROOT), []);
});

test('root install hooks: preinstall, install, postinstall and prepare are refused on the root package, beside every pre and post script', () => {
  assert.deepEqual(rootHookKeys({ scripts: { start: 'x', scenarios: 'x', test: 'x' } }), []);
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare', 'prestart', 'posttest']) {
    assert.deepEqual(rootHookKeys({ scripts: { test: 'x', [k]: 'x' } }), [k], k);
  }
});

test('.npmrc: a copy with a fourth line, or without its last newline, is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-npmrc-'));
  try {
    fs.writeFileSync(path.join(dir, '.npmrc'), `${NPMRC}registry=https://registry.example.test/\n`);
    assert.notDeepEqual(npmrcProblems(dir), []);
    fs.writeFileSync(path.join(dir, '.npmrc'), NPMRC.trimEnd());
    assert.notDeepEqual(npmrcProblems(dir), []);
    fs.writeFileSync(path.join(dir, '.npmrc'), NPMRC);
    assert.deepEqual(npmrcProblems(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('installs the repository runs: npm ci --ignore-scripts --omit=optional inside env -i, and no npm_config_ value from the caller', () => {
  const files = codeFiles(['scripts', 'src', 'bin', 'test']);
  assert.ok(files.some((f) => f.name === 'scripts/vendor/build-secretless-tarball.sh'));
  assert.deepEqual(installProblems(files), []);
});

test('installs the repository runs: a script that drops --omit=optional, runs outside env -i or reads npm_config_cache from the caller is refused', () => {
  // Built from fragments, so the scan above does not read these lines as installs.
  const npm = (args) => ['np', 'm ', args].join('');
  const wrapper = 'run() {\n  env -i PATH="$PATH" HOME="$B/home" "$@"\n}\n';
  const cases = [
    ['a.sh', `${wrapper}run ${npm('ci --ignore-scripts')}\n`],
    ['b.sh', `${wrapper}${npm('ci --ignore-scripts --omit=optional')}\n`],
    ['c.sh', `${wrapper}CACHE="$${'{'}npm_config_cache:-x}"\nrun ${npm('ci --ignore-scripts --omit=optional')}\n`],
    ['d.mjs', `spawnSync('${'np'}m', ['ci', '--ignore-scripts'], { stdio: 'ignore' });\n`],
  ];
  for (const [name, text] of cases) assert.notDeepEqual(installProblems([{ name, text }]), [], name);
  assert.deepEqual(installProblems([{ name: 'e.sh', text: `${wrapper}run ${npm('ci --ignore-scripts --omit=optional')} >/dev/null\n` }]), []);
});

test('secretless-ai tarball: label, file dependency, sha256 and lockfile integrity agree', () => {
  const tgz = path.join(ROOT, pins.secretlessAi.tarball);
  assert.equal(sha256(tgz), pins.secretlessAi.sha256);
  assert.equal(pkg.dependencies['secretless-ai'], `file:${pins.secretlessAi.tarball}`);
  const entry = lock.packages['node_modules/secretless-ai'];
  assert.ok(entry.resolved.startsWith('file:vendor/'));
  assert.equal(entry.version, pins.secretlessAi.label);
  assert.match(entry.version, /-unreleased\.g[0-9a-f]{12}$/);
  assert.ok(pins.secretlessAi.commit.startsWith(entry.version.split('.g').pop()));
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tgz)).digest('base64')}`;
  assert.equal(entry.integrity, integrity);
  const installed = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/secretless-ai/package.json'), 'utf8'));
  assert.equal(installed.version, pins.secretlessAi.label);
  assert.ok(fs.readFileSync(path.join(ROOT, 'vendor/VENDORED.md'), 'utf8').includes(pins.secretlessAi.sha256));
});

test('secretless-ai tarball: content checks on the unpacked package', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkd-unpack-'));
  try {
    execFileSync('tar', ['-xzf', path.join(ROOT, pins.secretlessAi.tarball), '-C', dir]);
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p); else files.push(path.relative(dir, p));
      }
    };
    walk(dir);
    const top = files.filter((f) => !f.startsWith('package/dist/'));
    for (const f of top) assert.match(f, /^package\/(package\.json|README(\.md)?|LICENSE|CHANGELOG(\.md)?)$/);
    assert.equal(files.filter((f) => /\.test\.|\.test-support\./.test(f)).length, 0);
    let pem = 0;
    let homePaths = 0;
    let absoluteMapSources = 0;
    // Example paths written in source comments are not a machine's home path.
    const PLACEHOLDER = new Set(['user', 'you', '...']);
    for (const f of files) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) pem += 1;
      for (const m of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)/g)) if (!PLACEHOLDER.has(m[1])) homePaths += 1;
      if (f.endsWith('.map')) {
        const map = JSON.parse(text);
        for (const s of map.sources ?? []) if (s.startsWith('/')) absoluteMapSources += 1;
      }
    }
    assert.equal(pem, 0);
    assert.equal(homePaths, 0);
    assert.equal(absoluteMapSources, 0);
    const scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package/package.json'), 'utf8')).scripts ?? {};
    for (const s of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(scripts[s], undefined, s);
    // The per file manifest records every file of the unpacked package.
    const manifest = fs.readFileSync(path.join(ROOT, pins.secretlessAi.filesManifest), 'utf8').trim().split('\n');
    assert.equal(manifest.length, files.length);
    for (const line of manifest) {
      const [hash, name] = line.split(/\s+/);
      assert.equal(sha256(path.join(dir, name)), hash, name);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Built from fragments so this file does not match the pattern it holds.
const IMPORT = new RegExp(["from 'secret", "less-ai'|require\\('secret", "less-ai'\\)|dist\\/cli\\.js"].join(''));

test('the demo imports the broker module and never the package entry or its CLI', () => {
  const offenders = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|cjs|js)$/.test(e.name)) {
        const text = fs.readFileSync(p, 'utf8');
        if (IMPORT.test(text)) offenders.push(path.relative(ROOT, p));
      }
    }
  };
  for (const d of ['src', 'bin', 'scripts']) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  assert.deepEqual(offenders, []);
});

test('agent credentials: committed bytes match the pin record', () => {
  for (const [file, hash] of Object.entries(pins.atxConformance.credentials)) {
    assert.equal(sha256(path.join(ROOT, file)), hash, file);
  }
});
