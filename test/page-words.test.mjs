// The website demo page's lead and answer, and the cut forms used if the
// page's served test fails, as the copy file carries them beside the deck:
// each compared by its sha256 with the words set for it, and each recorded
// in the sidecar as ruled. No demo screen shows them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copy = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.json'), 'utf8'));
const side = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/view/copy.sidecar.json'), 'utf8'));

// The leading 16 hex digits of the sha256 of each string, as its words were set.
const SET = {
  pageLead: '3b24381b86d57c58',
  pageAnswer: '02b721421a7b91e9',
  pageLeadShort: 'ffba25e80c5ed220',
  pageAnswerShort: '32c588003c4dccdf',
};

test('copy.json: the demo page lead and answer and their cut forms, byte for byte, each recorded as ruled with its reason', () => {
  for (const [k, digest] of Object.entries(SET)) {
    const words = copy.RULED_EXTRA[k];
    assert.equal(typeof words, 'string', k);
    assert.equal(crypto.createHash('sha256').update(words).digest('hex').slice(0, 16), digest, k);
    assert.equal(side.strings[`RULED_EXTRA.${k}`]?.status, 'ruled', k);
    assert.equal(typeof side.strings[`RULED_EXTRA.${k}`].reason, 'string', k);
  }
});

test('the demo page words are on no demo screen: no screen string carries them and no view or server file reads them', () => {
  const screens = JSON.stringify([copy.LABELS, copy.GLOBAL, copy.SCREENS, copy.NARRATION]);
  for (const k of Object.keys(SET)) assert.equal(screens.includes(copy.RULED_EXTRA[k]), false, k);
  const files = ['src', 'bin'].flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true }).map((f) => path.join(d, f)))
    .filter((f) => /\.(mjs|js|html|css)$/.test(f));
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const k of Object.keys(SET)) assert.equal(text.includes(k), false, `${f}: ${k}`);
  }
});
