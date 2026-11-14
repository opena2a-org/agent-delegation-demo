// The offline check's controls, each made once and never retried. The view
// server makes the outside halves before the rerun starts; the rerun's root
// process makes the inside halves under the offline check profile.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';

// outcome: 'connected', 'timeout' or the error code. EPERM is the sandbox's
// refusal; ECONNREFUSED is an answer from the host.
export function connectOnce(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    const s = net.connect({ host, port });
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      s.destroy();
      resolve({ outcome, ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10 });
    };
    s.once('connect', () => done('connected'));
    s.once('error', (err) => done(err.code ?? 'error'));
    setTimeout(() => done('timeout'), timeoutMs).unref();
  });
}

export function readControl(file) {
  try {
    fs.readFileSync(file);
    return { outcome: 'read' };
  } catch (err) {
    return { outcome: err.code ?? 'error' };
  }
}

export function execControl(file) {
  const r = spawnSync(file, [], { stdio: 'ignore', timeout: 5000 });
  if (r.error) return { outcome: r.error.code ?? 'error' };
  return { outcome: r.status === 0 ? 'ran' : `exit ${r.status}` };
}

// This machine's IPv4 address on the interface listed earliest that is up
// and not loopback. The address goes to the two connects and nowhere else.
export function ownAddress(interfaces = os.networkInterfaces()) {
  for (const [name, addrs] of Object.entries(interfaces)) {
    const a = (addrs ?? []).find((x) => x.family === 'IPv4' && !x.internal);
    if (a) return { interface: name, address: a.address };
  }
  return null;
}
