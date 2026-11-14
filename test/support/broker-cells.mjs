// Broker cells, run inside the sandbox profile by broker-isolation.test.mjs
// and k17.test.mjs.
//   home <mode>:    starts and stops a broker with HOME set to an empty
//                   directory, then counts what appeared under HOME.
//   resolve <mode>: asks the broker's /resolve for a canary variable that a
//                   policy file allows.
//   grant <mode>:   starts a broker, writes one line naming its socket, its
//                   TCP port and its token file, and runs until stdin
//                   closes; the test process sends the K17 requests to it.
// mode "bank" builds the broker exactly as the bank does. The other modes
// are the mutants the checks must catch, built in this script and nowhere in src:
// "no-grant-resolver" is the bank's construction with grantResolver: null.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BankBroker, loadTrust, makeSigningKey, refusingResolver } from '../../src/bank/broker.mjs';

const require = createRequire(import.meta.url);
const broker = require('secretless-ai/dist/broker/index.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [work, cell, mode, canaryName] = process.argv.slice(2);

const bankDir = path.join(work, 'bank');
const sockDir = path.join(work, 'sock');
fs.mkdirSync(bankDir, { mode: 0o700 });
fs.mkdirSync(sockDir, { mode: 0o700 });
const grantFile = path.join(bankDir, 'grants.json');
fs.writeFileSync(grantFile, JSON.stringify({ version: 1, providers: {}, bindings: [] }));
const policyFile = path.join(bankDir, 'policy.json');
if (cell === 'resolve') {
  fs.writeFileSync(policyFile, JSON.stringify({ rules: [{ id: 'cell', agentSelector: 'cell-agent', credentialSelector: canaryName, constraints: {}, effect: 'allow' }] }));
}

const bb = new BankBroker({ bankDir, sockDir, trust: loadTrust(path.join(ROOT, 'fixtures/issuer/trust.json')), signing: makeSigningKey(), grantFile });
let server;
if (mode === 'bank') {
  await bb.start();
  server = bb.server;
} else {
  const audit = new broker.AuditLogger(bb.paths.auditLog);
  const config = { socketPath: bb.paths.socketPath, httpPort: 0, policyFile, auditLog: bb.paths.auditLog, tokenFile: bb.paths.tokenFile };
  if (mode === 'no-token-file') delete config.tokenFile;
  let deps = { resolver: { resolve: async () => undefined, exists: async () => false }, audit, aimClient: null };
  if (mode === 'no-resolver') deps = { audit, aimClient: null };
  if (mode === 'no-grant-resolver') deps = { resolver: refusingResolver, audit, aimClient: null, grantResolver: null };
  server = new broker.BrokerServer(config, deps);
  await server.start();
}

if (cell === 'grant') {
  process.stdout.write(`${JSON.stringify({ socketPath: bb.paths.socketPath, port: server.httpServer.address().port, tokenFile: bb.paths.tokenFile })}\n`);
  await new Promise((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.resume();
  });
  await server.stop();
  process.exit(0);
}

const out = { cell, mode };
if (cell === 'resolve') {
  const token = fs.readFileSync(bb.paths.tokenFile, 'utf8').trim();
  const body = JSON.stringify({ agentId: 'cell-agent', credentialName: canaryName });
  const res = await new Promise((resolve) => {
    const req = http.request({ socketPath: bb.paths.socketPath, path: '/resolve', method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve({ status: null, text: '' }));
    req.end(body);
  });
  out.status = res.status;
  out.bodyCarriesCanary = res.text.includes(process.env[canaryName] ?? '\u0000none');
}
await server.stop();
const home = os.homedir();
let entries = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    entries += 1;
    if (e.isDirectory()) walk(path.join(d, e.name));
  }
};
walk(home);
out.homeEntries = entries;
out.secretlessDirInHome = fs.existsSync(path.join(home, '.secretless-ai'));
process.stdout.write(`${JSON.stringify(out)}\n`);
