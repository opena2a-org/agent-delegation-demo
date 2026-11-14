// The view server: the page of every screen, and the loopback HTTP API the
// page calls. It runs scenarios through the scenario engine and reads the
// current bank's state and records. It imports no broker code; the bank runs
// that in its own process.

import fs from 'node:fs';
import http from 'node:http';
import { buildInfo } from '../build-info.mjs';
import { formNotRefusingReason, runOfflineCheck } from '../egress/offline.mjs';
import { CHAINS, STEP_TITLES, runChain } from '../scenarios/engine.mjs';
import { COPY, FICTIONAL_LINE, FILLS, label } from '../scenarios/labels.mjs';
import { readJson, sendJson } from '../http.mjs';
import { footerLeftParts } from '../view/footer.mjs';
import { SHELL_HEADERS, screenRoutes, shell, viewAsset } from './shell.mjs';

// The view refuses to start on copy whose footer does not begin with the
// fictional line and one space.
footerLeftParts(COPY);
const ROUTES = screenRoutes(COPY);

// The one start command: the package's start script, run through npm.
const PKG = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const VIEW_FILLS = Object.freeze({ ...FILLS, startCommand: PKG.scripts && PKG.scripts.start ? 'npm start' : null });
const LABEL_TEXTS = Object.freeze(Object.keys(COPY.LABELS).map((id) => label(id)));

const NOT_FOUND_PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title></head>'
  + '<body><p>This page does not exist.</p><p><a href="/">Back to the demo</a></p></body></html>';

// A run or an offline check this session refuses, with the reason of the
// control whose deny form was seen not refusing.
class Refused extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

export class ViewServer {
  constructor({ port, runOptions = {}, offlineOptions = {}, extraRoutes = {}, build = buildInfo() }) {
    this.port = port;
    this.build = build;
    this.runOptions = runOptions;
    this.offlineOptions = offlineOptions;
    this.extraRoutes = extraRoutes;
    this.current = null; // { run, result }
    this.lastOffline = null;
    // Set once, for the rest of this session, when an offline check saw a
    // deny form not refusing: the reason every later run and offline check
    // is refused with. A new session starts without it.
    this.stopReason = null;
    this.inFlight = null; // { key, promise }
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.onComponentExit = null;
  }

