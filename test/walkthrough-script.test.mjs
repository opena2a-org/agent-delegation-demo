// The walkthrough capture script, without a browser: where it may write, and
// that a run whose proof did not hold, whose page asked for an address other
// than 127.0.0.1, or whose file is over its limit exits non-zero, keeps no
// output file and leaves the files already in place as they were. The
// capture itself runs in test/capture/walkthrough-capture.test.mjs, under npm
// run test:capture.

import './support/outer-profile.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CAPS, ROOT, SHOTS, outputMap, parseArgs, problems, settle } from '../docs/demo/walkthrough.demo.mjs';

const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const refusal = (fn) => {
  try { fn(); } catch (err) { return err; }
  return null;
};

test('records: a records directory inside the clone is refused, whatever the spelling; one outside it is accepted', () => {
  const clone = tmp('walk-clone-');
  fs.mkdirSync(path.join(clone, 'docs/captures'), { recursive: true });
  const outside = tmp('walk-records-');
  fs.symlinkSync(path.join(clone, 'docs'), path.join(outside, 'into-clone'));
  for (const inside of [clone, path.join(clone, 'docs/captures'), path.join(clone, 'evidence/new'), `${clone}/docs/../records`, path.join(outside, 'into-clone/records')]) {
    const err = refusal(() => parseArgs(['--stills', '--records', inside], clone));
    assert.ok(err, `refused: ${inside}`);
    assert.equal(err.exitCode, 2);
    assert.match(err.lines.join('\n'), /inside the clone/);
  }
  const ok = parseArgs(['--record', '--records', path.join(outside, 'evidence')], clone);
  assert.deepEqual(ok, { mode: 'record', records: path.join(outside, 'evidence') });
  assert.deepEqual(parseArgs(['--records', outside, '--stills'], clone), { mode: 'stills', records: outside });
  fs.rmSync(clone, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('records: no default; a missing directory, a missing mode, both modes and an unknown argument are each refused', () => {
  const clone = tmp('walk-clone-');
  for (const argv of [['--stills'], ['--stills', '--records'], ['--records', os.tmpdir()], ['--stills', '--record', '--records', os.tmpdir()], ['--stills', '--records', os.tmpdir(), '--port', '1']]) {
    const err = refusal(() => parseArgs(argv, clone));
    assert.ok(err, argv.join(' '));
    assert.equal(err.exitCode, 2, argv.join(' '));
  }
  fs.rmSync(clone, { recursive: true, force: true });
});

test('each shot has its still under docs/captures, and that directory holds no other still', () => {
  const stills = fs.readdirSync(path.join(ROOT, 'docs/captures')).filter((f) => f.endsWith('.png')).sort();
  assert.deepEqual(stills, SHOTS.map((s) => `${s.slug}.png`).sort());
});

test('output map: the two modes write thirteen files into the clone, all under docs/captures and ending .png, .gif, .vtt or .txt', () => {
  const stills = outputMap('stills');
  const record = outputMap('record');
  const clone = [...stills.clone, ...record.clone];
  assert.equal(clone.length, 13);
  assert.equal(new Set(clone).size, 13);
  for (const f of clone) {
    assert.equal(path.posix.dirname(f), 'docs/captures', f);
    assert.match(f, /\.(png|gif|vtt|txt)$/, f);
  }
  assert.deepEqual(stills.clone, [...SHOTS.map((s) => `docs/captures/${s.slug}.png`), 'docs/captures/npm-start.txt']);
  assert.deepEqual(SHOTS.map((s) => s.slug), ['00-overview', '01-setup', '02-scenario-1-normal-bill', '03-scenario-2-fake-invoice', '04-scenario-3-stop-one-agent', '05-scenario-4-dispute', '06-offline-check', '07-summary', '08-summary-limits']);
  assert.equal(record.clone.filter((f) => f.endsWith('.gif')).length, 1);
  assert.deepEqual(record.clone.filter((f) => f.endsWith('.vtt')), ['docs/captures/walkthrough.captions.vtt', 'docs/captures/walkthrough.chapters.vtt']);
  assert.deepEqual(stills.records, [...SHOTS.flatMap((s) => [`captures/${s.slug}.json`, `captures/${s.slug}.proof.json`]), 'captures/npm-start.json']);
  assert.deepEqual(record.records, ['captures/walkthrough.json', 'captures/walkthrough.mp4']);
});

// A staged run: every file of the mode's map under stage/clone and
// stage/records, as the capture leaves them before it settles. Each file
// holds its own name and the run's tag, so two runs' files differ.
function staged(mode, extra = [], tag = 'run') {
  const stage = tmp('walk-stage-');
  const map = outputMap(mode);
  for (const f of [...map.clone.map((r) => `clone/${r}`), ...map.records.map((r) => `records/${r}`), ...extra]) {
    fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
    fs.writeFileSync(path.join(stage, f), `${f} ${tag}\n`);
  }
  return stage;
}

const listed = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).sort() : []);

test('output map: a run settles every mapped file into place, and a staged file outside the map keeps every file out', () => {
  for (const mode of ['stills', 'record']) {
    const clone = tmp('walk-clone-');
    const records = tmp('walk-records-');
    const ok = settle({ mode, root: clone, records, stage: staged(mode), problems: [], log: () => {} });
    assert.equal(ok, 0);
    assert.deepEqual(listed(path.join(clone, 'docs/captures')), outputMap(mode).clone.map((f) => path.basename(f)).sort());
    assert.deepEqual(listed(path.join(records, 'captures')), outputMap(mode).records.map((f) => path.basename(f)).sort());
    for (const extra of ['clone/docs/captures/03-scenario-2-fake-invoice.json', 'clone/docs/captures/README.md', 'clone/docs/walkthrough.md', 'records/captures/walkthrough-steps.yaml']) {
      const c2 = tmp('walk-clone-');
      const r2 = tmp('walk-records-');
      const code = settle({ mode, root: c2, records: r2, stage: staged(mode, [extra]), problems: [], log: () => {} });
      assert.equal(code, 1, extra);
      assert.deepEqual(listed(path.join(c2, 'docs')), [], extra);
      assert.deepEqual(listed(r2), [], extra);
    }
  }
});

// The three ways a run fails closed. Each case runs against outputs a
// previous run left in place, as a clone holds its committed captures: those
// are left as they were, byte for byte, so a failed run neither removes a
// file a reader already has nor puts one of its own in its place.
function failsClosed(mode, found) {
  const clone = tmp('walk-clone-');
  const records = tmp('walk-records-');
  assert.equal(settle({ mode, root: clone, records, stage: staged(mode, [], 'previous run'), problems: [], log: () => {} }), 0);
  const inPlace = () => [path.join(clone, 'docs/captures'), path.join(records, 'captures')]
    .map((d) => Object.fromEntries(listed(d).map((f) => [f, fs.readFileSync(path.join(d, f), 'utf8')])));
  const before = inPlace();
  assert.deepEqual(before.map((files) => Object.keys(files).length), [outputMap(mode).clone.length, outputMap(mode).records.length]);
  const stage = staged(mode, [], 'second run');
  const lines = [];
  const code = settle({ mode, root: clone, records, stage, problems: found, log: (l) => lines.push(l) });
  assert.notEqual(code, 0);
  assert.deepEqual(inPlace(), before, 'the files in place after the failed run');
  assert.equal(fs.existsSync(stage), false);
  return lines.join('\n');
}

const proof = (slug, ok) => ({ slug, ok, assertions: [{ name: 'balance', expected: '4800.00', actual: ok ? '4800.00' : '4713.60', pass: ok }], domEqualsState: [{ field: 'balance', dom: '$4,800.00', state: '$4,800.00', pass: true }] });

test('fail closed: a proof that is not ok exits non-zero, keeps no output file and leaves the files in place as they were', () => {
  const found = problems({ proofs: [proof('00-overview', true), proof('02-scenario-1-normal-bill', false)], outside: [], files: [] });
  assert.equal(found.length, 1);
  assert.match(found[0], /02-scenario-1-normal-bill/);
  assert.match(failsClosed('stills', found), /02-scenario-1-normal-bill/);
  const rowFailed = proof('01-setup', true);
  rowFailed.domEqualsState[0].pass = false;
  assert.equal(problems({ proofs: [rowFailed], outside: [], files: [] }).length, 1, 'ok true with a failed row is still refused');
});

test('fail closed: a request that leaves 127.0.0.1 exits non-zero, keeps no output file and leaves the files in place as they were', () => {
  const found = problems({ proofs: [proof('00-overview', true)], outside: ['http://192.0.2.1'], files: [] });
  assert.equal(found.length, 1);
  assert.match(found[0], /192\.0\.2\.1/);
  assert.match(failsClosed('record', found), /192\.0\.2\.1/);
  assert.match(failsClosed('stills', found), /192\.0\.2\.1/);
});

test('fail closed: a file over its limit exits non-zero, keeps no output file and leaves the files in place as they were', () => {
  const still = { name: '03-scenario-2-fake-invoice.png', kind: 'still', bytes: CAPS.stillBytes, widthPx: 2880, heightPx: 1800 };
  assert.deepEqual(problems({ proofs: [], outside: [], files: [still] }), []);
  const over = [
    { ...still, bytes: CAPS.stillBytes + 1 },
    { ...still, widthPx: 1440, heightPx: 900 },
    { name: 'walkthrough-fake-invoice.gif', kind: 'gif', bytes: CAPS.gifBytes + 1, widthPx: 1100, seconds: 20 },
    { name: 'walkthrough-fake-invoice.gif', kind: 'gif', bytes: 1000, widthPx: 1101, seconds: 20 },
    { name: 'walkthrough-fake-invoice.gif', kind: 'gif', bytes: 1000, widthPx: 1100, seconds: CAPS.gifSeconds + 0.1 },
    { name: 'walkthrough.mp4', kind: 'recording', bytes: 1000, widthPx: 1440, heightPx: 900, seconds: CAPS.recordingSeconds },
    { name: 'walkthrough.mp4', kind: 'recording', bytes: Math.ceil(CAPS.recordingBytesPerMinute * 2) + 1, widthPx: 1440, heightPx: 900, seconds: 120 },
  ];
  for (const f of over) {
    const found = problems({ proofs: [], outside: [], files: [f] });
    assert.equal(found.length, 1, JSON.stringify(f));
    assert.match(found[0], new RegExp(f.name.replace(/\./g, '\\.')));
  }
  assert.match(failsClosed('stills', problems({ proofs: [], outside: [], files: [over[0]] })), /over/);
  assert.match(failsClosed('record', problems({ proofs: [], outside: [], files: [over[5]] })), /walkthrough\.mp4/);
});

test('the script is the committed file the sidecars name, under docs/demo beside the narration', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'docs/demo/walkthrough.demo.mjs')), true);
  assert.equal(fs.existsSync(path.join(ROOT, 'docs/demo/walkthrough.narration.json')), true);
});
