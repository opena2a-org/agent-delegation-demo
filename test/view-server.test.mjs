// The view server's page routes: one page for each of the eight screens,
// the files the page loads from src/view/ and nothing else, the build the
// footer names, and a refusal for any request that names another host.

import './support/outer-profile.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfo } from '../src/build-info.mjs';
import { freeLoopbackPort } from '../src/orchestrator/ports.mjs';
import { ViewServer } from '../src/server/main.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
const ROUTES = ['/', '/setup', '/scenario/1', '/scenario/2', '/scenario/3', '/scenario/4', '/offline', '/summary'];
const FONT_SHA256 = 'c940764593d0fe5d596be327ca7558855e018039fb78509aa21921fd3644c3e4';

let view;
let port;

function get(route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  port = await freeLoopbackPort();
  view = new ViewServer({ port });
  await view.listen();
});
after(async () => { await view.stop(); });

test('the view server listens on 127.0.0.1 and no other address', () => {
  assert.equal(view.server.address().address, '127.0.0.1');
});

test('eight routes, one page each: its title, the step chips with the current one marked, an empty main for the script, and the footer with the fictional line on its own row', async () => {
  assert.deepEqual(COPY.SCREENS.map((s) => s.route), ROUTES);
  for (const s of COPY.SCREENS) {
    const r = await get(s.route);
    assert.equal(r.status, 200, s.route);
    assert.match(r.headers['content-type'], /^text\/html; charset=utf-8$/);
    assert.match(r.headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
    const page = r.body.toString('utf8');
    assert.ok(page.includes(`<title>${s.docTitle.replace(/&/g, '&amp;')}</title>`), s.route);
    assert.equal((page.match(/<main /g) || []).length, 1);
    assert.ok(page.includes(`<main id="main" data-screen="${s.id}" data-state="loading" aria-busy="true"></main>`), s.route);
    assert.equal((page.match(/aria-current="step"/g) || []).length, 1);
    assert.ok(page.includes(`href="${s.route}" aria-current="step">${COPY.GLOBAL.chips[s.chip]}</a>`), s.route);
    assert.ok(page.includes(`<span class="footer-line">${COPY.RULED_EXTRA.fictionalLine}</span> <span class="footer-note">`), s.route);
    assert.equal(/<script(?![^>]*\ssrc="\/assets\/view\.mjs")/.test(page), false, 'no script but the page module');
    assert.equal(/\sstyle="/.test(page), false, 'no inline style');
  }
});

test('the footer names the build the server started from; the overview reads not run yet', async () => {
  const b = await get('/api/build');
  const { build } = JSON.parse(b.body.toString('utf8'));
  assert.deepEqual(build, { ...buildInfo() });
  const head = build.modified ? `Build ${build.sha7} (modified)` : `Build ${build.sha7}`;
  const overview = (await get('/')).body.toString('utf8');
  assert.ok(overview.includes(`<p class="footer-prov">${head} · Not run yet</p>`), overview.slice(-400));
  const setup = (await get('/setup')).body.toString('utf8');
  assert.ok(setup.includes(`<p class="footer-prov">${head} · Not run yet</p>`), 'no run yet on this server');
});

test('the page files: the stylesheet, the modules and the font, each with its type; the font is the website file', async () => {
  for (const [route, type] of [['/assets/view.css', 'text/css; charset=utf-8'], ['/assets/view.mjs', 'text/javascript; charset=utf-8'], ['/assets/fill.mjs', 'text/javascript; charset=utf-8'], ['/assets/footer.mjs', 'text/javascript; charset=utf-8'], ['/assets/fonts/inter-latin-wght.woff2', 'font/woff2']]) {
    const r = await get(route);
    assert.equal(r.status, 200, route);
    assert.equal(r.headers['content-type'], type, route);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
  const font = await get('/assets/fonts/inter-latin-wght.woff2');
  assert.equal(crypto.createHash('sha256').update(font.body).digest('hex'), FONT_SHA256);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'src/view/fonts/inter-latin-wght.woff2'))).digest('hex'), FONT_SHA256);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/view/fonts/OFL.txt'), 'utf8'), /SIL Open Font License, Version 1\.1/);
});

test('nothing else under or outside src/view/ is served', async () => {
  for (const route of ['/assets/copy.json', '/assets/copy.sidecar.json', '/assets/fonts/OFL.txt', '/assets/../server/main.mjs', '/assets/%2e%2e/server/main.mjs', '/assets/%2e%2e%2fserver%2fmain.mjs', '/assets//view.css', '/assets/', '/assets/nope.mjs', '/assets/%E0%A4%A.mjs', '/src/view/view.css', '/scenario/5', '/scenario/', '/summary/']) {
    const r = await get(route);
    assert.equal(r.status, 404, route);
  }
});

test('a request that names another host is refused, a page and an API read alike', async () => {
  for (const route of ['/', '/assets/view.css', '/api/build', '/api/copy']) {
    assert.equal((await get(route, { Host: 'rebind.example' })).status, 403, route);
    assert.equal((await get(route, { Host: `localhost:${port}` })).status, 200, route);
  }
  assert.equal((await get('/', { Origin: 'http://rebind.example' })).status, 403);
});

test('the copy route carries the label texts with their fills, and the start command', async () => {
  const r = JSON.parse((await get('/api/copy')).body.toString('utf8'));
  assert.equal(r.fills.startCommand, 'npm start');
  assert.deepEqual(r.labels.map((l) => l.id), Object.keys(COPY.LABELS));
  const l7 = r.labels.find((l) => l.id === 'L7');
  assert.match(l7.text, /at commit [0-9a-f]{12}\.$/);
  assert.ok(r.labels.every((l) => l.printable === true && !/\{[A-Za-z0-9]+\}|<version>|at commit X\b/.test(l.text)));
});

test('the result route answers 409 before any run', async () => {
  assert.equal((await get('/api/result')).status, 409);
});
