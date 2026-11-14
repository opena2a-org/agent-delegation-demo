// The view server alone, for a page test that starts it inside a sandbox
// profile of the test's own: it listens on a free loopback port, runs no
// scenario, prints one JSON line with its port, and serves until it is sent
// SIGTERM.
//
// Usage: node test/support/view-serve.mjs

import { freeLoopbackPort } from '../../src/orchestrator/ports.mjs';
import { ViewServer } from '../../src/server/main.mjs';

const port = await freeLoopbackPort();
const view = new ViewServer({ port });
let componentExits = 0;
view.onComponentExit = () => { componentExits += 1; };
await view.listen();
process.stdout.write(`${JSON.stringify({ port, pid: process.pid })}\n`);
const stop = async () => {
  await view.stop().catch(() => {});
  process.stderr.write(`component exits: ${componentExits}\n`);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
