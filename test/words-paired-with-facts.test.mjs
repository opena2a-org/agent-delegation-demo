// The words beside the facts they state. Each sentence here is printed by a
// build where its fact holds, and each test reads that fact from the build
// itself: the issuer line and the broker record line from the copy file, the
// broker item of the summary's limits from the secretless-ai dependency and
// the vendoring record, the issuer the READMEs name from the issuer trust
// section, and the fixtures README from its own paragraphs.
// The sentence on the broker's TCP port is paired with the answer that port
// gives in the grant path test, which records it on every run.

import './support/outer-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILLS } from '../src/scenarios/labels.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));
const linesWith = (text, s) => text.split('\n').filter((l) => l.includes(s)).length;
const occurrences = (text, s) => text.split(s).length - 1;
// A Markdown paragraph read as one line, the way it renders.
const joined = (text) => text.replace(/\n/g, ' ');

const ISSUER_LINE = 'Test issuer, published key: agent credentials prove nothing outside this demo.';
const ISSUER_LINE_OLDER = 'Agent credentials use a published test key and prove nothing outside this demo.';
const RECORD_LINE = "Signed with the bank broker's key for this run, the broker record isn't evidence against the bank. Payee, amount and bank decision come from the bank's ledger.";
const RECORD_LINE_OLDER = "The signed broker record names the agent, grant and broker decision; the payee, amount and bank decision come from the bank's ledger entry beside it.";

test('copy.json: the issuer line and the broker record line in their set words, in every place they appear, and no older words', () => {
  const copy = json('src/view/copy.json');
  const text = read('src/view/copy.json');
  assert.equal(copy.LABELS.L8, ISSUER_LINE);
  assert.equal(copy.LABELS.L13, RECORD_LINE);
  // The label, the setup screen note, the offline screen note and the summary limits item.
  assert.equal(linesWith(text, ISSUER_LINE), 4);
  // The label, the screen 4 note and the summary limits item.
  assert.equal(linesWith(text, RECORD_LINE), 3);
  assert.equal(linesWith(text, ISSUER_LINE_OLDER), 0);
  assert.equal(linesWith(text, RECORD_LINE_OLDER), 0);
});

// The broker item of the summary's limits names the build the dependency
// installs: the vendored file is an unreleased local build with no provenance
// attestation; an exact version is the npm release with its attestation
// checked. Any other dependency names no build these words describe. The
// item is that sentence, or that sentence, one space and the TCP port
// sentence.
const BROKER_LOCAL = "The bank's broker is an unreleased local build of the AAP reference implementation from secretless-ai at commit {brokerSha12}, with no provenance attestation.";
const BROKER_RELEASE = "The bank's broker is the AAP reference implementation from secretless-ai {secretlessVersion}, installed from npm with its provenance attestation checked.";
const BROKER_TCP = 'It answers grant requests on a local TCP port as well as on its Unix socket.';
const BROKER_ITEM = "The bank's broker is ";

function brokerItemFindings({ spec, lockVersion, items }) {
  const carrying = items.filter((i) => typeof i === 'string' && i.startsWith(BROKER_ITEM));
  if (carrying.length !== 1) return [`${carrying.length} broker items in the summary limits; expected 1`];
  let lead;
  const findings = [];
  if (spec.startsWith('file:vendor/')) {
    lead = BROKER_LOCAL;
  } else if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(spec)) {
    lead = BROKER_RELEASE;
    if (lockVersion !== spec) findings.push(`the lockfile installs ${lockVersion}, the dependency names ${spec}`);
  } else {
    return [`secretless-ai is neither the vendored file nor an exact version: ${spec}`];
  }
  if (carrying[0] !== lead && carrying[0] !== `${lead} ${BROKER_TCP}`) findings.push(`the broker item does not read the words for ${spec}`);
  return findings;
}

const summaryItems = () => json('src/view/copy.json').SCREENS.find((s) => s.id === 'summary').limits.items;

