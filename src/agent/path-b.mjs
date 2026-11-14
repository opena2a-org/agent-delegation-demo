// The grant path: the agent presents its own credential and a grant name to
// the bank's broker over a Unix socket. Its configuration names no host and
// no port. It is given its credential, the grant name, the socket path and a
// copy of the broker token, which every request to the broker carries; it
// never receives a token the bank's payment API accepts, and never the bank's
// reason for a refusal.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export class GrantTransport {
  constructor({ agentDir }) {
    this.dir = agentDir;
  }

  describe() {
    return { transport: 'grant over the broker socket' };
  }

  load(present) {
    const grantFile = path.join(this.dir, 'grant.json');
    if (!fs.existsSync(grantFile)) return null;
    const g = JSON.parse(fs.readFileSync(grantFile, 'utf8'));
    const atxFile = present?.atxFile ? path.join(this.dir, path.basename(present.atxFile)) : path.join(this.dir, 'atx.json');
    return {
      socketPath: g.socketPath,
      grant: present?.grant ?? g.grant,
      token: fs.readFileSync(path.join(this.dir, 'broker.token'), 'utf8').trim(),
      atx: JSON.parse(fs.readFileSync(atxFile, 'utf8')),
    };
  }

  call(operation, present) {
    const cfg = this.load(present);
    if (!cfg) return Promise.resolve({ step: 'no grant', status: null, refused: true });
    const body = JSON.stringify({ agentId: cfg.atx.agentId, grant: cfg.grant, atx: cfg.atx, operation });
    return new Promise((resolve) => {
      const req = http.request({
        socketPath: cfg.socketPath,
        path: '/grant',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          if (res.statusCode === 200 && parsed && parsed.result) {
            resolve({ step: 'bank', status: parsed.result.status, refused: parsed.result.status >= 400, body: parsed.result.body });
          } else {
            resolve({ step: 'broker', status: res.statusCode, refused: true, body: parsed });
          }
        });
      });
      req.on('error', (err) => resolve({ step: 'broker', status: null, refused: true, error: err.code ?? 'error' }));
      req.end(body);
    });
  }

  pay(attempt, present) {
    return this.call({
      method: 'POST',
      path: '/v1/payments',
      body: { creditorAccount: attempt.payeeAccount, amount: { amount: attempt.amount, currency: attempt.currency } },
    }, present);
  }

  readBalance(present) {
    return this.call({ method: 'GET', path: '/v1/balance' }, present);
  }
}
