// The fictional line is one sentence, byte for byte the same wherever it
// appears, so one fixed string search finds every surface that carries it:
// the left footer of every screen, the line constant the runner and the API
// print, and the mock bank item of the summary's limits.

import './support/outer-profile.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FICTIONAL_LINE } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copy = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
const summary = copy.SCREENS.find((s) => s.id === 'summary');

const LINE = 'Every customer, account, payee and payment in this demo is fictional.';
const FOOTER = 'Every customer, account, payee and payment in this demo is fictional. Scenarios are scripted.';
const LIMITS_BANK_ITEM = 'Example Bank is a mock bank. Every customer, account, payee and payment in this demo is fictional. No real bank, account or credential is used.';

test('copy.json: the left footer of every screen is the fictional line, then "Scenarios are scripted."', () => {
  assert.equal(copy.GLOBAL.footerLeft, FOOTER);
});

test('config.mjs: FICTIONAL_LINE is the fictional line, byte for byte', () => {
  assert.equal(FICTIONAL_LINE, LINE);
});

test('copy.json: RULED_EXTRA.fictionalLine is the fictional line, and summary limits item 1 carries it between the mock bank sentence and the no real bank sentence', () => {
  assert.equal(copy.RULED_EXTRA.fictionalLine, LINE);
  assert.equal(summary.limits.items[0], LIMITS_BANK_ITEM);
});
