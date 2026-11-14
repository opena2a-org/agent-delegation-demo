// The page tests' browser, driven in a cell of its own (page-cell.mjs). The
// cell runs under its own profile: outbound network to localhost alone and
// the boundary's terms. This module exports page.mjs's names and returns
// mirrors of the browser, its contexts and its pages, whose calls the cell
// answers, so a test runner that drives a page loads no package: this module
// imports node: built-ins, the demo's sandbox module and the profile texts.
//
// A mirror page answers url() from the last reply; a mirror context keeps
// outside, the list of origins its requests left 127.0.0.1 for, current from
// every reply and event, read as an array as before. An AssertionError in the
// cell is thrown here as an AssertionError with the same message, so the
// browser precondition reads as page.mjs words it. Each request is bounded by
// its operation's timeout, or 30 s, plus 30 s; when one expires, or the cell
// ends, every pending request is refused with the operation, the cell's exit
// code or signal and the last 20 lines of its stderr, and an expiry ends the
// cell's process group. The mirror browser's close() asks the cell to close
// the browser and waits for the cell's exit; its end() ends the cell's
// process group, for a teardown that does not wait on a close past its bound
// (teardown.mjs).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import { SANDBOX_EXEC, realExecPath, sandboxStatus, writeProfile } from '../../src/orchestrator/sandbox.mjs';
import { pageCellProfile } from './profiles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRE = 'precondition: /usr/bin/sandbox-exec (macOS); the page cell runs inside its profile and nowhere else';
const ENV = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ'];
const DEFAULT_MS = 30000;
const SLACK_MS = 30000;
// Playwright's own bound on a browser start.
const LAUNCH_MS = 180000;
const CLOSE_MS = 30000;
// The wait for the cell's exit once its process group was sent SIGKILL.
const END_MS = 5000;

export const TERMINAL = ['done', 'mismatch', 'error'];

const encode = (value) => v8.serialize(value).toString('base64');
const decode = (text) => (typeof text === 'string' ? v8.deserialize(Buffer.from(text, 'base64')) : undefined);

function crossed({ name, message }) {
  if (name === 'AssertionError') return new assert.AssertionError({ message });
  const err = new Error(message);
  err.name = name;
  return err;
}

class Cell {
  constructor() {
    if (!sandboxStatus().available) assert.fail(PRE);
    this.dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-page-')));
    const profile = writeProfile(path.join(this.dir, 'page.sb'), pageCellProfile());
    const env = {};
    for (const k of ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    this.child = spawn(SANDBOX_EXEC, ['-f', profile, realExecPath(), path.join(HERE, 'page-cell.mjs')], { detached: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    this.pending = new Map();
    this.outside = new Map();
    this.sent = 0;
    this.stderr = [];
    this.end = null;
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        this.end = { code, signal };
        this.refuseAll('the cell ended');
        fs.rmSync(this.dir, { recursive: true, force: true });
        process.removeListener('exit', this.onExit);
        resolve(this.end);
      });
    });
    this.child.once('error', (err) => this.refuseAll(`the cell did not start (${err.code ?? err.message})`));
    // A write after the cell ended: the exit refuses what is pending.
    this.child.stdin.on('error', () => {});
    this.onExit = () => this.kill();
    process.on('exit', this.onExit);
    readline.createInterface({ input: this.child.stderr }).on('line', (line) => {
      this.stderr.push(line);
      if (this.stderr.length > 20) this.stderr.shift();
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => this.receive(line));
  }

  receive(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event === 'outside') {
      this.listOf(msg.ctx).splice(0, Infinity, ...msg.outside);
      return;
    }
    const waiting = this.pending.get(msg.id);
    if (!waiting) return;
    this.pending.delete(msg.id);
    clearTimeout(waiting.timer);
    if (Array.isArray(msg.outside) && typeof waiting.ctx === 'string') this.listOf(waiting.ctx).splice(0, Infinity, ...msg.outside);
    if (msg.error) waiting.reject(crossed(msg.error));
    else waiting.resolve({ value: decode(msg.result), url: msg.url });
  }

  listOf(ctx) {
    if (!this.outside.has(ctx)) this.outside.set(ctx, []);
    return this.outside.get(ctx);
  }

  why(op, reason) {
    const end = this.end ? `exit ${this.end.code ?? this.end.signal}` : 'still running';
    return new Error(`the page cell, ${op}: ${reason}; ${end}; stderr: ${this.stderr.join('\n') || '(none)'}`);
  }

  refuseAll(reason) {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(this.why(waiting.op, reason));
      this.pending.delete(id);
    }
  }

  kill() {
    try {
      process.kill(-this.child.pid, 'SIGKILL');
    } catch {
      // The group has ended.
    }
  }

  call(op, params = {}, { timeoutMs = DEFAULT_MS, ctx = null } = {}) {
    if (this.end) return Promise.reject(this.why(op, 'the cell ended'));
    this.sent += 1;
    const id = this.sent;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(this.why(op, `no reply within ${timeoutMs + SLACK_MS} ms`));
        this.refuseAll(`${op} expired`);
        this.kill();
      }, timeoutMs + SLACK_MS);
      this.pending.set(id, { op, ctx, resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }
}

