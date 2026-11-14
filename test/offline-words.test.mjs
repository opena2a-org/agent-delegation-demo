// The words of the summary's self run lead and of the offline screen: the
// card, the subhead beside the measured one, the reasons a count reads not
// measured and the not run words. Each string is compared byte for byte, the
// lists the code prints from are the lists the view reads, and the sidecar
// records each changed string as ruled.

import './support/outer-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as classify from '../src/egress/classify.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copy = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
const side = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.sidecar.json'), 'utf8'));
const offline = copy.SCREENS.find((s) => s.id === 'offline');
const summary = copy.SCREENS.find((s) => s.id === 'summary');
const X = copy.RULED_EXTRA;

// In the order that picks the reason shown: the earliest that holds.
const NOT_MEASURED_REASONS = [
  'the count record was missing or unreadable',
  'no IPv4 address was found besides loopback',
  'the control to 192.0.2.1 failed',
  "the control to this machine's address failed",
  'the control reading a test file failed',
  'the control running a test program failed',
  'a process tried to load a native module',
  'a process ran uncounted',
  'a process started with the QUIC flag',
  'the rerun ended without four decisions',
];
const NOT_RUN_REASONS = [
  'no macOS sandbox on this system',
  'the demo is already inside another sandbox',
  'the sandbox could not be applied',
];
const NOT_RUN_NEEDS = {
  'no macOS sandbox on this system': 'Why: the check needs the macOS sandbox; see Requirements in the README.',
  'the demo is already inside another sandbox': 'Why: the check needs a terminal outside any other sandbox.',
  'the sandbox could not be applied': 'Why: the check needs its own sandbox, and macOS refused it.',
};

test('offline card: the check names the connections the block allows', () => {
  assert.equal(offline.card.text, "Run the four grant path scenarios again with every connection blocked except those between the demo's own processes. The bank, its broker and the agents run on this machine.");
});

test('summary: the self run lead names the install step', () => {
  assert.equal(summary.cta.selfLead, 'Clone the repository, install its dependencies and start the demo. It prints the local web address to open.');
});

test('offline subhead: the measured subhead stays as it was, and its variant without "either" sits beside it', () => {
  assert.equal(offline.sub, "The password path calls no OpenA2A service either. This check shows the grant path doesn't depend on one.");
  assert.equal(offline.subB, "This check shows the grant path doesn't depend on an OpenA2A service.");
  const keys = Object.keys(offline);
  assert.equal(keys.indexOf('subB'), keys.indexOf('sub') + 1);
});

test('not measured: the result line keeps its sentence, the reasons are the closed list in order, and the code prints from the same list', () => {
  assert.equal(X.offlineNotMeasured, 'Outbound connection attempts: not measured ({reason}).');
  assert.deepEqual(X.offlineNotMeasuredReasons, NOT_MEASURED_REASONS);
  assert.deepEqual(Object.values(classify.NOT_MEASURED), NOT_MEASURED_REASONS);
});

test('not run: the outcome, the result line, the closed list of reasons and what the check needs for each, and the code prints from the same list', () => {
  assert.equal(X.offlineNotRun, 'Not run');
  assert.equal(X.offlineNotRunResult, 'The four scenarios were not rerun ({reason}).');
  assert.deepEqual(X.offlineNotRunReasons, NOT_RUN_REASONS);
  assert.deepEqual(X.offlineNotRunNeeds, NOT_RUN_NEEDS);
  assert.deepEqual(Object.keys(X.offlineNotRunNeeds), X.offlineNotRunReasons);
  assert.deepEqual(Object.values(classify.NOT_RUN ?? {}), NOT_RUN_REASONS);
});

test('the changed words, one cell each: the reason under the key the code prints from and in the copy file, byte for byte with its length, and the reason for a rerun that ended without four decisions, last in the not measured list', () => {
  const rows = [
    ['noAddress', 'no IPv4 address was found besides loopback', 42],
    ['nativeModule', 'a process tried to load a native module', 39],
    ['quic', 'a process started with the QUIC flag', 36],
    ['storeControl', 'the control reading a test file failed', 38],
    ['execControl', 'the control running a test program failed', 41],
  ];
  for (const [key, words, length] of rows) {
    assert.equal(classify.NOT_MEASURED[key], words, key);
    assert.equal(Buffer.byteLength(words), length, key);
    assert.ok(X.offlineNotMeasuredReasons.includes(words), key);
  }
  const ended = 'the rerun ended without four decisions';
  assert.equal(classify.NOT_MEASURED.rerunStopped, ended);
  assert.equal('rerunStopped' in classify.NOT_RUN, false);
  assert.equal(X.offlineNotMeasuredReasons.at(-1), ended);
  assert.equal(X.offlineNotRunReasons.includes(ended), false);
  assert.equal(Buffer.byteLength(ended), 38);
  const filled = X.offlineNotMeasured.replace('{reason}', ended);
  assert.equal(filled, 'Outbound connection attempts: not measured (the rerun ended without four decisions).');
  assert.equal(Buffer.byteLength(filled), 84);
  // The longest reason a count that was not measured can show.
  assert.equal(Math.max(...X.offlineNotMeasuredReasons.map((s) => s.length)), 44);
});

test('copy.sidecar.json: each string these words changed is recorded as ruled, with its reason', () => {
  const keys = [
    "SCREENS (offline card): \"Run the four grant path scenarios again with every connection blocked except those between the demo's own processes.\"",
    'SCREENS (offline subB)',
    'SCREENS (summary cta.selfLead)',
    'RULED_EXTRA.offlineNotMeasured',
    'RULED_EXTRA.offlineNotMeasuredReasons',
    'RULED_EXTRA.offlineNotRun',
    'RULED_EXTRA.offlineNotRunResult',
    'RULED_EXTRA.offlineNotRunReasons',
    'RULED_EXTRA.offlineNotRunNeeds',
    'bin/start.mjs launcher lines',
  ];
  for (const k of keys) {
    assert.equal(side.strings[k]?.status, 'ruled', k);
    assert.equal(typeof side.strings[k].reason, 'string', k);
  }
  assert.equal(Object.keys(side.strings).some((k) => k.includes('every network destination outside this machine')), false);
});
