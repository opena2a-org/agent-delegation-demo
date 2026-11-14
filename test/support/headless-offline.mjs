// A headless rerun through the API, for the tests: it starts the view server
// on a free loopback port, asks it for the offline check once
// (POST /api/offline), then asks for the index page, and prints one JSON
// line. Its exit code is the verdict: 0 when the count was measured, and 1
// when the check was not run or the count was not measured.
//
// The check is given a reader: when a deny form was seen not refusing, it
// runs scripts/checks/sandbox-witness.mjs on the rerun's root and profile
// file before the root ends, and the result records the witness's lines and
// its exit code (0 pass, 1 fail, 2 inconclusive).
//
// Usage: node test/support/headless-offline.mjs '<options as JSON>'
//   sandboxExec    a path in place of /usr/bin/sandbox-exec
//   open           false to leave out the run as usual
//   widenLoopback  true to replace the loopback port lines with localhost:*
//   dropSentinel   true to drop the sentinel subpath from the store deny form
//   runBefore      a scenario to run (POST /api/run) before the check
//   runAfter       a scenario to ask for after the check, then the check again

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freeLoopbackPort } from '../../src/orchestrator/ports.mjs';
import { ViewServer } from '../../src/server/main.mjs';

const WITNESS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'checks', 'sandbox-witness.mjs');

const opts = JSON.parse(process.argv[2] ?? '{}');
const offlineOptions = {};
if (opts.sandboxExec) offlineOptions.sandboxExec = opts.sandboxExec;
if (opts.open === false) offlineOptions.open = false;
const edits = [];
if (opts.widenLoopback) {
  edits.push((p) => p
    .replace(/\(allow network-outbound \(remote ip "localhost:\d+"\)\)\n/g, '')
    .replace('(deny process-exec', '(allow network-outbound (remote ip "localhost:*"))\n(deny process-exec'));
}
if (opts.dropSentinel) edits.push((p) => p.replace(/ \(subpath "[^"]*\/offline\/sentinel"\)/, ''));
if (edits.length > 0) offlineOptions.editProfile = (p) => edits.reduce((text, edit) => edit(text), p);
offlineOptions.readWitness = ({ pid, profileFile }) => {
  const r = spawnSync(process.execPath, [WITNESS, `rerun=${pid}:${profileFile}`], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', TZ: 'UTC' },
    timeout: 30000,
  });
  return { lines: String(r.stdout ?? '').split('\n').filter(Boolean), exitCode: r.status };
};

const port = await freeLoopbackPort();
const view = new ViewServer({ port, offlineOptions });
let componentExits = 0;
view.onComponentExit = () => { componentExits += 1; };
await view.listen();

async function call(method, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json };
}

let out;
try {
  let before = null;
  let current = null;
  if (opts.runBefore) {
    const r = await call('POST', '/api/run', { scenario: opts.runBefore });
    current = view.current ? view.current.run : null;
    before = { status: r.status, runId: current ? current.runId : null };
  }
  const res = await call('POST', '/api/offline');
  const result = res.json;
  // The launcher reports a component exit 500 ms after its rule is called.
  await new Promise((resolve) => { setTimeout(resolve, 1000); });
  const later = {};
  if (before) {
    later.runBeforeStopped = current ? current.stopped : null;
    later.currentRunId = view.current ? view.current.run.runId : null;
  }
  if (opts.runAfter) {
    later.runAfter = await call('POST', '/api/run', { scenario: opts.runAfter });
    later.offlineAgain = await call('POST', '/api/offline');
    later.currentAfter = view.current ? view.current.run.runId : null;
  }
  const index = await fetch(`http://127.0.0.1:${port}/`);
  await index.text();
  out = { httpStatus: res.status, result, indexStatus: index.status, componentExits, ...(before ? { before } : {}), ...later };
} finally {
  await view.stop();
}
process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(out.result?.status === 'measured' ? 0 : 1);
