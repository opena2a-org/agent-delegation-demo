// The build the footer, the launcher's Ready line and the capture sidecars
// name: one function, run against the repository root whatever the working
// directory, with changes under docs/captures/ and nowhere else left out.
// Each case builds a scratch repository holding the function and the footer
// code, changes one file and reads the footer from a process whose working
// directory is src/.

import './support/outer-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfo, launcherBuildLabel } from '../src/build-info.mjs';
import { footerLeftParts, footerProvenance } from '../src/view/footer.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
const RUN = { runId: 'c20f0231', ranAtUtc: '2026-10-24 04:08:45' };

function git(dir, args) {
  return execFileSync('git', ['-C', dir, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Demo test', '-c', 'user.email=demo-test@example.test', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A repository with the function, the footer code and the copy, committed.
function scratchRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/bank-demo-build-'));
  for (const rel of ['src/build-info.mjs', 'src/view/fill.mjs', 'src/view/footer.mjs', 'src/view/copy.json']) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  fs.mkdirSync(path.join(dir, 'docs/demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/demo/walk.mjs'), '// walk\n');
  git(dir, ['init', '-q']);
  git(dir, ['add', '--', 'src', 'docs']);
  git(dir, ['commit', '-q', '-m', 'scratch']);
  return dir;
}

// The footer and the launcher label as a process with its working directory
// in src/ computes them.
function fromSrc(dir) {
  const script = [
    "import fs from 'node:fs';",
    "const { buildInfo, launcherBuildLabel } = await import('./build-info.mjs');",
    "const { footerProvenance } = await import('./view/footer.mjs');",
    "const copy = JSON.parse(fs.readFileSync('./view/copy.json', 'utf8'));",
    'const info = buildInfo();',
    `const run = ${JSON.stringify(RUN)};`,
    'process.stdout.write(JSON.stringify({ cwd: process.cwd(), info, footer: footerProvenance(copy, info, run), idle: footerProvenance(copy, info, null), launcher: launcherBuildLabel(info) }));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: path.join(dir, 'src'), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('from a working directory in src/, one file outside it modified: the footer and the launcher read (modified)', () => {
  const dir = scratchRepo();
  const sha7 = git(dir, ['rev-parse', '--short=7', 'HEAD']);
  const clean = fromSrc(dir);
  assert.equal(clean.cwd, path.join(dir, 'src'));
  assert.deepEqual(clean.info, { fromGit: true, sha7, modified: false });
  assert.equal(clean.footer, `Build ${sha7} · Run c20f · 2026-10-24 04:08:45 UTC`);
  assert.equal(clean.idle, `Build ${sha7} · Not run yet`);
  assert.equal(clean.launcher, `build ${sha7}`);

  fs.appendFileSync(path.join(dir, 'docs/demo/walk.mjs'), '// changed\n');
  const changed = fromSrc(dir);
  assert.equal(changed.info.modified, true);
  assert.equal(changed.footer, `Build ${sha7} (modified) · Run c20f · 2026-10-24 04:08:45 UTC`);
  assert.equal(changed.idle, `Build ${sha7} (modified) · Not run yet`);
  assert.equal(changed.launcher, `build ${sha7} (modified)`);
});

test('a change under docs/captures/ leaves the build unmodified; docs/captures-old/ and docs/capturesX.txt still count', () => {
  const dir = scratchRepo();
  fs.mkdirSync(path.join(dir, 'docs/captures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/captures/00-overview.png'), 'not a real image');
  assert.equal(fromSrc(dir).info.modified, false);
  fs.mkdirSync(path.join(dir, 'docs/captures-old'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/captures-old/y.txt'), 'y');
  assert.equal(fromSrc(dir).info.modified, true);
  fs.rmSync(path.join(dir, 'docs/captures-old'), { recursive: true });
  assert.equal(fromSrc(dir).info.modified, false);
  fs.writeFileSync(path.join(dir, 'docs/capturesX.txt'), 'x');
  assert.equal(fromSrc(dir).info.modified, true);
});

test('without a .git entry the build is not from a git clone, and no sha is shown', () => {
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/bank-demo-build-'));
  const info = buildInfo(dir);
  assert.deepEqual(info, { fromGit: false, sha7: null, modified: null });
  assert.equal(launcherBuildLabel(info), 'build not from a git clone');
  assert.equal(footerProvenance(COPY, info, RUN), 'Build not from a git clone · Run c20f · 2026-10-24 04:08:45 UTC');
  assert.equal(footerProvenance(COPY, info, null), 'Build not from a git clone · Not run yet');
});

test('this checkout: one answer for the launcher and the footer', () => {
  const info = buildInfo();
  assert.equal(info.fromGit, true);
  assert.match(info.sha7, /^[0-9a-f]{7,}$/);
  assert.equal(launcherBuildLabel(info), `build ${info.sha7}${info.modified ? ' (modified)' : ''}`);
});

test('the footer refuses copy whose footer text does not begin with the fictional line and one space', () => {
  assert.deepEqual(footerLeftParts(COPY), { line: COPY.RULED_EXTRA.fictionalLine, rest: COPY.GLOBAL.footerLeft.slice(COPY.RULED_EXTRA.fictionalLine.length + 1) });
  const broken = (footerLeft) => ({ ...COPY, GLOBAL: { ...COPY.GLOBAL, footerLeft } });
  assert.throws(() => footerLeftParts(broken(`Scenarios are scripted. ${COPY.RULED_EXTRA.fictionalLine}`)));
  assert.throws(() => footerLeftParts(broken(`${COPY.RULED_EXTRA.fictionalLine}Scenarios are scripted.`)));
  assert.throws(() => footerLeftParts(broken(COPY.RULED_EXTRA.fictionalLine.toLowerCase())));
  const src = fs.readFileSync(path.join(ROOT, 'src/server/main.mjs'), 'utf8');
  assert.ok(src.includes('\nfooterLeftParts(COPY);\n'), 'the view server checks the footer text when it loads');
});

test('the launcher loads the build function after its checks, by a dynamic import', () => {
  const src = fs.readFileSync(path.join(ROOT, 'bin/start.mjs'), 'utf8');
  const imports = src.split('\n').filter((l) => /^import .* from '/.test(l));
  assert.ok(imports.every((l) => /from 'node:[a-z_/]+';$/.test(l)), imports.join('\n'));
  assert.ok(src.includes("await import('../src/build-info.mjs')"));
  assert.ok(src.indexOf("await import('../src/build-info.mjs')") > src.indexOf('npm start takes no arguments.'));
});
