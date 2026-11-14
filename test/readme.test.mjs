// README.md against what it repeats. The start block is the summary screen's
// Run it yourself block; the limits section mirrors the summary's limits
// list item for item; every commit, version and name in a ruled sentence is
// read from the pin file, the lockfile or the fixtures, never typed; and a
// sentence that rests on a test or a pin is printed exactly while it holds.
//
// When a pin moves (a secretless-ai re-pin or release, or any atx-verify
// version change) and a check flips, the matching line is rewritten or
// removed in the same change; a limit line whose check fails is a failed
// build.

import './support/outer-profile.mjs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  CAPTURE_SIDECARS, PACKAGE, PINS, README, SUMMARY, blockEquality, brokerWords, browserCaptures, captureBlock, captureChrome, count, fencedBlocks, limitsMirror, limitsSection, missingPaths, screenLimits, startBlockPin,
} from './support/readme.mjs';

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const text = README();
const lines = text.split('\n');

// The README with one line replaced, inserted or removed (0-based index).
const edit = (fn) => { const l = text.split('\n'); fn(l); return l.join('\n'); };
const at = (re) => lines.findIndex((l) => re.test(l));

test('README start block: the earliest fenced block is the sh block, equal to the summary selfCode after fills, closing at line 30 or above', () => {
  assert.deepEqual(blockEquality(text), []);
  assert.equal(count(text, 'npm install'), 0);
});

test('README start block: the block check fails npm install, a prompt, CRLF, an earlier fenced block and a block closing at line 40', () => {
  const ci = at(/^npm ci$/);
  const sh = at(/^```sh$/);
  const cases = {
    'npm install': edit((l) => { l[ci] = 'npm install'; }),
    prompt: edit((l) => { l[ci] = '$ npm ci'; }),
    crlf: text.replace(/\n/g, '\r\n'),
    'earlier block': edit((l) => { l.splice(sh - 1, 0, '```text', 'output', '```', ''); }),
    'closing at line 40': edit((l) => { l.splice(sh - 1, 0, ...Array(17).fill('')); }),
  };
  for (const [name, fixture] of Object.entries(cases)) assert.notDeepEqual(blockEquality(fixture), [], name);
});

test('README start block: no lead sentence; the requirements line opens its own paragraph above the block, and the capture shows the Ready line once', () => {
  assert.deepEqual(startBlockPin(text), []);
});

test('README start block: the pin fails each misplaced lead, other words and a capture without the Ready line, on the assertion named', () => {
  const [lead1, lead2] = SUMMARY.cta.selfLead.split(/(?<=\.)\s+(?=[A-Z])/);
  const req = at(/^Requirements: /);
  const sh = at(/^```sh$/);
  const ready = at(/^Ready\. Open /);
  const label = at(/^What `npm start` prints /);
  const fixtures = {
    F1: [edit((l) => { l.splice(sh, 0, `${lead1} ${lead2}`, ''); }), ['A1', 'A3']],
    F2: [edit((l) => { l.splice(req + 1, 0, `${lead1} ${lead2}`); }), ['A1', 'A3']],
    F3: [edit((l) => { l.splice(req, 0, `${lead1} ${lead2}`, ''); }), ['A3']],
    F4: [edit((l) => { l.splice(req, 0, `${lead1} ${lead2}`); }), ['A2', 'A3']],
    F5: [edit((l) => { l.splice(sh, 0, lead1, ''); }), ['A1', 'A3']],
    F6: [edit((l) => { l.splice(sh, 0, 'Run these four commands:', ''); }), ['A1']],
    F7: [edit((l) => { l.splice(req, 0, 'Before you start:'); }), ['A2']],
    F8: [edit((l) => { l.splice(req, 2); }), ['A1']],
    F9: [edit((l) => { l.splice(ready, 1); }), ['A4']],
    F10: [edit((l) => { l.splice(label, 0, `${lead1} ${lead2}`, ''); }), ['A3']],
  };
  for (const [name, [fixture, expected]] of Object.entries(fixtures)) assert.deepEqual(startBlockPin(fixture), expected, name);
});

