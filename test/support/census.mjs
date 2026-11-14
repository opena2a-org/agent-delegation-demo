// The install census: what in an installed tree would run at install time.
// It walks every package directory under node_modules, nested ones included,
// reads each package.json for an install script and looks at each package's
// root for a binding.gyp. A package that carries a binding.gyp and no script
// gets no hasInstallScript flag in the lockfile, yet npm builds it with
// node-gyp when scripts run, so the lockfile's flags are counted beside the
// walk and never in its place.

import fs from 'node:fs';
import path from 'node:path';

export const INSTALL_SCRIPTS = Object.freeze(['preinstall', 'install', 'postinstall']);
// The root package's install hooks: every pre and post script, and these.
export const ROOT_HOOKS = Object.freeze(['preinstall', 'install', 'postinstall', 'prepare']);

export function rootHookKeys(pkg) {
  return Object.keys(pkg.scripts ?? {}).filter((k) => /^(pre|post)/.test(k) || ROOT_HOOKS.includes(k));
}

const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');

// Every package directory under <root>/node_modules (name, or @scope/name),
// and under each package's own node_modules, at any depth. A linked package
// is visited once, at the path its link sits at.
export function packageDirs(root) {
  const out = [];
  const seen = new Set();
  const isDir = (p) => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  };
  const visit = (dir) => {
    const real = fs.realpathSync(dir);
    if (seen.has(real)) return;
    seen.add(real);
    out.push(dir);
    walk(path.join(dir, 'node_modules'));
  };
  const walk = (nm) => {
    if (!isDir(nm)) return;
    for (const name of fs.readdirSync(nm).sort()) {
      if (name.startsWith('.')) continue;
      const p = path.join(nm, name);
      if (!isDir(p)) continue;
      if (name.startsWith('@')) {
        for (const sub of fs.readdirSync(p).sort()) if (isDir(path.join(p, sub))) visit(path.join(p, sub));
      } else {
        visit(p);
      }
    }
  };
  walk(path.join(root, 'node_modules'));
  return out;
}

export function installCensus(root) {
  const dirs = packageDirs(root);
  const scripted = [];
  const gyp = [];
  const noManifest = [];
  for (const dir of dirs) {
    const file = path.join(dir, 'package.json');
    if (!fs.existsSync(file)) {
      noManifest.push(rel(root, dir));
      continue;
    }
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (INSTALL_SCRIPTS.some((s) => typeof pkg.scripts?.[s] === 'string')) scripted.push(rel(root, dir));
    if (fs.existsSync(path.join(dir, 'binding.gyp'))) gyp.push(rel(root, dir));
  }
  const rootHooks = rootHookKeys(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const lockfileFlags = Object.entries(lock.packages ?? {}).filter(([k, v]) => k !== '' && v.hasInstallScript === true).map(([k]) => k);
  return {
    packages: dirs.map((d) => rel(root, d)),
    scripted,
    gyp,
    noManifest,
    rootHooks,
    lockfileFlags,
    installSteps: new Set([...scripted, ...gyp]).size,
  };
}

export const censusLine = (c) => `scripts ${c.scripted.length}, gyp ${c.gyp.length}, lockfile flags ${c.lockfileFlags.length}`;

// The positive control's tree: one package that declares an install script,
// scoped, and one that carries a binding.gyp and nothing else, nested under a
// third package that has neither. The lockfile flags the scripted one alone,
// the way npm writes it. A walker that sees both counts 2.
export const FIXTURE_INSTALL_STEPS = 2;

export function writeCensusFixture(dir) {
  const put = (file, value) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  put('package.json', { name: 'census-fixture', version: '1.0.0', private: true });
  put('node_modules/@fixture/scripted/package.json', { name: '@fixture/scripted', version: '1.0.0', scripts: { postinstall: 'node -e 0' } });
  put('node_modules/host/package.json', { name: 'host', version: '1.0.0' });
  put('node_modules/host/node_modules/gyp-built/package.json', { name: 'gyp-built', version: '1.0.0' });
  put('node_modules/host/node_modules/gyp-built/binding.gyp', '{ "targets": [] }\n');
  put('package-lock.json', {
    name: 'census-fixture',
    lockfileVersion: 3,
    packages: {
      '': { name: 'census-fixture', version: '1.0.0' },
      'node_modules/@fixture/scripted': { version: '1.0.0', hasInstallScript: true },
      'node_modules/host': { version: '1.0.0' },
      'node_modules/host/node_modules/gyp-built': { version: '1.0.0' },
    },
  });
  return dir;
}

export function controlProblems(census) {
  return census.installSteps === FIXTURE_INSTALL_STEPS ? [] : [`the walker counts ${census.installSteps} on the fixture tree; it must count ${FIXTURE_INSTALL_STEPS}`];
}
