// The page every screen route answers with: the top bar with the step chips,
// the main region the page script fills from the bank's results, and the
// footer. The footer is filled here, so the fictional line is on the page
// before any script runs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { esc } from '../view/fill.mjs';
import { footerLeftParts, footerProvenance } from '../view/footer.mjs';

export const VIEW_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../view');

// One route per screen, from the copy's own route table.
export function screenRoutes(copy) {
  return Object.freeze(Object.fromEntries(copy.SCREENS.map((s) => [s.route, s.id])));
}

// No script, style or font from anywhere but this server; nothing framed.
export const SHELL_HEADERS = Object.freeze({
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
});

export function shell(copy, screenId, build, run) {
  const screen = copy.SCREENS.find((s) => s.id === screenId);
  const left = footerLeftParts(copy);
  const provenance = footerProvenance(copy, build, screenId === 'overview' ? null : run);
  const chips = copy.GLOBAL.chips.map((label, i) => {
    const target = copy.SCREENS.find((s) => s.chip === i);
    const state = i === screen.chip ? ' current' : i < screen.chip ? ' done' : '';
    const current = i === screen.chip ? ' aria-current="step"' : '';
    return `<a class="chip${state}" href="${esc(target.route)}"${current}>${esc(label)}</a>`;
  }).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(screen.docTitle)}</title>
<link rel="preload" href="/assets/fonts/inter-latin-wght.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/assets/view.css">
<script type="module" src="/assets/view.mjs"></script>
</head>
<body data-screen="${esc(screen.id)}">
<header class="topbar"><div class="brand"><div class="t">${esc(copy.GLOBAL.appTitle)}</div><div class="s">${esc(copy.GLOBAL.appSubtitle)}</div></div><nav class="chips" aria-label="Steps">${chips}</nav></header>
<main id="main" data-screen="${esc(screen.id)}" data-state="loading" aria-busy="true"></main>
<footer><p class="footer-left"><span class="footer-line">${esc(left.line)}</span> <span class="footer-note">${esc(left.rest)}</span></p><p class="footer-prov">${esc(provenance)}</p></footer>
</body>
</html>
`;
}

const TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
});

// A file under src/view/ the page loads: its stylesheet, its modules and its
// font. Anything else, and any path that leaves the directory, is null.
export function viewAsset(urlPath) {
  if (!urlPath.startsWith('/assets/')) return null;
  let rel;
  try {
    rel = decodeURIComponent(urlPath.slice('/assets/'.length));
  } catch {
    return null;
  }
  if (rel === '' || rel.includes('\0') || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) return null;
  const type = TYPES[path.extname(rel)];
  if (!type) return null;
  const file = path.resolve(VIEW_DIR, rel);
  if (!file.startsWith(`${VIEW_DIR}${path.sep}`)) return null;
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return { file, type };
}