test('README start block: the capture label names a commit, and the capture is what npm start printed: npm\'s lines, then the build line, the Ready line and how to stop', () => {
  const m = /^What `npm start` prints \(captured from agent-banking-delegation-demo at commit ([0-9a-f]{7}), ([0-9]{4}-[0-9]{2}-[0-9]{2}), on the scripted Example Bank fixture\):$/.exec(lines[at(/^What `npm start` prints /)]);
  assert.ok(m, 'the capture label');
  const cap = captureBlock(text);
  assert.deepEqual(cap.lines.slice(0, 4), ['', `> ${PACKAGE.name}@${PACKAGE.version} start`, `> ${PACKAGE.scripts.start}`, '']);
  assert.equal(cap.lines[4], `Agent banking delegation demo, build ${m[1]}`);
  assert.match(cap.lines[5], /^Ready\. Open http:\/\/127\.0\.0\.1:7380\/ in a browser\.$/);
  assert.equal(cap.lines[6], 'Press Ctrl+C to stop.');
  assert.equal(cap.lines.length, 7);
});

test('README start block: the .npmrc line says what the three settings tell npm, and the file holds those three settings', () => {
  assert.equal(count(text, "The repository's `.npmrc` tells npm commands run in this directory to refuse a Node.js older than 22.12.0, to skip every package's install scripts and to leave out optional dependencies."), 1);
  assert.equal(count(text, 'The pinned dependencies carry no install script.'), 0);
  assert.equal(read('.npmrc'), 'engine-strict=true\nignore-scripts=true\nomit=optional\n');
});

test('no file a reader meets tells them to run npm install', () => {
  const docs = fs.readdirSync(new URL('../docs', import.meta.url), { recursive: true }).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`);
  for (const f of ['README.md', 'fixtures/README.md', 'vendor/VENDORED.md', ...docs]) assert.equal(count(read(f), 'npm install'), 0, f);
});

test('README limits: the last section mirrors the summary screen, item for item after fills, with every other line blank or indented', () => {
  assert.equal(SUMMARY.limits.items.length, 18);
  assert.deepEqual(limitsMirror(text), []);
});

test('README limits: the mirror fails an edited label, a code span in an item, an extra item and a section that is not last', () => {
  const l1 = at(/^- Your payees and limits live/);
  const broker = at(/^- The bank's broker is an unreleased/);
  const last = at(/^- This demo is not a security assessment/);
  assert.deepEqual(limitsMirror(edit((l) => { l[l1] = l[l1].replace('consent record', 'consent'); })), ['item 5 differs']);
  assert.deepEqual(limitsMirror(edit((l) => { l[broker] = l[broker].replace('secretless-ai', '`secretless-ai`'); })), ['item 17 differs']);
  assert.deepEqual(limitsMirror(edit((l) => { l.push('', '- One more item.'); })), ['19 items, screen has 18']);
  assert.notDeepEqual(limitsMirror(edit((l) => { l.splice(last + 1, 0, '', '## After the limits', ''); })), []);
});

test('README limits: the bearer credential item, its README form, its references in one group and the lifetime line, in that order', () => {
  const s = limitsSection(text).split('\n');
  const marks = ['- Bearer credential: ', '  In a deployment that follows ATX, ', '  - [AAP, Section 4.3, ', '  - [AAP, Section 8.6, ', '  - [ATX, the Presentation row]', '  The reference verifier rejects ', '  - [ATX, Section 1.3, ', '- Revoking withdrew your consent'];
  const n = marks.map((m) => s.findIndex((l) => l.startsWith(m)));
  const base = n[0];
  assert.deepEqual(n.map((x) => x - base), [0, 2, 4, 5, 6, 8, 10, 12]);
  assert.equal(count(limitsSection(text), 'Bearer credential: a copy with the grant name is accepted as this agent.'), 1);
  const atx = [...limitsSection(text).matchAll(/atx-spec\/blob\/([0-9a-f]{40})\//g)].map((m) => m[1]);
  assert.deepEqual([...new Set(atx)], [PINS.atxSpec.commit]);
  assert.equal(count(text, "/blob/" + PINS.aapSpec.commit + '/AAP-BROKER-PROFILE.md#14-reference-implementation-informative'), 2);
  assert.equal(count(text, `secretless-ai/blob/${PINS.secretlessAi.commit}/src/broker/grant-config.ts#L23-L24`), 1);
});

