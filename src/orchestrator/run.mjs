// One bank run: a fresh run directory, a fresh bank process, four agent
// processes (two per path) and the two customers' own sessions.
//
// The run directory is made under the system temporary directory, outside
// the checkout, mode 0700. Every secret a run makes (the broker's keys and
// the broker token, the token service's access tokens, the customers'
// passwords) lives in a process's memory or in a 0600 file inside it, and the
// key and token files are deleted when the run stops.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, BILLPAY_CONSENT_TERMS, BUDGET_CONSENT_TERMS, CUSTOMERS } from '../config.mjs';
import { launcherRefusalCause, readCounter } from '../egress/classify.mjs';
import { Channel } from './channel.mjs';
import { childEnv } from './env.mjs';
import { freeLoopbackPorts } from './ports.mjs';
import { ProfileNotApplied, SANDBOX_EXEC, componentProfile, realExecPath, sandboxStatus, writeProfile } from './sandbox.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BANK_MAIN = path.join(REPO_ROOT, 'src/bank/main.mjs');
const AGENT_MAIN = path.join(REPO_ROOT, 'src/agent/main.mjs');

const mkdir700 = (p) => {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  fs.chmodSync(p, 0o700);
  return p;
};

export function makeRunDir(prefix = 'bank-demo-run-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.chmodSync(dir, 0o700);
  return dir;
}

export class DemoRun {
  static async create(options = {}) {
    const run = new DemoRun(options);
    try {
      await run.start();
    } catch (err) {
      await run.stop();
      throw err;
    }
    return run;
  }

  // runDir, runId and ports are given by the offline check, which writes its
  // sandbox profile before this run starts. sandbox 'outer' means every
  // process already runs under that one profile, so none gets its own.
  // A given runDir is resolved like a made one: the profiles name the broker
  // socket's directory by path, and the sandbox matches the resolved path.
  // witness asks the bank to keep every broker token and access token it
  // makes, for the tests that compare them with what the agents wrote.
  // counterFile names the counter file the run's processes write to: npm start
  // gives its own, so the launcher's lines and every component's are in one
  // file. Without it a run writes <runDir>/egress.jsonl.
  // On macOS a run's sandbox is 'required' unless the caller names another
  // mode: every component starts through sandbox-exec under its own profile,
  // a system without sandbox-exec stops the run before its directory is made,
  // and a component with no profile is never started. 'off' and 'auto' (a
  // profile where the sandbox is available) are explicit options, and 'auto'
  // is the default on other systems.
  constructor({ sandbox = process.platform === 'darwin' ? 'required' : 'auto', counter = true, counterFile = null, origins = [], spawnEnv = null, brokerFactory = null, pathB = true, runDir = null, runId = null, ports = null, witness = false } = {}) {
    const status = sandboxStatus();
    if (sandbox === 'required' && !status.available) throw new ProfileNotApplied('noSandbox');
    this.sandboxRequired = sandbox === 'required';
    this.pathB = pathB;
    this.runId = runId ?? crypto.randomBytes(4).toString('hex');
    this.runDir = runDir ? fs.realpathSync(runDir) : makeRunDir();
    this.witness = witness === true;
    this.presetPorts = ports;
    this.execPath = realExecPath();
    if (sandbox === 'off') this.sandbox = { applied: false, reason: 'turned off for this run' };
    else if (sandbox === 'outer') this.sandbox = { applied: false, outer: true, reason: 'every process runs under the offline check profile' };
    else this.sandbox = { applied: status.available, reason: status.reason };
    this.counter = counter;
    this.origins = origins;
    this.spawnEnv = spawnEnv;
    this.brokerFactory = brokerFactory;
    this.dirs = {
      bank: mkdir700(path.join(this.runDir, 'bank')),
      bankHome: mkdir700(path.join(this.runDir, 'bank', 'home')),
      sock: mkdir700(path.join(this.runDir, 'sock')),
      control: mkdir700(path.join(this.runDir, 'control')),
      sentinel: mkdir700(path.join(this.runDir, 'control', 'sentinel')),
      evidence: mkdir700(path.join(this.runDir, 'evidence')),
      profiles: mkdir700(path.join(this.runDir, 'profiles')),
    };
    this.egressLog = counter ? (counterFile ?? path.join(this.runDir, 'egress.jsonl')) : null;
    this.passwords = {};
    this.sessions = {};
    this.agents = {};
    this.consents = {};
    this.restarts = [];
    this.processes = [];
    this.stopped = false;
  }

