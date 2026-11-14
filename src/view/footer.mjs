// The footer of every screen. Left: the fictional line on a row of its own,
// then the rest of the footer text. Right: the build and the run the screen
// shows. Used by the view server, which refuses to start on copy that breaks
// it, and by the page.

import { fill } from './fill.mjs';

const BUILD = 'Build {sha7}';

// The fictional line and the rest of footerLeft after it and one space. The
// copy keys are not split: footerLeft stays one string.
export function footerLeftParts(copy) {
  const line = copy.RULED_EXTRA.fictionalLine;
  const left = copy.GLOBAL.footerLeft;
  if (typeof line !== 'string' || line === '' || typeof left !== 'string' || !left.startsWith(`${line} `) || left.length === line.length + 1) {
    throw new Error('the footer text does not begin with the fictional line and one space');
  }
  return { line, rest: left.slice(line.length + 1) };
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
