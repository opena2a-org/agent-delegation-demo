// Prints the bank broker's delegation chain check for each fixture file named,
// beside the fixture's expected result: an observed line per fixture and a
// summary line, as the aap-conformance reference verifier prints. With --trace
// it also prints every check that passed. Exit code 0 when every observed
// result is the expected one, 1 when one is not, 2 on a usage error.
//
//   node scripts/delegation-chain/verify.mjs [--trace] <fixture.json> [...]

import fs from 'node:fs';
import { report } from './report.mjs';

const args = process.argv.slice(2);
const trace = args.includes('--trace');
const files = args.filter((a) => a !== '--trace');
if (files.length === 0 || files.some((f) => f.startsWith('--'))) {
  console.error('usage: node scripts/delegation-chain/verify.mjs [--trace] <fixture.json> [...]');
  process.exit(2);
}

let pass = 0;
for (const file of files) {
  const { ok, lines } = report(JSON.parse(fs.readFileSync(file, 'utf8')), file, { trace });
  if (ok) pass += 1;
  for (const line of lines) console.log(line);
}
console.log(`summary: ${pass} pass, ${files.length - pass} fail (${files.length} fixtures)`);
process.exit(pass === files.length ? 0 : 1);