test('README limits: the broker item, then the TCP port paragraph, then the socket line', () => {
  const s = limitsSection(text).split('\n');
  const marks = ["- The bank's broker is ", "  The bank's broker opens that port on 127.0.0.1 ", '  To admit a caller, ', '  - [`AAP-BROKER-PROFILE.md`, Section 6.8, ', '  - [`AAP-BROKER-PROFILE.md`, Section 14, Implementation status, the presentation binding step]', '- This demo is not a security assessment'];
  const n = marks.map((m) => s.findIndex((l) => l.startsWith(m)));
  assert.deepEqual(n.map((x) => x - n[0]), [0, 2, 4, 6, 7, 9]);
  assert.equal(count(limitsSection(text), 'To admit a caller, the broker checks one thing'), 1);
  assert.equal(count(limitsSection(text), 'The reference verifier rejects an agent credential after its'), 1);
});

test('README limits: every link in the section sits in a reference group, one link per line', () => {
  for (const l of limitsSection(text).split('\n')) if (l.includes('](')) assert.match(l, /^ {2}- \[/, l);
});

test('README limits: the test issuer named in the paragraph after L8 is the fixture trust list\'s one issuer, under .example', () => {
  const trust = JSON.parse(read('fixtures/issuer/trust.json'));
  const issuer = trust.trustedIssuers[0];
  assert.match(issuer, /\.example$/);
  const m = /^ {2}Agent credentials are signed by a test issuer, `([^`]+)`, named under the reserved `\.example` domain \(RFC 2606\)\./m.exec(text);
  assert.ok(m, 'the issuer paragraph');
  assert.equal(m[1], issuer);
  const s = limitsSection(text).split('\n');
  const l8 = s.findIndex((l) => l === `- ${screenLimits()[9]}`);
  assert.ok(s[l8 + 2].startsWith('  Agent credentials are signed by a test issuer,'), 'directly after L8');
});

test('README limits: the broker record paragraph is present once, directly after L13', () => {
  const s = limitsSection(text).split('\n');
  const l13 = s.findIndex((l) => l === `- ${screenLimits()[14]}`);
  assert.ok(s[l13 + 2].startsWith("  The broker record is signed with a key the bank's broker creates for this run."));
  assert.equal(count(text, "The broker record is signed with a key the bank's broker creates for this run."), 1);
});

test('README limits: item 5\'s sentence and its two links sit under L1, after L1\'s reference', () => {
  const s = limitsSection(text).split('\n');
  const l1 = s.findIndex((l) => l === `- ${screenLimits()[4]}`);
  assert.match(s[l1 + 2], /^ {2}- \[AAP, Section 4\.1, Authorization Details\]\(https:\/\/datatracker\.ietf\.org\/doc\/html\/draft-fane-opena2a-aap-02#section-4\.1\)$/);
  assert.equal(s[l1 + 4], '  As in UK Open Banking variable recurring payment consents, the bank holds the per payment and per period limits and checks every payment against them.');
  assert.match(s[l1 + 6], /^ {2}- \[Domestic VRP consents - v4\.0\]\(https:\/\/openbankinguk\.github\.io\/[^)]+domestic-vrp-consents\.html\)$/);
  assert.match(s[l1 + 7], /^ {2}- \[Domestic VRPS - v4\.0\]\(https:\/\/openbankinguk\.github\.io\/[^)]+domestic-vrps\.html\)$/);
});

test('README: the broker build words pair with the dependency, in the architecture section and in the limits item', () => {
  const w = brokerWords();
  assert.equal(count(text, w.sentence), 1);
  const item17 = screenLimits()[16];
  if (w.form === 'unreleased') {
    assert.ok(PACKAGE.dependencies['secretless-ai'].startsWith('file:vendor/'));
    assert.equal(count(text, '](vendor/VENDORED.md)'), 1);
    assert.equal(count(text.replace('[`vendor/VENDORED.md`](vendor/VENDORED.md)', '`vendor/VENDORED.md`'), '`vendor/VENDORED.md` gives the commands that rebuild them.'), 1);
    for (const s of [text, item17]) {
      assert.ok(s.includes('unreleased local build'));
      assert.ok(s.includes('no provenance attestation'));
    }
  } else {
    assert.equal(count(text, 'unreleased local build'), 0);
  }
  assert.equal(count(text, 'npm does not serve these bytes, and they carry no provenance attestation.'), w.form === 'unreleased' ? 1 : 0);
});

test('README: the verifier passage names the vendored commit, and the vendored file is the one VENDORED.md hashes', () => {
  const vendored = read('vendor/VENDORED.md');
  const m = /The bank's token service checks the broker's token with the reference Node\.js verifier from aap-conformance at commit `([0-9a-f]{40})`\./.exec(text);
  assert.ok(m);
  assert.ok(vendored.includes(`| Commit | \`${m[1]}\` |`));
  assert.equal(m[1], PINS.aapConformance.commit);
  assert.equal(count(text, 'reports one fixture passed.'), 1);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(new URL(`../${PINS.aapConformance.vendoredPath}`, import.meta.url))).digest('hex');
  assert.ok(vendored.includes(`| sha256 | \`${sha}\` |`));
});

