// Write test/fixtures/upstream-vector-keys.json from local clones of the two
// conformance repositories at the pinned commits: the public keys of every
// published test vector, and the sha256 of every published seed. No seed is
// written. The tests use the public keys to show the run's broker key is no
// vector key, and the seed digests to show no seed sits in this repository.
//
// Usage: node scripts/checks/vector-digests.mjs <atx-conformance clone> <aap-conformance clone>

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pins = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/pins.json'), 'utf8'));
const [atxClone, aapClone] = process.argv.slice(2);
if (!atxClone || !aapClone) {
  console.error('usage: node scripts/checks/vector-digests.mjs <atx-conformance clone> <aap-conformance clone>');
  process.exit(2);
}
const show = (repo, commit, file) => execFileSync('git', ['-C', repo, 'show', `${commit}:${file}`], { encoding: 'utf8' });
const ls = (repo, commit, dir) => execFileSync('git', ['-C', repo, 'ls-tree', '--name-only', commit, `${dir}/`], { encoding: 'utf8' }).trim().split('\n');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const publicKeyHex = new Set();
const seedSha256 = new Set();
for (const f of ls(atxClone, pins.atxConformance.commit, 'vectors')) {
  if (!f.endsWith('.json')) continue;
  const v = JSON.parse(show(atxClone, pins.atxConformance.commit, f));
  if (v.publicKeyHex && /^[0-9a-f]{64}$/.test(v.publicKeyHex)) publicKeyHex.add(v.publicKeyHex);
  if (v.seedHex) seedSha256.add(sha(v.seedHex));
}
const tk = JSON.parse(show(aapClone, pins.aapConformance.commit, 'vectors/test-keys.json'));
for (const k of tk.keys) {
  if (k.publicJwk && k.publicJwk.kty === 'OKP') publicKeyHex.add(Buffer.from(k.publicJwk.x, 'base64url').toString('hex'));
  for (const field of ['ed25519SeedHex', 'mlDsa65SeedHex']) if (k[field]) seedSha256.add(sha(k[field]));
}
const out = {
  source: {
    atxConformance: { commit: pins.atxConformance.commit, files: 'vectors/*.json' },
    aapConformance: { commit: pins.aapConformance.commit, files: 'vectors/test-keys.json' },
  },
  publicKeyHex: [...publicKeyHex].sort(),
  seedSha256: [...seedSha256].sort(),
};
fs.writeFileSync(path.join(ROOT, 'test/fixtures/upstream-vector-keys.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`public keys ${out.publicKeyHex.length}, seed digests ${out.seedSha256.length}`);
