// One call of each class the egress counter wraps, made inside the offline
// check's block. Every call is meant to be refused there; the test reads the
// counter's lines, which must be exactly one per call. The script prints the
// result of each call as one JSON line.

import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TARGET = { host: '192.0.2.1', port: 9 };
const NAME = 'bank-demo-class-check.test';

const settle = (p, ms = 3000) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);

function tcp() {
  return new Promise((resolve) => {
    const s = net.connect(TARGET);
    s.once('connect', () => { s.destroy(); resolve('connected'); });
    s.once('error', (err) => resolve(err.code ?? 'error'));
  });
}

function udp() {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.once('error', (err) => { s.close(); resolve(err.code ?? 'error'); });
    s.send(Buffer.from('x'), TARGET.port, TARGET.host, (err) => {
      s.close();
      resolve(err ? err.code ?? 'error' : 'sent');
    });
  });
}

function child(script, env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(HERE, script)], { env, stdio: 'ignore' });
    c.once('error', (err) => resolve({ pid: c.pid ?? null, error: err.code ?? 'error' }));
    c.once('exit', (code) => resolve({ pid: c.pid, code }));
  });
}

function worker() {
  return new Promise((resolve) => {
    const w = new Worker(
      "const net = require('node:net');"
        + " const s = net.connect({ host: '192.0.2.1', port: 9 });"
        + " s.once('error', (e) => require('node:worker_threads').parentPort.postMessage(e.code || 'error'));"
        + " s.once('connect', () => { s.destroy(); require('node:worker_threads').parentPort.postMessage('connected'); });",
      { eval: true },
    );
    w.once('message', (m) => { w.terminate(); resolve(m); });
    w.once('error', (err) => resolve(err.code ?? 'error'));
  });
}

const out = { pid: process.pid };
out.tcp = await settle(tcp());
// fetch refuses port 9 itself (a bad port in the Fetch standard) before any
// socket call, so the fetch that is counted goes to port 80.
out.fetch = await settle(fetch(`http://${TARGET.host}:80/`).then(() => 'answered', (err) => err.cause?.code ?? 'error'));
out.fetchPort9 = await settle(fetch(`http://${TARGET.host}:${TARGET.port}/`).then(() => 'answered', (err) => err.cause?.message ?? 'error'));
out.udp = await settle(udp());
out.lookup = await settle(new Promise((resolve) => dns.lookup(NAME, (err) => resolve(err ? err.code ?? 'error' : 'resolved'))));
out.resolve4 = await settle(new Promise((resolve) => dns.resolve4(NAME, (err) => resolve(err ? err.code ?? 'error' : 'resolved'))));
// A child whose environment was replaced: the counter puts itself back.
out.child = await settle(child('child-attempt.mjs', { PATH: '/usr/bin:/bin' }), 5000);
out.worker = await settle(worker());
out.quickExit = await settle(child('quick-exit.mjs', { PATH: '/usr/bin:/bin' }), 5000);
process.stdout.write(`${JSON.stringify(out)}\n`);
