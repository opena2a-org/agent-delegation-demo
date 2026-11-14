// The agent process. One program for both paths: it reads its task, decides
// what to do with the same planning code, and reaches the bank through the
// transport it was configured with. It reports to the launcher on stdout and
// keeps a log of what it attempted in its own directory.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { serve } from '../orchestrator/channel.mjs';
import { planInvoicePayment } from './plan.mjs';

let transport = null;
let identity = null;
let logFile = null;

function log(entry) {
  if (!logFile) return;
  fs.appendFileSync(logFile, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

// What this process reports when an operation fails: its own fixed messages
// as they are, and any other error by its code alone. An error's own text can
// name the file it was reading, and nothing this process reports to the
// launcher carries a path under the run directory.
const OWN_MESSAGES = new Set(['not configured', 'unknown task', 'unknown probe']);

const WRITE_OPS = Object.freeze(['create', 'append', 'rename', 'rename-out']);

function reportCodesOnly(handlers) {
  return Object.fromEntries(Object.entries(handlers).map(([op, handler]) => [op, async (params) => {
    try {
      return await handler(params);
    } catch (err) {
      throw new Error(OWN_MESSAGES.has(err?.message) ? err.message : `${op} failed (${err?.code ?? 'error'})`);
    }
  }]));
}

serve(reportCodesOnly({
  async configure(params) {
    identity = { path: params.path, role: params.role };
    logFile = path.join(params.agentDir, 'agent.log');
    if (params.path === 'A') {
      const { PasswordTransport } = await import('./path-a.mjs');
      transport = new PasswordTransport(params);
    } else {
      const { GrantTransport } = await import('./path-b.mjs');
      transport = new GrantTransport(params);
    }
    log({ event: 'configured', ...identity, ...transport.describe() });
    return { ok: true };
  },

  async task({ task }) {
    if (!transport) throw new Error('not configured');
    if (task.kind === 'pay-invoice') {
      const plan = planInvoicePayment(task.invoice);
      const answer = await transport.pay(plan.attempt, task.present);
      const out = { attempted: plan.attempt, followedHiddenInstruction: plan.followedHiddenInstruction, answer };
      log({ event: 'task', ...out });
      return out;
    }
    if (task.kind === 'read-balance') {
      const answer = await transport.readBalance(task.present);
      const out = { attempted: { kind: 'balance' }, followedHiddenInstruction: false, answer };
      log({ event: 'task', ...out });
      return out;
    }
    throw new Error('unknown task');
  },

  health({ canaryName } = {}) {
    return {
      ok: true,
      pid: process.pid,
      envKeys: Object.keys(process.env).sort(),
      canaryPresent: typeof canaryName === 'string' && canaryName.length > 0 ? process.env[canaryName] !== undefined : null,
    };
  },

  // Controls run inside this agent's own sandbox profile.
  probe({ kind, port, file, op, from, to }) {
    if (kind === 'read') {
      try {
        fs.readFileSync(file);
        return { result: 'read' };
      } catch (err) {
        return { result: 'refused', code: err.code ?? 'error' };
      }
    }
    if (kind === 'tcp') {
      return new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port });
        const done = (r) => { s.destroy(); resolve(r); };
        s.once('connect', () => done({ result: 'connected' }));
        s.once('error', (err) => done({ result: 'refused', code: err.code ?? 'error' }));
        setTimeout(() => done({ result: 'timeout' }), 2000).unref();
      });
    }
    // A write on file: create it, append to it, write `from` in this agent's
    // own directory and rename it onto file, or rename file out to `to` in
    // this agent's own directory.
    if (kind === 'write' && WRITE_OPS.includes(op)) {
      try {
        if (op === 'create') fs.writeFileSync(file, 'probe\n', { flag: 'wx', mode: 0o600 });
        if (op === 'append') fs.appendFileSync(file, 'probe\n');
        if (op === 'rename') {
          fs.writeFileSync(from, 'probe\n', { mode: 0o600 });
          fs.renameSync(from, file);
        }
        if (op === 'rename-out') fs.renameSync(file, to);
        return { result: 'written' };
      } catch (err) {
        return { result: 'refused', code: err.code ?? 'error' };
      }
    }
    throw new Error('unknown probe');
  },

  stop() {
    return { stopped: true };
  },
}));