test('summary limits: the broker item names the build the secretless-ai dependency installs, and its commit fill is the vendored commit', () => {
  const spec = json('package.json').dependencies['secretless-ai'];
  const lockVersion = json('package-lock.json').packages['node_modules/secretless-ai']?.version;
  assert.deepEqual(brokerItemFindings({ spec, lockVersion, items: summaryItems() }), []);
  const item = summaryItems().find((i) => typeof i === 'string' && i.startsWith(BROKER_ITEM));
  // Values are read, never typed: the item carries the fill, not a commit or a version.
  assert.doesNotMatch(item, /\b[0-9a-f]{12,40}\b|\b[0-9]+\.[0-9]+\.[0-9]+\b/);
  const markdown = execFileSync('git', ['-C', ROOT, 'ls-files', '*.md'], { encoding: 'utf8' }).trim().split('\n')
    .filter((f) => !f.startsWith('vendor/aap-conformance/') && fs.existsSync(path.join(ROOT, f)));
  if (spec.startsWith('file:vendor/')) {
    assert.ok(item.includes('{brokerSha12}'));
    const record = read('vendor/VENDORED.md');
    const commit = /^\| Commit \| `([0-9a-f]{40})` \|$/m.exec(record.slice(record.indexOf('## secretless-ai')));
    assert.ok(commit, 'vendor/VENDORED.md names the secretless-ai commit');
    assert.equal(FILLS.brokerSha12, commit[1].slice(0, 12));
    assert.ok(spec.endsWith(`.g${FILLS.brokerSha12}.tgz`), spec);
    for (const f of markdown) assert.equal(joined(read(f)).includes('installed from npm with its provenance attestation checked'), false, f);
  } else {
    assert.ok(item.includes('{secretlessVersion}'));
    for (const f of markdown) assert.equal(joined(read(f)).includes('unreleased local build'), false, f);
  }
});

test('the broker item check refuses words that name another build than the dependency installs', () => {
  const vendored = 'file:vendor/secretless-ai-0.0.0-unreleased.g000000000000.tgz';
  const local = [BROKER_LOCAL, `${BROKER_LOCAL} ${BROKER_TCP}`];
  const release = [BROKER_RELEASE, `${BROKER_RELEASE} ${BROKER_TCP}`];
  for (const item of local) {
    assert.deepEqual(brokerItemFindings({ spec: vendored, items: [item] }), []);
    assert.equal(brokerItemFindings({ spec: '0.23.1', lockVersion: '0.23.1', items: [item] }).length, 1);
  }
  for (const item of release) {
    assert.deepEqual(brokerItemFindings({ spec: '0.23.1', lockVersion: '0.23.1', items: [item] }), []);
    assert.equal(brokerItemFindings({ spec: vendored, items: [item] }).length, 1);
  }
  assert.equal(brokerItemFindings({ spec: '0.23.1', lockVersion: '0.23.2', items: [BROKER_RELEASE] }).length, 1);
  assert.equal(brokerItemFindings({ spec: '^0.23.1', lockVersion: '0.23.1', items: [BROKER_RELEASE] }).length, 1);
  assert.equal(brokerItemFindings({ spec: vendored, items: [BROKER_LOCAL, BROKER_LOCAL] }).length, 1);
  assert.equal(brokerItemFindings({ spec: vendored, items: [`${BROKER_LOCAL}  ${BROKER_TCP}`] }).length, 1);
  assert.equal(brokerItemFindings({ spec: vendored, items: [`${BROKER_LOCAL.replace(' with no provenance attestation', ' built locally')}`] }).length, 1);
});

// The issuer the READMEs name is the trust section's one issuer, a name
// under the reserved .example domain, and each README that names it carries
// the value read from the trust section, never an unfilled placeholder.
const AUTHORITY_DID = /did:opena2a:authority:[A-Za-z0-9.-]*[A-Za-z0-9]/g;

function issuerFindings({ trustedIssuers, docs }) {
  if (!Array.isArray(trustedIssuers) || trustedIssuers.length !== 1) return ['the trust section names one issuer'];
  const [issuer] = trustedIssuers;
  const findings = [];
  if (!/^did:opena2a:authority:([a-z0-9-]+\.)+example$/.test(issuer)) findings.push(`${issuer} is not a name under .example`);
  let named = 0;
  for (const [file, text] of Object.entries(docs)) {
    if (text.includes('{issuerDid}')) findings.push(`${file}: an unfilled {issuerDid}`);
    for (const m of text.matchAll(AUTHORITY_DID)) {
      named += 1;
      if (m[0] !== issuer) findings.push(`${file}: ${m[0]}`);
    }
  }
  if (named === 0) findings.push('no README names the issuer');
  return findings;
}