  agentDir(pathKey, role) {
    return path.join(this.runDir, `agent-${pathKey.toLowerCase()}-${role}`);
  }

  // A component under its profile is started by sandbox-exec, in the same
  // process. When its profile is not applied the run stops with the cause
  // (ProfileNotApplied), and the component is never started without it.
  spawn(name, script, { home, profile = null, cwd }) {
    if (this.sandboxRequired && !profile) throw new Error(`${name} has no profile`);
    const env = this.spawnEnv ? this.spawnEnv({ home, egressLog: this.egressLog }) : childEnv({ home, egressLog: this.egressLog });
    let cmd = this.execPath;
    let args = [script];
    const sandboxed = Boolean(profile && this.sandbox.applied);
    if (sandboxed) {
      const file = writeProfile(path.join(this.dirs.profiles, `${name}.sb`), profile);
      cmd = SANDBOX_EXEC;
      args = ['-f', file, this.execPath, script];
    }
    const refused = (err) => (sandboxed ? new ProfileNotApplied(launcherRefusalCause({ spawnError: err.code ?? null }), { part: name }) : err);
    // The system refuses a spawn at once (EPERM), or with an error event and
    // no exit event (ENOENT), which started() reads.
    let child;
    try {
      child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      throw refused(err);
    }
    const record = { name, sandboxed, answered: false, stderr: '' };
    record.started = new Promise((resolve) => {
      child.once('spawn', () => resolve(null));
      child.once('error', (err) => resolve(refused(err)));
    });
    child.on('error', () => {});
    record.channel = new Channel(child, { name, stderrLog: path.join(cwd, 'stderr.log') });
    child.stdout.once('data', () => { record.answered = true; });
    child.stderr.on('data', (chunk) => { if (record.stderr.length < 4096) record.stderr += chunk.toString('utf8'); });
    record.closed = new Promise((resolve) => { child.once('close', resolve); });
    this.processes.push(record);
    return record.channel;
  }

  // Waits until the system has started a component's process. One it
  // refused never runs and has no exit event: it leaves the run's list of
  // processes, and the run stops with the cause.
  async started(channel) {
    const i = this.processes.findIndex((p) => p.channel === channel);
    const err = await this.processes[i].started;
    if (err) {
      this.processes.splice(i, 1);
      throw err;
    }
    return channel;
  }

