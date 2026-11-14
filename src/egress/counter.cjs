'use strict';
// Egress counter. Loaded into every process the demo starts with
// NODE_OPTIONS=--require <absolute path to this file>. For each call below it
// appends one JSON line to the file named by DEMO_EGRESS_LOG, before the call
// runs:
//   net.Socket.prototype.connect (TCP and IPC; http, https, tls, fetch and
//     WebSocket all go through it)
//   dgram send and connect, once per caller's call
//   every lookup, resolve* and reverse function of dns, dns.promises and both
//     Resolver prototypes
//   every child_process function, with the child pid; a child environment
//     that lacks NODE_OPTIONS or DEMO_EGRESS_LOG gets them back
//   process.dlopen
// and one hello line per process and per worker thread at load.
//
// It classifies nothing: the harness reads the file with the run's list of
// listener ports. It has no dependencies.

const LOG = process.env.DEMO_EGRESS_LOG;

if (LOG && !globalThis.__demoEgressCounterLoaded) {
  globalThis.__demoEgressCounterLoaded = true;
  const fs = require('node:fs');
  const net = require('node:net');
  const dgram = require('node:dgram');
  const dns = require('node:dns');
  const childProcess = require('node:child_process');
  const { isMainThread, threadId } = require('node:worker_threads');
  const NODE_OPTIONS = process.env.NODE_OPTIONS || '';

  const write = (rec) => {
    try {
      fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), pid: process.pid, ppid: process.ppid, thread: threadId, ...rec }) + '\n');
    } catch {
      // A line that cannot be written leaves a pid without its record, which
      // the harness reads as "not measured".
    }
  };

  write({
    kind: 'hello',
    main: isMainThread,
    execArgv: process.execArgv,
    nodeOptions: NODE_OPTIONS,
    argv1: process.argv[1] ? require('node:path').basename(process.argv[1]) : null,
  });

  // TCP and IPC.
  const origConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...args) {
    let head = args[0];
    if (Array.isArray(head)) head = head[0];
    let rec;
    if (head !== null && typeof head === 'object') {
      if (head.path !== undefined && head.path !== null) rec = { kind: 'ipc', path: String(head.path) };
      else rec = { kind: 'tcp', host: head.host === undefined ? 'localhost' : String(head.host), port: Number(head.port) };
    } else if (typeof head === 'string' && !/^[0-9]+$/.test(head)) {
      rec = { kind: 'ipc', path: head };
    } else {
      rec = { kind: 'tcp', host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(head) };
    }
    write({ fn: 'net.Socket.connect', ...rec });
    return origConnect.apply(this, args);
  };

  // UDP. A send on an unbound socket is queued and re-enters send after the
  // bind; that re-entry is not a second call by the caller.
  const pending = new WeakMap();
  const isBound = (sock) => {
    try { sock.address(); return true; } catch { return false; }
  };
  const origSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function send(...args) {
    const queued = pending.get(this) || 0;
    if (queued > 0 && isBound(this)) {
      pending.set(this, queued - 1);
      return origSend.apply(this, args);
    }
    const port = args.find((a, i) => i > 0 && typeof a === 'number' && Number.isInteger(a) && a > 0 && a < 65536 && typeof args[i + 1] !== 'number');
    const host = args.find((a, i) => i > 0 && typeof a === 'string');
    write({ fn: 'dgram.Socket.send', kind: 'udp', host: host === undefined ? null : host, port: port === undefined ? null : port });
    if (!isBound(this)) pending.set(this, queued + 1);
    return origSend.apply(this, args);
  };
  const origUdpConnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function connect(port, address, ...rest) {
    write({ fn: 'dgram.Socket.connect', kind: 'udp', host: typeof address === 'string' ? address : null, port: Number(port) });
    return origUdpConnect.call(this, port, address, ...rest);
  };

  // DNS.
  const DNS_FN = /^(lookup|lookupService|resolve[A-Za-z0-9]*|reverse)$/;
  const wrapDns = (target, label) => {
    if (!target) return;
    for (const name of Object.getOwnPropertyNames(target)) {
      if (!DNS_FN.test(name)) continue;
      const desc = Object.getOwnPropertyDescriptor(target, name);
      if (!desc || typeof desc.value !== 'function' || !desc.writable && !desc.configurable) continue;
      const orig = desc.value;
      const wrapped = function (...args) {
        write({ fn: `${label}.${name}`, kind: 'dns', name: typeof args[0] === 'string' ? args[0] : null });
        return orig.apply(this, args);
      };
      try {
        Object.defineProperty(target, name, { ...desc, value: wrapped });
      } catch {
        // Left unwrapped: the harness's class test would read it as a miss.
      }
    }
  };
  wrapDns(dns, 'dns');
  wrapDns(dns.promises, 'dns.promises');
  wrapDns(dns.Resolver && dns.Resolver.prototype, 'dns.Resolver');
  wrapDns(dns.promises && dns.promises.Resolver && dns.promises.Resolver.prototype, 'dns.promises.Resolver');

  // Child processes. exec calls execFile through the module object, so the
  // depth guard keeps one line per caller's call.
  let depth = 0;
  const fixEnv = (opts) => {
    if (!opts || typeof opts !== 'object' || Array.isArray(opts) || !opts.env) return;
    if (!opts.env.NODE_OPTIONS && NODE_OPTIONS) opts.env = { ...opts.env, NODE_OPTIONS };
    if (!opts.env.DEMO_EGRESS_LOG) opts.env = { ...opts.env, DEMO_EGRESS_LOG: LOG };
  };
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const orig = childProcess[fn];
    if (typeof orig !== 'function') continue;
    childProcess[fn] = function (...args) {
      if (depth > 0) return orig.apply(this, args);
      for (const a of args) fixEnv(a);
      depth += 1;
      let out;
      try {
        out = orig.apply(this, args);
      } finally {
        depth -= 1;
      }
      const childPid = out && typeof out === 'object' && Number.isInteger(out.pid) ? out.pid : null;
      write({ fn: `child_process.${fn}`, kind: 'child', file: typeof args[0] === 'string' ? args[0] : null, childPid });
      return out;
    };
  }

  // Native modules.
  const origDlopen = process.dlopen;
  process.dlopen = function dlopen(module, filename, ...rest) {
    write({ fn: 'process.dlopen', kind: 'dlopen', filename: String(filename) });
    return origDlopen.call(this, module, filename, ...rest);
  };
}
