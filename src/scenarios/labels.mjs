// The binding labels every result carries, read from src/view/copy.json and
// filled from the pin file and the lockfile, never typed. A label whose words
// are held or contested is returned with printable false, so a view can never
// drop it silently and never print it by mistake.

import fs from 'node:fs';

const read = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
export const COPY = read('../view/copy.json');
const SIDECAR = read('../view/copy.sidecar.json');
const PINS = read('../../vendor/pins.json');
const LOCK = read('../../package-lock.json');

export const FILLS = Object.freeze({
  verifierSha12: PINS.aapConformance.commit.slice(0, 12),
  brokerSha12: PINS.secretlessAi.commit.slice(0, 12),
  atxVerifyVersion: LOCK.packages['node_modules/@opena2a/atx-verify'].version,
});

export const FICTIONAL_LINE = COPY.RULED_EXTRA.fictionalLine;
export const PATH_A_NOTE = COPY.GLOBAL.noteA;

// Where each label sits, per screen (design placement), and the labels every
// grant path decision carries whatever the screen.
const PLACEMENT = Object.freeze({
  setup: ['L1', 'L4', 'L8', 'L10'],
  approve: ['L1', 'L4', 'L8', 'L10'],
  1: ['L6', 'L5', 'L10'],
  2: ['L6', 'L5', 'L10'],
  cross: ['L6', 'L5', 'L10'],
  3: ['L12', 'L11', 'L10'],
  4: ['L13', 'L10'],
  offline: ['L7', 'L8', 'L9', 'L10'],
});
const EVERY_GRANT_DECISION = Object.freeze(['L1', 'L6', 'L7', 'L8', 'L9', 'L10']);
const ORDER = ['L1', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10', 'L11', 'L12', 'L13'];

function fill(id, text) {
  if (text === null) return null;
  let out = text;
  const f = COPY.LABEL_FILLS[id];
  if (f) out = out.replace(f.find, f.fill);
  return out.replace(/\{(verifierSha12|brokerSha12|atxVerifyVersion)\}/g, (_, k) => FILLS[k]);
}

export function label(id, { scopeIsConsent = true } = {}) {
  const side = SIDECAR.strings[`LABELS.${id}`];
  const status = side ? side.status : 'ruled';
  let text = COPY.LABELS[id];
  if (id === 'L6' && !scopeIsConsent) text = COPY.RULED_EXTRA.l6ScopeVariant;
  return {
    id,
    text: fill(id, text),
    status,
    printable: status === 'ruled' && text !== null,
  };
}

export function grantPathLabels(screen, opts = {}) {
  const placed = PLACEMENT[screen] ?? [];
  const ids = new Set([...placed, ...EVERY_GRANT_DECISION]);
  if (screen === 'setup' || screen === 'approve') ids.add('L4');
  if (screen === 1 || screen === 2 || screen === 'cross' || screen === '1' || screen === '2') ids.add('L5');
  if (screen === 3 || screen === '3') { ids.add('L11'); ids.add('L12'); }
  if (screen === 4 || screen === '4') ids.add('L13');
  return ORDER.filter((id) => ids.has(id)).map((id) => ({ ...label(id, opts), onScreen: placed.includes(id) }));
}

export function passwordPathLabels() {
  return [{ id: 'noteA', text: PATH_A_NOTE, status: 'ruled', printable: true, onScreen: true }];
}