  // A component under its profile that ended before any answer and
  // wrote no hello line did not start under its profile: the run stops with
  // the cause, read from how sandbox-exec ended, as the offline check reads
  // the rerun's.
  async profileNotApplied() {
    for (const p of this.processes) {
      if (!p.sandboxed || p.answered || !p.channel.exited) continue;
      if (this.egressLog && fs.existsSync(this.egressLog) && readCounter(this.egressLog).lines.some((l) => l.kind === 'hello' && l.main && l.pid === p.channel.pid)) continue;
      // Its stderr is read to the end, and its log written, before the line
      // it starts with is judged.
      await Promise.race([p.closed, new Promise((resolve) => { setTimeout(resolve, 2000).unref(); })]);
      for (let i = 0; i < 20 && (fs.existsSync(p.channel.stderrLog) ? fs.statSync(p.channel.stderrLog).size : 0) < Buffer.byteLength(p.stderr); i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 50); });
      }
      const key = launcherRefusalCause({ exitCode: p.channel.exited.code, stderr: p.stderr.split('\n')[0] || null });
      return new ProfileNotApplied(key, { part: p.name, log: key === 'notApplied' ? p.channel.stderrLog : null });
    }
    return null;
  }

  async start() {
    try {
      await this.startComponents();
    } catch (err) {
      throw (await this.profileNotApplied()) ?? err;
    }
  }

  async startComponents() {
    const [online, resource, token] = this.presetPorts
      ? [this.presetPorts.online, this.presetPorts.resource, this.presetPorts.token]
      : await freeLoopbackPorts(3);
    this.ports = { online, resource, token };
    const bankProfile = componentProfile({
      runId: this.runId,
      execPath: this.execPath,
      tcpPorts: [resource, token],
      unixSubpath: this.runDir,
      sentinelDir: this.dirs.sentinel,
    });
    // A file the bank may read and the grant path agent may not: the agent's
    // control tries to read it.
    fs.writeFileSync(path.join(this.dirs.bank, 'sentinel.txt'), 'bank sentinel\n', { mode: 0o600 });
    this.bank = await this.started(this.spawn('bank', BANK_MAIN, { home: this.dirs.bankHome, profile: bankProfile, cwd: this.dirs.bank }));
    this.bankInfo = await this.bank.call('init', {
      runId: this.runId,
      runDir: this.runDir,
      bankDir: this.dirs.bank,
      sockDir: this.dirs.sock,
      evidenceDir: this.dirs.evidence,
      ports: this.ports,
      origins: this.origins,
      repoRoot: REPO_ROOT,
      pathB: this.pathB,
      brokerFactory: this.brokerFactory,
      witness: this.witness,
    });
    for (const c of Object.values(CUSTOMERS)) {
      this.passwords[c.key] = crypto.randomBytes(18).toString('base64url');
      await this.bank.call('setPassword', { customer: c.key, password: this.passwords[c.key] });
    }

    const agentAProfile = componentProfile({
      runId: this.runId,
      execPath: this.execPath,
      tcpPorts: [online],
      sentinelDir: this.dirs.sentinel,
    });
    const agentBProfile = componentProfile({
      runId: this.runId,
      execPath: this.execPath,
      tcpPorts: [],
      unixSubpath: this.dirs.sock,
      denyReadSubpaths: [this.dirs.bank],
      denyWriteSubpaths: [this.dirs.bank, REPO_ROOT],
      sentinelDir: this.dirs.sentinel,
    });
    for (const pathKey of this.pathB ? ['A', 'B'] : ['A']) {
      for (const role of Object.keys(AGENTS)) {
        const dir = mkdir700(this.agentDir(pathKey, role));
        const home = mkdir700(path.join(dir, 'home'));
        const ch = await this.started(this.spawn(`agent-${pathKey.toLowerCase()}-${role}`, AGENT_MAIN, {
          home,
          profile: pathKey === 'A' ? agentAProfile : agentBProfile,
          cwd: dir,
        }));
        this.agents[`${pathKey}:${role}`] = ch;
        if (pathKey === 'A') {
          await ch.call('configure', {
            path: 'A',
            role,
            agentDir: dir,
            bankUrl: `http://127.0.0.1:${online}`,
            username: CUSTOMERS.A.username,
            password: this.passwords.A,
          });
        } else {
          fs.copyFileSync(path.join(REPO_ROOT, AGENTS[role].credentialFile), path.join(dir, 'atx.json'));
          fs.chmodSync(path.join(dir, 'atx.json'), 0o600);
          await ch.call('configure', { path: 'B', role, agentDir: dir });
        }
      }
    }
  }

  // Customers act through the bank's online banking, with their own sessions.
  async http(method, route, { session = null, body = null, headers = {} } = {}) {
    const h = { Accept: 'application/json', ...headers };
    if (session) h.Authorization = `Bearer ${session}`;
    if (body) h['Content-Type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${this.ports.online}${route}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, body: parsed };
  }

  async customerSignIn(key) {
    const r = await this.http('POST', '/login', { body: { username: CUSTOMERS[key].username, password: this.passwords[key] } });
    this.sessions[key] = r.status === 200 ? r.body.session : null;
    return r.status === 200;
  }

  async customerBalance(key) {
    if (!this.sessions[key]) return { status: 401, refused: true, step: 'no session' };
    const r = await this.http('GET', '/balance', { session: this.sessions[key] });
    return { status: r.status, refused: r.status >= 400, body: r.body };
  }

  async customerChangePassword(key) {
    const next = crypto.randomBytes(18).toString('base64url');
    const r = await this.http('POST', '/password', {
      session: this.sessions[key],
      body: { currentPassword: this.passwords[key], newPassword: next },
    });
    if (r.status === 200) this.passwords[key] = next;
    return { status: r.status, sessionsEnded: r.body?.sessionsEnded ?? null };
  }

  // Customer B approves a consent for one of the grant path agents. The bank
  // verifies the agent's credential, writes the binding into its broker's
  // grant file and restarts its broker; the launcher then gives the agent its
  // grant name and a copy of the broker token.
  async approve(role) {
    const atx = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, AGENTS[role].credentialFile), 'utf8'));
    const terms = role === 'billpay' ? BILLPAY_CONSENT_TERMS : BUDGET_CONSENT_TERMS;
    const r = await this.http('POST', '/consents', { session: this.sessions.B, body: { agentRole: role, atx, terms } });
    if (r.status !== 200) throw new Error(`consent refused (${r.status})`);
    this.consents[role] = { consentId: r.body.consentId, grantName: r.body.grantName };
    this.restarts.push({ reason: 'approve', role, seconds: r.body.restartSeconds });
    this.giveGrant(role, r.body.grantName);
    this.refreshBrokerTokens();
    return r.body;
  }

  async withdraw(role) {
    const c = this.consents[role];
    const r = await this.http('POST', `/consents/${c.consentId}/withdraw`, { session: this.sessions.B });
    if (r.status !== 200) throw new Error(`withdrawal refused (${r.status})`);
    this.restarts.push({ reason: 'withdraw', role, seconds: r.body.restartSeconds });
    this.refreshBrokerTokens();
    return r.body;
  }

  giveGrant(role, grantName, { to = role } = {}) {
    const dir = this.agentDir('B', to);
    const file = path.join(dir, 'grant.json');
    fs.writeFileSync(file, JSON.stringify({ grant: `grant://${grantName}`, socketPath: path.join(this.dirs.sock, 'broker.sock') }), { mode: 0o600 });
  }

  refreshBrokerTokens() {
    const src = path.join(this.dirs.bank, 'broker.token');
    for (const role of Object.keys(AGENTS)) {
      const dir = this.agentDir('B', role);
      if (fs.existsSync(path.join(dir, 'grant.json'))) {
        fs.copyFileSync(src, path.join(dir, 'broker.token'));
        fs.chmodSync(path.join(dir, 'broker.token'), 0o600);
      }
    }
  }

  // Put a copy of one agent's credential into another agent's directory, the
  // way a copied credential would reach a second holder.
  placeCredentialCopy(fromRole, toRole) {
    const dest = path.join(this.agentDir('B', toRole), 'atx-copy.json');
    fs.copyFileSync(path.join(REPO_ROOT, AGENTS[fromRole].credentialFile), dest);
    fs.chmodSync(dest, 0o600);
    return 'atx-copy.json';
  }

  agentTask(pathKey, role, task) {
    return this.agents[`${pathKey}:${role}`].call('task', { task });
  }

  state() {
    return this.bank.call('state');
  }

  records() {
    return this.bank.call('records');
  }

  dispute(rowId) {
    return this.bank.call('dispute', { rowId });
  }

  pathBOp(params) {
    return this.bank.call('pathBOp', params);
  }

  pids() {
    return this.processes.map((p) => ({ name: p.name, pid: p.channel.pid }));
  }

  // Delete every private key file and every token file the run made.
  scrubSecrets() {
    const removed = [];
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch (err) {
        // The offline check's sentinel directory is refused to every process
        // under its profile, this one included. The run writes nothing there.
        if (err.code === 'EPERM' || err.code === 'EACCES') return;
        throw err;
      }
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(key|token)$/.test(e.name) || e.name === 'broker.token') {
          fs.rmSync(p, { force: true });
          removed.push(path.relative(this.runDir, p));
        }
      }
    };
    walk(this.runDir);
    return removed;
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    const agents = this.processes.filter((p) => p.name !== 'bank');
    await Promise.all(agents.map((p) => p.channel.stop()));
    const bank = this.processes.find((p) => p.name === 'bank');
    if (bank) await bank.channel.stop();
    this.passwords = {};
    this.sessions = {};
    this.scrubbed = this.scrubSecrets();
  }
}
