// Make src/view/copy.json and its sidecar from the layout check deck.
//
// Usage: node scripts/export-copy.mjs <path to deck.mjs> <path to label table>
//
// The deck reads the eleven label strings from a table in a file it names.
// The deck is loaded with the given label table in place of the file it
// names, and the sidecar records the sha256 of both; neither path is
// written anywhere.
//
// Every string is copied byte for byte. Four kinds of change are made, each
// recorded in the sidecar with its reason:
//   held:     a string withheld until its words are ruled; it becomes null
//             everywhere it appears and its words are not written here;
//   floor:    a string replaced by its technical floor, until
//             its final words are set;
//   ruled:    a string replaced by the words a ruling sets, until the deck
//             carries them;
//   added:    strings the screens or the text runner need that the deck
//             does not carry;
//   pending:  strings a screen state needs whose words are not set yet; each
//             is null in PENDING_WORDS, and the view prints nothing in its
//             place until it carries words.
// The deck's mock fills are layout fixtures and are not exported.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [deckPath, labelPath] = process.argv.slice(2);
if (!deckPath || !labelPath || process.argv.length > 4) {
  console.error('usage: node scripts/export-copy.mjs <path to deck.mjs> <path to label table>');
  process.exit(2);
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const deckSource = fs.readFileSync(deckPath, 'utf8');
const deckSha = sha256(deckSource);
const labelSha = sha256(fs.readFileSync(labelPath));
// The deck names its label file in one string constant: the one whose
// value is the absolute path of a Markdown file.
const gate = /^const ([A-Z][A-Z0-9_]*) = '\/[^'\n]*\.md';$/gm;
const gates = deckSource.match(gate) ?? [];
if (gates.length !== 1) {
  console.error(`the deck names ${gates.length} label files; expected 1`);
  process.exit(2);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-copy-'));
let deck;
try {
  const copy = path.join(dir, 'deck.mjs');
  const name = /^const ([A-Z][A-Z0-9_]*)/.exec(gates[0])[1];
  fs.writeFileSync(copy, deckSource.replace(gates[0], `const ${name} = ${JSON.stringify(path.resolve(labelPath))};`));
  deck = await import(pathToFileURL(copy).href);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
for (const [id, text] of Object.entries(deck.LABELS)) {
  if (typeof text !== 'string' || !text) {
    console.error(`the label table gives no words for ${id}`);
    process.exit(2);
  }
}

const OFFLINE_CARD = 'Run the four grant path scenarios again with all outbound network traffic blocked.';
// The card sentence as ruled, in place of the deck's: it names the
// connections the block allows.
const OFFLINE_CARD_RULED = "Run the four grant path scenarios again with every connection blocked except those between the demo's own processes.";
const SELF_LEAD = 'Clone the repository and start the demo. It prints the local web address to open.';
const SELF_LEAD_RULED = 'Clone the repository, install its dependencies and start the demo. It prints the local web address to open.';
// Subhead B of the offline screen, beside the deck's subhead: the measured
// state's subhead when the scenario runs did not count 0 outbound attempts.
const OFFLINE_SUB_B = "This check shows the grant path doesn't depend on an OpenA2A service.";
// The offline screen's left column title as ruled, in place of the deck's:
// it names how that run was made, the way every run of the demo is made.
const OFFLINE_LEFT_TITLE_RULED = 'Path B, run as usual';
// Screen 4: the broker record names the agent whose credential was
// presented, not the process that presented it, so the headline and the
// grant path why line say that.
const S4_H1 = 'With a grant, the bank can show which agent paid';
const S4_H1_RULED = "With a grant, the bank's record names the agent";
const S4_WHY_B = 'Why: the agent presented its own credential and grant.';
const S4_WHY_B_RULED = 'Why: it names whose credential was used, not who used it.';
// Summary limits item 17: the broker's build as it is, and the second
// listener it opens. The second sentence stays while the broker's TCP port
// answers an authenticated grant request at the pin, which the grant path
// test records on every run.
const LIMIT_BROKER = "The bank's broker is the AAP reference implementation from secretless-ai, built at commit {brokerSha12}.";
const LIMIT_BROKER_RULED = "The bank's broker is an unreleased local build of the AAP reference implementation from secretless-ai at commit {brokerSha12}, with no provenance attestation. It answers grant requests on a local TCP port as well as on its Unix socket.";

// Whole strings are replaced; the offline card sentence is replaced inside
// the string that carries it. Each replacement made is recorded.
const map = new Map([
  [SELF_LEAD, SELF_LEAD_RULED],
  [S4_H1, S4_H1_RULED],
  [S4_WHY_B, S4_WHY_B_RULED],
  [LIMIT_BROKER, LIMIT_BROKER_RULED],
]);
const applied = new Set();
const replaceStrings = (value) => JSON.parse(JSON.stringify(value), (k, v) => {
  if (typeof v !== 'string') return v;
  if (map.has(v)) {
    applied.add(v);
    return map.get(v);
  }
  if (v.includes(OFFLINE_CARD)) {
    applied.add(OFFLINE_CARD);
    return v.replace(OFFLINE_CARD, OFFLINE_CARD_RULED);
  }
  return v;
});
// Subhead B goes beside the offline screen's subhead.
const withSubB = (screens) => screens.map((screen) => {
  if (screen.id !== 'offline' || 'subB' in screen) return screen;
  return Object.fromEntries(Object.entries(screen).flatMap(([k, v]) => (k === 'sub' ? [[k, v], ['subB', OFFLINE_SUB_B]] : [[k, v]])));
});
// The left column title goes in place of the deck's until the deck carries
// it; the replacement is recorded by its ruled words.
const withLeftTitle = (screens) => screens.map((screen) => {
  if (screen.id !== 'offline' || screen.cols[0].title === OFFLINE_LEFT_TITLE_RULED) return screen;
  applied.add(OFFLINE_LEFT_TITLE_RULED);
  return { ...screen, cols: screen.cols.map((col, i) => (i === 0 ? { ...col, title: OFFLINE_LEFT_TITLE_RULED } : col)) };
});

const out = {
  LABELS: replaceStrings(deck.LABELS),
  LABEL_FILLS: deck.LABEL_FILLS,
  GLOBAL: replaceStrings(deck.GLOBAL),
  SCREENS: withSubB(withLeftTitle(replaceStrings(deck.SCREENS))),
  NARRATION: replaceStrings(deck.NARRATION),
  RULED_EXTRA: {
    fictionalLine: 'Every customer, account, payee and payment in this demo is fictional.',
    l6ScopeVariant: "The bank's broker signs a short lived token naming the agent, the bank service and the scope; payees and limits stay in the bank's records.",
    restartTook: 'Restart took {restartSeconds} s.',
    offlineNotMeasured: 'Outbound connection attempts: not measured ({reason}).',
    offlineNotMeasuredReasons: [
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
    ],
    offlineNotRun: 'Not run',
    offlineNotRunResult: 'The four scenarios were not rerun ({reason}).',
    offlineNotRunReasons: [
      'no macOS sandbox on this system',
      'the demo is already inside another sandbox',
      'the sandbox could not be applied',
    ],
    offlineNotRunNeeds: {
      'no macOS sandbox on this system': 'Why: the check needs the macOS sandbox; see Requirements in the README.',
      'the demo is already inside another sandbox': 'Why: the check needs a terminal outside any other sandbox.',
      'the sandbox could not be applied': 'Why: the check needs its own sandbox, and macOS refused it.',
    },
    offlineNoDecision: 'no decision',
    buildNotFromGit: 'Build not from a git clone',
    pageLead: "With a customer's password, an AI agent looks like the customer. The bank can't tell agents apart or limit one.",
    pageAnswer: 'With a grant, this mock bank sees the agent and checks every payment.',
    pageLeadShort: "With a customer's password, an AI agent looks like the customer.",
    pageAnswerShort: 'With a grant, this mock bank checks every payment.',
  },
  // The idle and differs words of the offline screen are the deck's (its
  // states and row tags); the words for a changed decision no row names are
  // not set.
  PENDING_WORDS: {
    offlineDiffersRow: null,
  },
};

const strings = {
  'LABELS.L4': {
    status: 'ruled',
    reason: "The grant path agent gets a grant name and a copy of the broker token, which every agent shares and which can't act on an account alone, and never the customer's password or a token for the account.",
  },
  'LABELS.L10': {
    status: 'ruled',
    reason: 'On every screen that shows the grant path, and in the limits: a copy of the credential with the grant name is accepted as this agent.',
  },
};
strings[`SCREENS (offline card): "${OFFLINE_CARD_RULED}"`] = {
  status: 'ruled',
  reason: "The card sentence as ruled, whether the deck carries it or this export puts it in place. It names what the block allows: the connections between the demo's own processes. The browser and the server that serves it run outside the block.",
};
strings['SCREENS (offline subB)'] = {
  status: 'ruled',
  reason: 'Added beside the subhead until the deck carries it: the subhead of the measured state when the scenario runs did not count 0 outbound attempts. The view selects it.',
};
if (applied.has(OFFLINE_LEFT_TITLE_RULED)) {
  strings['SCREENS (offline cols[0].title)'] = { status: 'ruled', reason: "In place of the deck's left column title until the deck carries it: it names how that run was made, the way every run of the demo is made." };
}
strings['SCREENS (summary cta.selfLead)'] = { status: 'ruled', reason: 'The lead as ruled, whether the deck carries it or this export puts it in place. It names the install step.' };
if (applied.has(S4_H1)) {
  strings['SCREENS (s4 h1)'] = { status: 'ruled', reason: "In place of the deck's headline until the deck carries it: the record names the agent whose credential was presented." };
}
if (applied.has(S4_WHY_B)) {
  strings['SCREENS (s4 Path B why)'] = { status: 'ruled', reason: "In place of the deck's why line until the deck carries it: the record names whose credential was used, not who used it." };
}
if (applied.has(LIMIT_BROKER)) {
  strings['SCREENS (summary limits item 17)'] = {
    status: 'ruled',
    reason: "In place of the deck's item until the deck carries it: the broker is an unreleased local build with no provenance attestation, and it answers grant requests on a local TCP port as well as on its Unix socket. The second sentence stays while that port answers an authenticated grant request at the pin.",
  };
}
Object.assign(strings, {
  'RULED_EXTRA.fictionalLine': { status: 'ruled', reason: 'Required on every screen and every screenshot; placement ruled.' },
  'RULED_EXTRA.l6ScopeVariant': { status: 'ruled', reason: 'Printed instead of L6 when a minted token\'s scope is not the consent id.' },
  'RULED_EXTRA.restartTook': { status: 'ruled', reason: 'Follows L12 on the scenario 3 panel.' },
  'RULED_EXTRA.offlineNotMeasured': { status: 'ruled', reason: 'The second sentence of the result line when the count is not measured; {reason} is one of offlineNotMeasuredReasons.' },
  'RULED_EXTRA.offlineNotMeasuredReasons': { status: 'ruled', reason: 'A closed list in the order that picks the reason shown: the earliest that holds. The result records every reason that holds.' },
  'RULED_EXTRA.offlineNotRun': { status: 'ruled', reason: "The right column's outcome when the rerun's root process wrote no hello line." },
  'RULED_EXTRA.offlineNotRunResult': { status: 'ruled', reason: 'The result line in that state; {reason} is one of offlineNotRunReasons.' },
  'RULED_EXTRA.offlineNotRunReasons': { status: 'ruled', reason: 'A closed list, one reason per cause.' },
  'RULED_EXTRA.offlineNotRunNeeds': { status: 'ruled', reason: 'The why line in that state, keyed by its reason: what the check needs.' },
  'RULED_EXTRA.offlineNoDecision': { status: 'added', reason: "The text runner's words for a scenario whose run returned no decision, moved here from the runner with its bytes unchanged. No screen shows them." },
  'RULED_EXTRA.buildNotFromGit': { status: 'ruled', reason: 'The build part of the footer when the demo does not run from a git clone, in place of the build and its sha.' },
  'RULED_EXTRA.pageLead': { status: 'ruled', reason: "The website demo page's problem lead." },
  'RULED_EXTRA.pageAnswer': { status: 'ruled', reason: "The website demo page's one-line answer." },
  'RULED_EXTRA.pageLeadShort': { status: 'ruled', reason: "The page lead's cut form, used in its place when the page's served test fails." },
  'RULED_EXTRA.pageAnswerShort': { status: 'ruled', reason: "The page answer's cut form, used in its place when the page's served test fails." },
  'PENDING_WORDS.offlineDiffersRow': { status: 'PENDING-WORDS', reason: "The words for a blocked run's decision that differs and that no row of the offline screen names; the row's tag after them is rowDifferent. Until they are set the row stays empty." },
  'bin/start.mjs launcher lines': { status: 'ruled', reason: 'Refusal, ready and stop lines in the words ruled for the start command.' },
});

const sidecar = {
  source: { deckSha256: deckSha, labelTableSha256: labelSha },
  marker: 'PENDING-WORDS marks a string whose final words are not yet set; HELD marks a string withheld from this file.',
  strings,
};

fs.writeFileSync(path.join(ROOT, 'src/view/copy.json'), `${JSON.stringify(out, null, 2)}\n`);
fs.writeFileSync(path.join(ROOT, 'src/view/copy.sidecar.json'), `${JSON.stringify(sidecar, null, 2)}\n`);
const made = [...applied].map((v) => (v === OFFLINE_CARD ? 'offline card' : v === OFFLINE_LEFT_TITLE_RULED ? 'offline left column title' : v === SELF_LEAD ? 'summary lead' : v === S4_H1 ? 's4 headline' : v === S4_WHY_B ? 's4 grant path why line' : 'summary limits item 17'));
const pendingKeys = Object.keys(out.PENDING_WORDS);
console.log(`deck sha256 ${deckSha}; label table sha256 ${labelSha}; replaced: ${made.length ? made.join(', ') : 'none'}; added: offline subhead B, build not from a git clone, the text runner's words for no decision, the demo page lead and answer and their cut forms; pending: ${pendingKeys.length ? pendingKeys.join(', ') : 'none'}`);
