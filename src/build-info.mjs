// The build the demo runs from, in one place: the launcher's Ready line, the
// footer of every screen, the modified field of every capture sidecar and
// the tests all read this function.
//
// git runs against the repository root, whatever the working directory, and
// changes under docs/captures/ are not counted: that directory holds the
// capture outputs, and nothing the demo runs reads from it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NOT_FROM_GIT = Object.freeze({ fromGit: false, sha7: null, modified: null });

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// { fromGit, sha7, modified }. Without a .git entry at the root, or when git
// does not answer, the build is not from a git clone and has no sha.
export function buildInfo(root = ROOT) {
  if (!fs.existsSync(path.join(root, '.git'))) return NOT_FROM_GIT;
  try {
    const sha7 = git(root, ['rev-parse', '--short=7', 'HEAD']);
    const dirty = git(root, ['status', '--porcelain', '--', '.', ':(exclude)docs/captures']);
    return Object.freeze({ fromGit: true, sha7, modified: dirty !== '' });
  } catch {
    return NOT_FROM_GIT;
  }
}

// The launcher's words for the build: "build <sha7>", "build <sha7>
// (modified)" or "build not from a git clone".
export function launcherBuildLabel(info = buildInfo()) {
  if (!info.fromGit) return 'build not from a git clone';
  return `build ${info.sha7}${info.modified ? ' (modified)' : ''}`;
}
