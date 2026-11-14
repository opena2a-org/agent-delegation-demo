// The footer of every screen. Left: the footer note. Right: the build and the
// run the screen shows. Used by the view server, which refuses to start on
// copy that breaks it, and by the page.

import { fill } from './fill.mjs';

const BUILD = 'Build {sha7}';

// The footer note, footerLeft as one string. It must be one non-empty line.
export function footerLeftParts(copy) {
  const left = copy.GLOBAL.footerLeft;
  if (typeof left !== 'string' || left.trim() === '' || left !== left.trim() || /\n/.test(left)) {
    throw new Error('the footer text is not one non-empty line');
  }
  return { rest: left };
}

// build is { fromGit, sha7, modified }; run is { runId, ranAtUtc } for the
// run on screen, or null where the footer reads not run yet.
export function footerProvenance(copy, build, run) {
  const g = copy.GLOBAL;
  const template = run ? g.footerRight : g.footerIdle;
  if (!template.startsWith(BUILD) || !g.footerModifiedBuild.startsWith(BUILD)) {
    throw new Error('the footer build text does not begin with the build');
  }
  let head = BUILD;
  if (!build || !build.fromGit) head = copy.RULED_EXTRA.buildNotFromGit;
  else if (build.modified) head = g.footerModifiedBuild;
  const values = { sha7: build && build.sha7 };
  if (run) {
    values.runId = typeof run.runId === 'string' ? run.runId.slice(0, 4) : null;
    values.ranAtUtc = run.ranAtUtc;
  }
  return fill(`${head}${template.slice(BUILD.length)}`, values);
}
