// The grant path, end to end: the bank process with its broker, token
// service and payment API, and the grant path agents, each under its own
// sandbox profile where the system has one. Assertions read the bank's state.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DemoRun, REPO_ROOT } from '../src/orchestrator/run.mjs';
import { deniesWrite } from '../src/orchestrator/sandbox.mjs';
import { ENV_ALLOWLIST } from '../src/orchestrator/env.mjs';
import { AGENTS, BUDGET_CONSENT_TERMS, INVOICES } from '../src/config.mjs';
import { formatUsd } from '../src/bank/money.mjs';
import { assertNoTokenOutsideBrokerTokenCopy, credentialAndPathFindings, emitted, filesUnder, stopAndCollect, witnessedRun } from './support/emitted.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CANARY = `LAUNCHER_CANARY_${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
process.env[CANARY] = crypto.randomBytes(16).toString('hex');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const frozen = (st) => JSON.stringify({
  balance: st.customers.B.balanceCents,
  payees: st.customers.B.payees,
  ledger: st.ledger,
  consents: st.consents,
});

// The broker socket as it stands: a socket, and its permission bits.
function socketState(file, after) {
  const st = fs.statSync(file);
  return { after, isSocket: st.isSocket(), mode: st.mode & 0o777 };
}

function listeners(pid) {
  try {
    const text = execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' });
    return text.trim().split('\n').slice(1).map((l) => l.trim().split(/\s+/).at(-2));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return [];
  }
}

// WR1 to WR3: the grant path agent's write probes on the bank directory and on
// the repository checkout, and their controls. The test process, outside every
// profile, plants the targets, reads what each probe left, and removes every
// file the probes made, so no later reading of this run sees one.
async function writeProbes(run) {
  const B = run.agents['B:billpay'];
  const A = run.agents['A:billpay'];
  const own = run.agentDir('B', 'billpay');
  const prefix = `wr-${run.runId}-`;
  const at = {
    target: path.join(run.dirs.bank, 'write-target.txt'),
    out: path.join(run.dirs.bank, `${prefix}out`),
    create: path.join(run.dirs.bank, `${prefix}create`),
    control: path.join(run.dirs.bank, `${prefix}control`),
    checkout: path.join(REPO_ROOT, `.${prefix}create`),
  };
  const write = (agent, params) => agent.call('probe', { kind: 'write', ...params });
  const digest = (f) => (fs.existsSync(f) ? sha(fs.readFileSync(f)) : null);
  fs.writeFileSync(at.target, 'write target\n', { mode: 0o600 });
  fs.writeFileSync(at.out, 'rename out\n', { mode: 0o600 });
  const w = { answers: {}, planted: { target: digest(at.target), out: digest(at.out) } };
  try {
    w.answers.bank = {
      create: await write(B, { op: 'create', file: at.create }),
      append: await write(B, { op: 'append', file: at.target }),
      rename: await write(B, { op: 'rename', from: path.join(own, `${prefix}from`), file: at.target }),
      renameOut: await write(B, { op: 'rename-out', file: at.out, to: path.join(own, `${prefix}out`) }),
    };
    w.answers.checkout = await write(B, { op: 'create', file: at.checkout });
    w.answers.own = {
      create: await write(B, { op: 'create', file: path.join(own, `${prefix}own`) }),
      append: await write(B, { op: 'append', file: path.join(own, `${prefix}own`) }),
      rename: await write(B, { op: 'rename', from: path.join(own, `${prefix}own-from`), file: path.join(own, `${prefix}own-to`) }),
    };
    w.answers.control = await write(A, { op: 'create', file: at.control });
    w.after = {
      createExists: fs.existsSync(at.create),
      target: digest(at.target),
      out: digest(at.out),
      checkoutExists: fs.existsSync(at.checkout),
      controlExists: fs.existsSync(at.control),
    };
  } finally {
    for (const f of Object.values(at)) fs.rmSync(f, { force: true });
    for (const name of fs.readdirSync(own)) if (name.startsWith(prefix)) fs.rmSync(path.join(own, name), { force: true });
  }
  return w;
}

const R = {};
let run;