test('README: the lifetime line is in the state the fixture credentials select', () => {
  const lifetimes = ['billpay', 'budget'].map((n) => {
    const a = JSON.parse(read(`fixtures/agents/${n}-agent.atx.json`));
    return (Date.parse(a.expiresAt) - Date.parse(a.issuedAt)) / 1000;
  });
  const stateA = lifetimes.some((s) => s > 604800);
  assert.equal(count(text, 'checks nothing else about its age'), 1);
  assert.equal(count(text, "This demo's agent credentials are long lived test fixtures, issued on 2026-05-23 with an `expiresAt` of 2099-12-31"), stateA ? 1 : 0);
  for (const n of ['billpay', 'budget']) {
    const a = JSON.parse(read(`fixtures/agents/${n}-agent.atx.json`));
    if (stateA) { assert.equal(a.issuedAt.slice(0, 10), '2026-05-23'); assert.equal(a.expiresAt.slice(0, 10), '2099-12-31'); }
  }
  assert.equal(count(text, 'stops working at its expiry time'), 0);
});

test('README: the socket line and the one-user paragraph in their ruled words, and the replaced words absent', () => {
  for (const s of [
    'To admit a caller, the broker checks one thing, on its Unix socket as on its local TCP port: the broker token.',
    'File permissions let every process running as the operating system user that runs the demo read the broker token, and keep other users of the machine from reading it.',
    "so the broker can't tell the agent from another process of that user.",
    'The bank, its broker and the agents run as one user on one machine.',
    "on their own, they would let an agent read the bank's files.",
  ]) assert.equal(count(text, s), 1, s);
  for (const s of ['can read the token file', 'File permissions on the run', 'caller token', 'The test suite adds an operating system boundary', 'the sandbox, not the socket', 'keeps the grant path agent out of']) assert.equal(count(text, s), 0, s);
  // Sentences 3 to 7 print together or not at all.
  const macos = ["except the offline check's rerun, which runs every process under one shared profile.", "These refusals come from that profile, not from the socket, so they don't apply in the rerun.", "The password path agent's profile doesn't refuse reads of the bank's directory."].map((s) => count(text, s));
  assert.equal(new Set(macos).size, 1, String(macos));
  assert.ok(macos[0] <= 1);
  assert.doesNotMatch(text, /socket (keeps|stops|separates|isolates|protects)|security boundary/i);
});

test('README: the offline passage says what the count covers once, and the offline screen\'s words name neither the browser nor the page', () => {
  assert.equal(count(text, "The count covers the demo's own processes, not the browser or the page."), 1);
  assert.equal(count(text, 'or when the demo already runs inside another sandbox'), 1);
  const offline = JSON.stringify(COPY_OFFLINE());
  assert.doesNotMatch(offline, /\bbrowser\b|\bpage\b/i);
});

