// npm start: one foreground process tree with the bank, its broker, the
// token service, the payment API, the password path sign in, both agents on
// each path and the view server.
//
// This file imports node: modules and nothing else. It checks the platform,
// then loads the start checks (src/start/checks.mjs): the platform against
// the list in the README, then one probe process started under a profile of
// its own, the way each component is started. Then it checks the Node.js
// version and that NODE_OPTIONS is not set, and loads the connection counter
// into this process. After that it checks that the dependencies resolve, that
// the view port is free and that no arguments were given, and after those
// checks loads the demo.

import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COUNTER = path.join(ROOT, 'src/egress/counter.cjs');
const DEFAULT_PORT = 7380;

// The run directory of this start, made when the counter loads.
let startDir = null;

function refuse(lines) {
  for (const l of lines) process.stdout.write(`${l}\n`);
  if (startDir) fs.rmSync(startDir, { recursive: true, force: true });
  process.exit(1);
}

// The connection counter goes into this process before any module outside node:
// is evaluated, any process is started or any client socket is opened. Its
// file is in a run directory of this start, mode 0700. NODE_OPTIONS is set
// here before the counter loads, so every process started from here gets it,
// with the counter's path as a JSON string: a clone path with a space or a
// double quote loads it too.
function loadCounter() {
  startDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bank-demo-start-')));
  fs.chmodSync(startDir, 0o700);
  const counterFile = path.join(startDir, 'egress.jsonl');
  fs.writeFileSync(counterFile, '', { mode: 0o600 });
  process.env.DEMO_EGRESS_LOG = counterFile;
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(COUNTER)}`;
  createRequire(import.meta.url)(COUNTER);
  // The counter replaces child_process and dns functions on their module
  // objects. This file imported node: modules before the counter loaded, so
  // their ES module bindings are brought up to date, as they are in a process
  // that loads the counter through NODE_OPTIONS.
  syncBuiltinESMExports();
  return counterFile;
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function anyFreePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function main() {
  if (process.platform === 'win32') {
    refuse(['This demo does not run on Windows.', 'Fix: run it on a platform listed under Requirements in the README.']);
  }
  // The start checks load before any other file of the demo, and refuse
  // before any other check.
  const startChecks = await import('../src/start/checks.mjs');
  const checked = startChecks.firstChecks();
  if (checked.refusal) refuse(checked.refusal);
  // The Node.js version, then an inherited NODE_OPTIONS, which is refused,
  // never merged and never replaced. npm run scenarios runs the same two
  // checks with the same functions.
  const early = startChecks.nodeVersionLines() ?? startChecks.nodeOptionsLines('npm start');
  if (early) refuse(early);
  const counterFile = loadCounter();
  // The probe ran before the counter loaded, so it has no hello line: its pid
  // and exit status are recorded beside the counter file, before any
  // component starts.
  fs.writeFileSync(path.join(startDir, 'probe.json'), `${JSON.stringify(checked.probe)}\n`, { mode: 0o600 });
  const deps = startChecks.dependencyLines();
  if (deps) refuse(deps);
  const raw = process.env.PORT;
  const port = raw === undefined || raw === '' ? DEFAULT_PORT : Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    refuse([`PORT must be a port number from 1 to 65535, not ${JSON.stringify(raw)}.`, `Fix: run: PORT=${await anyFreePort()} npm start`]);
  }
  if (!(await portFree(port))) {
    const q = await anyFreePort();
    refuse([`Port ${port} on 127.0.0.1 is in use, possibly by an earlier run of this demo.`, `Fix: stop that run with Ctrl+C in its terminal, or run: PORT=${q} npm start`]);
  }
  if (process.argv.length > 2) {
    const q = await anyFreePort();
    refuse(['npm start takes no arguments.', `Fix: npm start, or to change the port: PORT=${q} npm start`]);
  }

  const { ViewServer } = await import('../src/server/main.mjs');
  const { launcherBuildLabel } = await import('../src/build-info.mjs');
  // Every process of the scenario runs writes to this start's counter file.
  const view = new ViewServer({ port, runOptions: { counterFile } });
  let stopping = false;
  const stop = async (code, lines = ['Stopped.']) => {
    if (stopping) return;
    stopping = true;
    await view.stop().catch(() => {});
    for (const l of lines) process.stdout.write(`${l}\n`);
    process.exit(code);
  };
  // A run whose component was not started under its profile stops the demo
  // with that cause's lines, at the start or after the Ready line. No
  // component starts without its profile. The request that asked for the run
  // is answered before the demo stops, so the view server can close.
  const runOnce = view.run.bind(view);
  view.run = async (target) => {
    try {
      return await runOnce(target);
    } catch (err) {
      const lines = startChecks.notAppliedLines(err);
      if (lines) setImmediate(() => { stop(1, lines); });
      throw err;
    }
  };
  // Ctrl+C in a terminal signals every process of the demo at once, so a
  // component can end before this process runs its own handler. A component
  // that ends while the demo is not stopping, and stays that way for a
  // moment, is reported.
  view.onComponentExit = ({ name, code, log }) => {
    setTimeout(() => {
      stop(1, [`${startChecks.PART_NAMES[name] ?? name} stopped unexpectedly (exit ${code}). The demo has stopped.`, `Log: ${log}`, 'Fix: npm start']);
    }, 500);
  };
  process.on('SIGINT', () => stop(0));
  process.on('SIGTERM', () => stop(0));

  await view.listen();
  try {
    await view.run('setup');
  } catch (err) {
    await stop(1, startChecks.notAppliedLines(err) ?? ['The demo could not start its bank and agents.', 'Fix: npm start']);
    return;
  }
  const health = await view.health();
  if (!health.ok) {
    await stop(1, ['The demo started, but a component did not answer its health check.', 'Fix: npm start']);
    return;
  }
  process.stdout.write(`Agent banking delegation demo, ${launcherBuildLabel()}\n`);
  process.stdout.write(`Ready. Open http://127.0.0.1:${port}/ in a browser.\n`);
  process.stdout.write('Press Ctrl+C to stop.\n');
}

main().catch(() => {
  process.stdout.write('The demo stopped with an error.\nFix: npm start\n');
  process.exit(1);
});