  origins() {
    return [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`];
  }

  hostAllowed(req) {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return false;
    return req.headers.origin === undefined || this.origins().includes(req.headers.origin);
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }

  // One job at a time: a scenario run or an offline check. The same request
  // while it runs gets the same result; a different request waits for it to
  // finish. A run never adds rows to another run's bank.
  enqueue(key, job) {
    if (this.inFlight && this.inFlight.key === key) return this.inFlight.promise;
    const previous = this.inFlight ? this.inFlight.promise.catch(() => {}) : Promise.resolve();
    const promise = previous.then(job);
    this.inFlight = { key, promise };
    promise.finally(() => { if (this.inFlight && this.inFlight.promise === promise) this.inFlight = null; }).catch(() => {});
    return promise;
  }

  run(target) {
    const key = String(target);
    return this.enqueue(`run ${key}`, async () => {
      if (this.stopReason) throw new Refused(this.stopReason);
      const next = await runChain(key, { ...this.runOptions, origins: this.origins() });
      const old = this.current;
      this.current = next;
      this.watch(next.run);
      if (old) await old.run.stop();
      return next.result;
    });
  }

  // The offline check runs on two banks of its own and leaves the current
  // run as it was. No other place in the demo starts it. A check that was not
  // run is an answer like any other: nothing else stops. The one exception: a
  // result whose store or exec control shows its deny form not refusing
  // (read from controls[].insideOutcome). Then the current run stops, and
  // every later run and offline check of this session is refused with that
  // control's reason, since their profiles come from the same generator.
  offline() {
    return this.enqueue('offline', async () => {
      if (this.stopReason) throw new Refused(this.stopReason);
      this.lastOffline = await runOfflineCheck({ ...this.offlineOptions, origins: this.origins() });
      const reason = formNotRefusingReason(this.lastOffline);
      if (reason) {
        this.stopReason = reason;
        const old = this.current;
        this.current = null;
        if (old) await old.run.stop();
      }
      return this.lastOffline;
    });
  }

  watch(run) {
    for (const p of run.processes) {
      p.channel.child.once('exit', (code, signal) => {
        if (run.stopped || (this.current && this.current.run !== run)) return;
        if (this.onComponentExit) this.onComponentExit({ name: p.name, code: code ?? signal, log: p.channel.stderrLog });
      });
    }
  }

  async health() {
    if (!this.current) return { ok: false };
    const run = this.current.run;
    const parts = { view: true };
    try { parts.bank = (await run.bank.call('health', {}, { timeoutMs: 5000 })).ok === true; } catch { parts.bank = false; }
    try {
      const res = await fetch(`http://127.0.0.1:${run.ports.token}/token`, { method: 'GET' });
      parts.tokenService = res.status === 404;
    } catch { parts.tokenService = false; }
    for (const [name, ch] of Object.entries(run.agents)) {
      try { parts[`agent ${name}`] = (await ch.call('health', {}, { timeoutMs: 5000 })).ok === true; } catch { parts[`agent ${name}`] = false; }
    }
    return { ok: Object.values(parts).every(Boolean), parts };
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    try {
      // Every request names this server's own host, and an Origin, when
      // sent, is this server's: a page that rebinds another name to
      // 127.0.0.1 reads and runs nothing.
      if (!this.hostAllowed(req)) {
        sendJson(res, 403, { error: 'request refused', fictionalLine: FICTIONAL_LINE });
        return;
      }
      const extra = this.extraRoutes[`${req.method} ${url.pathname}`];
      if (extra) {
        await extra(req, res, this);
        return;
      }
      if (req.method === 'GET' && Object.hasOwn(ROUTES, url.pathname)) {
        const run = this.current ? { runId: this.current.result.runId, ranAtUtc: this.current.result.ranAtUtc } : null;
        res.writeHead(200, SHELL_HEADERS);
        res.end(shell(COPY, ROUTES[url.pathname], this.build, run));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const asset = viewAsset(url.pathname);
        if (asset) {
          const body = fs.readFileSync(asset.file);
          res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(body);
          return;
        }
      }
      if (req.method === 'GET' && url.pathname === '/api/build') {
        sendJson(res, 200, { build: this.build, fictionalLine: FICTIONAL_LINE });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/result') {
        if (!this.current) { sendJson(res, 409, { error: 'no run yet', fictionalLine: FICTIONAL_LINE }); return; }
        sendJson(res, 200, this.current.result);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, await this.health());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/copy') {
        sendJson(res, 200, { copy: COPY, fills: VIEW_FILLS, labels: LABEL_TEXTS, fictionalLine: FICTIONAL_LINE });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/scenarios') {
        sendJson(res, 200, { chains: CHAINS, titles: STEP_TITLES, fictionalLine: FICTIONAL_LINE });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const body = await readJson(req, 4096);
        const target = String(body.scenario ?? '');
        if (!Object.hasOwn(CHAINS, target)) {
          sendJson(res, 400, { error: 'unknown scenario', scenarios: Object.keys(CHAINS), fictionalLine: FICTIONAL_LINE });
          return;
        }
        const result = await this.run(target);
        sendJson(res, 200, filterPaths(result, body.path));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/offline') {
        sendJson(res, 200, await this.offline());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/offline') {
        if (!this.lastOffline) { sendJson(res, 409, { error: 'no offline check yet', fictionalLine: FICTIONAL_LINE }); return; }
        sendJson(res, 200, this.lastOffline);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        if (!this.current) { sendJson(res, 409, { error: 'no run yet', fictionalLine: FICTIONAL_LINE }); return; }
        sendJson(res, 200, { runId: this.current.run.runId, state: await this.current.run.state(), fictionalLine: FICTIONAL_LINE });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/records') {
        if (!this.current) { sendJson(res, 409, { error: 'no run yet', fictionalLine: FICTIONAL_LINE }); return; }
        const r = await this.current.run.records();
        sendJson(res, 200, {
          runId: this.current.run.runId,
          audit: { entries: r.audit.entries, verification: r.audit.verification, keyChanged: r.audit.keyChanged },
          exchanges: r.exchanges.map(({ claims, ...rest }) => ({ ...rest, scope: claims?.scope ?? rest.scope })),
          restarts: this.current.run.restarts,
          fictionalLine: FICTIONAL_LINE,
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(NOT_FOUND_PAGE);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof Refused) sendJson(res, 409, { error: 'request refused', reason: err.reason, fictionalLine: FICTIONAL_LINE });
      else sendJson(res, 500, { error: 'the request failed', fictionalLine: FICTIONAL_LINE });
    }
  }

  async stop() {
    if (this.inFlight) await this.inFlight.promise.catch(() => {});
    if (this.current) await this.current.run.stop();
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server.closeAllConnections?.();
  }
}

function filterPaths(result, pathKey) {
  if (pathKey !== 'A' && pathKey !== 'B') return result;
  const steps = {};
  for (const [k, v] of Object.entries(result.steps)) steps[k] = { [pathKey]: v[pathKey] };
  return { ...result, steps };
}
