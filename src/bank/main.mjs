// The bank process. It runs the online banking listener (the password path)
// and, for the grant path, the bank's broker, its token service and the
// payment API the broker calls. The launcher talks to it over stdin and
// stdout; customers and agents reach it over loopback HTTP or the broker's
// Unix socket.

import http from 'node:http';
import { serve } from '../orchestrator/channel.mjs';
import { close, listen } from '../http.mjs';
import { BankState } from './state.mjs';
import { onlineHandler } from './online.mjs';
import { grantPathDispute, passwordPathDispute } from './dispute.mjs';

const ctx = {
  bank: new BankState(),
  servers: {},
  routes: {},
  config: null,
  pathB: null,
};

serve({
  async init(params) {
    ctx.config = params;
    const { ports, origins } = params;
    if (params.pathB) {
      const { startPathB } = await import('./path-b.mjs');
      ctx.pathB = await startPathB(ctx, params);
    }
    ctx.servers.online = http.createServer(onlineHandler(ctx.bank, { port: ports.online, origins, routes: ctx.routes }));
    await listen(ctx.servers.online, ports.online);
    return { pid: process.pid, home: process.env.HOME, ...(ctx.pathB ? ctx.pathB.describe() : {}) };
  },

  setPassword({ customer, password }) {
    ctx.bank.setPassword(customer, password);
    return { ok: true };
  },

  state() {
    return ctx.bank.snapshot();
  },

  async records() {
    return ctx.pathB ? ctx.pathB.records() : { audit: null };
  },

  dispute({ rowId }) {
    const state = ctx.bank.snapshot();
    const row = state.ledger.find((r) => r.rowId === rowId);
    if (!row) throw new Error('no such ledger row');
    if (row.path === 'A') return passwordPathDispute(state, rowId);
    return grantPathDispute(state, ctx.pathB.records().audit, ctx.bank.consentAsOf(row.consentId), rowId);
  },

  health({ canaryName } = {}) {
    return {
      ok: true,
      pid: process.pid,
      envKeys: Object.keys(process.env).sort(),
      canaryPresent: typeof canaryName === 'string' && canaryName.length > 0 ? process.env[canaryName] !== undefined : null,
      broker: ctx.pathB ? ctx.pathB.brokerRunning() : null,
    };
  },

  async pathBOp(params) {
    if (!ctx.pathB) throw new Error('grant path not started');
    return ctx.pathB.op(params);
  },

  async stop() {
    if (ctx.pathB) await ctx.pathB.stop();
    for (const s of Object.values(ctx.servers)) await close(s);
    return { stopped: true };
  },
});
