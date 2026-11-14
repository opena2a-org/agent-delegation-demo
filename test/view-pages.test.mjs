// The eight screens in the installed Chrome, at 1440x900, device scale 1,
// light, each after its done state, reached the way a presenter reaches it:
// open the route, press its run control. The footer cells t1 to t8, no fill
// marker in any rendered text, no secret in any captured page, every demo
// listener on loopback, the presenter keys, the landmarks, and the columns
// stacked below 1100 px.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeLoopbackPort } from '../src/orchestrator/ports.mjs';
import { ViewServer } from '../src/server/main.mjs';
import { launchChrome, mainState, newContext, openAndRun, waitLoaded, waitTerminal } from './support/page-remote.mjs';
import { stopThenClose } from './support/teardown.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
const ROUTES = ['/', '/setup', '/scenario/1', '/scenario/2', '/scenario/3', '/scenario/4', '/offline', '/summary'];
const FIXED = ROUTES.filter((r) => r !== '/summary');
const FILL_MARKER = /\{[A-Za-z0-9]+\}/;

let view;
let base;
let browser;
let ctx;
let page;
const seen = {}; // route -> { metrics, html, text }

// Measured in the page: the footer, the page height, and every text node
// whose box crosses the footer's top edge.
function footerCells() {
  const footer = document.querySelector('footer');
  const f = footer.getBoundingClientRect();
  const straddling = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim() || footer.contains(n)) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.height > 0 && r.top < f.top - 0.5 && r.bottom > f.top + 0.5) straddling.push(n.textContent.trim().slice(0, 40));
    }
  }
  return {
    scrollHeight: document.documentElement.scrollHeight,
    footerTop: f.top,
    footerBottom: f.bottom,
    footerScrollWidth: footer.scrollWidth,
    footerClientWidth: footer.clientWidth,
    footerHeight: f.height,
    leftText: document.querySelector('.footer-left').textContent,
    straddling,
  };
}

before(async () => {
  const port = await freeLoopbackPort();
  view = new ViewServer({ port });
  await view.listen();
  await view.run('setup');
  base = `http://127.0.0.1:${port}`;
  browser = await launchChrome();
  ctx = await newContext(browser);
  page = await ctx.newPage();
});

// The view server stops, then the browser closes within its bound
// (support/teardown.mjs).
after(async (t) => {
  await stopThenClose(t, { view, browser });
});

test('presenter keys: Right Arrow runs the screen\'s step, then goes to the next screen; Left Arrow goes back', async () => {
  await page.goto(`${base}/scenario/1`);
  await waitLoaded(page);
  assert.equal(await mainState(page), 'idle', 'the run on screen is the setup run, so scenario 1 has not run');
  await page.keyboard.press('ArrowRight');
  await waitTerminal(page);
  assert.equal(await mainState(page), 'done');
  assert.equal(new URL(page.url()).pathname, '/scenario/1');
  await Promise.all([page.waitForURL(`${base}/scenario/2`), page.keyboard.press('ArrowRight')]);
  await waitLoaded(page);
  await Promise.all([page.waitForURL(`${base}/scenario/1`), page.keyboard.press('ArrowLeft')]);
  await waitLoaded(page);
  assert.equal(await mainState(page), 'done', 'scenario 1 is in the run on screen');
  await Promise.all([page.waitForURL(`${base}/scenario/2`), page.keyboard.press('PageDown')]);
  await waitLoaded(page);
  assert.equal(await mainState(page), 'idle');
  await page.keyboard.press('PageDown');
  await waitTerminal(page);
  assert.equal(await mainState(page), 'done');
});

test('the eight screens reach their done state the way a presenter reaches them, with no request leaving 127.0.0.1', async () => {
  for (const route of ROUTES) {
    await openAndRun(page, base, route);
    const state = await mainState(page);
    const failed = await page.evaluate(() => document.querySelector('main').dataset.failed || '');
    assert.equal(state, 'done', `${route}: ${failed}`);
    seen[route] = {
      cells: await page.evaluate(footerCells),
      html: await page.content(),
      text: await page.evaluate(() => document.body.innerText),
      offlineState: await page.evaluate(() => document.querySelector('main').dataset.offlineState || null),
    };
  }
  assert.equal(seen['/offline'].offlineState, 'measured', 'precondition: /usr/bin/sandbox-exec (macOS) for the offline check');
  assert.deepEqual(ctx.outside, []);
});

