// The fictional line is one sentence, kept byte for byte as the constant the
// runner and the API print. The screens no longer show it: the left footer of
// every screen is the scripted note alone, and the summary's mock bank item
// says the bank is a mock without it.

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
const FOOTER = 'Scenarios are scripted.';
const LIMITS_BANK_ITEM = 'Example Bank is a mock bank. No real bank, account or credential is used.';

test('copy.json: the left footer of every screen is "Scenarios are scripted.", without the fictional line', () => {
  assert.equal(copy.GLOBAL.footerLeft, FOOTER);
});

test('config.mjs: FICTIONAL_LINE is the fictional line, byte for byte', () => {
  assert.equal(FICTIONAL_LINE, LINE);
});

test('copy.json: RULED_EXTRA.fictionalLine is the fictional line, and summary limits item 1 is the mock bank sentence and the no real bank sentence, without it', () => {
  assert.equal(copy.RULED_EXTRA.fictionalLine, LINE);
  assert.equal(summary.limits.items[0], LIMITS_BANK_ITEM);
  assert.equal(JSON.stringify(copy.SCREENS).includes(LINE), false, 'no screen carries the fictional line');
});