before(async () => {
  run = await witnessedRun();
  R.sandbox = run.sandbox;
  R.thumbprint = run.bankInfo.brokerKeyThumbprint;
  R.socketPath = run.bankInfo.socketPath;
  R.socketStates = [socketState(R.socketPath, 'start')];
  assert.equal(await run.customerSignIn('B'), true);
  R.approve = await run.approve('billpay');
  R.socketStates.push(socketState(R.socketPath, 'restart after the bill pay approval'));
  await run.approve('budget');
  R.socketStates.push(socketState(R.socketPath, 'restart after the budget approval'));
  R.tokenDigest = sha(fs.readFileSync(path.join(run.dirs.bank, 'broker.token')));
  R.modes = filesUnder(run.runDir).concat([run.runDir]).map((f) => ({ f: path.relative(run.runDir, f), mode: fs.statSync(f).mode & 0o777, dir: fs.statSync(f).isDirectory() }));
  for (const d of ['bank', 'sock', 'agent-b-billpay', 'agent-b-budget', 'agent-a-billpay', 'evidence']) R.modes.push({ f: d, mode: fs.statSync(path.join(run.runDir, d)).mode & 0o777, dir: true });

  R.s1 = await run.agentTask('B', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
  R.afterS1 = await run.state();
  R.s2 = await run.agentTask('B', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.lakesideFake });
  R.afterS2 = await run.state();
  R.cross = await run.agentTask('B', 'budget', { kind: 'pay-invoice', invoice: INVOICES.cityWater, present: { grant: `grant://${run.consents.billpay.grantName}` } });
  R.afterCross = await run.state();

  R.health = {};
  for (const [name, ch] of Object.entries(run.agents)) R.health[name] = await ch.call('health', { canaryName: CANARY });
  R.health.bank = await run.bank.call('health', { canaryName: CANARY });
  R.probeTcp = await run.agents['B:billpay'].call('probe', { kind: 'tcp', port: run.ports.resource });
  R.probeRead = await run.agents['B:billpay'].call('probe', { kind: 'read', file: path.join(run.dirs.bank, 'sentinel.txt') });
  R.write = await writeProbes(run);
  R.profileTexts = Object.fromEntries(['agent-b-billpay', 'agent-b-budget', 'agent-a-billpay'].map((name) => {
    const file = path.join(run.dirs.profiles, `${name}.sb`);
    return [name, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null];
  }));
  R.bankReal = fs.realpathSync(run.dirs.bank);
  R.repoReal = fs.realpathSync(REPO_ROOT);
  R.listeners = run.pids().map((p) => ({ name: p.name, addrs: listeners(p.pid) }));
  const bankAddrs = listeners(run.bank.pid) ?? [];
  const known = new Set(Object.values(run.ports).map(String));
  R.brokerTcpPort = bankAddrs.map((a) => a.split(':').pop()).find((p) => !known.has(p)) ?? null;
  if (R.brokerTcpPort) {
    const token = fs.readFileSync(path.join(run.agentDir('B', 'billpay'), 'broker.token'), 'utf8').trim();
    const atx = JSON.parse(fs.readFileSync(path.join(run.agentDir('B', 'billpay'), 'atx.json'), 'utf8'));
    const res = await fetch(`http://127.0.0.1:${R.brokerTcpPort}/grant`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: atx.agentId, grant: `grant://${run.consents.billpay.grantName}`, atx, operation: { method: 'GET', path: '/v1/balance' } }),
    });
    R.grantOverTcp = res.status;
  }
  // K17, from this broker in this run: an authenticated POST /grant {} on its
  // socket and on its TCP port.
  if (R.brokerTcpPort) {
    const { postGrant } = await import('./support/k17.mjs');
    const token = fs.readFileSync(path.join(run.dirs.bank, 'broker.token'), 'utf8').trim();
    R.k17 = {
      socket: await postGrant({ socketPath: run.bankInfo.socketPath, token }),
      tcp: await postGrant({ port: Number(R.brokerTcpPort), token }),
    };
  }

  const consentsBefore = JSON.stringify((await run.state()).consentHistory);
  const atx = JSON.parse(fs.readFileSync(path.join(run.agentDir('B', 'billpay'), 'atx.json'), 'utf8'));
  const terms = { permissions: ['payment:billpay'], creditorAccounts: ['DEMO-0000-4417'], maximumIndividualAmount: { amount: '9999.00', currency: 'USD' }, periodicLimits: [], validToDateTime: '2027-03-31T23:59:59Z' };
  const body = JSON.stringify({ agentRole: 'billpay', atx, terms });
  // node:http, because fetch replaces a Host header set by the caller.
  const post = (headers, payload = body) => new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port: run.ports.online,
      path: '/consents',
      method: 'POST',
      headers: { Authorization: `Bearer ${run.sessions.B}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', () => resolve({ status: null }));
    req.end(payload);
  });
  R.rebindHost = (await post({ Host: 'rebind.example' })).status;
  R.rebindOrigin = (await post({ Origin: 'http://rebind.example' })).status;
  R.consentsUnchanged = JSON.stringify((await run.state()).consentHistory) === consentsBefore;

  // The credential check on approval, with the request itself well formed:
  // a tampered credential (a capability added after signing), a valid
  // credential without the trust class of the requested role (the bill pay
  // credential for the budget role, which needs payment:read), and no
  // credential at all. Each is refused, and no consent record is written.
  const activeBefore = (await run.state()).consents.length;
  const tampered = JSON.stringify({ agentRole: 'billpay', atx: { ...atx, capabilities: [...atx.capabilities, 'payment:read'] }, terms });
  const withoutClass = JSON.stringify({ agentRole: 'budget', atx, terms: BUDGET_CONSENT_TERMS });
  const noCredential = JSON.stringify({ agentRole: 'billpay', terms });
  R.approveTampered = (await post({}, tampered)).status;
  R.approveWithoutClass = (await post({}, withoutClass)).status;
  R.approveNoCredential = (await post({}, noCredential)).status;
  const afterBad = await run.state();
  R.badCredentialUnchanged = JSON.stringify(afterBad.consentHistory) === consentsBefore && afterBad.consents.length === activeBefore;

  R.withdraw = await run.withdraw('billpay');
  R.socketStates.push(socketState(R.socketPath, 'restart after the withdrawal'));
  R.afterWithdrawToken = sha(fs.readFileSync(path.join(run.dirs.bank, 'broker.token')));
  R.s3BillPay = await run.agentTask('B', 'billpay', { kind: 'pay-invoice', invoice: INVOICES.cityWater });
  R.s3Budget = await run.agentTask('B', 'budget', { kind: 'read-balance' });
  R.s3Customer = await run.customerBalance('B');
  R.afterS3 = await run.state();
  // A grant path agent asked to present a credential file it was not given.
  R.notGiven = await run.agentTask('B', 'budget', { kind: 'read-balance', present: { atxFile: 'not-given.atx.json' } })
    .then(() => ({ refused: false, message: null }), (err) => ({ refused: true, message: err.message }));
  // A second process of this operating system user, outside every sandbox,
  // calls the broker socket with the token from the bill pay agent's copy,
  // and makes the same call without it.
  R.sameUser = JSON.parse(execFileSync(process.execPath, [path.join(HERE, 'support/socket-caller.mjs'), R.socketPath, path.join(run.agentDir('B', 'billpay'), 'broker.token')], { encoding: 'utf8', env: {} }).trim());
  R.records = await run.records();
  R.witness = await run.pathBOp({ name: 'witness' });
  R.bankHomeEntries = filesUnder(run.dirs.bankHome).length + fs.readdirSync(run.dirs.bankHome).length;
  R.tokenAtEnd = fs.readFileSync(path.join(run.dirs.bank, 'broker.token'), 'utf8').trim();
  R.runDir = run.runDir;
  R.allFiles = await stopAndCollect(run);
  R.agentFiles = Object.fromEntries(['billpay', 'budget'].map((role) => [role, R.allFiles.filter((f) => f.pathKey === 'B' && f.rel.startsWith(`agent-b-${role}/`))]));
  R.reports = run.reports;
  R.answers = Object.entries({ s1: R.s1, s2: R.s2, cross: R.cross, s3BillPay: R.s3BillPay, s3Budget: R.s3Budget, health: R.health, probeTcp: R.probeTcp, probeRead: R.probeRead, write: R.write.answers, notGiven: R.notGiven })
    .map(([k, v]) => ({ where: `answer ${k}`, text: JSON.stringify(v) }));
  R.afterStopFiles = filesUnder(R.runDir).map((f) => path.relative(R.runDir, f));
  R.evidenceTexts = filesUnder(path.join(R.runDir, 'evidence')).map((f) => fs.readFileSync(f, 'utf8'));
});

after(async () => {
  if (run) await run.stop();
});

test('scenario 1 on the grant path: City Water is paid, the balance is $4,713.60', () => {
  assert.equal(R.s1.answer.status, 200);
  assert.equal(formatUsd(R.afterS1.customers.B.balanceCents), '$4,713.60');
  const row = R.afterS1.ledger.at(-1);
  assert.equal(row.channel, 'agent under consent');
  assert.equal(row.agentId, 'demo_billpay_agent');
  assert.equal(row.consentId, run.consents.billpay.consentId);
});

test('scenario 2 on the grant path: the payment to account ending 4417 is refused on creditorAccounts; no money moved', () => {
  assert.equal(R.s2.followedHiddenInstruction, true);
  assert.equal(R.s2.answer.status, 403);
  assert.deepEqual(R.s2.answer.body, { status: 'refused' }, 'the agent is not told why');
  const d = R.afterS2.decisions.at(-1);
  assert.equal(d.decision, 'refused');
  assert.equal(d.failingField, 'creditorAccounts');
  assert.equal(frozen(R.afterS2), frozen(R.afterS1));
  assert.equal(formatUsd(R.afterS2.customers.B.balanceCents), '$4,713.60');
  assert.ok(!R.afterS2.customers.B.payees.some((p) => p.account === 'DEMO-0000-4417'));
});

test('another agent presenting the bill pay grant with its own valid credential is refused on the agent field; state unchanged', () => {
  assert.equal(R.cross.answer.status, 403);
  assert.deepEqual(R.cross.answer.body, { status: 'refused' });
  const d = R.afterCross.decisions.at(-1);
  assert.equal(d.failingField, 'agent');
  assert.equal(d.agentDid, 'did:opena2a:agent:demo_budget_agent');
  assert.equal(frozen(R.afterCross), frozen(R.afterS2));
});

test('the broker token names the consent: every minted scope equals a consent id', () => {
  const issued = R.records.exchanges.filter((e) => e.accepted);
  assert.ok(issued.length >= 3);
  const ids = new Set(R.afterS3.consentHistory.map((h) => h.record.consentId));
  for (const e of issued) assert.ok(ids.has(e.claims.scope), e.claims.scope);
  const billpay = issued.filter((e) => e.claims.sub === 'did:opena2a:agent:demo_billpay_agent');
  for (const e of billpay) assert.equal(e.claims.scope, run.consents.billpay.consentId);
});

test('one broker token per operation: each payment attempt that reached the bank pairs with one exchange', () => {
  const attempts = R.afterS3.decisions.length;
  assert.equal(R.records.exchanges.filter((e) => e.accepted).length, attempts);
});

test('revoking one agent: the broker refuses it; the other agent and the customer keep working', () => {
  assert.equal(R.withdraw.status, 'withdrawn');
  assert.ok(typeof R.withdraw.restartSeconds === 'number');
  assert.equal(R.s3BillPay.answer.step, 'broker');
  assert.equal(R.s3BillPay.answer.status, 403);
  assert.equal(R.s3Budget.answer.status, 200);
  assert.equal(R.s3Customer.status, 200);
  assert.equal(R.afterS3.consents.some((c) => c.agentId === 'demo_billpay_agent'), false, 'the consent record is removed from the active set');
  assert.equal(R.afterS3.ledger.length, R.afterS2.ledger.length);
  assert.equal(R.records.grantBindings, 1, 'one binding left: the budget agent');
});

test('grant path agent files: the given files and the agent\'s own and no other; no JWS and no access_token field in any; no 64 hex value in the agent log or an answer; the broker token copy is present', () => {
  for (const [role, files] of Object.entries(R.agentFiles)) {
    const names = files.map((f) => f.name).sort();
    for (const n of names) assert.ok(['agent.log', 'atx.json', 'broker.token', 'grant.json', 'stderr.log', 'atx-copy.json'].includes(n), `${role}: ${n}`);
    for (const f of files) {
      assert.equal(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(f.text), false, `${role}/${f.name} carries a JWS`);
      assert.equal(/access_token/.test(f.text), false, `${role}/${f.name} carries an access token`);
    }
    const log = files.find((f) => f.name === 'agent.log').text;
    assert.equal(/[0-9a-f]{64}/.test(log), false, `${role} log carries a 64 hex token`);
  }
  for (const a of [R.s1, R.s2, R.cross, R.s3BillPay, R.s3Budget]) {
    const text = JSON.stringify(a);
    assert.equal(/eyJ|access_token|[0-9a-f]{64}/.test(text), false, text);
  }
  assert.ok(R.agentFiles.billpay.some((f) => f.name === 'broker.token'), 'the broker token copy is in the agent directory');
});

test('by value: every broker token the broker wrote appears in no agent file but a grant path agent\'s broker.token copy, and no access token the token service issued appears in any agent file (stderr.log included), report or answer', () => {
  const w = R.witness;
  assert.ok(R.records.brokerStarts >= 4, 'the run starts the broker once and restarts it three times');
  assert.equal(w.brokerTokens.length, R.records.brokerStarts, 'one witnessed broker token per broker start');
  assert.equal(new Set(w.brokerTokens).size, w.brokerTokens.length, 'a new broker token at every start');
  assert.equal(w.brokerTokens.every((t) => /^[0-9a-f]{64}$/.test(t)), true, 'every broker token is 64 hex');
  assert.equal(w.accessTokens.length, R.records.exchanges.filter((e) => e.accepted).length, 'one witnessed access token per accepted exchange');
  assert.ok(w.accessTokens.length >= 3);
  assert.equal(w.accessTokens.every((t) => /^[0-9a-f]{64}$/.test(t)), true, 'every access token is 64 hex');
  for (const d of ['agent-a-billpay', 'agent-a-budget', 'agent-b-billpay', 'agent-b-budget']) {
    for (const n of ['agent.log', 'stderr.log']) assert.ok(R.allFiles.some((f) => f.rel === `${d}/${n}`), `${d}/${n} is in the set`);
  }
  for (const role of ['billpay', 'budget']) {
    const copy = R.agentFiles[role].find((f) => f.name === 'broker.token');
    assert.equal(copy.text.trim() === w.brokerTokens.at(-1), true, `${role}: the broker.token copy holds the token of the last broker start`);
  }
  const reports = Object.entries(R.reports).map(([name, text]) => ({ where: `${name} stdout`, text }));
  assert.equal(reports.length, 4, 'the stdout of all four agents is in the set');
  assertNoTokenOutsideBrokerTokenCopy({ files: R.allFiles, answers: [...R.answers, ...reports], witness: w });
});

test('what the grant path agents emit (agent.log, stderr.log, their reports to the launcher, their answers) carries no agent credential, no broker socket path and no run directory path', () => {
  const credentials = Object.values(AGENTS).map((a) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, a.credentialFile), 'utf8')));
  assert.ok(credentials.every((c) => c.signatures.length >= 1 && typeof c.signatures[0].value === 'string'), 'precondition: every credential carries a signature value');
  const items = [
    ...emitted(R.allFiles, R.reports).filter((i) => i.pathKey === 'B'),
    ...R.answers.filter((a) => a.where !== 'answer health'),
  ];
  for (const where of ['agent-b-billpay/agent.log', 'agent-b-billpay/stderr.log', 'agent-b-budget/agent.log', 'agent-b-budget/stderr.log', 'agent-b-billpay stdout', 'agent-b-budget stdout']) {
    assert.ok(items.some((i) => i.where === where), `${where} is in the set`);
  }
  assert.deepEqual(credentialAndPathFindings({ items, runDir: R.runDir, socketPath: R.socketPath, credentials }), []);
});

test('a grant path agent asked to present a credential file it was not given reports the failure by its code, without the file\'s path', () => {
  assert.equal(R.notGiven.refused, true);
  assert.equal(R.notGiven.message.includes(R.runDir.replace(/^\/private/, '')), false, 'the report names no path under the run directory');
  assert.equal(R.notGiven.message.includes('not-given.atx.json'), false, 'the report names no file');
  assert.equal(R.notGiven.message, 'agent-b-budget: task failed (ENOENT)');
});

test('broker socket admission at this pin: a call carrying the broker token is admitted from a second process of this user, and the same call without it is refused', () => {
  assert.notEqual(R.sameUser.pid, process.pid);
  assert.notEqual(R.sameUser.pid, run.bank.pid);
  assert.equal(R.sameUser.withToken, 200);
  assert.equal(R.sameUser.withoutToken, 401);
});

// On macOS the Node.js runtime sets __CF_USER_TEXT_ENCODING in its own
// environment at start (env -i A=1 node shows it; env -i A=1 /usr/bin/env does
// not), so a child reports it although the launcher never passes it.
const RUNTIME_KEYS = process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [];

test('child environments: keys within the allowlist, the launcher canary absent in every child', () => {
  for (const [name, h] of Object.entries(R.health)) {
    for (const k of h.envKeys) assert.ok(ENV_ALLOWLIST.includes(k) || RUNTIME_KEYS.includes(k), `${name}: ${k}`);
    assert.equal(h.canaryPresent, false, name);
  }
});

test('the grant path agent cannot reach the bank over TCP or read the bank directory', () => {
  assert.equal(R.sandbox.applied, true, 'precondition: /usr/bin/sandbox-exec (macOS); this check needs the OS sandbox and does not run without it');
  assert.equal(R.probeTcp.result, 'refused');
  assert.equal(R.probeRead.result, 'refused');
});

const SANDBOX_PRE = 'precondition: /usr/bin/sandbox-exec (macOS); this check needs the OS sandbox and does not run without it';
// A refusal counts when the probe reached the rule: ENOENT and ENOTDIR say
// that it did not.
const NOT_REACHED = ['ENOENT', 'ENOTDIR'];
const reading = (a) => `${a.result}${a.code ? ` ${a.code}` : ''}`;

test('WR1: the grant path agent cannot create, append to or rename onto a file in the bank directory, or rename a file out of it; the planted files keep their bytes', (t) => {
  const w = R.write;
  for (const [op, a] of Object.entries(w.answers.bank)) t.diagnostic(`WR1 ${op}: ${reading(a)}`);
  assert.equal(R.sandbox.applied, true, SANDBOX_PRE);
  for (const [op, a] of Object.entries(w.answers.bank)) {
    assert.equal(a.result, 'refused', `${op}: ${reading(a)}`);
    assert.equal(NOT_REACHED.includes(a.code), false, `${op}: the probe did not reach the rule (${a.code})`);
  }
  assert.equal(w.after.createExists, false, 'the created file is absent from the bank directory');
  assert.equal(w.after.target, w.planted.target, 'write-target.txt keeps its recorded sha256');
  assert.equal(w.after.out, w.planted.out, 'the file planted for the rename out is in place with its bytes');
});

test('WR2: the grant path agent cannot create a file in the repository checkout', (t) => {
  const a = R.write.answers.checkout;
  t.diagnostic(`WR2 create: ${reading(a)}`);
  assert.equal(R.sandbox.applied, true, SANDBOX_PRE);
  assert.equal(a.result, 'refused', `create: ${reading(a)}`);
  assert.equal(NOT_REACHED.includes(a.code), false, `create: the probe did not reach the rule (${a.code})`);
  assert.equal(R.write.after.checkoutExists, false, 'the file is absent from the checkout (one found there was removed)');
});

test('WR3: the controls in the same run: the grant path agent writes its own directory, the password path agent writes the bank directory, and the profiles applied', (t) => {
  const w = R.write;
  for (const [op, a] of Object.entries(w.answers.own)) t.diagnostic(`WR3 own directory ${op}: ${reading(a)}`);
  t.diagnostic(`WR3 password path agent create in the bank directory: ${reading(w.answers.control)}`);
  assert.equal(R.sandbox.applied, true, SANDBOX_PRE);
  for (const [op, a] of Object.entries(w.answers.own)) assert.equal(a.result, 'written', `own directory ${op}: ${reading(a)}`);
  assert.equal(w.answers.control.result, 'written', `password path agent create: ${reading(w.answers.control)}`);
  assert.equal(w.after.controlExists, true, 'the test process sees the file the password path agent made');
});

test('WR4: the grant path agent profiles as written refuse writes on the bank directory and on the checkout; the password path agent profile refuses neither', () => {
  assert.equal(R.sandbox.applied, true, SANDBOX_PRE);
  for (const name of ['agent-b-billpay', 'agent-b-budget']) {
    assert.equal(deniesWrite(R.profileTexts[name], R.bankReal), true, `${name}.sb: the bank directory`);
    assert.equal(deniesWrite(R.profileTexts[name], R.repoReal), true, `${name}.sb: the checkout`);
  }
  assert.equal(deniesWrite(R.profileTexts['agent-a-billpay'], R.bankReal), false, 'agent-a-billpay.sb: the bank directory');
  assert.equal(deniesWrite(R.profileTexts['agent-a-billpay'], R.repoReal), false, 'agent-a-billpay.sb: the checkout');
});

test('every listener binds a loopback address', () => {
  for (const l of R.listeners) {
    assert.notEqual(l.addrs, null, 'precondition: lsof (/usr/sbin/lsof on macOS) on PATH; without it no listener is seen');
    for (const a of l.addrs) assert.match(a, /^(127\.0\.0\.1|\[::1\]):[0-9]+$/, `${l.name} ${a}`);
  }
  // The bank's four: online banking, the payment API, the token service and
  // the broker's TCP port.
  assert.equal(R.listeners.find((l) => l.name === 'bank').addrs.length, 4);
});

test('K17 on the run: from this broker, an authenticated POST /grant {} reads 400 on the socket, and on the TCP port the value recorded for this pin', async (t) => {
  const { k17Line, k17Problems } = await import('./support/k17.mjs');
  assert.ok(R.k17, 'the broker opens a TCP listener at this pin');
  t.diagnostic(k17Line(R.k17));
  const pins = JSON.parse(fs.readFileSync(new URL('../vendor/pins.json', import.meta.url), 'utf8'));
  assert.deepEqual(k17Problems(R.k17, pins.secretlessAi.commit), []);
});

test('broker TCP port: an authenticated /grant still answers there at this pin (recorded gap until the pin carries the fix that serves grants on the socket alone)', () => {
  assert.ok(R.brokerTcpPort, 'the broker opens a TCP listener at this pin');
  assert.notEqual(R.grantOverTcp, 404);
  assert.ok([200, 403].includes(R.grantOverTcp), String(R.grantOverTcp));
});

// The summary's limits item on the broker says it answers on a TCP port as
// well as on its socket. That sentence is printed while the answer recorded
// above is not 404, and is gone once it is.
test('summary limits: the broker TCP port sentence is present exactly while the recorded answer is not 404', () => {
  const copy = JSON.parse(fs.readFileSync(new URL('../src/view/copy.json', import.meta.url), 'utf8'));
  const items = copy.SCREENS.find((s) => s.id === 'summary').limits.items;
  const sentence = 'It answers grant requests on a local TCP port as well as on its Unix socket.';
  const carrying = items.filter((i) => typeof i === 'string' && i.includes(sentence));
  assert.equal(carrying.length, R.grantOverTcp === 404 ? 0 : 1, String(R.grantOverTcp));
});

// The README's paragraph on that port, under the broker item of its limits
// section, follows the same recorded answer.
test('README limits: the broker TCP port paragraph is present exactly while the recorded answer is not 404', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const paragraph = "\n  The bank's broker opens that port on 127.0.0.1 with a number the operating system picks ";
  assert.equal(readme.split(paragraph).length - 1, R.grantOverTcp === 404 ? 0 : 1, String(R.grantOverTcp));
});

// The README's sentences on the macOS profiles hold where this run
// applied them and the grant path agent's profile refused both ways.
test('README architecture: the macOS profile sentences are present exactly while this run applied the profiles and the grant path agent was refused over TCP and on the bank directory', () => {
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const held = R.sandbox.applied === true && R.probeTcp.result === 'refused' && R.probeRead.result === 'refused';
  for (const s of [
    "except the offline check's rerun, which runs every process under one shared profile.",
    "These refusals come from that profile, not from the socket, so they don't apply in the rerun.",
    "The password path agent's profile doesn't refuse reads of the bank's directory.",
  ]) assert.equal(readme.split(s).length - 1, held ? 1 : 0, s);
});

test('consent requests with a foreign Host or Origin are refused and change no consent record', () => {
  assert.ok(R.rebindHost >= 400 && R.rebindHost < 500, String(R.rebindHost));
  assert.ok(R.rebindOrigin >= 400 && R.rebindOrigin < 500, String(R.rebindOrigin));
  assert.equal(R.consentsUnchanged, true);
});

test('consent approval answers 422 to a tampered credential, a valid credential without the role trust class, and a missing credential; no consent record is written', () => {
  assert.equal(R.approveTampered, 422);
  assert.equal(R.approveWithoutClass, 422);
  assert.equal(R.approveNoCredential, 422);
  assert.equal(R.badCredentialUnchanged, true);
});

test('the broker token changes at every broker start', () => {
  assert.notEqual(R.afterWithdrawToken, R.tokenDigest);
});

test('run directory modes: directories 0700, key and token files 0600, and the broker socket a socket at 0600 after every broker start', () => {
  for (const m of R.modes) {
    if (m.dir) assert.equal(m.mode, 0o700, m.f);
    else if (/\.(key|token)$/.test(m.f)) assert.equal(m.mode, 0o600, m.f);
  }
  assert.equal(R.socketPath, path.join(R.runDir, 'sock', 'broker.sock'));
  assert.equal(R.socketStates.length, R.records.brokerStarts, 'one reading per broker start');
  for (const s of R.socketStates) {
    assert.equal(s.isSocket, true, s.after);
    assert.equal(s.mode, 0o600, s.after);
  }
});

test('the bank process left nothing under its HOME', () => {
  assert.equal(R.bankHomeEntries, 0);
});

test('after the run stops: no private key file and no token file remain; the evidence holds no private key and no token', () => {
  for (const f of R.afterStopFiles) {
    assert.equal(/\.(key|token)$/.test(f), false, f);
  }
  for (const t of R.evidenceTexts) {
    assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t), false);
    assert.equal(t.includes(R.tokenAtEnd), false);
  }
});

test('the token service trusts one key: the run broker key, which is no upstream vector key', () => {
  assert.equal(R.records.cgtKeySet.length, 1);
  assert.equal(R.records.cgtKeySet[0].thumbprint, R.thumbprint);
  const x = Buffer.from(R.records.cgtKeySet[0].x, 'base64url').toString('hex');
  const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/upstream-vector-keys.json', import.meta.url), 'utf8'));
  assert.ok(vectors.publicKeyHex.length > 0);
  assert.equal(vectors.publicKeyHex.includes(x), false);
});

test('a run that did not ask for the witness keeps none: the bank refuses the witness operation', async () => {
  const plain = await DemoRun.create();
  try {
    await assert.rejects(plain.pathBOp({ name: 'witness' }), /this run keeps no witness/);
  } finally {
    await plain.stop();
  }
});

test('two runs: different broker keys and different broker tokens', async () => {
  const other = await DemoRun.create();
  try {
    assert.notEqual(other.bankInfo.brokerKeyThumbprint, R.thumbprint);
    const t = sha(fs.readFileSync(path.join(other.dirs.bank, 'broker.token')));
    assert.notEqual(t, R.tokenDigest);
    assert.notEqual(t, R.afterWithdrawToken);
  } finally {
    await other.stop();
  }
});