test('every issuer a README names is the trust section\'s one issuer, a name under the reserved .example domain', () => {
  const trust = json('fixtures/issuer/trust.json');
  const markdown = execFileSync('git', ['-C', ROOT, 'ls-files', '*.md'], { encoding: 'utf8' }).trim().split('\n')
    .filter((f) => !f.startsWith('vendor/aap-conformance/') && fs.existsSync(path.join(ROOT, f)));
  const docs = Object.fromEntries(markdown.map((f) => [f, read(f)]));
  assert.deepEqual(issuerFindings({ trustedIssuers: trust.trustedIssuers, docs }), []);
  assert.ok((docs['fixtures/README.md'] ?? '').match(AUTHORITY_DID)?.length >= 1, 'fixtures/README.md names the issuer');
  for (const key of trust.publicKeys) assert.ok(key.keyId.startsWith(`${trust.trustedIssuers[0]}#`), key.keyId);
});

test('the issuer check refuses another issuer, a name outside .example, an unfilled placeholder and READMEs that name none', () => {
  const issuer = 'did:opena2a:authority:partner.example';
  const elsewhere = 'did:opena2a:authority:partner.example.com';
  const signed = (did) => ({ 'README.md': `Agent credentials are signed by a test issuer, \`${did}\`, named under the reserved \`.example\` domain.` });
  assert.deepEqual(issuerFindings({ trustedIssuers: [issuer], docs: signed(issuer) }), []);
  assert.equal(issuerFindings({ trustedIssuers: [issuer], docs: signed(elsewhere) }).length, 1);
  assert.equal(issuerFindings({ trustedIssuers: [elsewhere], docs: signed(elsewhere) }).length, 1);
  assert.equal(issuerFindings({ trustedIssuers: [issuer, elsewhere], docs: signed(issuer) }).length, 1);
  assert.deepEqual(issuerFindings({ trustedIssuers: [issuer], docs: signed('{issuerDid}') }), ['README.md: an unfilled {issuerDid}', 'no README names the issuer']);
  assert.deepEqual(issuerFindings({ trustedIssuers: [issuer], docs: { 'README.md': 'The demo names no issuer here.' } }), ['no README names the issuer']);
});

test('the view and the server name no DID', () => {
  const files = ['src/view', 'src/server'].flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true }).map((f) => path.join(d, f)))
    .filter((f) => fs.statSync(path.join(ROOT, f)).isFile());
  assert.ok(files.includes(path.join('src/view', 'copy.json')));
  for (const f of files) assert.equal(read(f).includes('did:'), false, f);
});

// The fixtures README: what the credentials prove, then who the issuer is,
// and the keys a run makes, in one paragraph.
const PROVE = 'These credentials prove nothing outside this demo.';
const TEST_ISSUER = 'The issuer is a test issuer, not an authority OpenA2A runs.';
const RUN_TIME_KEYS = "The broker's token signing key, the audit log signing key, the broker token, the token service's access tokens and the password for the password path are made fresh for every run, inside a run directory outside this checkout, and deleted when the run stops. None is ever committed.";

test('fixtures README: the issuer is called a test issuer, not an authority OpenA2A runs, directly after the sentence on what the credentials prove', () => {
  const text = joined(read('fixtures/README.md'));
  assert.equal(occurrences(text, TEST_ISSUER), 1);
  assert.equal(occurrences(text, `${PROVE} ${TEST_ISSUER}`), 1);
});

test('fixtures README: the keys made at run time in their set words, once', () => {
  assert.equal(occurrences(joined(read('fixtures/README.md')), RUN_TIME_KEYS), 1);
});

// The rebuild block in vendor/VENDORED.md lists the commands the rebuild
// script runs. The block's npm ci, npm run and npm pack commands, read from
// the fenced block after the line beginning "It runs these commands" with
// each line split on " && ", are the script's lines beginning "run npm ci ",
// "run npm run " or "run npm pack ", read without "run " and without a
// trailing " >/dev/null": the same commands in the same order, and at least
// one. The lead-in names a scratch npm cache exactly when the script carries
// the cache line. npm version is not compared: the block writes its argument
// inline, where the script uses $VERSION.
const REBUILD_LEAD_IN = 'It runs these commands';
const CACHE_WORDS = 'a scratch npm cache';
const CACHE_LINE = 'CACHE="$B/npm-cache"';

