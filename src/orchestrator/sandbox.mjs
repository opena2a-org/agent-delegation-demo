// macOS sandbox profiles for the processes the demo starts.
//
// Each component runs under its own profile, written per run after the
// loopback ports are fixed:
//   - outbound network is refused, except the listed loopback ports and Unix
//     sockets under the run directory;
//   - process exec is refused, except this Node.js binary (the exec deny
//     form), and the system's keychain tool is refused again by name. No
//     rule names the offline rerun's exec control, so the exec deny form
//     alone refuses it, and a refused run of the control shows that form
//     fires;
//   - reads and writes are refused on the credential store paths under the
//     real home directory, and on the run's control sentinel;
//   - the grant path agent's profile also refuses writes in the bank's
//     directory and in the repository checkout.
// A profile that already denies something cannot start a nested sandbox
// (sandbox_apply fails), so the offline rerun gets its own profile, started
// by the view server, and its children run inside it without a second one.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
// The system tool that reads the keychain.
export const KEYCHAIN_TOOL = '/usr/bin/security';

export function sandboxStatus(sandboxExec = SANDBOX_EXEC) {
  if (process.platform !== 'darwin' || !fs.existsSync(sandboxExec)) {
    return { available: false, reason: 'no sandbox on this system' };
  }
  return { available: true, reason: null };
}

// A part of a run whose profile was not applied, so it did not start. key
// names the cause by a key of the offline check's not run reasons
// (src/egress/classify.mjs NOT_RUN), and the launcher refuses the start with
// that cause's lines. log, when macOS refused the profile, names the 0600
// file that holds sandbox-exec's stderr.
export class ProfileNotApplied extends Error {
  constructor(key, { part = null, log = null } = {}) {
    super(`the profile of ${part ?? 'a part'} was not applied (${key})`);
    this.code = 'PROFILE_NOT_APPLIED';
    this.key = key;
    this.part = part;
    this.log = log;
  }
}

export function realExecPath() {
  return fs.realpathSync(process.execPath);
}

// The home directory as the password database records it, resolved; never
// HOME, which a run sets to a directory of its own.
export function realHome() {
  return resolvedPath(os.userInfo().homedir);
}

// The boundary's terms: reads and writes refused on the credential store
// paths under the real home directory, and exec refused for the keychain
// tool (by name in the harness profile; a component profile refuses every
// exec but Node.js).
export const BOUNDARY_TERMS = Object.freeze({
  storePaths: Object.freeze(['.secretless-ai', 'Library/Keychains']),
  keychainTool: '/usr/bin/security',
});

// The path as the kernel matches it, with each symbolic link in it resolved.
// For a path that does not exist yet, or that this process may not look at,
// its nearest parent that resolves is resolved and the rest appended.
export function resolvedPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('a profile path must be absolute');
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest);
    } catch (err) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code)) throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw err;
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function protectedPaths({ home = realHome(), sentinelDir = null } = {}) {
  const paths = BOUNDARY_TERMS.storePaths.map((rel) => path.join(home, rel));
  if (sentinelDir) paths.push(sentinelDir);
  return paths;
}

export function componentProfile({
  runId,
  execPath,
  tcpPorts = [],
  unixSubpath = null,
  denyReadSubpaths = [],
  denyWriteSubpaths = [],
  home = realHome(),
  sentinelDir = null,
}) {
  const lines = [
    '(version 1)',
    '(allow default)',
    `(deny network-outbound (with message ${q(`bank-demo-${runId}`)}))`,
  ];
  for (const port of tcpPorts) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`bad port ${port}`);
    lines.push(`(allow network-outbound (remote ip ${q(`localhost:${port}`)}))`);
  }
  if (unixSubpath) lines.push(`(allow network-outbound (remote unix-socket (subpath ${q(unixSubpath)})))`);
  lines.push(`(deny process-exec (with message ${q(`bank-demo-${runId}-exec`)}))`);
  lines.push(`(allow process-exec (literal ${q(execPath)}))`);
  // The keychain tool by name, besides the exec deny form above. The exec
  // control stays out of this rule: here it would be refused even with the
  // exec deny form missing.
  lines.push(`(deny process-exec (literal ${q(KEYCHAIN_TOOL)}))`);
  for (const d of denyReadSubpaths) lines.push(`(deny file-read* (subpath ${q(d)}))`);
  if (denyWriteSubpaths.length > 0) lines.push(`(deny file-write* ${denyWriteSubpaths.map((d) => `(subpath ${q(d)})`).join(' ')})`);
  const denied = protectedPaths({ home, sentinelDir }).map((p) => `(subpath ${q(p)})`).join(' ');
  lines.push(`(deny file-read* file-write* ${denied})`);
  return `${lines.join('\n')}\n`;
}

