// Writes fixtures/delegation-chain/<case>.json for every case in
// scripts/delegation-chain/cases.mjs, under keys made fresh for this run, and
// removes any other .json file from that directory. The private keys stay in
// this process and are gone when it ends; a fixture holds public keys and
// signed tokens. Run from the repository root:
//
//   node scripts/delegation-chain/generate-fixtures.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCases } from './cases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'fixtures', 'delegation-chain');

fs.mkdirSync(DIR, { recursive: true });
const cases = buildCases();
const names = new Set(cases.map((c) => c.file));
for (const f of fs.readdirSync(DIR)) if (f.endsWith('.json') && !names.has(f)) fs.rmSync(path.join(DIR, f));
for (const { file, fixture } of cases) fs.writeFileSync(path.join(DIR, file), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${cases.length} fixtures to fixtures/delegation-chain/`);