function rebuildBlockFindings({ record, script }) {
  const lines = record.split('\n');
  const lead = lines.findIndex((l) => l.startsWith(REBUILD_LEAD_IN));
  const open = lead === -1 ? -1 : lines.findIndex((l, i) => i > lead && l.startsWith('```'));
  const close = open === -1 ? -1 : lines.findIndex((l, i) => i > open && l === '```');
  if (close === -1) return [`block: no fenced block after a line beginning "${REBUILD_LEAD_IN}"`];
  const blockNpm = lines.slice(open + 1, close).flatMap((l) => l.split(' && ')).filter((c) => /^npm (ci|run|pack)( |$)/.test(c));
  const scriptLines = script.split('\n');
  const scriptNpm = scriptLines.filter((l) => /^run npm (ci|run|pack) /.test(l)).map((l) => l.replace(/^run /, '').replace(/ >\/dev\/null$/, ''));
  const findings = [];
  if (scriptNpm.length === 0 || JSON.stringify(blockNpm) !== JSON.stringify(scriptNpm)) {
    findings.push(`npm commands: the block runs ${JSON.stringify(blockNpm)}, the script runs ${JSON.stringify(scriptNpm)}`);
  }
  const named = lines.slice(lead, open).join(' ').includes(CACHE_WORDS);
  const carried = scriptLines.includes(CACHE_LINE);
  if (named !== carried) {
    findings.push(carried
      ? `cache: the script carries ${CACHE_LINE}, the lead-in does not name ${CACHE_WORDS}`
      : `cache: the lead-in names ${CACHE_WORDS}, the script does not carry ${CACHE_LINE}`);
  }
  return findings;
}

// A record and a script that agree, for the planted inputs.
const PLANTED_RECORD = [
  `${REBUILD_LEAD_IN} in a scratch clone with a scratch HOME and ${CACHE_WORDS}:`,
  '',
  '```',
  'cd "$B/sls" && npm version "$VERSION" --no-git-tag-version',
  'npm ci --ignore-scripts --omit=optional && npm run build && npm pack --ignore-scripts && shasum -a 256 secretless-ai-*.tgz',
  '```',
].join('\n');
const PLANTED_SCRIPT = [
  CACHE_LINE,
  'run npm version "$VERSION" --no-git-tag-version >/dev/null',
  'run npm ci --ignore-scripts --omit=optional >/dev/null',
  'run npm run build >/dev/null',
  'run npm pack --ignore-scripts >/dev/null',
].join('\n');

test("vendor/VENDORED.md: the rebuild block's npm commands are the ones the rebuild script runs", () => {
  const kinds = (record, script) => rebuildBlockFindings({ record, script }).map((f) => f.split(':')[0]);
  assert.deepEqual(kinds(PLANTED_RECORD, PLANTED_SCRIPT), []);
  // npm version is not compared: a block that writes its argument inline
  // agrees with a script that uses $VERSION.
  const inline = PLANTED_RECORD.replace('npm version "$VERSION"', 'npm version "0.0.0-unreleased.g000000000000"');
  assert.notEqual(inline, PLANTED_RECORD);
  assert.deepEqual(kinds(inline, PLANTED_SCRIPT), []);
  // Planted inputs fail: a block whose npm ci lacks --omit=optional, and a
  // script without the cache line.
  const noOmit = PLANTED_RECORD.replace('npm ci --ignore-scripts --omit=optional &&', 'npm ci --ignore-scripts &&');
  const noCache = PLANTED_SCRIPT.replace(`${CACHE_LINE}\n`, '');
  assert.notEqual(noOmit, PLANTED_RECORD);
  assert.notEqual(noCache, PLANTED_SCRIPT);
  assert.deepEqual(kinds(noOmit, PLANTED_SCRIPT), ['npm commands']);
  assert.deepEqual(kinds(PLANTED_RECORD, noCache), ['cache']);
  // The record and the script of this checkout.
  assert.deepEqual(rebuildBlockFindings({ record: read('vendor/VENDORED.md'), script: read('scripts/vendor/build-secretless-tarball.sh') }), []);
});