test('t1: the footer\'s bottom is at or above 900 at scroll 0 on all eight routes', () => {
  for (const route of ROUTES) assert.ok(seen[route].cells.footerBottom <= 900, `${route} ${seen[route].cells.footerBottom}`);
});

test('t2: the seven fixed routes are 900 px tall: no scroll at 1440x900', () => {
  for (const route of FIXED) assert.equal(seen[route].cells.scrollHeight, 900, route);
});

test('t3: the fictional line is on no screen, and the footer is one slim row at 1440x900', () => {
  for (const route of ROUTES) {
    assert.equal(seen[route].text.includes(COPY.RULED_EXTRA.fictionalLine), false, route);
    assert.ok(seen[route].cells.footerHeight <= 40, `${route} ${seen[route].cells.footerHeight}`);
  }
});

test('t4: the footer text is footerLeft, byte for byte', () => {
  for (const route of ROUTES) assert.equal(seen[route].cells.leftText, COPY.GLOBAL.footerLeft, route);
});

test('t5: no text crosses the footer\'s top edge, on every route at scroll 0 and on the summary at the end of the page', async () => {
  for (const route of ROUTES) assert.deepEqual(seen[route].cells.straddling, [], route);
  await openAndRun(page, base, '/summary');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  assert.deepEqual((await page.evaluate(footerCells)).straddling, []);
});

test('t6: the summary at the end of the page: every limits item ends at or above the footer\'s top', async () => {
  await openAndRun(page, base, '/summary');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const r = await page.evaluate(() => {
    const top = document.querySelector('footer').getBoundingClientRect().top;
    return { top, items: [...document.querySelectorAll('#limits li')].map((li) => li.getBoundingClientRect().bottom) };
  });
  assert.equal(r.items.length, COPY.SCREENS.find((s) => s.id === 'summary').limits.items.length);
  for (const b of r.items) assert.ok(b <= r.top + 0.5, `${b} > ${r.top}`);
});

test('t8: the summary at scroll 0 ends on the limits heading, 8 px or more above the footer, and the list starts at or below the footer\'s top', async () => {
  await openAndRun(page, base, '/summary');
  await page.evaluate(() => window.scrollTo(0, 0));
  const r = await page.evaluate(() => ({
    footerTop: document.querySelector('footer').getBoundingClientRect().top,
    heading: document.querySelector('#limits h2').getBoundingClientRect().bottom,
    listTop: document.querySelector('#limits li').getBoundingClientRect().top,
    self: document.querySelector('#run-it-yourself').getBoundingClientRect().bottom,
  }));
  assert.ok(r.footerTop - r.heading >= 8, JSON.stringify(r));
  assert.ok(r.listTop >= r.footerTop - 0.5, JSON.stringify(r));
  assert.ok(r.self <= r.footerTop, `the run it yourself block ends at or above the footer: ${JSON.stringify(r)}`);
});

