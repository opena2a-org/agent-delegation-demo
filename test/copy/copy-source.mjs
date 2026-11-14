// The lint reads the deck from src/view/copy.json, the file the view uses.
// Strings added beside the deck (RULED_EXTRA) are linted with GLOBAL.

import fs from 'node:fs';

const copy = JSON.parse(fs.readFileSync(new URL('../../src/view/copy.json', import.meta.url), 'utf8'));
export const LABELS = copy.LABELS;
export const GLOBAL = { ...copy.GLOBAL, ruledExtra: copy.RULED_EXTRA };
export const SCREENS = copy.SCREENS;
export const NARRATION = copy.NARRATION;