// Every path a profile names, in (subpath "...") and (literal "..."), is
// written resolved: a rule whose path runs through a symbolic link (/tmp and
// /var on macOS) does not fire.
const PATH_FILTER = /\((subpath|literal) "((?:[^"\\]|\\.)*)"\)/g;

export function resolveProfilePaths(text) {
  return text.replace(PATH_FILTER, (_, filter, quoted) => `(${filter} ${q(resolvedPath(quoted.replace(/\\(.)/g, '$1')))})`);
}

export function writeProfile(file, text) {
  fs.writeFileSync(file, resolveProfilePaths(text), { mode: 0o600 });
  return file;
}

// Whether a profile's text refuses reads and writes on a path: a
// (deny file-read* file-write* ...) rule that names (subpath "<path>").
export function deniesReadWrite(text, p) {
  return text.split('\n').some((line) => line.startsWith('(deny file-read* file-write* ') && line.includes(`(subpath ${q(p)})`));
}

// Whether a profile's text refuses writes on a path: a (deny file-write* ...)
// or (deny file-read* file-write* ...) rule that names (subpath "<path>").
export function deniesWrite(text, p) {
  return text.split('\n').some((line) => (line.startsWith('(deny file-write* ') || line.startsWith('(deny file-read* file-write* ')) && line.includes(`(subpath ${q(p)})`));
}

// The harness starts when each credential store path is a directory or
// absent, never a symbolic link. An lstat type test: nothing under either
// path is read, and no name is printed.
export function linkedStorePaths(home = realHome()) {
  return BOUNDARY_TERMS.storePaths.filter((rel) => {
    try {
      return fs.lstatSync(path.join(home, rel)).isSymbolicLink();
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
      throw new Error(`refused: <real HOME>/${rel} could not be examined (${err.code ?? 'no code'})`);
    }
  }).map((rel) => `<real HOME>/${rel}`);
}

export function refuseLinkedStore(home = realHome()) {
  const linked = linkedStorePaths(home);
  if (linked.length > 0) throw new Error(`refused: ${linked.map((l) => `${l} is a symbolic link`).join('; ')}; the harness starts when each is a directory or absent`);
}

// The test harness's profile: the boundary's terms and the run's two sibling
// controls. Outbound network to localhost alone, which the kernel matches for
// loopback and for this machine's own addresses on every port (a profile
// names no other host but *); reads and writes refused on the credential
// store paths and on the sentinel; exec refused for the keychain tool and the
// exec control, in one rule.
export function harnessProfile({ runId, home = realHome(), sentinelDir, execControl }) {
  if (!sentinelDir || !execControl) throw new Error('the harness profile carries the sentinel and the exec control');
  const denied = protectedPaths({ home, sentinelDir }).map((p) => `(subpath ${q(p)})`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    `(deny network-outbound (with message ${q(`bank-demo-${runId}-harness`)}))`,
    '(allow network-outbound (remote ip "localhost:*"))',
    `(deny file-read* file-write* ${denied})`,
    `(deny process-exec (literal ${q(BOUNDARY_TERMS.keychainTool)}) (literal ${q(execControl)}))`,
    '',
  ].join('\n');
}