test('t7: at 375x812 the footer fits its width and t4 holds', async () => {
  const phone = await newContext(browser, { width: 375, height: 812 });
  const p = await phone.newPage();
  for (const route of ROUTES) {
    await p.goto(`${base}${route}`);
    await waitLoaded(p);
    const c = await p.evaluate(footerCells);
    assert.ok(c.footerScrollWidth <= c.footerClientWidth, `${route} ${c.footerScrollWidth} > ${c.footerClientWidth}`);
    assert.equal(c.leftText, COPY.GLOBAL.footerLeft, route);
    assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${route} scrolls sideways`);
  }
  assert.deepEqual(phone.outside, []);
  await phone.close();
});

test('no {name} fill marker in the rendered text of any screen', () => {
  for (const route of ROUTES) assert.equal(FILL_MARKER.test(seen[route].text), false, `${route}: ${(seen[route].text.match(FILL_MARKER) || [])[0]}`);
  for (const route of ROUTES) assert.equal(/<version>|at commit X\b/.test(seen[route].text), false, route);
});

test('K8: no captured page holds a PEM header, a private key member, the broker token or a customer password', () => {
  const run = view.current.run;
  const token = fs.readFileSync(path.join(run.dirs.bank, 'broker.token'), 'utf8').trim();
  const passwords = Object.values(run.passwords);
  assert.ok(token.length > 0 && passwords.length === 2, 'precondition: the run holds a broker token and two passwords');
  for (const route of ROUTES) {
    const html = seen[route].html;
    assert.equal(/-----BEGIN [A-Z ]*-----/.test(html), false, route);
    assert.equal(/"d"\s*:\s*"/.test(html), false, route);
    assert.equal(html.includes(token), false, route);
    for (const p of passwords) assert.equal(html.includes(p), false, route);
    assert.equal(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(html), false, `${route}: a compact token`);
  }
});

test('K18: every listener of the view server and of the run\'s processes is on 127.0.0.1 or [::1]', () => {
  const pids = [{ name: 'view', pid: process.pid }, ...view.current.run.pids()];
  let seenAny = false;
  for (const { name, pid } of pids) {
    let text = '';
    try {
      text = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
    } catch (err) {
      assert.notEqual(err.code, 'ENOENT', 'precondition: lsof (/usr/sbin/lsof on macOS) on PATH');
    }
    for (const line of text.trim().split('\n').slice(1).filter(Boolean)) {
      seenAny = true;
      assert.match(line.trim().split(/\s+/).at(-2), /^(127\.0\.0\.1|\[::1\]):[0-9]+$/, `${name} ${line}`);
    }
  }
  assert.ok(seenAny, 'at least one listener was seen');
});

test('one h1 per screen, the landmarks, the results region announced politely, a title per screen', () => {
  for (const s of COPY.SCREENS) {
    const html = seen[s.route].html;
    assert.equal((html.match(/<h1[ >]/g) || []).length, 1, s.route);
    for (const tag of ['header', 'nav', 'main', 'footer']) assert.equal((html.match(new RegExp(`<${tag}[ >]`, 'g')) || []).length, 1, `${s.route} ${tag}`);
    if (s.cols) assert.ok(html.includes('<section class="cols" aria-live="polite">'), s.route);
    assert.ok(html.includes(`<title>${s.docTitle}</title>`), s.route);
  }
});

test('below 1100 px the columns stack, the password path above the grant path; at 1100 they sit side by side', async () => {
  for (const [width, stacked] of [[1099, true], [1100, false]]) {
    const c = await newContext(browser, { width, height: 900 });
    const p = await c.newPage();
    await p.goto(`${base}/scenario/1`);
    await waitLoaded(p);
    const r = await p.evaluate(() => [...document.querySelectorAll('.col')].map((e) => ({ side: e.dataset.side, top: e.getBoundingClientRect().top, bottom: e.getBoundingClientRect().bottom })));
    assert.deepEqual(r.map((x) => x.side), ['A', 'B']);
    if (stacked) assert.ok(r[1].top >= r[0].bottom, JSON.stringify(r));
    else assert.equal(r[0].top, r[1].top);
    await c.close();
  }
});

test('the overview starts the demo with a link to setup, and the summary\'s buttons are links to the address and the run it yourself block', async () => {
  await page.goto(`${base}/`);
  await waitLoaded(page);
  await Promise.all([page.waitForURL(`${base}/setup`), page.locator('main a.btn.primary').click()]);
  await page.goto(`${base}/summary`);
  await waitLoaded(page);
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('.cta a.btn')].map((a) => a.getAttribute('href')));
  assert.deepEqual(hrefs, ['mailto:info@opena2a.org?subject=agent%20channel', '#run-it-yourself']);
  const code = await page.evaluate(() => document.querySelector('#run-it-yourself pre').textContent);
  assert.equal(code, 'git clone https://github.com/opena2a-org/agent-delegation-demo\ncd agent-delegation-demo\nnpm ci\nnpm start');
});
