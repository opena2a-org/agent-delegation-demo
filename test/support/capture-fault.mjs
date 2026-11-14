// Runs the walkthrough capture once through the script's own run() seam with
// one named fault, writes each still sidecar to a file as the run generates
// it when a file is given, and exits with run()'s code once its output is
// written.
// The tests of failing closed start it, so each capture runs in a process of
// its own and a test never waits on a handle the capture left open.
//
//   node test/support/capture-fault.mjs <case> <records directory> [<sidecars file>]

import fs from 'node:fs';
import { run } from '../../docs/demo/walkthrough.demo.mjs';

const bump = (st) => JSON.parse(JSON.stringify(st), (k, v) => (typeof v === 'number' ? v + 1 : v));
// The page's Content-Security-Policy stops an in-page fetch before it is
// made, so a second page of the same browser context opens 192.0.2.1, and
// the context's route sees the request and aborts it.
const secondPageTo192 = async (page) => {
  const p2 = await page.context().newPage();
  await p2.goto('http://192.0.2.1/', { timeout: 5000 }).catch(() => null);
  await p2.close();
};
const sidecars = {};
const CASES = {
  'stills-proof': ['stills', { state: (slug, st) => (slug === '02-scenario-1-normal-bill' ? bump(st) : st) }],
  'stills-over-limit': ['stills', {
    bytes: (name, buf) => {
      if (/^\d\d-[a-z0-9-]+\.json$/.test(name)) {
        sidecars[name] = JSON.parse(buf.toString('utf8'));
        if (sidecarsFile) fs.writeFileSync(sidecarsFile, `${JSON.stringify(sidecars, null, 2)}\n`);
      }
      return name === '03-scenario-2-fake-invoice.png' ? Buffer.concat([buf, Buffer.alloc(600001)]) : buf;
    },
  }],
  'stills-request': ['stills', { page: secondPageTo192 }],
  'record-request': ['record', { page: secondPageTo192 }],
};

const [name, records, sidecarsFile] = process.argv.slice(2);
if (!CASES[name] || !records) {
  process.stderr.write(`Usage: node test/support/capture-fault.mjs ${Object.keys(CASES).join('|')} <records directory> [<sidecars file>]\n`);
  process.exit(2);
}
const [mode, faults] = CASES[name];
const code = await run({ argv: [`--${mode}`, '--records', records], faults });
await new Promise((r) => process.stdout.write('', r));
await new Promise((r) => process.stderr.write('', r));
process.exit(code);
