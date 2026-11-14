// JSON lines over a child's stdin and stdout: one request, one response,
// matched by id. A child's stderr goes to a log file in its own directory.

import fs from 'node:fs';
import readline from 'node:readline';

export class Channel {
  constructor(child, { name, stderrLog }) {
    this.child = child;
    this.name = name;
    this.nextId = 1;
    this.waiting = new Map();
    this.exited = null;
    this.stderrLog = stderrLog ?? null;
    if (stderrLog) {
      const out = fs.createWriteStream(stderrLog, { flags: 'a', mode: 0o600 });
      child.stderr.pipe(out);
    } else {
      child.stderr.resume();
    }
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      const w = this.waiting.get(msg.id);
      if (!w) return;
      this.waiting.delete(msg.id);
      if (msg.error) w.reject(Object.assign(new Error(`${name}: ${msg.error}`), { remote: true }));
      else w.resolve(msg.result);
    });
    child.on('exit', (code, signal) => {
      this.exited = { code, signal };
      for (const w of this.waiting.values()) w.reject(new Error(`${name} exited (${code ?? signal})`));
      this.waiting.clear();
    });
    child.stdin.on('error', () => {});
  }

  get pid() {
    return this.child.pid;
  }

  call(op, params = {}, { timeoutMs = 30000 } = {}) {
    if (this.exited) return Promise.reject(new Error(`${this.name} is not running`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${this.name}: ${op} timed out`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
    });
  }

  async stop({ timeoutMs = 5000 } = {}) {
    if (this.exited) return this.exited;
    const done = new Promise((resolve) => this.child.once('exit', (code, signal) => resolve({ code, signal })));
    try { await this.call('stop', {}, { timeoutMs }); } catch { /* fall through to a signal */ }
    const t = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    const r = await done;
    clearTimeout(t);
    return r;
  }
}

// The child side: read requests, call the handler, write one response each.
export function serve(handlers) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const h = handlers[msg.op];
    let reply;
    try {
      if (!h) throw new Error(`unknown op ${msg.op}`);
      reply = { id: msg.id, result: (await h(msg.params ?? {})) ?? null };
    } catch (err) {
      reply = { id: msg.id, error: err && err.message ? err.message : 'failed' };
    }
    if (msg.op === 'stop') process.stdout.write(`${JSON.stringify(reply)}\n`, () => process.exit(0));
    else process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
  rl.on('close', () => {
    if (handlers.stop) Promise.resolve(handlers.stop({})).finally(() => process.exit(0));
    else process.exit(0);
  });
}