test('README: every platform it names carries its product version and architecture, never a bare major version or a range', () => {
  const docs = fs.readdirSync(new URL('../docs', import.meta.url), { recursive: true }).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`);
  for (const f of ['README.md', ...docs]) {
    for (const l of read(f).split('\n')) {
      if (/macos/i.test(l) && /[0-9]+\.[0-9]+/.test(l)) assert.match(l, /arm64|x86_64/, `${f}: a macOS version without the architecture: ${l.slice(0, 80)}`);
      assert.doesNotMatch(l, /macOS [0-9]+(\.[0-9]+)* or later|macOS [0-9]+([^0-9.]|$)|\| macOS \| [0-9]+ \|/, `${f}: ${l.slice(0, 80)}`);
    }
  }
});

test('README: the requirements line names the Chrome version the committed captures\' sidecars name, and each sidecar row holds the committed file\'s sha256', () => {
  assert.equal(CAPTURE_SIDECARS.rows.length, browserCaptures().length);
  assert.equal(browserCaptures().length, 12);
  assert.deepEqual(captureChrome(text), []);
});

test('README: the Chrome check fails another version on the requirements line, a row whose sha256 is not the committed file\'s, a capture with no row and rows that name two versions', () => {
  const req = at(/^Requirements: /);
  const { rows } = CAPTURE_SIDECARS;
  const version = rows[0].chromeVersion;
  const other = edit((l) => { l[req] = l[req].replace(` in Chrome ${version}, `, ' in Chrome 156.0.8078.47, '); });
  assert.ok(other !== text, `the requirements line names Chrome ${version}, the version the sidecar rows name`);
  assert.deepEqual(captureChrome(other), [`the requirements line names Chrome 156.0.8078.47, and the captures' sidecars name ${version}`]);
  const retaken = rows.map((r, i) => (i === 0 ? { ...r, sha256: '0'.repeat(64) } : r));
  const found = captureChrome(text, { rows: retaken });
  assert.equal(found.length, 1, found.join('\n'));
  assert.match(found[0], new RegExp(`^${rows[0].file.replace(/\./g, '\\.')}: sha256 [0-9a-f]{64}, and its sidecar row records 0{64}; rewrite the row from the new ${rows[0].sidecar.replace(/\./g, '\\.')}$`));
  assert.deepEqual(captureChrome(text, { rows: rows.slice(1) }), [`${rows[0].file} has no sidecar row`]);
  const two = rows.map((r, i) => (i === rows.length - 1 ? { ...r, chromeVersion: '157.0.8103.38' } : r));
  assert.deepEqual(captureChrome(text, { rows: two }), [`the sidecar rows name 2 Chrome versions: ${version}, 157.0.8103.38`]);
});

test('README: the record block prints the install line the --record check prints, then the --record line, and no block runs npx playwright-core install', async () => {
  const { FFMPEG_INSTALL } = await import('../docs/demo/walkthrough.demo.mjs');
  const record = fencedBlocks(text).filter((b) => b.lines.some((l) => / --record /.test(l)));
  assert.equal(record.length, 1);
  assert.deepEqual(record[0].lines, [FFMPEG_INSTALL, 'node docs/demo/walkthrough.demo.mjs --record --records <a directory outside the clone>']);
  assert.equal(FFMPEG_INSTALL, 'node scripts/install-playwright-ffmpeg.mjs');
  for (const b of fencedBlocks(text)) for (const l of b.lines) assert.doesNotMatch(l, /npx playwright(-core)? install/, l);
});

test('README: the earliest fenced block is the start block, and every fence closes', () => {
  const blocks = fencedBlocks(text);
  assert.equal(blocks[0].info, 'sh');
  assert.ok(blocks.every((b) => b.close > b.open));
});

test('README: every path under a repository directory that it names, outside its links, exists on the tree', () => {
  assert.deepEqual(missingPaths(text), []);
});

test('README: the path check reports a script and a directory the tree lacks, named in a code span or a fenced command, and passes a path inside a link to another repository', () => {
  const arch = at(/^## Architecture$/);
  const fixture = edit((l) => {
    l.splice(arch, 0,
      'The stills are taken by `docs/demo/retake.demo.mjs` and rewritten under `docs/stills/`.', '',
      '```sh', 'node docs/demo/retake.demo.mjs --stills', '```', '');
  });
  assert.deepEqual(missingPaths(fixture), ['docs/demo/retake.demo.mjs', 'docs/stills']);
  assert.deepEqual(missingPaths('[a file elsewhere](https://example.com/x/src/not/here.ts) and `src/orchestrator/sandbox.mjs`'), []);
});

function COPY_OFFLINE() {
  return JSON.parse(read('src/view/copy.json')).SCREENS.find((s) => s.id === 'offline');
}
