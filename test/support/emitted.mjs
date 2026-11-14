// What the agents wrote and reported, checked against the values the bank
// made in the run. The bank's witness supplies every broker token its broker
// wrote across the run's starts and every access token its token service
// issued. Values are compared and never printed: a finding names the place and
// the kind of value, never the value.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DemoRun } from '../../src/orchestrator/run.mjs';

// The files the launcher puts into an agent directory. Everything else there
// is written by the agent process or from its stderr.
export const GIVEN_FILES = Object.freeze(['atx.json', 'atx-copy.json', 'broker.token', 'grant.json']);

export function filesUnder(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

// A run with the bank's witness, whose agents' stdout (their reports to the
// launcher) is recorded from the start.
export async function witnessedRun(options = {}) {
  const run = new DemoRun({ ...options, witness: true });
  run.reports = {};
  const spawn = run.spawn.bind(run);
  run.spawn = (name, ...rest) => {
    const channel = spawn(name, ...rest);
    if (name.startsWith('agent-')) {
      run.reports[name] = '';
      channel.child.stdout.on('data', (c) => { run.reports[name] += c.toString('utf8'); });
    }
    return channel;
  };
  try {
    await run.start();
  } catch (err) {
    await run.stop();
    throw err;
  }
  return run;
}

// Every file under every agent directory of the run, both paths.
export function agentFiles(run) {
  const out = [];
  for (const pathKey of ['A', 'B']) {
    for (const role of ['billpay', 'budget']) {
      const dir = run.agentDir(pathKey, role);
      for (const f of filesUnder(dir)) {
        out.push({
          pathKey,
          rel: path.relative(run.runDir, f),
          name: path.basename(f),
          top: path.dirname(f) === dir,
          text: fs.readFileSync(f, 'utf8'),
        });
      }
    }
  }
  return out;
}

// The files as they stand after the run stops (agents exited, logs complete),
// with the ones the stop deletes (the broker.token copies) as read before it.
export async function stopAndCollect(run) {
  const before = agentFiles(run);
  await run.stop();
  await new Promise((resolve) => setImmediate(resolve));
  const after = agentFiles(run);
  const kept = new Set(after.map((f) => f.rel));
  return [...after, ...before.filter((f) => !kept.has(f.rel))];
}

// What the agents emitted: their logs, their stderr and their reports to the
// launcher, without the files the launcher gave them.
export function emitted(files, reports) {
  return [
    ...files.filter((f) => !GIVEN_FILES.includes(f.name)).map((f) => ({ where: f.rel, pathKey: f.pathKey, text: f.text })),
    ...Object.entries(reports).map(([name, text]) => ({ where: `${name} stdout`, pathKey: name.startsWith('agent-b-') ? 'B' : 'A', text })),
  ];
}

// The check by value. The broker token may appear in a grant path agent's
// broker.token copy and nowhere else; an access token may appear nowhere.
export function tokenFindings({ files, answers, brokerTokens, accessTokens }) {
  const findings = [];
  const scan = (where, text, brokerTokenAllowed) => {
    if (!brokerTokenAllowed && brokerTokens.some((t) => text.includes(t))) findings.push({ where, kind: 'broker token' });
    if (accessTokens.some((t) => text.includes(t))) findings.push({ where, kind: 'access token' });
  };
  for (const f of files) scan(f.rel, f.text, f.pathKey === 'B' && f.top && f.name === 'broker.token');
  for (const a of answers) scan(a.where, a.text, false);
  return findings;
}

const unresolved = (p) => (p.startsWith('/private/') ? p.slice('/private'.length) : p);

// The same check's other items, over what a grant path agent emits: no
// agent credential, no broker socket path and no run directory path,
// resolved or not.
export function credentialAndPathFindings({ items, runDir, socketPath, credentials }) {
  const needles = [];
  for (const v of new Set([socketPath, unresolved(socketPath), path.basename(socketPath)])) needles.push({ kind: 'broker socket path', v });
  for (const v of new Set([runDir, unresolved(runDir), path.basename(runDir)])) needles.push({ kind: 'run directory path', v });
  for (const c of credentials) {
    for (const v of [c.id, c.contentHash, ...(c.signatures ?? []).map((s) => s.value)]) needles.push({ kind: 'agent credential', v });
  }
  const findings = [];
  for (const item of items) {
    for (const kind of new Set(needles.filter((n) => item.text.includes(n.v)).map((n) => n.kind))) findings.push({ where: item.where, kind });
  }
  return findings;
}

// The check itself, as test/path-b.test.mjs applies it and as the seeded
// control applies it to a run whose agent log carries the broker token.
export function assertNoTokenOutsideBrokerTokenCopy(collected) {
  const { files, answers, witness } = collected;
  assert.ok(witness.brokerTokens.length >= 1, 'precondition: the witness holds the broker tokens of the run');
  assert.ok(files.some((f) => f.name === 'stderr.log'), 'precondition: the agents\' stderr.log files are in the set');
  const findings = tokenFindings({ files, answers, brokerTokens: witness.brokerTokens, accessTokens: witness.accessTokens });
  assert.deepEqual(findings, [], `a bank-issued value appears where it must not: ${findings.map((f) => `${f.where} (${f.kind})`).join(', ')}`);
}