class Browser {
  constructor(cell) {
    this._cell = cell;
  }

  async newContext({ width, height }) {
    const { value } = await this._cell.call('newContext', { width, height });
    return new Context(this._cell, value.ctx);
  }

  async close() {
    if (!this._cell.end) {
      try {
        await this._cell.call('closeBrowser', {}, { timeoutMs: CLOSE_MS });
      } catch {
        // The group ends below.
      }
    }
    const timer = setTimeout(() => this._cell.kill(), CLOSE_MS);
    await this._cell.exited;
    clearTimeout(timer);
  }

  // The cell's process group is sent SIGKILL when the cell has not ended,
  // and its exit is awaited for END_MS: true once the exit is seen. A close
  // still pending then settles, since the exit refuses its request.
  async end() {
    if (this._cell.end) return true;
    this._cell.kill();
    let timer;
    const seen = await Promise.race([
      this._cell.exited.then(() => true),
      new Promise((resolve) => { timer = setTimeout(resolve, END_MS, false); }),
    ]);
    clearTimeout(timer);
    return seen;
  }
}

class Context {
  constructor(cell, id) {
    this._cell = cell;
    this._id = id;
    this.outside = cell.listOf(id);
  }

  async newPage() {
    const { value } = await this._cell.call('newPage', { ctx: this._id }, { ctx: this._id });
    return new Page(this._cell, value.page, this._id);
  }

  async close() {
    await this._cell.call('closeContext', { ctx: this._id }, { ctx: this._id });
  }
}

class Page {
  constructor(cell, id, ctx) {
    this._cell = cell;
    this._id = id;
    this._ctx = ctx;
    this._url = 'about:blank';
    this.keyboard = { press: (key, options) => this._call('keyboardPress', { key, options }, options?.timeout) };
  }

  async _call(op, params, timeoutMs = DEFAULT_MS) {
    const { value, url } = await this._cell.call(op, { page: this._id, ...params }, { timeoutMs, ctx: this._ctx });
    if (typeof url === 'string') this._url = url;
    return value;
  }

  url() {
    return this._url;
  }

  async goto(url, options) {
    await this._call('goto', { url, options }, options?.timeout);
    return null;
  }

  content() {
    return this._call('content', {});
  }

  // The function is sent as its source, as Playwright sends it.
  evaluate(fn, arg) {
    const isFunction = typeof fn === 'function';
    return this._call('evaluate', { source: isFunction ? fn.toString() : String(fn), isFunction, arg: encode(arg) });
  }

  locator(selector) {
    const click = (nth) => this._call('click', { selector, nth });
    return { click: () => click(null), nth: (i) => ({ click: () => click(i) }) };
  }

  async waitForURL(url, options) {
    await this._call('waitForURL', { url, options }, options?.timeout);
  }

  // GET on the pattern is answered with the response; every other method
  // continues to the server.
  async fulfillGet(pattern, response) {
    await this._call('fulfillGet', { pattern, response });
  }

  async close() {
    await this._call('closePage', {});
  }
}

export async function launchChrome() {
  const cell = new Cell();
  let terminal;
  try {
    ({ value: { terminal } } = await cell.call('launch', {}, { timeoutMs: LAUNCH_MS }));
  } catch (err) {
    cell.kill();
    throw err;
  }
  assert.deepEqual(terminal, TERMINAL, 'the cell\'s terminal states are this module\'s');
  return new Browser(cell);
}

export async function newContext(browser, { width = 1440, height = 900 } = {}) {
  return browser.newContext({ width, height });
}

export function mainState(page) {
  return page._call('mainState', {});
}

export async function waitLoaded(page) {
  await page._call('waitLoaded', {});
}

export async function waitTerminal(page, timeout = 240000) {
  await page._call('waitTerminal', { timeout }, timeout);
}

// Its steps' own bounds: the address, the loaded state, the click, the
// terminal state and the fonts.
export async function openAndRun(page, base, route) {
  await page._call('openAndRun', { base, route }, 4 * DEFAULT_MS + 240000);
}
