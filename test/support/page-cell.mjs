// The page tests' browser cell. page-remote.mjs starts it under its own
// profile through sandbox-exec, and it drives the browser through page.mjs
// for a test runner that loads no package. It reads one JSON request per
// line on stdin and writes one JSON reply per request on stdout, each when
// its handler completes, so two requests can be in flight at once, as the
// demo's channel does. Values cross as node:v8 serialized bytes in base64,
// so -0, NaN, the infinities and undefined arrive as Playwright returned
// them; an error crosses as its name and message. Every reply carries the
// page's current address and its context's outside list, and the cell sends
// an outside event each time a context counts a request that leaves
// 127.0.0.1.
//
// Before the demo's page code or a package loads, the cell checks that it is
// inside its profile: the credential store path under the real home
// directory refuses it. Anything else ends it with exit 3.
//
// The browser's close is given CLOSE_MS, on closeBrowser and when stdin
// closes; the cell then exits whether or not the close returned, since
// Playwright's close can stay pending for longer than a test file can wait.
// On the cell's exit Playwright's own exit handler sends SIGKILL to the
// browser's process group and removes its profile directory.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import v8 from 'node:v8';

const home = fs.realpathSync(os.userInfo().homedir);
let held = null;
try {
  fs.lstatSync(path.join(home, 'Library', 'Keychains'));
} catch (err) {
  held = err.code ?? null;
}
if (held !== 'EPERM') {
  process.stderr.write('the page cell is not inside its profile\n');
  process.exit(3);
}

const pw = await import('./page.mjs');

const encode = (value) => v8.serialize(value).toString('base64');
const decode = (text) => (typeof text === 'string' ? v8.deserialize(Buffer.from(text, 'base64')) : undefined);
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const CLOSE_MS = 15000;

let browser = null;
const contexts = new Map();
const pages = new Map();
let made = 0;

// true when the close returned within CLOSE_MS.
async function closeWithin() {
  if (!browser) return true;
  const closing = browser.close();
  browser = null;
  let timer;
  const returned = await Promise.race([
    closing.then(() => true, () => true),
    new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_MS, false); }),
  ]);
  clearTimeout(timer);
  return returned;
}

const pageOf = (id) => {
  const entry = pages.get(id);
  if (!entry) throw new Error(`no page ${id}`);
  return entry.page;
};
const contextOf = (id) => {
  const ctx = contexts.get(id);
  if (!ctx) throw new Error(`no context ${id}`);
  return ctx;
};

// page.mjs counts a request that leaves 127.0.0.1 in ctx.outside; the list
// the cell puts there reports each count as it happens.
function observe(id, ctx) {
  const list = [];
  Object.defineProperty(list, 'push', {
    value: (...items) => {
      const n = Array.prototype.push.apply(list, items);
      send({ event: 'outside', ctx: id, outside: [...list] });
      return n;
    },
  });
  ctx.outside = list;
}

// The function a test hands evaluate, from its source as Function.toString
// writes it, a method shorthand included.
function fromSource(source) {
  const forms = [source, source.startsWith('async ') ? `async function ${source.slice(6)}` : `function ${source}`];
  for (const form of forms) {
    try {
      return new Function(`return (${form});`)();
    } catch {
      // The next form.
    }
  }
  throw new Error('the function handed to evaluate is not well formed');
}

const ops = {
  async launch() {
    browser = await pw.launchChrome();
    return { terminal: pw.TERMINAL };
  },
  async newContext({ width, height }) {
    const ctx = await pw.newContext(browser, { width, height });
    made += 1;
    const id = `c${made}`;
    observe(id, ctx);
    contexts.set(id, ctx);
    return { ctx: id };
  },
  async newPage({ ctx }) {
    const page = await contextOf(ctx).newPage();
    made += 1;
    const id = `p${made}`;
    pages.set(id, { page, ctx });
    return { page: id };
  },
  async closeContext({ ctx }) {
    await contextOf(ctx).close();
    return null;
  },
  async goto({ page, url, options }) {
    await pageOf(page).goto(url, options);
    return null;
  },
  async waitForURL({ page, url, options }) {
    await pageOf(page).waitForURL(url, options);
    return null;
  },
  async closePage({ page }) {
    await pageOf(page).close();
    return null;
  },
  async content({ page }) {
    return pageOf(page).content();
  },
  async evaluate({ page, source, isFunction, arg }) {
    return pageOf(page).evaluate(isFunction ? fromSource(source) : source, decode(arg));
  },
  async keyboardPress({ page, key, options }) {
    await pageOf(page).keyboard.press(key, options);
    return null;
  },
  async click({ page, selector, nth }) {
    const all = pageOf(page).locator(selector);
    await (Number.isInteger(nth) ? all.nth(nth) : all).click();
    return null;
  },
  // GET is answered with the response given; every other method continues.
  async fulfillGet({ page, pattern, response }) {
    await pageOf(page).route(pattern, (route) => (route.request().method() === 'GET' ? route.fulfill(response) : route.continue()));
    return null;
  },
  async waitLoaded({ page }) {
    await pw.waitLoaded(pageOf(page));
    return null;
  },
  async waitTerminal({ page, timeout }) {
    await pw.waitTerminal(pageOf(page), timeout);
    return null;
  },
  async mainState({ page }) {
    return pw.mainState(pageOf(page));
  },
  async openAndRun({ page, base, route }) {
    await pw.openAndRun(pageOf(page), base, route);
    return null;
  },
  async closeBrowser() {
    return { returned: await closeWithin() };
  },
};

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const params = msg.params ?? {};
  const reply = { id: msg.id };
  try {
    const handler = ops[msg.op];
    if (!handler) throw new Error(`unknown op ${msg.op}`);
    reply.result = encode(await handler(params));
  } catch (err) {
    reply.error = { name: err && err.name ? err.name : 'Error', message: err && err.message ? err.message : String(err) };
  }
  const entry = typeof params.page === 'string' ? pages.get(params.page) : null;
  if (entry) reply.url = entry.page.url();
  const ctx = entry ? entry.ctx : params.ctx;
  if (typeof ctx === 'string' && contexts.has(ctx)) reply.outside = [...contexts.get(ctx).outside];
  if (msg.op === 'closeBrowser') process.stdout.write(`${JSON.stringify(reply)}\n`, () => process.exit(0));
  else send(reply);
});
rl.on('close', () => {
  closeWithin().finally(() => process.exit(0));
});
